// GnomeflixApp: owns the desktop surface, what is on it, and the transitions
// between them. Rendering happens on the wallpaper layer of the active
// workspace, so the surface is shown and hidden as workspaces change.
//
// The surface holds the home menu and one page per section — a header over a
// library grid — each built once and kept, so moving between them is a matter
// of which one is visible. The detail pane is shared, and moves into whichever
// page opened it.
//
// That is the "desktop" view. In the "menu" view the library is browsed in the
// overview instead (mediaMenu.js) and only one of the two is ever built: the
// surface is then no more than the detail pane of whatever was picked there,
// on a workspace of its own.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import {Duration, Ease, POP_SCALE, allocateNow, fadeTo, flyClone, rectIn} from './anim.js';
import {SECTIONS, libraryCountLabel, loadLibrary, libraryPath, openPath, sectionByKey} from './library.js';
import {createHomeButton, createIconButton} from './widgets.js';
import {DEFAULT_RADIUS, setCornerRadius} from './shape.js';
import {DEFAULT_COLUMNS, LibraryView} from './libraryView.js';
import {HOME, HomeView} from './homeView.js';
import {DetailView} from './detailView.js';
import {OverviewPreview} from './overviewPreview.js';
import {MediaMenu} from './mediaMenu.js';

// Gap between the surface and the work-area edges.
const OUTER_MARGIN = 28;
// Header height plus its bottom margin, in px, subtracted before sizing grids.
const HEADER_ALLOWANCE = 76;
// How long the shell's own workspace slide takes (WORKSPACE_SWITCH_TIME).
const WORKSPACE_SWITCH_TIME = 250;

