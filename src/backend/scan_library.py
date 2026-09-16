#!/usr/bin/env python3
"""Index the media library and write the library.json Gnomeflix reads.

Each section is scanned only when its path is given, and the result is merged
into the existing library.json so a rescan of one section keeps the others.
Games are the exception: they are not a folder of media, so `--games` runs that
section and the two paths only override auto-detection.

    python3 scan_library.py --tv-path "~/Videos/TV Shows" --films-path ~/Videos/Films
    python3 scan_library.py --music-path ~/Music --offline
    python3 scan_library.py --games

Run standalone for debugging, or from the Rescan buttons in the preferences.
"""

import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from games_scanner import scan_games  # noqa: E402
from media_scanner import scan_documents, scan_films, scan_music, scan_photos, scan_tv  # noqa: E402
from metadata import CACHE_DIR, MetadataService, make_thumbnailer  # noqa: E402

LIBRARY_VERSION = 2
SECTIONS = ("tv", "films", "music", "photos", "documents", "games")


def load_existing(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    if isinstance(data, list):  # version 1: a bare list of TV shows
        return {"tv": data}
    return data.get("sections", {}) if isinstance(data, dict) else {}


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
    parser.add_argument("--out", default=os.path.join(CACHE_DIR, "library.json"))
    args = parser.parse_args()

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
        parser.error(
            "give at least one of --tv-path, --films-path, --music-path, "
            "--photos-path, --documents-path, --games")

    # Keys come from the environment (GNOMEFLIX_TMDB_KEY, GNOMEFLIX_IGDB_*), never argv.
    meta = MetadataService(
        online=not args.offline,
        providers={"tv": args.tv_provider, "film": args.films_provider},
    )
    sections = load_existing(args.out)
    scanned = {}

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
        if key == "tv":
            items = scan_tv(path)
        elif key == "films":
            items = scan_films(path, exclude=[os.path.expanduser(args.tv_path or "")])
        elif key == "music":
            items = scan_music(path)
        elif key == "photos":
            items = scan_photos(path, make_thumbnailer())
        else:
            items = scan_documents(path)

        if key in ("tv", "films", "music"):
            for item in items:
                meta.enrich(item)

        sections[key] = items
        scanned[key] = {"path": path, "count": len(items)}
        print(f"{key}: {len(items)} items from {path} ({time.time() - t0:.1f}s)")

    if do_games:
        t0 = time.time()
        games = scan_games(
            steam_root=os.path.expanduser(args.steam_path) or None,
            pcsx2_root=os.path.expanduser(args.pcsx2_path) or None,
        )
        for game in games:
            meta.enrich(game)
        sections["games"] = games
        scanned["games"] = {
            "path": args.steam_path or "auto",
            "count": len(games),
            "steam": sum(1 for g in games if g.get("platform") == "steam"),
            "ps2": sum(1 for g in games if g.get("platform") == "ps2"),
        }
        print(f"games: {len(games)} items ({time.time() - t0:.1f}s)")

    library = {
        "version": LIBRARY_VERSION,
        "generated": time.time(),
        "sections": {k: sections.get(k, []) for k in SECTIONS},
        "scanned": scanned,
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    tmp = f"{args.out}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(library, f, indent=1)
    os.replace(tmp, args.out)  # atomic: the shell's file monitor never sees a half-written file
    print(f"Wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
