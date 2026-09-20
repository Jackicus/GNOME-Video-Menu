---
description: Re-index every enabled media section and download artwork
allowed-tools: Bash(make scan), Bash(./scripts/dev.sh scan), Bash(./scripts/dev.sh status)
---

Re-index the media library.

1. Run `make scan`. It reads each enabled section's folder from GSettings (TV
   shows, films, music, photos; an empty path means the XDG user folder
   for music and photos, and "not set" for TV shows and films), walks it,
   looks items up online through each section's ordered source list
   (`<prefix>-sources`: TVmaze, TMDB and Wikipedia for shows; TMDB and
   Wikipedia for films; iTunes for album art), trying them in turn until one
   has the artwork, generates photo thumbnails, and writes
   `~/.cache/media-libraries/library.json`. A section whose `<prefix>-online` switch
   is off reads the cache and stays off the network.
   Games have no folder to walk: `--games` reads Steam's own library files and
   PCSX2's ini, so `steam-path` / `pcsx2-path` are empty ("auto-detected") unless
   someone has overridden them. API keys are credential slots in the
   `credentials` setting, which the scanner reads itself; never print them.
   "no credential set, skipping it" in the output is a source without a key
   stepping aside, not an error.
2. Report the per-section counts and folders from the scanner's output.
3. Nothing else is needed: the running extension watches `library.json` and
   rebuilds itself when the file lands.

A section reported as "is not a folder" means its path is unreachable — check the
drive is mounted or fix the folder in Settings rather than treating it as empty.
Film lookups can log `HTTP Error 429`; that is Wikipedia rate-limiting and the
film will be retried on the next scan. "PCSX2: nothing found" is normal on a
machine with no PS2 discs — PCSX2 writes its ini on first launch, and until then
there is nothing to read.
