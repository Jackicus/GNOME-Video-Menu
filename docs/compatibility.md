# Compatibility

`metadata.json` claims GNOME Shell 48, 49 and 50. Exactly one of those has
been run. This page says which, lists every code path that depends on the
version, and says what to check first on each claimed version.

## What has been tested

- **GNOME Shell 50.5** on CachyOS (Arch-based), Wayland, with an NVIDIA
  GeForce GTX 1080 on the proprietary driver 580.178.04. The rest of the
  stack on that machine: mutter 50.5, GJS 1.88.1, GLib 2.88.3, GTK 4.22.5,
  libadwaita 1.9.4, libmanette 0.2.13, Python 3.14.7.
- **The same shell headless and nested** (`make nested`, `scripts/nested.sh`,
  which runs `gnome-shell --wayland --headless --virtual-monitor ...` on its
  own session bus), both with and without Dash to Panel enabled, and both
  with and without Blur my Shell enabled — the four combinations `panel.js`'s
  `folderLook()` and `libraryButton.js`'s Dash to Panel branch exist for.
- **All four `library-opens-in` places** (`desktop`, `workspaces`, `menu`,
  `modal`), **the pop-up detail pane**, **the library's keyboard shortcut**,
  and **the preferences' General page** were exercised in the nested shell on
  2026-09-25.

Unlike some sibling extensions, there is no separate development entry point
here: `src/extension.js` is what both `make link` (a symlink, for editing) and
`make install`/`make pack` (a plain copy or a zip) install, and it always
stages `lib/` into `$XDG_RUNTIME_DIR/media-libraries/lib-<checksum>/` before
importing it (see CLAUDE.md's "How it fits together", step 2, and the Gotcha
on the staged copy surviving a lock). So testing through `make nested` already
exercises the same loading path a real install does; there is no separate zip
build to re-test the way Wallpaper Engine's compatibility notes call for.

Nothing else has been tested:

