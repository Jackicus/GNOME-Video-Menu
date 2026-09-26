"""Online metadata and artwork, cached under ~/.cache/media-libraries.

Sources, an ordered list per section in the preferences:

  TV shows   tvmaze (keyless) | tmdb (needs a key) | wikipedia (keyless)
  Films      tmdb (needs a key) | wikipedia (keyless)

The list is tried in order until one of them comes back with the artwork, so a
section can name several and a title TMDB has never heard of still gets a
poster from Wikipedia. A source whose credential is not set skips itself rather
than failing, which is why TMDB can sit in every default list unkeyed.

TMDB is the richest: poster, backdrop, tagline, runtime, genres and a rating.
TVmaze covers TV well without a key. Wikipedia gives a poster and the lead
paragraph for almost anything.

A source entry is a name, optionally with a credential slot — "tmdb" is the
same as "tmdb@1", "tmdb@2" is a second TMDB key to fall back to. Credentials
arrive from the preferences (the `credentials` setting, read by
scan_library.py) or, for a standalone run, from the environment
(MEDIA_LIBRARIES_TMDB_KEY). Neither is ever argv, so they do not show up in `ps`.

Everything degrades to "no metadata" on failure: the UI draws a placeholder
tile from the title when poster_path is null, so nothing is ever generated on
disk for a lookup that failed.

Every artwork path this module hands back is a file inside the cache, scaled to
the size the desktop draws it at. Both halves of that matter: St decodes an
image at its full resolution on the compositor thread and keeps the decoded
copy, so a 2830x4000 poster costs tens of megabytes to draw a 320px tile, and a
path outside the cache is a path into the media folder — which may be a network
mount where a single read stalls the whole desktop for seconds.
"""

import contextlib
import hashlib
import html
import json
import os
import re
import shutil
import threading
import time
import urllib.error
import urllib.parse
import urllib.request


def _user_cache_dir():
    """What GLib.get_user_cache_dir() answers in the extension: XDG_CACHE_HOME
    when it is set to an absolute path, else ~/.cache. The two sides have to
    agree, or a scan lands where the shell never looks — the nested shell of
    scripts/nested.sh points the extension at a cache of its own this way."""
    home = os.environ.get("XDG_CACHE_HOME", "")
    return home if os.path.isabs(home) else os.path.expanduser("~/.cache")


CACHE_DIR = os.path.join(_user_cache_dir(), "media-libraries")
POSTER_CACHE_DIR = os.path.join(CACHE_DIR, "posters")
BACKDROP_CACHE_DIR = os.path.join(CACHE_DIR, "backdrops")
METADATA_CACHE_DIR = os.path.join(CACHE_DIR, "metadata")
# One file for every cached record. The first release wrote one small file per
# item, which cost an open() per item per scan just to check the provider still
# matched; those files are still read when the index has no record for an item,
# so upgrading re-reads each of them exactly once and never refetches.
METADATA_INDEX = os.path.join(METADATA_CACHE_DIR, "index.json")
# The index is rewritten this often as well as at the end, so a scan that is
# interrupted loses at most this many freshly fetched records (never artwork,
# which is on disk the moment it lands).
INDEX_FLUSH_EVERY = 25
# A title no source had artwork for is not asked about again for this long:
# a home video would otherwise cost a request per source on every scan.
MISS_RETRY_SECONDS = 7 * 24 * 3600
# Transport failures in a row (no route, a firewall dropping packets, a
# timeout each) before the rest of the run is taken offline; one success in
# between starts the count over.
OFFLINE_AFTER_FAILURES = 6
USER_AGENT = "MediaLibraries/2.0"

# The largest the desktop ever draws each kind of artwork, doubled where a
# HiDPI monitor would ask for twice the pixels, and no further — everything
# above this is memory the compositor holds and never uses.
#   poster    a 320px grid tile (mediaGrid.js iconSize, floored by MIN_ART) at
#             scale 2, and the 560px detail hero (detailView.js
#             HERO_MAX_HEIGHT) at scale 1
#   backdrop  the detail pane's own backing, dimmed under a veil
POSTER_BOX = (512, 768)
BACKDROP_BOX = (960, 540)
ART_CACHES = (
    (POSTER_CACHE_DIR, POSTER_BOX),
    (BACKDROP_CACHE_DIR, BACKDROP_BOX),
)
# Remembers the caps the cache was last swept to; see fit_cached_art.
ART_FIT_STAMP = os.path.join(CACHE_DIR, "art-fit.json")

