// Reads ~/.cache/gnomeflix/library.json (written by backend/scan_library.py)
// and normalises every media type into one shape the views can render:
//
//   item = {
//     id, kind, title, year, rating, tags, summary, tagline, art, backdrop, folder,
//     countLabel,               // "141 episodes", "12 tracks", "105 hours played"
//     playPath, playLabel,      // what the primary button opens
//     groups: [{name, entries: [{title, subtitle, path, badges, thumb}]}],
//     layout: 'list' | 'grid',  // how a group's entries are shown
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
        emptyHint: 'Add a folder with one subfolder per show in Settings.',
    },
    {
        key: 'films',
        prefix: 'films',
        title: 'Films',
        icon: 'video-x-generic-symbolic',
        aspect: 1.5,
        emptyHint: 'Add a folder with one subfolder or file per film in Settings.',
    },
    {
        key: 'music',
        prefix: 'music',
        title: 'Music',
        icon: 'audio-x-generic-symbolic',
        aspect: 1,
        emptyHint: 'Add a folder of albums in Settings.',
    },
    {
        key: 'photos',
        prefix: 'photos',
        title: 'Photos',
        icon: 'image-x-generic-symbolic',
        aspect: 1,
        emptyHint: 'Add a folder of photo albums in Settings.',
    },
    {
        key: 'documents',
        prefix: 'documents',
        title: 'Documents',
        icon: 'x-office-document-symbolic',
        aspect: 1.3,
        emptyHint: 'Add a folder of documents in Settings.',
    },
    {
        key: 'games',
        prefix: 'games',
        title: 'Games',
        icon: 'applications-games-symbolic',
        aspect: 1.5,
        emptyHint: 'Install a Steam game, or point PCSX2 at a folder of PS2 discs, then rescan in Settings.',
    },
];

export function sectionByKey(key) {
    return SECTIONS.find(s => s.key === key) ?? SECTIONS[0];
}

export function cacheDir() {
    return GLib.build_filenamev([GLib.get_user_cache_dir(), 'gnomeflix']);
}

export function libraryPath() {
    return GLib.build_filenamev([cacheDir(), 'library.json']);
}

// "141 in your library". The header and its static twin in the overview both
// say this, so they say it from one place.
export function libraryCountLabel(count) {
    return count ? `${count} in your library` : 'Nothing indexed yet';
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
        console.error(`[Gnomeflix] Failed to read ${path}: ${e}`);
        return nothing;
    }
}

// Returns {tv: [...], films: [...], music: [...], photos: [...]} of normalised
// items. Missing or unreadable files yield empty sections, never fake data.
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
// Every one of those paths is the scanner's own, in three cache folders: it
// copies a cover.jpg it finds beside the media in with the rest, scaled to
// what the desktop draws. So the folders are listed once and the check is a
// lookup. A path from anywhere else counts as missing rather than earning a
// stat of its own — the media can be on a share that has gone to sleep, and
// one stat of that is the desktop standing still until it wakes.
// ---------------------------------------------------------------------------
const ART_DIRS = ['posters', 'backdrops', 'thumbs'];

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
        layout: 'list',
    };
    switch (sectionKey) {
    case 'tv': return normalizeShow(item, base);
    case 'films': return normalizeFilm(item, base);
    case 'music': return normalizeAlbum(item, base);
    case 'photos': return normalizePhotoAlbum(item, base, art);
    case 'documents': return normalizeDocuments(item, base);
    case 'games': return normalizeGame(item, base);
    default: return null;
    }
}

// ---------------------------------------------------------------------------
// TV
// ---------------------------------------------------------------------------

