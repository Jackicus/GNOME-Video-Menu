---
description: Show Media Libraries running in a nested shell, mirrored live on the desktop, and describe what it looks like
argument-hint: "[optional: what to click through first, e.g. 'open a show' or 'the Films tab']"
allowed-tools: Bash(./scripts/nested.sh:*), Bash(make nested:*), Read
---

Show what Media Libraries currently looks like, using the `drive-extension` skill. The
user is watching the mirror window, so narrate with `say` before each step.

Requested: $ARGUMENTS

1. `./scripts/nested.sh start` (reuses one if already running; opens the mirror
   window on the desktop; Media Libraries is ACTIVE when it returns).
2. In **one** `./scripts/nested.sh do …` call: `say` and `click` through to anything
   requested above (`wait 1` after anything that changes workspace), then
   `shot` into your scratchpad.
3. **Read the PNG** and describe what's actually on screen — layout, spacing,
   anything visibly broken.
4. `./scripts/nested.sh stop` when done, even if a step failed. It closes the mirror.

Check `./scripts/nested.sh logs` if the screenshot looks wrong or unchanged; a JS
exception leaves the previous UI up and reads as "nothing happened".
