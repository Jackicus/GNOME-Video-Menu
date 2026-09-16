---
name: drive-extension
description: Launch a throwaway nested GNOME Shell, load Gnomeflix into it, click through the UI and capture screenshots, then shut it down. Use whenever a change needs to be SEEN rather than just compiled — layout, spacing, colours, animation end-states, navigation between the Library and Detail views, the section switcher — or when a change is risky enough that it should not be tried on the real desktop first. Also the way to test anything needing a fresh shell start, such as a new UUID, an extension.js edit, or a metadata.json change. The nested shell is mirrored live in a window on the user's desktop, so narrate what you do with `say` — the user is watching.
---

# Driving Gnomeflix in a nested shell

Gnomeflix renders onto the desktop background, so the only way to verify a visual
change is to look at it. A nested GNOME Shell is a complete second shell with its
own session bus and virtual monitor. It reads the same installed extension, but if
your code throws during `enable()` it takes down the *nested* shell — the user's
real session never notices.

It runs headless (this mutter build has no windowed backend), but `start` also
opens a **live mirror window on the user's real desktop**: a PipeWire screencast
of the nested monitor with the cursor embedded, at full frame rate, so animations
show as they really are. Two people are looking at it: you through screenshots,
the user through that window. Drive it so both can follow.

## Lifecycle — always close what you open

```bash
./scripts/nested.sh start 1600x900    # or: make nested. Opens the mirror too.
./scripts/nested.sh say "Baseline before the change"
./scripts/nested.sh shot /tmp/before.png
# ... edit src/, then:
./scripts/nested.sh say "Reloading with the new stylesheet"
./scripts/nested.sh reload
./scripts/nested.sh shot /tmp/after.png
./scripts/nested.sh stop              # or: make nested-stop. Closes the mirror.
```

**Keep one nested shell up while iterating** and `reload` into it between
edits; that is the fast loop. But also **`stop` + `start` at least once before
calling a change done**: a reload keeps the old workspaces, the old dconf
snapshot and whatever the previous build left on screen, and only a fresh start
exercises `extension.js`, the enable path and first-frame layout the way a login
does. **Always `stop` when the task is finished**, including when a check fails
— the user cannot use the mirror window anyway, and a leaked nested shell keeps
a gnome-shell, a dbus-daemon and a screencast alive. `status` says whether one is
already up; `start` reuses it.

`start --headless` skips the mirror, for when nobody is watching.

## Narrate for the watcher

Before every click, reload or check, run `say` with a short present-tense phrase
of what is about to happen. It appears as the shell's own OSD banner inside the
nested shell, so it shows in the mirror and in your screenshots alike:

```bash
./scripts/nested.sh say "Opening Black Clover"
./scripts/nested.sh click 125 280
./scripts/nested.sh say "Switching to the Extras tab"
./scripts/nested.sh click 460 374
```

Keep it to one line, no more than about 40 characters, and say what you are
looking for when it is a check ("Checking the hero lands on the poster").

## Commands

| Command | Does |
|---|---|
| `start [WxH]` | Start headless (default `1600x900`) and open the mirror. Installs the extension first if needed. |
| `start --headless [WxH]` | Same, without the mirror window |
| `mirror on\|off` | Open / close the live mirror window on the real desktop |
| `say TEXT` | Flash TEXT as an OSD banner in the nested shell |
| `shot [FILE]` | Screenshot to PNG; prints the path. Defaults under `dist/`. |
| `click X Y` | Click at desktop coordinates |
| `move X Y` | Move the pointer there without clicking, to see hover states in the next `shot` |
| `key KEYSYM` | `Escape`, `Return`, arrows, a single character, or a chord: `Super+Page_Down` switches workspace |
| `overview on\|off` | Show/hide the Activities overview |
| `reload` | disable/enable Gnomeflix *inside* the nested shell, picking up `src/` edits |
| `run CMD...` | Run any command against the nested shell's bus |
| `logs [N]` | The nested shell's own output — where exceptions land |
| `status` | Running? mirror open? is Gnomeflix ACTIVE? |
| `stop` | Close the mirror, terminate the shell, clean up |

