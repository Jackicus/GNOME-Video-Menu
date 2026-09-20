#!/usr/bin/env python3
"""Index the media library and write the library.json Media Libraries reads.

Each section is scanned only when a folder is given for it, and the result is
merged into the existing library.json so a rescan of one section keeps the
others. A section can have several folders — repeat its flag — and they are
walked in order into one list. Games are the exception: they are not a folder
of media, so `--games` runs that section and the two paths only override
auto-detection.

    python3 scan_library.py --tv-path "~/Videos/TV Shows" --films-path ~/Videos/Films
    python3 scan_library.py --films-path ~/Videos/Films --films-path /media/HDD/Films
    python3 scan_library.py --music-path ~/Music --offline
    python3 scan_library.py --games
    python3 scan_library.py --films-path ~/Videos/Films --source film=tmdb,wikipedia

`--from-settings` fills all of that in from GSettings instead, optionally
narrowed with `--only`, so the Rescan buttons in the preferences and
./scripts/dev.sh both just run this rather than each rebuilding the same
command line:

    python3 scan_library.py --from-settings
    python3 scan_library.py --from-settings --only films

Run standalone for debugging, or from the Rescan buttons in the preferences.
"""

import argparse
import ast
import concurrent.futures
import contextlib
import fcntl
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from games_scanner import scan_games  # noqa: E402
from media_scanner import scan_films, scan_music, scan_photos, scan_tv  # noqa: E402
from metadata import (  # noqa: E402
    CACHE_DIR, PROVIDERS, MetadataService, fit_cached_art, localise_art, make_thumbnailer,
    prune_art, source_id,
)

LIBRARY_VERSION = 2
SECTIONS = ("tv", "films", "music", "photos", "games")

# Enrichment is almost entirely waiting on someone else's server, so it runs on
# a small pool. Small deliberately: every provider here is free, and Wikipedia
# answers bursts with 429 (metadata.py backs off and retries, but the polite
# thing is not to provoke it).
ENRICH_WORKERS = 6

SCHEMA = "org.gnome.shell.extensions.media-libraries"
# The schemas ship beside the backend in the extension directory, so they are
# found from the installed copy as readily as from the repo.
SCHEMA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "schemas")

# The library the extension reads. A run with --out somewhere else writes a
# library of its own, but shares this machine's one artwork cache.
LIBRARY_PATH = os.path.join(CACHE_DIR, "library.json")

# section key -> (GSettings key prefix, XDG user folder when no folder is set).
# TV shows and films have no default: the Videos folder cannot serve both.
SECTION_SETTINGS = {
    "tv": ("tv-shows", None),
    "films": ("films", None),
    "music": ("music", "MUSIC"),
    "photos": ("photos", "PICTURES"),
    "games": ("games", None),
}
# A section is a page in the preferences; a kind is what metadata.py calls the
# items on it. They differ for films and music, so the mapping is written down
# once rather than guessed at either end.
SECTION_KINDS = {"tv": "tv", "films": "film", "music": "album", "games": "game"}
XDG_FALLBACKS = {"MUSIC": "Music", "PICTURES": "Pictures"}


