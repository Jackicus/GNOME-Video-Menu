"""Installed games: Steam's own library files, and PCSX2's PS2 disc images.

Nothing here is a folder walk over a media tree the way the other sections
are — a game library is described by the launcher's own bookkeeping, so this
module reads that instead:

  Steam   steamapps/libraryfolders.vdf lists every library root (games install
          on any drive) and every appid registered in them; one
          appmanifest_<appid>.acf per title gives the name, the install
          directory and the size. Playtime comes from the logged-in user's
          userdata/<id>/config/localconfig.vdf.
  PCSX2   PCSX2.ini names the game directories ([GameList] RecursivePaths) and
          the covers folder ([Folders] Covers); the disc images themselves are
          files under those directories.

Both halves degrade to an empty list: a machine with no Steam, or with PCSX2
installed but never launched (so no PCSX2.ini yet), is a real answer and not
an error.

Launching is an argv list handed straight to Gio.Subprocess by the shell:
`xdg-open steam://rungameid/<appid>` for Steam, and the PCSX2 binary (native,
AppImage or the flatpak export wrapper) with the disc image for PS2.

No network — metadata.py's `steam` and `igdb` providers do the online half.
"""

import os
import re

from media_scanner import IMAGE_EXTENSIONS, file_size_mb, natural_sort_key, path_key, slug
from metadata import cache_local_art

# --------------------------------------------------------------------------
# Steam
# --------------------------------------------------------------------------

# Where a stock Steam install lives. `~/.steam/steam` is usually a symlink to
# one of the others, so the same root can be reached twice — scan_steam
# de-duplicates by real path.
STEAM_ROOTS = (
    "~/.steam/steam",
    "~/.steam/debian-installation",
    "~/.local/share/Steam",
    "~/.var/app/com.valvesoftware.Steam/.local/share/Steam",
    "~/.var/app/com.valvesoftware.Steam/data/Steam",
)

# Entries Steam registers exactly like a game but that nobody plays: the
# compatibility tools, the runtimes and the shared redistributables.
NON_GAME_PATTERNS = (
    "steamworks common redistributables",
    "steam linux runtime",
    "proton",
    "steamvr",
    "steam controller configs",
)

