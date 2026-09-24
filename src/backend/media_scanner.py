"""Walk media folders and turn them into plain dicts for library.json.

One scanner per section. They know nothing about the network; metadata.py
enriches what they return.

Every scanner takes the section's previous items keyed by id. Walking a folder
and stat'ing each file in it is the bulk of a rescan, and almost nothing has
changed between one scan and the next, so an item whose folder still carries
the signature recorded last time reuses the file list it already had. The
metadata fields are always rebuilt from scratch, so switching provider still
refetches everything.
"""

import hashlib
import os
import re

from metadata import cache_local_art

VIDEO_EXTENSIONS = {".mp4", ".mkv", ".avi", ".webm", ".m4v", ".mov", ".wmv"}
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".avif", ".tiff", ".bmp"}
SUBTITLE_EXTENSIONS = {".srt", ".vtt", ".ass", ".ssa", ".sub"}
COVER_NAMES = ("cover", "folder", "front", "album", "poster", "artwork")

YEAR_RE = re.compile(r"\s*[\(\[](\d{4})[\)\]]\s*$")


def natural_sort_key(s):
    return [int(text) if text.isdigit() else text.lower() for text in re.split(r"(\d+)", s)]


def slug(name):
    return re.sub(r"[^a-zA-Z0-9]", "_", name.lower())


def split_year(name):
    """'Doctor Strange (2016)' -> ('Doctor Strange', 2016)."""
    m = YEAR_RE.search(name)
    if not m:
        return name.strip(), None
    return name[: m.start()].strip(), int(m.group(1))


def file_size_mb(path):
    try:
        return round(os.path.getsize(path) / (1024 * 1024), 1)
    except OSError:
        return 0


def subdirs(path):
    try:
        names = sorted(os.listdir(path), key=natural_sort_key)
    except OSError as e:
        print(f"Cannot read {path}: {e}")
        return []
    return [n for n in names if not n.startswith(".") and os.path.isdir(os.path.join(path, n))]


def files_with_ext(path, extensions):
    try:
        names = sorted(os.listdir(path), key=natural_sort_key)
    except OSError:
        return []
    return [
        n for n in names
        if not n.startswith(".") and os.path.splitext(n)[1].lower() in extensions
        and os.path.isfile(os.path.join(path, n))
    ]


def folder_signature(folder, recursive=True):
    """A string that changes when what is in `folder` changes.

    A directory's mtime moves whenever a name is added, removed or renamed
    inside it, so the newest mtime across the folder (and, recursively, its
    subfolders) stands in for "something appeared or went away in here". The
    one edit it cannot see is a file rewritten in place under the same name,
    which leaves a stale size behind until `--force` re-reads everything.

    The folder's own path is part of it. What is reused on a match is the file
    list, and every entry in it is an absolute path — so a tree that moved
    unchanged (a drive renamed, a share remounted somewhere else) has to read
    as changed, or every file in it is looked for where it used to be.
    """
    newest = 0.0
    seen = 0
    for root, dirs, _files in os.walk(folder):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        seen += 1
        try:
            newest = max(newest, os.path.getmtime(root))
        except OSError:
            pass
        if not recursive:
            break
    return f"{seen}:{newest:.3f}:{folder}"


def reusable(previous, item_id, signature, field):
    """The cached `field` of a previous item whose folder has not changed."""
    if not previous or not signature:
        return None
    entry = previous.get(item_id)
    if not entry or entry.get("scan_sig") != signature:
        return None
    return entry.get(field)


def find_local_cover(folder):
    """A cover image kept beside the media (cover.jpg, folder.png, ...).

    What comes back is the scaled copy in the artwork cache, not the file in the
    media folder: the shell reads artwork on the compositor thread and must
    never be sent into a media folder to do it.
    """
    for name in files_with_ext(folder, IMAGE_EXTENSIONS):
        stem = os.path.splitext(name)[0].lower()
        if stem in COVER_NAMES or stem.startswith(COVER_NAMES):
            return cache_local_art(os.path.join(folder, name))
    return None


