# Gnomeflix

A GNOME Shell extension (UUID `gnomeflix@jackt`) that renders a TV/film library
directly onto the desktop wallpaper — no window, no titlebar. Shell version 50.

## Commands

| Command | Does |
|---|---|
| `make link` | Dev mode: symlink `src/` into the extensions dir. Run once. |
| `make reload` | Apply edits — recompile schemas, disable/enable. **The main loop.** |
| `make logs` | Follow GNOME Shell's journal, filtered to Gnomeflix |
| `make status` | What's installed, whether it's active, library size |
| `make scan` | Re-index the media dir and download artwork |
| `make install` | Real install (copy, not symlink) |
| `make pack` | Build `dist/gnomeflix@jackt.shell-extension.zip` |
| `make prune` | Remove superseded builds, keep the current one |
| `make uninstall` | Remove everything, stale builds included |
| `make clean` | Drop compiled schemas, `dist/`, `__pycache__` |

All of them delegate to `scripts/dev.sh`; put new logic there, not in the Makefile.

`.claude/commands/` wraps the four you'll reach for most — `/reload`, `/logs`,
`/status`, `/scan` — with the checks worth running alongside them.

## Layout

`src/` is an **exact mirror of the installed extension directory**. Installing is a
plain copy or symlink, so there is no file list to keep in sync — add a file to
`src/` and it ships.

```
src/
├── metadata.json          # manifest; uuid + shell-version live here
├── extension.js           # entry point — thin cache-busting module loader
├── prefs.js               # Libadwaita preferences dialog
├── stylesheet.css         # St CSS (a strict subset — see Gotchas)
├── lib/mediaWorkspace.js  # all the UI, layout and animation (~950 lines)
├── backend/               # Python: scanning, metadata, artwork
│   ├── media_scanner.py   #   walks the media dir → show/episode dicts
│   ├── metadata.py        #   TVmaze lookup, poster download, SVG fallback
│   └── scan_library.py    #   CLI entry point; what the prefs button runs
└── schemas/               # GSettings schema (compiled artifact is gitignored)
```

Runtime data: `~/.cache/gnomeflix/` — `library.json`, `posters/`, `metadata/`.
The JS never scrapes; it only reads `library.json` that the Python wrote.

## How it fits together

1. `scan_library.py` walks the media dir, enriches each show via TVmaze, and
   writes `~/.cache/gnomeflix/library.json`.
2. `extension.js` dynamically imports `lib/mediaWorkspace.js` with a `?v=<timestamp>`
   cache-buster, so a disable/enable picks up edits **without restarting the shell**.
   That matters on Wayland, where you can't `Alt+F2 r`.
3. `GnomeflixApp` reads `library.json` and attaches its actors to
   `Main.layoutManager._backgroundGroup` — rendering over the wallpaper itself.

## Gotchas

- **New UUIDs need a logout.** The shell only scans for unknown extension UUIDs at
  startup. `make reload` handles every edit after that, but the very first
  `make link` needs a log out / log back in before the shell sees the extension.
- **`make reload` is not optional.** Edits in `src/` are live on disk via the
  symlink, but the shell holds the old module until the disable/enable cycle.
- **St CSS is not web CSS.** No flexbox, no grid, no `calc()`, no CSS variables.
  Layout is done in JS (`St.BoxLayout`, `Clutter.BinLayout`); the stylesheet is for
  paint (colors, borders, padding, font) only.
- **`_backgroundGroup` is private API.** It's an underscore-prefixed internal that
  can change between shell releases. If rendering breaks after a GNOME upgrade,
  look there first.
- **Never hardcode the repo path.** Resolve paths from `this.path` /
  `this.dir.get_uri()` in JS and `__file__` in Python — the extension has to work
  from the installed copy, not just the symlink.
- **Check the logs.** Exceptions inside the extension are swallowed into the shell
  journal, not a terminal. `make logs` is the only way to see them.
