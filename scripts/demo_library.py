#!/usr/bin/env python3
"""A made-up library for screenshots: `demo_library.py CACHE_HOME`.

Writes CACHE_HOME/media-libraries/ exactly as the scanner would —
library.json, with posters and backdrops in its own posters/ and backdrops/
folders at the cache's own caps — but for shows and films that do not
exist, with artwork drawn here. The README's screenshots are of this rather
than of anyone's real library: nobody's collection goes into a public repo,
and nobody's artwork either.

`nested.sh start --demo` runs it and points the nested session's
XDG_CACHE_HOME at the result, so the extension reads it and nothing else.
The file paths inside are under /demo and are never opened.
"""
import json
import math
import os
import random
import sys
import time

try:
    from PIL import Image, ImageDraw, ImageFilter, ImageFont
except ImportError:
    sys.exit("demo_library.py needs Pillow (python-pillow).")

# The cache's own caps (backend/metadata.py POSTER_BOX, BACKDROP_BOX).
POSTER = (512, 768)
BACKDROP = (960, 540)
FONT = "/usr/share/fonts/Adwaita/AdwaitaSans-Regular.ttf"

# (title, year, rating, genres, palette, motif, summary)
SHOWS = [
    ("Harbour Lights", 2021, 8.4, ["Drama", "Mystery"], ("#0b2545", "#f4a259"), "sun",
     "A harbour pilot starts to notice that the ships she guides in are not always the ships that left."),
    ("The Northern Line", 2019, 7.9, ["Comedy", "Drama"], ("#1b1b3a", "#e84855"), "stripes",
     "Six strangers share the last train home every night, and slowly stop being strangers."),
    ("Paper Satellites", 2023, 8.1, ["Sci-Fi & Fantasy"], ("#10002b", "#7b2cbf"), "rings",
     "A school science club launches a cardboard probe and gets an answer back."),
    ("Saltmarsh", 2018, 7.6, ["Crime", "Drama"], ("#1d3b2a", "#a7c957"), "peaks",
     "A detective returns to the fen village she swore she would never see again."),
    ("Night Shift", 2020, 7.2, ["Drama"], ("#03045e", "#00b4d8"), "grid",
     "Life, death and bad coffee on the overnight ward of a city hospital."),
    ("Glasshouse", 2022, 8.7, ["Mystery", "Sci-Fi & Fantasy"], ("#073b3a", "#0b6e4f"), "moon",
     "Everyone in the botanical dome is keeping a secret, and the plants are listening."),
    ("The Cartographers", 2017, 8.0, ["Adventure", "Drama"], ("#3d2c2e", "#e0a458"), "peaks",
     "Two rival mapmakers are hired to chart the same island, from opposite ends."),
    ("Low Tide", 2024, 7.8, ["Drama"], ("#14213d", "#fca311"), "sun",
     "When the sea goes out further than it ever has, a coastal town finds what it buried."),
    ("Signal & Noise", 2021, 8.2, ["Sci-Fi & Fantasy", "Mystery"], ("#212529", "#ff006e"), "stripes",
     "A radio astronomer hears a pattern in the static that only she can decode."),
    ("Hollow Pines", 2016, 7.4, ["Mystery"], ("#132a13", "#90a955"), "peaks",
     "A summer camp reopens thirty years after the season nobody talks about."),
    ("Afterglow", 2023, 8.5, ["Animation", "Drama"], ("#240046", "#ff9e00"), "sun",
     "A lighthouse keeper's daughter paints the sunsets that keep a whole town going."),
    ("Copper Coast", 2020, 7.7, ["Comedy"], ("#2b2d42", "#ef8354"), "grid",
     "The worst hotel on the coast gets a new manager who is determined to make it the second worst."),
    ("The Long Winter", 2015, 8.3, ["Drama", "History"], ("#0d1b2a", "#e0e1dd"), "moon",
     "An Arctic research station is cut off for a season, and the season keeps getting longer."),
    ("Static Bloom", 2025, 7.9, ["Animation", "Sci-Fi & Fantasy"], ("#1a1423", "#b8f2e6"), "rings",
     "In a city run on radio, a girl who can hear flowers grow joins the repair crew."),
]

