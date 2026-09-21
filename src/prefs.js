import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {SECTIONS as LIBRARY_SECTIONS, migrateOpenCommand, openCommandKey, readSections} from './lib/library.js';

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
// A section normally looks in a list of folders, <prefix>-folders, added and
// removed on its Files group as sources are on the sources group. Games are
// different: not a list of media folders but two roots — Steam's library and
// PCSX2's config folder, both auto-detected — so they name them in `paths`
// and get one fixed row each.
const PAGES = {
    tv: {
        lower: 'TV shows', noun: 'shows', xdg: null,
        layout: 'One folder per show. Seasons can be subfolders ("Season 2") or SxxEyy in the file names.',
        online: 'Where artwork, synopsis, genres and ratings come from.',
        sources: ['tvmaze', 'tmdb', 'wikipedia'],
        opener: {title: 'Video player command', hint: 'For example "vlc" or "mpv --fullscreen".'},
    },
    films: {
        lower: 'films', noun: 'films', xdg: null,
        layout: 'One folder or file per film, named "Title (Year)". The largest video in a folder is the feature.',
        online: 'Where posters, synopses, genres and ratings come from.',
        sources: ['tmdb', 'wikipedia'],
        opener: {title: 'Video player command', hint: 'For example "vlc" or "mpv --fullscreen".'},
    },
    music: {
        lower: 'music', noun: 'albums', xdg: GLib.UserDirectory.DIRECTORY_MUSIC,
        layout: 'Album folders, optionally inside artist folders. A cover.jpg or folder.jpg beside the tracks is used as the artwork.',
        online: 'Where missing album art comes from.',
        sources: ['itunes'],
        opener: {title: 'Music player command', hint: 'For example "rhythmbox" or "mpv --no-video".'},
    },
    photos: {
        lower: 'photos', noun: 'albums', xdg: GLib.UserDirectory.DIRECTORY_PICTURES,
        layout: 'One folder per album. Loose images in the folder itself become an album too.',
        online: 'Photos never leave this computer; thumbnails are generated locally.',
        sources: [],
        offline: 'Not used — photos are never sent anywhere and thumbnails are made on this machine.',
        opener: {title: 'Image viewer command', hint: 'For example "loupe" or "eog".'},
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
        this._migrateFolders(settings);

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
            ['menu', 'Menu'],
            ['desktop', 'Desktop'],
            ['workspaces', 'Workspaces'],
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

        // A slider with a tick at the schema's own default, read from the
        // schema rather than repeated here, so dragging back to the line is
        // dragging back to the default.
        const slider = (key, min, max) => {
            const scale = new Gtk.Scale({
                orientation: Gtk.Orientation.HORIZONTAL,
                adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: 1}),
                digits: 0,
                draw_value: true,
                value_pos: Gtk.PositionType.RIGHT,
                hexpand: true,
                width_request: 220,
                valign: Gtk.Align.CENTER,
            });
            scale.add_mark(settings.get_default_value(key).deep_unpack(), Gtk.PositionType.BOTTOM, null);
            scale.set_value(settings.get_int(key));
            scale.connect('value-changed', () => settings.set_int(key, Math.round(scale.get_value())));
            settings.connect(`changed::${key}`, () => {
                if (Math.round(scale.get_value()) !== settings.get_int(key))
                    scale.set_value(settings.get_int(key));
            });
            return scale;
        };

        const rowsRow = new Adw.ActionRow({
            title: 'Rows',
            subtitle: 'Covers down a page. Fewer means larger covers.',
        });
        rowsRow.add_suffix(slider('rows', 1, 3));
        appearance.add(rowsRow);

        const columnsRow = new Adw.ActionRow({
            title: 'Columns',
            subtitle: 'Covers across a page. Fewer means larger covers. A small space — the grid in the overview, a small screen — fits fewer of either.',
        });
        columnsRow.add_suffix(slider('columns', 4, 10));
        appearance.add(columnsRow);

        // Where a row that is not full sits: centred under the full ones, as
        // the app grid does, or against the leading edge.
        const align = new Adw.ToggleGroup({valign: Gtk.Align.CENTER, homogeneous: true, can_shrink: false});
        align.add(new Adw.Toggle({name: 'center', label: 'Centre'}));
        align.add(new Adw.Toggle({name: 'start', label: 'Left'}));
        align.set_active_name(settings.get_string('grid-align'));
        align.connect('notify::active-name', () => settings.set_string('grid-align', align.get_active_name()));
        settings.connect('changed::grid-align', () => {
            if (align.get_active_name() !== settings.get_string('grid-align'))
                align.set_active_name(settings.get_string('grid-align'));
        });
        const alignRow = new Adw.ActionRow({
            title: 'Align covers',
            subtitle: 'Where a row that is not full sits',
        });
        alignRow.add_suffix(align);
        appearance.add(alignRow);

        const radiusRow = new Adw.ActionRow({
            title: 'Corner radius',
            subtitle: 'How rounded covers, tiles and the detail pane are, in pixels. 0 is square.',
        });
        radiusRow.add_suffix(slider('corner-radius', 0, 40));
        appearance.add(radiusRow);

        const detailSizeRow = new Adw.ActionRow({
            title: 'Detail pop-up size',
            subtitle: 'How much of the available room the pop-up fills, as a percentage',
        });
        detailSizeRow.add_suffix(slider('detail-size', 80, 120));
        appearance.add(detailSizeRow);

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
            detailSizeRow.sensitive = detail === 'menu' || detail === 'modal';
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

        // Sources, keys, the online switch and what files open with are each
        // section's own; all that is left here is the one button that runs the lot.
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

        if (section.paths) {
            for (const spec of section.paths)
                files.add(this._folderRow(state, section, spec));
        } else {
            this._foldersGroup(state, section, files);
        }

        page.add(this._sourcesGroup(state, section));

        if (openCommandKey(section))
            page.add(this._openerGroup(state, section));

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
    // Opening
    // ------------------------------------------------------------------
    // What a section's files open with: a command of the user's own, with the
    // file's path appended, or the system default when left empty. Games have
    // none — a game is launched by its own command line.
    _openerGroup(state, section) {
        const {settings} = state;
        const key = openCommandKey(section);
        const group = new Adw.PreferencesGroup({title: 'Opening'});

        const command = new Adw.EntryRow({
            title: section.opener.title,
            text: settings.get_string(key),
            show_apply_button: true,
        });
        command.connect('apply', () => settings.set_string(key, command.get_text().trim()));
        settings.connect(`changed::${key}`, () => {
            const value = settings.get_string(key);
            if (command.get_text().trim() !== value)
                command.set_text(value);
        });
        group.add(command);
        group.add(new Adw.ActionRow({
            title: 'Leave empty for the system default',
            subtitle: `${section.opener.hint} The file's path is added to the end.`,
            sensitive: false,
        }));
        return group;
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

    // ------------------------------------------------------------------
    // Folders
    // ------------------------------------------------------------------
    // The ordered list of folders a section is scanned from, on the Files
    // group: one row per folder with a remove button, and a "+" in the group's
    // header that opens the chooser and appends. The rows are rebuilt from
    // <prefix>-folders whenever it changes, as the sources rows are. With the
    // list empty the group shows what the scanner will use instead — the XDG
    // folder for music and photos, nothing for TV shows and films.
    _foldersGroup(state, section, group) {
        const {settings} = state;
        const key = `${section.prefix}-folders`;

        const add = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Add a folder',
            css_classes: ['flat'],
        });
        add.connect('clicked', () => {
            const current = settings.get_strv(key);
            this._pickFolder(state.window, `Add a ${section.title} folder`, current.at(-1) ?? null, path => {
                if (!current.includes(path))
                    settings.set_strv(key, [...current, path]);
            });
        });
        group.set_header_suffix(add);

        const rows = [];
        const rebuild = () => {
            for (const row of rows.splice(0))
                group.remove(row);
            const list = settings.get_strv(key);
            if (!list.length) {
                const fallback = this._defaultFolder(section);
                const row = new Adw.ActionRow({
                    title: fallback ? 'Folder' : 'No folder',
                    subtitle: fallback ? `${fallback}  (default)` : 'Nothing is scanned. Add a folder above.',
                    sensitive: Boolean(fallback),
                });
                if (fallback)
                    this._checkFolder(row, fallback, () => !settings.get_strv(key).length);
                group.add(row);
                rows.push(row);
                return;
            }
            list.forEach((path, index) => {
                const row = new Adw.ActionRow({
                    title: list.length > 1 ? `Folder ${index + 1}` : 'Folder',
                    subtitle: path,
                    activatable: true,
                });
                this._checkFolder(row, path, () => settings.get_strv(key)[index] === path);
                const remove = new Gtk.Button({
                    icon_name: 'list-remove-symbolic',
                    valign: Gtk.Align.CENTER,
                    tooltip_text: 'Remove this folder',
                    css_classes: ['flat'],
                });
                remove.connect('clicked', () => {
                    settings.set_strv(key, settings.get_strv(key).filter((_, i) => i !== index));
                });
                row.add_suffix(remove);
                // Activating a row points it somewhere else, in place.
                row.connect('activated', () => {
                    this._pickFolder(state.window, `Choose ${section.title} folder`, path, chosen => {
                        const next = settings.get_strv(key);
                        next[index] = chosen;
                        settings.set_strv(key, [...new Set(next)]);
                    });
                });
                group.add(row);
                rows.push(row);
            });
        };
        settings.connect(`changed::${key}`, rebuild);
        rebuild();
    }

    // Earlier releases kept one folder per section in <prefix>-path. It is
    // moved into the list once, here, so a desktop that upgrades keeps its
    // folders and the scanner never has to read the old key again.
    _migrateFolders(settings) {
        migrateOpenCommand(settings);
        for (const section of SECTIONS) {
            if (section.paths)
                continue;
            const legacy = settings.get_string(`${section.prefix}-path`);
            if (!legacy)
                continue;
            if (!settings.get_strv(`${section.prefix}-folders`).length)
                settings.set_strv(`${section.prefix}-folders`, [legacy]);
            settings.set_string(`${section.prefix}-path`, '');
        }
    }

    // The folders the scanner will walk for a section: the list, or the XDG
    // default while the list is empty.
    _foldersFor(settings, section) {
        const listed = settings.get_strv(`${section.prefix}-folders`);
        if (listed.length)
            return listed;
        const fallback = this._defaultFolder(section);
        return fallback ? [fallback] : [];
    }

    // Find out whether `path` is there and mark the row if not. The answer is
    // never waited for: a folder on a share or an automount that has idled
    // out takes as long to stat as the share takes to come back, and asked
    // synchronously that is how long the window takes to open. `stillCurrent`
    // says whether the row is still about this path when the answer lands.
    _checkFolder(row, path, stillCurrent) {
        const text = row.get_subtitle();
        Gio.File.new_for_path(path).query_info_async(
            'standard::type', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null,
            (file, result) => {
                let found = false;
                try {
                    found = file.query_info_finish(result).get_file_type() === Gio.FileType.DIRECTORY;
                } catch (e) {
                    // Missing or unreachable: the row says the same either way.
                }
                if (!found && stillCurrent())
                    row.set_subtitle(`${text}  — not found`);
            });
    }

    _pickFolder(window, title, initial, onChosen) {
        const dialog = new Gtk.FileDialog({
            title,
            modal: true,
            initial_folder: Gio.File.new_for_path(
                initial ??
                GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_VIDEOS) ?? GLib.get_home_dir()),
        });
        dialog.select_folder(window, null, (source, result) => {
            try {
                const file = source.select_folder_finish(result);
                if (file)
                    onChosen(file.get_path());
            } catch (e) {
                // Cancelled.
            }
        });
    }

    // One fixed root row, for games: what it is set to, a chooser and a
    // button back to auto-detection.
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
            tooltip_text: 'Back to auto-detection',
            css_classes: ['flat'],
            visible: settings.get_string(spec.key) !== '',
        });
        row.add_suffix(reset);
        row.add_suffix(pick);

        const choose = () => this._pickFolder(
            state.window, `Choose ${section.title} ${spec.title.toLowerCase()}`,
            settings.get_string(spec.key) || null, path => {
                settings.set_string(spec.key, path);
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
    // The XDG user folder a section falls back to (Music, Pictures), or null
    // for the ones that have no sensible default: the Videos folder cannot
    // serve both TV shows and films.
    _defaultFolder(section) {
        if (section.xdg === null || section.xdg === undefined)
            return null;
        return GLib.get_user_special_dir(section.xdg) ?? null;
    }

    // A games root row: the setting, or the auto-detection hint when unset.
    _showFolder(row, settings, spec) {
        const path = settings.get_string(spec.key);
        row.set_subtitle(path || spec.hint);
        if (path)
            this._checkFolder(row, path, () => settings.get_string(spec.key) === path);
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
                s.paths || this._foldersFor(state.settings, s).length);
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
