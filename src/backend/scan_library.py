#!/usr/bin/env python3
"""Index the media library and write the library.json Gnomeflix reads.

Each section is scanned only when its path is given, and the result is merged
into the existing library.json so a rescan of one section keeps the others.
Games are the exception: they are not a folder of media, so `--games` runs that
section and the two paths only override auto-detection.

    python3 scan_library.py --tv-path "~/Videos/TV Shows" --films-path ~/Videos/Films
    python3 scan_library.py --music-path ~/Music --offline
    python3 scan_library.py --games

`--from-settings` fills all of that in from GSettings instead, optionally
narrowed with `--only`, so the Rescan buttons in the preferences and
./scripts/dev.sh both just run this rather than each rebuilding the same
command line:

    python3 scan_library.py --from-settings
    python3 scan_library.py --from-settings --only films

Run standalone for debugging, or from the Rescan buttons in the preferences.
"""

import argparse
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
from media_scanner import scan_documents, scan_films, scan_music, scan_photos, scan_tv  # noqa: E402
from metadata import (  # noqa: E402
    CACHE_DIR, MetadataService, fit_cached_art, localise_art, make_thumbnailer, prune_art,
)

LIBRARY_VERSION = 2
SECTIONS = ("tv", "films", "music", "photos", "documents", "games")

# Enrichment is almost entirely waiting on someone else's server, so it runs on
# a small pool. Small deliberately: every provider here is free, and Wikipedia
# answers bursts with 429 (metadata.py backs off and retries, but the polite
# thing is not to provoke it).
ENRICH_WORKERS = 6

SCHEMA = "org.gnome.shell.extensions.gnomeflix"
# The schemas ship beside the backend in the extension directory, so they are
# found from the installed copy as readily as from the repo.
SCHEMA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "schemas")

# section key -> (GSettings key prefix, XDG user folder when the path is unset).
# TV shows and films have no default: the Videos folder cannot serve both.
SECTION_SETTINGS = {
    "tv": ("tv-shows", None),
    "films": ("films", None),
    "music": ("music", "MUSIC"),
    "photos": ("photos", "PICTURES"),
    "documents": ("documents", "DOCUMENTS"),
    "games": ("games", None),
}
XDG_FALLBACKS = {"MUSIC": "Music", "PICTURES": "Pictures", "DOCUMENTS": "Documents"}


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


def apply_settings(args, parser):
    """Fill the command line in from the preferences.

    This is the only place that knows how a setting becomes a scanner flag, so
    the preferences and dev.sh cannot drift from it or from each other.
    """
    if _setting("online-metadata") is None:
        parser.error(
            "--from-settings could not read the Gnomeflix settings. Compile the "
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
        path = _setting(f"{prefix}-path") or (xdg_dir(xdg) if xdg else "")
        if path:
            setattr(args, f"{key}_path", path)
        else:
            print(f"{key}: no folder set, skipping")

    if _setting("online-metadata") == "false":
        args.offline = True
    args.tv_provider = args.tv_provider or _setting("tv-shows-provider")
    args.films_provider = args.films_provider or _setting("films-provider")


# --------------------------------------------------------------------------
# Scanning
# --------------------------------------------------------------------------
def enrich_all(meta, items):
    """Fill in metadata and artwork for `items`, several at a time."""
    def one(item):
        try:
            meta.enrich(item)
        except Exception as e:  # one bad item must never abort the scan
            print(f"Metadata failed for '{item.get('title')}': {e}")

    if len(items) < 2 or not meta.online:
        for item in items:
            one(item)
        return
    with concurrent.futures.ThreadPoolExecutor(max_workers=ENRICH_WORKERS) as pool:
        list(pool.map(one, items))


def unchanged(items, previous):
    """How many items came back straight out of the previous scan."""
    return sum(
        1 for item in items
        if item.get("scan_sig") and previous.get(item["id"], {}).get("scan_sig") == item["scan_sig"]
    )


def main():
    parser = argparse.ArgumentParser(description="Scan media folders and cache metadata.")
    parser.add_argument("--tv-path", help="TV shows folder")
    parser.add_argument("--films-path", help="Films folder")
    parser.add_argument("--music-path", help="Music folder")
    parser.add_argument("--photos-path", help="Photos folder")
    parser.add_argument("--documents-path", help="Documents folder")
    parser.add_argument("--games", action="store_true", help="Index installed Steam and PS2 games")
    parser.add_argument("--steam-path", default="", help="Steam library root (empty: auto-detect)")
    parser.add_argument("--pcsx2-path", default="", help="PCSX2 config folder (empty: auto-detect)")
    parser.add_argument("--tv-provider", choices=("tvmaze", "tmdb", "wikipedia"), help="Where TV metadata comes from")
    parser.add_argument("--films-provider", choices=("tmdb", "wikipedia"), help="Where film metadata comes from")
    parser.add_argument("--offline", action="store_true", help="Skip online metadata and artwork")
    parser.add_argument("--from-settings", action="store_true",
                        help="Take the folders, providers and online setting from the preferences")
    parser.add_argument("--only", action="append", choices=SECTIONS, metavar="SECTION",
                        help="With --from-settings, scan just this section (repeatable)")
    parser.add_argument("--force", action="store_true",
                        help="Re-read every folder instead of reusing the entries of unchanged ones")
    parser.add_argument("--out", default=os.path.join(CACHE_DIR, "library.json"))
    args = parser.parse_args()

    if args.from_settings:
        apply_settings(args, parser)
    elif args.only:
        parser.error("--only is only meaningful with --from-settings")

    requested = {
        "tv": args.tv_path,
        "films": args.films_path,
        "music": args.music_path,
        "photos": args.photos_path,
        "documents": args.documents_path,
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
            "--photos-path, --documents-path, --games, --from-settings")

    # Keys come from the environment (GNOMEFLIX_TMDB_KEY, GNOMEFLIX_IGDB_*), never argv.
    meta = MetadataService(
        online=not args.offline,
        providers={"tv": args.tv_provider, "film": args.films_provider},
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

        for key, raw in requested.items():
            if not raw:
                continue
            path = os.path.expanduser(raw)
            if not os.path.isdir(path):
                print(f"{key}: {path} is not a folder, leaving section empty")
                sections[key] = []
                scanned[key] = {"path": path, "count": 0, "error": "missing"}
                continue

            t0 = time.time()
            previous = previous_items(key)
            if key == "tv":
                items = scan_tv(path, previous)
            elif key == "films":
                items = scan_films(path, exclude=[os.path.expanduser(args.tv_path or "")], previous=previous)
            elif key == "music":
                items = scan_music(path, previous)
            elif key == "photos":
                items = scan_photos(path, make_thumbnailer(), previous)
            else:
                items = scan_documents(path, previous)

            if key in ("tv", "films", "music"):
                enrich_all(meta, items)

            sections[key] = items
            scanned[key] = {"path": path, "count": len(items)}
            reused = unchanged(items, previous)
            note = f", {reused} unchanged" if reused else ""
            print(f"{key}: {len(items)} items from {path} ({time.time() - t0:.1f}s{note})")

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
        # merged library points at is exactly what is worth keeping.
        dropped = prune_art(library["sections"])
        if fitted or moved or dropped:
            print(f"Artwork cache: {fitted} scaled down, {moved} copied in, {dropped} removed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
