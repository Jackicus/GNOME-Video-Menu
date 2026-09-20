# Media Libraries

**Your own media collection, browsed like a streaming service — without one.**

A GNOME Shell extension that turns the folders you already have into a proper
library: posters, backdrops, ratings, synopses, episode lists. It lives on the
desktop wallpaper, in the overview beside your apps, or in a panel that pops
out of a button — your choice, and you can change your mind at any time.

**It does not play anything.** There is no player in here, no codecs, no
transcoding, no server. It finds your media, dresses it up, and when you pick
something it hands the file to whatever app already opens that kind of file —
VLC, mpv, Loupe, Rhythmbox, Steam, PCSX2. Think of it as a good-looking front
door to a collection you already own, not another media player competing for
the job.

---

## What it does

- **Five libraries.** TV Shows, Films, Music, Photos and Games. Turn on the
  ones you want and ignore the rest.
- **Finds the artwork for you.** Point it at a folder and it looks each title
  up online — posters, backdrops, year, rating, tagline, runtime, genres, a
  synopsis, the episode list. Everything is cached locally and pre-scaled, so
  browsing stays instant.
- **Games without a launcher.** Steam and PCSX2 are found on their own, with
  playtime, install folder and cover art.
- **Built out of GNOME, not on top of it.** The grid *is* the shell's app grid
  — same paging, same swipe, same keyboard, same hover and focus rings. It
  follows your accent colour, your font size and your theme, because it is
  using the shell's own widgets rather than imitating them.
- **Nothing to leave running.** No daemon, no tray icon, no window. It draws
  when you look at it and costs nothing when you don't.

## What it is not

- Not a player, a transcoder or a media server.
- Not a file manager — it will show you a folder in Files, but it won't
  rename, move or organise anything.
- Not a downloader. It fetches artwork and descriptions, and only that.

---

## Getting started

### 1. Check you're on a supported GNOME

GNOME Shell **48, 49 or 50**. Nothing else is needed — the scanner uses
Python 3 and the image libraries GNOME already ships. (If you happen to have
[Pillow](https://python-pillow.org/) installed it will use that instead;
either way, it's optional.)

```bash
gnome-shell --version
```

### 2. Install it

```bash
git clone https://github.com/Jackicus/Gnome-Extension-Media-Libraries.git
cd Gnome-Extension-Media-Libraries
make install
```

Then **log out and back in**. GNOME only notices a brand-new extension at
login — there's no way around it on Wayland.

### 3. Point it at your media

Open the preferences:

```bash
gnome-extensions prefs media-libraries@jackt
```

Each library has its own page, and each page tells you the folder layout it
expects:

- **TV Shows** — one folder per show. Seasons can be subfolders (`Season 2`)
  or `SxxEyy` in the file names.
- **Films** — one folder or file per film, named `Title (Year)`.
- **Music** — album folders, optionally inside artist folders.
- **Photos** — one folder per album; loose images count as an album too.
- **Games** — nothing to set. Steam's own library files are read (including
  libraries on other drives), and PS2 games come from wherever `PCSX2.ini`
  points.

Music and Photos start out pointed at your usual Music and Pictures folders.
TV Shows and Films have no default — your Videos folder can't be both — so
they stay switched off until you give them one.

### 4. Scan

Press **Rescan** on a library's page, or **Rescan everything** on the General
page. The first run takes a while — it's looking every title up online — and
after that it only re-reads folders that have actually changed.

That's it. Open your library from the home menu on the desktop, or from the
buttons that appear beside Show Apps, depending on the view you pick below.

---

## Choosing how it looks

Two settings on the **General** page decide where things happen, and they're
read independently of each other:

| | Libraries open in | Items open in |
|---|---|---|
| **Desktop** | The library is drawn on the wallpaper, under a home menu of your libraries | The item's details replace the grid, in place |
| **Workspaces** | Same, but each library claims a workspace of its own and slides to it | The details get a workspace of their own too |
| **Menu** | The library sits in the overview next to your apps, opened from a button beside Show Apps | The details pop up the way an app folder does |
| **Modal** | The library pops out of that button into a panel over the desktop | The details pop up over everything, until you dismiss them |

Mix them however you like — a library in the overview with details popping up
over the desktop is a perfectly good combination.

The rest of the **Appearance** group is one set of settings that applies to
every view: **covers per row** (fewer means bigger), **corner radius**, and
how much of the screen a pop-up fills. Colour comes from your system accent,
and text sizes follow Settings → Accessibility → Large Text.

---

## Artwork sources

Each library has an ordered list of places to look, tried in turn until one
answers:

| Library | Sources | Key needed? |
|---|---|---|
| TV Shows | TVmaze, TMDB, Wikipedia | Only TMDB |
| Films | TMDB, Wikipedia | Only TMDB |
| Music | iTunes | No |
| Games | Steam, IGDB | Only IGDB |
| Photos | — (thumbnails are made from your own pictures) | No |

TVmaze, Wikipedia and iTunes work straight away. TMDB adds backdrops,
taglines, runtimes and ratings and is worth setting up — a free key from
[themoviedb.org](https://www.themoviedb.org/settings/api) goes in the
preferences and applies everywhere at once. An unkeyed source simply skips
itself, so nothing breaks if you don't bother.

> Keys are stored in dconf in plain text, like any other GNOME setting. Treat
> them the way you'd treat any other credential on your machine.

---

## Everyday commands

You never need these — the preferences do the same things — but they're handy.

| Command | Does |
|---|---|
| `make status` | What's installed, whether it's enabled, how big the library is |
| `make scan` | Re-index every enabled library and fetch artwork |
| `make logs` | Follow the shell journal, filtered to this extension |
| `make uninstall` | Remove it entirely, older builds included |

Something looks wrong? `make logs` first — a GNOME extension's errors go to
the system journal, never to a terminal.

---

## Development

`CLAUDE.md` is the real design document: how the pieces fit together, which
shell internals are being used and why, and the traps that bite.

```bash
# Symlink src/ into the extensions dir, so edits are live
make link

# Apply your edits (recompiles schemas, disable/enable, no shell restart)
make reload

# Follow shell logs, filtered to Media Libraries
make logs
```

`make link` is the one to use while working in this repo. Run it once; after
that `make reload` picks up every edit straight from `src/`. Edits to
`extension.js` or `metadata.json` still need a full log out and back in.

| Command | Does |
|---|---|
| `make install` | Clean copy into the extensions dir (a real install, not a symlink) |
| `make stalls` | Watch for desktop freezes and log what stalled, on what, with timestamps |
| `make pack` | Build `dist/media-libraries@jackt.shell-extension.zip` |
| `make prune` | Remove superseded builds of this extension, keeping the current one |
| `make clean` | Drop compiled schemas, `dist/`, and files that don't ship |

### Seeing it

The UI renders onto the desktop wallpaper or into a shell-native panel, not
into an ordinary window, so a visual change can only be verified by looking at
it. These targets drive a throwaway **nested GNOME Shell** with a live mirror
on the real desktop — see `CLAUDE.md` and the `drive-extension` skill before
using them.

| Command | Does |
|---|---|
| `make nested` | Start the nested shell, with a live mirror window on the desktop |
| `make nested-headless` | Same, without the mirror window |
| `make preview` | Start it (if not already running) and take a screenshot |
| `make nested-status` | Report whether it's running |
| `make nested-stop` | Tear it down — always run this when finished |
