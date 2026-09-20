# Media Libraries

A GNOME Shell extension that puts a library of TV shows, films, music,
photos and games where a media player would put a window — on the desktop, in
the overview, or in a floating panel, your choice. It browses and launches
what's already there; it does not play anything itself.

See `CLAUDE.md` for how it's built.

## Requirements

GNOME Shell 48–50.

## Development

```bash
# Dev mode: symlink src/ into the extensions dir, so edits are live
make link

# Apply your edits (recompiles schemas, disable/enable, no shell restart)
make reload

# Follow shell logs, filtered to Media Libraries
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
| `make stalls` | Watch for desktop freezes and log what stalled, on what, with timestamps |
| `make pack` | Build `dist/media-libraries@jackt.shell-extension.zip` |
| `make prune` | Remove superseded builds of this extension, keeping the current one |
| `make uninstall` | Remove the extension entirely, stale older builds included |
| `make clean` | Drop compiled schemas, `dist/`, and files that don't ship |

## Seeing it

The UI renders onto the desktop wallpaper or into a shell-native panel, not
into an ordinary window, so a visual change can only be verified by looking
at it. These targets drive a throwaway **nested GNOME Shell** with a live
mirror on the real desktop — see `CLAUDE.md` and the `drive-extension` skill
before using them.

| Command | Does |
|---|---|
| `make nested` | Start the nested shell, with a live mirror window on the desktop |
| `make nested-headless` | Same, without the mirror window |
| `make preview` | Start it (if not already running) and take a screenshot |
| `make nested-status` | Report whether it's running |
| `make nested-stop` | Tear it down — always run this when finished |