def _read_text(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return None


_VDF_TOKEN = re.compile(r'"((?:[^"\\]|\\.)*)"|([{}])')


def parse_vdf(text):
    """Parse Valve's key/value format into nested dicts.

    Tolerant on purpose: unquoted tokens, comments and stray braces are skipped
    rather than raised on, because these files are written by the client and we
    only ever read a handful of known keys out of them. Repeated keys keep the
    first value, which is how Steam itself resolves them.
    """
    root = {}
    stack = [root]
    pending = None
    for match in _VDF_TOKEN.finditer(text or ""):
        string, brace = match.group(1), match.group(2)
        if brace == "{":
            child = {}
            if pending is not None:
                stack[-1].setdefault(pending, child)
                child = stack[-1][pending]
                pending = None
            stack.append(child if isinstance(child, dict) else {})
        elif brace == "}":
            if len(stack) > 1:
                stack.pop()
            pending = None
        elif pending is None:
            pending = string.replace('\\\\', '\\').replace('\\"', '"')
        else:
            stack[-1].setdefault(pending, string.replace('\\\\', '\\').replace('\\"', '"'))
            pending = None
    return root


def _vdf_get(node, *path):
    """Walk a parsed vdf case-insensitively; None when any step is missing."""
    for key in path:
        if not isinstance(node, dict):
            return None
        for k, v in node.items():
            if k.lower() == key.lower():
                node = v
                break
        else:
            return None
    return node


def steam_roots(explicit=None):
    """Candidate Steam roots, real paths, de-duplicated, existing only."""
    candidates = [explicit] if explicit else list(STEAM_ROOTS)
    roots, seen = [], set()
    for raw in candidates:
        if not raw:
            continue
        path = os.path.realpath(os.path.expanduser(raw))
        if path in seen or not os.path.isdir(path):
            continue
        seen.add(path)
        roots.append(path)
    return roots


def _is_non_game(name):
    lower = name.lower()
    return any(pattern in lower for pattern in NON_GAME_PATTERNS)


def _steam_libraries(root):
    """`root` plus every extra library its libraryfolders.vdf points at."""
    libraries = [root]
    data = parse_vdf(_read_text(os.path.join(root, "steamapps", "libraryfolders.vdf")) or "")
    folders = _vdf_get(data, "libraryfolders") or {}
    for entry in folders.values():
        path = entry.get("path") if isinstance(entry, dict) else None
        if not path:
            continue
        path = os.path.realpath(path)
        if os.path.isdir(os.path.join(path, "steamapps")) and path not in libraries:
            libraries.append(path)
    return libraries


def _steam_playtimes(root):
    """appid -> {'playtime_minutes': int, 'last_played': int} for every local user.

    localconfig.vdf is per Steam account; a shared machine has several, and the
    largest playtime across them is the honest answer for "this install".
    """
    out = {}
    userdata = os.path.join(root, "userdata")
    try:
        accounts = os.listdir(userdata)
    except OSError:
        return out
    for account in accounts:
        text = _read_text(os.path.join(userdata, account, "config", "localconfig.vdf"))
        if not text:
            continue
        apps = _vdf_get(parse_vdf(text), "UserLocalConfigStore", "Software", "Valve", "Steam", "apps")
        if not isinstance(apps, dict):
            continue
        for appid, values in apps.items():
            if not isinstance(values, dict):
                continue
            minutes = _int_or_none(values.get("Playtime") or values.get("playtime"))
            played = _int_or_none(values.get("LastPlayed") or values.get("lastplayed"))
            record = out.setdefault(appid, {"playtime_minutes": None, "last_played": None})
            if minutes is not None and (record["playtime_minutes"] or 0) < minutes:
                record["playtime_minutes"] = minutes
            if played is not None and (record["last_played"] or 0) < played:
                record["last_played"] = played
    return out


def _int_or_none(value):
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def _steam_local_art(root, appid):
    """(poster, backdrop) from the client's own cache, either layout.

    Modern clients keep `appcache/librarycache/<appid>/library_600x900.jpg`;
    older ones put everything flat with an `<appid>_` prefix. The cache is
    lazy — the client downloads only what it has had to draw — so a missing
    file is normal and metadata.py fetches it from the store CDN instead.

    Both are copied into the extension's own cache at drawing size: the hero art in
    particular is 1920 wide, and Steam is free to clear its cache under us.
    """
    cache = os.path.join(root, "appcache", "librarycache")
    found = []
    for stem in ("library_600x900", "library_hero"):
        hit = None
        for candidate in (
            os.path.join(cache, appid, f"{stem}.jpg"),
            os.path.join(cache, appid, f"{stem}.png"),
            os.path.join(cache, f"{appid}_{stem}.jpg"),
            os.path.join(cache, f"{appid}_{stem}.png"),
        ):
            if os.path.isfile(candidate):
                hit = candidate
                break
        found.append(hit)
    return cache_local_art(found[0]), cache_local_art(found[1], "backdrop")


def scan_steam(root=None):
    """Every installed Steam game, across every library the install knows about."""
    games = []
    for steam_root in steam_roots(root):
        libraries = _steam_libraries(steam_root)
        playtimes = _steam_playtimes(steam_root)
        for library in libraries:
            steamapps = os.path.join(library, "steamapps")
            try:
                manifests = sorted(
                    (n for n in os.listdir(steamapps) if n.startswith("appmanifest_") and n.endswith(".acf")),
                    key=natural_sort_key,
                )
            except OSError:
                continue
            for name in manifests:
                game = _steam_game(steamapps, name, steam_root, playtimes)
                if game:
                    games.append(game)
        if games:
            break  # the first install that actually has games wins
    games.sort(key=lambda g: natural_sort_key(g["title"]))
    return games


def _steam_game(steamapps, manifest, steam_root, playtimes):
    state = _vdf_get(parse_vdf(_read_text(os.path.join(steamapps, manifest)) or ""), "AppState")
    if not isinstance(state, dict):
        return None
    appid = str(state.get("appid") or "").strip()
    title = (state.get("name") or "").strip()
    installdir = (state.get("installdir") or "").strip()
    if not appid or not title or not installdir or _is_non_game(title):
        return None

    folder = os.path.join(steamapps, "common", installdir)
    if not os.path.isdir(folder):
        return None  # a stale manifest for something already uninstalled

    poster, backdrop = _steam_local_art(steam_root, appid)
    played = playtimes.get(appid, {})
    size = _int_or_none(state.get("SizeOnDisk")) or 0
    return {
        "id": f"steam_{appid}",
        "kind": "game",
        "title": title,
        "platform": "steam",
        "year": None,
        "folder_path": folder,
        # steam:// keeps the client's own launch options, compatibility tool
        # and overlay; running the binary directly would drop all three.
        "launch": ["xdg-open", f"steam://rungameid/{appid}"],
        "poster_path": poster,
        "backdrop_path": backdrop,
        "summary": None,
        "genres": [],
        "rating": None,
        "playtime_minutes": played.get("playtime_minutes"),
        "last_played": played.get("last_played"),
        "app_id": appid,
        "steam_root": steam_root,
        "size_mb": round(size / (1024 * 1024), 1) if size else 0,
    }


# --------------------------------------------------------------------------
# PCSX2 (PlayStation 2)
# --------------------------------------------------------------------------

PCSX2_CONFIG_ROOTS = (
    "~/.config/PCSX2",
    "~/.var/app/net.pcsx2.PCSX2/config/PCSX2",
    "~/.config/pcsx2",
    "~/.PCSX2",
)

PCSX2_EXECUTABLES = (
    "~/.local/share/flatpak/exports/bin/net.pcsx2.PCSX2",
    "/var/lib/flatpak/exports/bin/net.pcsx2.PCSX2",
    "/usr/bin/pcsx2-qt",
    "/usr/bin/pcsx2",
    "/usr/games/pcsx2-qt",
    "/usr/games/pcsx2",
    "/usr/local/bin/pcsx2-qt",
    "/usr/local/bin/pcsx2",
    "/snap/bin/pcsx2",
)
PCSX2_APPIMAGE_DIRS = ("~/Applications", "~/.local/bin", "~/bin", "~/Downloads")

# Disc images PCSX2 can boot. A `.bin` is only a game when no `.cue` names it:
# otherwise the cue is the title and the bin is its track data — and a BIOS
# dump is called `.bin` too.
PS2_EXTENSIONS = {".iso", ".chd", ".cso", ".zso", ".cue", ".elf", ".gz", ".mdf", ".nrg", ".bin"}
PS2_SCAN_MAX_DEPTH = 5
PS2_SCAN_MAX_FILES = 2000

# "SLUS-20062", "SCES_502.10" — the serial PCSX2 names a cover after.
SERIAL_RE = re.compile(r"\b(S[A-Z]{3}[-_]?\d{3}\.?\d{2})\b", re.IGNORECASE)


def pcsx2_config_roots(explicit=None):
    candidates = [explicit] if explicit else list(PCSX2_CONFIG_ROOTS)
    roots, seen = [], set()
    for raw in candidates:
        if not raw:
            continue
        path = os.path.realpath(os.path.expanduser(raw))
        if path in seen or not os.path.isdir(path):
            continue
        seen.add(path)
        roots.append(path)
    return roots


def pcsx2_executable():
    """The argv prefix that launches PCSX2, or None when it is not installed."""
    for candidate in PCSX2_EXECUTABLES:
        path = os.path.expanduser(candidate)
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    for directory in PCSX2_APPIMAGE_DIRS:
        folder = os.path.expanduser(directory)
        try:
            names = sorted(os.listdir(folder), key=natural_sort_key)
        except OSError:
            continue
        for name in names:
            if name.lower().startswith("pcsx2") and name.lower().endswith(".appimage"):
                path = os.path.join(folder, name)
                if os.access(path, os.X_OK):
                    return path
    return None


def parse_ini(text):
    """Sections -> keys, with repeated keys newline-joined.

    PCSX2 writes multi-valued keys as repeated lines — `[GameList]
    RecursivePaths` above all — so assigning would keep only the last folder.
    """
    sections = {"General": {}}
    current = sections["General"]
    for line in (text or "").splitlines():
        line = line.strip()
        if not line or line[0] in ";#":
            continue
        if line.startswith("[") and line.endswith("]"):
            current = sections.setdefault(line[1:-1].strip(), {})
            continue
        key, sep, value = line.partition("=")
        if not sep:
            continue
        key = key.strip()
        value = re.sub(r"\s+[;#].*$", "", value).strip()
        current[key] = value if key not in current else f"{current[key]}\n{value}"
    return sections


def _ini_section(ini, name):
    for key, value in ini.items():
        if key.lower() == name.lower():
            return value
    return {}


def _ini_value(section, *names):
    for key, value in section.items():
        if any(key.lower() == n.lower() for n in names):
            return value
    return None


def _unquote(value):
    bare = (value or "").strip()
    if len(bare) > 1 and bare[0] == bare[-1] == '"':
        bare = bare[1:-1].strip()
    return bare.rstrip("/") if len(bare) > 1 else bare


def _find_ini(root):
    for candidate in (os.path.join(root, "PCSX2.ini"), os.path.join(root, "inis", "PCSX2.ini")):
        if os.path.isfile(candidate):
            return candidate
    return None


def _ini_base_dir(ini_path):
    """`[Folders]` paths resolve against the DATA root, one level above inis/."""
    folder = os.path.dirname(ini_path)
    return os.path.dirname(folder) if os.path.basename(folder).lower() == "inis" else folder


def _pcsx2_paths(root):
    """(game directories, covers directory) as PCSX2.ini configures them."""
    ini_path = _find_ini(root)
    if not ini_path:
        return [], None
    ini = parse_ini(_read_text(ini_path))
    base = _ini_base_dir(ini_path)

    covers = _unquote(_ini_value(_ini_section(ini, "Folders"), "Covers") or "")
    covers_dir = os.path.join(base, covers) if covers and not os.path.isabs(covers) else (covers or None)
    if not covers_dir or not os.path.isdir(covers_dir):
        fallback = os.path.join(base, "covers")
        covers_dir = fallback if os.path.isdir(fallback) else None

    dirs = []
    for key, value in _ini_section(ini, "GameList").items():
        if not re.fullmatch(r"RecursivePaths|Paths|SearchDirectories|GameDirs", key, re.IGNORECASE):
            continue
        for part in re.split(r"[;|\n]", value):
            folder = _unquote(part)
            if not folder:
                continue
            resolved = folder if os.path.isabs(folder) else os.path.join(base, folder)
            if resolved not in dirs:
                dirs.append(resolved)
    # Older layout: [GameDir\0], [GameDir\1], … each with its own Path.
    for name, keys in ini.items():
        if name.startswith("GameDir") and keys.get("Path"):
            folder = _unquote(keys["Path"])
            resolved = folder if os.path.isabs(folder) else os.path.join(base, folder)
            if folder and resolved not in dirs:
                dirs.append(resolved)
    return dirs, covers_dir


def _walk_discs(folder):
    """Every bootable disc image under `folder`, depth- and count-bounded."""
    found, bins, cue_stems = [], [], set()
    root_depth = folder.rstrip(os.sep).count(os.sep)
    for root, subdirs, files in os.walk(folder):
        if root.rstrip(os.sep).count(os.sep) - root_depth >= PS2_SCAN_MAX_DEPTH:
            subdirs[:] = []
        subdirs[:] = sorted((d for d in subdirs if not d.startswith(".")), key=natural_sort_key)
        for name in sorted(files, key=natural_sort_key):
            ext = os.path.splitext(name)[1].lower()
            if ext not in PS2_EXTENSIONS or name.startswith("."):
                continue
            path = os.path.join(root, name)
            if ext == ".bin":
                bins.append(path)
            else:
                if ext == ".cue":
                    cue_stems.add(os.path.splitext(path)[0].lower())
                found.append(path)
        if len(found) + len(bins) >= PS2_SCAN_MAX_FILES:
            break
    found.extend(b for b in bins if os.path.splitext(b)[0].lower() not in cue_stems)
    return found


def _pcsx2_cover(covers_dir, title, serial):
    """PCSX2 names a cover after the game's title or its serial.

    Scaled into the extension's own cache like every other path the shell is given.
    """
    if not covers_dir or not os.path.isdir(covers_dir):
        return None
    wanted = {t.lower() for t in (title, serial) if t}
    try:
        names = sorted(os.listdir(covers_dir), key=natural_sort_key)
    except OSError:
        return None
    for name in names:
        stem, ext = os.path.splitext(name)
        if ext.lower() in IMAGE_EXTENSIONS and stem.lower() in wanted:
            return cache_local_art(os.path.join(covers_dir, name))
    return None


def _clean_disc_title(stem):
    """'Shadow of the Colossus (USA) [SCUS-97472]' -> 'Shadow of the Colossus'."""
    title = re.sub(r"\s*[\(\[][^\)\]]*[\)\]]", " ", stem)
    title = re.sub(r"[._]+", " ", title)
    return re.sub(r"\s{2,}", " ", title).strip() or stem


def scan_pcsx2(config_root=None):
    """Every PS2 disc image in the folders PCSX2 itself is pointed at.

    Empty and silent when PCSX2 is absent, or installed but never launched —
    it writes PCSX2.ini on first run, and until then there is nothing to read.
    """
    executable = pcsx2_executable()
    games, seen = [], set()
    for root in pcsx2_config_roots(config_root):
        game_dirs, covers_dir = _pcsx2_paths(root)
        for folder in game_dirs:
            if not os.path.isdir(folder):
                continue
            for disc in _walk_discs(folder):
                real = os.path.realpath(disc)
                if real in seen:
                    continue
                seen.add(real)
                games.append(_ps2_game(disc, covers_dir, executable))
        if games:
            break
    games.sort(key=lambda g: natural_sort_key(g["title"]))
    return games


def _ps2_game(disc, covers_dir, executable):
    stem = os.path.splitext(os.path.basename(disc))[0]
    match = SERIAL_RE.search(stem)
    serial = match.group(1).upper().replace("_", "-") if match else None
    title = _clean_disc_title(stem)
    # `--` ends PCSX2's own options, so a disc image named like a flag is still
    # read as the file to boot.
    launch = [executable, "-fullscreen", "--", disc] if executable else None
    return {
        "id": f"ps2_{path_key(disc)}",
        "kind": "game",
        "title": title,
        "platform": "ps2",
        "year": None,
        "folder_path": os.path.dirname(disc),
        "launch": launch,
        "poster_path": _pcsx2_cover(covers_dir, title, serial) or _pcsx2_cover(covers_dir, stem, None),
        "backdrop_path": None,
        "summary": None,
        "genres": [],
        "rating": None,
        "playtime_minutes": None,
        "serial": serial,
        "disc_path": disc,
        "disc_format": os.path.splitext(disc)[1].lower().lstrip("."),
        "size_mb": file_size_mb(disc),
    }


# --------------------------------------------------------------------------
# Both together
# --------------------------------------------------------------------------
def scan_games(steam_root=None, pcsx2_root=None):
    """Steam first, then PS2. Either half may be empty; neither may raise."""
    games = []
    for label, scan, root in (("Steam", scan_steam, steam_root), ("PCSX2", scan_pcsx2, pcsx2_root)):
        try:
            found = scan(root)
        except Exception as e:  # a launcher's own files, in whatever state
            print(f"{label} scan failed: {e}")
            continue
        if not found:
            print(f"{label}: nothing found" + (f" under {root}" if root else " (auto-detect)"))
        games.extend(found)
    # Distinct ids even if a title somehow appears on both platforms.
    for game in games:
        game["id"] = slug(game["id"])
    return games
