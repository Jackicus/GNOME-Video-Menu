#!/usr/bin/env python3
"""Index the media library and write the cached library.json Gnomeflix reads.

Run standalone for debugging, or via the "Rescan Library Now" button in prefs:

    python3 src/backend/scan_library.py --tv-path "/media/LENOVO/Videos/TV Shows"
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from media_scanner import MediaScanner
from metadata import CACHE_DIR, MetadataService


def main():
    parser = argparse.ArgumentParser(description="Scan media directories and cache metadata.")
    parser.add_argument("--tv-path", default=None, help="TV shows directory to index")
    parser.add_argument(
        "--out",
        default=os.path.join(CACHE_DIR, "library.json"),
        help="Where to write the library index",
    )
    args = parser.parse_args()

    scanner = MediaScanner(args.tv_path)
    shows = scanner.scan_shows()
    print(f"Found {len(shows)} shows in {scanner.media_path or '<no media path>'}")

    meta = MetadataService()
    for show in shows:
        meta._fetch_show_worker(show)

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(shows, f, indent=2)

    print(f"Wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