// "Season 3" -> 3, null for named groups such as "Extras" or "OVA".
export function seasonNumberOf(name) {
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
        entries: bySeason.get(name).map((ep, i) => {
            const tag = (ep.filename || '').match(EPISODE_TAG);
            return {
                index: tag ? parseInt(tag[2], 10) : i + 1,
                title: episodeTitle(ep.title || ep.filename || ''),
                subtitle: tag ? `S${tag[1].padStart(2, '0')}E${tag[2].padStart(2, '0')}` : null,
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
        playLabel: first?.subtitle ? `Play ${first.subtitle}` : 'Play',
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

// ---------------------------------------------------------------------------
// Music
// ---------------------------------------------------------------------------
function normalizeAlbum(album, base) {
    const tracks = Array.isArray(album.tracks) ? album.tracks : [];
    const entries = tracks.map((t, i) => ({
        index: t.track ?? i + 1,
        title: t.title || t.filename,
        subtitle: null,
        path: t.path,
        badges: [],
        size: t.size_mb ? `${t.size_mb} MB` : null,
    }));
    return {
        ...base,
        subtitle: album.artist ?? null,
        countLabel: plural(tracks.length, 'track'),
        groups: [{name: 'Tracks', entries}],
        groupLabel: null,
        playPath: tracks[0]?.path ?? null,
        playLabel: 'Play album',
    };
}

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------
function normalizePhotoAlbum(album, base, art) {
    const photos = Array.isArray(album.photos) ? album.photos : [];
    const entries = photos.map((p, i) => ({
        index: i + 1,
        title: p.title || p.filename,
        subtitle: null,
        path: p.path,
        thumb: exists(p.thumb_path, art) ? p.thumb_path : null,
        badges: [],
        size: null,
    }));
    return {
        ...base,
        layout: 'grid',
        countLabel: plural(photos.length, 'photo'),
        groups: [{name: 'Photos', entries}],
        groupLabel: null,
        playPath: album.folder_path ?? null,
        playLabel: 'Open folder',
    };
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------
const DOCUMENT_ICONS = {
    pdf: 'x-office-document-symbolic',
    odt: 'x-office-document-symbolic', doc: 'x-office-document-symbolic', docx: 'x-office-document-symbolic', rtf: 'x-office-document-symbolic',
    ods: 'x-office-spreadsheet-symbolic', xls: 'x-office-spreadsheet-symbolic', xlsx: 'x-office-spreadsheet-symbolic', csv: 'x-office-spreadsheet-symbolic', tsv: 'x-office-spreadsheet-symbolic',
    odp: 'x-office-presentation-symbolic', ppt: 'x-office-presentation-symbolic', pptx: 'x-office-presentation-symbolic',
};

function normalizeDocuments(collection, base) {
    const docs = Array.isArray(collection.documents) ? collection.documents : [];
    const entries = docs.map((d, i) => ({
        index: i + 1,
        title: d.title || d.filename,
        subtitle: d.ext ? d.ext.toUpperCase() : null,
        path: d.path,
        icon: DOCUMENT_ICONS[d.ext] ?? 'text-x-generic-symbolic',
        badges: [],
        size: d.size_mb ? `${d.size_mb} MB` : null,
    }));
    const total = collection.document_count ?? docs.length;
    return {
        ...base,
        countLabel: plural(total, 'document'),
        groups: [{name: total > docs.length ? `Newest ${docs.length} of ${total}` : 'Files', entries}],
        groupLabel: null,
        playPath: collection.folder_path ?? null,
        playLabel: 'Open folder',
    };
}

// ---------------------------------------------------------------------------
// Games
// ---------------------------------------------------------------------------
const PLATFORM_NAMES = {steam: 'Steam', ps2: 'PlayStation 2'};

// 58 -> "58 minutes played"; 6347 -> "105 hours played". Steam counts in
// minutes and never rounds, so anything past a couple of hours reads better
// as hours.
function playtimeLabel(minutes) {
    if (!minutes || minutes < 1)
        return null;
    if (minutes < 120)
        return `${plural(minutes, 'minute')} played`;
    return `${plural(Math.round(minutes / 60), 'hour')} played`;
}

function normalizeGame(game, base) {
    const platform = PLATFORM_NAMES[game.platform] ?? 'Game';
    const played = playtimeLabel(game.playtime_minutes);
    const folder = game.folder_path ?? null;

    // Not a list of things to play — a game is one thing — so the group is
    // what there is to know about it, each row opening the folder it names.
    const entries = [];
    if (folder) {
        entries.push({
            index: entries.length + 1,
            title: game.platform === 'ps2' ? 'Disc image' : 'Install folder',
            subtitle: game.platform === 'ps2' ? (game.disc_path ?? folder) : folder,
            path: folder,
            icon: 'folder-symbolic',
            badges: game.disc_format ? [game.disc_format.toUpperCase()] : [],
            size: game.size_mb ? `${Math.round(game.size_mb)} MB` : null,
        });
    }
    if (played) {
        entries.push({
            index: entries.length + 1,
            title: 'Playtime',
            subtitle: played,
            path: null,
            icon: 'preferences-system-time-symbolic',
            badges: [],
            size: null,
        });
    }
    if (game.serial) {
        entries.push({
            index: entries.length + 1,
            title: 'Serial',
            subtitle: game.serial,
            path: null,
            icon: 'media-optical-symbolic',
            badges: [],
            size: null,
        });
    }

    const launch = Array.isArray(game.launch) && game.launch.every(a => typeof a === 'string' && a)
        ? game.launch : null;
    return {
        ...base,
        subtitle: platform,
        countLabel: played ?? platform,
        groups: [{name: 'Details', entries}],
        groupLabel: null,
        // An argv array: openPath runs it as a command line rather than
        // handing it to the default application.
        playPath: launch,
        playLabel: 'Play',
    };
}

// ---------------------------------------------------------------------------
// Opening things
// ---------------------------------------------------------------------------

// Open a file with the configured player, or the system default app. An
// array is a command line to run as-is (a game launcher, an emulator).
export function openPath(path, playerCommand = '') {
    if (!path)
        return;
    if (Array.isArray(path)) {
        try {
            Gio.Subprocess.new(path, Gio.SubprocessFlags.NONE);
        } catch (e) {
            console.error(`[Gnomeflix] Could not run ${path.join(' ')}: ${e.message}`);
        }
        return;
    }
    // This runs in the compositor, and media often lives on a network share or
    // an automount that has idled out: asked synchronously, the whole desktop
    // would stand still for as long as the share takes to come back.
    const failed = e => console.error(`[Gnomeflix] Could not open ${path}: ${e.message}`);
    Gio.File.new_for_path(path).query_info_async(
        'standard::type', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null,
        (file, result) => {
            let isDir = false;
            try {
                isDir = file.query_info_finish(result).get_file_type() === Gio.FileType.DIRECTORY;
            } catch (e) {
                // Not there: let the launch below say so.
            }
            try {
                if (playerCommand && !isDir) {
                    const [ok, argv] = GLib.shell_parse_argv(playerCommand);
                    if (ok && argv.length) {
                        Gio.Subprocess.new([...argv, path], Gio.SubprocessFlags.NONE);
                        return;
                    }
                }
                Gio.AppInfo.launch_default_for_uri_async(file.get_uri(), null, null, (_source, res) => {
                    try {
                        Gio.AppInfo.launch_default_for_uri_finish(res);
                    } catch (e) {
                        failed(e);
                    }
                });
            } catch (e) {
                failed(e);
            }
        });
}