FILMS = [
    ("Midnight Orchard", 2022, 7.8, ["Drama", "Romance"], ("#1b263b", "#e76f51"), "moon", 112,
     "Some harvests happen after dark.",
     "Two estranged sisters return to their late father's orchard to pick one last crop."),
    ("The Last Ferry", 2019, 7.1, ["Thriller"], ("#0b132b", "#5bc0be"), "stripes", 98,
     "Nine passengers. One crossing. No way back.",
     "A late-night crossing becomes a locked-room mystery when the captain disappears."),
    ("Wildfire Season", 2024, 7.6, ["Action", "Drama"], ("#370617", "#f48c06"), "peaks", 126,
     "Hold the line.",
     "A crew of smokejumpers races a fire that seems to know where they are going."),
    ("Parallel Lines", 2021, 8.0, ["Sci-Fi & Fantasy"], ("#0f0e17", "#ff8906"), "stripes", 118,
     "Every choice runs on its own track.",
     "A signal engineer finds a junction that switches between the lives she did not lead."),
    ("Quiet Machines", 2023, 7.4, ["Sci-Fi & Fantasy", "Drama"], ("#212529", "#4cc9f0"), "grid", 104,
     "They were built to listen.",
     "A repair robot on a deserted station starts keeping the diary its owners stopped writing."),
    ("Salt & Silver", 2018, 6.9, ["Adventure"], ("#003049", "#eae2b7"), "rings", 131,
     "Fortune favours the tide.",
     "A salvage diver and a forger chase a sunken fortune that someone keeps moving."),
    ("The Lantern Room", 2020, 7.9, ["Mystery", "Drama"], ("#231942", "#f9c74f"), "sun", 109,
     "The light has been left on for forty years.",
     "An archivist inherits a lighthouse and the letters its last keeper never sent."),
    ("Echo Valley", 2017, 7.3, ["Thriller", "Mystery"], ("#081c15", "#74c69d"), "peaks", 101,
     "Some voices answer back.",
     "Hikers in a remote valley hear their own voices call out before they have spoken."),
    ("Northbound", 2025, 8.2, ["Adventure", "Drama"], ("#0d1b2a", "#90e0ef"), "moon", 137,
     "Two thousand miles. One old truck.",
     "A retired long-haul driver takes her grandson on the route she drove for thirty years."),
]

EPISODE_WORDS = [
    "Arrival", "The Crossing", "Undertow", "First Light", "Old Friends", "The Map Room",
    "Static", "Harvest", "The Long Night", "Beacon", "Driftwood", "Echoes", "The Visitor",
    "Low Water", "Homecoming", "Paper Trail", "Nightfall", "The Signal", "Fault Lines",
    "Open Water", "The Archive", "Last Orders", "Thaw", "Northern Lights",
]