After `shot`, **Read the PNG** — that is the point. Don't report a visual change as
working without having looked at it. The mirror is for the user; the screenshot
is for you.

## Reading the screenshot

At 1600x900 the surface fills the work area below the top panel. Roughly:

- Header: title top-left; the section switcher (TV Shows / Films / Music / Photos
  / Documents) top-right at y ≈ 83. With five tabs it starts further left; take a
  screenshot and measure the tab centres before clicking them.
- Library grid, 2:3 posters: row 1 centres y ≈ 275, row 2 y ≈ 605; columns start
  at x ≈ 120 with a ≈ 193 px pitch (8 columns at this size).
- Detail pane: back button at (48, 83); season/group tabs at y ≈ 374 starting
  x ≈ 372; episode rows from y ≈ 430 in ≈ 54 px steps; Play at (177, 562).

Re-measure from a fresh screenshot rather than trusting these if the columns
setting, the accent, the enabled sections or the geometry changed.

Navigation is two levels: Library → Detail. Seasons are tabs inside the detail
pane, not a separate view.

In the default `layout-mode` (`workspaces`) each section is its own workspace,
so clicking a switcher tab runs the shell's workspace slide (about 250 ms) and
the tiles stagger in after it. Wait ~1 s before the next `shot`. The top-left
workspace indicator and `overview on` show whether the section workspaces are
being kept alive. Switching workspace always drops back to that section's
library, even from a detail view.

## Verifying a change properly

1. `say` what you are about to compare, then `shot` before the edit.
2. Edit `src/`.
3. `say`, `reload`, then `shot` again.
4. Read both PNGs and say what actually differs. If nothing visibly changed, say so
   — do not assume the edit worked.
5. `logs` if anything looks wrong; a JS exception during enable leaves the old UI on
   screen and is easy to mistake for "no change".
6. `stop` when the task is done.

The preferences window can be driven too:
`./scripts/nested.sh run gnome-extensions prefs gnomeflix@jackt &` opens it inside
the nested session, where the mirror and `shot` both show it.

## Gotchas

- **The overview covers everything.** The nested shell boots into the Activities
  overview, which hides the desktop surface Gnomeflix draws on. `shot`, `click` and
  `say` dismiss it automatically; if you call the driver directly you must do it
  yourself.
- **Never move the pointer to the top-left.** That is the Activities hot corner and
  it throws the shell back into the overview. `click` pins from the bottom-right
  corner for exactly this reason.
- **A screen-sharing indicator appears in the top bar** while input is being
  injected or the mirror is open — it is the Mutter RemoteDesktop / ScreenCast
  session, not a bug in the extension.
- **Screenshots and banners need a bus name.** `org.gnome.Shell.Screenshot` and
  `ShowOSD` refuse unknown callers, so `nested_driver.py` owns
  `org.gnome.SettingsDaemon.MediaKeys` on the nested bus to get through. That name
  is unclaimed on a private throwaway bus. Do not try this against the real session.
- **`Eval` is blocked** (unsafe mode off), so there is no arbitrary-JS escape hatch.
  Drive it through input and D-Bus properties like a user would.
- **dconf is shared with the real session, and the nested one can clobber it.**
  The nested session starts its own `dconf-service`, which caches the database
  when it starts and rewrites the whole file on its first write. Any setting
  changed from the *real* session after the nested shell started (e.g. via
  `gsettings --schemadir src/schemas set ...`) is silently lost the moment the
  nested extension writes `last-section`. So: change settings **before** `start`
  or **after** `stop`, never in between, and re-check with `gsettings ...
  list-recursively org.gnome.shell.extensions.gnomeflix` once the nested shell is
  down. Put `last-section` back to `tv` when you are done.
- **New UUIDs still need a fresh start**, and so do edits to `extension.js` or
  `metadata.json` (the shell caches both for its lifetime). For a nested shell
  that is `stop` + `start`, about two seconds — the whole reason this exists.
  `reload` is enough for everything under `lib/`, the stylesheet and the schema.
- **The mirror needs GStreamer's PipeWire plugin** (`gst-plugin-pipewire`). If
  `mirror on` fails, fall back to `--headless` and screenshots, and say so.
