"""Walk media folders and turn them into plain dicts for library.json.

One scanner per section. They know nothing about the network; metadata.py
enriches what they return.
"""

import hashlib
import os
import re

VIDEO_EXTENSIONS = {".mp4", ".mkv", ".avi", ".webm", ".m4v", ".mov", ".wmv"}
AUDIO_EXTENSIONS = {".mp3", ".flac", ".ogg", ".opus", ".m4a", ".aac", ".wav", ".wma"}
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".avif", ".tiff", ".bmp"}
SUBTITLE_EXTENSIONS = {".srt", ".vtt", ".ass", ".ssa", ".sub"}
DOCUMENT_EXTENSIONS = {
    ".pdf", ".txt", ".md", ".rst", ".rtf", ".tex", ".epub",
    ".odt", ".ods", ".odp", ".odg", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".csv", ".tsv",
}
# A collection lists at most this many files; Documents folders can be huge.
MAX_DOCUMENTS_PER_COLLECTION = 500
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


def find_local_cover(folder):
    """A cover image kept beside the media (cover.jpg, folder.png, ...)."""
    for name in files_with_ext(folder, IMAGE_EXTENSIONS):
        stem = os.path.splitext(name)[0].lower()
        if stem in COVER_NAMES or stem.startswith(COVER_NAMES):
            return os.path.join(folder, name)
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
def scan_tv(root):
    shows = []
    for name in subdirs(root):
        folder = os.path.join(root, name)
        episodes = _video_entries(folder)
        if not episodes:
            continue
        for ep in episodes:
            # Legacy display form the UI groups by: "[Extras] OP01 - ..." for
            # named subfolders; plain for season folders (grouped by SxxEyy).
            group = ep["group"]
            prefix = f"[{group}] " if group and not group.lower().startswith("season") else ""
            ep["title"] = f"{prefix}{ep['title']}"
        title, year = split_year(name)
        shows.append({
            "id": slug(name),
            "kind": "tv",
            "title": title,
            "year": year,
            "folder_path": folder,
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
def scan_films(root, exclude=()):
    """Films under root. Folders in `exclude` (e.g. the TV shows folder, when it
    lives inside the films folder) are skipped rather than read as films."""
    skip = {os.path.realpath(p) for p in exclude if p}
    films = []
    for name in subdirs(root):
        folder = os.path.join(root, name)
        if os.path.realpath(folder) in skip:
            continue
        files = _video_entries(folder)
        if not files:
            continue
        title, year = split_year(name)
        films.append(_film_entry(name, title, year, folder, files))

    for fname in files_with_ext(root, VIDEO_EXTENSIONS):
        stem = os.path.splitext(fname)[0]
        title, year = split_year(stem)
        fpath = os.path.join(root, fname)
        files = [{
            "filename": fname, "path": fpath, "title": stem, "group": None,
            "has_subtitles": False, "size_mb": file_size_mb(fpath),
        }]
        films.append(_film_entry(stem, title, year, root, files))

    films.sort(key=lambda f: natural_sort_key(f["title"]))
    return films


def _film_entry(name, title, year, folder, files):
    # The main feature is the largest file; extras and samples are smaller.
    main = max(files, key=lambda f: f["size_mb"])
    return {
        "id": slug(name),
        "kind": "film",
        "title": title,
        "year": year,
        "folder_path": folder,
        "files": files,
        "main_path": main["path"],
        "poster_path": find_local_cover(folder),
        "summary": None,
        "genres": [],
        "rating": None,
        "runtime": None,
    }


# --------------------------------------------------------------------------
# Music: <root>/<Artist>/<Album>/<track>.flac  or  <root>/<Album>/<track>.mp3
# --------------------------------------------------------------------------
TRACK_RE = re.compile(r"^\s*(?:\d+\s*[-.]\s*)?(\d{1,3})\s*[-. ]+\s*(.+)$")


def scan_music(root):
    albums = []
    for folder, parent_name in _album_folders(root):
        tracks = []
        for fname in files_with_ext(folder, AUDIO_EXTENSIONS):
            stem = os.path.splitext(fname)[0]
            m = TRACK_RE.match(stem)
            tracks.append({
                "filename": fname,
                "path": os.path.join(folder, fname),
                "title": m.group(2).strip() if m else stem,
                "track": int(m.group(1)) if m else None,
                "size_mb": file_size_mb(os.path.join(folder, fname)),
            })
        if not tracks:
            continue
        name = os.path.basename(folder)
        title, year = split_year(name)
        albums.append({
            "id": slug(f"{parent_name or ''}_{name}"),
            "kind": "album",
            "title": title,
            "artist": parent_name,
            "year": year,
            "folder_path": folder,
            "tracks": tracks,
            "track_count": len(tracks),
            "poster_path": find_local_cover(folder),
            "summary": None,
            "genres": [],
            "rating": None,
        })
    albums.sort(key=lambda a: (natural_sort_key(a["artist"] or ""), natural_sort_key(a["title"])))
    return albums


def _album_folders(root):
    """Yield (album_folder, artist_name_or_None) for every folder holding audio."""
    if files_with_ext(root, AUDIO_EXTENSIONS):
        yield root, None
    for name in subdirs(root):
        folder = os.path.join(root, name)
        if files_with_ext(folder, AUDIO_EXTENSIONS):
            yield folder, None
        for sub in subdirs(folder):
            album = os.path.join(folder, sub)
            if files_with_ext(album, AUDIO_EXTENSIONS):
                yield album, name


# --------------------------------------------------------------------------
# Photos: <root>/<Album>/<image>.jpg (plus loose images in root as "Photos")
# --------------------------------------------------------------------------
def scan_photos(root, thumbnailer=None):
    albums = []
    loose = files_with_ext(root, IMAGE_EXTENSIONS)
    if loose:
        albums.append(_photo_album(os.path.basename(root) or "Photos", root, loose, thumbnailer))
    for name in subdirs(root):
        folder = os.path.join(root, name)
        images = []
        for r, dirs, files in os.walk(folder):
            dirs[:] = sorted(d for d in dirs if not d.startswith("."))
            images.extend(
                os.path.relpath(os.path.join(r, f), folder)
                for f in sorted(files, key=natural_sort_key)
                if os.path.splitext(f)[1].lower() in IMAGE_EXTENSIONS and not f.startswith(".")
            )
        if images:
            albums.append(_photo_album(name, folder, images, thumbnailer))
    return albums


def _photo_album(name, folder, images, thumbnailer):
    photos = []
    for rel in images:
        path = os.path.join(folder, rel)
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            mtime = 0
        photos.append({
            "filename": os.path.basename(rel),
            "path": path,
            "title": os.path.splitext(os.path.basename(rel))[0],
            "thumb_path": thumbnailer(path) if thumbnailer else path,
            "size_mb": file_size_mb(path),
            "mtime": mtime,
        })
    photos.sort(key=lambda p: -p["mtime"])
    title, year = split_year(name)
    return {
        "id": slug(folder),
        "kind": "photos",
        "title": title,
        "year": year,
        "folder_path": folder,
        "photos": photos,
        "photo_count": len(photos),
        "poster_path": photos[0]["thumb_path"] if photos else None,
        "summary": None,
        "genres": [],
        "rating": None,
    }


# --------------------------------------------------------------------------
# Documents: <root>/<Collection>/<file>.pdf (plus loose files in root)
#
# Deliberately shallow: only top-level folders and their direct files. A
# Documents folder can hold hundreds of thousands of files a few levels down,
# and this is a desktop overview, not a file manager.
# --------------------------------------------------------------------------
def scan_documents(root):
    collections = []
    loose = files_with_ext(root, DOCUMENT_EXTENSIONS)
    if loose:
        collections.append(_document_collection(os.path.basename(root) or "Documents", root, loose))
    for name in subdirs(root):
        folder = os.path.join(root, name)
        files = files_with_ext(folder, DOCUMENT_EXTENSIONS)
        if files:
            collections.append(_document_collection(name, folder, files))
    return collections


def _document_collection(name, folder, files):
    docs = []
    for fname in files[:MAX_DOCUMENTS_PER_COLLECTION]:
        path = os.path.join(folder, fname)
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            mtime = 0
        docs.append({
            "filename": fname,
            "path": path,
            "title": os.path.splitext(fname)[0],
            "ext": os.path.splitext(fname)[1].lower().lstrip("."),
            "size_mb": file_size_mb(path),
            "mtime": mtime,
        })
    docs.sort(key=lambda d: -d["mtime"])
    return {
        "id": slug(folder),
        "kind": "documents",
        "title": name,
        "year": None,
        "folder_path": folder,
        "documents": docs,
        "document_count": len(files),
        "poster_path": None,
        "summary": None,
        "genres": [],
        "rating": None,
    }


def path_key(path):
    return hashlib.sha1(path.encode("utf-8", "surrogateescape")).hexdigest()[:20]
