---
description: Screenshot Gnomeflix running in a nested shell, and show what it looks like
argument-hint: "[optional: what to click through first, e.g. 'open a show']"
allowed-tools: Bash(./scripts/nested.sh:*), Bash(make nested:*), Read
---

Show what Gnomeflix currently looks like, using the `drive-extension` skill.

Requested: $ARGUMENTS

1. `./scripts/nested.sh start 1600x900` (reuses one if already running).
2. If something specific was requested above, `click` through to it first.
3. `./scripts/nested.sh shot` and **Read the PNG**.
4. Describe what's actually on screen — layout, spacing, anything visibly broken.
5. `./scripts/nested.sh stop` when done, even if a step failed.

Check `./scripts/nested.sh logs` if the screenshot looks wrong or unchanged; a JS
exception leaves the previous UI up and reads as "nothing happened".
