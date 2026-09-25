---
name: drive-extension
description: Run Media Libraries in a throwaway nested GNOME Shell, mirrored live on the user's desktop — click through it, screenshot it, then shut it down. Use whenever a change must be SEEN (layout, spacing, colour, animation end-states, the tabs, Library → Detail navigation, the overview and workspace-slide clones), or needs a fresh shell start (extension.js, metadata.json, a new UUID).
---

# Driving Media Libraries in a nested shell

Media Libraries renders onto the desktop background, so the only way to verify a visual
change is to look at it. The nested shell is a complete second GNOME Shell with its
own session bus and virtual monitor, reading the same installed extension; if the
code throws during `enable()` it takes down the *nested* shell, never the user's.

It runs headless, and `start` opens a **live mirror window on the user's real
desktop** so they can watch. Two people are looking: you through screenshots, the
user through that window. Drive it so both can follow.

## The loop

```bash
S=/tmp/claude-1000/...scratchpad        # your scratchpad; keep shots out of the repo
./scripts/nested.sh start               # ~2 s; Media Libraries is ACTIVE when it returns
./scripts/nested.sh do "say Baseline" "shot $S/before.png"
# ... edit src/ ...
./scripts/nested.sh reload
./scripts/nested.sh do "say After the stylesheet change" "shot $S/after.png"
./scripts/nested.sh stop                # closes the mirror window too
```

Then **Read the PNGs** and say what actually differs. If nothing visibly changed,
say so; do not assume the edit worked.

## Batch with `do` — one call per interaction

`do` runs every step over a single connection and input session, so a whole
walkthrough is **one** tool call, and it stops at the first failing step:

```bash
./scripts/nested.sh do \
  "say Opening the first show" "click 120 275" "wait 0.6" \
  "say Switching to season 2"  "click 460 374" "wait 0.3" \
  "shot $S/season2.png"
```

| Step | Does |
|---|---|
| `say TEXT` | Banner in the nested shell (≤ ~40 chars). Put one before every click or check. |
| `click X Y` / `move X Y` | Click / hover at desktop coordinates |
| `key KEYSYM` | `Escape`, `Return`, arrows, `F1`–`F12`, a remote's `XF86OK`/`XF86Back`/`XF86HomePage`/`XF86ChannelUp`…, one character, or a chord like `Super+Page_Down` |
| `wait SECS` | Let an animation land: ~1 s after anything that changes workspace (the button, a tab switch that claims or releases one), ~0.6 s after opening or closing an item |
| `shot [FILE [X Y W H]]` | Screenshot, or **just a region** — crop to what you are checking (a header strip, one tile) rather than reading 1600×900 every time |
| `window FILE` | Screenshot of the focused window alone, frame and shadow included — how the preferences in `docs/screenshots/` are taken |
| `overview on\|off` | Show/hide the overview. While on, shots and clicks act on it (for `overviewPreview.js`); nothing dismisses it until `off`. |

The same steps exist as single commands (`./scripts/nested.sh click X Y`, …) for a
one-off; prefer `do`. Other commands: `status`, `reload`, `logs [N] [--all]`,
`mirror on|off`, `run CMD…` (against the nested bus), `start --headless [WxH]`,
`start --clean [--demo]` (below).

## Screenshots for the docs

`docs/screenshots/` — the README's images — are taken in
`./scripts/nested.sh start --clean --demo`: settings of its own with only Media
Libraries enabled and the real session's look copied in (so GNOME's default
wallpaper, and the library button in the overview's dash at ≈ (960, 838)), and
the made-up library `scripts/demo_library.py` draws, pointed at through the
session's `XDG_CACHE_HOME` — never the user's own collection, which is not for
a public repo. Full-screen shots go in as JPEG, windows (`window FILE`, the
preferences) as PNG. Switch places with `run gsettings --schemadir
"$PWD/src/schemas" set …`, which under `--clean` writes the private database.

## Closing what you open

**`stop` when the task is finished — including when a check failed.** It closes the
mirror window, the shell, its bus and the screencast. Keep one shell up while
iterating and `reload` into it; `start` reuses a running one.

Backstops, so a forgotten `stop` never strands a window on the user's desktop:
- the mirror window closes by itself when the nested shell stops or crashes;
- a shell started from a Claude Code session stops itself after 10 minutes with no
  `nested.sh` command (`MEDIA_LIBRARIES_NESTED_IDLE=<seconds>` at `start`, `0` = never);
- the project's SessionEnd hook stops it when that session ends.

Do not rely on them — they are for accidents. If the idle stop hit mid-task,
`start` again (~2 s).

