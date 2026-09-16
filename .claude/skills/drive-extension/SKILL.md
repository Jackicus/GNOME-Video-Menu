---
name: drive-extension
description: Launch a throwaway nested GNOME Shell, load Gnomeflix into it, click through the UI and capture screenshots, then shut it down. Use whenever a change needs to be SEEN rather than just compiled — layout, spacing, colours, animation end-states, navigation between the Library, Seasons and Episodes views — or when a change is risky enough that it should not be tried on the real desktop first. Also the way to test anything needing a fresh shell start, such as a new UUID or a metadata.json change.
---

# Driving Gnomeflix in a nested shell

Gnomeflix renders onto the desktop background, so the only way to verify a visual
change is to look at it. A nested GNOME Shell is a complete second shell with its
own session bus and virtual monitor. It reads the same installed extension, but if
your code throws during `enable()` it takes down the *nested* shell — the user's
real session never notices.

Headless by default: nothing appears on the user's screen. You see it through
screenshots.

## Lifecycle — always close what you open

```bash
./scripts/nested.sh start 1600x900   # or: make nested
./scripts/nested.sh shot /tmp/before.png
# ... edit src/, then:
./scripts/nested.sh reload
./scripts/nested.sh shot /tmp/after.png
./scripts/nested.sh stop             # or: make nested-stop
```

**Always `stop` when you are done**, including when a check fails or you hit an
error. A leaked nested shell keeps a gnome-shell process and a dbus-daemon alive.
Run `./scripts/nested.sh status` if you are unsure whether one is already up;
`start` will reuse a running one rather than starting a second.

## Commands

| Command | Does |
|---|---|
| `start [WxH]` | Start headless (default `1920x1080`). Installs the extension first if needed. |
| `start --windowed [WxH]` | Visible window instead — use when the *user* wants to watch |
| `shot [FILE]` | Screenshot to PNG; prints the path. Defaults under `dist/`. |
| `click X Y` | Click at desktop coordinates |
| `key KEYSYM` | `Escape`, `Return`, `Left`, `Right`, `Up`, `Down`, or a single character |
| `overview on\|off` | Show/hide the Activities overview |
| `reload` | disable/enable Gnomeflix *inside* the nested shell, picking up `src/` edits |
| `run CMD...` | Run any command against the nested shell's bus |
| `logs [N]` | The nested shell's own output — where exceptions land |
| `status` | Running? which bus? is Gnomeflix ACTIVE? |
| `stop` | Terminate and clean up |

After `shot`, **Read the PNG** — that is the point. Don't report a visual change as
working without having looked at it.

## Reading the screenshot

At 1600x900 with the default 6 columns the library grid lands roughly at:

- Row 1 poster centres: y ≈ 290; Row 2: y ≈ 575
- Column centres: x ≈ 148, 315, 481, 647, 813, 978

So `click 978 575` opens the 12th show. Re-measure from a fresh screenshot rather
than trusting these if the columns setting or geometry changed.

Navigation is Library → Seasons → Episodes. `← Back to Library` sits near
`click 143 90`.

## Verifying a change properly

1. `shot` before the edit, so you have something to compare against.
2. Edit `src/`.
3. `reload`, then `shot` again.
4. Read both PNGs and say what actually differs. If nothing visibly changed, say so
   — do not assume the edit worked.
5. `logs` if anything looks wrong; a JS exception during enable leaves the old UI on
   screen and is easy to mistake for "no change".
6. `stop`.

## Gotchas

- **The overview covers everything.** The nested shell boots into the Activities
  overview, which hides the desktop surface Gnomeflix draws on. `shot` and `click`
  dismiss it automatically; if you call the driver directly you must do it yourself.
- **Never move the pointer to the top-left.** That is the Activities hot corner and
  it throws the shell back into the overview. `click` pins from the bottom-right
  corner for exactly this reason.
- **A screen-sharing indicator appears in the top bar** while input is being
  injected — it is the Mutter RemoteDesktop session, not a bug in the extension.
- **Screenshots need a bus name.** `org.gnome.Shell.Screenshot` refuses unknown
  callers, so `nested_driver.py` owns `org.gnome.SettingsDaemon.MediaKeys` on the
  nested bus to get through. That name is unclaimed on a private throwaway bus.
  Do not try this against the real session.
- **`Eval` is blocked** (unsafe mode off), so there is no arbitrary-JS escape hatch.
  Drive it through input and D-Bus properties like a user would.
- **dconf is shared with the real session.** Changing a Gnomeflix setting inside the
  nested shell changes it for the user's real desktop too. Set it back when done.
- **New UUIDs still need a fresh start**, but for a nested shell that is `stop` +
  `start`, about two seconds — the whole reason this exists.
