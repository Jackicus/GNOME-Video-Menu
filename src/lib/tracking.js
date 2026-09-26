// What has been watched. Two files, one format:
//
//   local   ~/.local/share/media-libraries/watched.json
//           every mark made on this machine, keyed by absolute path
//   folder  <library folder>/.media-libraries-watched.json
//           the marks for what is in that folder, keyed by the path inside it
//
// The `tracking` setting picks which are used. "local" keeps the local file
// alone. "source" keeps it too and copies each folder's share of it into
// that folder, so another machine pointed at the same share reads the same
// marks — and folds the folder's marks into the local file first, which is
// how that other machine's marks come through. The local file is never
// trimmed by any of this, so a mark on a folder that is not in the list
// right now waits there until it is. Going back to "local" takes the folder
// files away; going back to "source" puts them back from the local file.
// "none" reads and writes nothing, and leaves both files as they are.
//
// A mark is made from the disc on a row, or by playback getting far enough
// (lib/playback.js). Either way the tracker emits `changed` (path, watched),
// which is how a row that is already built shows it; so does a mark read in
// from another machine's folder file, and so does a position kept, which is
// what moves the detail pane's Continue button along.
//
// An entry is {watched, at, position?}, `at` and `position` in seconds. An
// unmark is kept as `watched: false` rather than dropped, so it outranks an
// older mark on another machine: whichever of two entries has the later `at`
// wins. `position` is where playback stopped, for resuming; marking an entry
// either way drops it, so something watched plays from the start.
//
// The folder files sit on shares that idle out or go offline, so everything
// that touches one is asynchronous (see "Never touch a media path
// synchronously" in CLAUDE.md). The local file is on the local disk.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {SECTIONS} from './library.js';

const FOLDER_FILE = '.media-libraries-watched.json';
const VERSION = 1;

function localPath() {
    return GLib.build_filenamev([GLib.get_user_data_dir(), 'media-libraries', 'watched.json']);
}

function parse(bytes) {
    const raw = JSON.parse(new TextDecoder('utf-8').decode(bytes));
    const entries = raw?.entries;
    return entries && typeof entries === 'object' ? entries : {};
}

// Sorted, so a file whose marks have not changed is written out the same and
// can be left alone.
function serialize(entries) {
    const sorted = {};
    for (const key of Object.keys(entries).sort())
        sorted[key] = entries[key];
    return JSON.stringify({version: VERSION, entries: sorted}, null, 1);
}

const now = () => Math.floor(Date.now() / 1000);

const newer = (a, b) => !b || (a?.at ?? 0) > (b.at ?? 0);

function isNotFound(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND);
}

