// Reads ~/.cache/media-libraries/library.json (written by backend/scan_library.py)
// and normalises TV shows and films into one shape the views can render:
//
//   item = {
//     id, kind, title, year, rating, tags, summary, tagline, art, backdrop, folder,
//     countLabel,               // "141 episodes", "112 min"
//     playPath, playLabel,      // what the primary button opens
//     groups: [{name, entries: [{title, subtitle, path, badges}]}],
//   }

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const SECTIONS = [
    {
        key: 'tv',
        prefix: 'tv-shows',
        title: 'TV Shows',
        icon: 'tv-symbolic',
        aspect: 1.5,
        watched: true,
        emptyHint: 'Add a folder with one subfolder per show in Settings.',
    },
    {
        key: 'films',
        prefix: 'films',
        title: 'Films',
        icon: 'video-x-generic-symbolic',
        aspect: 1.5,
        watched: true,
        emptyHint: 'Add a folder with one subfolder or file per film in Settings.',
    },
];

// The library as a whole: what its one button beside Show Apps is called and
// shows. The sections are its tabs.
export const LIBRARY = {
    title: 'Videos',
    icon: 'folder-videos-symbolic',
};

export function sectionByKey(key) {
    return SECTIONS.find(s => s.key === key) ?? SECTIONS[0];
}

// The setting that names what a section's files open with.
export function openCommandKey(section) {
    return `${section.prefix}-open-command`;
}

// Earlier releases kept one player command for every video. It is moved into
// the TV shows and films commands once, here, by whichever of the extension
// and the preferences runs first, and nothing reads the old key after that.
export function migrateOpenCommand(settings) {
    const legacy = settings.get_string('player-command');
    if (!legacy)
        return;
    // Not set by the user, rather than empty: the video commands have a
    // default of their own, and an empty one is a choice.
    for (const key of ['tv-shows-open-command', 'films-open-command']) {
        if (settings.get_user_value(key) === null)
            settings.set_string(key, legacy);
    }
    settings.set_string('player-command', '');
}

function cacheDir() {
    return GLib.build_filenamev([GLib.get_user_cache_dir(), 'media-libraries']);
}

export function libraryPath() {
    return GLib.build_filenamev([cacheDir(), 'library.json']);
}

// The file as the scanner wrote it: the raw per-section arrays and when it ran.
export function readSections() {
    const nothing = {sections: {}, generated: null};
    const path = libraryPath();
    if (!GLib.file_test(path, GLib.FileTest.EXISTS))
        return nothing;
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok)
            return nothing;
        const raw = JSON.parse(new TextDecoder('utf-8').decode(bytes));
        return {sections: raw?.sections ?? {}, generated: raw?.generated ?? null};
    } catch (e) {
        console.error(`[Media Libraries] Failed to read ${path}: ${e}`);
        return nothing;
    }
}

