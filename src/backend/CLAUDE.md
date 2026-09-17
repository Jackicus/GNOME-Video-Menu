# Backend

API-key handling rules live in the root `CLAUDE.md` and apply here.

## Games

**Games are the one section that is not a folder of media**, so
`games_scanner.py` reads the launchers' own bookkeeping instead:
`steamapps/libraryfolders.vdf` for every library root and appid, one
`appmanifest_<appid>.acf` per title, `userdata/*/config/localconfig.vdf` for
playtime, and `PCSX2.ini` for the PS2 game folders and the covers folder.
Steam roots and the PCSX2 config folder are auto-detected, so `--games` runs
the section and `--steam-path` / `--pcsx2-path` only override that; a machine
without Steam, or with PCSX2 installed but never launched, yields an empty
list rather than an error. Proton, the Steam Linux Runtimes and the shared
redistributables are skipped. Steam art is the client's own
`appcache/librarycache` when it has cached it and the keyless
`cdn.cloudflare.steamstatic.com` when it has not; the keyless store API adds
the synopsis, genres, year and Metacritic score. PS2 games use PCSX2's own
cover (matched by title or serial) and fall back to IGDB, whose Twitch
client id/secret live in `igdb-client-id` / `igdb-client-secret` and reach the
scanner as `$GNOMEFLIX_IGDB_CLIENT_ID` / `$GNOMEFLIX_IGDB_CLIENT_SECRET`.
Launching is an argv list in the item — `xdg-open steam://rungameid/<appid>`,
or the PCSX2 binary with the disc image — which `openPath` runs as a command
line.

## Gotchas

- **Wikipedia rate-limits bursts** (HTTP 429). `metadata.py` retries with backoff;
  a film that still fails is simply retried on the next scan.
