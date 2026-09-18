"""Online metadata and artwork, cached under ~/.cache/gnomeflix.

Providers, chosen per section in the preferences:

  TV shows   tvmaze (default, keyless) | tmdb (needs a key) | wikipedia
  Films      tmdb (default, needs a key; falls back to wikipedia) | wikipedia
  Albums     itunes (keyless)
  Games      steam (keyless, Steam apps) | igdb (needs Twitch credentials, PS2)

TMDB is the richest: poster, backdrop, tagline, runtime, genres and a rating.
TVmaze covers TV well without a key. Wikipedia gives a poster and the lead
paragraph for almost anything. Photos and documents never go online.

Games are the one kind whose source is decided by the item rather than by a
preference: a Steam app has its own keyless store record and artwork CDN, and a
PS2 disc image has neither, so it falls to IGDB when the Twitch credentials are
set and to the drawn placeholder when they are not.

Keys arrive through the environment (GNOMEFLIX_TMDB_KEY,
GNOMEFLIX_IGDB_CLIENT_ID, GNOMEFLIX_IGDB_CLIENT_SECRET), never argv, so they do
not show up in `ps`.

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

import html
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

CACHE_DIR = os.path.expanduser("~/.cache/gnomeflix")
POSTER_CACHE_DIR = os.path.join(CACHE_DIR, "posters")
BACKDROP_CACHE_DIR = os.path.join(CACHE_DIR, "backdrops")
METADATA_CACHE_DIR = os.path.join(CACHE_DIR, "metadata")
THUMB_CACHE_DIR = os.path.join(CACHE_DIR, "thumbs")
# One file for every cached record. The first release wrote one small file per
# item, which cost an open() per item per scan just to check the provider still
# matched; those files are still read when the index has no record for an item,
# so upgrading re-reads each of them exactly once and never refetches.
METADATA_INDEX = os.path.join(METADATA_CACHE_DIR, "index.json")
# The index is rewritten this often as well as at the end, so a scan that is
# interrupted loses at most this many freshly fetched records (never artwork,
# which is on disk the moment it lands).
INDEX_FLUSH_EVERY = 25
USER_AGENT = "Gnomeflix/2.0"

# The largest the desktop ever draws each kind of artwork, doubled where a
# HiDPI monitor would ask for twice the pixels, and no further — everything
# above this is memory the compositor holds and never uses.
#   poster    320px grid tile (libraryView MAX_TILE), 480x720 detail hero
#   backdrop  the detail pane's own backing, dimmed under a veil
#   thumb     132px in the photo grid, and the first one is the album's poster
#             at up to 320px; an album can hold thousands, so they stay modest
POSTER_BOX = (640, 960)
BACKDROP_BOX = (1280, 720)
THUMB_BOX = (384, 384)
ART_CACHES = (
    (POSTER_CACHE_DIR, POSTER_BOX),
    (BACKDROP_CACHE_DIR, BACKDROP_BOX),
    (THUMB_CACHE_DIR, THUMB_BOX),
)
# Remembers the caps the cache was last swept to; see fit_cached_art.
ART_FIT_STAMP = os.path.join(CACHE_DIR, "art-fit.json")

TMDB_API = "https://api.themoviedb.org/3"
TMDB_IMAGE = "https://image.tmdb.org/t/p"
TMDB_POSTER_SIZE = "w780"
TMDB_BACKDROP_SIZE = "w1280"

# Steam publishes the same library art the client caches, keyless and sessionless.
STEAM_CDN = "https://cdn.cloudflare.steamstatic.com/steam/apps"
STEAM_STORE_API = "https://store.steampowered.com/api/appdetails"

# IGDB is a Twitch property: the client id/secret pair is exchanged for an app
# access token, which is then sent as a bearer alongside the Client-ID header.
IGDB_TOKEN_URL = "https://id.twitch.tv/oauth2/token"
IGDB_API = "https://api.igdb.com/v4"
IGDB_IMAGE = "https://images.igdb.com/igdb/image/upload"
IGDB_PS2_PLATFORM = 8

PROVIDERS = {
    "tv": ("tvmaze", "tmdb", "wikipedia"),
    "film": ("tmdb", "wikipedia"),
    "album": ("itunes",),
    "game": ("steam", "igdb"),
}
DEFAULT_PROVIDER = {"tv": "tvmaze", "film": "tmdb", "album": "itunes", "game": "steam"}
# What wrote a cache entry that predates the "provider" field.
LEGACY_PROVIDER = {"tv": "tvmaze", "film": "wikipedia", "album": "itunes", "game": "steam"}
CACHED_FIELDS = ("summary", "genres", "rating", "runtime", "year", "artist", "tagline", "seasons")

for _d in (POSTER_CACHE_DIR, BACKDROP_CACHE_DIR, METADATA_CACHE_DIR, THUMB_CACHE_DIR):
    os.makedirs(_d, exist_ok=True)


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
            img = ImageOps.exif_transpose(module.open(src))
            # Recomputed: a photo tagged as rotated comes out of that with its
            # width and height the other way round.
            fit = min(1.0, box[0] / img.width, box[1] / img.height)
            if fit < 1.0:
                img = img.resize(
                    (max(1, round(img.width * fit)), max(1, round(img.height * fit))),
                    module.LANCZOS)
            if img.mode in ("RGBA", "LA") or "transparency" in img.info:
                out = _png_name(out, dest)
                img.save(tmp, "PNG")
            else:
                img.convert("RGB").save(tmp, "JPEG", quality=88)
        else:
            if scale < 1.0:
                pb = module.Pixbuf.new_from_file_at_scale(
                    src, max(1, round(size[0] * scale)), max(1, round(size[1] * scale)), True)
            else:
                pb = module.Pixbuf.new_from_file(src)
            pb = pb.apply_embedded_orientation() or pb
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

    A cover.jpg beside the media, Steam's own library cache, PCSX2's covers
    folder: handing any of those to the shell puts a read of the media folder on
    the compositor thread, and that folder may be an automount where one read
    blocks for ten seconds. The copy is named after the source path and its
    mtime, so it is written once and rewritten only when the file behind it
    changes. Getting that mtime is itself a stat of the media folder, which is
    fine out here — the scanner has just walked it.
    """
    if not path:
        return None
    from media_scanner import path_key

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
    thumbnailer = make_thumbnailer()
    moved = 0
    for items in sections.values():
        for item in items or []:
            for field, kind in (("poster_path", "poster"), ("backdrop_path", "backdrop")):
                path = item.get(field)
                if path and not path.startswith(CACHE_DIR):
                    item[field] = cache_local_art(path, kind)
                    moved += 1
            for photo in item.get("photos") or []:
                path = photo.get("thumb_path")
                if path and not path.startswith(CACHE_DIR):
                    photo["thumb_path"] = thumbnailer(photo["path"], photo.get("mtime")) if thumbnailer else None
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

    Thumbnails carry the photo's mtime in their name, so every edit leaves the
    previous one behind for good; posters and backdrops are orphaned by items
    that were renamed or deleted. `sections` must be the whole merged library —
    pruning against one section's items would throw away all the others — so
    this belongs inside the scan lock, beside the write.
    """
    keep = set()
    for items in sections.values():
        for item in items or []:
            keep.update(p for p in (item.get("poster_path"), item.get("backdrop_path")) if p)
            keep.update(p["thumb_path"] for p in item.get("photos") or [] if p.get("thumb_path"))
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
    return removed


def _fetch(url, timeout, data=None, headers=None):
    """GET with a polite retry: Wikipedia answers bursts with 429.

    Passing `data` makes it a POST, which is the only way to talk to IGDB: it
    speaks Apicalypse, a query language sent as the request body.
    """
    req = urllib.request.Request(
        url, data=data, headers={"User-Agent": USER_AGENT, **(headers or {})}
    )
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:
            if e.code != 429 or attempt == 3:
                raise
            time.sleep(1.5 * (attempt + 1))


def _get_json(url, timeout=6):
    return json.loads(_fetch(url, timeout).decode("utf-8"))


def _download(url, dest, box, timeout=10):
    """Fetch artwork and leave it no larger than the desktop will draw it.

    Providers are asked for the smallest file that still covers `box` where they
    offer a choice, but several only publish the full-resolution original, so
    the shrink after the download is the guarantee rather than the fallback.
    """
    data = _fetch(url, timeout)
    with open(dest, "wb") as f:
        f.write(data)
    fit_image(dest, box)
    return dest


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
    piece of shared state below it — the record index, the IGDB token, the
    one-shot warning — is taken under `_lock`."""

    def __init__(self, online=True, providers=None, tmdb_key=None):
        self.online = online
        self.providers = dict(DEFAULT_PROVIDER)
        for kind, name in (providers or {}).items():
            if name in PROVIDERS.get(kind, ()):
                self.providers[kind] = name
        self.tmdb_key = (tmdb_key or os.environ.get("GNOMEFLIX_TMDB_KEY") or "").strip()
        self.igdb_id = (os.environ.get("GNOMEFLIX_IGDB_CLIENT_ID") or "").strip()
        self.igdb_secret = (os.environ.get("GNOMEFLIX_IGDB_CLIENT_SECRET") or "").strip()
        self._igdb_token = None       # (value, expiry); minted once per run
        self._warned_no_key = False
        self._lock = threading.Lock()
        self._igdb_lock = threading.Lock()
        self._index = self._load_index()
        self._unflushed = 0

    def provider_for(self, kind):
        """The provider that will actually run: TMDB needs a key to be usable."""
        name = self.providers.get(kind, DEFAULT_PROVIDER.get(kind))
        if name == "tmdb" and not self.tmdb_key:
            with self._lock:
                warn = not self._warned_no_key
                self._warned_no_key = True
            if warn:
                print("TMDB selected but no API key is set; using Wikipedia instead.")
            return "wikipedia"
        return name

    def provider_for_item(self, item):
        """The provider for one item, or None when nothing can answer for it.

        Every other kind is decided by a preference. A game is decided by the
        item: a Steam app has a store record and an artwork CDN of its own, and
        a PS2 disc image has neither — IGDB is the only source that knows it,
        and only when the Twitch credentials are set.
        """
        kind = item["kind"]
        if kind != "game":
            return self.provider_for(kind)
        if item.get("platform") == "steam":
            return "steam"
        return "igdb" if (self.igdb_id and self.igdb_secret) else None

    # -- cache helpers ---------------------------------------------------
    def _load_index(self):
        try:
            with open(METADATA_INDEX, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    def _paths(self, item):
        # TV shows keep the unprefixed names the first release used, so posters
        # already on disk are not fetched twice.
        prefix = "" if item["kind"] == "tv" else f"{item['kind']}_"
        safe = re.sub(r"[^a-zA-Z0-9_]", "", f"{prefix}{item['id']}")
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

    def _apply_cached(self, item, provider, key, poster_file, backdrop_file):
        data = self._record(key)
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

    def _save(self, item, provider, key):
        record = {field: item.get(field) for field in CACHED_FIELDS}
        record["genres"] = item.get("genres") or []
        record["provider"] = provider
        with self._lock:
            self._index[key] = record
            self._unflushed += 1
            due = self._unflushed >= INDEX_FLUSH_EVERY
        if due:
            self.flush()

    def flush(self):
        """Write the record index out. Atomic, so a scan killed mid-write
        leaves the previous index rather than a truncated one."""
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
        """Fill summary/genres/rating/artwork in place, from cache or online."""
        kind = item["kind"]
        provider = self.provider_for_item(item)
        if provider is None:
            return
        key, poster_file, backdrop_file = self._paths(item)
        if self._apply_cached(item, provider, key, poster_file, backdrop_file):
            return
        if not self.online:
            return

        lookup = {
            ("tv", "tvmaze"): self._tvmaze,
            ("tv", "tmdb"): lambda it: self._tmdb(it, "tv"),
            ("tv", "wikipedia"): lambda it: self._wikipedia(it, "tv"),
            ("film", "tmdb"): lambda it: self._tmdb(it, "movie"),
            ("film", "wikipedia"): lambda it: self._wikipedia(it, "film"),
            ("album", "itunes"): lambda it: self._itunes(it, "album"),
            ("game", "steam"): self._steam,
            ("game", "igdb"): self._igdb,
        }.get((kind, provider))
        if lookup is None:
            return

        try:
            art = lookup(item) or {}
        except Exception as e:  # network errors, odd JSON, anything
            print(f"{provider} lookup failed for '{item['title']}': {e}")
            return
        if isinstance(art, str):  # providers that only know a poster
            art = {"poster": art}

        if art.get("poster") and not item.get("poster_path"):
            try:
                item["poster_path"] = _download(art["poster"], poster_file, POSTER_BOX)
            except Exception as e:
                print(f"Artwork download failed for '{item['title']}': {e}")
        if art.get("backdrop"):
            try:
                item["backdrop_path"] = _download(art["backdrop"], backdrop_file, BACKDROP_BOX)
            except Exception as e:
                print(f"Backdrop download failed for '{item['title']}': {e}")
        item["provider"] = provider
        self._save(item, provider, key)

    # -- providers -------------------------------------------------------
    def _tvmaze(self, show):
        q = urllib.parse.quote(clean_query(show["title"], "tv"))
        results = _get_json(f"https://api.tvmaze.com/search/shows?q={q}")
        if not results:
            return None
        data = results[0].get("show", {})
        show["summary"] = _strip_html(data.get("summary"))
        show["genres"] = data.get("genres", []) or []
        show["rating"] = (data.get("rating") or {}).get("average")
        premiered = data.get("premiered") or ""
        if not show.get("year") and premiered[:4].isdigit():
            show["year"] = int(premiered[:4])
        image = data.get("image") or {}
        return image.get("original") or image.get("medium")

    def _tmdb(self, item, media):
        """Poster, backdrop, synopsis, tagline, genres, runtime and rating from
        The Movie Database. `media` is "movie" or "tv"."""
        query = clean_query(item["title"], "film" if media == "movie" else "tv")
        params = {"api_key": self.tmdb_key, "query": query, "include_adult": "false"}
        year = item.get("year")
        if year:
            params["year" if media == "movie" else "first_air_date_year"] = str(year)

        def search():
            url = f"{TMDB_API}/search/{media}?{urllib.parse.urlencode(params)}"
            return _get_json(url).get("results") or []

        results = search()
        if not results and year:  # the folder's year may be off by one
            params.pop("year", None)
            params.pop("first_air_date_year", None)
            results = search()
        if not results:
            return None

        best = results[0]
        details = _get_json(f"{TMDB_API}/{media}/{best['id']}?api_key={self.tmdb_key}")
        item["summary"] = details.get("overview") or best.get("overview") or None
        item["tagline"] = details.get("tagline") or None
        item["genres"] = [g["name"] for g in details.get("genres") or [] if g.get("name")]
        vote = details.get("vote_average")
        item["rating"] = round(vote, 1) if vote else None
        if media == "movie":
            item["runtime"] = details.get("runtime") or None
            date = details.get("release_date") or ""
        else:
            run = details.get("episode_run_time") or []
            item["runtime"] = run[0] if run else None
            item["seasons"] = details.get("number_of_seasons")
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
        film["summary"] = extract
        m = re.search(r"\b(\d{4})\b", summary.get("description") or "")
        if not film.get("year") and m:
            film["year"] = int(m.group(1))
        image = summary.get("originalimage") or summary.get("thumbnail") or {}
        return image.get("source")

    def _itunes(self, item, entity):
        query = clean_query(item["title"], "album")
        if entity == "album" and item.get("artist"):
            query = f"{item['artist']} {query}"
        q = urllib.parse.quote(query)
        data = _get_json(f"https://itunes.apple.com/search?term={q}&entity={entity}&limit=5")
        results = data.get("results") or []
        if not results:
            return None

        # Prefer the result whose release year matches the folder name.
        year = item.get("year")
        best = results[0]
        if year:
            for r in results:
                if str(r.get("releaseDate", ""))[:4] == str(year):
                    best = r
                    break

        if entity == "movie":
            item["summary"] = best.get("longDescription") or best.get("shortDescription")
            genre = best.get("primaryGenreName")
            item["genres"] = [genre] if genre else []
            millis = best.get("trackTimeMillis")
            item["runtime"] = round(millis / 60000) if millis else None
        else:
            item["artist"] = item.get("artist") or best.get("artistName")
            genre = best.get("primaryGenreName")
            item["genres"] = [genre] if genre else []
            if not item.get("summary"):
                count = best.get("trackCount")
                item["summary"] = f"{count} tracks" if count else None
        release = str(best.get("releaseDate", ""))[:4]
        if not item.get("year") and release.isdigit():
            item["year"] = int(release)

        art = best.get("artworkUrl100")
        return art.replace("100x100bb", "600x600bb") if art else None


    def _steam(self, item):
        """A Steam app, from Valve's own keyless endpoints.

        The store record (synopsis, genres, release year, Metacritic score) and
        the library art come from two different hosts, and neither takes a key
        or a session. Artwork is only asked for when the local client has not
        already cached it: the scanner fills poster_path/backdrop_path from
        appcache/librarycache first, and that cache is lazy — the client
        downloads only what it has had to draw — so the CDN covers the rest.
        """
        appid = str(item.get("app_id") or "").strip()
        if not appid:
            return None

        try:
            record = _get_json(f"{STEAM_STORE_API}?appids={appid}&l=english", timeout=8).get(appid) or {}
        except Exception as e:
            print(f"Steam store lookup failed for '{item['title']}': {e}")
            record = {}
        data = record.get("data") or {} if record.get("success") else {}
        if data:
            item["summary"] = _strip_html(data.get("short_description") or data.get("about_the_game"))
            item["genres"] = [g["description"] for g in data.get("genres") or [] if g.get("description")]
            score = (data.get("metacritic") or {}).get("score")
            # The rest of the library rates out of 10; Metacritic rates out of 100.
            item["rating"] = round(score / 10, 1) if score else None
            released = (data.get("release_date") or {}).get("date") or ""
            year = re.search(r"\b(\d{4})\b", released)
            if not item.get("year") and year:
                item["year"] = int(year.group(1))

        art = {}
        if not item.get("poster_path"):
            art["poster"] = f"{STEAM_CDN}/{appid}/library_600x900.jpg"
        if not item.get("backdrop_path"):
            art["backdrop"] = f"{STEAM_CDN}/{appid}/library_hero.jpg"
        return art

    def _igdb_access_token(self):
        """The Twitch app access token, minted once per run.

        Tokens are good for weeks, so one scan needs exactly one. The lock is
        held across the exchange as well as the check, so a pool of workers all
        reaching PS2 games at once still mints a single token between them.
        None on any failure — an unreachable IGDB must leave the PS2 games with
        the drawn placeholder, not stop the scan.
        """
        with self._igdb_lock:
            return self._igdb_access_token_locked()

    def _igdb_access_token_locked(self):
        if self._igdb_token and time.time() < self._igdb_token[1]:
            return self._igdb_token[0]
        params = urllib.parse.urlencode({
            "client_id": self.igdb_id,
            "client_secret": self.igdb_secret,
            "grant_type": "client_credentials",
        })
        try:
            data = json.loads(_fetch(f"{IGDB_TOKEN_URL}?{params}", 10, data=b"").decode("utf-8"))
        except Exception as e:
            print(f"IGDB authentication failed: {e}")  # never the credentials themselves
            return None
        value = data.get("access_token")
        if not value:
            return None
        # A minute of headroom, so a token cannot expire mid-request.
        self._igdb_token = (value, time.time() + max(0, int(data.get("expires_in") or 3600) - 60))
        return value

    def _igdb(self, item):
        """A PS2 game from IGDB: cover, synopsis, genres, rating and year.

        IGDB speaks Apicalypse — one POST body, one round trip for the whole
        record. The search is pinned to the PlayStation 2 platform so a
        remake on another console cannot outrank the disc actually on disk.
        """
        token = self._igdb_access_token()
        if not token:
            return None
        query = clean_query(item["title"], "game").replace('"', "")
        body = (
            f'search "{query}"; '
            "fields name,summary,storyline,first_release_date,total_rating,genres.name,"
            "cover.image_id,artworks.image_id,screenshots.image_id; "
            f"where platforms = ({IGDB_PS2_PLATFORM}); limit 5;"
        )
        raw = _fetch(
            f"{IGDB_API}/games", 10,
            data=body.encode("utf-8"),
            headers={"Client-ID": self.igdb_id, "Authorization": f"Bearer {token}", "Accept": "application/json"},
        )
        results = json.loads(raw.decode("utf-8")) or []
        if not results:
            return None

        best = results[0]
        item["summary"] = best.get("summary") or best.get("storyline") or None
        item["genres"] = [g["name"] for g in best.get("genres") or [] if g.get("name")]
        rating = best.get("total_rating")
        item["rating"] = round(rating / 10, 1) if rating else None
        released = best.get("first_release_date")
        if not item.get("year") and released:
            item["year"] = int(time.strftime("%Y", time.gmtime(released)))

        cover = (best.get("cover") or {}).get("image_id")
        wide = next(
            (w.get("image_id") for w in (best.get("artworks") or []) + (best.get("screenshots") or []) if w.get("image_id")),
            None,
        )
        return {
            "poster": f"{IGDB_IMAGE}/t_cover_big/{cover}.jpg" if cover else None,
            "backdrop": f"{IGDB_IMAGE}/t_1080p/{wide}.jpg" if wide else None,
        }


# --------------------------------------------------------------------------
# Photo thumbnails
# --------------------------------------------------------------------------
def make_thumbnailer():
    """Return a callable path -> thumbnail path, or None if nothing can scale images.

    The thumbnail is the only thing the shell is ever pointed at for a photo:
    failing back to the photo itself would put a full-resolution decode, of a
    file that may be on a network mount, on the compositor thread.
    """
    if _scaler() is None:
        return None

    from media_scanner import path_key

    def thumbnail(path, mtime=None):
        # The caller has usually just stat'ed the file to sort by date; taking
        # its mtime saves stat'ing every photo in the library a second time.
        try:
            mtime = int(os.path.getmtime(path) if mtime is None else mtime)
        except OSError:
            return None
        dest = os.path.join(THUMB_CACHE_DIR, f"{path_key(path)}_{mtime}.jpg")
        return _cached_copy(dest) or fit_image(path, THUMB_BOX, dest)

    return thumbnail