TMDB_API = "https://api.themoviedb.org/3"
TMDB_IMAGE = "https://image.tmdb.org/t/p"
TMDB_POSTER_SIZE = "w780"
TMDB_BACKDROP_SIZE = "w1280"

PROVIDERS = {
    "tv": ("tvmaze", "tmdb", "wikipedia"),
    "film": ("tmdb", "wikipedia"),
}
# The list each kind falls back to when nothing was passed in — a standalone
# run with no preferences to read. It matches the schema's defaults.
DEFAULT_SOURCES = {
    "tv": ("tvmaze", "tmdb@1", "wikipedia"),
    "film": ("tmdb@1", "wikipedia"),
}
# Sources that need a credential at all — only TMDB does now. A source not
# listed here never carries a slot, which is why TMDB can sit in every
# default list unkeyed and everything else never needs one.
CREDENTIAL_NEEDED = {"tmdb"}
# What wrote a cache entry that predates the "provider" field.
LEGACY_PROVIDER = {"tv": "tvmaze", "film": "wikipedia"}
CACHED_FIELDS = ("summary", "genres", "rating", "runtime", "year", "tagline", "seasons")


def source_id(entry):
    """The source a list entry names. "tmdb@2" is TMDB with its second key."""
    return entry.split("@", 1)[0]


def normalise_entry(entry):
    """A list entry with its credential slot spelled out.

    "tmdb" and "tmdb@1" are the same first TMDB key; a source that takes no
    credential never carries a slot at all. Doing this once, on the way in,
    is what lets everything below look a credential up by the entry itself.
    """
    name = source_id(entry)
    if name not in CREDENTIAL_NEEDED:
        return name
    return entry if "@" in entry else f"{name}@1"


# (kind, source) -> the call that asks it. One table rather than one built per
# item: enrich runs once per title, and a library is thousands of them.
_LOOKUPS = {
    ("tv", "tvmaze"): lambda svc, item, entry: svc._tvmaze(item),
    ("tv", "tmdb"): lambda svc, item, entry: svc._tmdb(item, "tv", entry),
    ("tv", "wikipedia"): lambda svc, item, entry: svc._wikipedia(item, "tv"),
    ("film", "tmdb"): lambda svc, item, entry: svc._tmdb(item, "movie", entry),
    ("film", "wikipedia"): lambda svc, item, entry: svc._wikipedia(item, "film"),
}

def ensure_cache_dirs():
    for directory in (POSTER_CACHE_DIR, BACKDROP_CACHE_DIR, METADATA_CACHE_DIR):
        os.makedirs(directory, exist_ok=True)


def path_key(path):
    """A short stable name for a path, for files in the cache named after one."""
    return hashlib.sha1(path.encode("utf-8", "surrogateescape")).hexdigest()[:20]


# --------------------------------------------------------------------------
# Scaling
# --------------------------------------------------------------------------
_SCALER = "?"


def _scaler():
    """(name, module) of whatever can scale an image here, or None.

    Pillow if it happens to be installed, otherwise GdkPixbuf, which is already
    on any machine running GNOME. Resolved once: every item on the pool asks.
    """
    global _SCALER
    if _SCALER == "?":
        try:
            from PIL import Image
            _SCALER = ("pil", Image)
        except ImportError:
            try:
                import gi
                gi.require_version("GdkPixbuf", "2.0")
                from gi.repository import GdkPixbuf
                _SCALER = ("pixbuf", GdkPixbuf)
            except (ImportError, ValueError):
                _SCALER = None
    return _SCALER


def image_size(path):
    """(width, height) read from the file's header, without decoding it."""
    scaler = _scaler()
    if scaler is None:
        return None
    kind, module = scaler
    try:
        if kind == "pil":
            with module.open(path) as img:
                return img.size
        fmt, width, height = module.Pixbuf.get_file_info(path)
        return (width, height) if fmt else None
    except Exception:
        return None


