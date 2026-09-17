// GnomeflixApp: owns the desktop surface, the two views, and the transitions
// between them. Rendering happens on the wallpaper layer of the active
// workspace, so the surface is shown and hidden as workspaces change.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import {Duration, Ease, POP_SCALE, allocateNow, fadeTo, flyClone, rectIn} from './anim.js';
import {SECTIONS, loadLibrary, libraryPath, openPath, sectionByKey} from './library.js';
import {createIconButton, createSegmented} from './widgets.js';
import {DEFAULT_RADIUS, setCornerRadius} from './shape.js';
import {LibraryView} from './libraryView.js';
import {DetailView} from './detailView.js';
import {OverviewPreview} from './overviewPreview.js';

// Gap between the surface and the work-area edges.
const OUTER_MARGIN = 28;
// Header height plus its bottom margin, in px, subtracted before sizing grids.
const HEADER_ALLOWANCE = 76;
// How long the shell's own workspace slide covers the surface (WORKSPACE_SWITCH_TIME).
const WORKSPACE_SWITCH_TIME = 250;

export class GnomeflixApp {
    constructor(extension) {
        this._extension = extension;
        this._settings = null;
        this._container = null;
        this._overlay = null;
        this._header = null;
        this._library = null;
        this._detail = null;
        this._sections = {};
        this._sectionKey = 'tv';
        this._mode = 'library';
        this._busy = false;
        this._heroFrom = null;
        this._monitor = null;
        this._previews = null;
        this._rebuildTimer = 0;
        this._reloadTimer = 0;
        this._keptAlive = [];

        try {
            this._settings = extension.getSettings();
        } catch (e) {
            console.warn(`[Gnomeflix] No settings available, using defaults: ${e}`);
        }
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------
    enable() {
        this._sections = loadLibrary();
        this._applyWorkspaceMode();
        this._sectionKey = this._initialSection();
        this._build();

        global.workspace_manager.connectObject(
            'active-workspace-changed', () => this._onWorkspaceChanged(),
            'workspace-removed', () => this._scheduleRebuild(),
            this);
        Main.layoutManager.connectObject('monitors-changed',
            () => this._scheduleRebuild(), this);
        // Panels and docks register their struts after we are enabled at
        // login, so the work area we sized against can change under us.
        global.display.connectObject('workareas-changed',
            () => this._scheduleRebuild(), this);
        Main.layoutManager.connectObject('startup-complete',
            () => this._scheduleRebuild(), this);

        if (this._settings) {
            const rebuildKeys = ['layout-mode', 'workspace-index', 'columns', 'corner-radius',
                ...SECTIONS.map(s => `${s.prefix}-enabled`)];
            for (const key of rebuildKeys)
                this._settings.connectObject(`changed::${key}`, () => this._scheduleRebuild(), this);
        }

        // The scanner writes library.json atomically; refresh when it lands so
        // a rescan from the preferences shows up without touching the shell.
        try {
            this._libraryFile = Gio.File.new_for_path(libraryPath());
            this._monitor = this._libraryFile.monitor_file(Gio.FileMonitorFlags.NONE, null);
            this._monitor.connect('changed', (_m, _f, _o, event) => {
                if (event === Gio.FileMonitorEvent.CHANGES_DONE_HINT ||
                    event === Gio.FileMonitorEvent.CREATED ||
                    event === Gio.FileMonitorEvent.RENAMED ||
                    event === Gio.FileMonitorEvent.MOVED_IN)
                    this._scheduleReload();
            });
        } catch (e) {
            console.warn(`[Gnomeflix] Could not watch library.json: ${e}`);
        }

        this._syncVisibility(false);
    }

    disable() {
        global.workspace_manager.disconnectObject(this);
        global.display.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this._settings?.disconnectObject(this);
        if (this._monitor) {
            this._monitor.cancel();
            this._monitor = null;
        }
        for (const id of [this._rebuildTimer, this._reloadTimer]) {
            if (id)
                GLib.source_remove(id);
        }
        this._rebuildTimer = this._reloadTimer = 0;
        this._teardown();
        this._releaseWorkspaces();
        this._sections = {};
    }

    _teardown() {
        this._previews?.destroy();
        this._previews = null;
        this._library?.destroy();
        this._detail?.destroy();
        this._container?.destroy();
        this._library = this._detail = this._container = this._overlay = this._header = null;
        this._busy = false;
        this._mode = 'library';
    }

    _scheduleRebuild() {
        if (this._rebuildTimer)
            GLib.source_remove(this._rebuildTimer);
        this._rebuildTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._rebuildTimer = 0;
            this._teardown();
            this._applyWorkspaceMode();
            this._sectionKey = this._initialSection();
            this._build();
            this._syncVisibility(false);
            return GLib.SOURCE_REMOVE;
        });
    }

    _scheduleReload() {
        if (this._reloadTimer)
            GLib.source_remove(this._reloadTimer);
        this._reloadTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._reloadTimer = 0;
            this._sections = loadLibrary();
            this._scheduleRebuild();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ------------------------------------------------------------------
    // Settings helpers
    // ------------------------------------------------------------------
    _enabledSections() {
        return SECTIONS.filter(s => !this._settings || this._settings.get_boolean(`${s.prefix}-enabled`));
    }

    _initialSection() {
        const enabled = this._enabledSections();
        if (this._workspacesMode()) {
            const key = this._sectionForWorkspace(global.workspace_manager.get_active_workspace_index());
            if (key)
                return key;
        }
        const wanted = this._settings?.get_string('last-section') ?? 'tv';
        if (enabled.some(s => s.key === wanted))
            return wanted;
        // Fall back to the first enabled section that has something in it.
        return (enabled.find(s => this._sections[s.key]?.length) ?? enabled[0] ?? SECTIONS[0]).key;
    }

    _targetWorkspace() {
        return this._settings?.get_int('workspace-index') ?? 0;
    }

    // ------------------------------------------------------------------
    // Sections as workspaces
    //
    // In "workspaces" mode each enabled section gets its own workspace,
    // starting at workspace-index, so the shell's own swipe browses the
    // library. GNOME's dynamic workspaces collapse any empty workspace that is
    // not the last one, which would fold ours away; the workspace tracker
    // spares a workspace whose _keepAliveId is set (the hook it uses itself
    // while a window is being dragged to a new workspace), so ours carry a
    // long-lived timeout source there until the extension is disabled.
    // ------------------------------------------------------------------
    _workspacesMode() {
        return (this._settings?.get_string('layout-mode') ?? 'single') === 'workspaces';
    }

    _sectionForWorkspace(index) {
        if (!this._workspacesMode())
            return null;
        return this._enabledSections()[index - this._targetWorkspace()]?.key ?? null;
    }

    _workspaceForSection(key) {
        const i = this._enabledSections().findIndex(s => s.key === key);
        if (i < 0)
            return null;
        const index = this._targetWorkspace() + i;
        return global.workspace_manager.get_workspace_by_index(index);
    }

    _applyWorkspaceMode() {
        if (!this._workspacesMode()) {
            this._releaseWorkspaces();
            return;
        }
        const wm = global.workspace_manager;
        const needed = this._targetWorkspace() + this._enabledSections().length;
        if (Meta.prefs_get_dynamic_workspaces()) {
            while (wm.n_workspaces < needed)
                wm.append_new_workspace(false, global.get_current_time());
        } else if (wm.n_workspaces < needed) {
            console.warn(`[Gnomeflix] ${needed} workspaces needed for one per section, but only ` +
                `${wm.n_workspaces} exist (Settings → Multitasking); the rest share the last one.`);
        }
        // Everything up to and including our last workspace stays put, so the
        // indices sections map to cannot shift underneath us.
        for (let i = 0; i < Math.min(needed, wm.n_workspaces); i++) {
            const ws = wm.get_workspace_by_index(i);
            if (!ws || ws._keepAliveId)
                continue;
            ws._keepAliveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, GLib.MAXUINT32, () => GLib.SOURCE_CONTINUE);
            GLib.Source.set_name_by_id(ws._keepAliveId, '[gnomeflix] keep section workspace');
            this._keptAlive.push(ws);
        }
        console.log(`[Gnomeflix] ${this._keptAlive.length} section workspaces kept of ${wm.n_workspaces}`);
    }

    _releaseWorkspaces() {
        if (!this._keptAlive.length)
            return;
        for (const ws of this._keptAlive) {
            if (ws._keepAliveId) {
                GLib.source_remove(ws._keepAliveId);
                ws._keepAliveId = 0;
            }
        }
        this._keptAlive = [];
        // Let the shell fold the now-empty workspaces back up.
        Main.wm._workspaceTracker?._queueCheckWorkspaces?.();
    }

    _onWorkspaceChanged() {
        const key = this._sectionForWorkspace(global.workspace_manager.get_active_workspace_index());
        if (key && key !== this._sectionKey)
            this._showSectionNow(key, {revealAfter: WORKSPACE_SWITCH_TIME});
        this._syncVisibility(true);
    }

    // Jump straight to a section's library, abandoning any open detail view.
    // Used when the workspace changes under us: the shell's slide covers the
    // surface, so the swap itself is instant and only the reveal animates.
    _showSectionNow(key, {revealAfter = 0} = {}) {
        if (!this._container)
            return;
        this._overlay.destroy_all_children();
        this._detail.actor.remove_all_transitions();
        this._detail.actor.hide();
        const grid = this._library.actor;
        grid.remove_all_transitions();
        grid.set_scale(1, 1);
        grid.opacity = 255;
        grid.show();
        this._mode = 'library';
        this._busy = false;
        this._sectionKey = key;
        this._library.showSection(key, this._sections[key] ?? [], {reveal: true, revealAfter});
        this._header.setLibraryMode(key, false);
    }

    _open(path) {
        openPath(path, this._settings?.get_string('player-command') ?? '');
    }

    // ------------------------------------------------------------------
    // Building the surface
    // ------------------------------------------------------------------
    _build() {
        // Every rounded surface reads its radius as it is constructed, so the
        // setting has to be in place before anything below is built.
        setCornerRadius(this._settings?.get_int('corner-radius') ?? DEFAULT_RADIUS);

        const bounds = this._bounds();

        this._container = new St.Widget({
            name: 'GnomeflixContainer',
            style_class: 'gf-surface',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
        });

        const column = new St.BoxLayout({vertical: true, x_expand: true, y_expand: true});
        this._container.add_child(column);

        this._header = this._buildHeader();
        column.add_child(this._header.actor);

        // Unclipped on purpose: the library grid overhangs it slightly so
        // hovered edge tiles are not cut off.
        const stack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        column.add_child(stack);

        this._library = new LibraryView({
            columnsPreference: () => this._settings?.get_int('columns') ?? 6,
            onActivate: (item, tile) => this._openItem(item, tile),
            onOpenSettings: () => this._extension.openPreferences(),
        });
        this._library.setSize(bounds.width, bounds.height - HEADER_ALLOWANCE);
        stack.add_child(this._library.actor);

        this._detail = new DetailView({onOpen: path => this._open(path)});
        this._detail.setSize(bounds.width, bounds.height - HEADER_ALLOWANCE);
        this._detail.actor.hide();
        stack.add_child(this._detail.actor);

        // Clones in flight between the two views live above both.
        this._overlay = new Clutter.Actor({x_expand: true, y_expand: true});
        this._container.add_child(this._overlay);

        const group = Main.layoutManager._backgroundGroup;
        if (group) {
            group.reactive = true;
            group.add_child(this._container);
        } else {
            global.window_group.insert_child_at_index(this._container, 0);
        }

        this._library.showSection(this._sectionKey, this._sections[this._sectionKey] ?? [], {reveal: true});
        this._header.setLibraryMode(this._sectionKey, false);

        // The overview never shows this surface — it builds its own wallpaper
        // for every workspace preview — so a copy has to be put into each.
        this._previews = new OverviewPreview({
            sectionForWorkspace: index => this._previewSectionFor(index),
            itemsFor: key => this._sections[key] ?? [],
            enabledSections: () => this._enabledSections(),
            columnsPreference: () => this._settings?.get_int('columns') ?? 6,
            bounds,
            headerAllowance: HEADER_ALLOWANCE,
        });
        this._previews.enable();
    }

    // Which section a workspace preview stands for: its own with a workspace
    // per section, the current one on the single workspace that carries the
    // surface otherwise.
    _previewSectionFor(index) {
        if (index === null || index === undefined)
            return null;
        if (this._workspacesMode())
            return this._sectionForWorkspace(index);
        return index === this._targetWorkspace() ? this._sectionKey : null;
    }

    _buildHeader() {
        const actor = new St.BoxLayout({style_class: 'gf-header', x_expand: true, y_align: Clutter.ActorAlign.CENTER});

        const back = createIconButton('go-previous-symbolic', {accessibleName: 'Back'});
        back.connect('clicked', () => this._goBack());
        back.hide();
        actor.add_child(back);

        const titles = new St.BoxLayout({vertical: true, style_class: 'gf-header-titles', y_align: Clutter.ActorAlign.CENTER});
        const title = new St.Label({style_class: 'gf-header-title'});
        const subtitle = new St.Label({style_class: 'gf-header-subtitle'});
        titles.add_child(title);
        titles.add_child(subtitle);
        actor.add_child(titles);

        actor.add_child(new St.Widget({x_expand: true}));

        const enabled = this._enabledSections();
        const switcher = createSegmented(enabled, this._sectionKey, key => this._switchSection(key));
        actor.add_child(switcher.actor);

        const header = {
            actor,
            back,
            switcher,
            setLibraryMode: (sectionKey, animate) => {
                const section = sectionByKey(sectionKey);
                const count = (this._sections[sectionKey] ?? []).length;
                this._setTitles(title, subtitle, section.title, count ? `${count} in your library` : 'Nothing indexed yet', animate);
                if (animate) {
                    fadeTo(back, 0, {duration: Duration.FAST});
                    fadeTo(switcher.actor, 255);
                } else {
                    back.hide();
                    switcher.actor.show();
                    switcher.actor.opacity = 255;
                }
                switcher.setActive(sectionKey);
            },
            setDetailMode: (item, sectionKey, animate) => {
                const section = sectionByKey(sectionKey);
                this._setTitles(title, subtitle, section.title, 'Back to library', animate);
                if (animate) {
                    fadeTo(switcher.actor, 0, {duration: Duration.FAST});
                    fadeTo(back, 255);
                } else {
                    switcher.actor.hide();
                    back.show();
                    back.opacity = 255;
                }
            },
        };
        return header;
    }

    _setTitles(title, subtitle, titleText, subtitleText, animate) {
        if (!animate) {
            title.text = titleText;
            subtitle.text = subtitleText;
            return;
        }
        for (const [label, text] of [[title, titleText], [subtitle, subtitleText]]) {
            label.remove_all_transitions();
            label.ease({
                opacity: 0,
                duration: Duration.FAST / 2,
                mode: Ease.OUT,
                onComplete: () => {
                    label.text = text;
                    label.ease({opacity: 255, duration: Duration.FAST, mode: Ease.OUT});
                },
            });
        }
    }

    // The surface fills the monitor's work area (so docks and panels from
    // other extensions are respected), inset by a margin.
    _bounds() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return {x: OUTER_MARGIN, y: OUTER_MARGIN, width: 1920 - 2 * OUTER_MARGIN, height: 1080 - 2 * OUTER_MARGIN};
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        return {
            x: area.x + OUTER_MARGIN,
            y: area.y + OUTER_MARGIN,
            width: area.width - 2 * OUTER_MARGIN,
            height: area.height - 2 * OUTER_MARGIN,
        };
    }

    // ------------------------------------------------------------------
    // Navigation
    // ------------------------------------------------------------------
    _switchSection(key) {
        if (this._busy || key === this._sectionKey)
            return;
        // With a workspace per section the switcher is a workspace jumper: the
        // shell slides across and _onWorkspaceChanged swaps the content.
        const workspace = this._workspacesMode() ? this._workspaceForSection(key) : null;
        if (workspace && workspace !== global.workspace_manager.get_active_workspace()) {
            workspace.activate(global.get_current_time());
            return;
        }
        this._sectionKey = key;
        this._settings?.set_string('last-section', key);
        this._library.showSection(key, this._sections[key] ?? [], {animate: true});
        this._header.setLibraryMode(key, true);
        // On one workspace the preview stands for whatever is on screen now.
        this._previews?.invalidate();
    }

    // Library -> detail. The tile's artwork flies to the hero slot while the
    // grid recedes and the detail pane rises into place.
    async _openItem(item, tile) {
        if (this._busy || this._mode !== 'library')
            return;
        this._busy = true;
        this._mode = 'detail';

        const section = sectionByKey(this._sectionKey);
        const art = tile.artwork;
        const from = rectIn(art, this._container);
        this._heroFrom = {item, from};

        this._detail.populate(item, section);
        const detailActor = this._detail.actor;
        detailActor.opacity = 0;
        detailActor.translation_y = 0;
        detailActor.show();
        allocateNow(detailActor);
        const hero = this._detail.hero;
        hero.opacity = 0;
        const to = rectIn(hero, this._container);

        this._header.setDetailMode(item, this._sectionKey, true);

        const grid = this._library.actor;
        grid.set_pivot_point(0.5, 0.5);
        grid.ease({
            opacity: 0,
            scale_x: POP_SCALE,
            scale_y: POP_SCALE,
            duration: Duration.NORMAL,
            mode: Ease.OUT,
            onComplete: () => {
                grid.hide();
                grid.set_scale(1, 1);
                grid.opacity = 255;
            },
        });

        detailActor.translation_y = 24;
        detailActor.ease({
            opacity: 255,
            translation_y: 0,
            duration: Duration.SLOW,
            mode: Ease.OUT_EXPO,
        });

        art.opacity = 0;
        await flyClone(this._overlay, art, from, to);
        hero.opacity = 255;
        art.opacity = 255;
        this._busy = false;
    }

    // Detail -> library, mirrored: the hero flies back to its tile while the
    // grid comes forward again.
    async _goBack() {
        if (this._busy || this._mode !== 'detail')
            return;
        this._busy = true;
        this._mode = 'library';

        const detailActor = this._detail.actor;
        const hero = this._detail.hero;
        const grid = this._library.actor;
        const remembered = this._heroFrom;
        const tile = remembered ? this._library.tileFor(remembered.item.id) : null;

        this._header.setLibraryMode(this._sectionKey, true);

        grid.set_pivot_point(0.5, 0.5);
        grid.set_scale(POP_SCALE, POP_SCALE);
        grid.opacity = 0;
        grid.show();
        grid.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            duration: Duration.SLOW,
            mode: Ease.OUT_EXPO,
        });

        detailActor.ease({
            opacity: 0,
            translation_y: 24,
            duration: Duration.NORMAL,
            mode: Ease.OUT,
            onComplete: () => {
                detailActor.hide();
                detailActor.translation_y = 0;
            },
        });

        if (tile && hero) {
            const from = rectIn(hero, this._container);
            hero.opacity = 0;
            tile.artwork.opacity = 0;
            await flyClone(this._overlay, hero, from, remembered.from);
            tile.artwork.opacity = 255;
        }
        this._busy = false;
    }

    // ------------------------------------------------------------------
    // Visibility
    // ------------------------------------------------------------------
    _syncVisibility(animate) {
        if (!this._container)
            return;
        const active = global.workspace_manager.get_active_workspace_index();
        const onTarget = this._workspacesMode()
            ? this._sectionForWorkspace(active) !== null
            : active === this._targetWorkspace();
        if (!animate) {
            this._container.visible = onTarget;
            this._container.opacity = onTarget ? 255 : 0;
            return;
        }
        // Fade in step with the shell's own workspace switch.
        fadeTo(this._container, onTarget ? 255 : 0, {duration: Duration.NORMAL});
    }
}
