---
description: Apply src/ edits to the running GNOME Shell and check for errors
allowed-tools: Bash(make reload), Bash(./scripts/dev.sh reload), Bash(./scripts/dev.sh logs:*)
---

Apply the current `src/` edits to the running shell, then confirm they took.

1. Run `make reload`.
2. Run `./scripts/dev.sh logs "1 min ago"` to see what the shell logged.
3. Report whether it came up clean. A healthy reload logs a single line:
   `[Gnomeflix] Enabled from /run/user/1000/gnomeflix/lib-<stamp>`.
   Anything with `Failed to load`, `Error during disable`, or a JS stack trace is a
   real failure — quote it and say which file it points at.

If the shell reports the extension doesn't exist, it needs a log out / log back in
before it will register the UUID — say so rather than retrying. The same applies
when `extension.js` or `metadata.json` changed: the shell caches those for its
whole lifetime, and a reload will run the old loader.
