#!/usr/bin/env python3
"""Screenshot and input driver for the nested GNOME Shell.

Always invoked through scripts/nested.sh, which points DBUS_SESSION_BUS_ADDRESS at
the nested shell's private bus and exports NESTED_GEOMETRY / NESTED_RUN_DIR.
Running it against your real session is pointless (and the name-ownership step
below would fail there anyway).

    nested_driver.py step CMD ARGS...       one step, argv form
    nested_driver.py batch "STEP" "STEP"... several steps over one connection
    nested_driver.py stream WIDTH HEIGHT VIEWER_CMD...
                                screencast the nested monitor to PipeWire and run
                                VIEWER_CMD, with {node} replaced by the node id

Steps:
    say TEXT...            flash TEXT as an on-screen banner
    click X Y              click at desktop coordinates
    move X Y               move the pointer there without clicking (hover)
    key KEYSYM             Escape, Return, a character, or a chord: Super+Page_Down
    wait SECONDS           pause, e.g. for a workspace slide to finish
    shot [FILE [X Y W H]]  screenshot, optionally of one region only
    window FILE            screenshot of the focused window alone, frame
                           and shadow included -- the preferences, say
    overview on|off        show/hide the Activities overview
"""

import os
import shlex
import signal
import subprocess
import sys
import time

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

# org.gnome.Shell.Screenshot and ShowOSD refuse callers that are not one of a few
# known services. On the nested shell's private bus that name is unclaimed, so
# owning it is how a script gets to use them at all -- there is no other public API.
SCREENSHOT_PROXY_NAME = "org.gnome.SettingsDaemon.MediaKeys"

# The overview's show/hide animation, with margin.
OVERVIEW_SETTLE = 0.6

BTN_LEFT = 0x110
KEYSYMS = {
    "Escape": 0xFF1B, "Return": 0xFF0D, "Tab": 0xFF09, "space": 0x020,
    "Left": 0xFF51, "Up": 0xFF52, "Right": 0xFF53, "Down": 0xFF54,
    "BackSpace": 0xFF08, "Home": 0xFF50, "End": 0xFF57,
    "Page_Up": 0xFF55, "Page_Down": 0xFF56,
    "Super": 0xFFEB, "Super_L": 0xFFEB, "Alt": 0xFFE9, "Alt_L": 0xFFE9,
    "Control": 0xFFE3, "Ctrl": 0xFFE3, "Shift": 0xFFE1,
    # F1..F12, for a shortcut that takes a function key.
    **{f"F{n}": 0xFFBD + n for n in range(1, 13)},
    # What a media remote sends (xkbcommon-keysyms.h).
    "XF86OK": 0x10081160, "XF86Select": 0x1008FFA0, "XF86Back": 0x1008FF26,
    "XF86HomePage": 0x1008FF18, "XF86Exit": 0x100810AE,
    "XF86ChannelUp": 0x10081192, "XF86ChannelDown": 0x10081193,
}


class StepError(Exception):
    pass


def _keysym(name):
    keysym = KEYSYMS.get(name)
    if keysym is None:
        if len(name) == 1:
            return ord(name)
        raise StepError(f"Unknown keysym '{name}'. Known: {', '.join(sorted(KEYSYMS))}")
    return keysym