// Returns {tv: [...], films: [...]} of normalised items. Missing or unreadable
// files yield empty sections, never fake data.
export function loadLibrary() {
    const empty = Object.fromEntries(SECTIONS.map(s => [s.key, []]));
    const {sections} = readSections();
    const art = artworkIndex();
    const out = {...empty};
    for (const section of SECTIONS) {
        const items = sections[section.key];
        if (Array.isArray(items))
            out[section.key] = items.map(item => normalize(item, section.key, art)).filter(Boolean);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Is the artwork still there?
//
// A path in library.json can outlive the file it names — a cleared cache — and
// St paints a missing background image as nothing at all, so the drawn
// placeholder would never get its turn. Checking costs a blocking stat per
// item, though, and this runs on the compositor's main loop for every item in
// every section, twice.
//
// Every one of those paths is the scanner's own, in two cache folders: it
// copies a cover.jpg it finds beside the media in with the rest, scaled to
// what the desktop draws. So the folders are listed once and the check is a
// lookup. A path from anywhere else counts as missing rather than earning a
// stat of its own — the media can be on a share that has gone to sleep, and
// one stat of that is the desktop standing still until it wakes.
// ---------------------------------------------------------------------------
const ART_DIRS = ['posters', 'backdrops'];

function listNames(path) {
    const names = new Set();
    let children;
    try {
        children = Gio.File.new_for_path(path).enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    } catch (e) {
        return names;   // the folder is not there yet: nothing is cached
    }
    let info;
    while ((info = children.next_file(null)) !== null)
        names.add(info.get_name());
    children.close(null);
    return names;
}

function artworkIndex() {
    const root = cacheDir();
    const index = new Map();
    for (const name of ART_DIRS) {
        const dir = GLib.build_filenamev([root, name]);
        index.set(dir, listNames(dir));
    }
    return index;
}

function exists(path, art) {
    if (!path)
        return false;
    const cut = path.lastIndexOf('/');
    return art.get(path.slice(0, cut))?.has(path.slice(cut + 1)) ?? false;
}

function plural(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function normalize(item, sectionKey, art) {
    if (!item || !item.title)
        return null;
    const base = {
        id: item.id ?? item.title,
        kind: sectionKey,
        title: item.title,
        year: item.year ?? null,
        rating: item.rating ?? null,
        tags: Array.isArray(item.genres) ? item.genres.slice(0, 3) : [],
        summary: item.summary ?? null,
        art: exists(item.poster_path, art) ? item.poster_path : null,
        backdrop: exists(item.backdrop_path, art) ? item.backdrop_path : null,
        tagline: item.tagline ?? null,
        folder: item.folder_path ?? null,
    };
    switch (sectionKey) {
    case 'tv': return normalizeShow(item, base);
    case 'films': return normalizeFilm(item, base);
    default: return null;
    }
}

// ---------------------------------------------------------------------------
// TV
// ---------------------------------------------------------------------------

// "Season 3" -> 3, null for named groups such as "Extras" or "OVA".
function seasonNumberOf(name) {
    const m = String(name).match(/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
}

const EPISODE_TAG = /S(\d+)\s*E(\d+)/i;

// "Black Clover - S01E01 - Asta and Yuno" -> "Asta and Yuno". Falls back to
// the input when nothing readable is left.
function episodeTitle(raw) {
    const stripped = raw
        .replace(/^\[[^\]]*\]\s*/, '')
        .replace(/^.*?S\d+\s*E\d+\s*[-–—.:]?\s*/i, '')
        .trim();
    return stripped || raw;
}

function normalizeShow(show, base) {
    const episodes = Array.isArray(show.episodes) ? show.episodes : [];
    const bySeason = new Map();

    for (const ep of episodes) {
        let season = 'Season 1';
        const title = ep.title || '';
        if (title.startsWith('[') && title.includes(']')) {
            season = title.slice(1, title.indexOf(']')).trim();
        } else {
            const m = (ep.filename || '').match(/S(\d+)/i);
            if (m)
                season = `Season ${parseInt(m[1], 10)}`;
        }
        if (!bySeason.has(season))
            bySeason.set(season, []);
        bySeason.get(season).push(ep);
    }

    // Numeric seasons in order, then named groups (Extras, OVA) alphabetically.
    const names = [...bySeason.keys()].sort((a, b) => {
        const na = seasonNumberOf(a), nb = seasonNumberOf(b);
        if (na !== null && nb !== null) return na - nb;
        if (na !== null) return -1;
        if (nb !== null) return 1;
        return a.localeCompare(b);
    });

    const groups = names.map(name => ({
        name,
        // A numbered season is part of the run the Continue button walks;
        // Extras and the like are not.
        season: seasonNumberOf(name) !== null,
        entries: bySeason.get(name).map((ep, i) => {
            const tag = (ep.filename || '').match(EPISODE_TAG);
            return {
                index: tag ? parseInt(tag[2], 10) : i + 1,
                title: episodeTitle(ep.title || ep.filename || ''),
                // The row says which episode with its number, under the
                // season's tab; the code is for the Play button alone.
                subtitle: null,
                code: tag ? `S${tag[1].padStart(2, '0')}E${tag[2].padStart(2, '0')}` : null,
                path: ep.path,
                badges: ep.has_subtitles ? ['SUB'] : [],
                size: ep.size_mb ? `${ep.size_mb} MB` : null,
            };
        }),
    }));

    // Start from the first numbered season, not whatever sorts first on disk
    // (an "Extras" folder would otherwise win).
    const first = groups[0]?.entries[0] ?? null;
    return {
        ...base,
        countLabel: plural(episodes.length, 'episode'),
        groups,
        groupLabel: groups.length === 1 ? null : `${groups.length} seasons`,
        playPath: first?.path ?? null,
        playLabel: first?.code ? `Play ${first.code}` : 'Play',
    };
}

// ---------------------------------------------------------------------------
// Films
// ---------------------------------------------------------------------------
function normalizeFilm(film, base) {
    const files = Array.isArray(film.files) ? film.files : [];
    const entries = files.map((f, i) => ({
        index: i + 1,
        title: f.title || f.filename,
        subtitle: f.group ?? null,
        path: f.path,
        badges: f.has_subtitles ? ['SUB'] : [],
        size: f.size_mb ? `${f.size_mb} MB` : null,
    }));
    const runtime = film.runtime ? `${film.runtime} min` : null;
    return {
        ...base,
        countLabel: runtime ?? (files.length > 1 ? plural(files.length, 'file') : null),
        groups: [{name: files.length > 1 ? 'Files' : 'File', entries}],
        groupLabel: null,
        playPath: film.main_path ?? files[0]?.path ?? null,
        playLabel: 'Play',
    };
}