def fit_image(src, box, dest=None):
    """Write `src` into `dest`, or over itself, no larger than `box`.

    Aspect is kept and a small image is never blown up: the point is to stop the
    shell decoding artwork at a resolution it will not draw, not to make
    anything sharper. JPEG stays JPEG at quality 88; anything carrying an alpha
    channel is written as PNG, so a transparent cover does not gain a black
    backing — and with a `dest` it takes the .png name to match, which is why
    the path written is returned rather than assumed. The file is put in place
    with a rename, since the shell may be reading the old one.

    Returns None when nothing here can scale an image, which is the caller's cue
    that there is no artwork rather than an invitation to use the original.
    """
    scaler = _scaler()
    size = image_size(src)
    if scaler is None or size is None:
        return None
    kind, module = scaler
    scale = min(1.0, box[0] / size[0], box[1] / size[1])
    if dest is None and scale == 1.0:
        return src  # already within the box: leave the file untouched
    out = dest or src
    tmp = f"{out}.tmp"
    try:
        if kind == "pil":
            from PIL import ImageOps
            img = module.open(src)
            # JPEG can decode straight to a smaller size instead of paying for
            # the full original and then throwing most of it away; the box is
            # squared so a 90-degree EXIF rotation still decodes the long side
            # at full size. Must come before exif_transpose, which loads the
            # image and makes draft() a no-op from then on.
            img.draft("RGB", (max(box), max(box)))
            img = ImageOps.exif_transpose(img)
            img.thumbnail(box, module.LANCZOS)  # keeps aspect, never enlarges
            if img.mode in ("RGBA", "LA") or "transparency" in img.info:
                out = _png_name(out, dest)
                img.save(tmp, "PNG")
            else:
                img.convert("RGB").save(tmp, "JPEG", quality=88)
        else:
            # Loaded no larger than the box's long side either way, so a
            # 90-degree orientation still has its long side whole, then
            # oriented and fitted to the box as it now stands — sizing off
            # the unrotated header put a rotated poster at two-thirds of it.
            side = max(box)
            pb = module.Pixbuf.new_from_file_at_scale(src, side, side, True) \
                if scale < 1.0 else module.Pixbuf.new_from_file(src)
            pb = pb.apply_embedded_orientation() or pb
            fit = min(1.0, box[0] / pb.get_width(), box[1] / pb.get_height())
            if fit < 1.0:
                pb = pb.scale_simple(max(1, round(pb.get_width() * fit)),
                                     max(1, round(pb.get_height() * fit)),
                                     module.InterpType.BILINEAR)
            if pb.get_has_alpha():
                out = _png_name(out, dest)
                pb.savev(tmp, "png", [], [])
            else:
                pb.savev(tmp, "jpeg", ["quality"], ["88"])
        os.replace(tmp, out)
        return out
    except Exception as e:
        print(f"Could not scale {src}: {e}")
        try:
            os.remove(tmp)
        except OSError:
            pass
        return None


def _png_name(out, dest):
    """A fresh copy switches to .png for alpha; a file rewritten in place keeps
    the name library.json already points at, whatever is inside it."""
    return f"{os.path.splitext(out)[0]}.png" if dest else out


def _cached_copy(dest):
    """The copy already written for `dest`, under either extension."""
    for path in (dest, f"{os.path.splitext(dest)[0]}.png"):
        if os.path.exists(path):
            return path
    return None


def cache_local_art(path, kind="poster"):
    """A scaled copy, inside the cache, of artwork that lives outside it.

    A cover.jpg beside the media: handing that path to the shell puts a read of
    the media folder on the compositor thread, and that folder may be an
    automount where one read blocks for ten seconds. The copy is named after
    the source path and its mtime, so it is written once and rewritten only
    when the file behind it changes. Getting that mtime is itself a stat of the
    media folder, which is fine out here — the scanner has just walked it.
    """
    if not path:
        return None
    directory, box = (BACKDROP_CACHE_DIR, BACKDROP_BOX) if kind == "backdrop" else (POSTER_CACHE_DIR, POSTER_BOX)
    try:
        mtime = int(os.path.getmtime(path))
    except OSError:
        return None
    dest = os.path.join(directory, f"local_{path_key(path)}_{mtime}.jpg")
    return _cached_copy(dest) or fit_image(path, box, dest)


