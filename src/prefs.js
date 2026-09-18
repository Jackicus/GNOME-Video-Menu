import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {SECTIONS as LIBRARY_SECTIONS, readSections} from './lib/library.js';

// One page per media section, plus General.
//
// What a section *is* — its key, its GSettings prefix, its title, its icon and
// the order the pages come in — is lib/library.js's SECTIONS, imported above,
// so adding or renaming a section is one edit there rather than two that can
// drift. What is added here is only what the preferences themselves need to
// say about it.
//
// A section normally has exactly one folder, <prefix>-path. Games have two —
// Steam's library root and PCSX2's config folder, both auto-detected — so they
// name them in `paths`, which _pathSpecs() below flattens the single case into.
const PAGES = {
    tv: {
        lower: 'TV shows', noun: 'shows', xdg: null,
        layout: 'One folder per show. Seasons can be subfolders ("Season 2") or SxxEyy in the file names.',
        online: 'Where artwork, synopsis, genres and ratings come from.',
        providers: [
            ['tvmaze', 'TVmaze', 'No key needed. Good coverage, including anime.'],
            ['tmdb', 'The Movie Database (TMDB)', 'Needs an API key. Adds backdrops, taglines and runtimes.'],
            ['wikipedia', 'Wikipedia', 'No key needed. Poster and lead paragraph only.'],
        ],
    },
    films: {
        lower: 'films', noun: 'films', xdg: null,
        layout: 'One folder or file per film, named "Title (Year)". The largest video in a folder is the feature.',
        online: 'Where posters, synopses, genres and ratings come from.',
        providers: [
            ['tmdb', 'The Movie Database (TMDB)', 'Needs an API key. Posters, backdrops, taglines, runtimes, genres and ratings.'],
            ['wikipedia', 'Wikipedia', 'No key needed. Poster and lead paragraph only. Used automatically when TMDB has no key.'],
        ],
    },
    music: {
        lower: 'music', noun: 'albums', xdg: GLib.UserDirectory.DIRECTORY_MUSIC,
        layout: 'Album folders, optionally inside artist folders. A cover.jpg or folder.jpg beside the tracks is used as the artwork.',
        online: 'Missing album art comes from the iTunes Search API.',
    },
    photos: {
        lower: 'photos', noun: 'albums', xdg: GLib.UserDirectory.DIRECTORY_PICTURES,
        layout: 'One folder per album. Loose images in the folder itself become an album too.',
        online: 'Photos never leave this computer; thumbnails are generated locally.',
    },
    documents: {
        lower: 'documents', noun: 'collections', xdg: GLib.UserDirectory.DIRECTORY_DOCUMENTS,
        layout: 'Each top-level folder is a collection of the documents directly inside it; loose files form one too. Deeper folders are not walked.',
        online: 'Documents never leave this computer.',
    },
    games: {
        lower: 'games', noun: 'games',
        paths: [
            {
                key: 'steam-path', title: 'Steam library',
                hint: 'Auto-detected — ~/.steam/steam, ~/.local/share/Steam or the flatpak install',
            },
            {
                key: 'pcsx2-path', title: 'PCSX2 configuration',
                hint: 'Auto-detected — ~/.config/PCSX2 or the flatpak install',
            },
        ],
        layout: 'Installed Steam games come from Steam\'s own library files, including libraries on other drives. PS2 games come from the folders PCSX2.ini points at; covers come from its covers folder.',
        online: 'Steam artwork and descriptions come from Valve\'s public endpoints; PS2 games use IGDB when its credentials are set.',
    },
};

const SECTIONS = LIBRARY_SECTIONS.map(section => ({...section, ...PAGES[section.key]}));

