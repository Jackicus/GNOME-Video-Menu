# Video Menu

A GNOME Shell extension (UUID `media-libraries@jackt`) that renders a video
library — TV shows and films — directly onto the desktop wallpaper, in the
overview beside the apps, or in a shell-native panel, depending on a setting.
No window, no titlebar. Shell versions 48 to 50 (48 and 49 by audit against
the shell's sources, not by boot — see the compat note in Gotchas).
"Video Menu" is only the name it shows — `metadata.json`'s `name`, which is
what the extension list and the preferences window read. Everything else
still says `media-libraries` (the UUID, the schema, the cache folders, the
`[Media Libraries]` log tag `make logs` filters on, and the `MediaLibraries*`
class names), and the rest of this file calls it Media Libraries.

A sibling extension, **Games Menu** (`games-menu@jackt`,
`/home/jackt/Projects/GNOME-Extensions/GNOME-Games-Menu`), is the same idea for a
games library and is meant to run alongside this one — see the coexistence
note near the end of this file for what that costs each of them.

## Seeing it

The UI renders onto the desktop wallpaper or into shell chrome, not into an
ordinary window, so a visual change can only be verified by looking at it.
`make nested` starts a **headless nested GNOME Shell**, loads the extension
into it, and opens a **live mirror window on the real desktop** (a PipeWire
screencast of the nested monitor) so the user can watch along without logging
out. `make preview` screenshots it. It can be clicked through
(`./scripts/nested.sh click X Y`) to test the button beside Show Apps, the
tabs it opens between TV Shows and Films, and Library → Detail navigation, and
`./scripts/nested.sh say "..."` flashes a banner in it so the watcher knows
what is about to happen. **`start --clean`** gives it a settings database of
its own — only this extension enabled, the real session's look copied in,
nothing written to `~/.config/dconf/user` — which is what to use to test a
setting while another project's nested shell is up; **`--demo`** on top shows
the made-up library `scripts/demo_library.py` draws instead of the user's, and
is what `docs/screenshots/` is taken of (a public repo gets nobody's real
collection).

Read the **`drive-extension` skill** before driving it; it covers the lifecycle and
the traps. Keep one nested shell up across edits and `reload` into it; `make
nested-stop` tears it down — always do that when finished.

All `make` targets delegate to `scripts/`: `dev.sh` for the extension itself and
`nested.sh` for the nested-shell targets (`nested`, `nested-stop`, `preview`, …).
Put new logic in those, not in the Makefile.

`docs/` holds what is not about working on the code day to day:
`docs/private-api.md` (every reach into shell internals, for reviewers and
for porting to the next GNOME), `docs/compatibility.md` (what has been tested
where, and what depends on the version), `docs/publishing.md` (making the
extensions.gnome.org zip, and how the extension stands against the review
guidelines), and `docs/screenshots/` (the README's images).

## Layout

`src/` is an **exact mirror of the installed extension directory**. Installing is a
plain copy or symlink, so there is no file list to keep in sync — add a file to
`src/` and it ships.

A section's identity — its key, its `<prefix>-` settings, its title, its icon and
the order they appear in — is `SECTIONS` in `lib/library.js` (TV Shows and
Films, in that order), and nothing else restates it: `prefs.js` imports that
list and merges in only what its pages say, and the scanner takes its folders
from the settings rather than from a copy of the list. Adding a third section
is an edit there plus the schema keys; `library.js` also exports `LIBRARY`,
the one thing that is not per-section — the button's own title ("Videos") and
its icon path — read by `libraryButton.js` and nowhere else.

Runtime data: `~/.cache/media-libraries/` — `library.json`, `posters/`, `backdrops/`,
`metadata/` (one `index.json` of every cached record; the per-item files the
first release wrote are still read once and folded in). The JS never
scrapes; it only reads `library.json` that Python wrote.

**Every artwork path in `library.json` is a file in that cache, already scaled
to what the desktop ever draws, HiDPI included** (posters 512×768, backdrops
960×540; `metadata.py POSTER_BOX`/`BACKDROP_BOX` hold the caps, sized off
`mediaGrid.js`'s tile and `detailView.js HERO_MAX_HEIGHT`). St decodes a
background image at full size on the compositor thread and keeps it, so the
scanner shrinks on the way in, copies a `cover.jpg` it finds beside the media
in with the rest, and sweeps and prunes the cache on each scan — only when it
is writing the shared `library.json`, though: a run sent somewhere else with
`--out` is merged onto that file's sections and would prune artwork the real
library still names. The JS treats an art path outside the cache as missing.

## How it fits together

1. `scan_library.py` walks each section's folder, enriches items online and
   writes `~/.cache/media-libraries/library.json` atomically, under an `flock` so two
   rescans cannot each write the other's sections back as they were. It reads
   the preferences itself with `--from-settings` (narrowed by `--only
   <section>`), so which setting becomes which flag is decided in one place and
   both the Rescan buttons and `dev.sh scan` just run it. Enrichment runs on a
   small thread pool — it is nearly all waiting on other people's servers — and
   each item records a `scan_sig` of its folder, so a rescan reuses the file
   list of anything that has not changed and only `--force` re-reads the lot.
   Where a section looks is an **ordered list** of sources,
   `<prefix>-sources`, tried one after another until one comes back with the
   artwork: TV shows can name TVmaze, TMDB and Wikipedia; films TMDB and
   Wikipedia. TMDB also yields a backdrop, tagline, runtime and rating, which
   the detail pane shows. Each section has its own `<prefix>-online` switch as
   well; there is no global one. Each cache entry records the source that wrote
   it, so a title already answered by one of a section's sources is not fetched
   again, and dropping that source refetches on the next scan. Sections are merged, so rescanning one keeps the others. A section's
   folders are an ordered list too, `<prefix>-folders`, added and removed on
   the Files group the way sources are; every folder is walked into one list
   for the section (a name found in two folders gets a `~2` id), and the
   flags are repeatable to match (`--films-path A --films-path B`).
   `<prefix>-path` is the single folder earlier releases kept: the prefs move
   it into the list when they open, and the scanner reads it only while the
   list is empty. Neither section has a default folder — the Videos folder
   cannot serve both TV Shows and Films — so both are off until pointed at one
   (prefs, `dev.sh scan` and the scanner all follow this).
   An item's `scan_sig` includes its folder's path as well as the tree's
   mtimes: what a match reuses is the file list, every entry of it an absolute
   path, so a drive renamed under an untouched tree must read as changed or
   every file in it is opened where it used to be.

   A list entry is a source name with a **credential slot** — `tmdb` is
   `tmdb@1`, `tmdb@2` is a second TMDB key to fall back to when the first is
   rate-limited or has never heard of the title. Slots live in one `credentials`
   setting (`a{ss}`, one value per slot — TMDB is the only source left that
   needs a key), so the slot TV shows name and the slot films name are *the
   same key*: edit it on either page and both change. A slot with nothing in
   it makes the sources that name it skip themselves, which is why TMDB sits
   unkeyed in the default lists rather than being an error. The scanner reads
   `credentials` out of GSettings itself under `--from-settings`, so neither
   the Rescan buttons nor `dev.sh scan` hands it a key; only a standalone run
   falls back to `$MEDIA_LIBRARIES_TMDB_KEY` for slot 1.
2. `extension.js` copies `lib/` into `$XDG_RUNTIME_DIR/media-libraries/lib-<stamp>/`
   and imports `app.js` from there, where `<stamp>` is a checksum of `lib/`'s
   file contents (name, size, mtime), not a timestamp of the build. GJS caches
   modules by URL for the life of the shell, and static imports between
   sibling modules would resolve to the cached copies, so a directory that
   changes name when the content changes is what lets a disable/enable pick up
   edits **without restarting the shell** — that matters on Wayland, where you
   can't `Alt+F2 r`. A screen lock disables the extension and unlocking
   re-enables it (`session-modes` defaults to `['user']`), which is not an
   edit: it stages the same checksum, skips the copy, and re-imports the same
   URL, which GJS serves from its module cache rather than re-executing — so
   an unlock re-enables into the same module graph the previous session used,
   and only an edit's changed checksum ever builds a new one.
3. `MediaLibrariesApp` reads `library.json`, builds the surface inside the monitor's
   work area, and attaches it to `Main.layoutManager._backgroundGroup` —
   rendering over the wallpaper itself. The surface holds **one library page** —
   tabs over a grid per section (`libraryView.js` over `mediaGrid.js`), each
   grid built once, the enabled ones ahead of time one to an idle, and kept, so
   switching tabs is a matter of which grid is visible — and **one detail
   page**, a header over the shared pane. The pane sits in the detail page of
   its own, or moves into the library page when it is replacing the grid. A
   file monitor on `library.json` rebuilds the surface when a rescan lands.
   All of this is built only when `library-opens-in` or `detail-opens-in` is a
   surface place — see below.

**Watched marks** (`lib/tracking.js`, setting `tracking`) are two files of one
format: `~/.local/share/media-libraries/watched.json`, every mark made on this
machine keyed by absolute path, and `<folder>/.media-libraries-watched.json`
at the top of each TV/film folder in `<prefix>-folders`, that folder's marks
keyed by the path inside it so another machine mounting it elsewhere reads
them. `local` uses the first alone; `source` also folds each folder's file
into it (later `at` wins; an unmark is kept as `watched: false` so it beats an
older mark) and writes each folder its share back — on enable, on a folder
change, when a rescan lands and on every tick; `none` touches neither. The
local file is never trimmed, so marks outlive a folder leaving the list;
`source` → `local` deletes the folder files and going back rewrites them. A
folder file is only ever written after it has been read, so another machine's
marks are never overwritten unseen. The toggle is the index disc of a row in
the detail list (`widgets.js` `createRow` `watched`), for sections with
`watched: true` in `SECTIONS`. The tracker emits `changed` for every flip,
which is how a row already built shows a mark it did not make. The scanner skips dot-files, and the file sits
beside the item folders rather than in one, so no `scan_sig` moves with it.

**Playback is followed, not driven** (`lib/playback.js`). The watcher listens
on the session bus for MPRIS players — VLC, or anything else in the shell's
media controls — and follows whichever has a file under a watched folder open,
however it was opened. Past `watched-threshold` percent of its length the
file is marked; where it stopped short of that is kept in the same entry as
`position` (and so travels in the folder file too), and a Play from the
library seeks there less `resume-rewind` once the player has the file
(`resumeNext`, SetPosition over MPRIS, so any player that can seek will do —
which is why the default VLC command turns VLC's own `--qt-continue` off).
MPRIS never announces the position and a closed player cannot be asked it,
so the watcher keeps the last reading and the monotonic time it was taken,
and reckons forward from that while playing: the 30 s poll only corrects
drift and catches the threshold, and a pause, seek, file change, the player
going, or a disable (the screen locking) each settle the position
themselves. Nothing is written while a file plays; the tracker writes when
one of those happens. The player controls themselves are meant to be a
separate extension, not this one.

The detail pane's primary button is a **Continue** button for these
sections (`detailView.js` `_syncPlay`, `Tracker.continueFrom`): the file
touched last if it was left partway or unticked, else the first unwatched
episode after it in the numbered seasons (Extras are not part of the run).
With nothing touched, or everything after it watched, it falls back to the
scan's own `playLabel` — "Play S01E01". It follows `changed`, which a kept
position emits too, so it moves on while the pane is up.

Navigation is two levels: the **library** (tabs between TV Shows and Films
over a grid of each) and the **detail** pane (artwork, facts, synopsis, then
seasons or files as tabbed lists). Opening an item flies its artwork into the
hero slot with a `Clutter.Clone` while the grid recedes; back reverses it.

**The library grid is the shell's own app grid** (`mediaGrid.js`): a subclass of
the class `AppDisplay` is built on, holding posters instead of apps, so pages,
swipe, the page dots, the hover arrows and scroll-wheel paging come with it. One
grid serves every place — the pages on the wallpaper, the pages in the
overview's slot and the pages in the modal library's panel — and a tile is an
`AppViewItem` around a `BaseIcon` styled
`overview-tile`, which is where its hover, focus ring and label come from. Ours
is only the shape: the icon asks for its artwork's proportions rather than a
square, the layout places cells of that shape the theme's own gap apart, and a
view builds the pages in reach of the one showing rather than a tile per item.

**The keyboard is St's.** The page stack inside the surface is a focus group
(`global.focus_manager.add_group`), as the shell's dialogs and menus are, and so
is each grid — the *nearest* group around what is focused is the one the arrow
keys walk, which is why the grid registers itself and not just the stack. The
group is the stack and not the surface around it because a focus group that can
take the keyboard itself yields the focus rather than passing it on
(`st_widget_real_navigate_focus`), and the surface *is* focusable: it is what
holds the keyboard while nothing else does, and what Escape bubbles up to.
Nothing is focused until a navigation key asks for it, as in the app grid; then
Tab and the arrows move, Enter opens, and Escape (ours) backs out a level.
Whatever holds the keyboard is constantly being hidden or destroyed — a tile as
its grid recedes, a list as the pane is filled — and Clutter drops key focus to
the stage when that happens, so `app.js` watches `notify::key-focus` and takes
it back while the surface is what the workspace shows.

The tabs and the grid under them are two different focus groups too — the
grid is one, as above, and St never walks from one group into another — so
the one step between them is `libraryView.js`'s own: an arrow up from the
grid's top row (`atTopRow`) focuses the tabs, and an arrow down from the tabs
focuses the grid's first tile. Landing on a tab at all, however it got there,
chooses it (`key-focus-in`), which is what lets a remote with nothing but
arrows switch between TV Shows and Films. This is the only place a key is
looked at outside `app.js`'s own `_onKeyPress` and the bound-key handling
below.

**Remotes and controllers are the keyboard too** (`lib/controls.js`, the
actions in `lib/actions.js`, the Controls page in the prefs). Ten actions —
the four directions, Select, Back, Home, a page each way, Mark watched — each
with a list of keys (`keys-<action>`, `a(uu)` of keyval and modifiers: numbers,
because Clutter's keysym table lacks half of what a remote sends, `XF86OK` and
`XF86HomePage` among them) and a list of controller inputs (`pad-<action>`,
`"button:304"`, `"axis:1-"`). The first six stand for a key and are replayed
as it through a Clutter virtual keyboard, so they do exactly what the arrows,
Enter and Escape do wherever the keyboard is; paging (`mediaGrid.js`
`pageBy`, since the shell's grid turns no page for a key), Home and Mark
watched (a row's `toggleWatched`, since St's focus stops at the row and never
reaches the disc inside it) are done directly. A bound key is handed over by
the view it reached — the surface's `_onKeyPress`, a grid's own key handler,
a panel's `vfunc_key_press_event` — so a binding means nothing outside a
library and a remote's Back stays the browser's Back. Controllers are read
with libmanette (loaded on demand; the extension runs without it) and acted
on only while `_controlsActive()`, except Home, which opens the library when
no window has the focus. The arrows, Enter and Escape are never offered for
binding: they always work. A pop-up panel holds the keyboard itself as it
opens, and an arrow from the panel finds nothing to move to, so its first
navigation key lands where Tab would (`panel.js` `_focusFirst`) — without it
a remote with only arrows could not get into one.

Where each of the two things opens is a setting, and the two are read
**independently of each other**: `library-opens-in` for a section's grid,
`detail-opens-in` for the pane of a picked item. Both take the same four
values, meaning the same four places — `desktop`, `workspaces`, `menu`,
`modal` — so the pair is a matter of where things go and never of how the two
settings negotiate. Exactly one thing follows from the pair rather than from
either alone, and it is named: `_detailInPlace()` in `app.js`, the grid and
the pane landing on the same workspace, which is what makes a pick a hero
flight *in place of* the grid rather than a move to somewhere else.

`desktop` and `workspaces` are the two **surface** places: the library drawn
on the wallpaper, brought up by the one button beside Show Apps and put away
by it again — Escape or the library header's own close button do the same.
They differ only in where what you open lands, and there is no home menu:
`desktop` draws nothing at all until the button is pressed. In `desktop` the
library then appears on the wallpaper of whichever workspace the button was
pressed on, following a press on another workspace rather than opening a
second copy; it claims no workspace of its own (`_libraryWorkspace` is just
"the workspace it is currently on"), though that one is held open while the
library is up on it, like everything below. In `workspaces` the button claims the
trailing empty workspace for the library and slides to it; closing it slides
back to the workspace it was opened from and gives the claimed one up.
`detail-opens-in` `workspaces` claims one for the pane the same way, on top of
whichever of the two the library is using. Either way, the workspace the
library (or the pane) was opened *from* is held open while it is away —
`app.js` `_holdWorkspaces()`, called after anything that changes what is
claimed — so a desktop left empty for the library is not folded away behind
it and there is always somewhere for Back or the close button to land.
Claimed workspaces are held as `Meta.Workspace` objects, not indices, because
indices shift as others close; GNOME's dynamic workspaces would collapse the
empty ones, so `app.js` marks every workspace it is holding — claimed or just
kept open — with the same `_keepAliveId` the shell's workspace tracker uses
during drag-and-drop, and releases it once nothing needs it any more, and on
disable. The `desktop` place claims nothing for the library itself — it only
holds open a workspace that was already there — which is why it is also the
mode with the least private API under it.

The surface is built when *either* setting is a surface place. It holds **one
library page** — the tabs over a grid per section, `libraryView.js` — and
**one detail page**, a header over the shared pane, which is what a pick gets
whenever it is not taking the grid's place; its header is retitled per pick,
since there is one pane and one pick. That separation is what lets the
library's workspace and the pane's workspace show different things at once,
which the overview's previews clone side by side.

What the surface shows is two pieces of state, not one: `_placeForWorkspace()`
is worked out fresh each time from what survives a rebuild — `_libraryWorkspace`,
`_detailWorkspace`, `_picked`, `_origin`, none of which `_teardown` touches —
while `_shown` is what is actually on the stack, and does not survive one: a
rebuild empties the stack without changing what a workspace is set to show.
They differ exactly across a rebuild, which is why `_onWorkspaceChanged`
compares the computed place against `_shown` — comparing it against itself
left the surface blank after a rescan or a settings change.

`menu` and `modal` are the two places **outside** the surface, and a library
in either is browsed by a *browser* of its own — `MediaMenu` or
`LibraryWindow`, both holding one `LibraryView` — opened from the one button
made as Show Apps is and put beside it (in the dash, or in Dash to Panel's
panel). `libraryButton.js` builds that button — a `Dash.ShowAppsIcon`
subclass for its icon and label — and both places open from it. The button
(and `library-shortcut`, below, which presses it) is the only way in, and it
behaves as a dock's Show Apps does: pressed on the desktop it opens the
overview itself, so a second press or Escape closes it again and lands on the
desktop; pressed with the overview already up, back to the window picker.
Every way out of an overview it opened goes all the way down, Show Apps
included: a dock keeps a `forcedOverview` flag of its own that ours never
sets, so an overview left standing settled on the window picker and every
Show Apps press after that came back there instead of to the desktop. Show
Apps itself is left alone — it leaves the grid as it always has, and the grid
shows the apps again next time because a browser only lives as long as the
grid is up. Switching sections is the tabs moving *in place* — no overview
transition — except when another extension's view is showing in the same
slot (Games Menu's own), where opening ours closes the overview and reopens
it rather than drawing over what is there (`mediaMenu.js` `open()`, the
`_next` field). A rebuild (a setting changing, a rescan landing) tears the
browser down and makes another, and puts back the tab that was showing
(`state`/`restore` on the browser), so the change shows where it is being
looked for rather than on the next press — a `columns` change used to leave
the overview on the app grid.

**One keyboard shortcut**, `library-shortcut` (`as`, empty by default so
nothing of the system's is taken), is grabbed with `Main.wm.addKeybinding`
the way the shell grabs its own — mutter follows the setting, so one set in
the preferences works at once, and it is not listed in GNOME Settings. A
press is the button's press wherever the library opens (`app.js`
`_onShortcut`): `toggle` on a browser, and on the surface the library from
anywhere, with a second press closing it. It is grabbed in `POPUP` mode too,
but only so the modal library's own panel can be closed or switched with it;
over any other popup it does nothing. The preferences set it the way GNOME
Settings does (`prefs.js` `_captureShortcut`): system shortcuts are inhibited
while the dialog listens — the shell asks once whether the Extensions app may
— and a key the window manager, the shell or the media keys already has is
refused, not taken over.

In the **`menu` library** `mediaMenu.js` puts the tabs and their grids into
the overview's app-grid slot. In the **`modal` library** (`libraryWindow.js`)
they go inside the folder's panel (`panel.js`) instead — pressing the button
zooms that panel, holding one `LibraryView`, out of the button, exactly as
the shell zooms an app folder's panel out of its icon; a second press,
Escape, or a click on the shade closes it, and the panel dies the moment the
button it came from unmaps (the overview closing, on stock GNOME). With the
library in either of these and the pane popping up too, nothing of ours is
drawn on the wallpaper at all and no surface is built. Every place draws a
poster with `createArtwork` (`widgets.js`); only what holds it differs.

`detail-opens-in` `menu` pops the pane up the way the shell opens an app
folder (`detailDialog.js`, built on `panel.js` — the same `AppFolderDialog`
host the modal library's panel also subclasses): the tile fades, the panel
zooms out of its artwork over a shade, and a click on the shade or Escape
zooms it back. That class is the
shell's `AppFolderDialog` with three things changed and nothing else — the
panel is sized around a poster rather than a 720px square, it holds a
`DetailView` (with a `bare` frame, since the folder's panel is the surface)
where the folder holds its grid, and there is no name to edit — so the panel
is styled `app-folder-dialog` and follows the shell's theme.

The pane sits **inside** that panel rather than filling it, by `shape.js`
`PANE_INSET`, so the folder's own frame shows around the artwork the way it
shows around a folder's grid; the pane's radius is the panel's less the inset
(`paneInner`), which is what keeps the two curves concentric. The inset comes
out of the pane's own padding rather than being added to it, so what shows
between the panel's edge and the artwork is the same either way —
`detailView.js` `PADDING.bare` and the stylesheet's `.ml-pane-bare
.ml-pane-content` are the two halves of that and must agree, or the pane
overhangs the panel and the clip cuts the backdrop's bottom corners square.

And what goes **behind and around** it is the folder's too, asked rather than
assumed (`panel.js` `folderLook`). Stock GNOME shades to `DIALOG_SHADE_NORMAL`
and paints the panel from its theme, and so does this; but an extension can
take that over — Blur my Shell drops the shade and blurs the background
instead, and makes the panel itself translucent with a class of its own on the
folder's box — and a panel that went on shading at 80% black behind an opaque
box reads as a different kind of thing entirely beside the folders it is
modelled on. So a folder's own dialog is looked at once per open: any
`Shell.BlurEffect` on it is matched here with the shade dropped, and any class
on its box beyond `app-folder-dialog` goes on ours, so the same stylesheet
paints both and nothing of the look is computed here. With Blur my Shell off
the folder carries neither, and with no folders on the desktop there is
nothing to ask, so the shade and the theme's panel stand.

It opens in **two moves**, so the first is the folder's own: the panel zooms
out of the tile as the artwork and its buttons alone — poster-shaped, as the
folder's square panel is icon-shaped, so the zoom is near enough uniform — and
then opens out sideways onto the title, facts and list, which were built on an
idle while it zoomed. Closing mirrors it. The pane is laid out once at the open
width inside a clip that *is* the panel, so widening reveals the second column
instead of reflowing every label under it per frame, and the panel's size is
asked of the side column (`get_preferred_height`) rather than added up from the
numbers the pane used — after `ensureStyleDeep`, see Gotchas.

It hosts itself where the pick was made: in `overviewGroup` when the overview is up, in `uiGroup`
otherwise — a tile in the modal library's own panel included, since that
panel hosts itself the same way — so any library goes with `detail-opens-in`
`menu`. Its `GrabHelper` is what takes Escape and the keyboard; the tile going
unmapped (the overview dismissed, the surface hidden by a workspace change, the
library panel closing) is its cue to go at once, as it is the folder's.

`detail-opens-in` `modal` is the same `DetailDialog` with two flags turned: it
is hosted in `uiGroup` always rather than wherever the pick was made, so a pick
made in the overview hides the overview first — which unmaps the tile, so the
panel fades in centred instead of zooming out of it — and a pick made from the
modal library's panel closes that panel first; and it does not die when
its source tile unmaps, so a workspace change or a closed library panel leaves
it up. Either way, its `GrabHelper` keeps the modal grab the whole time it is
up, so Super and the workspace-switch keys are inert until Escape or a click
away closes it. The grab is `Shell.ActionMode.POPUP`, the tier the app folder
and the shell's popup menus use — not `SYSTEM_MODAL`, which is
`modalDialog.js`'s alone and would buy nothing but the loss of the message
tray and quick-settings shortcuts. Neither place is a window: both are shell
chrome holding a stage grab, and a real `Meta.Window` would mean a second
process, since the shell links no GTK.

The `menu` library folds the overview's row of small workspaces away to give the
posters its room. How far it is folded is read from the overview's own state
adjustment, never timed: a fade of our own is out of step with the shell's
transition, and one started as the overview unmaps stalls until it is next
shown.

Neither the overview nor the slide between workspaces shows the desktop at all
— each builds its own wallpaper actor per workspace — so `overviewPreview.js`
puts a `Clutter.Clone` of the live library or detail page into every picture
the shell makes of one of our workspaces: the overview's previews, the
thumbnails in its strip, and the strip the slide animates, which is why the
library travels with its workspace. Nothing is built for any of them; the
clones die with the shell's own actors. A clone paints a hidden source, but
lays it out at the size it *asks* for, so the pages are sized outright.

Everything that runs in `app.js` and below runs **inside the compositor**, so a
long synchronous block is a dropped frame for the whole desktop. Two rules come
out of that. **Nothing builds an actor per thing you own**: the detail lists
fill through `lazyList.js` as they scroll, and a grid builds the pages within
reach of the one showing, so a section of thousands costs a screenful either
way. **And nothing is built on a frame that
is animating**: the detail pane puts up its artwork alone and builds its second
column on the next idle, so the flight or the zoom that opened it has the first
frames to itself — and the group list, the one piece that runs to a couple of
dozen rows at once, waits for the opening move to finish altogether
(`detailView.js` `_fillList`, a timer rather than an idle, because an idle
lands in the middle of an animation, which is the whole of what it avoids).
And **nothing stats per item**:
`library.js` lists the three artwork cache folders once per load and looks paths
up in that, rather than a blocking `file_test` per poster.

## Design rules

- **A modification of GNOME, not a second one.** Whatever the shell already has
  is what Media Libraries uses: the app grid for a library, `AppViewItem` and
  `overview-tile` for a tile, `icon-button` and `button` for the header and the
  actions, `global.focus_manager` for the keyboard, the dash's own
  `DashItemContainer` for the library's button, `AppFolderDialog` for a pop-up
  pane and the `modal` library's panel. Before writing a widget, look for the
  shell's — the extension should be the media, the surface it is drawn on and
  the few shapes GNOME has no equivalent for (the tab bar, the detail pane, the
  rows), and nothing else.
- **Motion copies the shell.** `anim.js` holds the only durations and curves in
  use: 120 ms for hover and things leaving, 200 ms ease-out-quad for the rest,
  260 ms for the hero flight. Don't invent new ones; `actor.ease()` already
  honours the animations toggle and slow-down factor. A workspace change is
  the shell's slide and nothing else: no reveal of our own is queued behind it.
- **Corners come from one radius.** `corner-radius` (a setting, default 18px) is
  the only radius in the design; `shape.js` scales it into the handful the views
  need — artwork (posters and rows share it), hero, pane, badge — and every rounded
  surface sets it inline as it is built. The stylesheet's `border-radius` values
  are fallbacks that match the default; change `shape.js`, not them. Pills stay
  `9999px` and are not scaled. The one exception to "one radius" is a surface
  *inside* another — `paneInner`, the pop-up pane within the folder's frame —
  which is the outer radius less the inset, so the two curves are concentric
  rather than one being visibly tighter than the other.
- **The style settings are one set, for every view.** `columns` (4–10) and
  `rows` (1–3) are the grid shape wherever a grid is drawn — the wallpaper, the
  overview's slot, the window panel — each capped by what fits at
  `mediaGrid.js`'s `MIN_ART` in the box that view is given, so a narrow space
  simply shows fewer of either; `corner-radius` is above; `detail-size`
  (80–120%) is how much of the work area a pop-up detail panel fills, and
  reaches `panel.js` `_budget()` alone; `grid-align` is whether a part-full row
  is centred under the full ones, as the app grid has it, or hugs the leading
  edge (`mediaGrid.js` `setGridAlign`, read by the layout as it allocates); the
  block itself is always centred, because `gridFor` shrinks the cover to fit
  `rows` and `columns` exactly and a block hugging the edge left all of that
  slack as one gap on the far side. The page dots keep their room on a one-page section — the
  shell hides them for a single page and the grid re-centred seven pixels
  lower — so every section's rows land on the same lines. The hero artwork under it
  has a floor of its own (`detailView.js` `HERO_MIN`, 132 logical px):
  on a small work area the smallest `detail-size` leaves less room than the
  buttons beneath the artwork take, and without the floor the hero came out at
  nothing — so the panel shrinks, the artwork does not vanish. There is no
  per-view copy of any of them, and a change of one rebuilds whatever is built.
- **Type is in em.** 1em is the stage's UI font, so every size in the
  stylesheet follows Settings → Accessibility → Large Text, and the values land
  on the shell's own steps (`%title_1` and friends in `_common.scss`). A px
  font-size in the stylesheet is a bug.
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
  rounded corners; unclipped, as a dark container behind the artwork (and, in
  a grid, a band merging one row's shadows into the next). A surface that
  wants both would need to cast the shadow from a plain rounded card and carry
  the image on a child layer.
- **St CSS is not web CSS.** No flexbox, grid, `calc()`, CSS variables or
  `linear-gradient()` (use `background-gradient-direction/start/end`). Layout is
  done in JS (`St.BoxLayout`, `Clutter.BinLayout`); the stylesheet is for paint
  only.
- **A freshly shown actor has no allocation until the next frame.** Measuring it
  for a clone flight yields NaN; `anim.js` `allocateNow()` lays it out first.
- **And a freshly built one has no style until something asks for it.** St
  computes a theme node lazily, but the numbers a widget takes *out* of its node
  — an `St.BoxLayout`'s `spacing`, a `margin` — are only picked up when
  `style-changed` is emitted on that widget, which happens no earlier than its
  first map. So `get_preferred_height` on a column built a moment ago answers as
  if it had no spacing and no margins: the detail popup's panel came out
  twenty-six pixels short of the pane inside it, and the clip cut the backdrop's
  bottom corners off square against the panel's rounded ones. `ensure_style()`
  fixes it but only for the widget it is called on — it merely marks the
  children dirty — so the whole subtree has to be walked: `anim.js`
  `ensureStyleDeep()`, the counterpart to `allocateNow()`. Nothing may be
  measured before it.
- **The overview is laid out in the work area, not on the monitor.** The `box`
  the shell's `ControlsManagerLayout.vfunc_allocate` divides up is already inset
  by the top bar and by whatever else is reserved — Dash to Panel's panel, 48px
  of it — so anything that works out one of its boxes ahead of the shell
  (`mediaMenu.js` `_slotSize`, for the button pressed before the overview
  has ever been shown) must start from `getWorkAreaForMonitor`, and must measure
  the dash whether or not it is *visible*, as the shell does. Getting either
  wrong left the first tab's grid built against a taller box than every
  later one, which is a different cover size for the same `columns`. The box the
  views standing were built for is kept either way, and they are all dropped and
  built again when it moves.
- **A scroll view's `St.Adjustment` is already disposed when its `destroy`
  fires.** Disconnecting a handler from it there throws "already disposed"
  rather than tidying anything — the adjustment dies with the view, so its
  handlers go with it. `lazyList.js` takes back only its idle source.
- **Hover on a tile is crossing events, not `track_hover`.** The `hover`
  pseudo-class restyles a widget and all its children on every enter and
  leave; across a grid that is the cost of a hover. Only the few widgets that
  paint something from `:hover` (the tabs, the detail list's rows) track it,
  and no rule keys a descendant off a parent's `:hover`.
- **`_backgroundGroup` and `_keepAliveId` are private API** — the full list,
  with what breaks if each one changes, is `docs/private-api.md` — and so is every
  path `overviewPreview.js` walks to reach the overview's previews
  (`controls._workspacesDisplay._workspacesViews`, a workspace's `_background`
  and its `_backgroundGroup`, `controls._thumbnailsBox._thumbnails`) and the
  slide (`Main.wm._workspaceAnimation`, its `_prepareWorkspaceSwitch` and
  `_switchData.monitors[]._workspaceGroups[]._background`). All are
  underscore-prefixed shell internals that can change between releases. The
  `menu` library adds `controls._stateAdjustment`, `_workspacesDisplay`, `_searchController`,
  the layout's `_getAppDisplayBoxForState` (wrapped, and unwrapped on
  disable), `appDisplay._box`, and `BaseAppView`, which the shell does not
  export and is reached as `AppDisplay`'s prototype. `libraryButton.js` adds
  `global.dashToPanel.panels` and its `panels-created` signal (Dash to Panel's
  own, not the shell's, used to re-attach the button when it rebuilds its
  panels) and `Dash.ShowAppsIcon` (exported, but its `_createIcon` and
  `_iconActor` are private shape the subclass fills in). `panel.js`
  `folderLook()` adds `appDisplay._folderIcons`, the `_dialog` each of them
  keeps and its `_viewBox`, read only to see what this desktop puts behind an open folder; it
  finds nothing on a desktop with no folders, and a shade is what it falls back
  to, so this one fails soft. If
  rendering breaks after a GNOME upgrade look at the first; if a held-open
  workspace starts collapsing under the library or the pane, at the second
  (`_holdWorkspaces`/`_keepOnly` in `app.js`); if the overview goes empty
  again, or the slide goes back to bare wallpaper, at the third; if the
  button stops appearing beside Show Apps after a GNOME or Dash to Panel
  upgrade, at the fourth; if the popup starts shading a desktop whose folders
  do not, at the fifth.
- **"Is the app grid up?" is `dash.showAppsButton.checked`, never
  `appDisplay.visible`.** The shell holds the app display visible for the whole
  slide down to the window picker (`_updateAppDisplayVisibility` takes the
  *larger* of the states it is moving between) and does not update it again
  once the transition is dropped, so a media view read from that visibility
  outlived the grid: Escape left the view current and Show Apps still held by
  us, and the next click on it went nowhere. The button's own checked state is
  set as the grid opens and cleared on every way out — Escape, a swipe, a
  search, leaving the overview — so `mediaMenu.js` follows it.
- **`captured-event::key` is wider than a key press.** Key releases and the
  input method's own events carry the same detail, and asking one of those for
  a key symbol is a Clutter assertion in the journal, twice per keystroke. Check
  `event.type() === Clutter.EventType.KEY_PRESS` first, exactly as the shell
  does (`calendar.js:860`); `mediaMenu.js` `_force()` is the only such handler
  here.
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
- **A freeze leaves no log; `make stalls` catches one in the act.** It writes
  three timestamped streams to `dist/stalls.log`: stalls of the shell's main
  loop, processes held in the kernel (`autofs_wait` is a systemd automount
  being mounted, `cifs_*` a share answering slowly) and which process woke an
  automount. Measure the main loop with a `Properties.Get` on
  `org.gnome.Shell`, never `Peer.Ping` — GDBus answers a ping on its worker
  thread, so a ping stays fast through any stall.
- **The shares idle out, and one of them can be offline.** `/media/LENOVO` and
  `/media/HP-AIO` are systemd automounts with a 60 s idle timeout; the first
  touch after that blocks until the mount is back, and an offline share blocks
  every toucher for the whole connect timeout (11 s measured). That is why
  nothing in `lib/` or `prefs.js` touches a media path synchronously (above),
  and why a stale entry in `~/.local/share/recently-used.xbel` pointing at an
  offline share stalls every Recent listing (`gvfsd-recent` stats each entry).
- **API keys are secrets.** They sit in dconf in plain text, in the
  `credentials` setting (the prefs say so). Never log them, never put them on a
  command line, and never paste them into the conversation; reading them back
  out of GSettings is fine, which is how the scanner gets them.
  `~/Documents/keys/<SERVICE>/` is the user's key drop shared with other
  projects, and each key row's Import button reads it from there.
- **The 48 floor is the theme's, not the architecture's.** Every shell class
  and private field this extension reaches is identical from 48.0 to 50.4; what
  actually stops it going lower is CSS — the whole accent palette is
  `-st-accent-color`, which is 47+, and `St.BoxLayout({orientation})`, used
  throughout, is 48+. 47 would cost fourteen `orientation:` sites and an
  `Adw.ToggleGroup` fallback (libadwaita 1.7 = 48) for a release past its
  support window; 45/46 would need a second palette. Neither is worth it.
- **The neutrals are the dark palette's on purpose.** The surface sits on the
  wallpaper, where a dark ground is defensible regardless of the desktop
  theme. A light variant is one style class synced from `Main.getStyleVariant()`
  and roughly 17 rules, not a second stylesheet — worth doing if asked for, not
  worth doing speculatively.
- **JS sizes are physical pixels; CSS strings are not.** A number that meets an
  allocation (`set_size`, a layout calculation, a budget) is logical px from a
  constant or a setting and has to be multiplied by
  `St.ThemeContext.get_for_stage(global.stage).scale_factor` before it is used.
  A number written into a `set_style()` string (`radiusStyle()`, `padding:`)
  must **not** be scaled — St scales CSS itself, so scaling it twice doubles it
  on HiDPI. `St.Icon.icon_size` is the one exception in the allocation
  direction: it is logical, so a size derived from physical px is *divided* by
  the scale factor, not multiplied (`widgets.js` `createArtwork`).
- **The staged `lib/` copy survives a screen unlock, not just a reload.**
  `extension.js` names the staging directory after a checksum of `lib/`'s file
  contents (name, size, mtime), not the time it was built, so re-enabling after
  a lock (GNOME disables every extension at lock and re-enables at unlock)
  finds the same directory and re-imports from GJS's module cache rather than
  copying and building again. Only an actual edit — which changes the checksum
  — makes a new stage; the sweep on the next `enable()` removes whatever stage
  is no longer current.

## Coexisting with Games Menu

Games Menu (`games-menu@jackt`) is built the same way — the same shell classes
subclassed, the same folder-dialog and app-grid shapes borrowed — and the two
run enabled at once on one machine, so nothing about how this extension
reaches into the shell may assume it is the only one doing so. What keeps them
apart: every `GObject.registerClass`'d class here is named `MediaLibraries*`
(`MediaLibrariesLibraryIcon`, `MediaLibrariesMediaView`, …), never the bare
shell name, so the two extensions' subclasses of the same shell class do not
collide as GTypes; every stylesheet class is `ml-`-prefixed and every borrowed
constant of the folder look is namespaced too (`panel.js`'s `BLUR` is
`media-libraries-panel-blur`, not Games Menu's own `games-menu-panel-blur`).
Both wrap the same shell internals — Dash to Panel's
`_updateGroupedElements`, the overview layout's `_getAppDisplayBoxForState` —
chain-safely: call through to whatever was there first, and on the way out
restore that (not delete the property) only if the wrap is still the
outermost one, so whichever of the two wrapped second unwraps cleanly without
taking the other's wrap down with it (`libraryButton.js` `_attachToPanel`,
`mediaMenu.js` `_foldWorkspaces`). A wrap left in the other's chain after a
disable goes inert, and the slot the menu measures for its next view is asked
of the shell's own method rather than of the wrap beneath it, which the other
may have grown for a view of its own. In the `menu` library, a button of ours
pressed while Games Menu's view is showing in the overview's app-grid slot
closes the overview and reopens it onto ours, rather than drawing over
what is there — and Games Menu does the same in reverse — which is the one
place either extension reads what the other put there (`mediaMenu.js`
`open()`, the `_next` field). And the Home action's own default binding
differs between the two (`keys-home`/`pad-home` in each schema), so a remote
or controller's Home button, out of the box, drives only one of them.
