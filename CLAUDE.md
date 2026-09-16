# Gnomeflix

A GNOME Shell extension (UUID `gnomeflix@jackt`) that renders a media library —
TV shows, films, music, photos, documents and games — directly onto the desktop
wallpaper. No window, no titlebar. Shell version 50.

## Commands

| Command | Does |
|---|---|
| `make link` | Dev mode: symlink `src/` into the extensions dir. Run once. |
| `make reload` | Apply edits — recompile schemas, disable/enable. **The main loop.** |
| `make logs` | Follow GNOME Shell's journal, filtered to Gnomeflix |
| `make status` | What's installed, whether it's active, library size |
| `make scan` | Re-index every enabled section and download artwork |
| `make install` | Real install (copy, not symlink) |
| `make pack` | Build `dist/gnomeflix@jackt.shell-extension.zip` |
| `make prune` | Remove superseded builds, keep the current one |
| `make uninstall` | Remove everything, stale builds included |
| `make clean` | Drop compiled schemas, `dist/`, `__pycache__` |
| `make preview` | Screenshot the extension running in a nested shell |
| `make nested` / `make nested-stop` | Start / stop that nested shell (with a live mirror window) |
| `make nested-headless` | Same, without the mirror window |

## Seeing it

The UI renders onto the desktop wallpaper, not into a window, so a visual change
can only be verified by looking at it. `make nested` starts a **headless nested
GNOME Shell**, loads the extension into it, and opens a **live mirror window on the
real desktop** (a PipeWire screencast of the nested monitor) so the user can watch
along without logging out. `make preview` screenshots it. It can be clicked
through (`./scripts/nested.sh click X Y`) to test Library → Detail navigation and
the section switcher, and `./scripts/nested.sh say "..."` flashes a banner in it
so the watcher knows what is about to happen.

Read the **`drive-extension` skill** before driving it; it covers the lifecycle and
the traps. Keep one nested shell up across edits and `reload` into it; `make
nested-stop` tears it down — always do that when finished.

All of them delegate to `scripts/dev.sh`; put new logic there, not in the Makefile.

`.claude/commands/` wraps the four you'll reach for most — `/reload`, `/logs`,
`/status`, `/scan`, `/preview` — with the checks worth running alongside them.

## Layout

`src/` is an **exact mirror of the installed extension directory**. Installing is a
plain copy or symlink, so there is no file list to keep in sync — add a file to
`src/` and it ships.

```
src/
├── metadata.json          # manifest; uuid + shell-version live here
├── extension.js           # entry point — stages lib/ to a fresh dir and imports it
├── prefs.js               # Libadwaita preferences: General + one page per section
├── stylesheet.css         # St CSS, paint only; all colours derive from -st-accent-color
├── lib/
│   ├── app.js             #   GnomeflixApp: surface, header, navigation, transitions
│   ├── libraryView.js     #   the tile grid for one section
│   ├── detailView.js      #   one item: hero, facts, synopsis, group tabs, list/grid
│   ├── widgets.js         #   tiles, rows, pills, segmented switcher, placeholders
│   ├── anim.js            #   the motion vocabulary (durations, curves, helpers)
│   └── library.js         #   reads library.json, normalises every media kind
├── backend/               # Python: scanning, metadata, artwork
│   ├── media_scanner.py   #   walks folders → dicts, one scanner per section
│   ├── games_scanner.py   #   reads Steam's vdf/acf library and PCSX2's ini instead
│   ├── metadata.py        #   TVmaze / TMDB / Wikipedia / iTunes / Steam / IGDB lookups, photo thumbnails
│   └── scan_library.py    #   CLI entry point; what the Rescan buttons run
└── schemas/               # GSettings schema (compiled artifact is gitignored)
```

Runtime data: `~/.cache/gnomeflix/` — `library.json`, `posters/`, `backdrops/`,
`metadata/`, `thumbs/`. The JS never scrapes; it only reads `library.json` that Python wrote.

## How it fits together

1. `scan_library.py` walks each section's folder, enriches items online and
   writes `~/.cache/gnomeflix/library.json` atomically. The provider is a
   per-section setting: TV shows use TVmaze, TMDB or Wikipedia; films use TMDB
   or Wikipedia (Wikipedia automatically when TMDB has no key); albums use
   iTunes; photos get local thumbnails; documents stay shallow and offline. TMDB
   also yields a backdrop, tagline, runtime and rating, which the detail pane
   shows. The TMDB key lives in `tmdb-api-key` and reaches the scanner as
   `$GNOMEFLIX_TMDB_KEY`, never on argv. Each cache entry records the provider
   that wrote it, so switching provider refetches on the next scan. Sections are merged, so rescanning one keeps the others. Music,
   Photos and Documents default to the XDG user folders; TV Shows and Films have
   no default because the Videos folder cannot serve both, so they are off until
   pointed at a folder (prefs, `dev.sh scan` and the scanner all follow this).
