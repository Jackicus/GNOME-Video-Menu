import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {SECTIONS as LIBRARY_SECTIONS, readSections} from './lib/library.js';

// Everything a source is, in one place: what it is called, what it is good
// for, where its key comes from and which fields that key has.
//
// `fields` is what the credential is made of — one for an API key, two for a
// Twitch client id/secret pair — and its order is the order they are joined by
// in the `credentials` setting. A source with no `fields` needs no key, and
// still gets a row of the same shape with the entry greyed out.
//
// `service` is the folder the key drop is read from (~/Documents/keys/TMDB/),
// shared with other projects; `file` is the file inside it.
const SOURCES = {
    tvmaze: {
        title: 'TVmaze',
        blurb: 'Free and keyless. Good TV coverage, including anime.',
        help: 'https://www.tvmaze.com/api',
        helpHint: 'tvmaze.com — no account needed',
    },
    tmdb: {
        title: 'TMDB',
        blurb: 'The richest source: posters, backdrops, taglines, runtimes, genres and ratings.',
        help: 'https://www.themoviedb.org/settings/api',
        helpHint: 'themoviedb.org → Settings → API (free for personal use)',
        service: 'TMDB',
        fields: [{title: 'API key', file: 'API KEY.txt'}],
    },
    wikipedia: {
        title: 'Wikipedia',
        blurb: 'Free and keyless. A poster and the lead paragraph, and little else.',
        help: 'https://www.wikipedia.org/',
        helpHint: 'wikipedia.org — no account needed',
    },
    itunes: {
        title: 'iTunes',
        blurb: 'Free and keyless. Album artwork from the iTunes Search API.',
        help: 'https://performance-partners.apple.com/search-api',
        helpHint: 'apple.com — no account needed',
    },
    steam: {
        title: 'Steam',
        blurb: 'Free and keyless. Valve\'s own store record and library artwork for installed Steam games.',
        help: 'https://store.steampowered.com/',
        helpHint: 'steampowered.com — no account needed',
    },
    igdb: {
        title: 'IGDB',
        blurb: 'Covers, synopses and ratings for PS2 discs, which have no store record of their own.',
        help: 'https://dev.twitch.tv/console/apps',
        helpHint: 'dev.twitch.tv → Applications → Register (free)',
        service: 'IGDB',
        fields: [
            {title: 'Client ID', file: 'CLIENT ID.txt'},
            {title: 'Client secret', file: 'CLIENT SECRET.txt'},
        ],
    },
};

// One page per media section, plus General.
//
// What a section *is* — its key, its GSettings prefix, its title, its icon and
// the order the pages come in — is lib/library.js's SECTIONS, imported above,
// so adding or renaming a section is one edit there rather than two that can
// drift. What is added here is only what the preferences themselves need to
// say about it.
//
// `sources` is what that section's Add menu offers, not what it uses: the
// ordered list in use is <prefix>-sources, and the same source may appear in
// it more than once with a different key.
//
// A section normally has exactly one folder, <prefix>-path. Games have two —
// Steam's library root and PCSX2's config folder, both auto-detected — so they
// name them in `paths`, which _pathSpecs() below flattens the single case into.
const PAGES = {
    tv: {
        lower: 'TV shows', noun: 'shows', xdg: null,
        layout: 'One folder per show. Seasons can be subfolders ("Season 2") or SxxEyy in the file names.',
        online: 'Where artwork, synopsis, genres and ratings come from.',
        sources: ['tvmaze', 'tmdb', 'wikipedia'],
    },
    films: {
        lower: 'films', noun: 'films', xdg: null,
        layout: 'One folder or file per film, named "Title (Year)". The largest video in a folder is the feature.',
        online: 'Where posters, synopses, genres and ratings come from.',
        sources: ['tmdb', 'wikipedia'],
    },
    music: {
        lower: 'music', noun: 'albums', xdg: GLib.UserDirectory.DIRECTORY_MUSIC,
        layout: 'Album folders, optionally inside artist folders. A cover.jpg or folder.jpg beside the tracks is used as the artwork.',
        online: 'Where missing album art comes from.',
        sources: ['itunes'],
    },
    photos: {
        lower: 'photos', noun: 'albums', xdg: GLib.UserDirectory.DIRECTORY_PICTURES,
        layout: 'One folder per album. Loose images in the folder itself become an album too.',
        online: 'Photos never leave this computer; thumbnails are generated locally.',
        sources: [],
        offline: 'Not used — photos are never sent anywhere and thumbnails are made on this machine.',
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
        online: 'A game\'s source follows its platform rather than this order — Steam apps use Steam, PS2 discs use IGDB. The order decides which IGDB credential is tried first.',
        sources: ['steam', 'igdb'],
    },
};