**`stop` + `start` at least once before calling a change done.** `reload` keeps the
old workspaces, dconf snapshot and whatever the previous build left on screen; only
a fresh start exercises `extension.js`, the enable path and first-frame layout the
way a login does. Edits to `extension.js` or `metadata.json` *need* one.

## Reading the screen (1600×900, Dash to Panel on — measured 2026-09-25)

Measure from a fresh screenshot if the columns setting, enabled sections, accent or
geometry changed; these are what the layout gives with the defaults. There is one
button, beside Show Apps — Show Apps ≈ (30, 875), the library button ≈ (90, 875),
tooltip "Videos" — and pressing it is the only way in everywhere; there is no home
menu and no per-section button.

- **`desktop` / `workspaces`** (`library-opens-in`): pressing the button draws the
  library — tabs over a grid — on the wallpaper. Header strip y ≈ 83: tabs centred
  (TV Shows ≈ x 765, Films ≈ x 846), Settings ≈ (1508, 83), Close ≈ (1553, 83).
  Grid rows from y ≈ 300, first poster ≈ (325, 300). Opening an item swaps the
  tabs for a Back button at (48, 83). In `desktop` the button (or Close, or
  Escape) puts the library away again on the same workspace, no slide; pressed
  on another workspace it moves there rather than opening a second copy. In
  `workspaces` the button claims a workspace and slides to it; closing it
  slides back to wherever it was opened from and gives the claimed one up.
  Check which mode you are in by cropping the workspace indicator:
  `shot F 0 0 140 30`.
- **A mode change leaves the active workspace where it was**, so after
  switching `library-opens-in` from `workspaces` to `desktop` you may be
  sitting on a workspace that is no longer one of ours and see bare wallpaper.
  Press the button again, or `stop` + `start`.
- **Detail pane** (on the surface): Back (48, 83); group tabs y ≈ 374 from
  x ≈ 372; rows from y ≈ 430 in ≈ 54 px steps; Play (177, 562).
- **The `menu` library** (`library-opens-in` `menu`): the button opens the
  overview onto the tabs over the grid, in the app-grid slot. Tabs at
  y ≈ 127 (TV Shows ≈ x 765, Films ≈ x 846), grid rows centred at y ≈ 320 and
  570. The tabs switch sections in place — no overview transition — unless
  another extension's view (Games Menu's) is what is showing there, in which
  case pressing ours closes the overview and reopens it onto ours.
- **The `modal` library** (`library-opens-in` `modal`) pops a panel over the
  desktop out of the button — with Dash to Panel, over the bottom panel — the
  same size and shade as the popup detail below, roughly `210,78` to
  `1390,800`, tabs at y ≈ 104 (same x as above). `click 20 450` on the shade
  closes it, as does `key Escape` or a second press of the button; picking an
  item opens the detail the same way a desktop or menu pick would, per
  `detail-opens-in`.
- **Empty section**: its tab shows a centred placeholder with an Open Settings
  button — normal until that section has been pointed at a folder and
  scanned.

Switching workspace drops back to whatever that workspace is showing. A slide
is over in 250 ms and a `shot` takes longer than that to fire, so a frame
caught mid-slide is luck: `wait 0.12` after the click catches its tail end at
best.

`reload` does not recompile the schema; after editing the `.gschema.xml` run
`glib-compile-schemas src/schemas` and `stop` + `start`. A `say` text must not
contain an apostrophe — steps are shell-split.

## When it looks wrong

`logs` first. A JS exception during enable leaves the previous UI on screen, which
reads as "no change". `logs` hides D-Bus activation and portal chatter; `logs 200
--all` shows everything. `[Media Libraries]` lines are the extension's own.

## Gotchas

