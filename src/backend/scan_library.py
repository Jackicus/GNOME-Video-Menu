#!/usr/bin/env python3
"""Index the media library and write the library.json Media Libraries reads.

Each section is scanned only when a folder is given for it, and the result is
merged into the existing library.json so a rescan of one section keeps the
other. A section can have several folders — repeat its flag — and they are
walked in order into one list.

    python3 scan_library.py --tv-path "~/Videos/TV Shows" --films-path ~/Videos/Films
    python3 scan_library.py --films-path ~/Videos/Films --films-path /media/HDD/Films
    python3 scan_library.py --films-path ~/Videos/Films --offline
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

from media_scanner import scan_films, scan_tv  # noqa: E402
from metadata import (  # noqa: E402
    CACHE_DIR, PROVIDERS, MetadataService, fit_cached_art, localise_art, prune_art, source_id,
)

LIBRARY_VERSION = 2
SECTIONS = ("tv", "films")

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

# section key -> GSettings key prefix. Neither section has a default folder —
# the Videos folder cannot serve both — so both are off until pointed at one.
SECTION_SETTINGS = {"tv": "tv-shows", "films": "films"}
# A section is a page in the preferences; a kind is what metadata.py calls the
# items on it. They differ for films, so the mapping is written down once
# rather than guessed at either end.
SECTION_KINDS = {"tv": "tv", "films": "film"}


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
_settings_cache = None


def _settings():
    """Every key of the schema as gsettings prints it, read in one go rather
    than a process per key; None if they cannot be read at all."""
    global _settings_cache
    if _settings_cache is None:
        argv = ["gsettings"]
        if os.path.exists(os.path.join(SCHEMA_DIR, "gschemas.compiled")):
            argv += ["--schemadir", SCHEMA_DIR]
        argv += ["list-recursively", SCHEMA]
        try:
            out = subprocess.run(argv, capture_output=True, text=True, timeout=10, check=True).stdout
        except (OSError, subprocess.SubprocessError):
            return None
        _settings_cache = {}
        for line in out.splitlines():
            parts = line.split(" ", 2)
            if len(parts) == 3 and parts[0] == SCHEMA:
                _settings_cache[parts[1]] = parts[2].strip()
    return _settings_cache


def _setting_value(key):
    """One GSettings value as a Python object: a string, a bool, or for
    `credentials` (a{ss}) and each section's source list (as) a container.

    gsettings prints GVariants in a syntax that is also valid Python literal
    syntax — strings in either kind of quote with backslash escapes, so a
    folder called "Jack's Films" reads back as written — optionally behind an
    `@type` prefix for an empty container, and `true`/`false` for a bool. So
    ast.literal_eval reads them without pulling gi into the backend. It only
    ever evaluates literals, so a credential holding anything at all is still
    only ever data.
    """
    values = _settings()
    raw = values.get(key) if values is not None else None
    if raw is None:
        return None
    if raw.startswith("@"):
        raw = raw.split(" ", 1)[1] if " " in raw else ""
    if raw in ("true", "false"):
        return raw == "true"
    try:
        return ast.literal_eval(raw)
    except (ValueError, SyntaxError):
        return None


def _setting(key):
    """One GSettings value as a plain string, or None if it cannot be read."""
    value = _setting_value(key)
    return value if isinstance(value, str) else None


def section_folders(prefix):
    """The folders a section is pointed at, in order, as the preferences see them.

    <prefix>-folders is the list; <prefix>-path is the single folder earlier
    releases kept and is read only while the list is empty, exactly as the
    preferences read it before moving it over.
    """
    listed = _setting_value(f"{prefix}-folders")
    folders = [str(f) for f in listed if str(f)] if isinstance(listed, list) else []
    if not folders:
        legacy = _setting(f"{prefix}-path")
        if legacy:
            folders = [legacy]
    return folders


def apply_settings(args, parser):
    """Fill the command line in from the preferences.

    This is the only place that knows how a setting becomes a scanner flag, so
    the preferences and dev.sh cannot drift from it or from each other.
    """
    if _setting("library-opens-in") is None:
        parser.error(
            "--from-settings could not read the Video Menu settings. Compile the "
            f"schemas ({SCHEMA_DIR}) or pass the folders explicitly.")

    only = set(args.only or SECTION_SETTINGS)
    for key, prefix in SECTION_SETTINGS.items():
        folders = section_folders(prefix)
        # Every section's folders are kept out of the other's walk whether
        # or not it is being scanned now: a TV folder inside the films folder
        # was read as one film with every episode as a file when the Films
        # page's own Rescan, which scans films alone, ran.
        args.exclude[key] = folders
        if key not in only or _setting_value(f"{prefix}-enabled") is not True:
            continue
        # An empty list, not nothing: a section switched on and pointed at
        # no folder is written out empty, so removing a section's last
        # folder takes its items off the desktop at the next scan.
        setattr(args, f"{key}_path", folders)
        if not folders:
            print(f"{key}: no folder set, clearing it")

    # Sources, the switch that gates them and the keys they need are all per
    # section now, so they are read per section too. A section left out of
    # --only keeps whatever its items already had cached; it is not scanned.
    for key in only:
        prefix = SECTION_SETTINGS[key]
        kind = SECTION_KINDS[key]
        if kind not in args.sources:
            listed = _setting_value(f"{prefix}-sources")
            if isinstance(listed, list):
                args.sources[kind] = [str(e) for e in listed]
        if _setting_value(f"{prefix}-online") is False:
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
    parser.add_argument("--source", action="append", default=[], metavar="KIND=A,B",
                        help="Sources for one kind, in the order they are tried "
                             "(tv, film). Repeatable. Keys come from "
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
    # A name the filesystem could not decode is printed escaped rather than
    # aborting the scan from inside a worker.
    sys.stdout.reconfigure(errors="backslashreplace")

    # Filled either from --source or, below, from the preferences.
    args.sources = {}
    args.offline_kinds = set()
    args.credentials = {}
    # section -> its folders, kept out of the other section's walk.
    args.exclude = {}
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

    # A section's folders, expanded once; None for a section this run leaves
    # as it is, [] for one it clears.
    def expand(folders):
        return None if folders is None else [os.path.expanduser(p) for p in folders]

    requested = {"tv": expand(args.tv_path), "films": expand(args.films_path)}
    if all(v is None for v in requested.values()):
        if args.from_settings:
            parser.error(
                "nothing to scan: no section is switched on. Set one in the preferences.")
        parser.error("give at least one of --tv-path, --films-path, --from-settings")
    exclude = {key: expand(folders) or [] for key, folders in args.exclude.items()}
    for key, folders in requested.items():
        if folders:
            exclude[key] = list(dict.fromkeys(exclude.get(key, []) + folders))

    with library_lock(args.out):
        # Under the lock, since it reads the record index another scan may be
        # writing: loaded before, a flush of this run's copy would put the
        # records that scan added back as they were.
        #
        # Keys come from the preferences, or from the environment
        # (MEDIA_LIBRARIES_TMDB_KEY) for a standalone run. Never argv.
        meta = MetadataService(
            online=not args.offline,
            sources=args.sources,
            credentials=args.credentials,
            offline_kinds=args.offline_kinds,
        )
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

        for key, paths in requested.items():
            if paths is None:
                continue
            t0 = time.time()
            previous = previous_items(key)
            items = []
            missing = []
            for path in paths:
                if not os.path.isdir(path):
                    print(f"{key}: {path} is not a folder, skipping it")
                    missing.append(path)
                    continue
                if key == "tv":
                    found = scan_tv(path, previous, exclude=exclude.get("films", ()))
                else:
                    found = scan_films(path, exclude=exclude.get("tv", ()), previous=previous)
                items.extend(found)
            scanned[key] = {"paths": paths, "count": len(items)}
            if missing:
                scanned[key]["missing"] = missing
            # Every folder out of reach — a share that is offline, a drive
            # not plugged in — is not an empty library: what the last scan
            # found is kept, and the artwork it names with it, rather than
            # written out empty and pruned, to be fetched all over again
            # when the share comes back.
            if paths and len(missing) == len(paths) and sections.get(key):
                print(f"{key}: none of its folders can be reached; keeping the last scan")
                scanned[key]["count"] = len(sections[key])
                continue
            unique_ids(items)
            enrich_all(meta, items)

            sections[key] = items
            scanned[key]["count"] = len(items)
            reused = unchanged(items, previous)
            note = f", {reused} unchanged" if reused else ""
            where = ", ".join(paths) or "no folder"
            print(f"{key}: {len(items)} items from {where} ({time.time() - t0:.1f}s{note})")

        meta.flush()
        moved = localise_art(sections)
        library = {
            "version": LIBRARY_VERSION,
            "generated": time.time(),
            # Only what this run knows about: a section this scanner no longer
            # has (music, photos, games, from an install that had them) is
            # dropped here rather than carried forward from the old file.
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
