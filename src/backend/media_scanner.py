import os
import re

DEFAULT_MEDIA_PATH = "/media/LENOVO/Videos/TV Shows"
FALLBACK_PATH = os.path.expanduser("~/Videos/TV Shows")

VIDEO_EXTENSIONS = {".mp4", ".mkv", ".avi", ".webm", ".m4v"}

def natural_sort_key(s):
    return [int(text) if text.isdigit() else text.lower() for text in re.split(r'(\d+)', s)]

class MediaScanner:
    def __init__(self, media_path=None):
        if media_path and os.path.exists(media_path):
            self.media_path = media_path
        elif os.path.exists(DEFAULT_MEDIA_PATH):
            self.media_path = DEFAULT_MEDIA_PATH
        elif os.path.exists(FALLBACK_PATH):
            self.media_path = FALLBACK_PATH
        else:
            self.media_path = None

    def scan_shows(self):
        """Scans the media directory and returns a list of TV show dicts."""
        if not self.media_path or not os.path.exists(self.media_path):
            return self._get_mock_shows()

        shows = []
        try:
            entries = os.listdir(self.media_path)
        except Exception as e:
            print(f"Error reading media directory {self.media_path}: {e}")
            return self._get_mock_shows()

        for name in sorted(entries):
            full_path = os.path.join(self.media_path, name)
            if not os.path.isdir(full_path) or name.startswith('.'):
                continue

            episodes = self._scan_episodes(full_path)
            show_id = re.sub(r'[^a-zA-Z0-9]', '_', name.lower())

            shows.append({
                "id": show_id,
                "title": name,
                "folder_path": full_path,
                "episodes": episodes,
                "episode_count": len(episodes),
                "poster_path": None,
                "summary": None,
                "genres": [],
                "rating": None,
            })

        return shows if shows else self._get_mock_shows()

    def _scan_episodes(self, folder_path):
        episodes = []

        # Recursively walk the show folder to support Season 1, Season 2, Extras subdirectories
        for root, _, files in os.walk(folder_path):
            # Find subtitle files in this subdirectory
            sub_files = {
                os.path.splitext(f)[0].lower()
                for f in files
                if f.endswith('.srt') or f.endswith('.vtt') or f.endswith('.ass')
            }

            for fname in files:
                ext = os.path.splitext(fname)[1].lower()
                if ext in VIDEO_EXTENSIONS:
                    fpath = os.path.join(root, fname)
                    base_name = os.path.splitext(fname)[0]

                    # Check for matching subtitle
                    has_sub = any(base_name.lower().startswith(sub_key.split('.')[0]) for sub_key in sub_files) or (base_name.lower() in sub_files)

                    # Subfolder name (e.g. Season 1)
                    rel_dir = os.path.relpath(root, folder_path)
                    display_prefix = f"[{rel_dir}] " if rel_dir != "." and not rel_dir.lower().startswith("season") else ""

                    size_mb = 0
                    try:
                        size_mb = round(os.path.getsize(fpath) / (1024 * 1024), 1)
                    except Exception:
                        pass

                    episodes.append({
                        "filename": fname,
                        "path": fpath,
                        "title": f"{display_prefix}{base_name}",
                        "has_subtitles": has_sub,
                        "size_mb": size_mb,
                        "sort_name": fname
                    })

        # Sort naturally by filename
        episodes.sort(key=lambda ep: natural_sort_key(ep["sort_name"]))
        return episodes

    def _get_mock_shows(self):
        """Fallback mock data if media drive is disconnected."""
        mock_titles = [
            "Solo Leveling",
            "Frieren - Beyond Journeys End",
            "Jujutsu Kaisen",
            "Black Clover",
            "Fire Force",
            "Mushoku Tensei Jobless Reincarnation",
            "Soul Eater",
            "That Time I Got Reincarnated as a Slime"
        ]
        return [
            {
                "id": re.sub(r'[^a-zA-Z0-9]', '_', t.lower()),
                "title": t,
                "folder_path": "",
                "episodes": [
                    {"filename": f"S01E{i:02d}.mp4", "path": "", "title": f"Episode {i}", "has_subtitles": True, "size_mb": 350.0}
                    for i in range(1, 13)
                ],
                "episode_count": 12,
                "poster_path": None,
                "summary": None,
                "genres": ["Action", "Adventure"],
                "rating": 8.5,
            }
            for t in mock_titles
        ]