def localise_art(sections):
    """Bring every artwork path in the library inside the cache.

    A section that was not rescanned, or an item reused from the previous scan
    on its folder signature, still carries whatever an older release wrote for
    it — and the shell must be handed a cache path or nothing at all. Copies
    already made are reused, so for a library that is already right this is one
    string comparison per item.
    """
    moved = 0
    for items in sections.values():
        for item in items or []:
            for field, kind in (("poster_path", "poster"), ("backdrop_path", "backdrop")):
                path = item.get(field)
                if path and not path.startswith(CACHE_DIR):
                    item[field] = cache_local_art(path, kind)
                    moved += 1
    return moved


def fit_cached_art():
    """Shrink artwork an older release cached at full resolution.

    Everything written from here on is fitted as it is written, so this is only
    for what is already on disk — and reading one file's dimensions costs about
    as much as opening it, which is too much to pay per thumbnail on every scan.
    So the caps are stamped beside the cache and the sweep is skipped until they
    change. Nothing is refetched: the files are rewritten from themselves.
    """
    caps = {os.path.basename(directory): list(box) for directory, box in ART_CACHES}
    try:
        with open(ART_FIT_STAMP, "r", encoding="utf-8") as f:
            if json.load(f) == caps:
                return 0
    except (OSError, ValueError):
        pass
    fitted = 0
    for directory, box in ART_CACHES:
        for name in sorted(os.listdir(directory)):
            path = os.path.join(directory, name)
            size = image_size(path)
            if size and (size[0] > box[0] or size[1] > box[1]) and fit_image(path, box):
                fitted += 1
    try:
        with open(ART_FIT_STAMP, "w", encoding="utf-8") as f:
            json.dump(caps, f)
    except OSError:
        pass  # the sweep simply runs again next time
    return fitted


def prune_art(sections):
    """Delete cached artwork nothing in the library points at any more.

    Posters and backdrops are orphaned by items that were renamed or deleted.
    `sections` must be the whole merged library — pruning against one
    section's items would throw away all the others — so this belongs inside
    the scan lock, beside the write.
    """
    keep = set()
    for items in sections.values():
        for item in items or []:
            keep.update(p for p in (item.get("poster_path"), item.get("backdrop_path")) if p)
    removed = 0
    for directory, _box in ART_CACHES:
        for name in os.listdir(directory):
            path = os.path.join(directory, name)
            if path in keep or not os.path.isfile(path):
                continue
            try:
                os.remove(path)
                removed += 1
            except OSError:
                pass
    # Photos, and the thumbs/ folder only they used, are gone; sweep what an
    # older release left behind once, here, rather than keeping thumbnail
    # cache code around just for this.
    thumbs_dir = os.path.join(CACHE_DIR, "thumbs")
    if os.path.isdir(thumbs_dir):
        shutil.rmtree(thumbs_dir, ignore_errors=True)
    return removed


# Transport failures seen in a row, across the pool; see OFFLINE_AFTER_FAILURES.
_failures = 0
_failures_lock = threading.Lock()


def _fetch(url, timeout):
    """GET with a polite retry: Wikipedia answers bursts with 429.

    A failure to reach the server at all (as against an answer) is counted,
    and after enough of them in a row the rest of the run is refused here
    rather than paid for at a timeout per item: a thousand-item scan with the
    network down took a quarter of an hour to fail otherwise."""
    global _failures
    if _failures >= OFFLINE_AFTER_FAILURES:
        raise OSError("the network is unreachable, not asking")
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = resp.read()
        except urllib.error.HTTPError as e:
            if e.code != 429 or attempt == 3:
                raise
            time.sleep(1.5 * (attempt + 1))
            continue
        except (urllib.error.URLError, OSError):
            with _failures_lock:
                _failures += 1
                tripped = _failures == OFFLINE_AFTER_FAILURES
            if tripped:
                print(f"No answer from the network {OFFLINE_AFTER_FAILURES} times running; "
                      "finishing this scan offline.")
            raise
        with _failures_lock:
            _failures = 0
        return data


