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
"""

import html
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

CACHE_DIR = os.path.expanduser("~/.cache/gnomeflix")
POSTER_CACHE_DIR = os.path.join(CACHE_DIR, "posters")
BACKDROP_CACHE_DIR = os.path.join(CACHE_DIR, "backdrops")
METADATA_CACHE_DIR = os.path.join(CACHE_DIR, "metadata")
THUMB_CACHE_DIR = os.path.join(CACHE_DIR, "thumbs")
USER_AGENT = "Gnomeflix/2.0"
THUMB_SIZE = 512

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


def _download(url, dest, timeout=10):
    data = _fetch(url, timeout)
    with open(dest, "wb") as f:
        f.write(data)
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

    def provider_for(self, kind):
        """The provider that will actually run: TMDB needs a key to be usable."""
        name = self.providers.get(kind, DEFAULT_PROVIDER.get(kind))
        if name == "tmdb" and not self.tmdb_key:
            if not self._warned_no_key:
                print("TMDB selected but no API key is set; using Wikipedia instead.")
                self._warned_no_key = True
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
    def _paths(self, item):
        # TV shows keep the unprefixed names the first release used, so posters
        # already on disk are not fetched twice.
        prefix = "" if item["kind"] == "tv" else f"{item['kind']}_"
        safe = re.sub(r"[^a-zA-Z0-9_]", "", f"{prefix}{item['id']}")
        return (
            os.path.join(METADATA_CACHE_DIR, f"{safe}.json"),
            os.path.join(POSTER_CACHE_DIR, f"{safe}.jpg"),
            os.path.join(BACKDROP_CACHE_DIR, f"{safe}.jpg"),
        )

    def _apply_cached(self, item, provider, meta_file, poster_file, backdrop_file):
        if not os.path.exists(meta_file):
            return False
        try:
            with open(meta_file, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            return False
        # Older caches lack these; a changed provider means fetch afresh.
        cached_by = data.get("provider") or LEGACY_PROVIDER.get(item["kind"])
        if "year" not in data or cached_by != provider:
            return False
        for key in CACHED_FIELDS:
            if data.get(key) is not None and item.get(key) in (None, [], ""):
                item[key] = data[key]
        if not item.get("poster_path"):
            if not os.path.exists(poster_file):
                return False  # text was cached but the artwork never arrived: retry
            item["poster_path"] = poster_file
        if os.path.exists(backdrop_file):
            item["backdrop_path"] = backdrop_file
        item["provider"] = cached_by
        return True

    def _save(self, item, provider, meta_file):
        record = {key: item.get(key) for key in CACHED_FIELDS}
        record["genres"] = item.get("genres") or []
        record["provider"] = provider
        try:
            with open(meta_file, "w", encoding="utf-8") as f:
                json.dump(record, f, indent=2)
        except OSError:
            pass

    # -- public ----------------------------------------------------------
    def enrich(self, item):
        """Fill summary/genres/rating/artwork in place, from cache or online."""
        kind = item["kind"]
        provider = self.provider_for_item(item)
        if provider is None:
            return
        meta_file, poster_file, backdrop_file = self._paths(item)
        if self._apply_cached(item, provider, meta_file, poster_file, backdrop_file):
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
                item["poster_path"] = _download(art["poster"], poster_file)
            except Exception as e:
                print(f"Artwork download failed for '{item['title']}': {e}")
        if art.get("backdrop"):
            try:
                item["backdrop_path"] = _download(art["backdrop"], backdrop_file)
            except Exception as e:
                print(f"Backdrop download failed for '{item['title']}': {e}")
        item["provider"] = provider
        self._save(item, provider, meta_file)

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
        results = _get_json(f"{TMDB_API}/search/{media}?{urllib.parse.urlencode(params)}").get("results") or []
        if not results and year:  # the folder's year may be off by one
            params.pop("year", None)
            params.pop("first_air_date_year", None)
            results = _get_json(f"{TMDB_API}/search/{media}?{urllib.parse.urlencode(params)}").get("results") or []
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

        Tokens are good for weeks, so one scan needs exactly one. None on any
        failure — an unreachable IGDB must leave the PS2 games with the drawn
        placeholder, not stop the scan.
        """
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
    """Return a callable path -> thumbnail path, or None if nothing can scale images."""
    Image = GdkPixbuf = None
    try:
        from PIL import Image
    except ImportError:
        try:
            import gi
            gi.require_version("GdkPixbuf", "2.0")
            from gi.repository import GdkPixbuf
        except (ImportError, ValueError):
            return None

    from media_scanner import path_key

    def thumbnail(path):
        try:
            mtime = int(os.path.getmtime(path))
        except OSError:
            return path
        dest = os.path.join(THUMB_CACHE_DIR, f"{path_key(path)}_{mtime}.jpg")
        if os.path.exists(dest):
            return dest
        try:
            if Image is not None:
                from PIL import ImageOps
                img = ImageOps.exif_transpose(Image.open(path))
                img.thumbnail((THUMB_SIZE, THUMB_SIZE))
                img.convert("RGB").save(dest, "JPEG", quality=88)
            else:
                pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, THUMB_SIZE, THUMB_SIZE, True)
                pb = pb.apply_embedded_orientation() or pb
                if pb.get_has_alpha():
                    dest = dest[:-4] + ".png"
                    pb.savev(dest, "png", [], [])
                else:
                    pb.savev(dest, "jpeg", ["quality"], ["88"])
            return dest
        except Exception as e:
            print(f"Thumbnail failed for {path}: {e}")
            return path

    return thumbnail
