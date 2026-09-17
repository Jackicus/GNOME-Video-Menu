# Gnomeflix

A GNOME Shell extension (UUID `gnomeflix@jackt`) that renders a media library —
TV shows, films, music, photos, documents and games — directly onto the desktop
wallpaper. No window, no titlebar. Shell version 50.

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

All `make` targets delegate to `scripts/dev.sh`; put new logic there, not in the Makefile.

## Layout

`src/` is an **exact mirror of the installed extension directory**. Installing is a
plain copy or symlink, so there is no file list to keep in sync — add a file to
`src/` and it ships.

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
   Games are the exception — see `src/backend/CLAUDE.md`.
2. `extension.js` copies `lib/` into `$XDG_RUNTIME_DIR/gnomeflix/lib-<stamp>/`
   and imports `app.js` from there. GJS caches modules by URL for the life of
   the shell, and static imports between sibling modules would resolve to the
   cached copies; a fresh directory per enable defeats that, so a
   disable/enable picks up edits **without restarting the shell**. That matters
   on Wayland, where you can't `Alt+F2 r`.
3. `GnomeflixApp` reads `library.json`, builds the surface inside the monitor's
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

The overview does not show the desktop at all — each workspace preview builds
its own wallpaper actor — so `overviewPreview.js` puts a static, non-interactive
copy of each section's library into the preview that section owns, and a clone
of it into the matching thumbnail in the strip. The copies live and die with one
overview, since the shell destroys its previews when it closes, and each is
built only as deep as the preview shows: the grid does not scroll in a picture,
so only the first few rows are worth laying out.

## Design rules

- **Motion copies the shell.** `anim.js` holds the only durations and curves in
  use: 150 ms for hover and window-style pops, 250 ms ease-out-quad for the rest,
  350 ms for the hero flight. Don't invent new ones; `actor.ease()` already
  honours the animations toggle and slow-down factor.
- **Corners come from one radius.** `corner-radius` (a setting, default 18px) is
  the only radius in the design; `shape.js` scales it into the handful the views
  need — artwork, tile, hero, thumbnail, row, pane, badge — and every rounded
  surface sets it inline as it is built. The stylesheet's `border-radius` values
  are fallbacks that match the default; change `shape.js`, not them. Pills stay
  `9999px` and are not scaled.
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
- **A rounded background image must carry its radius inline.** St bakes the
  corner radius into artwork only when it renders the background image itself,
  so `border-radius` has to travel in the same `set_style()` string as
  `background-image`, never be left to the stylesheet alone. A small radius also
  reads as "missing" on a large tile: the curve is only visible where the
  artwork's corner contrasts with the wallpaper behind it, which is why it looks
  random rather than absent.
- **St CSS is not web CSS.** No flexbox, grid, `calc()`, CSS variables or
  `linear-gradient()` (use `background-gradient-direction/start/end`). Layout is
  done in JS (`St.BoxLayout`, `Clutter.BinLayout`); the stylesheet is for paint
  only.
- **A freshly shown actor has no allocation until the next frame.** Measuring it
  for a clone flight yields NaN; `anim.js` `allocateNow()` lays it out first.
- **`_backgroundGroup` and `_keepAliveId` are private API**, and so is every
  path `overviewPreview.js` walks to reach the overview's previews
  (`controls._workspacesDisplay._workspacesViews`, a workspace's `_background`
  and its `_backgroundGroup`, `controls._thumbnailsBox._thumbnails`). All are
  underscore-prefixed shell internals that can change between releases. If
  rendering breaks after a GNOME upgrade look at the first; if section
  workspaces start collapsing, at the second (`_applyWorkspaceMode` in
  `app.js`); if the overview goes empty again, at the third.
- **A preview's background group is the monitor, allocated small.** It is the
  box the wallpaper gets, stretched in x and y independently while the overview
  animates, and it is re-allocated without reliably notifying its size — so the
  copy reads the scale back in its own `vfunc_allocate` rather than watching a
  signal, and asks for no size of its own, or the workspace is stretched out of
  shape around it. A `Clutter.Clone` paints its source through the source's own
  transform, so the thumbnail's clone has that scale undone again.
- **Never hardcode the repo path.** Resolve paths from `this.path` /
  `this.dir.get_uri()` in JS and `__file__` in Python — the extension has to work
  from the installed copy, not just the symlink. Modules under `lib/` run from a
  staging copy, so never derive resource paths from `import.meta.url` either.
- **Check the logs.** Exceptions inside the extension are swallowed into the shell
  journal, not a terminal. `make logs` is the only way to see them.
- **API keys are secrets.** They sit in dconf in plain text (the prefs say so).
  Never log them, never put them on a command line, and never paste them into
  the conversation; `~/Documents/keys/` is the user's key drop shared with other
  projects and the prefs can import from it.