class Driver:
    """One bus connection, one bus name and one input session for a whole batch.

    Every step used to be its own process, re-acquiring the name and re-creating
    the virtual input devices -- and paying the first-event workaround -- each time.
    """

    def __init__(self):
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        geometry = os.environ.get("NESTED_GEOMETRY", "1600x900")
        self.width, self.height = (int(v) for v in geometry.split("x"))
        run_dir = os.environ.get("NESTED_RUN_DIR")
        # Set by 'overview on': until 'overview off', shots and clicks act on the
        # overview instead of dismissing it.
        self.overview_flag = os.path.join(run_dir, "overview-wanted") if run_dir else None
        self.shot_dir = os.environ.get("NESTED_SHOT_DIR", os.getcwd())
        self._name_id = None
        self._input = None
        self._stream = None
        self._pointer_ready = False
        self._keyboard_ready = False

    # -- plumbing -----------------------------------------------------------

    def _own_name(self):
        if self._name_id is not None:
            return
        loop = GLib.MainLoop()
        state = {"acquired": False}

        def on_acquired(_conn, _n):
            state["acquired"] = True
            loop.quit()

        oid = Gio.bus_own_name_on_connection(
            self.bus, SCREENSHOT_PROXY_NAME, Gio.BusNameOwnerFlags.NONE,
            on_acquired, lambda *_: loop.quit(),
        )
        GLib.timeout_add(2000, lambda: (loop.quit(), False)[1])
        loop.run()
        if not state["acquired"]:
            Gio.bus_unown_name(oid)
            raise StepError(f"Could not acquire {SCREENSHOT_PROXY_NAME}; the shell would refuse the call.")
        self._name_id = oid

    def _proxy(self, name, path, iface):
        return Gio.DBusProxy.new_sync(self.bus, Gio.DBusProxyFlags.NONE, None, name, path, iface, None)

    def _session(self):
        """A RemoteDesktop session linked to a screencast of the whole monitor.

        Without a stream only relative pointer motion is accepted, which meant
        pinning the pointer into a corner and walking out from there -- racing the
        compositor's asynchronous clamp. A linked stream allows absolute motion in
        the stream's own coordinates, which for a full-monitor area are desktop
        coordinates. Nothing consumes the stream; it only has to exist.
        """
        if self._input is None:
            rd = self._proxy("org.gnome.Mutter.RemoteDesktop", "/org/gnome/Mutter/RemoteDesktop",
                             "org.gnome.Mutter.RemoteDesktop")
            session = self._proxy("org.gnome.Mutter.RemoteDesktop", rd.CreateSession(),
                                  "org.gnome.Mutter.RemoteDesktop.Session")
            session_id = session.get_cached_property("SessionId").unpack()
            sc = self._proxy("org.gnome.Mutter.ScreenCast", "/org/gnome/Mutter/ScreenCast",
                             "org.gnome.Mutter.ScreenCast")
            cast_path = sc.call_sync(
                "CreateSession",
                GLib.Variant("(a{sv})", ({"remote-desktop-session-id": GLib.Variant("s", session_id)},)),
                Gio.DBusCallFlags.NONE, 5000, None,
            ).unpack()[0]
            cast = self._proxy("org.gnome.Mutter.ScreenCast", cast_path, "org.gnome.Mutter.ScreenCast.Session")
            self._stream = cast.call_sync(
                "RecordArea",
                GLib.Variant("(iiiia{sv})", (0, 0, self.width, self.height, {})),
                Gio.DBusCallFlags.NONE, 5000, None,
            ).unpack()[0]
            session.Start()
            self._input = session
        return self._input

    def _notify(self, method, signature, *args):
        self._session().call_sync(
            f"org.gnome.Mutter.RemoteDesktop.Session.{method}",
            GLib.Variant(signature, args), Gio.DBusCallFlags.NONE, 5000, None,
        )

    def _overview_active(self):
        value = self.bus.call_sync(
            "org.gnome.Shell", "/org/gnome/Shell",
            "org.freedesktop.DBus.Properties", "Get",
            GLib.Variant("(ss)", ("org.gnome.Shell", "OverviewActive")),
            GLib.VariantType("(v)"), Gio.DBusCallFlags.NONE, 5000, None,
        ).unpack()[0]
        return bool(value)

    def _set_overview(self, active):
        self.bus.call_sync(
            "org.gnome.Shell", "/org/gnome/Shell",
            "org.freedesktop.DBus.Properties", "Set",
            GLib.Variant("(ssv)", ("org.gnome.Shell", "OverviewActive", GLib.Variant("b", active))),
            None, Gio.DBusCallFlags.NONE, 5000, None,
        )

    def _overview_wanted(self):
        return bool(self.overview_flag) and os.path.exists(self.overview_flag)

    def ensure_desktop(self):
        """The nested shell boots into the overview, and the hot corner can throw it
        back there; either way it covers the surface Media Libraries draws on. Dismiss it
        -- and only wait for the animation when there was something to dismiss."""
        if self._overview_wanted():
            return
        if self._overview_active():
            self._set_overview(False)
            time.sleep(OVERVIEW_SETTLE)

    def close(self):
        if self._input is not None:
            try:
                self._input.Stop()
            except GLib.Error:
                pass
        if self._name_id is not None:
            Gio.bus_unown_name(self._name_id)

    # -- steps --------------------------------------------------------------

    def say(self, *words):
        if not words:
            raise StepError("say needs some text")
        text = " ".join(words)
        self._own_name()
        self.bus.call_sync(
            "org.gnome.Shell", "/org/gnome/Shell", "org.gnome.Shell", "ShowOSD",
            GLib.Variant("(a{sv})", ({
                "icon": GLib.Variant("s", "video-display-symbolic"),
                "label": GLib.Variant("s", text),
            },)),
            None, Gio.DBusCallFlags.NONE, 5000, None,
        )
        return f"said: {text}"

    def move(self, x, y, press=False):
        x, y = int(x), int(y)
        if not (0 <= x < self.width and 0 <= y < self.height):
            raise StepError(f"({x}, {y}) is outside the {self.width}x{self.height} monitor")
        self._session()
        if not self._pointer_ready:
            # The very first event on a fresh virtual pointer is dropped while the
            # device is being created -- and in a freshly started shell, creating it
            # springs the Activities hot corner. So make the device first, give the
            # overview time to start opening, and only then check for it; checking
            # before let the overview reopen behind the check and eat the click.
            self._notify("NotifyPointerMotionAbsolute", "(sdd)", self._stream, float(x), float(y))
            time.sleep(0.3)
            self._pointer_ready = True
            # The hot corner is a toggle: after 'overview on' what it springs
            # shut is the overview that was asked for. Only here -- later on,
            # an overview that has gone is one the extension closed.
            if self._overview_wanted() and not self._overview_active():
                self._set_overview(True)
                time.sleep(OVERVIEW_SETTLE)
        self.ensure_desktop()
        self._notify("NotifyPointerMotionAbsolute", "(sdd)", self._stream, float(x), float(y))
        # Let the actor under the pointer pick up hover/reactive state.
        time.sleep(0.2)
        if not press:
            return f"moved to ({x}, {y})"
        self._notify("NotifyPointerButton", "(ib)", BTN_LEFT, True)
        time.sleep(0.05)
        self._notify("NotifyPointerButton", "(ib)", BTN_LEFT, False)
        time.sleep(0.1)
        return f"clicked ({x}, {y})"

    def click(self, x, y):
        return self.move(x, y, press=True)

    def key(self, combo):
        parts = combo.split("+") if combo != "+" else ["+"]
        keysyms = [_keysym(p) for p in parts]
        if not self._keyboard_ready:
            # Same as the pointer: the first event on a fresh virtual keyboard is
            # lost while the device is created. A lone Shift tap absorbs it.
            self._notify("NotifyKeyboardKeysym", "(ub)", KEYSYMS["Shift"], True)
            self._notify("NotifyKeyboardKeysym", "(ub)", KEYSYMS["Shift"], False)
            time.sleep(0.1)
            self._keyboard_ready = True
        for k in keysyms:
            self._notify("NotifyKeyboardKeysym", "(ub)", k, True)
            time.sleep(0.03)
        for k in reversed(keysyms):
            self._notify("NotifyKeyboardKeysym", "(ub)", k, False)
            time.sleep(0.03)
        return f"pressed {combo}"

    def wait(self, seconds):
        time.sleep(float(seconds))
        return f"waited {seconds}s"

    def shot(self, path=None, *region):
        if path in (None, "", "-"):
            path = os.path.join(self.shot_dir, f"nested-{time.strftime('%H%M%S')}.png")
        path = os.path.abspath(path)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.ensure_desktop()
        self._own_name()
        if region:
            if len(region) != 4:
                raise StepError("shot FILE X Y W H -- a region needs all four numbers")
            x, y, w, h = (int(v) for v in region)
            method, args = "ScreenshotArea", GLib.Variant("(iiiibs)", (x, y, w, h, False, path))
        else:
            method, args = "Screenshot", GLib.Variant("(bbs)", (False, False, path))
        ok, used = self.bus.call_sync(
            "org.gnome.Shell", "/org/gnome/Shell/Screenshot",
            "org.gnome.Shell.Screenshot", method, args,
            GLib.VariantType("(bs)"), Gio.DBusCallFlags.NONE, 15000, None,
        ).unpack()
        if not ok:
            raise StepError("Screenshot call returned failure.")
        return f"shot: {used}"

    def window(self, path):
        path = os.path.abspath(path)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self._own_name()
        ok, used = self.bus.call_sync(
            "org.gnome.Shell", "/org/gnome/Shell/Screenshot",
            "org.gnome.Shell.Screenshot", "ScreenshotWindow",
            GLib.Variant("(bbbs)", (True, False, False, path)),
            GLib.VariantType("(bs)"), Gio.DBusCallFlags.NONE, 15000, None,
        ).unpack()
        if not ok:
            raise StepError("ScreenshotWindow returned failure (is a window focused?).")
        return f"window: {used}"

    def overview(self, state):
        if state not in ("on", "off"):
            raise StepError("overview on|off")
        want = state == "on"
        if self.overview_flag:
            if want:
                open(self.overview_flag, "w").close()
            elif os.path.exists(self.overview_flag):
                os.remove(self.overview_flag)
        if self._overview_active() != want:
            self._set_overview(want)
            time.sleep(OVERVIEW_SETTLE)
        return f"overview {state}"

    STEPS = {"say", "click", "move", "key", "wait", "shot", "window", "overview"}

    def run(self, argv):
        if not argv or argv[0] not in self.STEPS:
            raise StepError(f"Unknown step {argv[0] if argv else '(empty)'!r}; "
                            f"known: {', '.join(sorted(self.STEPS))}")
        try:
            return getattr(self, argv[0])(*argv[1:])
        except TypeError:
            raise StepError(f"Wrong arguments for {argv[0]!r}: {shlex.join(argv)}") from None
        except ValueError as e:
            raise StepError(f"Bad value in {shlex.join(argv)}: {e}") from None