const SECTIONS = LIBRARY_SECTIONS.map(section => ({...section, ...PAGES[section.key]}));

// Fields of a multi-field credential are joined by a tab: it cannot occur in
// any of the keys, and it keeps the setting one flat a{ss}.
const FIELD_SEP = '\t';

export default class MediaLibrariesPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(720, 640);
        window.set_search_enabled(true);

        const state = {
            window,
            settings,
            counts: this._readCounts(),
        };

        window.add(this._generalPage(state));
        for (const section of SECTIONS)
            window.add(this._sectionPage(state, section));
    }

    // ------------------------------------------------------------------
    // Credentials
    // ------------------------------------------------------------------
    // A slot id ("tmdb@1") is the unit of sharing: two sections naming the
    // same slot are looking at one key, so editing it on either page edits it
    // on both. A second slot ("tmdb@2") is a second key to fall back to.
    _credentials(settings) {
        return settings.get_value('credentials').deep_unpack();
    }

    _credential(settings, slot) {
        return this._credentials(settings)[slot] ?? '';
    }

    _setCredential(settings, slot, value) {
        const all = this._credentials(settings);
        if (value)
            all[slot] = value;
        else
            delete all[slot];
        settings.set_value('credentials', new GLib.Variant('a{ss}', all));
    }

    // One credential split into the fields its source declares, padded so a
    // half-filled pair still has a box for the missing half.
    _fields(settings, slot, count) {
        const parts = this._credential(settings, slot).split(FIELD_SEP);
        return Array.from({length: count}, (_, i) => parts[i] ?? '');
    }

    _setField(settings, slot, index, value, count) {
        const parts = this._fields(settings, slot, count);
        parts[index] = value;
        // All-empty is no credential at all, so the slot goes rather than
        // lingering as a row of tabs.
        this._setCredential(settings, slot, parts.some(Boolean) ? parts.join(FIELD_SEP) : '');
    }

    // A slot is usable when every field its source declares is filled; a
    // source whose slot is not usable is skipped by the scanner.
    _credentialReady(settings, slot, count) {
        return this._fields(settings, slot, count).every(value => value.trim() !== '');
    }

    // Slots no list names any more are keys nobody can reach, so removing the
    // last row that used one removes the key with it.
    _pruneCredentials(settings) {
        const used = new Set();
        for (const section of SECTIONS) {
            for (const entry of settings.get_strv(`${section.prefix}-sources`))
                used.add(entry);
        }
        const all = this._credentials(settings);
        const orphans = Object.keys(all).filter(slot => !used.has(slot));
        if (!orphans.length)
            return;
        for (const slot of orphans)
            delete all[slot];
        settings.set_value('credentials', new GLib.Variant('a{ss}', all));
    }

    // The other sections whose list names this exact slot — what the row says
    // so that editing a shared key is never a surprise.
    _sharedWith(settings, section, entry) {
        if (!entry.includes('@'))
            return [];
        return SECTIONS
            .filter(other => other.key !== section.key &&
                settings.get_strv(`${other.prefix}-sources`).includes(entry))
            .map(other => other.title);
    }

    // ------------------------------------------------------------------
    // General
    // ------------------------------------------------------------------
    _generalPage(state) {
        const {settings} = state;
        const page = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});

        // One way of browsing at a time, and one way of opening what is
        // picked, each chosen on its own.
        const view = new Adw.PreferencesGroup({title: 'View'});
        page.add(view);

        // One vocabulary, offered twice: the same four places for the library
        // and for a picked item, each read without reference to the other.
        const PLACES = [
            ['desktop', 'Desktop'],
            ['workspaces', 'Workspaces'],
            ['menu', 'Menu'],
            ['modal', 'Modal'],
        ];
        const toggles = () => {
            // `can_shrink` off so a label is never ellipsized to fit the row; the
            // two titles are kept short and parallel so both groups sit the same.
            const group = new Adw.ToggleGroup({valign: Gtk.Align.CENTER, homogeneous: true, can_shrink: false});
            for (const [name, label] of PLACES)
                group.add(new Adw.Toggle({name, label}));
            return group;
        };
        const modes = toggles();
        const viewRow = new Adw.ActionRow({title: 'Libraries open in'});
        viewRow.add_suffix(modes);
        view.add(viewRow);

        const details = toggles();
        const detailRow = new Adw.ActionRow({title: 'Items open in'});
        detailRow.add_suffix(details);
        view.add(detailRow);

        const desktop = new Adw.PreferencesGroup({title: 'Desktop'});
        page.add(desktop);

        const workspace = new Adw.SpinRow({
            title: 'Workspace',
            subtitle: 'The workspace that carries the home menu',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 16, step_increment: 1, value: settings.get_int('workspace-index') + 1}),
        });
        workspace.connect('changed', () => settings.set_int('workspace-index', Math.round(workspace.get_value()) - 1));
        desktop.add(workspace);

        // Shown for whichever of the two is set to claim one.
        const workspaces = new Adw.ActionRow({
            title: 'Workspaces Media Libraries is using stay open',
            subtitle: 'A workspace opened for a section or for a picked item is held until you go back from it, so GNOME does not fold it away. With a fixed number of workspaces, set enough in Settings → Multitasking.',
            sensitive: false,
        });
        desktop.add(workspaces);

        const appearance = new Adw.PreferencesGroup({title: 'Appearance'});
        page.add(appearance);

        const columns = new Adw.SpinRow({
            title: 'Covers per row',
            subtitle: 'Fewer means larger covers. A small space — the grid in the overview, a small screen — fits fewer.',
            adjustment: new Gtk.Adjustment({lower: 3, upper: 12, step_increment: 1, value: settings.get_int('columns')}),
        });
        columns.connect('changed', () => settings.set_int('columns', Math.round(columns.get_value())));
        appearance.add(columns);

        const radius = new Adw.SpinRow({
            title: 'Corner radius',
            subtitle: 'How rounded covers, tiles and the detail pane are, in pixels. 0 is square.',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 40, step_increment: 1, value: settings.get_int('corner-radius')}),
        });
        radius.connect('changed', () => settings.set_int('corner-radius', Math.round(radius.get_value())));
        appearance.add(radius);

        const detailSize = new Adw.SpinRow({
            title: 'Detail pop-up size',
            subtitle: 'How much of the available room the pop-up fills, as a percentage',
            adjustment: new Gtk.Adjustment({lower: 50, upper: 100, step_increment: 5, value: settings.get_int('detail-size')}),
        });
        detailSize.connect('changed', () => settings.set_int('detail-size', Math.round(detailSize.get_value())));
        appearance.add(detailSize);

        const VIEWS = {
            desktop: 'Drawn straight onto the wallpaper, with a home menu of launchers. Every section shares the one workspace.',
            workspaces: 'Drawn straight onto the wallpaper, with a home menu of launchers. Each section you open gets a workspace of its own.',
            menu: 'A grid for each section in the overview, beside your applications, opened from the buttons next to Show Apps.',
            modal: 'A panel over the desktop, opened from the same buttons next to Show Apps. Escape, a click away, or the button again closes it.',
        };
        const DETAILS = {
            desktop: 'What you pick opens on the workspace you are already on.',
            workspaces: 'What you pick opens on a workspace of its own.',
            menu: 'What you pick pops up where you picked it, the way an app folder opens.',
            modal: 'What you pick opens in a panel over the desktop and stays up until Escape or a click away closes it.',
        };
        const chosen = key => settings.get_string(key);
        const syncView = () => {
            const mode = chosen('library-opens-in');
            const detail = chosen('detail-opens-in');
            if (modes.active_name !== mode)
                modes.active_name = mode;
            if (details.active_name !== detail)
                details.active_name = detail;
            // Under the heading, not in the rows, where it would squeeze the toggles.
            view.description = `${VIEWS[mode]} ${DETAILS[detail]}`;
            // The home menu, and the workspace it lives on, come with a
            // library drawn on the wallpaper.
            const onSurface = mode === 'desktop' || mode === 'workspaces';
            workspace.sensitive = onSurface;
            workspaces.visible = onSurface || detail === 'workspaces';
            // The pop-up panel only exists for the two places that are one.
            detailSize.sensitive = detail === 'menu' || detail === 'modal';
        };
        for (const [group, key] of [[modes, 'library-opens-in'], [details, 'detail-opens-in']]) {
            group.connect('notify::active-name', () => {
                if (group.active_name && group.active_name !== settings.get_string(key))
                    settings.set_string(key, group.active_name);
            });
            settings.connect(`changed::${key}`, syncView);
        }
        syncView();

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
                console.warn(`[Media Libraries] Could not open Settings: ${e.message}`);
            }
        });
        appearance.add(accent);

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

        // Sources, keys and the online switch are each section's own; all that
        // is left here is the one button that runs the lot.
        const library = new Adw.PreferencesGroup({
            title: 'Library',
            description: 'Folders, sources and API keys are on each section\'s own page.',
        });
        page.add(library);

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

        return page;
    }

    // ------------------------------------------------------------------
    // One media section
    // ------------------------------------------------------------------
    _sectionPage(state, section) {
        const {settings} = state;
        const page = new Adw.PreferencesPage({title: section.title, icon_name: section.icon});

        const files = new Adw.PreferencesGroup({title: 'Files', description: section.layout});
        page.add(files);

        const enabled = new Adw.SwitchRow({
            title: `Show ${section.lower} on the desktop`,
        });
        settings.bind(`${section.prefix}-enabled`, enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
        files.add(enabled);

        for (const spec of this._pathSpecs(section))
            files.add(this._folderRow(state, section, spec));

        page.add(this._sourcesGroup(state, section));

        const library = new Adw.PreferencesGroup({title: 'Library'});
        page.add(library);

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

    // ------------------------------------------------------------------
    // Sources
    // ------------------------------------------------------------------
    // The ordered list of where a section's artwork and facts come from, and
    // the keys that go with them. Everything in it lives in two settings —
    // <prefix>-sources for the order and `credentials` for the keys — so the
    // rows are torn down and rebuilt from those rather than kept in step by
    // hand; that is also how a slot edited on one page updates on the other.
    _sourcesGroup(state, section) {
        const {settings} = state;
        const key = `${section.prefix}-sources`;
        const offered = section.sources ?? [];

        const group = new Adw.PreferencesGroup({
            title: 'Information sources',
            description: section.online,
        });

        // Photos have no source to switch off, so they get the line in the
        // same place with no switch on it rather than one that does nothing.
        if (!offered.length) {
            group.add(new Adw.ActionRow({
                title: 'Fetch artwork and descriptions online',
                subtitle: section.offline,
                sensitive: false,
            }));
            return group;
        }

        const online = new Adw.SwitchRow({
            title: 'Fetch artwork and descriptions online',
            subtitle: 'Off leaves this section with whatever is already cached.',
        });
        settings.bind(`${section.prefix}-online`, online, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(online);

        // The Add menu. An action group rather than a callback per item so the
        // menu is a plain Gio.Menu and the popover comes from GTK.
        const actions = new Gio.SimpleActionGroup();
        const add = new Gio.SimpleAction({name: 'add', parameter_type: new GLib.VariantType('s')});
        add.connect('activate', (_action, param) => this._addSource(state, section, param.unpack()));
        actions.add_action(add);
        group.insert_action_group('sources', actions);

        const menu = new Gio.Menu();
        for (const id of offered)
            menu.append(SOURCES[id].title, `sources.add('${id}')`);
        group.set_header_suffix(new Gtk.MenuButton({
            icon_name: 'list-add-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Add a source',
            css_classes: ['flat'],
            menu_model: menu,
        }));

        const rows = [];
        const syncers = [];
        const rebuild = () => {
            for (const row of rows.splice(0))
                group.remove(row);
            syncers.length = 0;
            const list = settings.get_strv(key);
            if (!list.length) {
                const empty = new Adw.ActionRow({
                    title: 'No sources',
                    subtitle: `Nothing is looked up for ${section.lower}. Add one above.`,
                    sensitive: false,
                });
                group.add(empty);
                rows.push(empty);
                return;
            }
            list.forEach((entry, index) => {
                const built = this._sourceRow(state, section, entry, index, list);
                group.add(built.row);
                rows.push(built.row);
                if (built.sync)
                    syncers.push(built.sync);
            });
        };

        const refresh = () => syncers.forEach(sync => sync());
        settings.connect(`changed::${key}`, rebuild);
        // A key edited on another section's page is the same key here, and
        // "shared with Films" is read off that section's list. Both are
        // refreshed rather than rebuilt, so an entry being typed into on this
        // page is not pulled out from under the cursor.
        settings.connect('changed::credentials', refresh);
        for (const other of SECTIONS) {
            if (other.key !== section.key)
                settings.connect(`changed::${other.prefix}-sources`, refresh);
        }
        rebuild();
        return group;
    }

    // One source: its name, what state its key is in, and — expanded — the key
    // itself. The shape is the same whether or not it takes one; a source that
    // needs no key shows the entry greyed out rather than hiding it, so the
    // rows line up and nothing looks missing.
    _sourceRow(state, section, entry, index, list) {
        const {settings} = state;
        const id = sourceId(entry);
        const spec = SOURCES[id];
        const slot = entry.includes('@') ? entry : null;
        const fields = spec?.fields ?? [];

        const row = new Adw.ExpanderRow({
            title: spec?.title ?? id,
            tooltip_text: spec?.blurb ?? '',
        });

        const sync = () => {
            if (!spec)
                row.set_subtitle('Unknown source — remove it or fix the setting');
            else if (!slot || !fields.length)
                row.set_subtitle('No key needed');
            else {
                const shared = this._sharedWith(settings, section, entry);
                const which = `Key ${entry.split('@')[1]}`;
                const where = shared.length ? ` · shared with ${shared.join(' and ')}` : '';
                row.set_subtitle(this._credentialReady(settings, slot, fields.length)
                    ? `${which} is set${where}`
                    : `${which} is not set — skipped${where}`);
            }
        };
        sync();

        const move = (to) => {
            const next = [...list];
            next.splice(to, 0, ...next.splice(index, 1));
            settings.set_strv(`${section.prefix}-sources`, next);
        };
        const remove = new Gtk.Button({
            icon_name: 'list-remove-symbolic', valign: Gtk.Align.CENTER,
            tooltip_text: 'Remove this source', css_classes: ['flat'],
        });
        remove.connect('clicked', () => {
            settings.set_strv(`${section.prefix}-sources`, list.filter((_, i) => i !== index));
            this._pruneCredentials(settings);
        });

        const down = new Gtk.Button({
            icon_name: 'go-down-symbolic', valign: Gtk.Align.CENTER,
            tooltip_text: 'Try this one later', css_classes: ['flat'],
            sensitive: index < list.length - 1,
        });
        down.connect('clicked', () => move(index + 1));

        const up = new Gtk.Button({
            icon_name: 'go-up-symbolic', valign: Gtk.Align.CENTER,
            tooltip_text: 'Try this one sooner', css_classes: ['flat'],
            sensitive: index > 0,
        });
        up.connect('clicked', () => move(index - 1));

        let help = null;
        if (spec?.help) {
            help = new Gtk.Button({
                icon_name: 'help-about-symbolic',
                valign: Gtk.Align.CENTER,
                tooltip_text: fields.length
                    ? `Get a ${spec.title} key — ${spec.helpHint}`
                    : `About ${spec.title} — ${spec.helpHint}`,
                css_classes: ['flat'],
            });
            help.connect('clicked', () => Gtk.show_uri(state.window, spec.help, Gdk.CURRENT_TIME));
        }

        // An expander row packs each suffix ahead of the last, so they go on
        // back to front to read help, sooner, later, remove from the left.
        for (const button of [remove, down, up, help]) {
            if (button)
                row.add_suffix(button);
        }

        if (!fields.length) {
            row.add_row(new Adw.PasswordEntryRow({
                title: spec ? `${spec.title} needs no key` : 'No key',
                sensitive: false,
            }));
            return {row, sync};
        }

        const entries = fields.map((field, i) => {
            const value = new Adw.PasswordEntryRow({
                title: field.title,
                text: this._fields(settings, slot, fields.length)[i],
                show_apply_button: true,
            });
            value.connect('apply', () => {
                this._setField(settings, slot, i, value.get_text().trim(), fields.length);
                sync();
            });

            const dropFile = this._keyDropFile(spec.service, field.file);
            if (dropFile) {
                const importBtn = new Gtk.Button({
                    label: 'Import',
                    valign: Gtk.Align.CENTER,
                    tooltip_text: `Read it from ${dropFile}`,
                    css_classes: ['flat'],
                });
                importBtn.connect('clicked', () => {
                    const imported = this._readKeyDrop(dropFile);
                    if (!imported)
                        return;
                    value.set_text(imported);
                    this._setField(settings, slot, i, imported, fields.length);
                    sync();
                });
                value.add_suffix(importBtn);
            }
            row.add_row(value);
            return value;
        });

        return {
            row,
            sync: () => {
                const current = this._fields(settings, slot, fields.length);
                entries.forEach((value, i) => {
                    // Never over an entry being typed into: the edit in front
                    // of the user beats the one that landed from elsewhere.
                    if (!value.has_focus && value.get_text() !== current[i])
                        value.set_text(current[i]);
                });
                sync();
            },
        };
    }

    // Adding a source picks the lowest slot this section is not already using,
    // so the first TMDB row shares films' key and a second one is a second key.
    _addSource(state, section, id) {
        const {settings} = state;
        const key = `${section.prefix}-sources`;
        const list = settings.get_strv(key);
        const spec = SOURCES[id];

        let entry = id;
        if (spec?.fields?.length) {
            let n = 1;
            while (list.includes(`${id}@${n}`))
                n++;
            entry = `${id}@${n}`;
        } else if (list.includes(id)) {
            return;   // a keyless source twice would only ask the same server twice
        }
        settings.set_strv(key, [...list, entry]);
    }

    // The value in the key drop, or '' if it cannot be read. Never logged.
    _readKeyDrop(path) {
        try {
            const [ok, bytes] = GLib.file_get_contents(path);
            return ok ? new TextDecoder().decode(bytes).trim() : '';
        } catch (e) {
            console.warn(`[Media Libraries] Could not read ${path}: ${e.message}`);
            return '';
        }
    }

    _keyDropFile(service, field) {
        if (!service || !field)
            return null;
        const docs = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOCUMENTS) ?? GLib.get_home_dir();
        const path = GLib.build_filenamev([docs, 'keys', service, field]);
        return GLib.file_test(path, GLib.FileTest.IS_REGULAR) ? path : null;
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

    // The XDG user folder for the path (Music, Pictures), or
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
    // The scanner reads the folders, sources, credentials and online switches
    // out of GSettings itself, so nothing here has to turn a setting into a
    // flag or hand it a key — `--only` just narrows it to the section whose
    // page this button is on.
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
                const proc = Gio.Subprocess.new(
                    argv, Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE);
                proc.communicate_utf8_async(null, null, (p, result) => {
                    let failed = false;
                    try {
                        const [, , stderr] = p.communicate_utf8_finish(result);
                        failed = !p.get_successful();
                        if (failed)
                            console.error(`[Media Libraries] Scan failed: ${stderr}`);
                    } catch (e) {
                        failed = true;
                        console.error(`[Media Libraries] Scan failed: ${e.message}`);
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
                console.error(`[Media Libraries] Could not launch scanner: ${e.message}`);
                button.set_sensitive(true);
                content.set_icon_name('dialog-warning-symbolic');
                content.set_label('Failed');
            }
        });
        return button;
    }
}

// "tmdb@2" names the second TMDB key; "wikipedia" names a source that has none.
function sourceId(entry) {
    return entry.split('@')[0];
}