def _get_json(url, timeout=6):
    return json.loads(_fetch(url, timeout).decode("utf-8"))


def _download(url, dest, box, timeout=10):
    """Fetch artwork and leave it no larger than the desktop will draw it.

    Providers are asked for the smallest file that still covers `box` where they
    offer a choice, but several only publish the full-resolution original, so
    the shrink after the download is the guarantee rather than the fallback.
    """
    data = _fetch(url, timeout)
    tmp = f"{dest}.download"
    with open(tmp, "wb") as f:
        f.write(data)
    # Fitted under the temporary name, then put in place in one move: the
    # shell may be drawing the old file, and a body that is not an image at
    # all (an error page) must not become the poster, or it would be kept —
    # it exists — and drawn as nothing, not even the placeholder.
    if fit_image(tmp, box) is None:
        with contextlib.suppress(OSError):
            os.remove(tmp)
        raise ValueError("not an image that can be scaled")
    os.replace(tmp, dest)
    return dest


def _fill(item, field, value):
    """Set a fact a source found; nothing found leaves what is there."""
    if value not in (None, "", []):
        item[field] = value


def _strip_html(text):
    """Tags out, entities decoded — providers hand back both (`<p>`, `&quot;`)."""
    return html.unescape(re.sub(r"<[^>]+>", "", text or "")).strip() or None


def clean_query(title, kind="tv"):
    """Turn a folder name into a search term.

    TV: 'Boruto Kai' -> 'Boruto'; 'Frieren - Beyond Journeys End' -> 'Frieren'
    (fan-edit suffixes and subtitles confuse TVmaze).
    Films: 'Spider-Man - Homecoming (2017)' -> 'Spider-Man: Homecoming'.
    """
    q = re.sub(r"\s*[\(\[]\d{4}[\)\]]", "", title)
    if kind == "tv":
        q = re.sub(r"\bKai\b", "", q, flags=re.IGNORECASE)
        q = re.sub(r"ReZERO", "Re:Zero", q, flags=re.IGNORECASE)
        q = q.split(" - ")[0]
    else:
        q = q.replace(" - ", ": ")
    return q.strip()