def load_existing(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    if isinstance(data, list):  # version 1: a bare list of TV shows
        return {"tv": data}
    return data.get("sections", {}) if isinstance(data, dict) else {}


@contextlib.contextmanager
def library_lock(out):
    """Hold the library against concurrent scans.

    Every scan reads the whole library.json, replaces the sections it was asked
    for and writes all of them back. Two running at once would each write the
    other's sections as they were before either started, so the one that
    finished last would silently undo the other — easily done from the
    preferences, which offer a Rescan button per section and one for the lot.
    """
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    with open(f"{out}.lock", "w", encoding="utf-8") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            print("Another scan is already running; waiting for it to finish...")
            fcntl.flock(handle, fcntl.LOCK_EX)
        yield


# --------------------------------------------------------------------------
# Reading the preferences
# --------------------------------------------------------------------------
def _setting(key):
    """One GSettings value as a plain string, or None if it cannot be read."""
    argv = ["gsettings"]
    if os.path.exists(os.path.join(SCHEMA_DIR, "gschemas.compiled")):
        argv += ["--schemadir", SCHEMA_DIR]
    argv += ["get", SCHEMA, key]
    try:
        out = subprocess.run(argv, capture_output=True, text=True, timeout=10, check=True).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    return out[1:-1] if len(out) >= 2 and out[0] == out[-1] == "'" else out


def _setting_value(key):
    """One GSettings value as a Python object, for the keys that are not plain
    strings — `credentials` (a{ss}) and each section's source list (as).

    gsettings prints GVariants in a syntax that is also valid Python literal
    syntax, optionally behind an `@type` prefix for an empty container, so
    ast.literal_eval reads them without pulling gi into the backend. It only
    ever evaluates literals, so a credential holding anything at all is still
    only ever data.
    """
    raw = _setting(key)
    if raw is None:
        return None
    if raw.startswith("@"):
        raw = raw.split(" ", 1)[1] if " " in raw else ""
    try:
        return ast.literal_eval(raw)
    except (ValueError, SyntaxError):
        return None


def xdg_dir(name):
    """An XDG user folder, read from the file GLib and xdg-user-dir both read,
    so the backend needs no bindings of its own to agree with them."""
    config = os.path.join(
        os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "user-dirs.dirs")
    try:
        with open(config, "r", encoding="utf-8") as f:
            for line in f:
                key, _, value = line.partition("=")
                if key.strip() == f"XDG_{name}_DIR":
                    return os.path.expanduser(value.strip().strip('"').replace("$HOME", "~"))
    except OSError:
        pass
    return os.path.expanduser(f"~/{XDG_FALLBACKS[name]}")


def section_folders(prefix, xdg):
    """The folders a section is pointed at, in order, as the preferences see them.

    <prefix>-folders is the list; <prefix>-path is the single folder earlier
    releases kept and is read only while the list is empty, exactly as the
    preferences read it before moving it over. With neither, the XDG folder for
    the sections that have one.
    """
    listed = _setting_value(f"{prefix}-folders")
    folders = [str(f) for f in listed if str(f)] if isinstance(listed, list) else []
    if not folders:
        legacy = _setting(f"{prefix}-path")
        if legacy:
            folders = [legacy]
    if not folders and xdg:
        folders = [xdg_dir(xdg)]
    return folders


def apply_settings(args, parser):
    """Fill the command line in from the preferences.

    This is the only place that knows how a setting becomes a scanner flag, so
    the preferences and dev.sh cannot drift from it or from each other.
    """
    if _setting("library-opens-in") is None:
        parser.error(
            "--from-settings could not read the Media Libraries settings. Compile the "
            f"schemas ({SCHEMA_DIR}) or pass the folders explicitly.")

    only = set(args.only or SECTION_SETTINGS)
    for key, (prefix, xdg) in SECTION_SETTINGS.items():
        if key not in only or _setting(f"{prefix}-enabled") != "true":
            continue
        if key == "games":
            args.games = True
            # The two roots are auto-detected; a setting only overrides that.
            args.steam_path = args.steam_path or _setting("steam-path") or ""
            args.pcsx2_path = args.pcsx2_path or _setting("pcsx2-path") or ""
            continue
        folders = section_folders(prefix, xdg)
        if folders:
            setattr(args, f"{key}_path", folders)
        else:
            print(f"{key}: no folder set, skipping")

    # Sources, the switch that gates them and the keys they need are all per
    # section now, so they are read per section too. A section left out of
    # --only keeps whatever its items already had cached; it is not scanned.
    for key in only:
        prefix = SECTION_SETTINGS[key][0]
        kind = SECTION_KINDS.get(key)
        if kind is None:   # photos never go online
            continue
        if kind not in args.sources:
            listed = _setting_value(f"{prefix}-sources")
            if isinstance(listed, list):
                args.sources[kind] = [str(e) for e in listed]
        if _setting(f"{prefix}-online") == "false":
            args.offline_kinds.add(kind)

    # Read here rather than taken from the environment, so the preferences and
    # dev.sh both just run the scanner and neither has to hand it a key.
    credentials = _setting_value("credentials")
    if isinstance(credentials, dict):
        args.credentials = {str(k): str(v) for k, v in credentials.items()}


# --------------------------------------------------------------------------
# Scanning
# --------------------------------------------------------------------------
def enrich_all(meta, items):
    """Fill in metadata and artwork for `items`, several at a time.

    A section that is not going online has nothing to wait for — it only reads
    the cache — so it is done in line rather than on the pool.
    """
    def one(item):
        try:
            meta.enrich(item)
        except Exception as e:  # one bad item must never abort the scan
            print(f"Metadata failed for '{item.get('title')}': {e}")

    if len(items) < 2 or not meta.online_for(items[0]["kind"]):
        for item in items:
            one(item)
        return
    with concurrent.futures.ThreadPoolExecutor(max_workers=ENRICH_WORKERS) as pool:
        list(pool.map(one, items))


def unique_ids(items):
    """Make every id in `items` distinct, in place.

    A section walked from several folders can hold the same name twice — a
    show kept on two drives — and the id is the slug of the name. The second
    one gets a numbered suffix; a reused entry is never confused with it, since
    the folder is part of the signature the reuse is checked against.
    """
    seen = set()
    for item in items:
        base = item["id"]
        candidate, n = base, 1
        while candidate in seen:
            n += 1
            candidate = f"{base}~{n}"
        item["id"] = candidate
        seen.add(candidate)
    return items


def unchanged(items, previous):
    """How many items came back straight out of the previous scan."""
    return sum(
        1 for item in items
        if item.get("scan_sig") and previous.get(item["id"], {}).get("scan_sig") == item["scan_sig"]
    )


def main():
    parser = argparse.ArgumentParser(description="Scan media folders and cache metadata.")
    parser.add_argument("--tv-path", action="append", metavar="FOLDER",
                        help="A TV shows folder (repeatable)")
    parser.add_argument("--films-path", action="append", metavar="FOLDER",
                        help="A films folder (repeatable)")
    parser.add_argument("--music-path", action="append", metavar="FOLDER",
                        help="A music folder (repeatable)")
    parser.add_argument("--photos-path", action="append", metavar="FOLDER",
                        help="A photos folder (repeatable)")
    parser.add_argument("--games", action="store_true", help="Index installed Steam and PS2 games")
    parser.add_argument("--steam-path", default="", help="Steam library root (empty: auto-detect)")
    parser.add_argument("--pcsx2-path", default="", help="PCSX2 config folder (empty: auto-detect)")
    parser.add_argument("--source", action="append", default=[], metavar="KIND=A,B",
                        help="Sources for one kind, in the order they are tried "
                             "(tv, film, album, game). Repeatable. Keys come from "
                             "the preferences or the environment, never from here.")
    parser.add_argument("--offline", action="store_true", help="Skip online metadata and artwork")
    parser.add_argument("--from-settings", action="store_true",
                        help="Take the folders, sources, keys and online switches from the preferences")
    parser.add_argument("--only", action="append", choices=SECTIONS, metavar="SECTION",
                        help="With --from-settings, scan just this section (repeatable)")
    parser.add_argument("--force", action="store_true",
                        help="Re-read every folder instead of reusing the entries of unchanged ones")
    parser.add_argument("--out", default=LIBRARY_PATH)
    args = parser.parse_args()

    # Filled either from --source or, below, from the preferences.
    args.sources = {}
    args.offline_kinds = set()
    args.credentials = {}
    for spec in args.source:
        kind, _, listed = spec.partition("=")
        kind = kind.strip()
        if kind not in PROVIDERS:
            parser.error(f"--source: unknown kind '{kind}'; expected one of {', '.join(PROVIDERS)}")
        entries = [e.strip() for e in listed.split(",") if e.strip()]
        unknown = [e for e in entries if source_id(e) not in PROVIDERS[kind]]
        if unknown:
            parser.error(f"--source {kind}: {', '.join(unknown)} cannot answer for {kind}")
        args.sources[kind] = entries

    if args.from_settings:
        apply_settings(args, parser)
    elif args.only:
        parser.error("--only is only meaningful with --from-settings")

    requested = {
        "tv": args.tv_path or [],
        "films": args.films_path or [],
        "music": args.music_path or [],
        "photos": args.photos_path or [],
    }
    # Games have no media folder to point at, so the flag alone runs them —
    # and naming either root implies it.
    do_games = args.games or bool(args.steam_path or args.pcsx2_path)
    if not any(requested.values()) and not do_games:
        if args.from_settings:
            parser.error(
                "nothing to scan: no section is both switched on and pointed at "
                "a folder. Set one in the preferences.")
        parser.error(
            "give at least one of --tv-path, --films-path, --music-path, "
            "--photos-path, --games, --from-settings")

    # Keys come from the preferences, or from the environment
    # (MEDIA_LIBRARIES_TMDB_KEY, MEDIA_LIBRARIES_IGDB_*) for a standalone run. Never argv.
    meta = MetadataService(
        online=not args.offline,
        sources=args.sources,
        credentials=args.credentials,
        offline_kinds=args.offline_kinds,
    )

    with library_lock(args.out):
        # Every artwork path the shell is given has to be a file in the cache,
        # no larger than the desktop draws it; these three keep that true for
        # what earlier releases left behind as well as for what is scanned now.
        fitted = fit_cached_art()
        sections = load_existing(args.out)
        scanned = {}

        def previous_items(key):
            if args.force:
                return {}
            return {
                item["id"]: item for item in sections.get(key) or []
                if isinstance(item, dict) and item.get("id")
            }

        tv_folders = [os.path.expanduser(p) for p in requested["tv"]]
        for key, raw_folders in requested.items():
            if not raw_folders:
                continue
            t0 = time.time()
            previous = previous_items(key)
            items = []
            missing = []
            for raw in raw_folders:
                path = os.path.expanduser(raw)
                if not os.path.isdir(path):
                    print(f"{key}: {path} is not a folder, skipping it")
                    missing.append(path)
                    continue
                if key == "tv":
                    found = scan_tv(path, previous)
                elif key == "films":
                    found = scan_films(path, exclude=tv_folders, previous=previous)
                elif key == "music":
                    found = scan_music(path, previous)
                else:
                    found = scan_photos(path, make_thumbnailer(), previous)
                items.extend(found)
            unique_ids(items)

            if key in ("tv", "films", "music"):
                enrich_all(meta, items)

            sections[key] = items
            paths = [os.path.expanduser(p) for p in raw_folders]
            scanned[key] = {"paths": paths, "count": len(items)}
            if missing:
                scanned[key]["missing"] = missing
            reused = unchanged(items, previous)
            note = f", {reused} unchanged" if reused else ""
            print(f"{key}: {len(items)} items from {', '.join(paths)} ({time.time() - t0:.1f}s{note})")

        if do_games:
            t0 = time.time()
            games = scan_games(
                steam_root=os.path.expanduser(args.steam_path) or None,
                pcsx2_root=os.path.expanduser(args.pcsx2_path) or None,
            )
            enrich_all(meta, games)
            sections["games"] = games
            scanned["games"] = {
                "path": args.steam_path or "auto",
                "count": len(games),
                "steam": sum(1 for g in games if g.get("platform") == "steam"),
                "ps2": sum(1 for g in games if g.get("platform") == "ps2"),
            }
            print(f"games: {len(games)} items ({time.time() - t0:.1f}s)")

        meta.flush()
        moved = localise_art(sections)
        library = {
            "version": LIBRARY_VERSION,
            "generated": time.time(),
            "sections": {k: sections.get(k, []) for k in SECTIONS},
            "scanned": scanned,
        }
        tmp = f"{args.out}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(library, f, indent=1)
        os.replace(tmp, args.out)  # atomic: the shell's file monitor never sees a half-written file
        print(f"Wrote {args.out}")
        # Pruned after the write and against every section at once: what the
        # merged library points at is exactly what is worth keeping. Only for
        # the real library, though — a run written elsewhere was merged onto
        # that file's sections, not these, so pruning against it would delete
        # the artwork the extension is still pointing at.
        dropped = 0
        if os.path.abspath(args.out) == os.path.abspath(LIBRARY_PATH):
            dropped = prune_art(library["sections"])
        if fitted or moved or dropped:
            print(f"Artwork cache: {fitted} scaled down, {moved} copied in, {dropped} removed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