- **GNOME 48 and 49 are claimed and have never been run.** Every entry below
  marked "confirmed at 48.0/49.0" was checked by reading the actual
  `GNOME/gnome-shell` source at those git tags on gitlab.gnome.org (fetched
  live, not from a local checkout) — not by booting either version. Entries
  with no such mark were checked only against the local 50.5 extraction and
  are assumed, not confirmed, to hold at 48 and 49; CLAUDE.md's own compat
  note makes the same distinction ("48 and 49 by audit against the shell's
  sources, not by boot").
- **GNOME 51 or later** is not claimed and has not been read at all here.
- **No Mesa GPU** (AMD, Intel), no virtual machine, no X11 session (removed
  in mutter 50; 48 and 49 still have one).
- **Multi-monitor.** The overview-preview code (`overviewPreview.js`) only
  ever draws on the primary monitor by design (see `private-api.md`), so a
  second monitor was not part of this pass the way it was for Wallpaper
  Engine's.

## Version-sensitive code paths

### `Adw.ShortcutLabel ?? Gtk.ShortcutLabel` (prefs.js)

```js
// Libadwaita's from 1.8 (GNOME 49); GTK's, deprecated since, before that.
const ShortcutLabel = Adw.ShortcutLabel ?? Gtk.ShortcutLabel;
```

Confirmed: `AdwShortcutLabel` carries "since: 1.8" throughout libadwaita's own
1.8 API reference. GNOME 48 ships libadwaita 1.7, GNOME 49 ships 1.8 — so on
48 this line reads `undefined ?? Gtk.ShortcutLabel` and takes the GTK widget
(deprecated in GTK, but present); on 49 and 50 it takes libadwaita's own.
Both widgets are used identically afterwards (`new ShortcutLabel({accelerator})`),
so nothing downstream branches on which one was picked.

*Check first on 48:* open Controls → a key row's "Set Shortcut" button. The
captured accelerator should render as a shortcut chip, from GTK's widget
rather than libadwaita's.

### `Adw.ToggleGroup` and `Adw.Toggle` (prefs.js)

Used for "Library opens in" / "Items open in", the grid-align choice, and
"Keep marks in" — three `Adw.ToggleGroup` instances. `AdwToggleGroup` carries
"since: 1.7" throughout libadwaita's 1.7 reference, which is exactly the
floor GNOME 48 ships. This is the tightest margin in the preferences: nothing
here works on libadwaita 1.6 or earlier, so claiming a GNOME version whose
libadwaita is below 1.7 would need a fallback (a `Gtk.ToggleButton` group, or
`Adw.ComboRow`) that does not exist.

*Check first on 48:* every `Adw.ToggleGroup` row (Library/Items/grid
align/Watched) shows its three or four options as a segmented control, not a
combo box or a crash.

### `Clutter.ClickGesture ?? Clutter.ClickAction` (panel.js)

```js
// Clutter.ClickGesture is 49 and later; on 48 this is the shell's own
// AppFolderDialog click action (`git show 48.0:js/ui/appDisplay.js`, line 2497).
_addClickAway() {
    if (Clutter.ClickGesture) { ... this.add_action(clickGesture); return; }
    const clickAction = new Clutter.ClickAction();
    ...
    this.add_action(clickAction);
}
```

Confirmed both ways: the shell's own `AppFolderDialog` (`appDisplay.js`) uses
`Clutter.ClickAction` for its click-away at the `48.0` tag, and
`Clutter.ClickGesture` at 50.5 — so this branch follows the same class the
shell's own folder panel follows on each version, which is exactly the
intent (`MediaPanel` is a hand-built copy of `AppFolderDialog`'s shape; see
`private-api.md`). Not checked directly against `49.0`, but `Clutter.ClickGesture`
existing is what gates the branch, so the two are automatically in step on
whichever version actually introduced it.

*Check first on 48:* click on the shade around a pop-up detail panel, or the
modal library's panel. It should close. A `TypeError` in the log instead
means the branch picked the wrong action for that version.

### The six-argument `_getAppDisplayBoxForState` (mediaMenu.js)

```js
// Six arguments since GNOME 47; five before.
const folded = function (state, box, searchHeight, dashHeight, workspacesBox, spacing) { ... };
```

Confirmed six arguments, in this order, at `48.0` and at 50.5. Since the
claimed floor is 48, this method's arity is not actually a live branch
anywhere in the code — the comment records the history for whoever reads it,
but every claimed version takes six. Nothing would need to change here even
if 47 were added, since the signature only *grew* a sixth argument at 47 and
has not changed shape since.

### `WORKSPACE_SLIDE_TIME`, restated (app.js)

```js
// workspaceAnimation.js WINDOW_ANIMATION_TIME — exported only from 50, so restated.
const WORKSPACE_SLIDE_TIME = 250;
```

Confirmed at all three claimed versions: `WINDOW_ANIMATION_TIME` is declared
`const` (module-private) at `48.0` and `49.0`, both times with value `250`,
and `export const` at 50.5, also `250`. So the restated value is correct on
every claimed version regardless of whether the shell's own export exists —
this is purely a "cannot import it on 48/49" workaround, not a value that
needs to track anything. If a future GNOME changes the shell's own duration,
this restated copy would silently drift out of step with the actual slide
(the timer that releases a claimed workspace after the slide, `_releaseWorkspaces`,
would then fire slightly before or after the real animation finishes) —
cosmetic, not a hang, since `_holdWorkspaces` still runs, just on a timer
close to but not exactly matching the shell's own.

### `group._background`'s shape across versions (overviewPreview.js)

Not called out in this extension's own comments, but confirmed by reading
the source directly: in `workspaceAnimation.js` at the `48.0` tag,
`WorkspaceGroup._background` is a plain `Meta.BackgroundGroup`, built inline
(`this._background = new Meta.BackgroundGroup(); this.add_child(this._background);`)
with no wrapper class. At 50.5 it is a `WorkspaceBackground` instance whose
own `_createBackground()` builds a `Meta.BackgroundGroup` as *its* first
child. `overviewPreview.js`'s `_joinSlide()` reaches it the same way either
way — `group._background.get_first_child()` — which is the wallpaper actor
directly on 48/49's shape and the inner `Meta.BackgroundGroup` on 50/51's, and
in both cases `insert_child_above(clone, wallpaper)` lands the clone above the
background and below any desktop-window clones added after. Wallpaper
Engine's own `compatibility.md` documents the same two shapes (and has
independently checked `49.0`, which was not re-checked here) — see that
document for the fuller version table.

*Check first on 48 and 49:* switch workspaces with Super+Page Down and with a
touchpad swipe, on both a `workspaces`-mode library and a `workspaces`-mode
detail pane claimed on a different workspace. Each should travel with its
workspace during the slide rather than the surface blinking back to bare
wallpaper and reappearing once the slide lands.

### The overview and its previews (overviewPreview.js)