- **dconf is shared with the real session, and other projects' nested shells
  clobber it too.** Every nested shell (this one, Wallpaper Engine's, Media
  Controls') writes the same real dconf file, and each one's `dconf-service`
  caches the database at start and rewrites the whole file from that stale
  cache on its first write — so a setting changed for a test, even one made
  from a *different* project's nested shell, can silently revert within
  seconds. **To test a setting, `start --clean`**: the nested session gets a
  database of its own (`media_libraries_nested`, a writable layer that starts
  empty every time over a read-only one with Media Libraries alone enabled and
  the real session's look), `run gsettings …` writes there, and `stop` deletes
  it. Nothing touches `~/.config/dconf/user`. The catch is that it has none of
  the real session's settings or extensions — no Dash to Panel, no Blur my
  Shell, no folders — so test against those without `--clean`, and change
  settings only while no other nested shell is up. A dconf database name must
  not contain a hyphen: it becomes a D-Bus object path element.
- **`start` enables Media Libraries** if dconf doesn't list it — which writes
  `enabled-extensions`, so the real session will load it at the next login too.
- **The one button sits beside Show Apps.** The nested shell loads the real
  session's extensions, so with Dash to Panel on it is in its bottom panel:
  Show Apps ≈ (30, 875), the library button ≈ (90, 875), tooltip "Videos".
  Without it they are in the overview's dash, further right and higher up —
  reshoot rather than trust a remembered coordinate. `library-opens-in` and
  `detail-opens-in` are dconf settings, so set them before `start` — or with
  `run gsettings` to watch a live switch. A `shot` or `click` outside
  `overview on` dismisses the overview, so wrap any overview walkthrough in
  `overview on` … `overview off`, and if a run starts with the overview in an
  unknown state, `overview off` then `overview on` first.
- **`overview on` is a flag, not only a command.** It writes the
  "overview wanted" marker in the run dir and *then* sets `OverviewActive`
  only if it is not already set — so it is also the way to photograph an
  overview the **extension** opened (the button pressed from the desktop):
  `do "overview on" "shot $S/x.png"` marks it wanted and leaves the open
  overview alone, where a bare `shot` would dismiss it. `run python3
  scripts/nested_driver.py …` carries the same environment as `do` now
  (`NESTED_RUN_DIR` and friends), so the driver called that way sees the flag
  too; before that it silently dismissed the overview in its own screenshot,
  which reads as "the overview will not open".
- **With a pop-up detail** (`detail-opens-in` = `menu` or `modal`) a pick zooms a panel
  out of its tile over a shade; the shade's edge is 48px in from the work
  area, so `click 20 450` lands on the shade and closes it, as `key Escape`
  does.
- **A keyboard walk has to be one unbroken run of `key` steps.** A `say` or a
  `shot` between presses takes the keyboard away, and the extension's focus
  watcher hands it back to the surface rather than to the tile or row that had
  it — so the walk starts over. Put the banner before the first key and the
  screenshot after the last.
- **Never click or hover at the top-left.** It is the Activities hot corner and
  throws the shell into the overview. Pointer motion is absolute (the input session
  is linked to a screencast of the monitor), so a point only lands there if asked
  to; coordinates outside the monitor are rejected.
- **A screen-sharing indicator in the top bar** is the input/screencast session, not
  an extension bug.
- **`Eval` is blocked** (unsafe mode off): no arbitrary-JS escape hatch. Drive it
  through input and D-Bus properties like a user would.
- **Screenshots and banners borrow a bus name** (`org.gnome.SettingsDaemon.MediaKeys`,
  unclaimed on the throwaway bus) because the shell refuses unknown callers. Never
  try that against the real session.
- **Other extensions load too** (the nested shell reads the same extension list), so
  their log lines and top-bar icons appear alongside Media Libraries.
- **The mirror needs GStreamer's PipeWire plugin.** If `mirror on` fails, use
  `start --headless` and screenshots, and tell the user.
- **Driving the prefs window:** `./scripts/nested.sh run gnome-extensions prefs media-libraries@jackt &`
  opens it inside the nested session, where `shot` and the mirror both show it.
  The Extensions app outlives its window and keeps the `prefs.js` it first
  imported, so after editing it kill *the nested one* before reopening — the
  process whose environment has `WAYLAND_DISPLAY=media-libraries-dev`, never a
  bare `pkill -f`, which also matches the real session's and your own shell.
- **With the library on the surface, windows on its workspace get no keys.**
  The surface's focus watcher takes the keyboard back from them, so anything
  typed into a window there (the prefs included) goes nowhere. Test keyboard
  input into a window with `library-opens-in` `menu` or `modal`.
- **A game controller is `scripts/vpad.py`**, a virtual Xbox 360 pad on
  uinput driven through a FIFO (`tap A`, `hat down`, `stick right 1.0`). It
  is a real device for the whole machine while it runs; `quit` it when done.
  Controller input is acted on only while a library is up and no window has
  the focus, so drive it with the prefs window closed.
- **Watched marks are real data.** Ticking an episode in the nested shell (a
  click on the disc, Mark watched from a key or the pad) writes the real
  `~/.local/share/media-libraries/watched.json` and, with `tracking` =
  `source`, a `.media-libraries-watched.json` into the library folder itself.
  Don't, or put both back afterwards.
- **The shell's "Allow inhibiting shortcuts" prompt writes the real permission
  store**, which the nested session shares. If a test has to answer it, delete
  the entry afterwards (`PermissionStore.DeletePermission gnome
  shortcuts-inhibitor org.gnome.Shell.Extensions.desktop`) so the real
  session still asks.
