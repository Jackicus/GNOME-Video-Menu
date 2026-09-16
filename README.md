# Gnomeflix 🎬

A native GNOME desktop media player and library dashboard designed to live directly on your GNOME workspaces (e.g. Workspace 1 for TV Shows, Workspace 2 for Movies) without window containers, titlebars, or transparency workarounds.

## Architecture

- **Direct Desktop Rendering:** Attaches directly to `Main.layoutManager._backgroundGroup` to render over your desktop wallpaper.
- **Zero-Snap Stacking:** Built with `Clutter.BinLayout` so all 3 navigation levels (Library, Seasons, Episodes) overlay seamlessly without vertical jumping or layout displacement.
- **GNOME-Native Animations:** Snappy sliding transitions (`Clutter.AnimationMode.EASE_OUT_QUAD`) and cubic hero poster expansion (`Clutter.AnimationMode.EASE_OUT_CUBIC`).
- **Dynamic Module Hot-Reloading:** `extension.js` is a thin timestamp loader that imports `lib/mediaWorkspace.js`. Any edits reload live with `make reload` — no GNOME Shell restart, which matters on Wayland.
- **Libadwaita Preferences Dialog:** Native settings for media directories, desktop columns, workspace picker, and one-click library indexing.

## Directory Structure

`src/` is an exact mirror of the installed extension directory, so installing is a
straight copy (or a symlink in dev mode) with no file list to keep in sync.

```text
gnomeflix/
├── src/                    # ← becomes ~/.local/share/gnome-shell/extensions/gnomeflix@jackt
│   ├── metadata.json       # Extension manifest (UUID: gnomeflix@jackt)
│   ├── extension.js        # Entry point — dynamic hot loader
│   ├── prefs.js            # Libadwaita preferences dialog
│   ├── stylesheet.css      # Desktop presentation styles (strict St CSS)
│   ├── lib/
│   │   └── mediaWorkspace.js   # Core UI, layout manager, and animation engine
│   ├── backend/
│   │   ├── media_scanner.py    # Local media directory parser
│   │   ├── metadata.py         # Metadata scraper and artwork downloader
│   │   └── scan_library.py     # CLI entry point used by the prefs Rescan button
│   └── schemas/
│       └── org.gnome.shell.extensions.gnomeflix.gschema.xml
├── scripts/
│   └── dev.sh              # install / link / reload / logs / pack / scan / status
├── Makefile                # Thin wrapper over scripts/dev.sh
└── README.md
```

Runtime data lives in `~/.cache/gnomeflix/` (`library.json`, `posters/`, `metadata/`).

## Development

```bash
# Dev mode: symlink src/ into the extensions dir, so edits are live
make link

# Apply your edits (recompiles schemas, disable/enable, no shell restart)
make reload

# Follow shell logs, filtered to Gnomeflix
make logs

# Index the media library and download artwork
make scan
```

`make link` is the one to use while working in this repo. Run it once; after that
`make reload` picks up every edit straight from `src/`.

## Other commands

| Command | Does |
|---|---|
| `make install` | Clean copy into the extensions dir (a real install, not a symlink) |
| `make status` | Show what's installed, whether it's enabled, and library size |
| `make pack` | Build `dist/gnomeflix@jackt.shell-extension.zip` |
| `make prune` | Remove superseded builds of this extension, keeping the current one |
| `make uninstall` | Remove the extension entirely, stale older builds included |
| `make clean` | Drop compiled schemas, `dist/`, and `__pycache__` |
