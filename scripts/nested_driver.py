#!/usr/bin/env python3
"""Screenshot and input driver for the nested GNOME Shell.

Always invoked through scripts/nested.sh, which points DBUS_SESSION_BUS_ADDRESS at
the nested shell's private bus. Running it against your real session is pointless
(and the name-ownership step below would fail there anyway).

    nested_driver.py shot FILE
    nested_driver.py click X Y WIDTH HEIGHT
    nested_driver.py move X Y WIDTH HEIGHT   (hover without clicking)
    nested_driver.py key KEYSYM      (e.g. Escape, Return, Super+Page_Down)
    nested_driver.py overview on|off
    nested_driver.py say TEXT        flash TEXT as an on-screen banner
    nested_driver.py stream WIDTH HEIGHT VIEWER_CMD...
                                     screencast the nested monitor to PipeWire and
                                     run VIEWER_CMD, with {node} replaced by the id
"""

import os
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

BTN_LEFT = 0x110
KEYSYMS = {
    "Escape": 0xFF1B, "Return": 0xFF0D, "Tab": 0xFF09, "space": 0x020,
    "Left": 0xFF51, "Up": 0xFF52, "Right": 0xFF53, "Down": 0xFF54,
    "BackSpace": 0xFF08, "Home": 0xFF50, "End": 0xFF57,
    "Page_Up": 0xFF55, "Page_Down": 0xFF56,
    "Super": 0xFFEB, "Super_L": 0xFFEB, "Alt": 0xFFE9, "Alt_L": 0xFFE9,
    "Control": 0xFFE3, "Ctrl": 0xFFE3, "Shift": 0xFFE1,
}


def session_bus():
    return Gio.bus_get_sync(Gio.BusType.SESSION, None)


def own_name(bus, name, timeout_ms=2000):
    """Acquire a bus name, returning its owner id, or None if it is taken."""
    loop = GLib.MainLoop()
    state = {"acquired": False}

    def on_acquired(_conn, _n):
        state["acquired"] = True
        loop.quit()

    oid = Gio.bus_own_name_on_connection(
        bus, name, Gio.BusNameOwnerFlags.NONE, on_acquired, lambda *_: loop.quit()
    )
    GLib.timeout_add(timeout_ms, lambda: (loop.quit(), False)[1])
    loop.run()
    if not state["acquired"]:
        Gio.bus_unown_name(oid)
        return None
    return oid


def cmd_shot(path):
    bus = session_bus()
    oid = own_name(bus, SCREENSHOT_PROXY_NAME)
    if oid is None:
        sys.exit(f"Could not acquire {SCREENSHOT_PROXY_NAME}; screenshot would be denied.")
    try:
        ok, used = bus.call_sync(
            "org.gnome.Shell", "/org/gnome/Shell/Screenshot",
            "org.gnome.Shell.Screenshot", "Screenshot",
            GLib.Variant("(bbs)", (False, False, path)),
            GLib.VariantType("(bs)"), Gio.DBusCallFlags.NONE, 15000, None,
        ).unpack()
    except GLib.Error as e:
        sys.exit(f"Screenshot failed: {e.message}")
    finally:
        Gio.bus_unown_name(oid)
    if not ok:
        sys.exit("Screenshot call returned failure.")
    print(used)


def cmd_say(text):
    """Show TEXT in the shell's OSD (the volume/brightness popup)."""
    bus = session_bus()
    oid = own_name(bus, SCREENSHOT_PROXY_NAME)
    if oid is None:
        sys.exit(f"Could not acquire {SCREENSHOT_PROXY_NAME}; ShowOSD would be denied.")
    try:
        bus.call_sync(
            "org.gnome.Shell", "/org/gnome/Shell", "org.gnome.Shell", "ShowOSD",
            GLib.Variant("(a{sv})", ({
                "icon": GLib.Variant("s", "video-display-symbolic"),
                "label": GLib.Variant("s", text),
            },)),
            None, Gio.DBusCallFlags.NONE, 5000, None,
        )
    except GLib.Error as e:
        sys.exit(f"ShowOSD failed: {e.message}")
    finally:
        Gio.bus_unown_name(oid)
    print(text)


def remote_session(bus):
    rd = Gio.DBusProxy.new_sync(
        bus, Gio.DBusProxyFlags.NONE, None,
        "org.gnome.Mutter.RemoteDesktop", "/org/gnome/Mutter/RemoteDesktop",
        "org.gnome.Mutter.RemoteDesktop", None,
    )
    path = rd.CreateSession()
    sess = Gio.DBusProxy.new_sync(
        bus, Gio.DBusProxyFlags.NONE, None,
        "org.gnome.Mutter.RemoteDesktop", path,
        "org.gnome.Mutter.RemoteDesktop.Session", None,
    )
    sess.Start()
    return sess