The paths into the workspace previews and the thumbnail strip
(`Main.overview._overview.controls._workspacesDisplay._workspacesViews`,
`workspace._background`/`_backgroundGroup`/`_monitorIndex`,
`controls._thumbnailsBox._thumbnails`/`_contents`) are the same private shape
Wallpaper Engine's `compatibility.md` reports unchanged from `45.0` to `51.0`.
Only 50.5 was checked directly here, with one monitor; see `private-api.md`
for why the `SecondaryMonitorDisplay`/`ExtraWorkspaceView` wrapper Wallpaper
Engine has to unwrap does not need handling in this extension (it only draws
on the primary monitor).

*Check first:* open the overview with a section's library set to `menu`, or
with any surface place's library up on the active workspace. The posters
should be in the workspace preview and, if the surface place claims a
workspace of its own, in the thumbnail strip too.

### `St.BoxLayout({orientation})` and `-st-accent-color`

Both are floor requirements rather than branches — there is no fallback for
either, and both are why the floor is 48 and not lower (CLAUDE.md's own
Gotcha, "The 48 floor is the theme's, not the architecture's"). Confirmed by
grep: `St.BoxLayout({orientation: ...})` is constructed at ten call sites
across `app.js`, `panel.js`, `widgets.js` (×3), `libraryButton.js`,
`libraryView.js`, `detailView.js` (×3); `-st-accent-color`/`-st-accent-fg-color`
appear sixteen times in `stylesheet.css`. Both are GNOME 48+ / libadwaita-era
shell CSS features (`orientation` as a constructor property on `St.BoxLayout`
is 48+; the accent palette is 47+), so nothing here needs guarding for the
claimed range, but either would need a second code path (named orientation
constants + manual layout, and a hardcoded accent) to go below 48.

### `Main.wm.keepWorkspaceAlive` vs. `workspace._keepAliveId` directly

Covered in full in `private-api.md`. The public method (`Main.wm.keepWorkspaceAlive(workspace, duration)`)
is confirmed present, with the same forwarding shape, at `48.0` and 50.5, so
it is not a version gap — the extension sets the private field directly
because the public method is duration-bound and this extension's hold is not,
not because the public method is missing on any claimed version.

### libmanette (controls.js, an optional native dependency, not a GNOME version)

```js
try {
    ({default: Manette} = await import('gi://Manette'));
} catch {
    console.log('[Media Libraries] libmanette is not installed; game controllers are not read.');
    return;
}
```

Not GNOME-version-sensitive — libmanette is a separate GObject-introspected
library (present on the test machine as `libmanette 0.2.13`, installed
alongside WebKitGTK on most desktops but not guaranteed) rather than part of
the shell. The dynamic `import()` and its catch are what let the extension —
and the preferences' own equivalent loader, `prefs.js`'s `loadManette()` —
run identically whether or not it is installed; nothing about game controller
support is claimed to require any particular GNOME version, only that
libmanette's GObject Introspection typelib be on the system.

*Check first, on any version:* toggle "Use game controllers" in Controls with
libmanette absent (e.g. `MANETTE_TYPELIB_PATH` pointed somewhere empty) and
confirm the row explains itself ("libmanette is not installed...") rather
than throwing.

### The preferences (prefs.js)

libadwaita's floor across the whole file is **1.7**, set by `Adw.ToggleGroup`/
`Adw.Toggle` above — every other widget used needs less:

| Widget or call | Needs | At GNOME 48's floor (libadwaita 1.7) |
|---|---|---|
| `Adw.PreferencesPage`, `Adw.PreferencesGroup`, `Adw.ActionRow`, `Adw.HeaderBar`, `Adw.ButtonContent` | libadwaita 1.0 | yes |
| `Adw.ExpanderRow`, `.add_row()` | libadwaita 1.0 | yes |
| `Adw.EntryRow`, `Adw.PasswordEntryRow` | libadwaita 1.2 | yes |
| `Adw.SwitchRow`, `Adw.ExpanderRow.add_suffix()` | libadwaita 1.4 | yes |
| `Adw.Dialog`, `Adw.ToolbarView`, `Adw.StatusPage` | libadwaita 1.5 | yes |
| `Adw.ToggleGroup`, `Adw.Toggle` | libadwaita 1.7 | yes, exactly the floor |
| `Adw.ShortcutLabel` (with the `Gtk.ShortcutLabel` fallback above) | libadwaita 1.8 | no — falls back to GTK's |
| `Gtk.FileDialog` (`select_folder()`/`select_folder_finish()`) | GTK 4.10 | yes (GNOME 48 ships GTK 4.14+) |

