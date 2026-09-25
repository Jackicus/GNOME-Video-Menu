# Publishing to extensions.gnome.org

How to build the upload, what goes in it, and how the extension stands against
the EGO review guidelines. Web sources are named where they are used; the
guidelines are gjs.guide's
[Review Guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html)
and [Best Practices](https://gjs.guide/extensions/review-guidelines/best-practices.html),
fetched 2026-09-25.

Private API use is a separate concern with its own page,
[private-api.md](private-api.md) — this page links to it rather than
repeating what it covers.

## Building the zip

```sh
make pack
```

This runs `scripts/dev.sh pack` (`cmd_pack`), which:

1. compiles the GSettings schemas (`glib-compile-schemas "$SRC_DIR/schemas"`).
   This writes `src/schemas/gschemas.compiled` onto the checked-out tree — a
   side effect on `src/`, not just `dist/` — but it is a `.gitignore`d local
   artefact (`make clean` removes it) and every later step packs a *copy*, so
   it never reaches the zip (below);
2. copies `src/` into a temporary directory and strips it with
   `strip_unshipped`: `__pycache__/`, `*.pyc` (`strip_pycache`) and every
   `CLAUDE.md` under it, including `src/backend/CLAUDE.md`. This is the only
   filtering step — unlike its sibling extensions, `cmd_pack` has no check
   that the result matches an expected file list, so a stray file sitting
   under `src/lib`, `src/backend` or `src/icons` at pack time (an editor
   backup, a half-finished module) ships silently. Read the `unzip -l` output
   before every upload rather than trusting the build to catch it;
3. runs `gnome-extensions pack --force --extra-source=lib
   --extra-source=backend --extra-source=icons -o dist .` from inside that
   staged copy. `gnome-extensions` adds `extension.js`, `metadata.json`,
   `prefs.js`, `stylesheet.css` and every `schemas/*.gschema.xml` itself
   (`command-pack.c`); `lib/`, `backend/` and `icons/` all need naming because
   none of them is one of its recognised top-level files. A `LICENSE` or
   `COPYING` would be picked up the same way *if it sat at the top of `src/`*
   — not the top of the git repository — because `src/` is the only thing the
   staged copy, and so the packer, ever sees;
4. deletes the temporary staging directory and reports
   `dist/media-libraries@jackt.shell-extension.zip`.

I ran `make pack` once; it only wrote into `dist/` and compiled the schema, as
expected — harmless. Its listing (`unzip -l`):

```
metadata.json
extension.js
prefs.js
stylesheet.css
schemas/org.gnome.shell.extensions.media-libraries.gschema.xml
backend/scan_library.py  backend/media_scanner.py  backend/metadata.py
icons/library-symbolic.svg
lib/anim.js  lib/app.js  lib/actions.js  lib/controls.js  lib/detailDialog.js
lib/detailView.js  lib/lazyList.js  lib/library.js  lib/libraryButton.js
lib/libraryView.js  lib/libraryWindow.js  lib/mediaGrid.js  lib/mediaMenu.js
lib/overviewPreview.js  lib/panel.js  lib/playback.js  lib/shape.js
lib/tracking.js  lib/widgets.js
```

What each part is:

- **`extension.js`, `metadata.json`, `prefs.js`, `stylesheet.css`,
  `schemas/*.gschema.xml`** — the entry points and the two files
  `gnome-extensions` always looks for.
- **`lib/`** — the shell-side implementation: the surface, the grid, the
  detail pane, tracking, playback-following, controls, the wrap/unwrap points
  into Dash to Panel and the overview. All of it runs inside the compositor
  process.
- **`backend/`** — a Python 3 program (`scan_library.py`, `media_scanner.py`,
  `metadata.py`) that walks the configured folders, fetches artwork and
  metadata online, and writes `~/.cache/media-libraries/library.json`. It is
  not GJS and is not spawned by `extension.js`: the preferences' Rescan
  buttons and `dev.sh scan` both invoke it out-of-process with `python3`. See
  [Scripts, subprocesses and network access](#scripts-subprocesses-and-network-access)
  below — this is the part of the review most worth thinking about before
  uploading.
- **`icons/library-symbolic.svg`** — the one icon, used for the button beside
  Show Apps.

What is left out, and why it is safe to leave out:

- **`src/schemas/gschemas.compiled`** — not in the zip, and does not need
  stripping by hand. `gnome-extensions` 50.5 (the version on this machine)
  does not write a compiled schema into a pack at all; from GNOME 46 onward it
  is compiled on install instead (`extensionDownloader.js` runs
  `glib-compile-schemas --strict` after unzipping an EGO download, both at
  `45.0` and in `50.5`). `cmd_pack` has no explicit delete step for it the way
  a version-straddling packer would, which is fine at the claimed floor of
  shell 48, but worth knowing if the packer itself is ever run with a
  `gnome-extensions` older than 46 (a stale system install, a container) —
  in that case it *would* compile one into the zip and `cmd_pack` would ship
  it unfiltered. Run `glib-compile-schemas --strict --dry-run src/schemas`
  before uploading regardless, since `--strict` is what an install enforces.
- **`__pycache__/`, `*.pyc`** — stripped by `strip_pycache`; confirmed absent
  from the listing above even though `src/backend/__pycache__` exists in the
  working tree from running the scanner locally.
- **`CLAUDE.md`** (root and `src/backend/`) — stripped by `strip_unshipped`;
  confirmed absent.
- **`scripts/`, `README.md`, `docs/`, `.claude/`, `.git`, `dist/`** — never
  part of `src/`, so never seen by the packer at all; `--extra-source` only
  reaches directories under the packed tree.

### Testing the zip before uploading

```sh
make uninstall
make pack
gnome-extensions install dist/media-libraries@jackt.shell-extension.zip
# log out and back in, then enable it
```

Do this rather than `gnome-extensions install --force` over the development
symlink: `--force` deletes the existing extension directory recursively
*through* the symlink, which would empty `src/` itself. `make link` restores
the development link afterwards. This is also the only way to exercise
exactly what a reviewer receives — the development link's `src/extension.js`
is what ships (there is no separate dev-only entry point here; see
[Avoid interfering with the extension system](#avoid-interfering-with-the-extension-system-a-real-risk)
below), but only an installed zip proves the packed `backend/` and `icons/`
paths resolve the way `extension.js`'s `this.dir`-relative code expects.

## metadata.json

| Key | Now | Verdict |
|---|---|---|
| `uuid` | `media-libraries@jackt` | Valid characters, not under `gnome.org`. Cannot change after the first upload — see [the name](#the-extension-name-versus-the-repo-name) |
| `name` | `Video Menu` | See [the name](#the-extension-name-versus-the-repo-name) |
| `description` | one line | Should say considerably more — below |
| `settings-schema` | set | Correct; `getSettings()` is called with no arguments in both `lib/app.js` and `prefs.js`, as Best Practices asks |
| `shell-version` | `["48", "49", "50"]` | All released, so allowed by "MUST NOT claim future versions." Worth knowing: per the root `CLAUDE.md`, 48 and 49 are audited against the shell's sources, not actually booted — only 50 has been run. A reviewer's VM may be on 48 or 49 |
| `version` | `1` | **Should be removed.** The Anatomy page: "This field SHOULD NOT be set by extension developers"; EGO assigns and increments it on every upload |
| `version-name` | absent | Worth adding — see below |
| `url` | absent | **Should be added**, pointing at `https://github.com/Jackicus/GNOME-Video-Menu` (the repo's current origin) |
| `session-modes` | absent | Correct — the extension only needs `user` mode and the guideline says the key "MUST be dropped" in that case |
| `donations`, `gettext-domain` | absent | Correct; neither is required |

**`version-name`** is what a user sees in the Extensions app; without it EGO
shows its own counter. It "MUST be a string that only contains letters,
numbers, space and period with a length between 1 and 16 characters" — so
`"1.0"` is fine, `"v1.0-beta"` is not (the dash). Add one and bump it with
each upload.

**`description`** is the one place a reviewer or a user learns, ahead of
time, about behaviour that could otherwise look like a bug or a red flag. The
current line — "Your TV shows and films as a library on the desktop, in the
overview, or in a floating panel." — says where it draws but nothing about
what it does off-screen. Worth adding:

- it looks titles up online (TVmaze, TMDB, Wikipedia) through a bundled
  Python helper, run from the preferences' Rescan buttons, not automatically
  and not in the background;
- an API key for TMDB is optional, entered in the preferences and kept in
  GSettings, never on a command line;
- it hands a picked file to the video player already configured for that
  section (VLC by default) rather than playing anything itself;
- in `workspaces` mode it claims an empty workspace for the library and,
  independently, one for the detail pane;
- it reaches several private GNOME Shell internals to sit the library beside
  Show Apps, fold the overview's workspace row, and clone pages into the
  overview's previews and the workspace slide — enumerated in
  [private-api.md](private-api.md).

## The review guidelines, point by point

### Only use initialization for static resources: meets

`src/extension.js`'s class body has no constructor; module scope across every
file under `lib/` is `import`, `const`, `class` and `GObject.registerClass()`
definitions — spot-checked in `lib/library.js`, `lib/controls.js` and
`lib/panel.js`, where the only top-level `new` calls are plain values
(`new Set([...])` in `controls.js`, two `new Cogl.Color(...)` constants in
`panel.js`), which is what the guideline allows ("static data structures and
instances of built-in JavaScript objects"). Nothing is instantiated,
connected or scheduled before `enable()` runs.

### Destroy all objects / disconnect all signals / remove main loop sources: meets, spot-checked

`MediaLibrariesApp.disable()` (`lib/app.js`) removes the keybinding
(`Main.wm.removeKeybinding('library-shortcut')`), disconnects every
`connectObject` owner it holds (`global.workspace_manager`, `global.display`,
`Main.layoutManager`, `Main.overview`, `global.stage`, the theme context, its
own settings), removes its rebuild timer with `GLib.source_remove`, and calls
`_teardown()`, which removes the focus group
(`global.focus_manager.remove_group`) and disables the browser, tracker,
playback watcher and controls in turn.

Each of those sub-modules was checked directly rather than taken on trust:

- **`lib/playback.js`**'s `PlaybackWatcher.disable()` unsubscribes all three
  D-Bus signal subscriptions it made in `enable()`
  (`bus.signal_unsubscribe`), cancels its `Gio.Cancellable`, and removes the
  30-second poll source.
- **`lib/controls.js`**'s `Controls.disable()` disconnects its settings and
  calls `_stopPads()`, which disconnects every pad, clears the axis map, and
  — checked specifically, since a repeat timer is easy to leak — removes
  every held key's `GLib.timeout_add` source before clearing the map.
- **`lib/tracking.js`**'s `Tracker.disable()` disconnects its settings and
  cancels its cancellable.
- **`lib/libraryButton.js`** and **`lib/mediaMenu.js`** wrap shell methods
  they do not own (`panel._updateGroupedElements`, the overview layout's
  `_getAppDisplayBoxForState`) and unwrap them chain-safely: each restores the
  stock method only if its own wrap is still the outermost one, so it cannot
  take a wrap installed after it (Games Menu's own, per the coexistence note
  in the root `CLAUDE.md`) down with it.

No gaps turned up in this pass. If one exists, it is likely in a codepath this
spot-check did not reach (`lib/mediaGrid.js`, `lib/detailView.js`,
`lib/widgets.js`, `lib/overviewPreview.js`'s clone bookkeeping) rather than
the modules above.

### Do not use deprecated modules: meets

No `ByteArray`, `imports.mainloop`, `imports.lang` or `Mainloop` anywhere
under `lib/`, `extension.js` or `prefs.js`.

### No GTK in the shell, no shell libraries in the preferences: meets

Nothing under `lib/` or `extension.js` imports `Gtk`, `Gdk` or `Adw`.
`prefs.js` imports `Adw`, `Gtk`, `Gdk`, `Gio`, `GLib` and `Pango`, plus two
shared modules — `lib/library.js` (imports only `Gio`, `GLib`) and
`lib/actions.js` (no imports at all) — neither of which pulls in `Clutter`,
`Meta`, `St` or `Shell`.

### Avoid interfering with the extension system: a real risk

`src/extension.js` — the file that ships — stages `lib/` into
`$XDG_RUNTIME_DIR/media-libraries/lib-<stamp>/` on every `enable()` and
imports `app.js` from there, where `<stamp>` is a checksum of `lib/`'s file
contents. This exists so `make reload` can pick up an edit without a shell
restart (GJS caches ES modules by URL for the process's life), and it is
documented at length in the root `CLAUDE.md`. But unlike this extension's own
sibling (Wallpaper Engine), where the equivalent mechanism lives in a
`scripts/dev-extension.js` that is deliberately kept out of the packed zip —
so the shipped `extension.js` is a plain, synchronous `enable()`/`disable()`
that statically imports `./lib/app.js` — **here the staging logic ships**. A
reviewer reading `extension.js` sees code that enumerates a directory,
computes a checksum, copies JavaScript files to a directory outside the
extension's own tree, and dynamically imports them from there, every time the
extension is enabled — which is close to the example the guideline
("Extensions which modify, reload or interact with other extensions or the
extension system are generally discouraged") is aimed at, even though nothing
here touches *another* extension. It is reviewed case-by-case, and the
in-repo justification (edit-without-restart on Wayland, where there is no
`Alt+F2 r`) is real and explicable — the guideline's actual bar ("developers
should be able to justify and explain the code they submit") is met — but
expect a question about it, and decide before uploading whether to answer it
in the description, move it out of the shipped entry point the way the
sibling extension did, or accept the risk. The `_sweepStages` cleanup (every
enable removes every stage but the one just built or reused) is itself
consistent and disposes correctly of stale directories, which is worth
pointing to if asked.

### Code must not be obfuscated: meets

Plain ES modules, unminified, throughout.

### No excessive logging: a real risk

Two `console.log` calls sit on paths a reviewer will exercise doing nothing
wrong:

- `extension.js`'s `enable()` logs `[Media Libraries] Enabled from ${runDir}`
  on every successful enable — not a failure path, the happy path.
- `lib/app.js`'s rebuild handler logs `[Media Libraries] Rebuilt` every time
  the surface is rebuilt, which happens on a settings change and whenever a
  rescan lands, i.e. routinely during ordinary use, not just on an error.

Everything else that logs is on an actual failure path (a `console.warn` or
`console.error` next to a caught exception — reading a corrupt
`library.json`, a folder file that failed to write, a scan that failed, a
player that could not be listed or resumed), which is what the guideline
("MUST NOT print excessively... use logs only for important messages and
errors") allows. `lib/controls.js` also logs once, informationally, the first
time a controller is used and libmanette turns out not to be installed — a
one-shot, gated behind a feature the user opted into, and the closest of the
three to defensible, but still not an error. The fix for all three is the
same: drop them, or gate them behind a debug switch that defaults off.

### Scripts, subprocesses and network access: the review's centre of gravity

The review guidelines' "Scripts and Binaries" rule is that a script "MUST be
written in GJS, unless absolutely necessary," and Best Practices separately
says "Avoid spawning external shell commands where possible... use D-Bus for
system service communication; offload heavy tasks to separate apps
communicating via D-Bus." This extension's `backend/` is a substantial,
non-GJS program: three Python files (`scan_library.py`, `media_scanner.py`,
`metadata.py`, roughly 1,800 lines together) that walk the filesystem, make
outbound HTTPS requests to `api.tvmaze.com`, `api.themoviedb.org` and
`en.wikipedia.org` with `urllib.request`, and write image and JSON files into
`~/.cache/media-libraries/`. It is launched two ways, both already careful
about the one thing that matters most (never putting a credential on a
command line):

- **From the preferences.** `prefs.js`'s `_scanButton` runs
  `Gio.Subprocess.new(['python3', '<path>/backend/scan_library.py',
  '--from-settings', '--only', <section>, ...], ...)`, with stdout silenced
  and stderr captured only to log a failure. Only ever on a Rescan button
  press — nothing runs on enable, on a timer, or in the background.
- **From the scanner itself.** `scan_library.py --from-settings` reads every
  setting it needs — folders, source order, the online switch, `credentials`
  — by spawning `gsettings get <schema> <key>` per key
  (`_setting`/`_setting_value` in `scan_library.py`) rather than linking
  PyGObject's `Gio.Settings` for it (PyGObject *is* used, but only for
  `GdkPixbuf` in `metadata.py`, to scale artwork on the way into the cache).
  A value read this way is held in memory only long enough to build the
  request that needs it, exactly as CLAUDE.md's API-key rule requires, and
  is never echoed.

None of this is secretive — the root `CLAUDE.md` documents the whole design,
down to which source needs a key and why the scanner reads settings itself
rather than being handed them — and a reviewer who reads `scan_library.py`
will find a normal, well-commented Python program, not obfuscation or
disguised behaviour. But "is this justified" is a judgement call the
guidelines leave to the reviewer, and a bundled Python backend making
outbound network calls on the user's behalf, with an optional third-party API
key stored in GSettings, is exactly the shape of thing the "unless absolutely
necessary" clause exists to gate. Two things are worth doing before
uploading: say so plainly in `description` (above), and be ready to explain
in the upload notes *why* this can't reasonably be GJS — GJS has no
equivalent of Python's standard library for this (threaded fetch pool,
`urllib`, image scaling via `GdkPixbuf` is available to GJS too, but the
scanning and enrichment logic itself would have to be rewritten wholesale)
and the alternative, a same-language rewrite under `lib/`, would run the
network waits and the folder walk on the compositor's own thread, which
`CLAUDE.md`'s own performance rules ("nothing stats per item", "a long
synchronous block is a dropped frame for the whole desktop") rule out as
firmly as the review guideline does.

Two smaller points under the same heading:

- **`Util.spawn`** (`lib/app.js`) launches the section's configured player
  command (`vlc --fullscreen --play-and-exit --qt-continue=0` by default) to
  open a picked file. The command comes from the user's own GSettings value,
  is parsed with `GLib.shell_parse_argv` inside a `try`/`catch` that reports a
  parse failure rather than swallowing it, and is only spawned once
  `GLib.find_program_in_path` confirms the program exists — otherwise it
  falls back to `Gio.AppInfo.launch_default_for_uri_async`. This is ordinary,
  disclosed behaviour (the README says outright "it hands the file to
  whatever app already opens that kind of file"), not a privileged subprocess
  and not something a reviewer is likely to object to, but it is still an
  external spawn worth naming in the description alongside the backend.
- **No telemetry, no clipboard access, no privileged subprocess** anywhere in
  `lib/`, `prefs.js` or `backend/` — nothing calls `pkexec`, nothing touches
  `St.Clipboard` or `Gtk.Clipboard`, and nothing phones anywhere but the three
  metadata sources above, each opt-in per section (`<prefix>-online`) and
  each only touched from a Rescan press.

### Extensions must be functional: worth a note, not a risk

The extension does nothing until its button is pressed or a section is
enabled and pointed at a folder — there is no default folder for either TV
Shows or Films, on purpose (a shared Videos folder can't serve both), so a
reviewer who installs it and does nothing else will see an empty library
until they configure one. Worth a line in the description so that reads as
intended rather than broken.

### Extensions must not be AI-generated: know the code

The rule is that the developer must be able to "justify and explain the code
they submit." Spot-checking the patterns Best Practices calls out:

- **Optional chaining on guaranteed APIs.** What remains (`this._browser?.disable()`,
  `this._dashToPanel?.disconnectObject?.(this)`, `this._monitor?.disconnectObject(this)`)
  is consistently on paths that are genuinely optional — a browser that may
  not have been built yet, Dash to Panel not being installed, a controller
  monitor that may never have started — not defensive noise around a
  guaranteed shell API. `private-api.md` explains the private-API instances
  of this pattern in more depth.
- **try/catch that only swallows.** The catches read in `lib/app.js`,
  `lib/playback.js`, `lib/tracking.js` and `prefs.js` each report a real
  failure (`console.warn`/`console.error`, or a UI state change such as the
  Rescan button's "Failed — see logs") rather than discarding the exception.
- **A lifecycle flag.** `extension.js` keeps `this._enabling` specifically to
  answer "did `disable()` arrive while an `import()` was still pending", which
  is a real, awaited race (the module load is asynchronous) rather than the
  reflexive `this._destroyed` pattern the guideline warns about.

The comments throughout — this file's own sourcing from `CLAUDE.md` is a
good example — consistently explain *why*, which is what the guideline wants,
though their length and density (the root `CLAUDE.md` alone runs to several
thousand words) is unusual enough that a reviewer skimming for AI tells may
notice it either way.

### metadata.json must be well-formed: needs two edits

See [metadata.json](#metadatajson) above — drop `version`, add `url` and
`version-name`.

### Session modes: meets

No `session-modes` key, so `user` only, satisfying "MUST be dropped if you
are only using `user` mode." A screen lock disables the extension and
unlocking re-enables it, which `extension.js`'s staging is explicitly built
to make cheap (an unlock re-enables into the same stage and the same
GJS-cached module graph rather than rebuilding).

### GSettings schemas: meets, one cosmetic oddity

The ID `org.gnome.shell.extensions.media-libraries` and path
`/org/gnome/shell/extensions/media-libraries/` use the required bases, the
file is named `<schema-id>.gschema.xml`, and the XML ships while the compiled
form does not (above). The schema's `<schemalist>` declares
`gettext-domain="gnome-shell-extensions"` — the *shell's own* domain, not
this extension's — which is almost certainly left over from a template and
is harmless (nothing in the schema is marked for translation with an `l10n`
attribute, so the domain is never actually consulted), but it is inconsistent
with a schema that belongs to a separate extension and worth changing to
something extension-specific, or removing, while touching this file for
`version`/`url` anyway.

### Licensing: needs a file

GNOME Shell is GPL-2.0-or-later, and "derived works like extensions MUST be
distributed under compatible terms." There is no `LICENSE` or `COPYING`
anywhere in the repository. Add one — for example GPL-2.0-or-later — and
place it **at the top of `src/`**, not the top of the git repository: because
`cmd_pack` stages and packs `src/` itself (`gnome-extensions pack ... .` run
from inside the staged copy), that is the only location the packer will ever
see, and it is also what `make install`/`make link` puts on disk as the
installed extension directory, per the "`src/` is an exact mirror" rule in
`CLAUDE.md`.

### Copyrights and trademarks: no issue found

"Video Menu" is not, as far as this review found, a name in current
commercial or trademarked use in this space (unlike this extension's sibling,
Wallpaper Engine, which shares a name with a well-known Steam application).
No copyrighted third-party content — icons, artwork, code — appears to be
bundled; the one shipped icon (`icons/library-symbolic.svg`) is original.

### The extension name versus the repo name

The repository is `GNOME-Video-Menu` (its GitHub remote is
`github.com/Jackicus/GNOME-Video-Menu`), to sit alongside its sibling
`GNOME-Games-Menu`, and the shipped `name` and the README's title have
followed it: both are "Video Menu". The UUID (`media-libraries@jackt`) has
not, nor has the schema ID (`org.gnome.shell.extensions.media-libraries`)
behind it. That is not itself a guideline violation — EGO reviews the shipped
`name` and `uuid` for what they are, not for agreeing with each other — but it
is worth resolving deliberately and *before* the first upload rather than
after: the UUID becomes the EGO listing's permanent identity once published,
and `dev.sh`'s own `LEGACY_UUIDS` array (`gnomeflix@jackt`,
`media-workspace-desktop@jackt`) shows this extension has already been renamed
more than once pre-release. Decide whether to keep `media-libraries@jackt`
or move to something like `video-menu@jackt` (matching the name and the
sibling's `games-menu@jackt`) before uploading — after the first upload it is
fixed.

### Don't include unnecessary files: meets, unverified by tooling

The zip listing above is what should ship and nothing more. Unlike this
extension's sibling, `cmd_pack` has no automated check of that (above under
[Building the zip](#building-the-zip)), so this is a spot-check of one build
rather than a build-time guarantee — re-read `unzip -l` on the zip that is
actually uploaded.

### Use a linter: recommended

No ESLint configuration anywhere in the repository. GNOME Shell's own rules
are on GitLab, as the guideline points to; running them once before the first
upload is cheap and would likely turn up some of the optional-chaining and
logging points above mechanically.

## Private API

What the extension reaches into beyond public GNOME Shell API, what each path
is for, and what breaks if a future GNOME shell changes it, is covered in
[private-api.md](private-api.md) rather than here.

## Before uploading

Most consequential first:

1. **Decide the UUID.** The name is now "Video Menu"; the UUID is still
   `media-libraries@jackt`. Keep it, or move the UUID, the schema ID and
   path to match the name, before the first upload. This cannot be changed
   afterwards.
2. **Answer the dynamic-import question.** Either be ready to explain, in the
   upload notes, why `extension.js` stages `lib/` into
   `$XDG_RUNTIME_DIR` and imports it from there on every enable (the Wayland
   edit-without-restart need, documented in `CLAUDE.md`), or move that logic
   out of the shipped entry point into a dev-only script the way the sibling
   Wallpaper Engine extension does, and ship a plain, static
   `enable()`/`disable()` instead.
3. **Say what the extension does off-screen, in `description`.** Network
   access to TVmaze/TMDB/Wikipedia through a bundled Python backend, an
   optional TMDB key kept in GSettings, handing files to an external player,
   and the workspace-claiming behaviour in `workspaces` mode.
4. **Add a `LICENSE` at the top of `src/`** (for example
   GPL-2.0-or-later) so `make pack` includes it automatically.
5. **Remove `version` from `metadata.json`**; add `url` (pointing at the
   current repo) and `version-name`.
6. **Drop, or gate behind a debug switch, the two informational
   `console.log` calls** — `extension.js`'s `Enabled from ...` and
   `lib/app.js`'s `Rebuilt` — so nothing logs on a good enable or an ordinary
   settings change.
7. **Fix the schema's `gettext-domain`**, currently the shell's own
   (`gnome-shell-extensions`) rather than this extension's.
8. **Run `glib-compile-schemas --strict --dry-run src/schemas`** before every
   upload — an install enforces `--strict`, and nothing here currently runs
   it as a check.
9. **Run the GNOME Shell ESLint rules once**; there is no linter configured
   yet.
10. **Test the packed zip, not the development link** — `make uninstall`,
    `make pack`, `gnome-extensions install dist/media-libraries@jackt.shell-extension.zip`,
    log out and back in — and go through it on whichever shell versions are
    actually claimed; per `CLAUDE.md`, 48 and 49 have only been audited
    against the shell's sources so far, not booted.

## Uploading

- **Web:** log in at https://extensions.gnome.org/upload/, choose
  `dist/media-libraries@jackt.shell-extension.zip` (or whatever the UUID
  becomes once the name question above is settled), and accept the terms.
- **Command line** (gnome-extensions 49 and later):
  `gnome-extensions upload --accept-tos dist/<uuid>.shell-extension.zip`. It
  prompts for the EGO username and password; `--user`, `--password` and
  `--password-file` exist for CI, with the same caution gjs.guide gives about
  a password ending up in a command line, a log or the environment.

Each upload is reviewed before publication, and review comments land on the
extension's EGO page. EGO assigns and increments `version` itself.
