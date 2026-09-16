---
description: Re-index the media directory and download artwork
allowed-tools: Bash(make scan), Bash(./scripts/dev.sh scan), Bash(./scripts/dev.sh reload)
---

Re-index the media library.

1. Run `make scan`. It reads `tv-shows-path` from GSettings, walks that directory,
   looks each show up on TVmaze, downloads posters (generating an SVG placeholder
   when there's no artwork), and writes `~/.cache/gnomeflix/library.json`.
2. Report the show count and where it scanned.
3. The running extension reads `library.json` once at enable, so offer to
   `make reload` to make new shows appear on the desktop.

A count of exactly 8 with anime titles means the media path was unreachable and the
scanner fell back to mock data — check the drive is mounted rather than treating it
as a successful scan.
