#!/usr/bin/env python3
"""Screenshot and input driver for the nested GNOME Shell.

Always invoked through scripts/nested.sh, which points DBUS_SESSION_BUS_ADDRESS at
the nested shell's private bus. Running it against your real session is pointless
(and the name-ownership step below would fail there anyway).

    nested_driver.py shot FILE
    nested_driver.py click X Y WIDTH HEIGHT
    nested_driver.py key KEYSYM      (e.g. Escape, Return, Left, Right)
    nested_driver.py overview on|off
"""

import sys
import time

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

# org.gnome.Shell.Screenshot refuses callers that are not one of a few known
# services. On the nested shell's private bus that name is unclaimed, so owning it
# is how a script gets to screenshot at all -- there is no other public API.
SCREENSHOT_PROXY_NAME = "org.gnome.SettingsDaemon.MediaKeys"

BTN_LEFT = 0x110
KEYSYMS = {
    "Escape": 0xFF1B, "Return": 0xFF0D, "Tab": 0xFF09, "space": 0x020,
    "Left": 0xFF51, "Up": 0xFF52, "Right": 0xFF53, "Down": 0xFF54,
    "BackSpace": 0xFF08, "Home": 0xFF50, "End": 0xFF57,
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


def cmd_click(x, y, width, height):
    bus = session_bus()
    sess = remote_session(bus)
    # Only relative motion is available without a screencast stream, so pin the
    # pointer to a known corner (the compositor clamps) and walk out from there.
    # It must be the BOTTOM-right: the top-left is the Activities hot corner, and
    # landing there throws the shell into the overview.
    notify(sess, "NotifyPointerMotionRelative", "(dd)", 20000.0, 20000.0)
    # The clamp to the corner is applied asynchronously, so without a pause the
    # second motion is measured from the pointer's OLD position and the click
    # lands somewhere else entirely.
    time.sleep(0.15)
    notify(sess, "NotifyPointerMotionRelative", "(dd)",
           float(x - (width - 1)), float(y - (height - 1)))
    # Let the actor under the pointer pick up hover/reactive state before pressing.
    time.sleep(0.25)
    notify(sess, "NotifyPointerButton", "(ib)", BTN_LEFT, True)
    time.sleep(0.05)
    notify(sess, "NotifyPointerButton", "(ib)", BTN_LEFT, False)
    time.sleep(0.1)
    print(f"clicked ({x}, {y})")


def cmd_key(name):
    keysym = KEYSYMS.get(name)
    if keysym is None:
        if len(name) == 1:
            keysym = ord(name)
        else:
            sys.exit(f"Unknown keysym '{name}'. Known: {', '.join(sorted(KEYSYMS))}")
    bus = session_bus()
    sess = remote_session(bus)
    notify(sess, "NotifyKeyboardKeysym", "(ub)", keysym, True)
    notify(sess, "NotifyKeyboardKeysym", "(ub)", keysym, False)
    print(f"pressed {name}")


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


def main(argv):
    if not argv:
        sys.exit(__doc__)
    cmd, args = argv[0], argv[1:]
    if cmd == "shot" and len(args) == 1:
        cmd_shot(args[0])
    elif cmd == "click" and len(args) == 4:
        cmd_click(int(args[0]), int(args[1]), int(args[2]), int(args[3]))
    elif cmd == "key" and len(args) == 1:
        cmd_key(args[0])
    elif cmd == "overview" and len(args) == 1 and args[0] in ("on", "off"):
        cmd_overview(args[0])
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
