import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// GJS caches ES modules by URL for the life of the process, so re-importing
// lib/ after an edit would hand back the old code. Every enable() therefore
// stages lib/ into a directory named after a checksum of its contents and
// imports from there: a fresh directory per *edit* (the stamp changes) reloads
// without a shell restart, while an unlock re-enables into the same stage and
// the same module graph, since session-modes defaults to ['user'] and the
// shell disables at lock. (A query string on the entry module alone is not
// enough -- its static imports of sibling modules resolve without it.)
// Second-granularity mtimes alone would collide with `make reload` run twice
// inside the same second, which is why size and the mtime's usec are in the
// stamp too.
export default class MediaLibrariesExtension extends Extension {
    async enable() {
        // disable() can arrive while the import is still pending, and would
        // find no app to take down; the one built afterwards would then never
        // be taken down at all.
        const enabling = this._enabling = {};
        try {
            const runDir = this._stageLib();
            const module = await import(`file://${runDir}/app.js`);
            if (this._enabling !== enabling)
                return;
            this._app = new module.MediaLibrariesApp(this);
            this._app.enable();
            console.log(`[Media Libraries] Enabled from ${runDir}`);
        } catch (e) {
            console.error('[Media Libraries] Failed to load lib/app.js:', e);
        }
    }

    disable() {
        this._enabling = null;
        if (this._app) {
            try {
                this._app.disable();
            } catch (e) {
                console.error('[Media Libraries] Error during disable:', e);
            }
            this._app = null;
        }
        // The stage this session used is kept on purpose (the next enable's
        // sweep removes it if it is now stale); only a live app is torn down.
    }

    _stageLib() {
        const base = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'media-libraries']);

        const src = this.dir.get_child('lib');
        const attrs = 'standard::name,standard::type,standard::size,time::modified,time::modified-usec';
        const it = src.enumerate_children(attrs, Gio.FileQueryInfoFlags.NONE, null);
        const names = [];
        const entries = [];
        let info;
        while ((info = it.next_file(null))) {
            if (info.get_file_type() !== Gio.FileType.REGULAR || !info.get_name().endsWith('.js'))
                continue;
            const name = info.get_name();
            const mtime = info.get_modification_date_time();
            names.push(name);
            entries.push(`${name}:${info.get_size()}:${mtime.to_unix()}:${mtime.get_microsecond()}`);
        }
        it.close(null);
        entries.sort();
        const stamp = GLib.compute_checksum_for_string(
            GLib.ChecksumType.SHA256, entries.join('\n'), -1).slice(0, 16);

        const runDir = GLib.build_filenamev([base, `lib-${stamp}`]);
        if (!Gio.File.new_for_path(runDir).query_exists(null)) {
            // Built beside its name and moved into it whole, so a shell that
            // went down mid-copy leaves nothing a later enable takes for a
            // finished stage; the sweep below removes the leftover.
            const building = `${runDir}.building`;
            this._removeTree(Gio.File.new_for_path(building));
            GLib.mkdir_with_parents(building, 0o700);
            for (const name of names) {
                src.get_child(name).copy(
                    Gio.File.new_for_path(GLib.build_filenamev([building, name])),
                    Gio.FileCopyFlags.OVERWRITE, null, null);
            }
            if (GLib.rename(building, runDir) !== 0)
                throw new Error(`could not move ${building} into place`);
        }
        // GJS caches modules by URL for the process's life, so a stage that
        // already exists (an unlock re-enabling into the same content) is
        // served from that cache with no copy needed.

        this._sweepStages(base, stamp);
        return runDir;
    }

    // Removes every stage but the one just built or reused -- leftovers from
    // a shell that exited without disable(), or from the edit before this one.
    _sweepStages(base, stamp) {
        const baseFile = Gio.File.new_for_path(base);
        if (!baseFile.query_exists(null))
            return;
        const it = baseFile.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        let info;
        while ((info = it.next_file(null))) {
            if (info.get_file_type() === Gio.FileType.DIRECTORY && info.get_name() !== `lib-${stamp}`)
                this._removeTree(baseFile.get_child(info.get_name()));
        }
        it.close(null);
    }

    _removeTree(file) {
        if (!file.query_exists(null))
            return;
        try {
            const it = file.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            let info;
            while ((info = it.next_file(null))) {
                const child = file.get_child(info.get_name());
                if (info.get_file_type() === Gio.FileType.DIRECTORY)
                    this._removeTree(child);
                else
                    child.delete(null);
            }
            it.close(null);
            file.delete(null);
        } catch (e) {
            console.warn(`[Media Libraries] Could not clean ${file.get_path()}: ${e.message}`);
        }
    }
}