def rgb(hex_colour):
    h = hex_colour.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def mix(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient(size, top, bottom):
    w, h = size
    img = Image.new("RGB", size)
    draw = ImageDraw.Draw(img)
    for y in range(h):
        draw.line([(0, y), (w, y)], fill=mix(top, bottom, y / max(1, h - 1)))
    return img


def motif(img, kind, dark, light, seed):
    """The picture on the poster: a shape or two in the palette, soft-edged."""
    w, h = img.size
    rnd = random.Random(seed)
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    glow = light + (235,)
    faint = mix(dark, light, 0.35) + (150,)
    if kind == "sun":
        r = w * 0.32
        cx, cy = w * 0.5, h * 0.42
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=glow)
        for i in range(6):
            y = cy + r * 0.2 + i * r * 0.22
            d.rectangle([0, y, w, y + r * 0.08], fill=dark + (255,))
    elif kind == "rings":
        cx, cy = w * 0.5, h * 0.4
        for i in range(9, 0, -1):
            r = w * 0.06 * i
            d.ellipse([cx - r, cy - r, cx + r, cy + r],
                      outline=mix(dark, light, i / 9) + (255,), width=max(3, w // 90))
    elif kind == "peaks":
        base = h * 0.72
        for i in range(4):
            x = rnd.uniform(-0.2, 0.9) * w
            peak = rnd.uniform(0.25, 0.5) * h
            width = rnd.uniform(0.5, 0.9) * w
            colour = mix(dark, light, 0.25 + i * 0.18) + (255,)
            d.polygon([(x, base), (x + width / 2, peak), (x + width, base)], fill=colour)
        d.rectangle([0, base, w, h], fill=dark + (255,))
        d.ellipse([w * 0.66, h * 0.12, w * 0.8, h * 0.12 + w * 0.14], fill=glow)
    elif kind == "stripes":
        step = w // 7
        for i in range(-8, 16):
            x = i * step
            colour = (glow if i % 3 == 0 else faint)
            d.polygon([(x, 0), (x + step * 0.45, 0), (x + step * 0.45 - h * 0.6, h), (x - h * 0.6, h)], fill=colour)
    elif kind == "moon":
        r = w * 0.26
        cx, cy = w * 0.55, h * 0.33
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=glow)
        # Drawing replaces rather than blends, so a clear disc cuts the crescent.
        d.ellipse([cx - r * 0.55, cy - r * 1.05, cx + r * 1.35, cy + r * 0.85], fill=(0, 0, 0, 0))
        for _ in range(60):
            x, y = rnd.uniform(0, w), rnd.uniform(0, h * 0.7)
            s = rnd.uniform(1, 3)
            d.ellipse([x, y, x + s, y + s], fill=light + (200,))
    elif kind == "grid":
        gap = w / 9
        for gx in range(10):
            for gy in range(12):
                x, y = gx * gap, gy * gap
                dist = math.hypot(x - w * 0.5, y - h * 0.4) / w
                s = max(2, gap * 0.45 * (1 - dist))
                d.ellipse([x - s / 2, y - s / 2, x + s / 2, y + s / 2], fill=mix(dark, light, 1 - dist) + (255,))
    img.paste(layer, (0, 0), layer)
    return img


def fonts(size):
    try:
        face = ImageFont.truetype(FONT, size)
        try:
            face.set_variation_by_name("Black")
        except Exception:
            pass
        return face
    except OSError:
        return ImageFont.load_default(size)


def wrap(draw, text, face, width):
    words, lines, line = text.upper().split(), [], ""
    for word in words:
        trial = f"{line} {word}".strip()
        if draw.textlength(trial, font=face) <= width or not line:
            line = trial
        else:
            lines.append(line)
            line = word
    lines.append(line)
    return lines


def poster(path, title, year, palette, kind, seed):
    dark, light = rgb(palette[0]), rgb(palette[1])
    img = gradient(POSTER, dark, mix(dark, light, 0.35))
    img = motif(img, kind, dark, light, seed)
    # A darker foot for the title to stand on.
    foot = gradient((POSTER[0], POSTER[1] // 3), dark, mix(dark, (0, 0, 0), 0.5))
    mask = gradient((POSTER[0], POSTER[1] // 3), (0, 0, 0), (255, 255, 255)).convert("L")
    img.paste(foot, (0, POSTER[1] - POSTER[1] // 3), mask)
    draw = ImageDraw.Draw(img)
    # As large as the longest word allows.
    width = POSTER[0] - 64
    size = 58
    face = fonts(size)
    while size > 30 and max(draw.textlength(w, font=face) for w in title.upper().split()) > width:
        size -= 4
        face = fonts(size)
    lines = wrap(draw, title, face, width)
    step = round(size * 1.1)
    y = POSTER[1] - 70 - step * len(lines)
    for line in lines:
        x = (POSTER[0] - draw.textlength(line, font=face)) / 2
        draw.text((x, y), line, font=face, fill=(250, 250, 251))
        y += step
    small = fonts(24)
    label = str(year)
    draw.text(((POSTER[0] - draw.textlength(label, font=small)) / 2, POSTER[1] - 52),
              label, font=small, fill=mix(light, (250, 250, 251), 0.5))
    img.save(path, "JPEG", quality=88)


def backdrop(path, palette, kind, seed):
    dark, light = rgb(palette[0]), rgb(palette[1])
    img = gradient(BACKDROP, dark, mix(dark, light, 0.3))
    img = motif(img, kind, dark, light, seed).filter(ImageFilter.GaussianBlur(6))
    img.save(path, "JPEG", quality=85)


def slug(text):
    return "".join(c.lower() if c.isalnum() else "-" for c in text).strip("-")


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    root = os.path.join(os.path.abspath(sys.argv[1]), "media-libraries")
    posters = os.path.join(root, "posters")
    backdrops = os.path.join(root, "backdrops")
    for folder in (posters, backdrops):
        os.makedirs(folder, exist_ok=True)

    tv = []
    for n, (title, year, rating, genres, palette, kind, summary) in enumerate(SHOWS):
        rnd = random.Random(title)
        key = slug(title)
        poster_path = os.path.join(posters, f"tv_{key}.jpg")
        backdrop_path = os.path.join(backdrops, f"tv_{key}.jpg")
        poster(poster_path, title, year, palette, kind, n)
        backdrop(backdrop_path, palette, kind, n)
        episodes = []
        seasons = rnd.randint(1, 3)
        for season in range(1, seasons + 1):
            # A season's names drawn without repeats, as a real one would be.
            names = rnd.sample(EPISODE_WORDS, rnd.randint(6, 10))
            for number, name in enumerate(names, 1):
                stem = f"{title} - S{season:02}E{number:02} - {name}"
                episodes.append({
                    "title": stem,
                    "filename": f"{stem}.mkv",
                    "path": f"/demo/TV Shows/{title}/Season {season:02}/{stem}.mkv",
                    "group": None,
                    "has_subtitles": rnd.random() < 0.6,
                    "size_mb": round(rnd.uniform(240, 1400), 1),
                })
        tv.append({
            "id": key, "kind": "tv", "title": title, "year": year, "rating": rating,
            "genres": genres, "summary": summary, "provider": "demo",
            "poster_path": poster_path, "backdrop_path": backdrop_path,
            "folder_path": f"/demo/TV Shows/{title}",
            "episodes": episodes, "episode_count": len(episodes), "seasons": seasons,
            "runtime": None, "scan_sig": "demo",
        })

    films = []
    for n, (title, year, rating, genres, palette, kind, runtime, tagline, summary) in enumerate(FILMS):
        key = slug(title)
        poster_path = os.path.join(posters, f"film_{key}.jpg")
        backdrop_path = os.path.join(backdrops, f"film_{key}.jpg")
        poster(poster_path, title, year, palette, kind, 100 + n)
        backdrop(backdrop_path, palette, kind, 100 + n)
        stem = f"{title} ({year})"
        path = f"/demo/Films/{stem}/{stem}.mkv"
        films.append({
            "id": key, "kind": "film", "title": title, "year": year, "rating": rating,
            "genres": genres, "summary": summary, "tagline": tagline, "provider": "demo",
            "poster_path": poster_path, "backdrop_path": backdrop_path,
            "folder_path": f"/demo/Films/{stem}", "runtime": runtime,
            "files": [{"title": stem, "filename": f"{stem}.mkv", "path": path, "group": None,
                       "has_subtitles": True, "size_mb": round(runtime * 21.5, 1)}],
            "main_path": path, "scan_sig": "demo",
        })

    library = {"version": 2, "generated": time.time(),
               "sections": {"tv": tv, "films": films}, "scanned": {}}
    with open(os.path.join(root, "library.json"), "w", encoding="utf-8") as f:
        json.dump(library, f, indent=1)
    print(f"demo library: {len(tv)} shows, {len(films)} films in {root}")


if __name__ == "__main__":
    main()
