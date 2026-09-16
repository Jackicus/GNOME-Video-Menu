---
description: Re-index every enabled media section and download artwork
allowed-tools: Bash(make scan), Bash(./scripts/dev.sh scan), Bash(./scripts/dev.sh status)
---

Re-index the media library.

1. Run `make scan`. It reads each enabled section's folder from GSettings (TV
   shows, films, music, photos, documents; an empty path means the XDG user folder
   for music, photos and documents, and "not set" for TV shows and films), walks it,
   looks items up online with the provider chosen per section (TVmaze, TMDB or
   Wikipedia for shows; TMDB or Wikipedia for films; iTunes for album art),
   generates photo thumbnails, and writes `~/.cache/gnomeflix/library.json`.
   Games have no folder to walk: `--games` reads Steam's own library files and
   PCSX2's ini, so `steam-path` / `pcsx2-path` are empty ("auto-detected") unless
   someone has overridden them. The TMDB key and the IGDB client id/secret are
   read from GSettings and passed in the environment; never print them.
2. Report the per-section counts and folders from the scanner's output.
3. Nothing else is needed: the running extension watches `library.json` and
   rebuilds itself when the file lands.

A section reported as "is not a folder" means its path is unreachable — check the
drive is mounted or fix the folder in Settings rather than treating it as empty.
Film lookups can log `HTTP Error 429`; that is Wikipedia rate-limiting and the
film will be retried on the next scan. "PCSX2: nothing found" is normal on a
machine with no PS2 discs — PCSX2 writes its ini on first launch, and until then
there is nothing to read.