def _video_entries(folder):
    """Every video under folder (recursively), with subtitle and size info."""
    entries = []
    for root, dirs, files in os.walk(folder):
        dirs[:] = sorted(d for d in dirs if not d.startswith("."))
        sub_stems = {
            os.path.splitext(f)[0].lower()
            for f in files
            if os.path.splitext(f)[1].lower() in SUBTITLE_EXTENSIONS
        }
        rel_dir = os.path.relpath(root, folder)
        for fname in files:
            ext = os.path.splitext(fname)[1].lower()
            if ext not in VIDEO_EXTENSIONS:
                continue
            fpath = os.path.join(root, fname)
            stem = os.path.splitext(fname)[0]
            stem_l = stem.lower()
            has_sub = stem_l in sub_stems or any(
                s.startswith(stem_l) or stem_l.startswith(s.split(".")[0]) for s in sub_stems
            )
            entries.append({
                "filename": fname,
                "path": fpath,
                "title": stem,
                "group": None if rel_dir == "." else rel_dir,
                "has_subtitles": has_sub,
                "size_mb": file_size_mb(fpath),
            })
    entries.sort(key=lambda e: (natural_sort_key(e["group"] or ""), natural_sort_key(e["filename"])))
    return entries


# --------------------------------------------------------------------------
# TV shows: <root>/<Show>/[Season N/]<episode>.mkv
# --------------------------------------------------------------------------
def scan_tv(root, previous=None):
    shows = []
    for name in subdirs(root):
        folder = os.path.join(root, name)
        show_id = slug(name)
        signature = folder_signature(folder)
        episodes = reusable(previous, show_id, signature, "episodes")
        if episodes is None:
            episodes = _video_entries(folder)
            for ep in episodes:
                # Legacy display form the UI groups by: "[Extras] OP01 - ..."
                # for named subfolders; plain for season folders (grouped by
                # SxxEyy). Only ever applied to a freshly walked list: a reused
                # one carries its prefixes already.
                group = ep["group"]
                prefix = f"[{group}] " if group and not group.lower().startswith("season") else ""
                ep["title"] = f"{prefix}{ep['title']}"
        if not episodes:
            continue
        title, year = split_year(name)
        shows.append({
            "id": show_id,
            "kind": "tv",
            "title": title,
            "year": year,
            "folder_path": folder,
            "scan_sig": signature,
            "episodes": episodes,
            "episode_count": len(episodes),
            "poster_path": find_local_cover(folder),
            "summary": None,
            "genres": [],
            "rating": None,
        })
    return shows


# --------------------------------------------------------------------------
# Films: <root>/<Film (Year)>/<file>.mkv  or  <root>/<Film (Year)>.mkv
# --------------------------------------------------------------------------
def scan_films(root, exclude=(), previous=None):
    """Films under root. Folders in `exclude` (e.g. the TV shows folder, when it
    lives inside the films folder) are skipped rather than read as films."""
    skip = {os.path.realpath(p) for p in exclude if p}
    films = []
    for name in subdirs(root):
        folder = os.path.join(root, name)
        if os.path.realpath(folder) in skip:
            continue
        film_id = slug(name)
        signature = folder_signature(folder)
        files = reusable(previous, film_id, signature, "files")
        if files is None:
            files = _video_entries(folder)
        if not files:
            continue
        title, year = split_year(name)
        films.append(_film_entry(name, title, year, folder, files, signature))

    # A film that is one loose file has nothing to walk, so it is always read
    # afresh; no signature means nothing ever reuses it either.
    for fname in files_with_ext(root, VIDEO_EXTENSIONS):
        stem = os.path.splitext(fname)[0]
        title, year = split_year(stem)
        fpath = os.path.join(root, fname)
        files = [{
            "filename": fname, "path": fpath, "title": stem, "group": None,
            "has_subtitles": False, "size_mb": file_size_mb(fpath),
        }]
        films.append(_film_entry(stem, title, year, root, files, None))

    films.sort(key=lambda f: natural_sort_key(f["title"]))
    return films


def _film_entry(name, title, year, folder, files, signature):
    # The main feature is the largest file; extras and samples are smaller.
    main = max(files, key=lambda f: f["size_mb"])
    return {
        "id": slug(name),
        "kind": "film",
        "title": title,
        "year": year,
        "folder_path": folder,
        "scan_sig": signature,
        "files": files,
        "main_path": main["path"],
        "poster_path": find_local_cover(folder),
        "summary": None,
        "genres": [],
        "rating": None,
        "runtime": None,
    }


def path_key(path):
    return hashlib.sha1(path.encode("utf-8", "surrogateescape")).hexdigest()[:20]
