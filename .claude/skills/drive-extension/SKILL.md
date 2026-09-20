---
name: drive-extension
description: Run Media Libraries in a throwaway nested GNOME Shell, mirrored live on the user's desktop — click through it, screenshot it, then shut it down. Use whenever a change must be SEEN (layout, spacing, colour, animation end-states, Home/Library/Detail navigation, the overview and workspace-slide clones), or needs a fresh shell start (extension.js, metadata.json, a new UUID).
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
| `key KEYSYM` | `Escape`, `Return`, arrows, one character, or a chord like `Super+Page_Down` |
| `wait SECS` | Let an animation land: ~1 s after anything that changes workspace (a launcher, the Home pill), ~0.6 s after opening or closing an item |
| `shot [FILE [X Y W H]]` | Screenshot, or **just a region** — crop to what you are checking (a header strip, one tile) rather than reading 1600×900 every time |
| `overview on\|off` | Show/hide the overview. While on, shots and clicks act on it (for `overviewPreview.js`); nothing dismisses it until `off`. |

The same steps exist as single commands (`./scripts/nested.sh click X Y`, …) for a
one-off; prefer `do`. Other commands: `status`, `reload`, `logs [N] [--all]`,
`mirror on|off`, `run CMD…` (against the nested bus), `start --headless [WxH]`.

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

## Reading the screen (1600×900)

Measure from a fresh screenshot if the columns setting, enabled sections, accent or
geometry changed. Roughly:

- **Home menu** (what a fresh start shows, when `library-opens-in` is `desktop`
  or `workspaces`): launchers
  in a centred row at y ≈ 465; with all six sections their centres are x ≈ 200, 440,
  680, 920, 1160, 1400. Clicking one opens that section on a new workspace, where the
  **Home** pill at (1520, 83) closes it again.
  `key Super+Page_Up` goes back to Home and leaves the section open. That is
  `library-opens-in` `workspaces`; in `desktop` the same click swaps the page
  on the one workspace and the Home pill swaps it back, with no slide. Check
  which by cropping the workspace indicator: `shot F 0 0 140 30`.
- **A mode change leaves the active workspace where it was**, so after
  switching `library-opens-in` from `workspaces` to `desktop` you may be
  sitting on a workspace that is no longer one of ours and see bare wallpaper.
  `key Super+Page_Up` to the home workspace first, or `stop` + `start`.
- **Header**: title top-left; Home pill top-right. Header strip region: `0 30 1600 110`.
- **Library grid**, 2:3 posters: row 1 centres y ≈ 250, row 2 y ≈ 540; columns from
  x ≈ 105 with a ≈ 170 px pitch (9 columns).
- **Detail pane**: back button (48, 83); group tabs y ≈ 374 from x ≈ 372; rows from
  y ≈ 430 in ≈ 54 px steps; Play (177, 562).
- **The `modal` library** (`library-opens-in` `modal`) pops a panel over the desktop
  from a section's button — with Dash to Panel, over the bottom panel — the
  same size and shade as the popup detail below, roughly `210,78` to
  `1390,800`. `click 20 450` on the shade closes it, as does `key Escape` or a
  second press of its button; picking an item opens the detail the same way a
  desktop or menu pick would, per `detail-opens-in`.
- **Empty library**: a centred placeholder with an Open Settings button — normal
  until a section has been pointed at a folder and scanned.

Switching workspace drops back to that section's library. A slide is over in
250 ms and a `shot` takes longer than that to fire, so a frame caught mid-slide
is luck: `wait 0.12` after the click catches its tail end at best.

`reload` does not recompile the schema; after editing the `.gschema.xml` run
`glib-compile-schemas src/schemas` and `stop` + `start`. A `say` text must not
contain an apostrophe — steps are shell-split.

## When it looks wrong

`logs` first. A JS exception during enable leaves the previous UI on screen, which
reads as "no change". `logs` hides D-Bus activation and portal chatter; `logs 200
--all` shows everything. `[Media Libraries]` lines are the extension's own.

## Gotchas

- **dconf is shared with the real session, and the nested one can clobber it.** The
  nested `dconf-service` caches the database at start and rewrites the whole file
  on its first write, so a setting changed from the real session while a nested
  shell runs is silently lost once anything in the nested one writes a key.
  Change settings **before** `start` or **after** `stop`, then re-check with
  `gsettings --schemadir src/schemas list-recursively org.gnome.shell.extensions.media-libraries`.
- **`start` enables Media Libraries** if dconf doesn't list it — which writes
  `enabled-extensions`, so the real session will load it at the next login too.
- **The `menu` and `modal` libraries' buttons sit beside Show Apps** (the same
  buttons; `library-opens-in` chooses what pressing one does). The nested shell loads the
  real session's extensions, so with Dash to Panel on they are in its bottom
  panel: Show Apps ≈ (30, 875), then a button per section with items, TV
  Shows ≈ (90, 875), Films ≈ (150, 875), Photos ≈ (210, 875), Games ≈ (270,
  875). Without it they are in the overview's dash: Show Apps ≈ (727, 850),
  TV Shows ≈ (800, 850), Films ≈ (873, 850). `library-opens-in` and `detail-opens-in` are
  dconf settings, so set them before `start` — or with `run gsettings` to
  watch a live switch. A `shot` or `click` outside `overview on` dismisses the
  overview, so wrap any overview walkthrough in `overview on` … `overview off`,
  and if a run starts with the overview in an unknown state, `overview off`
  then `overview on` first.
- **`overview on` is a flag, not only a command.** It writes the
  "overview wanted" marker in the run dir and *then* sets `OverviewActive`
  only if it is not already set — so it is also the way to photograph an
  overview the **extension** opened (a section button pressed from the
  desktop): `do "overview on" "shot $S/x.png"` marks it wanted and leaves the
  open overview alone, where a bare `shot` would dismiss it. `run python3
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