`fillPreferencesWindow(window)` is synchronous, which is fine on every
claimed version — the shell has awaited it since 47 regardless of whether the
implementation itself is a function or an `async function`
(`extensionPrefs.js`/`extensionSystem.js`), and a synchronous one satisfies an
`await` trivially.

*Check first on 48:* open every page (General, Controls, and each enabled
section's own), confirm no page throws building itself, use the folder
Browse… button, capture a keyboard shortcut and a controller input, and Import
a key from `~/Documents/keys/<SERVICE>/`.

### `enable()`/`disable()` synchronity (extension.js)

```js
async enable() { ... }
disable() { ... }
```

`enable()` is `async` because it awaits the dynamic `import()` of the staged
`lib/app.js`; `disable()` is synchronous. The shell has awaited `enable()`
since GNOME 45 (`extensionSystem.js`, `await extension.stateObj.enable()`),
so this is not a version gap on any claimed version; it would only matter if
GNOME 51's stricter rule (an async `disable()` throws) were relevant, which it
is not here, since `disable()` never was async.

## Checklist for a new GNOME version

1. Read gjs.guide's "Port Extensions to GNOME Shell N" page and search it for
   `AppFolderDialog`, `ClickGesture`, `ShowAppsIcon`, `IconGrid`, `BaseAppView`,
   `workspaceAnimation`, `overviewControls`, `_getAppDisplayBoxForState`,
   `keepWorkspaceAlive`, `St.Settings` and `Adw`/libadwaita version bumps.
2. Diff the shell between the last confirmed tag and the new one, over the
   files `private-api.md` reaches into:
   `js/ui/{appDisplay,dash,iconGrid,layout,overviewControls,workspace,
   workspaceAnimation,workspaceThumbnail,workspacesView,windowManager}.js`.
   Search for every expression in that document's "At a glance" table.
3. Check what libadwaita version the new GNOME ships and confirm it is still
   ≥ 1.7 (the `Adw.ToggleGroup` floor); if it is exactly 1.8 or later, the
   `Adw.ShortcutLabel ?? Gtk.ShortcutLabel` fallback can drop its GTK half if
   the floor version is also being raised, but only then.
4. Install the zip rather than the development link: `make uninstall`, then
   `make pack`, then install the built `dist/media-libraries@jackt.shell-extension.zip`
   with `gnome-extensions install`, then log out and in (a new UUID needs
   this the first time regardless; every other GNOME-version test can reuse
   `make link` afterwards, since both paths run the same `extension.js`).
5. `make logs '10 min ago'` should show no `TypeError`, no "No button beside
   Show Apps", no "not laid out as expected", and no libmutter CRITICAL from
   `Meta.Workspace.index()`.
6. Go through all four `library-opens-in` places and all four
   `detail-opens-in` places (sixteen combinations is more than is practical
   to do exhaustively; at minimum, every place alone with the other held at
   `desktop`, plus `desktop`+`desktop`, `workspaces`+`workspaces`,
   `menu`+`menu`, `modal`+`modal`).
7. Switch workspaces with the keyboard and with a touchpad swipe while a
   `workspaces`-mode library or pane is claimed, and confirm it travels with
   its workspace both in the live slide and in the overview's thumbnail
   strip.
8. Lock and unlock the screen with the library open, and confirm the staged
   `lib/` directory is reused (`make logs` should show no new "Enabled from"
   line with a different checksum) rather than rebuilt.
9. With Dash to Panel installed and enabled, and again with it disabled,
   confirm the button appears beside Show Apps in both places, and toggle
   Blur my Shell to confirm the pop-up panel's shade and translucency follow
   a folder's own look in both states.
10. Disable and enable the extension ten times in a row and watch `make logs`
    and the shell's CPU while idle, watching in particular for the staged
    `lib-<checksum>` directories under `$XDG_RUNTIME_DIR/media-libraries/`
    not accumulating (the sweep in `extension.js` `_sweepStages` should leave
    only the current one).
11. If Games Menu is also installed and enabled, repeat steps 6–9 with both
    extensions enabled together, and confirm disabling either one leaves the
    other's button, folded workspace row and app-grid slot view intact.
12. Only then add the version to `shell-version` in `metadata.json`.
