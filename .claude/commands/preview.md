---
description: Show Gnomeflix running in a nested shell, mirrored live on the desktop, and describe what it looks like
argument-hint: "[optional: what to click through first, e.g. 'open a show' or 'the Films tab']"
allowed-tools: Bash(./scripts/nested.sh:*), Bash(make nested:*), Read
---

Show what Gnomeflix currently looks like, using the `drive-extension` skill. The
user is watching the mirror window, so narrate with `say` before each step.

Requested: $ARGUMENTS

1. `./scripts/nested.sh start 1600x900` (reuses one if already running; opens the
   mirror window on the desktop).
2. If something specific was requested above, `say` it, then `click` through to it.
   Switcher tabs slide workspaces, so wait about a second before the next shot.
3. `./scripts/nested.sh shot` and **Read the PNG**.
4. Describe what's actually on screen — layout, spacing, anything visibly broken.
5. `./scripts/nested.sh stop` when done, even if a step failed.

Check `./scripts/nested.sh logs` if the screenshot looks wrong or unchanged; a JS
exception leaves the previous UI up and reads as "nothing happened".
