---
description: Re-index every enabled media section and download artwork
allowed-tools: Bash(make scan), Bash(./scripts/dev.sh scan), Bash(./scripts/dev.sh status)
---

Re-index the media library.

1. Run `make scan`. It reads each enabled section's folders from GSettings (TV
   Shows, Films; neither has a default, so "not set" means the section is off
   until pointed at a folder), walks them, looks items up online through each
   section's ordered source list (`<prefix>-sources`: TVmaze, TMDB and
   Wikipedia for shows; TMDB and Wikipedia for films), trying them in turn
   until one has the artwork, and writes `~/.cache/media-libraries/library.json`.
   A section whose `<prefix>-online` switch is off reads the cache and stays
   off the network. API keys are credential slots in the `credentials`
   setting, which the scanner reads itself; never print them. "no credential
   set, skipping it" in the output is a source without a key stepping aside,
   not an error.
2. Report the per-section counts and folders from the scanner's output.
3. Nothing else is needed: the running extension watches `library.json` and
   rebuilds itself when the file lands.

A section reported as "is not a folder" means its path is unreachable — check the
drive is mounted or fix the folder in Settings rather than treating it as empty.
Film lookups can log `HTTP Error 429`; that is Wikipedia rate-limiting and the
film will be retried on the next scan.