def run_steps(steps):
    driver = Driver()
    try:
        for n, argv in enumerate(steps, 1):
            try:
                print(driver.run(argv), flush=True)
            except (StepError, GLib.Error) as e:
                message = e.message if isinstance(e, GLib.Error) else str(e)
                sys.exit(f"step {n} ({shlex.join(argv)}) failed: {message}")
    finally:
        driver.close()


def cmd_stream(width, height, viewer):
    """Publish the nested monitor as a PipeWire stream and show it in a viewer.

    Mutter's ScreenCast API hands out a PipeWire node; PipeWire itself is per-user
    and shared with the real session, so a viewer on the real desktop can play it.
    The viewer never outlives this process, and this process never outlives the
    nested shell: when its bus goes away the window is closed, instead of being
    left frozen on the desktop.
    """
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    # By default GDBus _exit()s the moment the bus closes, which would orphan the
    # viewer. Handle the close ourselves.
    bus.set_exit_on_close(False)
    sc = Gio.DBusProxy.new_sync(
        bus, Gio.DBusProxyFlags.NONE, None,
        "org.gnome.Mutter.ScreenCast", "/org/gnome/Mutter/ScreenCast",
        "org.gnome.Mutter.ScreenCast", None,
    )
    session_path = sc.call_sync(
        "CreateSession", GLib.Variant("(a{sv})", ({},)),
        Gio.DBusCallFlags.NONE, 5000, None,
    ).unpack()[0]
    sess = Gio.DBusProxy.new_sync(
        bus, Gio.DBusProxyFlags.NONE, None,
        "org.gnome.Mutter.ScreenCast", session_path,
        "org.gnome.Mutter.ScreenCast.Session", None,
    )
    # cursor-mode 1 embeds the pointer in the frames, so the watcher sees where
    # the driver is about to click.
    stream_path = sess.call_sync(
        "RecordArea",
        GLib.Variant("(iiiia{sv})", (0, 0, width, height, {"cursor-mode": GLib.Variant("u", 1)})),
        Gio.DBusCallFlags.NONE, 5000, None,
    ).unpack()[0]

    loop = GLib.MainLoop()
    state = {"node": None}

    def on_signal(_conn, _sender, _path, _iface, name, params):
        if name == "PipeWireStreamAdded":
            state["node"] = params.unpack()[0]
            loop.quit()

    bus.signal_subscribe(
        "org.gnome.Mutter.ScreenCast", "org.gnome.Mutter.ScreenCast.Stream",
        "PipeWireStreamAdded", stream_path, None, Gio.DBusSignalFlags.NONE, on_signal,
    )
    sess.call_sync("Start", None, Gio.DBusCallFlags.NONE, 5000, None)
    GLib.timeout_add(5000, lambda: (loop.quit(), False)[1])
    loop.run()
    if state["node"] is None:
        sys.exit("Screencast started but no PipeWire node appeared.")

    print(f"pipewire node {state['node']}", flush=True)
    argv = [a.replace("{node}", str(state["node"])) for a in viewer]
    proc = subprocess.Popen(argv)

    # A loop of its own, not `loop` rebound: the five-second guard above is
    # still pending when the node arrives early, and closes over the name —
    # it would have quit this loop, and the mirror with it, at five seconds.
    watching = GLib.MainLoop()

    def finish(*_):
        watching.quit()
        return GLib.SOURCE_REMOVE

    def viewer_alive():
        if proc.poll() is not None:     # the user closed the window
            watching.quit()
            return GLib.SOURCE_REMOVE
        return GLib.SOURCE_CONTINUE

    bus.connect("closed", finish)       # the nested shell went away
    try:
        gi.require_version("GLibUnix", "2.0")
        from gi.repository import GLibUnix
        signal_add = GLibUnix.signal_add
    except (ImportError, ValueError):
        signal_add = GLib.unix_signal_add
    signal_add(GLib.PRIORITY_DEFAULT, signal.SIGTERM, finish)
    signal_add(GLib.PRIORITY_DEFAULT, signal.SIGINT, finish)
    GLib.timeout_add(300, viewer_alive)
    watching.run()

    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
    if not bus.is_closed():
        try:
            sess.call_sync("Stop", None, Gio.DBusCallFlags.NONE, 2000, None)
        except GLib.Error:
            pass


def main(argv):
    if not argv:
        sys.exit(__doc__)
    cmd, args = argv[0], argv[1:]
    if cmd == "step" and args:
        run_steps([args])
    elif cmd == "batch" and args:
        steps = [shlex.split(s) for s in args]
        run_steps([s for s in steps if s])
    elif cmd == "stream" and len(args) >= 3:
        cmd_stream(int(args[0]), int(args[1]), args[2:])
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