export class GnomeflixApp {
    constructor(extension) {
        this._extension = extension;
        this._settings = null;
        this._container = null;
        this._overlay = null;
        this._home = null;
        this._pages = new Map();
        this._detail = null;
        this._sections = {};
        this._sectionKey = null;
        this._mode = 'library';
        this._busy = false;
        this._reloadWanted = false;
        this._leaving = null;
        this._heroFrom = null;
        this._monitor = null;
        this._previews = null;
        this._menu = null;
        // Menu view: what was picked in the overview, and the workspace it
        // was picked from, which is where Back returns to.
        this._picked = null;
        this._origin = null;
        this._rebuildTimer = 0;
        this._closeTimer = 0;
        this._prebuildIdle = 0;
        this._keptAlive = [];
        // Home layout: the workspace each open section was given, by section
        // key. Held as workspaces, not indices, which shift as others close.
        this._opened = new Map();

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
        this._build();

        global.workspace_manager.connectObject(
            'active-workspace-changed', () => this._onWorkspaceChanged(),
            'workspace-removed', () => this._onWorkspaceRemoved(),
            this);
        // Panels and docks register their struts after we are enabled at
        // login, so the work area we sized against can change under us.
        Main.layoutManager.connectObject(
            'monitors-changed', () => this._onGeometryChanged(),
            'startup-complete', () => this._onGeometryChanged(),
            this);
        global.display.connectObject('workareas-changed',
            () => this._onGeometryChanged(), this);

        if (this._settings) {
            const rebuildKeys = ['workspace-index', 'columns', 'corner-radius',
                ...SECTIONS.map(s => `${s.prefix}-enabled`)];
            for (const key of rebuildKeys)
                this._settings.connectObject(`changed::${key}`, () => this._scheduleRebuild(), this);
            // What an open workspace means differs between the views, so none
            // is carried from one to the other.
            this._settings.connectObject('changed::view-mode', () => {
                this._opened.clear();
                this._picked = this._origin = null;
                this._scheduleRebuild();
            }, this);
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
                    this._scheduleRebuild({reload: true, delay: 400});
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
        for (const id of [this._rebuildTimer, this._closeTimer]) {
            if (id)
                GLib.source_remove(id);
        }
        this._rebuildTimer = this._closeTimer = 0;
        this._teardown();
        this._opened.clear();
        this._picked = this._origin = null;
        this._keepOnly(new Set());
        this._sections = {};
    }

    _teardown() {
        if (this._prebuildIdle)
            GLib.source_remove(this._prebuildIdle);
        this._prebuildIdle = 0;
        this._previews?.destroy();
        this._previews = null;
        this._menu?.disable();
        this._menu = null;
        // The background group is the shell's, and was not reactive before.
        const group = this._container?.get_parent();
        if (group && group === Main.layoutManager._backgroundGroup)
            group.reactive = false;
        this._home?.destroy();
        for (const page of this._pages.values())
            page.library?.destroy();
        this._pages.clear();
        this._detail?.destroy();
        this._container?.destroy();
        this._home = this._detail = null;
        this._container = this._stack = this._overlay = null;
        this._busy = false;
        this._mode = 'library';
    }

    // 'workareas-changed' is a claim that some work area may have changed: the
    // shell makes it whenever a workspace is added or removed, which opening and
    // closing a section both do. A rebuild tears the surface down and staggers
    // it back in, so it waits for the box we actually draw in to move.
    _onGeometryChanged() {
        const now = this._bounds();
        const was = this._builtBounds;
        if (!was || ['x', 'y', 'width', 'height'].some(k => now[k] !== was[k]))
            this._scheduleRebuild();
    }

    // Settings and geometry changes arrive in bursts (a spin button held down,
    // every monitor reporting in), and a rescan writes the library more than
    // once; `reload` rides the same timer so a burst of either is one rebuild.
    _scheduleRebuild({reload = false, delay = 150} = {}) {
        this._reloadWanted ||= reload;
        if (this._rebuildTimer)
            GLib.source_remove(this._rebuildTimer);
        this._rebuildTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._rebuildTimer = 0;
            if (this._reloadWanted)
                this._sections = loadLibrary();
            this._reloadWanted = false;
            this._teardown();
            this._applyWorkspaceMode();
            this._build();
            this._syncVisibility(false);
            console.log('[Gnomeflix] Surface rebuilt');
            return GLib.SOURCE_REMOVE;
        });
    }

    // ------------------------------------------------------------------
    // Settings helpers
    // ------------------------------------------------------------------
    _enabledSections() {
        return SECTIONS.filter(s => !this._settings || this._settings.get_boolean(`${s.prefix}-enabled`));
    }

    // Where the library is browsed. "window" is not built yet, and is the
    // desktop until it is.
    _menuMode() {
        return this._settings?.get_string('view-mode') === 'menu';
    }

    // The home menu's workspace; the menu view has no home menu, and -1 is
    // no workspace's index.
    _targetWorkspace() {
        if (this._menuMode())
            return -1;
        return this._settings?.get_int('workspace-index') ?? 0;
    }

    _columns() {
        return this._settings?.get_int('columns') ?? DEFAULT_COLUMNS;
    }

    // ------------------------------------------------------------------
    // Sections as workspaces
    //
    // Only the Home workspace, `workspace-index`, is there to begin with: it
    // carries the launcher menu, and a section is given a workspace when it is
    // opened from there and gives it back when its Home button is pressed.
    //
    // GNOME's dynamic workspaces collapse any empty workspace that is not the
    // last one, which would fold ours away; the workspace tracker spares a
    // workspace whose _keepAliveId is set (the hook it uses itself while a
    // window is being dragged to a new workspace), so ours carry a long-lived
    // timeout source there until they are closed or the extension is disabled.
    // ------------------------------------------------------------------

    // What a workspace shows: a section key, HOME for the launcher, or null
    // when it is not one of ours.
    _placeForWorkspace(index) {
        if (index === this._targetWorkspace())
            return HOME;
        for (const [key, workspace] of this._opened) {
            if (workspace.index() === index)
                return key;
        }
        return null;
    }

    _applyWorkspaceMode() {
        const wm = global.workspace_manager;
        const needed = this._targetWorkspace() + 1;
        if (Meta.prefs_get_dynamic_workspaces()) {
            while (wm.n_workspaces < needed)
                wm.append_new_workspace(false, global.get_current_time());
        } else if (wm.n_workspaces < needed) {
            console.warn(`[Gnomeflix] Workspace ${needed} is where the home menu goes, but only ` +
                `${wm.n_workspaces} exist (Settings → Multitasking).`);
        }

        // An open section goes with its workspace, and with its setting.
        const enabled = this._enabledSections();
        for (const [key, workspace] of [...this._opened]) {
            if (workspace.index() < 0 || !enabled.some(s => s.key === key))
                this._opened.delete(key);
        }
        if (this._picked && !this._opened.has(this._picked.key))
            this._picked = null;

        // Everything up to and including Home stays put, so its index cannot
        // shift underneath us.
        const wanted = new Set(this._opened.values());
        for (let i = 0; i < Math.min(needed, wm.n_workspaces); i++)
            wanted.add(wm.get_workspace_by_index(i));
        this._keepOnly(wanted);
    }

    // Hold exactly `wanted` open, releasing whatever else we were holding.
    _keepOnly(wanted) {
        let released = false;
        this._keptAlive = this._keptAlive.filter(ws => {
            if (wanted.has(ws))
                return true;
            if (ws._keepAliveId) {
                GLib.source_remove(ws._keepAliveId);
                ws._keepAliveId = 0;
            }
            released = true;
            return false;
        });
        for (const ws of wanted) {
            // Set by someone else: the shell's own, mid drag-and-drop.
            if (!ws || ws._keepAliveId)
                continue;
            ws._keepAliveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, GLib.MAXUINT32, () => GLib.SOURCE_CONTINUE);
            GLib.Source.set_name_by_id(ws._keepAliveId, '[gnomeflix] keep section workspace');
            this._keptAlive.push(ws);
        }
        // Let the shell fold the now-empty workspaces back up.
        if (released)
            Main.wm._workspaceTracker?._queueCheckWorkspaces?.();
    }

    // A workspace for a section being opened from the home menu. Dynamic
    // workspaces always end in an empty one, which is exactly what is wanted;
    // holding it makes the shell add the next. With a fixed number, the first
    // one past Home that nothing is using.
    _claimWorkspace() {
        const wm = global.workspace_manager;
        const taken = new Set(this._opened.values());
        const free = ws => ws && ws.index() > this._targetWorkspace() && !taken.has(ws) &&
            !ws._keepAliveId && !ws.list_windows().some(w => !w.is_on_all_workspaces());
        if (Meta.prefs_get_dynamic_workspaces()) {
            const last = wm.get_workspace_by_index(wm.n_workspaces - 1);
            return free(last) ? last : wm.append_new_workspace(false, global.get_current_time());
        }
        for (let i = this._targetWorkspace() + 1; i < wm.n_workspaces; i++) {
            const ws = wm.get_workspace_by_index(i);
            if (free(ws))
                return ws;
        }
        return null;
    }

    // Home menu -> a section. Its workspace is made on the way if it is not
    // open already; _onWorkspaceChanged puts the library on it.
    _openSection(key) {
        if (this._busy)
            return;
        let workspace = this._opened.get(key);
        if (!workspace || workspace.index() < 0) {
            workspace = this._claimWorkspace();
            if (!workspace) {
                console.warn('[Gnomeflix] No free workspace to open a section on (Settings → Multitasking).');
                return;
            }
            this._opened.set(key, workspace);
            this._keepOnly(new Set([...this._keptAlive, workspace]));
            Main.wm._workspaceTracker?._queueCheckWorkspaces?.();
        }
        workspace.activate(global.get_current_time());
    }

    // A section -> where it was opened from, closing the section's workspace
    // behind it once the shell's slide has left it. That is the home menu; in
    // the menu view, the workspace the overview was on when the item was
    // picked, with the overview back on that section.
    _goHome() {
        if (this._busy)
            return;
        const wm = global.workspace_manager;
        const menu = this._menuMode();
        const to = menu
            ? (this._origin?.index() >= 0 ? this._origin : wm.get_workspace_by_index(0))
            : wm.get_workspace_by_index(this._targetWorkspace());
        if (!to)
            return;
        // Forgotten now, so Home arrives without its dot; let go of only when
        // the slide is over, so the shell is not removing a workspace it is
        // still animating away from. The slide it leaves by still wants its
        // picture, though.
        const key = this._sectionKey;
        const workspace = this._opened.get(key);
        // Already on its way out: a second press would replace the timer that
        // lets the first one's workspace go.
        if (!workspace)
            return;
        this._opened.delete(key);
        this._leaving = {key, workspace};
        if (menu) {
            this._picked = null;
            this._menu?.open(key);
        }
        to.activate(global.get_current_time());
        // Left without a change of workspace, when that is where it was opened.
        this._syncVisibility(true);
        if (this._closeTimer)
            GLib.source_remove(this._closeTimer);
        this._closeTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WORKSPACE_SWITCH_TIME + 50, () => {
            this._closeTimer = 0;
            this._leaving = null;
            this._keepOnly(new Set(this._keptAlive.filter(ws => ws !== workspace)));
            return GLib.SOURCE_REMOVE;
        });
    }

    // A workspace going can take an open section with it, and shifts the
    // index of everything after it — so what the active one shows is asked
    // again. Nothing on the surface needs building for that.
    _onWorkspaceRemoved() {
        this._applyWorkspaceMode();
        this._home?.setOpened(this._opened.keys());
        this._previews?.invalidate();
        this._onWorkspaceChanged();
    }

    _onWorkspaceChanged() {
        const place = this._placeForWorkspace(global.workspace_manager.get_active_workspace_index());
        if (place === HOME)
            this._showHomeNow();
        else if (place && (place !== this._sectionKey || this._mode === HOME))
            this._showSectionNow(place);
        this._syncVisibility(true);
    }

    // The media menu -> an item. There is one workspace for whatever was
    // picked last, whichever section it came from, since there is one detail
    // pane; it is in place before the slide that brings it in.
    _openFromMenu(key, item) {
        Main.overview.hide();
        const active = global.workspace_manager.get_active_workspace();
        if (this._placeForWorkspace(active.index()) === null)
            this._origin = active;
        const [[was, workspace] = []] = this._opened;
        if (workspace && was !== key) {
            this._opened.delete(was);
            this._opened.set(key, workspace);
            this._previews?.invalidate();
        }
        this._picked = {key, item};
        this._showSectionNow(key);
        this._openSection(key);
        // Picked from the workspace that is then claimed, nothing changes.
        this._syncVisibility(true);
    }

    // The current page back to its library, whatever was in flight on it.
    _resetViews() {
        this._overlay.destroy_all_children();
        this._detail.actor.remove_all_transitions();
        this._detail.actor.hide();
        const page = this._pages.get(this._sectionKey);
        const grid = page?.library?.actor;
        if (grid) {
            grid.remove_all_transitions();
            grid.set_scale(1, 1);
            grid.opacity = 255;
            grid.show();
        }
        page?.header.setLibraryMode(false);
        this._busy = false;
    }

    // Jump straight to a section's library, abandoning any open detail view.
    // The shell's slide is the transition when the workspace changes, so the
    // page is simply there when it lands; `reveal` staggers it in, for the
    // first build, which no slide carries.
    _showSectionNow(key, {reveal = false} = {}) {
        if (!this._container)
            return;
        this._resetViews();
        this._home?.actor.hide();
        this._mode = 'library';
        this._sectionKey = key;
        const page = this._page(key);
        for (const other of this._pages.values())
            other.actor.visible = other === page;
        if (!page.library)
            this._showPicked(page);
        else if (reveal)
            page.library.reveal();
    }

    // A page of the menu view has no grid: it is the detail pane of what was
    // picked, put there outright. The shell's slide is what brings it in.
    _showPicked(page) {
        if (this._picked?.key !== page.key)
            return;
        this._mode = 'detail';
        this._attachDetail(page);
        this._detail.populate(this._picked.item, sectionByKey(page.key));
        const actor = this._detail.actor;
        actor.opacity = 255;
        actor.translation_y = 0;
        actor.show();
        page.header.setDetailMode(false);
    }

    // The detail pane is shared, and moves into whichever page wants it.
    _attachDetail(page) {
        const actor = this._detail.actor;
        if (actor.get_parent() === page.stack)
            return;
        actor.get_parent()?.remove_child(actor);
        page.stack.add_child(actor);
    }

    // The same for the home menu.
    _showHomeNow({reveal = false} = {}) {
        if (!this._container)
            return;
        this._resetViews();
        for (const page of this._pages.values())
            page.actor.hide();
        this._home.actor.show();
        this._home.setOpened(this._opened.keys());
        if (reveal)
            this._home.reveal();
        this._mode = HOME;
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

        const bounds = this._builtBounds = this._bounds();

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

        // Pages share the surface, one visible at a time.
        this._stack = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        this._container.add_child(this._stack);

        this._detail = new DetailView({onOpen: path => this._open(path)});
        this._detail.setSize(bounds.width, bounds.height - HEADER_ALLOWANCE);
        this._detail.actor.hide();

        const menu = this._menuMode();
        if (!menu)
            this._buildHome(bounds);

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

        // Anything but an open section's workspace starts at the menu,
        // including the workspaces the surface is hidden on.
        const place = this._placeForWorkspace(global.workspace_manager.get_active_workspace_index());
        if (place && place !== HOME)
            this._showSectionNow(place, {reveal: true});
        else if (!menu)
            this._showHomeNow({reveal: true});

        // The overview never shows this surface — it builds its own wallpaper
        // for every workspace preview — so each gets a clone of its page.
        this._previews = new OverviewPreview({
            placeForWorkspace: index => this._pictureFor(index),
            sourceFor: place => place === HOME ? this._home.actor : this._page(place).actor,
            bounds,
        });
        this._previews.enable();

        // One way of browsing at a time: the library as a second application
        // menu in the overview, or as pages here. A page of the menu view is
        // a header and nothing else until something is picked, so none is
        // built ahead.
        if (menu) {
            this._menu = new MediaMenu({
                sections: this._enabledSections(),
                itemsFor: key => this._sections[key] ?? [],
                onActivate: (key, item) => this._openFromMenu(key, item),
            });
            this._menu.enable();
        } else {
            this._prebuildPages();
        }
    }

    // The home menu has the whole surface to itself, header included.
    _buildHome(bounds) {
        this._home = new HomeView({
            sections: this._enabledSections(),
            itemsFor: key => this._sections[key] ?? [],
            onActivate: key => this._openSection(key),
            onOpenSettings: () => this._extension.openPreferences(),
        });
        this._home.setSize(bounds.width, bounds.height);
        // A clone lays a hidden source out at the size it asks for, and left
        // to itself the menu asks for no more than its launchers take up.
        this._home.actor.set_size(bounds.width, bounds.height);
        this._home.build(this._opened.keys());
        this._home.actor.hide();
        this._container.add_child(this._home.actor);
    }

    // The page for a section, built the first time it is asked for.
    _page(key = this._sectionKey) {
        let page = this._pages.get(key);
        if (!page) {
            page = this._buildPage(key);
            this._pages.set(key, page);
        }
        return page;
    }

    // A page is a couple of hundred actors, which is a dropped frame if it is
    // built on the first frame of the workspace slide that wants it. So the
    // enabled ones are built ahead, one to an idle, while nothing is moving.
    _prebuildPages() {
        const waiting = this._enabledSections().map(s => s.key);
        this._prebuildIdle = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            const key = waiting.find(k => !this._pages.has(k));
            if (key)
                this._page(key);
            if (waiting.some(k => !this._pages.has(k)))
                return GLib.SOURCE_CONTINUE;
            this._prebuildIdle = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    _buildPage(key) {
        const {width, height} = this._builtBounds;
        // Sized outright, as the home menu is, for the overview's clones.
        const actor = new St.BoxLayout({vertical: true, width, height, visible: false});
        const header = this._buildHeader(key);
        actor.add_child(header.actor);

        // Unclipped on purpose: the library grid overhangs it slightly so
        // hovered edge tiles are not cut off.
        const stack = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        actor.add_child(stack);

        // The menu view's grid is the one in the overview.
        let library = null;
        if (!this._menuMode()) {
            library = new LibraryView({
                section: sectionByKey(key),
                items: this._sections[key] ?? [],
                width,
                height: height - HEADER_ALLOWANCE,
                columns: this._columns(),
                onActivate: (item, tile) => this._openItem(item, tile),
                onOpenSettings: () => this._extension.openPreferences(),
            });
            stack.add_child(library.actor);
        }

        this._stack.add_child(actor);
        return {key, actor, header, stack, library};
    }

    // What the shell's picture of a workspace shows. A section on its way
    // out is no longer open, but the slide it leaves by still draws it.
    _pictureFor(index) {
        if (index === null || index === undefined)
            return null;
        if (this._leaving?.workspace?.index() === index)
            return this._leaving.key;
        return this._placeForWorkspace(index);
    }

    _buildHeader(sectionKey) {
        const section = sectionByKey(sectionKey);
        const count = (this._sections[sectionKey] ?? []).length;
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

        // The way back to the menu, which closes this section's workspace.
        const home = createHomeButton();
        home.connect('clicked', () => this._goHome());
        actor.add_child(home);
        title.text = section.title;
        subtitle.text = libraryCountLabel(count);

        return {
            actor,
            setLibraryMode: animate => {
                this._setTitles(title, subtitle, section.title, libraryCountLabel(count), animate);
                if (animate) {
                    fadeTo(back, 0, {duration: Duration.FAST});
                    fadeTo(home, 255);
                } else {
                    back.hide();
                    home.show();
                    home.opacity = 255;
                }
            },
            setDetailMode: animate => {
                this._setTitles(title, subtitle, section.title, 'Back to library', animate);
                if (animate) {
                    fadeTo(home, 0, {duration: Duration.FAST});
                    fadeTo(back, 255);
                } else {
                    home.hide();
                    back.show();
                    back.opacity = 255;
                }
            },
        };
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
    // Library -> detail. The tile's artwork flies to the hero slot while the
    // grid recedes and the detail pane rises into place.
    async _openItem(item, tile) {
        if (this._busy || this._mode !== 'library')
            return;
        this._busy = true;
        this._mode = 'detail';

        const section = sectionByKey(this._sectionKey);
        const page = this._page();
        this._attachDetail(page);
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

        page.header.setDetailMode(true);

        const grid = page.library.actor;
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
        // The menu view's library is in the overview.
        if (this._menuMode()) {
            this._goHome();
            return;
        }
        if (this._busy || this._mode !== 'detail')
            return;
        this._busy = true;
        this._mode = 'library';

        const detailActor = this._detail.actor;
        const hero = this._detail.hero;
        const page = this._page();
        const grid = page.library.actor;
        const remembered = this._heroFrom;
        const tile = remembered ? page.library.tileFor(remembered.item.id) : null;

        page.header.setLibraryMode(true);

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
        const onTarget = this._placeForWorkspace(active) !== null;
        if (!animate) {
            this._container.visible = onTarget;
            this._container.opacity = onTarget ? 255 : 0;
            return;
        }
        // Already there, as it is on every move between two of our own.
        if (this._container.visible === onTarget && this._container.opacity === (onTarget ? 255 : 0))
            return;
        // Fade in step with the shell's own workspace switch.
        fadeTo(this._container, onTarget ? 255 : 0, {duration: Duration.NORMAL});
    }
}