def notify(sess, method, signature, *args):
    sess.call_sync(
        f"org.gnome.Mutter.RemoteDesktop.Session.{method}",
        GLib.Variant(signature, args), Gio.DBusCallFlags.NONE, 5000, None,
    )


def cmd_click(x, y, width, height, press=True):
    bus = session_bus()
    sess = remote_session(bus)
    # Only relative motion is available without a screencast stream, so pin the
    # pointer to a known corner (the compositor clamps) and walk out from there.
    # It must be the BOTTOM-right: the top-left is the Activities hot corner, and
    # landing there throws the shell into the overview.
    #
    # The very first event on a fresh virtual pointer is dropped while the device
    # is being created, which used to swallow the first click after every start
    # or reload. A throwaway nudge absorbs that.
    notify(sess, "NotifyPointerMotionRelative", "(dd)", 1.0, 1.0)
    time.sleep(0.3)
    notify(sess, "NotifyPointerMotionRelative", "(dd)", 20000.0, 20000.0)
    # The clamp to the corner is applied asynchronously, so without a pause the
    # second motion is measured from the pointer's OLD position and the click
    # lands somewhere else entirely.
    time.sleep(0.15)
    notify(sess, "NotifyPointerMotionRelative", "(dd)",
           float(x - (width - 1)), float(y - (height - 1)))
    # Let the actor under the pointer pick up hover/reactive state before pressing.
    time.sleep(0.25)
    if not press:
        print(f"moved to ({x}, {y})")
        return
    notify(sess, "NotifyPointerButton", "(ib)", BTN_LEFT, True)
    time.sleep(0.05)
    notify(sess, "NotifyPointerButton", "(ib)", BTN_LEFT, False)
    time.sleep(0.1)
    print(f"clicked ({x}, {y})")


def _keysym(name):
    keysym = KEYSYMS.get(name)
    if keysym is None:
        if len(name) == 1:
            keysym = ord(name)
        else:
            sys.exit(f"Unknown keysym '{name}'. Known: {', '.join(sorted(KEYSYMS))}")
    return keysym


def cmd_key(combo):
    """Press a key, or a chord such as Super+Page_Down (modifiers first)."""
    parts = combo.split("+") if combo != "+" else ["+"]
    keysyms = [_keysym(p) for p in parts]
    bus = session_bus()
    sess = remote_session(bus)
    # Same as the pointer: the first event on a fresh virtual keyboard is lost
    # while the device is created. A lone Shift tap absorbs it harmlessly.
    notify(sess, "NotifyKeyboardKeysym", "(ub)", KEYSYMS["Shift"], True)
    notify(sess, "NotifyKeyboardKeysym", "(ub)", KEYSYMS["Shift"], False)
    time.sleep(0.1)
    for k in keysyms:
        notify(sess, "NotifyKeyboardKeysym", "(ub)", k, True)
        time.sleep(0.03)
    for k in reversed(keysyms):
        notify(sess, "NotifyKeyboardKeysym", "(ub)", k, False)
        time.sleep(0.03)
    print(f"pressed {combo}")


def cmd_overview(state):
    bus = session_bus()
    bus.call_sync(
        "org.gnome.Shell", "/org/gnome/Shell",
        "org.freedesktop.DBus.Properties", "Set",
        GLib.Variant("(ssv)", ("org.gnome.Shell", "OverviewActive",
                               GLib.Variant("b", state == "on"))),
        None, Gio.DBusCallFlags.NONE, 5000, None,
    )
    print(f"overview {state}")


def cmd_stream(width, height, viewer):
    """Publish the nested monitor as a PipeWire stream and show it in a viewer.

    Mutter's ScreenCast API hands out a PipeWire node; PipeWire itself is
    per-user and shared with the real session, so a viewer on the real desktop
    can play it. The session dies with this process, so it stays alive for as
    long as the viewer runs.
    """
    bus = session_bus()
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

    def stop(*_):
        if proc.poll() is None:
            proc.terminate()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        proc.wait()
    finally:
        try:
            sess.call_sync("Stop", None, Gio.DBusCallFlags.NONE, 5000, None)
        except GLib.Error:
            pass


def main(argv):
    if not argv:
        sys.exit(__doc__)
    cmd, args = argv[0], argv[1:]
    if cmd == "shot" and len(args) == 1:
        cmd_shot(args[0])
    elif cmd == "click" and len(args) == 4:
        cmd_click(int(args[0]), int(args[1]), int(args[2]), int(args[3]))
    elif cmd == "move" and len(args) == 4:
        cmd_click(int(args[0]), int(args[1]), int(args[2]), int(args[3]), press=False)
    elif cmd == "key" and len(args) == 1:
        cmd_key(args[0])
    elif cmd == "overview" and len(args) == 1 and args[0] in ("on", "off"):
        cmd_overview(args[0])
    elif cmd == "say" and args:
        cmd_say(" ".join(args))
    elif cmd == "stream" and len(args) >= 3:
        cmd_stream(int(args[0]), int(args[1]), args[2:])
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