export default class GnomeflixPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(720, 640);
        window.set_search_enabled(true);

        const state = {
            window,
            settings,
            counts: this._readCounts(),
            rows: new Map(),   // section key -> {status, button}
        };

        window.add(this._generalPage(state));
        for (const section of SECTIONS)
            window.add(this._sectionPage(state, section));
    }

    // ------------------------------------------------------------------
    // General
    // ------------------------------------------------------------------
    _generalPage(state) {
        const {settings} = state;
        const page = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});

        const desktop = new Adw.PreferencesGroup({
            title: 'Desktop',
            description: 'Gnomeflix draws straight onto the wallpaper: a home menu on one workspace, and a workspace for each section you open from it.',
        });
        page.add(desktop);

        const workspace = new Adw.SpinRow({
            title: 'Workspace',
            subtitle: 'The workspace that carries the home menu',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 16, step_increment: 1, value: settings.get_int('workspace-index') + 1}),
        });
        workspace.connect('changed', () => settings.set_int('workspace-index', Math.round(workspace.get_value()) - 1));
        desktop.add(workspace);

        desktop.add(new Adw.ActionRow({
            title: 'Workspaces Gnomeflix is using stay open',
            subtitle: 'The home menu opens a workspace for a section when you pick it and closes it again from the section\'s Home button. With a fixed number of workspaces, set enough in Settings → Multitasking.',
            sensitive: false,
        }));

        const columns = new Adw.SpinRow({
            title: 'Minimum covers per row',
            subtitle: 'Fewer means larger covers. Wide screens fit more automatically.',
            adjustment: new Gtk.Adjustment({lower: 3, upper: 12, step_increment: 1, value: settings.get_int('columns')}),
        });
        columns.connect('changed', () => settings.set_int('columns', Math.round(columns.get_value())));
        desktop.add(columns);

        const radius = new Adw.SpinRow({
            title: 'Corner radius',
            subtitle: 'How rounded covers, tiles and the detail pane are, in pixels. 0 is square.',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 40, step_increment: 1, value: settings.get_int('corner-radius')}),
        });
        radius.connect('changed', () => settings.set_int('corner-radius', Math.round(radius.get_value())));
        desktop.add(radius);

        const accent = new Adw.ActionRow({
            title: 'Accent colour',
            subtitle: 'Follows Settings → Appearance → Accent Color',
            activatable: true,
        });
        accent.add_suffix(new Gtk.Image({icon_name: 'external-link-symbolic'}));
        accent.connect('activated', () => {
            try {
                Gio.Subprocess.new(['gnome-control-center', 'background'], Gio.SubprocessFlags.NONE);
            } catch (e) {
                console.warn(`[Gnomeflix] Could not open Settings: ${e.message}`);
            }
        });
        desktop.add(accent);

        const playback = new Adw.PreferencesGroup({title: 'Playback'});
        page.add(playback);

        const player = new Adw.EntryRow({
            title: 'Video player command',
            text: settings.get_string('player-command'),
            show_apply_button: true,
        });
        player.connect('apply', () => settings.set_string('player-command', player.get_text().trim()));
        playback.add(player);
        playback.add(new Adw.ActionRow({
            title: 'Leave empty for the system default',
            subtitle: 'For example "vlc" or "mpv --fullscreen". Music and photos always open with their default apps.',
            sensitive: false,
        }));

        const library = new Adw.PreferencesGroup({title: 'Library'});
        page.add(library);

        const online = new Adw.SwitchRow({
            title: 'Fetch artwork and descriptions online',
            subtitle: 'Sources are chosen on each section\'s page; album art comes from iTunes. Results are cached.',
        });
        settings.bind('online-metadata', online, 'active', Gio.SettingsBindFlags.DEFAULT);
        library.add(online);

        const rescan = new Adw.ActionRow({
            title: 'Rescan everything',
            subtitle: this._lastScanText(),
        });
        const button = this._scanButton(state, SECTIONS.filter(s => settings.get_boolean(`${s.prefix}-enabled`)), () => {
            rescan.set_subtitle(this._lastScanText());
        });
        rescan.add_suffix(button);
        library.add(rescan);
        state.rescanAll = {row: rescan, button};

        page.add(this._keysGroup(state));
        return page;
    }

    // API keys live in dconf as plain text. A key drop folder
    // (~/Documents/keys/<SERVICE>/API KEY.txt, shared with other projects) can
    // seed them with one click.
    _keysGroup(state) {
        const group = new Adw.PreferencesGroup({
            title: 'API keys',
            description: 'Optional. Unlock richer sources for the sections above. Keys are stored in dconf, unencrypted.',
        });

        group.add(this._keyRow(state, {
            setting: 'tmdb-api-key', title: 'TMDB API key', service: 'TMDB', file: 'API KEY.txt',
        }));
        group.add(this._linkRow(state, {
            title: 'Get a TMDB key',
            subtitle: 'themoviedb.org → Settings → API (free for personal use)',
            uri: 'https://www.themoviedb.org/settings/api',
        }));

        // IGDB is a Twitch property, so it takes a client id/secret pair rather
        // than a key; scan_library.py exchanges them for an app access token.
        group.add(this._keyRow(state, {
            setting: 'igdb-client-id', title: 'IGDB client ID', service: 'IGDB', file: 'CLIENT ID.txt',
        }));
        group.add(this._keyRow(state, {
            setting: 'igdb-client-secret', title: 'IGDB client secret', service: 'IGDB', file: 'CLIENT SECRET.txt',
        }));
        group.add(this._linkRow(state, {
            title: 'Get IGDB credentials',
            subtitle: 'dev.twitch.tv → Applications → Register (free; gives PS2 games their covers)',
            uri: 'https://dev.twitch.tv/console/apps',
        }));

        return group;
    }

    // A masked entry for one credential, with an Import button when the key
    // drop folder has a file for it. The value is never logged.
    _keyRow(state, {setting, title, service, file}) {
        const {settings} = state;
        const row = new Adw.PasswordEntryRow({
            title,
            text: settings.get_string(setting),
            show_apply_button: true,
        });
        row.connect('apply', () => settings.set_string(setting, row.get_text().trim()));

        const dropFile = this._keyDropFile(service, file);
        if (dropFile) {
            const importBtn = new Gtk.Button({
                label: 'Import',
                valign: Gtk.Align.CENTER,
                tooltip_text: `Read it from ${dropFile}`,
                css_classes: ['flat'],
            });
            importBtn.connect('clicked', () => {
                try {
                    const [ok, bytes] = GLib.file_get_contents(dropFile);
                    const value = ok ? new TextDecoder().decode(bytes).trim() : '';
                    if (value) {
                        settings.set_string(setting, value);
                        row.set_text(value);
                    }
                } catch (e) {
                    console.warn(`[Gnomeflix] Could not read ${dropFile}: ${e.message}`);
                }
            });
            row.add_suffix(importBtn);
        }
        return row;
    }

    _linkRow(state, {title, subtitle, uri}) {
        const row = new Adw.ActionRow({title, subtitle, activatable: true});
        row.add_suffix(new Gtk.Image({icon_name: 'external-link-symbolic'}));
        row.connect('activated', () => Gtk.show_uri(state.window, uri, Gdk.CURRENT_TIME));
        return row;
    }

    _keyDropFile(service, field) {
        const docs = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOCUMENTS) ?? GLib.get_home_dir();
        const path = GLib.build_filenamev([docs, 'keys', service, field]);
        return GLib.file_test(path, GLib.FileTest.IS_REGULAR) ? path : null;
    }

    // ------------------------------------------------------------------
    // One media section
    // ------------------------------------------------------------------
    _sectionPage(state, section) {
        const {settings} = state;
        const page = new Adw.PreferencesPage({title: section.title, icon_name: section.icon});

        const source = new Adw.PreferencesGroup({title: 'Source', description: section.layout});
        page.add(source);

        const enabled = new Adw.SwitchRow({
            title: `Show ${section.lower} on the desktop`,
        });
        settings.bind(`${section.prefix}-enabled`, enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
        source.add(enabled);

        for (const spec of this._pathSpecs(section))
            source.add(this._folderRow(state, section, spec));

        const library = new Adw.PreferencesGroup({title: 'Library', description: section.online});
        page.add(library);

        if (section.providers) {
            const ids = section.providers.map(p => p[0]);
            const provider = new Adw.ComboRow({
                title: 'Information source',
                model: Gtk.StringList.new(section.providers.map(p => p[1])),
                selected: Math.max(0, ids.indexOf(settings.get_string(`${section.prefix}-provider`))),
            });
            const describe = () => provider.set_subtitle(section.providers[provider.selected]?.[2] ?? '');
            describe();
            provider.connect('notify::selected', () => {
                settings.set_string(`${section.prefix}-provider`, ids[provider.selected] ?? ids[0]);
                describe();
            });
            library.add(provider);
        }

        const status = new Adw.ActionRow({
            title: 'Indexed',
            subtitle: this._countText(state.counts, section),
        });
        const button = this._scanButton(state, [section], () => {
            status.set_subtitle(this._countText(state.counts, section));
        });
        status.add_suffix(button);
        library.add(status);

        return page;
    }

    // One "Folder" row: what it is set to, a chooser and a clear button.
    _folderRow(state, section, spec) {
        const {settings} = state;
        const row = new Adw.ActionRow({title: spec.title, activatable: true});
        this._showFolder(row, settings, spec);
        const pick = new Gtk.Button({
            icon_name: 'folder-open-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Choose folder',
            css_classes: ['flat'],
        });
        const reset = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: spec.hint ? 'Back to auto-detection' : 'Clear',
            css_classes: ['flat'],
            visible: settings.get_string(spec.key) !== '',
        });
        row.add_suffix(reset);
        row.add_suffix(pick);

        const choose = () => this._chooseFolder(state.window, settings, section, spec, () => {
            this._showFolder(row, settings, spec);
            reset.visible = true;
        });
        pick.connect('clicked', choose);
        row.connect('activated', choose);
        reset.connect('clicked', () => {
            settings.set_string(spec.key, '');
            this._showFolder(row, settings, spec);
            reset.visible = false;
        });
        return row;
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------
    // Every folder a section can be pointed at. Sections have one, named
    // <prefix>-path; games have two, and say so in `paths`.
    _pathSpecs(section) {
        if (section.paths)
            return section.paths;
        return [{
            key: `${section.prefix}-path`,
            title: 'Folder',
            xdg: section.xdg,
        }];
    }

    // The XDG user folder for the path (Music, Pictures, Documents), or
    // null for the ones that have no sensible default: the Videos folder
    // cannot serve both TV shows and films, and a Steam root is not an XDG
    // folder at all.
    _defaultFolder(spec) {
        if (spec.xdg === null || spec.xdg === undefined)
            return null;
        return GLib.get_user_special_dir(spec.xdg) ?? null;
    }

    _folderFor(settings, spec) {
        return settings.get_string(spec.key) || this._defaultFolder(spec);
    }

    _folderText(settings, spec) {
        const path = this._folderFor(settings, spec);
        if (!path)
            return spec.hint ?? 'Not set — choose a folder';
        const isDefault = settings.get_string(spec.key) === '';
        return `${path}${isDefault ? '  (default)' : ''}`;
    }

    // Put a folder on its row, then find out whether it is there. The answer
    // is never waited for: a folder on a network share or an automount that
    // has idled out takes as long to stat as the share takes to come back,
    // and asked synchronously that is how long the window takes to open.
    _showFolder(row, settings, spec) {
        const text = this._folderText(settings, spec);
        row.set_subtitle(text);
        const path = this._folderFor(settings, spec);
        if (!path)
            return;
        Gio.File.new_for_path(path).query_info_async(
            'standard::type', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null,
            (file, result) => {
                let found = false;
                try {
                    found = file.query_info_finish(result).get_file_type() === Gio.FileType.DIRECTORY;
                } catch (e) {
                    // Missing or unreachable: the row says the same either way.
                }
                // The row may have been pointed somewhere else by now.
                if (!found && this._folderFor(settings, spec) === path)
                    row.set_subtitle(`${text}  — not found`);
            });
    }

    _chooseFolder(window, settings, section, spec, onDone) {
        const dialog = new Gtk.FileDialog({
            title: `Choose ${section.title} ${spec.title.toLowerCase()}`,
            modal: true,
            initial_folder: Gio.File.new_for_path(
                this._folderFor(settings, spec) ??
                GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_VIDEOS) ?? GLib.get_home_dir()),
        });
        dialog.select_folder(window, null, (source, result) => {
            try {
                const file = source.select_folder_finish(result);
                if (file) {
                    settings.set_string(spec.key, file.get_path());
                    onDone();
                }
            } catch (e) {
                // Cancelled.
            }
        });
    }

    // How many items the last scan found per section, read the same way the
    // desktop reads it.
    _readCounts() {
        const {sections, generated} = readSections();
        const counts = {generated};
        for (const s of SECTIONS)
            counts[s.key] = Array.isArray(sections[s.key]) ? sections[s.key].length : null;
        return counts;
    }

    _countText(counts, section) {
        const n = counts[section.key];
        if (n === null || n === undefined)
            return 'Not scanned yet';
        return `${n} ${section.noun}`;
    }

    _lastScanText() {
        const counts = this._readCounts();
        if (!counts.generated)
            return 'The library has not been scanned yet';
        const when = GLib.DateTime.new_from_unix_local(Math.floor(counts.generated));
        return `Last scanned ${when.format('%-d %b %H:%M')}`;
    }

    // A button that runs backend/scan_library.py for `sections`, then
    // re-reads the counts. The desktop picks the new library up on its own.
    //
    // The scanner reads the folders, providers and online switch out of
    // GSettings itself, so nothing here has to turn a setting into a flag —
    // `--only` just narrows it to the section whose page this button is on.
    _scanButton(state, sections, onDone) {
        const content = new Adw.ButtonContent({label: 'Rescan', icon_name: 'view-refresh-symbolic'});
        const button = new Gtk.Button({child: content, valign: Gtk.Align.CENTER, css_classes: ['flat']});

        button.connect('clicked', () => {
            const enabled = sections.filter(s => state.settings.get_boolean(`${s.prefix}-enabled`));
            if (!enabled.length) {
                content.set_label('Nothing enabled');
                return;
            }
            // Games are auto-detected and so always have somewhere to look;
            // every other section needs a folder before it is worth running.
            const ready = enabled.filter(s =>
                s.paths || this._folderFor(state.settings, this._pathSpecs(s)[0]));
            if (!ready.length) {
                content.set_label('No folder set');
                return;
            }
            const argv = [
                'python3',
                GLib.build_filenamev([this.path, 'backend', 'scan_library.py']),
                '--from-settings',
            ];
            for (const s of ready)
                argv.push('--only', s.key);

            button.set_sensitive(false);
            content.set_label('Scanning…');
            content.set_icon_name('content-loading-symbolic');
            try {
                // The key goes through the environment so it never shows in ps.
                const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE});
                launcher.setenv('GNOMEFLIX_TMDB_KEY', state.settings.get_string('tmdb-api-key'), true);
                launcher.setenv('GNOMEFLIX_IGDB_CLIENT_ID', state.settings.get_string('igdb-client-id'), true);
                launcher.setenv('GNOMEFLIX_IGDB_CLIENT_SECRET', state.settings.get_string('igdb-client-secret'), true);
                const proc = launcher.spawnv(argv);
                proc.communicate_utf8_async(null, null, (p, result) => {
                    let failed = false;
                    try {
                        const [, , stderr] = p.communicate_utf8_finish(result);
                        failed = !p.get_successful();
                        if (failed)
                            console.error(`[Gnomeflix] Scan failed: ${stderr}`);
                    } catch (e) {
                        failed = true;
                        console.error(`[Gnomeflix] Scan failed: ${e.message}`);
                    }
                    button.set_sensitive(true);
                    content.set_icon_name(failed ? 'dialog-warning-symbolic' : 'view-refresh-symbolic');
                    content.set_label(failed ? 'Failed — see logs' : 'Rescan');
                    state.counts = this._readCounts();
                    onDone();
                    // Every page shows counts; refresh the ones we know about.
                    state.rescanAll?.row.set_subtitle(this._lastScanText());
                });
            } catch (e) {
                console.error(`[Gnomeflix] Could not launch scanner: ${e.message}`);
                button.set_sensitive(true);
                content.set_icon_name('dialog-warning-symbolic');
                content.set_label('Failed');
            }
        });
        return button;
    }
}
