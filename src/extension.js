import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// GJS caches ES modules by URL for the life of the process, so re-importing
// lib/ after an edit would hand back the old code. Every enable() therefore
// copies lib/ to a fresh directory and imports from there: new URLs, new
// modules, no shell restart. (A query string on the entry module alone is not
// enough -- its static imports of sibling modules resolve without it.)
export default class GnomeflixExtension extends Extension {
    async enable() {
        this._runDir = null;
        // disable() can arrive while the import is still pending, and would
        // find no app to take down; the one built afterwards would then never
        // be taken down at all.
        const enabling = this._enabling = {};
        try {
            const runDir = this._stageLib();
            const module = await import(`file://${runDir}/app.js`);
            if (this._enabling !== enabling)
                return;
            this._app = new module.GnomeflixApp(this);
            this._app.enable();
            console.log(`[Gnomeflix] Enabled from ${runDir}`);
        } catch (e) {
            console.error('[Gnomeflix] Failed to load lib/app.js:', e);
        }
    }

    disable() {
        this._enabling = null;
        if (this._app) {
            try {
                this._app.disable();
            } catch (e) {
                console.error('[Gnomeflix] Error during disable:', e);
            }
            this._app = null;
        }
        if (this._runDir) {
            this._removeTree(Gio.File.new_for_path(this._runDir));
            this._runDir = null;
        }
    }

    _stageLib() {
        const base = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'gnomeflix']);
        // Sweep stages left behind by a shell that exited without disable().
        this._removeTree(Gio.File.new_for_path(base));

        const runDir = GLib.build_filenamev([base, `lib-${Date.now()}`]);
        GLib.mkdir_with_parents(runDir, 0o700);

        const src = this.dir.get_child('lib');
        const it = src.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = it.next_file(null))) {
            if (info.get_file_type() !== Gio.FileType.REGULAR || !info.get_name().endsWith('.js'))
                continue;
            src.get_child(info.get_name()).copy(
                Gio.File.new_for_path(GLib.build_filenamev([runDir, info.get_name()])),
                Gio.FileCopyFlags.OVERWRITE, null, null);
        }
        it.close(null);
        this._runDir = runDir;
        return runDir;
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
            console.warn(`[Gnomeflix] Could not clean ${file.get_path()}: ${e.message}`);
        }
    }
}
