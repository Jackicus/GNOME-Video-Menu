---
description: Report install mode, shell state, and library size
allowed-tools: Bash(make status), Bash(./scripts/dev.sh status)
---

Run `make status` and report the four lines it prints:

- **install** — `symlink` means dev mode (edits in `src/` are live); `copy` means a
  real install that won't pick up edits until `make install` is re-run.
- **state** — `ACTIVE` is healthy. `unknown to the running shell` means the UUID was
  never registered, which needs a logout, not a reload.
- **cache** — `~/.cache/gnomeflix`, holding `library.json`, `posters/`, `metadata/`.
- **library** — show count, or `not scanned yet` (run `/scan`).

If anything is off, say which command fixes it.
