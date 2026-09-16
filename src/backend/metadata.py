import os
import re
import json
import urllib.request
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

CACHE_DIR = os.path.expanduser("~/.cache/gnomeflix")
POSTER_CACHE_DIR = os.path.join(CACHE_DIR, "posters")
METADATA_CACHE_DIR = os.path.join(CACHE_DIR, "metadata")

os.makedirs(POSTER_CACHE_DIR, exist_ok=True)
os.makedirs(METADATA_CACHE_DIR, exist_ok=True)

class MetadataService:
    def __init__(self, on_update_callback=None):
        self.on_update_callback = on_update_callback
        self.executor = ThreadPoolExecutor(max_workers=4)

    def fetch_all(self, shows):
        """Asynchronously fetches metadata and posters for a list of shows."""
        for show in shows:
            self.executor.submit(self._fetch_show_worker, show)

    def _fetch_show_worker(self, show):
        show_id = show["id"]
        title = show["title"]
        safe_name = re.sub(r'[^a-zA-Z0-9_]', '', show_id)
        
        poster_file = os.path.join(POSTER_CACHE_DIR, f"{safe_name}.jpg")
        meta_file = os.path.join(METADATA_CACHE_DIR, f"{safe_name}.json")
        svg_fallback = os.path.join(POSTER_CACHE_DIR, f"{safe_name}_fallback.svg")

        # 1. Check if cached metadata and poster already exist
        if os.path.exists(meta_file) and (os.path.exists(poster_file) or os.path.exists(svg_fallback)):
            try:
                with open(meta_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    show["summary"] = data.get("summary")
                    show["genres"] = data.get("genres", [])
                    show["rating"] = data.get("rating")
                    if os.path.exists(poster_file):
                        show["poster_path"] = poster_file
                    else:
                        show["poster_path"] = svg_fallback
                if self.on_update_callback:
                    self.on_update_callback(show)
                return
            except Exception:
                pass

        # 2. Clean query name
        # E.g. "Boruto Kai" -> "Boruto", "Frieren - Beyond Journeys End" -> "Frieren"
        clean_name = re.sub(r'\bKai\b', '', title, flags=re.IGNORECASE)
        clean_name = re.sub(r'ReZERO', 'Re:Zero', clean_name, flags=re.IGNORECASE)
        clean_name = clean_name.split(' - ')[0].strip()
        # Clean extra subtitle info like "(2024)"
        clean_name = re.sub(r'\s*\(\d{4}\)', '', clean_name).strip()

        api_url = f"https://api.tvmaze.com/search/shows?q={urllib.parse.quote(clean_name)}"
        img_url = None
        summary = None
        genres = []
        rating = None

        try:
            req = urllib.request.Request(api_url, headers={'User-Agent': 'Gnomeflix/1.0'})
            with urllib.request.urlopen(req, timeout=5) as resp:
                results = json.loads(resp.read().decode('utf-8'))
                if results and len(results) > 0:
                    show_data = results[0].get("show", {})
                    # Clean HTML tags from summary
                    raw_sum = show_data.get("summary", "")
                    if raw_sum:
                        summary = re.sub(r'<[^>]+>', '', raw_sum).strip()
                    genres = show_data.get("genres", [])
                    rating_dict = show_data.get("rating", {})
                    rating = rating_dict.get("average")
                    
                    img_dict = show_data.get("image", {})
                    if img_dict:
                        img_url = img_dict.get("original") or img_dict.get("medium")
        except Exception as e:
            print(f"Metadata lookup error for '{title}': {e}")

        # 3. Download poster image or create fallback SVG
        if img_url:
            try:
                img_req = urllib.request.Request(img_url, headers={'User-Agent': 'Gnomeflix/1.0'})
                with urllib.request.urlopen(img_req, timeout=8) as img_resp:
                    with open(poster_file, 'wb') as out_f:
                        out_f.write(img_resp.read())
                show["poster_path"] = poster_file
            except Exception as e:
                print(f"Error downloading poster for '{title}': {e}")
                self._generate_svg_poster(title, svg_fallback)
                show["poster_path"] = svg_fallback
        else:
            self._generate_svg_poster(title, svg_fallback)
            show["poster_path"] = svg_fallback

        show["summary"] = summary or f"Episodes and media collection for {title}."
        show["genres"] = genres
        show["rating"] = rating

        # Save metadata cache
        try:
            with open(meta_file, 'w', encoding='utf-8') as f:
                json.dump({
                    "summary": show["summary"],
                    "genres": show["genres"],
                    "rating": show["rating"]
                }, f, indent=2)
        except Exception:
            pass

        if self.on_update_callback:
            self.on_update_callback(show)

    def _generate_svg_poster(self, title, output_path):
        """Generates a modern SVG card poster placeholder."""
        # Pick background accent color based on title hash
        colors = [
            ("#1e1e2e", "#313244", "#cba6f7"),
            ("#1a1b26", "#24283b", "#7aa2f7"),
            ("#282828", "#3c3836", "#fabd2f"),
            ("#181825", "#313244", "#f38ba8"),
            ("#1e1e2e", "#45475a", "#89b4fa"),
        ]
        h = sum(ord(c) for c in title) % len(colors)
        bg1, bg2, accent = colors[h]
        
        # Shorten title for SVG display
        display_title = title if len(title) <= 24 else title[:22] + "..."

        svg = f"""<svg width="240" height="360" viewBox="0 0 240 360" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:{bg1};stop-opacity:1" />
      <stop offset="100%" style="stop-color:{bg2};stop-opacity:1" />
    </linearGradient>
  </defs>
  <rect width="240" height="360" rx="16" fill="url(#grad)"/>
  <circle cx="120" cy="140" r="46" fill="{accent}" fill-opacity="0.2"/>
  <path d="M106 116 L144 140 L106 164 Z" fill="{accent}"/>
  <text x="120" y="240" font-family="system-ui, sans-serif" font-size="14" font-weight="bold" fill="#cdd6f4" text-anchor="middle">
    {display_title}
  </text>
  <text x="120" y="265" font-family="system-ui, sans-serif" font-size="11" fill="#a6adc8" text-anchor="middle">
    TV Series
  </text>
</svg>"""
        with open(output_path, 'w', encoding='utf-8') as f:
            f.write(svg)