export class Tracker extends Signals.EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this._entries = {};
        this._mode = 'none';
        this._cancellable = null;
        // Folder -> what is on its file as last read or written, and the
        // folders with a write in flight or another one wanted after it.
        this._written = new Map();
        this._writing = new Set();
        this._again = new Set();
        // The local file the same way: one write at a time, the latest
        // marks after it.
        this._savingLocal = false;
        this._saveAgain = false;
        // The folder list, read from the settings once until they change:
        // it is asked for on every reading of a playing file's position.
        this._folderList = null;
    }

    // Only the sections of things that are watched — every section names one
    // now, but a pick with no section of its own (nothing is open) is not.
    static tracks(section) {
        return !!section?.watched;
    }

    get enabled() {
        return this._mode !== 'none';
    }

    enable() {
        this._cancellable = new Gio.Cancellable();
        this._loadLocal();
        this._mode = this._settings.get_string('tracking');
        this._settings.connectObject('changed::tracking', () => this._onModeChanged(), this);
        for (const section of SECTIONS.filter(Tracker.tracks)) {
            for (const key of [`${section.prefix}-folders`, `${section.prefix}-path`]) {
                this._settings.connectObject(`changed::${key}`, () => {
                    this._folderList = null;
                    this.sync();
                }, this);
            }
        }
        this.sync();
    }

    // Reads in flight are dropped; a write in flight is let finish, since
    // it was started with what is known and is small (see `_writeFolder`).
    disable() {
        this._settings.disconnectObject(this);
        this._cancellable?.cancel();
        this._cancellable = null;
        this._folderList = null;
        this._written.clear();
        this._writing.clear();
        this._again.clear();
    }

    isWatched(path) {
        return this.enabled && typeof path === 'string' && !!this._entries[path]?.watched;
    }

    setWatched(path, watched) {
        if (!this.enabled || typeof path !== 'string')
            return;
        this._entries[path] = {watched, at: now()};
        this._commit(path);
        this.emit('changed', path, watched);
    }

    // Is this a file whose playback is worth following: under one of the
    // folders of a section that is watched?
    covers(path) {
        return this.enabled && typeof path === 'string' && !!this._folderOf(path);
    }

    // Where playback of a file stopped, in seconds; 0 for nowhere.
    positionOf(path) {
        return this.enabled ? this._entries[path]?.position ?? 0 : 0;
    }

    // Keep where playback stopped, or forget it with 0. Whether it is
    // watched is left as it was: a second look at something already
    // watched, stopped halfway, does not unmark it.
    setPosition(path, position) {
        if (!this.enabled || typeof path !== 'string')
            return;
        const previous = this._entries[path];
        position = Math.max(0, Math.floor(position));
        if ((previous?.position ?? 0) === position)
            return;
        const entry = {watched: previous?.watched ?? false, at: now()};
        if (position)
            entry.position = position;
        this._entries[path] = entry;
        this._commit(path);
        this.emit('changed', path, entry.watched);
    }

    // What to carry on with, given a show's episodes in order (`order`) and
    // anything else of it that can be played (`others`, its extras): the
    // file touched last, if it was left partway or unticked since, or else
    // the first unwatched one after it in order. null when nothing has been
    // touched, or everything after the last one is watched — start over.
    continueFrom(order, others = []) {
        if (!this.enabled)
            return null;
        let last = null;
        for (const path of [...order, ...others]) {
            const entry = this._entries[path];
            if (entry && (!last || entry.at > this._entries[last].at))
                last = path;
        }
        if (!last)
            return null;
        const entry = this._entries[last];
        if (entry.position || !entry.watched)
            return last;
        for (let i = order.indexOf(last) + 1; i < order.length; i++) {
            if (!this._entries[order[i]]?.watched)
                return order[i];
        }
        return null;
    }

    // Out to the local file, and to the folder's when that is kept too.
    _commit(path) {
        this._saveLocal();
        const folder = this._mode === 'source' ? this._folderOf(path) : null;
        if (folder)
            this._writeFolder(folder);
    }

    // Read every folder's file into the local one and write each folder its
    // share back. On enable, when the folders change, and when a rescan lands
    // — the moments another machine's marks are worth looking for.
    sync() {
        if (this._mode !== 'source')
            return;
        for (const folder of this._folders())
            this._readFolder(folder);
    }

    _onModeChanged() {
        const previous = this._mode;
        this._mode = this._settings.get_string('tracking');
        if (this._mode === 'source')
            this.sync();
        else if (previous === 'source' && this._mode === 'local')
            this._removeFolderFiles();
    }

    // ------------------------------------------------------------------
    // Where a path belongs
    // ------------------------------------------------------------------
    _folders() {
        if (this._folderList)
            return this._folderList;
        const folders = new Set();
        for (const section of SECTIONS.filter(Tracker.tracks)) {
            let listed = this._settings.get_strv(`${section.prefix}-folders`);
            // Earlier releases kept one folder; the scanner reads it while the
            // list is empty, and so does this.
            if (!listed.length && this._settings.get_string(`${section.prefix}-path`))
                listed = [this._settings.get_string(`${section.prefix}-path`)];
            for (const folder of listed) {
                // As the scanner reads it: `~` is the home folder, and a
                // trailing slash is nothing.
                let trimmed = folder.replace(/\/+$/, '');
                if (trimmed === '~' || trimmed.startsWith('~/'))
                    trimmed = GLib.get_home_dir() + trimmed.slice(1);
                if (trimmed)
                    folders.add(trimmed);
            }
        }
        this._folderList = [...folders];
        return this._folderList;
    }

    // The innermost listed folder a path is under, so a folder listed inside
    // another keeps its own marks.
    _folderOf(path, folders = this._folders()) {
        let best = null;
        for (const folder of folders) {
            if (path.startsWith(`${folder}/`) && (!best || folder.length > best.length))
                best = folder;
        }
        return best;
    }

    // A folder's share of the local marks, keyed by the path inside it.
    _shareOf(folder) {
        const share = {};
        const folders = this._folders();
        for (const [path, entry] of Object.entries(this._entries)) {
            if (this._folderOf(path, folders) === folder)
                share[path.slice(folder.length + 1)] = entry;
        }
        return share;
    }

    // ------------------------------------------------------------------
    // The local file
    // ------------------------------------------------------------------
    _loadLocal() {
        this._entries = {};
        const path = localPath();
        if (!GLib.file_test(path, GLib.FileTest.EXISTS))
            return;
        try {
            const [ok, bytes] = GLib.file_get_contents(path);
            if (ok)
                this._entries = parse(bytes);
        } catch (e) {
            // Put aside rather than read as empty: the next mark would write
            // an empty file over every mark ever made here.
            console.warn(`[Media Libraries] Could not read ${path}, keeping it as ${path}.broken: ${e}`);
            GLib.rename(path, `${path}.broken`);
        }
    }

    // Written whole, in the background: this runs in the compositor, and a
    // synchronous write of an existing file syncs the disk first. One write
    // at a time; a mark made during one is written after it. Not
    // cancellable, so what is known at a lock goes down.
    _saveLocal() {
        if (this._savingLocal) {
            this._saveAgain = true;
            return;
        }
        const path = localPath();
        GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
        const file = Gio.File.new_for_path(path);
        const bytes = new GLib.Bytes(new TextEncoder().encode(serialize(this._entries)));
        this._savingLocal = true;
        file.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.NONE, null,
            (_file, result) => {
                this._savingLocal = false;
                try {
                    file.replace_contents_finish(result);
                } catch (e) {
                    console.error(`[Media Libraries] Could not write ${path}: ${e.message}`);
                }
                if (this._saveAgain) {
                    this._saveAgain = false;
                    this._saveLocal();
                }
            });
    }

    // ------------------------------------------------------------------
    // The folder files
    // ------------------------------------------------------------------
    _readFolder(folder) {
        const file = Gio.File.new_for_path(GLib.build_filenamev([folder, FOLDER_FILE]));
        file.load_contents_async(this._cancellable, (_file, result) => {
            let theirs = {};
            try {
                const [, bytes] = file.load_contents_finish(result);
                theirs = parse(bytes);
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
                // Not there yet is the usual case, and one this writes below;
                // a folder that cannot be read at all is not written either.
                if (!isNotFound(e)) {
                    console.warn(`[Media Libraries] Could not read ${file.get_path()}: ${e.message}`);
                    return;
                }
            }
            if (this._mode !== 'source')
                return;
            // A folder with no file and nothing to say is left untouched: it
            // is recorded as holding the empty share it would be written.
            this._written.set(folder, serialize(theirs));

            // Whose mark flipped, for the rows showing them; a position
            // alone moves nothing on screen.
            const changed = [];
            let merged = false;
            const folders = this._folders();
            for (const [relative, entry] of Object.entries(theirs)) {
                const path = `${folder}/${relative}`;
                const previous = this._entries[path];
                // Only if it is still this folder's: a folder listed inside
                // it since keeps its own.
                if (typeof entry?.watched === 'boolean' && this._folderOf(path, folders) === folder &&
                    newer(entry, previous)) {
                    this._entries[path] = {watched: entry.watched, at: entry.at ?? 0};
                    if (typeof entry.position === 'number' && entry.position > 0)
                        this._entries[path].position = Math.floor(entry.position);
                    merged = true;
                    if (entry.watched !== !!previous?.watched)
                        changed.push(path);
                }
            }
            if (merged)
                this._saveLocal();
            for (const path of changed)
                this.emit('changed', path, this._entries[path].watched);
            this._writeFolder(folder);
        });
    }

    // Write a folder its share, unless that is what it already holds. One
    // write per folder at a time; a mark made during one is written after it.
    _writeFolder(folder) {
        if (this._writing.has(folder)) {
            this._again.add(folder);
            return;
        }
        // Never over a file not yet read: it may hold another machine's
        // marks. The read folds them in and comes back here.
        if (!this._written.has(folder)) {
            this._readFolder(folder);
            return;
        }
        const contents = serialize(this._shareOf(folder));
        if (this._written.get(folder) === contents)
            return;

        this._writing.add(folder);
        const file = Gio.File.new_for_path(GLib.build_filenamev([folder, FOLDER_FILE]));
        const bytes = new GLib.Bytes(new TextEncoder().encode(contents));
        // Not cancellable: the last thing a lock does is keep where playback
        // is, and a replace cancelled after it has opened leaves its
        // temporary file beside the media.
        file.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.NONE,
            null, (_file, result) => {
                this._writing.delete(folder);
                try {
                    file.replace_contents_finish(result);
                    this._written.set(folder, contents);
                } catch (e) {
                    console.warn(`[Media Libraries] Could not write ${file.get_path()}: ${e.message}`);
                }
                if (this._again.delete(folder) && this._mode === 'source')
                    this._writeFolder(folder);
            });
    }

    // Back to "local": the folders' copies go, the local file stays whole.
    _removeFolderFiles() {
        for (const folder of this._folders()) {
            const file = Gio.File.new_for_path(GLib.build_filenamev([folder, FOLDER_FILE]));
            file.delete_async(GLib.PRIORITY_DEFAULT, this._cancellable, (_file, result) => {
                try {
                    file.delete_finish(result);
                } catch (e) {
                    if (!isNotFound(e) && !e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.warn(`[Media Libraries] Could not remove ${file.get_path()}: ${e.message}`);
                }
            });
        }
        this._written.clear();
    }
}
