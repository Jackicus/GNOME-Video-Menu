#!/usr/bin/env python3
"""A virtual Xbox 360 pad on /dev/uinput, for testing lib/controls.js with no
controller to hand. Run it in the background, then write lines to the FIFO:

  ./scripts/vpad.py /path/to/pad.fifo &
  echo "tap A" > /path/to/pad.fifo

  tap A|B|X|Y|LB|RB|START|BACK|GUIDE     press and release a button
  hat up|down|left|right                 tap the D-pad (hat axis)
  stick up|down|left|right [secs]        push the left stick, hold, let go
  quit                                   remove the pad and exit

It sends what the kernel's xpad driver sends for a real one (X and Y on the
old BTN_X/BTN_Y codes, which libmanette's mapping turns positional), so
libmanette maps it as it would the real pad. Needs python-evdev and write
access to /dev/uinput (steam-devices grants it). The pad is a real input
device while it runs: every session on the machine sees it, not only a
nested shell.
"""
import os
import sys
import time

from evdev import AbsInfo, UInput, ecodes as e

FIFO = sys.argv[1]
BUTTONS = {
    'A': e.BTN_SOUTH, 'B': e.BTN_EAST, 'X': e.BTN_NORTH, 'Y': e.BTN_WEST,
    'LB': e.BTN_TL, 'RB': e.BTN_TR, 'BACK': e.BTN_SELECT, 'START': e.BTN_START,
    'GUIDE': e.BTN_MODE, 'LS': e.BTN_THUMBL, 'RS': e.BTN_THUMBR,
}
stick = AbsInfo(0, -32768, 32767, 16, 128, 0)
trigger = AbsInfo(0, 0, 255, 0, 0, 0)
hat = AbsInfo(0, -1, 1, 0, 0, 0)
caps = {
    e.EV_KEY: list(BUTTONS.values()),
    e.EV_ABS: [(e.ABS_X, stick), (e.ABS_Y, stick), (e.ABS_RX, stick), (e.ABS_RY, stick),
               (e.ABS_Z, trigger), (e.ABS_RZ, trigger), (e.ABS_HAT0X, hat), (e.ABS_HAT0Y, hat)],
}
pad = UInput(caps, name='Microsoft X-Box 360 pad', vendor=0x045e, product=0x028e,
             version=0x110, bustype=e.BUS_USB)
print('virtual pad up', pad.device, flush=True)

if not os.path.exists(FIFO):
    os.mkfifo(FIFO)


def emit(kind, code, value):
    pad.write(kind, code, value)
    pad.syn()


try:
    while True:
        with open(FIFO) as fifo:
            for line in fifo:
                words = line.split()
                if not words:
                    continue
                cmd, *args = words
                if cmd == 'quit':
                    raise SystemExit
                if cmd == 'tap':
                    code = BUTTONS[args[0].upper()]
                    emit(e.EV_KEY, code, 1)
                    time.sleep(0.08)
                    emit(e.EV_KEY, code, 0)
                elif cmd == 'hat':
                    axis, value = {'up': (e.ABS_HAT0Y, -1), 'down': (e.ABS_HAT0Y, 1),
                                   'left': (e.ABS_HAT0X, -1), 'right': (e.ABS_HAT0X, 1)}[args[0]]
                    emit(e.EV_ABS, axis, value)
                    time.sleep(0.08)
                    emit(e.EV_ABS, axis, 0)
                elif cmd == 'stick':
                    axis, value = {'up': (e.ABS_Y, -32000), 'down': (e.ABS_Y, 32000),
                                   'left': (e.ABS_X, -32000), 'right': (e.ABS_X, 32000)}[args[0]]
                    emit(e.EV_ABS, axis, value)
                    time.sleep(float(args[1]) if len(args) > 1 else 0.1)
                    emit(e.EV_ABS, axis, 0)
                print('done', line.strip(), flush=True)
finally:
    pad.close()
    os.unlink(FIFO)
