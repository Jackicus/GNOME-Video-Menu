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
through (`./scripts/nested.sh click X Y`) to test Home → Library → Detail
navigation, and `./scripts/nested.sh say "..."` flashes a banner in it
so the watcher knows what is about to happen.

Read the **`drive-extension` skill** before driving it; it covers the lifecycle and
the traps. Keep one nested shell up across edits and `reload` into it; `make
nested-stop` tears it down — always do that when finished.

All `make` targets delegate to `scripts/`: `dev.sh` for the extension itself and
`nested.sh` for the nested-shell targets (`nested`, `nested-stop`, `preview`, …).
Put new logic in those, not in the Makefile.

## Layout

`src/` is an **exact mirror of the installed extension directory**. Installing is a
plain copy or symlink, so there is no file list to keep in sync — add a file to
`src/` and it ships.

A section's identity — its key, its `<prefix>-` settings, its title, its icon and
the order they appear in — is `SECTIONS` in `lib/library.js`, and nothing else
restates it: `prefs.js` imports that list and merges in only what its pages say,
and the scanner takes its folders from the settings rather than from a copy of
the list. Adding or renaming one is an edit there plus the schema keys.

Runtime data: `~/.cache/gnomeflix/` — `library.json`, `posters/`, `backdrops/`,
`metadata/` (one `index.json` of every cached record; the per-item files the
first release wrote are still read once and folded in), `thumbs/`. The JS never
scrapes; it only reads `library.json` that Python wrote.

**Every artwork path in `library.json` is a file in that cache, already scaled
to what the desktop draws** (posters 640×960, backdrops 1280×720, thumbs 384;
`metadata.py` holds the caps). St decodes a background image at full size on
the compositor thread and keeps it, so the scanner shrinks on the way in,
copies a `cover.jpg` it finds beside the media in with the rest, and sweeps
and prunes the cache on each scan. The JS treats an art path outside the cache
as missing.

## How it fits together

1. `scan_library.py` walks each section's folder, enriches items online and
   writes `~/.cache/gnomeflix/library.json` atomically, under an `flock` so two
   rescans cannot each write the other's sections back as they were. It reads
   the preferences itself with `--from-settings` (narrowed by `--only
   <section>`), so which setting becomes which flag is decided in one place and
   both the Rescan buttons and `dev.sh scan` just run it. Enrichment runs on a
   small thread pool — it is nearly all waiting on other people's servers — and
   each item records a `scan_sig` of its folder, so a rescan reuses the file
   list of anything that has not changed and only `--force` re-reads the lot.
   The provider is a
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
   rendering over the wallpaper itself. The surface holds the home menu and one
   **page** per section (a header over a `LibraryView`), each built once — the
   enabled ones ahead of time, one to an idle — and kept, so changing section
   or workspace is a matter of which is visible. The detail pane is shared and
   moves into whichever page opened it. A file monitor on `library.json`
   rebuilds the surface when a rescan lands.

Navigation is three levels: the **home menu**, a section's **library** (a grid)
and the **detail** pane (artwork, facts,
synopsis, then seasons/tracks/files as tabbed lists, or a thumbnail grid for photo
albums; a game's list is what there is to know about it — install folder,
playtime, serial — since a game is one thing to play, not many). Opening an item flies its artwork into the hero slot with a `Clutter.Clone`
while the grid recedes; back reverses it.

Sections live on workspaces of their own. One workspace, `workspace-index`,
carries the **home menu** (`homeView.js`): a launcher per enabled section.
Opening one claims the trailing empty workspace for that section and slides to
it; the header's Home button slides back and gives the workspace up, while
swiping away leaves it open with a dot under its launcher. Open sections are
held as `Meta.Workspace` objects, not indices, because indices shift as others
close. GNOME's dynamic workspaces would collapse those empty workspaces, so
`app.js` marks them with the same `_keepAliveId` the shell's workspace tracker
uses during drag-and-drop, and releases them when a section closes and on
disable. That is the only layout: the extension was cut back to it on purpose,
and anything beyond it (every section on one workspace behind a header
switcher, a standing workspace per section) is to be argued back in on its own
merits rather than restored wholesale.

Neither the overview nor the slide between workspaces shows the desktop at all
— each builds its own wallpaper actor per workspace — so `overviewPreview.js`
puts a `Clutter.Clone` of the live page (or the home menu) into every picture
the shell makes of one of our workspaces: the overview's previews, the
thumbnails in its strip, and the strip the slide animates, which is why the
library travels with its workspace. Nothing is built for any of them; the
clones die with the shell's own actors. A clone paints a hidden source, but
lays it out at the size it *asks* for, so the home menu and the pages are
sized outright.