class MetadataService:
    """Enrichment for one scan. `enrich` is called from a worker pool, so every
    piece of shared state below it — the record index, the one-shot warning —
    is taken under `_lock`."""

    def __init__(self, online=True, sources=None, credentials=None, offline_kinds=()):
        self.online = online
        # Sections whose own switch is off. They still get whatever is already
        # cached; they just never reach for the network.
        self._offline_kinds = set(offline_kinds)
        self.sources = {
            kind: tuple(normalise_entry(e) for e in entries)
            for kind, entries in DEFAULT_SOURCES.items()
        }
        for kind, entries in (sources or {}).items():
            if kind in self.sources and entries is not None:
                self.sources[kind] = tuple(
                    normalise_entry(e) for e in entries
                    if source_id(e) in PROVIDERS.get(kind, ()))
        self._credentials = dict(credentials or {})
        # Slot 1 falls back to the environment, which is how a standalone run
        # (no preferences to read) is given a key.
        self._env_credentials = {
            "tmdb": (os.environ.get("MEDIA_LIBRARIES_TMDB_KEY") or "").strip(),
        }
        self._warned = set()          # source names already complained about
        self._refused = set()         # entries whose key the source rejected
        self._lock = threading.Lock()
        # Held for the whole of a flush: two due at once would write the same
        # temporary file over each other.
        self._flush_lock = threading.Lock()
        self._unflushed = 0
        ensure_cache_dirs()
        self._index = self._load_index()

    # -- sources ---------------------------------------------------------
    def credential(self, entry):
        """One source entry's credential (its API key), or "" if it has none."""
        raw = self._credentials.get(entry)
        if not raw and entry.endswith("@1"):
            raw = self._env_credentials.get(source_id(entry))
        return (raw or "").strip()

    def _usable(self, entry):
        """Whether this entry can run at all. A source whose credential is
        missing skips itself, which is what lets TMDB sit unkeyed in every
        default list rather than being an error."""
        if source_id(entry) not in CREDENTIAL_NEEDED:
            return True
        if entry in self._refused:
            return False
        if self.credential(entry):
            return True
        name = source_id(entry)
        with self._lock:
            warn = name not in self._warned
            self._warned.add(name)
        if warn:
            print(f"{name}: no credential set, skipping it wherever it is listed.")
        return False

    def _refuse(self, entry, why):
        """Give an entry up for the rest of the run — its key was rejected —
        and say so once, rather than a failure line per item."""
        with self._lock:
            first = entry not in self._refused
            self._refused.add(entry)
        if first:
            print(f"{entry}: {why}; skipping it for the rest of this scan.")

    def online_for(self, kind):
        """Whether this kind may go online at all: the run's --offline flag and
        then the section's own switch."""
        return self.online and kind not in self._offline_kinds

    # -- cache helpers ---------------------------------------------------
    def _load_index(self):
        try:
            with open(METADATA_INDEX, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            return {}
        if not isinstance(data, dict):
            return {}
        # Music and games are gone; drop what their scans cached rather than
        # carry it forward forever unread. The next flush writes the index
        # back without them.
        kept = {k: v for k, v in data.items() if not k.startswith(("album_", "game_"))}
        self._unflushed += len(data) - len(kept)
        return kept

    def _paths(self, item):
        # TV shows keep the unprefixed names the first release used, so posters
        # already on disk are not fetched twice. An id keeps every letter it
        # has (media_scanner.slug) and the `~n` of a name found twice: folded
        # to ASCII, "foo~2" was "foo2", and two titles that differ only in
        # script were one record.
        prefix = "" if item["kind"] == "tv" else f"{item['kind']}_"
        safe = re.sub(r"[^\w~]", "", f"{prefix}{item['id']}")
        return (
            safe,
            os.path.join(POSTER_CACHE_DIR, f"{safe}.jpg"),
            os.path.join(BACKDROP_CACHE_DIR, f"{safe}.jpg"),
        )

    def _record(self, key):
        """The cached record for `key`, from the index or — once, for a cache
        the first release wrote — from that item's own file."""
        with self._lock:
            if key in self._index:
                return self._index[key]
        try:
            with open(os.path.join(METADATA_CACHE_DIR, f"{key}.json"), "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            return None
        if not isinstance(data, dict):
            return None
        with self._lock:
            self._index.setdefault(key, data)
            # Dirty, so the fold-in is written out even by a run that fetches
            # nothing; otherwise every scan would keep reading the old files.
            self._unflushed += 1
        return data

    def _apply_cached(self, item, provider, data, poster_file, backdrop_file):
        if data is None:
            return False
        # Older caches lack these; a changed provider means fetch afresh.
        cached_by = data.get("provider") or LEGACY_PROVIDER.get(item["kind"])
        if "year" not in data or cached_by != provider:
            return False
        for field in CACHED_FIELDS:
            if data.get(field) is not None and item.get(field) in (None, [], ""):
                item[field] = data[field]
        if not item.get("poster_path"):
            if not os.path.exists(poster_file):
                return False  # text was cached but the artwork never arrived: retry
            item["poster_path"] = poster_file
        if os.path.exists(backdrop_file):
            item["backdrop_path"] = backdrop_file
        item["provider"] = cached_by
        return True

    def _save(self, item, provider, key, asked, previous=None):
        """Record what the sources came back with — or, with `provider` None,
        that none of them had anything, keeping whatever facts an earlier
        run cached. Either way, when no artwork arrived, the time and the
        sources that were `asked` and answered go in too, so the same
        question is not put to the same sources again for a while
        (`_missed`). A source that could not be asked — the network down, a
        key refused — is not among them, and is asked next time."""
        if provider:
            record = {field: item.get(field) for field in CACHED_FIELDS}
            record["genres"] = item.get("genres") or []
            record["provider"] = provider
        else:
            record = {k: v for k, v in (previous or {}).items() if k not in ("tried", "sources")}
        if not item.get("poster_path"):
            record["tried"] = time.time()
            record["sources"] = sorted(asked)
        with self._lock:
            self._index[key] = record
            self._unflushed += 1
            due = self._unflushed >= INDEX_FLUSH_EVERY
        if due:
            self.flush()

    @staticmethod
    def _missed(record, sources):
        """Whether the same sources were asked for this lately and had no
        artwork. A source added since, or the window passed, asks again."""
        tried = (record or {}).get("tried")
        return bool(tried) and time.time() - tried < MISS_RETRY_SECONDS and \
            set(sources) <= set(record.get("sources") or ())

    def flush(self):
        """Write the record index out. Atomic, so a scan killed mid-write
        leaves the previous index rather than a truncated one."""
        with self._flush_lock:
            with self._lock:
                if not self._unflushed:
                    return
                snapshot = dict(self._index)
                self._unflushed = 0
            tmp = f"{METADATA_INDEX}.tmp"
            try:
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(snapshot, f, indent=1)
                os.replace(tmp, METADATA_INDEX)
            except OSError as e:
                print(f"Could not write the metadata index: {e}")

    # -- public ----------------------------------------------------------
    def enrich(self, item):
        """Fill summary/genres/rating/artwork in place, from cache or online.

        The section's sources are tried in order until one comes back with the
        artwork. A source that knows the facts but has no poster leaves the
        next one to try for one — it has already written what it knew into the
        item, and whatever answers last overwrites it — so a list is worth
        arranging richest-first.
        """
        kind = item["kind"]
        listed = self.sources.get(kind, ())
        if not listed:
            return
        key, poster_file, backdrop_file = self._paths(item)
        record = self._record(key)
        # A cached record was written by one source; any entry naming that
        # source is still the answer, wherever it now sits in the order — and
        # whether or not it could be asked again now: a key blanked in the
        # preferences must not throw away what it fetched.
        for entry in listed:
            if self._apply_cached(item, source_id(entry), record, poster_file, backdrop_file):
                return
        if not self.online_for(kind):
            return
        entries = [e for e in listed if self._usable(e)]
        names = [source_id(e) for e in entries]
        if not entries or self._missed(record, names):
            return

        answered = None
        asked = []  # the sources that answered at all, with a result or without
        for entry in entries:
            name = source_id(entry)
            lookup = _LOOKUPS.get((kind, name))
            if lookup is None:
                continue
            try:
                art = lookup(self, item, entry)
            except Exception as e:  # network errors, odd JSON, anything
                print(f"{name} lookup failed for '{item['title']}': {e}")
                continue
            asked.append(name)
            if not art:  # nothing found here; the next source gets its turn
                continue
            if isinstance(art, str):  # sources that only know a poster
                art = {"poster": art}

            answered = name
            if art.get("poster") and not item.get("poster_path"):
                try:
                    item["poster_path"] = _download(art["poster"], poster_file, POSTER_BOX)
                except Exception as e:
                    print(f"Artwork download failed for '{item['title']}': {e}")
            if art.get("backdrop") and not item.get("backdrop_path"):
                try:
                    item["backdrop_path"] = _download(art["backdrop"], backdrop_file, BACKDROP_BOX)
                except Exception as e:
                    print(f"Backdrop download failed for '{item['title']}': {e}")
            if item.get("poster_path"):
                break

        if answered:
            item["provider"] = answered
        self._save(item, answered, key, asked, record)

    # -- providers -------------------------------------------------------
    def _tvmaze(self, show):
        q = urllib.parse.quote(clean_query(show["title"], "tv"))
        results = _get_json(f"https://api.tvmaze.com/search/shows?q={q}")
        if not results:
            return None
        data = results[0].get("show", {})
        # Facts go in only where this source has them: a source asked after
        # one that answered is asked for the poster the first had none of,
        # and must not blank what the first knew.
        _fill(show, "summary", _strip_html(data.get("summary")))
        _fill(show, "genres", data.get("genres"))
        _fill(show, "rating", (data.get("rating") or {}).get("average"))
        premiered = data.get("premiered") or ""
        if not show.get("year") and premiered[:4].isdigit():
            show["year"] = int(premiered[:4])
        image = data.get("image") or {}
        return image.get("original") or image.get("medium")

    def _tmdb(self, item, media, entry):
        """Poster, backdrop, synopsis, tagline, genres, runtime and rating from
        The Movie Database. `media` is "movie" or "tv"; `entry` names the key
        slot, so a list holding "tmdb@1" and "tmdb@2" asks twice with two keys."""
        api_key = self.credential(entry)
        query = clean_query(item["title"], "film" if media == "movie" else "tv")
        params = {"api_key": api_key, "query": query, "include_adult": "false"}
        year = item.get("year")
        if year:
            params["year" if media == "movie" else "first_air_date_year"] = str(year)

        def search():
            url = f"{TMDB_API}/search/{media}?{urllib.parse.urlencode(params)}"
            return _get_json(url).get("results") or []

        try:
            results = search()
            if not results and year:  # the folder's year may be off by one
                params.pop("year", None)
                params.pop("first_air_date_year", None)
                results = search()
        except urllib.error.HTTPError as e:
            # Given up for the run, and said once rather than per title; it
            # still counts as a failure here, not as "TMDB had nothing".
            if e.code == 401:
                self._refuse(entry, "TMDB rejected this key")
            raise
        if not results:
            return None

        best = results[0]
        details = _get_json(f"{TMDB_API}/{media}/{best['id']}?api_key={api_key}")
        _fill(item, "summary", details.get("overview") or best.get("overview"))
        _fill(item, "tagline", details.get("tagline"))
        _fill(item, "genres", [g["name"] for g in details.get("genres") or [] if g.get("name")])
        vote = details.get("vote_average")
        _fill(item, "rating", round(vote, 1) if vote else None)
        if media == "movie":
            _fill(item, "runtime", details.get("runtime"))
            date = details.get("release_date") or ""
        else:
            run = details.get("episode_run_time") or []
            _fill(item, "runtime", run[0] if run else None)
            _fill(item, "seasons", details.get("number_of_seasons"))
            date = details.get("first_air_date") or ""
        if not item.get("year") and date[:4].isdigit():
            item["year"] = int(date[:4])
        poster = details.get("poster_path") or best.get("poster_path")
        backdrop = details.get("backdrop_path") or best.get("backdrop_path")
        return {
            "poster": f"{TMDB_IMAGE}/{TMDB_POSTER_SIZE}{poster}" if poster else None,
            "backdrop": f"{TMDB_IMAGE}/{TMDB_BACKDROP_SIZE}{backdrop}" if backdrop else None,
        }

    def _wikipedia(self, film, kind="film"):
        """Poster and lead paragraph from the Wikipedia article."""
        title = clean_query(film["title"], kind)
        year = film.get("year")
        noun = "film" if kind == "film" else "TV series"
        terms = f"{title} {year} {noun}" if year else f"{title} {noun}"
        q = urllib.parse.quote(terms)
        data = _get_json(
            "https://en.wikipedia.org/w/api.php?action=query&list=search"
            f"&srsearch={q}&srlimit=5&format=json"
        )
        hits = (data.get("query") or {}).get("search") or []
        if not hits:
            return None

        # Prefer an article whose snippet mentions the year; else the top hit.
        best = hits[0]
        if year:
            for h in hits:
                if str(year) in h.get("snippet", "") or str(year) in h.get("title", ""):
                    best = h
                    break

        page = urllib.parse.quote(best["title"].replace(" ", "_"), safe=":()_,'")
        summary = _get_json(f"https://en.wikipedia.org/api/rest_v1/page/summary/{page}")
        extract = summary.get("extract")
        if extract:
            # Drop the "X is a 2017 American superhero film" / "X is a Japanese
            # anime television series" lead-in; the tile already shows the title.
            extract = re.sub(r"^[^.]*\bis an? (\d{4} )?[^.]*\.\s*", "", extract, count=1) or extract
        _fill(film, "summary", extract)
        m = re.search(r"\b(\d{4})\b", summary.get("description") or "")
        if not film.get("year") and m:
            film["year"] = int(m.group(1))
        image = summary.get("originalimage") or summary.get("thumbnail") or {}
        return image.get("source")
