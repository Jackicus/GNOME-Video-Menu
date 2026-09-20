#!/usr/bin/env python3
# Catch a desktop freeze in the act: what stalled, for how long, and on what.
#
# Three things are watched at once and written to one log with timestamps:
#
#   stall    the compositor's main loop. A property of org.gnome.Shell is read
#            every 50 ms; a registered object's Properties.Get is answered on
#            the shell's main loop (Peer.Ping is not -- GDBus answers that on
#            its worker thread), so a slow answer is the shell standing still,
#            which on Wayland is every window and, with a software cursor,
#            the mouse.
#   D-state  any process -- and any gnome-shell thread -- held in
#            uninterruptible sleep for a sample or more, with its kernel wait
#            channel: `autofs_wait` is a systemd automount being mounted,
#            `cifs_*` a network share answering slowly.
#   automount the system journal's "Got automount request ... triggered by
#            PID (comm)" lines, which name the process that woke a share.
#
# Run it, reproduce the freeze, stop it with Ctrl+C, and read the log. Nothing
# here needs root or touches the shell.
#
#   ./scripts/dev.sh stalls [LOG]     (default log: dist/stalls.log)

import datetime
import os
import subprocess
import sys
import threading
import time

import gi
gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib  # noqa: E402

STALL_MS = 80
SAMPLE_S = 0.05
DSTATE_S = 0.2

log_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'dist', 'stalls.log')
os.makedirs(os.path.dirname(log_path), exist_ok=True)
log = open(log_path, 'a', buffering=1)
lock = threading.Lock()


def stamp():
    return datetime.datetime.now().strftime('%H:%M:%S.%f')[:-3]


def write(line):
    with lock:
        log.write(f'{stamp()} {line}\n')
        print(line, flush=True)


def watch_main_loop():
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    while True:
        t0 = time.monotonic()
        try:
            bus.call_sync('org.gnome.Shell', '/org/gnome/Shell',
                          'org.freedesktop.DBus.Properties', 'Get',
                          GLib.Variant('(ss)', ('org.gnome.Shell', 'ShellVersion')),
                          GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, 120000, None)
        except Exception as e:  # the shell went away, or the bus did
            write(f'stall ? {e}')
            time.sleep(1)
            continue
        ms = (time.monotonic() - t0) * 1000
        if ms > STALL_MS:
            write(f'stall {ms:.0f} ms (shell main loop)')
        time.sleep(SAMPLE_S)


def read_stat(path):
    try:
        with open(path + '/stat') as f:
            s = f.read()
        return s[s.index('(') + 1:s.rindex(')')], s[s.rindex(')') + 2]
    except OSError:
        return None, None


def read_wchan(path):
    try:
        with open(path + '/wchan') as f:
            return f.read().strip() or '?'
    except OSError:
        return '?'


def watch_dstate():
    seen = {}
    while True:
        now = time.monotonic()
        live = set()
        for pid in os.listdir('/proc'):
            if not pid.isdigit():
                continue
            base = f'/proc/{pid}'
            comm, state = read_stat(base)
            if comm is None:
                continue
            # Kernel threads dip into D on every sample and mean nothing here;
            # they are the processes with no command line at all.
            try:
                if os.path.getsize(base + '/cmdline') == 0 and open(base + '/cmdline', 'rb').read() == b'':
                    continue
            except OSError:
                continue
            tasks = [(pid, base, comm, state)]
            if comm == 'gnome-shell':
                try:
                    for tid in os.listdir(base + '/task'):
                        tcomm, tstate = read_stat(f'{base}/task/{tid}')
                        if tcomm is not None:
                            tasks.append((f'{pid}/{tid}', f'{base}/task/{tid}', tcomm, tstate))
                except OSError:
                    pass
            for key, path, c, st in tasks:
                if st == 'D':
                    live.add(key)
                    seen.setdefault(key, (now, c, read_wchan(path)))
        for key in [k for k in seen if k not in live]:
            t0, c, wchan = seen.pop(key)
            held = (now - t0) * 1000
            if held >= DSTATE_S * 1000:
                write(f'D-state {key} ({c}) {held:.0f} ms wchan={wchan}')
        time.sleep(DSTATE_S)


def watch_automounts():
    try:
        proc = subprocess.Popen(
            ['journalctl', '-f', '-n', '0', '-o', 'cat', '_COMM=systemd', '_PID=1'],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    except OSError:
        return
    for line in proc.stdout:
        if 'automount request' in line or 'Mounting ' in line or 'Failed to mount' in line:
            write(f'automount {line.strip()}')


write(f'# stallwatch started, log: {log_path}')
for target in (watch_main_loop, watch_dstate, watch_automounts):
    threading.Thread(target=target, daemon=True).start()
try:
    while True:
        time.sleep(3600)
except KeyboardInterrupt:
    write('# stallwatch stopped')
