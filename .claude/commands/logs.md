---
description: Show recent Media Libraries output from the GNOME Shell journal
argument-hint: "[systemd time spec, e.g. '5 min ago' — defaults to 10 min]"
allowed-tools: Bash(./scripts/dev.sh logs:*)
---

Show what the extension has logged recently.

Time window requested: $ARGUMENTS

Run `./scripts/dev.sh logs "<window>"`, using the window above — or `10 min ago` if
it's empty. Anything systemd accepts works (`5 min ago`, `today`, `09:00`).

Summarise what happened rather than dumping every line: how many enable/disable
cycles, whether the library loaded and with how many shows, and any errors or
stack traces in full. Exceptions inside a GNOME extension only ever surface here,
never in a terminal, so this is the place to look when something silently does
nothing.