2. **Games are the one section that is not a folder of media**, so
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
3. `extension.js` copies `lib/` into `$XDG_RUNTIME_DIR/gnomeflix/lib-<stamp>/`
   and imports `app.js` from there. GJS caches modules by URL for the life of
   the shell, and static imports between sibling modules would resolve to the
   cached copies; a fresh directory per enable defeats that, so a
   disable/enable picks up edits **without restarting the shell**. That matters
   on Wayland, where you can't `Alt+F2 r`.
4. `GnomeflixApp` reads `library.json`, builds the surface inside the monitor's
   work area, and attaches it to `Main.layoutManager._backgroundGroup` —
   rendering over the wallpaper itself. A file monitor on `library.json` rebuilds
   the surface when a rescan lands.

Navigation is two levels: the **library** (a grid for the active section, switched
with the segmented control in the header) and the **detail** pane (artwork, facts,
synopsis, then seasons/tracks/files as tabbed lists, or a thumbnail grid for photo
albums; a game's list is what there is to know about it — install folder,
playtime, serial — since a game is one thing to play, not many). Opening an item flies its artwork into the hero slot with a `Clutter.Clone`
while the grid recedes; back reverses it.

`layout-mode` decides where sections live. `single` puts them all on one
workspace. `workspaces` (the default) gives each enabled section its own
workspace from `workspace-index` up (six, in section order), so the shell's own swipe browses the library
and the header switcher becomes a workspace jumper. GNOME's dynamic workspaces
would collapse those empty workspaces, so `app.js` marks them with the same
`_keepAliveId` the shell's workspace tracker uses during drag-and-drop, and
releases them on disable.

## Design rules

- **Motion copies the shell.** `anim.js` holds the only durations and curves in
  use: 150 ms for hover and window-style pops, 250 ms ease-out-quad for the rest,
  350 ms for the hero flight. Don't invent new ones; `actor.ease()` already
  honours the animations toggle and slow-down factor.
- **Colour comes from the accent.** The stylesheet never hardcodes a hue. Use
  `-st-accent-color` / `-st-accent-fg-color` with `st-lighten()`, `st-mix()` and
  `st-transparentize()`, exactly as `gnome-shell.css` does. Neutrals are the
  shell's own (`#222226`, `#fafafb`).
- **Placeholders are drawn, not generated.** Missing artwork gets an
  accent-tinted tile built in `widgets.js`, so nothing stale is cached on disk and
  an accent change shows immediately.

## Gotchas

- **`extension.js` itself is cached for the life of the shell.** `make reload`
  picks up everything under `lib/`, `stylesheet.css` and the schema, but an edit to
  `extension.js` or `metadata.json` needs a log out / log back in (or, for the
  nested shell, `stop` + `start`).
- **New UUIDs need a logout** for the same reason: the shell only scans for
  unknown extension UUIDs at startup.
- **`make reload` is not optional.** Edits in `src/` are live on disk via the
  symlink, but the shell holds the old module until the disable/enable cycle.
- **St CSS is not web CSS.** No flexbox, grid, `calc()`, CSS variables or
  `linear-gradient()` (use `background-gradient-direction/start/end`). Layout is
  done in JS (`St.BoxLayout`, `Clutter.BinLayout`); the stylesheet is for paint
  only.
- **A freshly shown actor has no allocation until the next frame.** Measuring it
  for a clone flight yields NaN; `anim.js` `allocateNow()` lays it out first.
- **`_backgroundGroup` and `_keepAliveId` are private API.** Both are
  underscore-prefixed shell internals that can change between releases. If
  rendering breaks after a GNOME upgrade look at the first; if section
  workspaces start collapsing, at the second (`_applyWorkspaceMode` in `app.js`).
- **Never hardcode the repo path.** Resolve paths from `this.path` /
  `this.dir.get_uri()` in JS and `__file__` in Python — the extension has to work
  from the installed copy, not just the symlink. Modules under `lib/` run from a
  staging copy, so never derive resource paths from `import.meta.url` either.
- **Check the logs.** Exceptions inside the extension are swallowed into the shell
  journal, not a terminal. `make logs` is the only way to see them.
- **Wikipedia rate-limits bursts** (HTTP 429). `metadata.py` retries with backoff;
  a film that still fails is simply retried on the next scan.
- **API keys are secrets.** They sit in dconf in plain text (the prefs say so).
  Never log them, never put them on a command line, and never paste them into
  the conversation; `~/Documents/keys/` is the user's key drop shared with other
  projects and the prefs can import from it.
