# Gnomeflix 🎬

A native GNOME desktop media player and library dashboard designed to live directly on your GNOME workspaces (e.g. Workspace 1 for TV Shows, Workspace 2 for Movies) without window containers, titlebars, or transparency workarounds.

## Architecture

- **Direct Desktop Rendering:** Attaches directly to `Main.layoutManager._backgroundGroup` to render over your desktop wallpaper.
- **Zero-Snap Stacking:** Built with `Clutter.BinLayout` so all 3 navigation levels (Library, Seasons, Episodes) overlay seamlessly without vertical jumping or layout displacement.
- **GNOME-Native Animations:** Snappy sliding transitions (`Clutter.AnimationMode.EASE_OUT_QUAD`) and cubic hero poster expansion (`Clutter.AnimationMode.EASE_OUT_CUBIC`).
- **Dynamic Module Hot-Reloading:** `extension.js` serves as a dynamic timestamp loader that imports `media_workspace.js`. Any edits reload live with `gnome-extensions disable` / `enable` without restarting the GNOME Shell.
- **Libadwaita Preferences Dialog:** Native settings for media directories, desktop columns, workspace picker, and one-click library indexing.

## Directory Structure

```text
Projects/gnomeflix/
├── extension.js          # GNOME Shell extension entry point (dynamic hot loader)
├── media_workspace.js    # Core UI, layout manager, and animation engine
├── prefs.js              # Libadwaita preferences dialog
├── stylesheet.css        # Desktop presentation styles (strict St CSS)
├── media_scanner.py      # Local media directory parser
├── metadata.py           # Metadata scraper and artwork downloader
├── metadata.json         # Extension manifest (UUID: gnomeflix@jackt)
├── schemas/              # GSettings schema definition & compiled binary
├── install.sh            # One-click schema compilation and extension installer
└── Makefile              # Development tasks (compile, install, reload, pack)
```

## Quick Development Commands

```bash
# Compile schemas and install to ~/.local/share/gnome-shell/extensions/gnomeflix@jackt
make install

# Hot-reload in running GNOME Shell (no logout needed!)
make reload

# Package into extension zip bundle
make pack
```