Everything that runs in `app.js` and below runs **inside the compositor**, so a
long synchronous block is a dropped frame for the whole desktop. Two rules come
out of that. **Nothing builds an actor per thing you own**: the library grid and
the detail lists fill through `lazyList.js`, which builds enough to cover what
is on screen and more as it scrolls, so a section of thousands or a photo album
of thousands costs a screenful either way. And **nothing stats per item**:
`library.js` lists the three artwork cache folders once per load and looks paths
up in that, rather than a blocking `file_test` per poster.

## Design rules

- **Motion copies the shell.** `anim.js` holds the only durations and curves in
  use: 120 ms for hover and things leaving, 200 ms ease-out-quad for the rest,
  260 ms for the hero flight. Don't invent new ones; `actor.ease()` already
  honours the animations toggle and slow-down factor. A workspace change is
  the shell's slide and nothing else: no reveal of our own is queued behind it.
- **Corners come from one radius.** `corner-radius` (a setting, default 18px) is
  the only radius in the design; `shape.js` scales it into the handful the views
  need — artwork (thumbnails and rows share it), hero, pane, launcher, badge — and every rounded
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
- **Never give an image-backed widget a `box-shadow`.** St draws that shadow as
  a square box, ignoring the radius: clipped, it shows as dark rings in the
  rounded corners; unclipped, as a dark container behind the artwork. A surface
  that wants both (the home launchers) casts the shadow from a plain rounded
  card and carries the image on a child layer.
- **St CSS is not web CSS.** No flexbox, grid, `calc()`, CSS variables or
  `linear-gradient()` (use `background-gradient-direction/start/end`). Layout is
  done in JS (`St.BoxLayout`, `Clutter.BinLayout`); the stylesheet is for paint
  only.
- **A freshly shown actor has no allocation until the next frame.** Measuring it
  for a clone flight yields NaN; `anim.js` `allocateNow()` lays it out first.
- **A scroll view's `St.Adjustment` is already disposed when its `destroy`
  fires.** Disconnecting a handler from it there throws "already disposed"
  rather than tidying anything — the adjustment dies with the view, so its
  handlers go with it. `lazyList.js` takes back only its idle source.
- **Hover on a tile is crossing events, not `track_hover`.** The `hover`
  pseudo-class restyles a widget and all its children on every enter and
  leave; across a grid that is the cost of a hover. Only the few widgets that
  paint something from `:hover` (launchers, rows) track it, and no rule keys a
  descendant off a parent's `:hover`.
- **`_backgroundGroup` and `_keepAliveId` are private API**, and so is every
  path `overviewPreview.js` walks to reach the overview's previews
  (`controls._workspacesDisplay._workspacesViews`, a workspace's `_background`
  and its `_backgroundGroup`, `controls._thumbnailsBox._thumbnails`) and the
  slide (`Main.wm._workspaceAnimation`, its `_prepareWorkspaceSwitch` and
  `_switchData.monitors[]._workspaceGroups[]._background`). All are
  underscore-prefixed shell internals that can change between releases. If
  rendering breaks after a GNOME upgrade look at the first; if section
  workspaces start collapsing, at the second (`_applyWorkspaceMode` in
  `app.js`); if the overview goes empty again, or the slide goes back to bare
  wallpaper, at the third.
- **A preview's background group is the monitor, allocated small.** It is the
  box the wallpaper gets, stretched in x and y independently while the overview
  animates, and it is re-allocated without reliably notifying its size — so the
  host reads the scale back in its own `vfunc_allocate` rather than watching a
  signal, and asks for no size of its own, or the workspace is stretched out of
  shape around it. The monitor-sized frame inside it is redirected offscreen,
  so the overview scales one texture per preview rather than a page of tiles.
- **Never hardcode the repo path.** Resolve paths from `this.path` /
  `this.dir.get_uri()` in JS and `__file__` in Python — the extension has to work
  from the installed copy, not just the symlink. Modules under `lib/` run from a
  staging copy, so never derive resource paths from `import.meta.url` either.
- **Never touch a media path synchronously.** The folders can sit on a network
  share behind a systemd automount that idles out, and the first stat after
  that blocks until it is mounted again — eleven seconds, measured. In
  `prefs.js` that is how long the window takes to open; in `lib/` it is the
  whole desktop standing still. Use `query_info_async` and friends; only the
  cache folder, which is always local, is read synchronously.
- **Check the logs.** Exceptions inside the extension are swallowed into the shell
  journal, not a terminal. `make logs` is the only way to see them.
- **API keys are secrets.** They sit in dconf in plain text (the prefs say so).
  Never log them, never put them on a command line, and never paste them into
  the conversation; `~/Documents/keys/` is the user's key drop shared with other
  projects and the prefs can import from it.
