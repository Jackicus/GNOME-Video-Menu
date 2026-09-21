// MediaLibrariesApp: owns the desktop surface, what is on it, and the transitions
// between them. Rendering happens on the wallpaper layer of the active
// workspace, so the surface is shown and hidden as workspaces change.
//
// Two settings decide where things open, and they are read independently of
// each other: `library-opens-in` for a section's grid, `detail-opens-in` for
// the pane of a picked item. Both take the same four values, meaning the same
// four places:
//
//   desktop     on the wallpaper, on the workspace you are already on
//   workspaces  on the wallpaper, on a workspace of its own, slid to
//   menu        in the overview's app-grid slot (mediaMenu.js) for a library;
//               popped up as an app folder is (detailDialog.js) for a pane
//   modal       in the folder's panel over the desktop (libraryWindow.js for a
//               library, detailDialog.js for a pane), held until it is closed
//
// Neither setting looks at the other. What follows from the pair rather than
// from either alone is one thing only, and it is named: `_detailInPlace()` —
// the grid and the pane landing on the same workspace, which is what makes a
// pick a hero flight in place of the grid rather than a move to somewhere else.
//
// The surface is built when either of them is `desktop` or `workspaces`. It
// holds the home menu, one page per section — a header over a library grid —
// and one detail page, each built once and kept, so moving between them is a
// matter of which is visible. The pane is shared: it sits in the detail page,
// or moves into a section's page when it is replacing that section's grid.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';
import {adjustAnimationTime} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import {Duration, Ease, POP_SCALE, allocateNow, fadeTo, flyClone, rectIn} from './anim.js';
import {SECTIONS, libraryCountLabel, loadLibrary, libraryPath, sectionByKey} from './library.js';
import {createEmptyState, createHeader} from './widgets.js';
import {setCornerRadius} from './shape.js';
import {createMediaView, setGridAlign} from './mediaGrid.js';
import {HOME, HomeView} from './homeView.js';
import {DetailView} from './detailView.js';
import {OverviewPreview} from './overviewPreview.js';
import {MediaMenu} from './mediaMenu.js';
import {LibraryWindow} from './libraryWindow.js';
import {DetailDialog} from './detailDialog.js';

// Gap between the surface and the work-area edges, in logical px.
const OUTER_MARGIN = 28;
// `.ml-header`'s height (52px) plus its margin-bottom (24px) in stylesheet.css
// — keep in step — subtracted before sizing what goes under it. Logical px.
const HEADER_ALLOWANCE = 76;
// workspaceAnimation.js WINDOW_ANIMATION_TIME — exported only from 50, so restated.
const WORKSPACE_SLIDE_TIME = 250;
// The place a workspace showing a picked item is at. Places are what
// `_placeForWorkspace` names: HOME, a section key, or this. There is one pane
// and one pick, so there is only ever one of these.
const DETAIL = 'detail';
// What counts as "start moving around the page" when nothing is focused yet.
const NAVIGATION_KEYS = [
    Clutter.KEY_Tab, Clutter.KEY_ISO_Left_Tab,
    Clutter.KEY_Up, Clutter.KEY_Down, Clutter.KEY_Left, Clutter.KEY_Right,
];

// Open a file with the configured player, or the system default app. An
// array is a command line to run as-is (a game launcher, an emulator). The
// shell's own spawn helper says so in a notification when a launch fails, and
// so does this for the launches it does itself.
function openPath(path, playerCommand = '') {
    if (!path)
        return;
    if (Array.isArray(path)) {
        Util.spawn(path);
        return;
    }
    // This runs in the compositor, and media often lives on a network share or
    // an automount that has idled out: asked synchronously, the whole desktop
    // would stand still for as long as the share takes to come back.
    const file = Gio.File.new_for_path(path);
    file.query_info_async(
        'standard::type', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null,
        (_file, result) => {
            let isDir = false;
            try {
                isDir = file.query_info_finish(result).get_file_type() === Gio.FileType.DIRECTORY;
            } catch (e) {
                // Not there: let the launch below say so.
            }
            if (playerCommand && !isDir) {
                // Only the parse can throw here; the spawn reports itself.
                let argv;
                try {
                    [, argv] = GLib.shell_parse_argv(playerCommand);
                } catch (e) {
                    Main.notifyError(`Could not open ${file.get_basename()}`, e.message);
                    return;
                }
                Util.spawn([...argv, path]);
                return;
            }
            Gio.AppInfo.launch_default_for_uri_async(file.get_uri(),
                global.create_app_launch_context(0, -1), null, (_source, res) => {
                    try {
                        Gio.AppInfo.launch_default_for_uri_finish(res);
                    } catch (e) {
                        Main.notifyError(`Could not open ${file.get_basename()}`, e.message);
                    }
                });
        });
}

// Is this workspace still one of the manager's? A section's workspace is
// removed under us as the section closes, and `Meta.Workspace.index()` on a
// removed one is a failed assertion — a libmutter CRITICAL in the journal —
// before it returns -1. There are only ever a handful of workspaces, so ask
// the manager for them instead.
function workspaceIsLive(workspace) {
    if (!workspace)
        return false;
    const wm = global.workspace_manager;
    for (let i = 0; i < wm.n_workspaces; i++) {
        if (wm.get_workspace_by_index(i) === workspace)
            return true;
    }
    return false;
}

export class MediaLibrariesApp {
    constructor(extension) {
        this._extension = extension;
        this._settings = extension.getSettings();
        this._container = null;
        this._stack = null;
        this._overlay = null;
        this._home = null;
        this._pages = new Map();
        // The pane's own page — a header over the pane, no grid — built the
        // first time a pick needs one that is not taking a grid's place.
        this._detailPage = null;
        // The pane on the surface, for picks that open there; null when they
        // pop up instead.
        this._detail = null;
        // The popup of the "menu" and "modal" detail modes; null when picks
        // open on the surface.
        this._dialog = null;
        this._sections = {};
        this._sectionKey = null;
        this._mode = 'library';
        // The place the surface is set to show, and the place it is actually
        // showing. They differ exactly across a rebuild, which empties the
        // stack without changing what the user last asked for — so `_place`
        // is what restores it and `_shown` is what knows it needs restoring.
        this._place = null;
        this._shown = null;
        this._busy = false;
        this._reloadWanted = false;
        this._leaving = null;
        this._heroFrom = null;
        this._monitor = null;
        this._previews = null;
        // Where the library is browsed when not on the surface: the menu view
        // or the window view. Null in the desktop view.
        this._browser = null;
        // The browsers' views: what was picked, and the workspace it was
        // picked from, which is where Back returns to.
        this._picked = null;
        this._origin = null;
        this._builtBounds = null;
        this._rebuildTimer = 0;
        this._closeTimer = 0;
        this._prebuildIdle = 0;
        this._keptAlive = [];
        // The workspace each open section was given, by section key, when the
        // library opens in 'workspaces'. Held as workspaces, not indices,
        // which shift as others close.
        this._opened = new Map();
        // And the one the pane was given, when a pick opens in 'workspaces'.
        // There is one pane and one pick, so there is only ever one.
        this._detailWorkspace = null;
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
        // Every size in JS is physical pixels, worked out from the scale
        // factor as it was; a change of it is a change of everything.
        St.ThemeContext.get_for_stage(global.stage).connectObject('notify::scale-factor',
            () => this._scheduleRebuild(), this);
        // Whatever had the keyboard is forever being hidden or destroyed under
        // us — a tile as its grid recedes, a list as the detail pane is filled
        // — and Clutter drops key focus to the stage when that happens. The
        // overview takes it too, while it is up. So the surface watches for
        // the keyboard going nowhere and takes it back.
        global.stage.connectObject('notify::key-focus',
            () => this._onStageFocusChanged(), this);
        Main.overview.connectObject('hidden',
            () => this._syncKeyFocus(this._onTarget()), this);

        const rebuildKeys = ['workspace-index', 'columns', 'grid-align', 'corner-radius', 'detail-size',
            ...SECTIONS.map(s => `${s.prefix}-enabled`)];
        for (const key of rebuildKeys)
            this._settings.connectObject(`changed::${key}`, () => this._scheduleRebuild(), this);
        // What a claimed workspace means differs between the places, so none
        // is carried from one to the other; nor is a pick, which may have
        // been opened somewhere the new setting has no room for.
        for (const key of ['library-opens-in', 'detail-opens-in']) {
            this._settings.connectObject(`changed::${key}`, () => {
                this._opened.clear();
                this._detailWorkspace = null;
                this._picked = this._origin = null;
                this._scheduleRebuild();
            }, this);
        }

        // The scanner writes library.json atomically; refresh when it lands so
        // a rescan from the preferences shows up without touching the shell.
        try {
            const file = Gio.File.new_for_path(libraryPath());
            this._monitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
            this._monitor.connect('changed', (_m, _f, _o, event) => {
                if (event === Gio.FileMonitorEvent.CHANGES_DONE_HINT ||
                    event === Gio.FileMonitorEvent.CREATED ||
                    event === Gio.FileMonitorEvent.RENAMED ||
                    event === Gio.FileMonitorEvent.MOVED_IN)
                    this._scheduleRebuild({reload: true, delay: 400});
            });
        } catch (e) {
            console.warn(`[Media Libraries] Could not watch library.json: ${e}`);
        }

        this._syncVisibility(false);
    }

    disable() {
        global.workspace_manager.disconnectObject(this);
        global.display.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        Main.overview.disconnectObject(this);
        global.stage.disconnectObject(this);
        St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);
        this._settings.disconnectObject(this);
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
        this._detailWorkspace = null;
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
        // Closes whatever it had open, too.
        this._browser?.disable();
        this._browser = null;
        // The home menu and the pages are the container's children, and go
        // with it; the pane and the popup host themselves.
        this._pages.clear();
        this._detailPage = null;
        this._detail?.destroy();
        // Let go of the keyboard and the tile it came out of before it goes.
        this._dialog?.popdown();
        this._dialog?.destroy();
        // Forgotten before it is destroyed: destroying what holds the
        // keyboard drops key focus to the stage, and the watcher would hand
        // it straight back to the actor on its way out — which leaves the
        // stage holding a disposed one.
        const container = this._container;
        const stack = this._stack;
        this._home = this._detail = this._dialog = null;
        this._container = this._stack = this._overlay = null;
        if (stack)
            global.focus_manager.remove_group(stack);
        container?.destroy();
        this._busy = false;
        this._mode = 'library';
        this._shown = null;
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
            // A browser being looked at is put back on the same section
            // once rebuilt, so the change that caused the rebuild shows
            // where it is being looked for rather than on the next press.
            const browsing = this._browser?.state ?? null;
            this._teardown();
            this._applyWorkspaceMode();
            this._build();
            this._syncVisibility(false);
            this._browser?.restore(browsing);
            console.log('[Media Libraries] Rebuilt');
            return GLib.SOURCE_REMOVE;
        });
    }

    // ------------------------------------------------------------------
    // Settings helpers
    // ------------------------------------------------------------------
    _enabledSections() {
        return SECTIONS.filter(s => this._settings.get_boolean(`${s.prefix}-enabled`));
    }

    // The two independent choices. Both are one of 'desktop', 'workspaces',
    // 'menu' or 'modal'; see the note at the top of this file.
    _libraryMode() {
        return this._settings.get_string('library-opens-in');
    }

    _detailMode() {
        return this._settings.get_string('detail-opens-in');
    }

    // Drawn on the wallpaper, as against browsed somewhere of the shell's.
    // The two surface places differ only in which workspace they land on, so
    // everything about *building* either is this question and not which.
    _libraryOnSurface() {
        const mode = this._libraryMode();
        return mode === 'desktop' || mode === 'workspaces';
    }

    _detailOnSurface() {
        const mode = this._detailMode();
        return mode === 'desktop' || mode === 'workspaces';
    }

    // The surface exists for either of them; with neither, nothing of ours is
    // drawn on the wallpaper at all.
    _surfaceWanted() {
        return this._libraryOnSurface() || this._detailOnSurface();
    }

    // A pick pops up in the folder's panel rather than landing on the surface.
    _detailPopsUp() {
        return !this._detailOnSurface();
    }

    // The one thing that follows from the pair rather than from either alone:
    // the pane lands on the very workspace the grid is on, so it takes the
    // grid's place there — the hero flies, the grid recedes — instead of being
    // somewhere to go to. Anything else gives the pane a page of its own.
    _detailInPlace() {
        return this._libraryOnSurface() && this._detailMode() === 'desktop';
    }

    // Who claims a workspace of their own, and so needs one held open.
    _libraryClaimsWorkspaces() {
        return this._libraryMode() === 'workspaces';
    }

    _detailClaimsWorkspace() {
        return this._detailMode() === 'workspaces';
    }

    // The home menu's workspace. It exists only where there is a home menu,
    // which is wherever the library is on the surface; -1 is no workspace's
    // index. In 'desktop' the sections share it; in 'workspaces' they each
    // get one past it.
    _targetWorkspace() {
        if (!this._libraryOnSurface())
            return -1;
        return this._settings.get_int('workspace-index');
    }

    // "Covers per row", for every grid in every view.
    _covers() {
        return this._settings.get_int('columns');
    }

    // ------------------------------------------------------------------
    // Workspaces
    //
    // A workspace is claimed by whoever is set to open on one of their own:
    // a section, when the library opens in 'workspaces'; the pane, when a
    // pick does. Either can be true without the other.
    //
    // Only the Home workspace, `workspace-index`, is there to begin with. It
    // carries the launcher menu, and in 'desktop' the section pages as well.
    //
    // GNOME's dynamic workspaces collapse any empty workspace that is not the
    // last one, which would fold ours away; the workspace tracker spares a
    // workspace whose _keepAliveId is set (the hook it uses itself while a
    // window is being dragged to a new workspace), so ours carry a long-lived
    // timeout source there until they are closed or the extension is disabled.
    // ------------------------------------------------------------------

    // What a workspace shows: HOME for the launcher, a section key for its
    // library, DETAIL for the pane, or null when it is not one of ours.
    // Workspaces are compared as objects, never by index — see
    // `workspaceIsLive`.
    _placeForWorkspace(workspace) {
        if (!workspace)
            return null;
        // The pane on a workspace of its own is that workspace's whole point,
        // so it answers before the section pages do — with both set to
        // 'workspaces' the claimed one is past Home either way.
        if (this._detailClaimsWorkspace() && this._picked &&
            workspace === this._detailWorkspace)
            return DETAIL;
        // Opened on the workspace the pick was made on. With the library on
        // the surface that is a section's own workspace, and the pane takes
        // the page's place there rather than being a place of its own; with
        // the library browsed elsewhere, this is the only thing we draw.
        if (!this._libraryOnSurface() && this._detailOnSurface() && this._picked &&
            workspace === this._origin)
            return DETAIL;

        if (!this._libraryOnSurface())
            return null;

        const target = this._targetWorkspace();
        const home = target >= 0 && workspace === global.workspace_manager.get_workspace_by_index(target);
        // Everything shares Home: which page is up is a matter of what was
        // last pressed, not of which workspace this is.
        if (!this._libraryClaimsWorkspaces())
            return home ? this._place ?? HOME : null;
        if (home)
            return HOME;
        for (const [key, held] of this._opened) {
            if (held === workspace)
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
            console.warn(`[Media Libraries] Workspace ${needed} is where the home menu goes, but only ` +
                `${wm.n_workspaces} exist (Settings → Multitasking).`);
        }

        // An open section goes with its workspace, and with its setting.
        const enabled = this._enabledSections();
        for (const [key, workspace] of [...this._opened]) {
            if (!workspaceIsLive(workspace) || !enabled.some(s => s.key === key))
                this._opened.delete(key);
        }
        if (!workspaceIsLive(this._detailWorkspace))
            this._detailWorkspace = null;
        if (this._picked && !enabled.some(s => s.key === this._picked.key))
            this._picked = null;

        // Everything up to and including Home stays put, so its index cannot
        // shift underneath us.
        const wanted = new Set(this._opened.values());
        if (this._detailWorkspace)
            wanted.add(this._detailWorkspace);
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
            GLib.Source.set_name_by_id(ws._keepAliveId, '[media-libraries] keep section workspace');
            this._keptAlive.push(ws);
        }
        // Let the shell fold the now-empty workspaces back up.
        if (released)
            Main.wm._workspaceTracker?._queueCheckWorkspaces?.();
    }

    // A free workspace past Home, for a section or for the pane. Dynamic
    // workspaces always end in an empty one, which is exactly what is wanted;
    // holding it makes the shell add the next. With a fixed number, the first
    // one past Home that nothing is using.
    _claimWorkspace() {
        const wm = global.workspace_manager;
        const taken = new Set(this._opened.values());
        if (this._detailWorkspace)
            taken.add(this._detailWorkspace);
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

    // Claim one and hold it open, or say why not. The caller activates it.
    _takeWorkspace(what) {
        const workspace = this._claimWorkspace();
        if (!workspace) {
            console.warn(`[Media Libraries] No free workspace to open ${what} on ` +
                '(Settings → Multitasking, or open it on the desktop instead).');
            return null;
        }
        this._keepOnly(new Set([...this._keptAlive, workspace]));
        Main.wm._workspaceTracker?._queueCheckWorkspaces?.();
        return workspace;
    }

    // Let a claimed workspace go, once the slide away from it is over — the
    // shell must not be removing a workspace it is still animating from, and
    // that slide still wants a picture of what it is leaving.
    _releaseWorkspace(place, workspace) {
        this._leaving = {key: place, workspace};
        if (this._closeTimer)
            GLib.source_remove(this._closeTimer);
        // The slide honours the animations toggle and slow-down factor, so
        // the wait for it does too.
        this._closeTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            adjustAnimationTime(WORKSPACE_SLIDE_TIME) + 50, () => {
                this._closeTimer = 0;
                this._leaving = null;
                this._keepOnly(new Set(this._keptAlive.filter(ws => ws !== workspace)));
                return GLib.SOURCE_REMOVE;
            });
    }

    // Home menu -> a section. On its own workspace, made on the way if it is
    // not open already and slid to — _onWorkspaceChanged puts the library on
    // it; or, opening on the desktop, simply the page that is showing.
    _openSection(key) {
        if (this._busy)
            return;
        if (!this._libraryClaimsWorkspaces()) {
            this._showSectionNow(key, {reveal: true});
            return;
        }
        let workspace = this._opened.get(key);
        if (!workspaceIsLive(workspace)) {
            workspace = this._takeWorkspace(`the ${key} library`);
            if (!workspace)
                return;
            this._opened.set(key, workspace);
        }
        workspace.activate(global.get_current_time());
    }

    // The way back out to the home menu, from a section's library or from a
    // pane that has no library here to go back to. Whatever workspace was
    // claimed on the way in is given up behind us.
    //
    // With the library browsed elsewhere there is no home menu: "home" is the
    // workspace the pick was made on, with the browser back on that section.
    _goHome() {
        if (this._busy)
            return;
        const wm = global.workspace_manager;
        const key = this._sectionKey;
        const browsed = !this._libraryOnSurface();

        // The pane's own workspace goes first, whichever library we came from.
        const detailWorkspace = this._detailWorkspace;
        this._picked = null;
        this._detailWorkspace = null;

        const to = browsed
            ? (workspaceIsLive(this._origin) ? this._origin : wm.get_workspace_by_index(0))
            : wm.get_workspace_by_index(this._targetWorkspace());
        if (!to)
            return;

        const sliding = global.workspace_manager.get_active_workspace() !== to;
        if (browsed)
            this._browser?.open(key);
        else
            this._showHomeNow({reveal: !sliding});

        // Forgotten now, so Home arrives without its dot.
        const sectionWorkspace = this._opened.get(key);
        if (sectionWorkspace)
            this._opened.delete(key);

        const leaving = detailWorkspace ?? sectionWorkspace;
        to.activate(global.get_current_time());
        // Left without a change of workspace, when that is where it was opened.
        this._syncVisibility(true);
        if (leaving)
            this._releaseWorkspace(detailWorkspace ? DETAIL : key, leaving);
        else
            this._previews?.invalidate();
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
        const place = this._placeForWorkspace(global.workspace_manager.get_active_workspace());
        // Against `_shown`, not `_place`: after a rebuild they are the same
        // and nothing is on the stack, which is exactly when it must be put
        // back. A workspace that is not ours leaves what is there alone — the
        // surface is hidden on it either way.
        if (place && place !== this._shown) {
            if (place === HOME)
                this._showHomeNow();
            else if (place === DETAIL)
                this._showDetailNow();
            else
                this._showSectionNow(place);
        }
        this._syncVisibility(true);
    }

    // A browser -> an item: the library is somewhere of the shell's, so there
    // is no grid of ours for the pane to take the place of. It pops up, or it
    // goes on the surface — on the workspace the pick was made from, or on one
    // of its own, which is claimed before the slide that brings it in.
    //
    // A "modal" pane wants the desktop to itself, so the browser goes first
    // (the popup hides the overview itself).
    _openPicked(key, item, tile) {
        if (this._dialog) {
            if (this._detailMode() === 'modal')
                this._browser.close();
            this._dialog.popup(tile, item, sectionByKey(key));
            return;
        }
        this._browser.close();
        const active = global.workspace_manager.get_active_workspace();
        if (this._placeForWorkspace(active) === null)
            this._origin = active;
        this._showDetail(key, item);
    }

    // The pane onto the surface, wherever this pick is set to open it. Shared
    // by a pick made in a browser and one made on a grid of ours that is not
    // in the pane's way (`_detailInPlace` is the one that is).
    _showDetail(key, item) {
        this._picked = {key, item};
        if (!this._detailClaimsWorkspace()) {
            this._showDetailNow({reveal: true});
            this._syncVisibility(true);
            this._previews?.invalidate();
            return;
        }
        let workspace = this._detailWorkspace;
        if (!workspaceIsLive(workspace)) {
            workspace = this._takeWorkspace('a picked item');
            if (!workspace) {
                // Nowhere to put it: show it where we already are rather than
                // swallowing the press.
                this._detailWorkspace = null;
                this._showDetailNow({reveal: true});
                this._syncVisibility(true);
                return;
            }
            this._detailWorkspace = workspace;
        }
        // In place before the slide that brings it in.
        this._showDetailNow();
        workspace.activate(global.get_current_time());
        this._syncVisibility(true);
    }

    // Every page the stack holds: one per section, plus the pane's own.
    _allPages() {
        const pages = [...this._pages.values()];
        if (this._detailPage)
            pages.push(this._detailPage);
        return pages;
    }

    // The current page back to its library, whatever was in flight on it.
    _resetViews() {
        if (!this._container)
            return;
        this._overlay.destroy_all_children();
        this._detail?.actor.remove_all_transitions();
        this._detail?.actor.hide();
        const page = this._pages.get(this._sectionKey);
        const grid = page?.library;
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
    // first build and for a move that no slide carries.
    _showSectionNow(key, {reveal = false} = {}) {
        if (!this._container || !this._libraryOnSurface())
            return;
        this._resetViews();
        this._home?.actor.hide();
        this._mode = 'library';
        this._sectionKey = key;
        const page = this._page(key);
        for (const other of this._allPages())
            other.actor.visible = other === page;
        if (reveal)
            page.library?.reveal();
        this._place = this._shown = key;
    }

    // The pane on a page of its own, which is what it gets whenever it is not
    // taking the place of a grid of ours: put there outright, since the shell's
    // slide — or the reveal, when there is no slide — is what brings it in.
    _showDetailNow({reveal = false} = {}) {
        if (!this._container || !this._picked)
            return;
        this._resetViews();
        this._home?.actor.hide();
        this._mode = 'detail';
        const {key, item} = this._picked;
        this._sectionKey = key;
        const section = sectionByKey(key);
        const page = this._detailPageFor(section);
        for (const other of this._allPages())
            other.actor.visible = other === page;
        this._attachDetail(page);
        this._detail.populate(item, section);
        const actor = this._detail.actor;
        actor.remove_all_transitions();
        actor.opacity = 255;
        actor.translation_y = 0;
        actor.show();
        page.header.setDetailMode(false);
        // Landing without a workspace change, so no slide brings it in: the
        // same rise the in-place flight gives it, and no curve of its own.
        if (reveal) {
            actor.opacity = 0;
            actor.translation_y = 24;
            actor.ease({
                opacity: 255,
                translation_y: 0,
                duration: Duration.SLOW,
                mode: Ease.OUT_EXPO,
            });
        }
        this._place = this._shown = DETAIL;
    }

    // The detail pane is shared, and moves into whichever page wants it: its
    // own, or the section page whose grid it is replacing.
    _attachDetail(page) {
        const actor = this._detail?.actor;
        if (!actor || actor.get_parent() === page.stack)
            return;
        actor.get_parent()?.remove_child(actor);
        page.stack.add_child(actor);
    }

    // The same for the home menu.
    _showHomeNow({reveal = false} = {}) {
        if (!this._container || !this._home)
            return;
        this._resetViews();
        for (const page of this._allPages())
            page.actor.hide();
        this._home.actor.show();
        this._home.setOpened(this._opened.keys());
        if (reveal)
            this._home.reveal();
        this._mode = HOME;
        this._place = this._shown = HOME;
    }

    _open(path) {
        openPath(path, this._settings.get_string('player-command'));
    }

    // ------------------------------------------------------------------
    // Building the surface
    // ------------------------------------------------------------------
    _build() {
        // Every rounded surface reads its radius as it is constructed, so the
        // setting has to be in place before anything below is built.
        setCornerRadius(this._settings.get_int('corner-radius'));
        setGridAlign(this._settings.get_string('grid-align'));

        // Recorded first, whatever is built below: a geometry change compares
        // against it, and without it every 'workareas-changed' would rebuild.
        const bounds = this._builtBounds = this._bounds();

        // A pick that pops up has a pane of its own, in the folder's panel;
        // it hosts itself over whatever it is opened from.
        if (this._detailPopsUp()) {
            this._dialog = new DetailDialog({
                onOpen: path => this._open(path),
                size: this._settings.get_int('detail-size') / 100,
                mode: this._detailMode(),
            });
        }

        // One way of browsing at a time: a browser of its own — the library
        // as a second application menu in the overview, or in a panel popped
        // out of its button — or pages here.
        if (!this._libraryOnSurface()) {
            const Browser = this._libraryMode() === 'modal' ? LibraryWindow : MediaMenu;
            this._browser = new Browser({
                sections: this._enabledSections(),
                itemsFor: key => this._sections[key] ?? [],
                onActivate: (key, item, tile) => this._openPicked(key, item, tile),
                covers: this._covers(),
            });
            this._browser.enable();
        }

        // The library browsed elsewhere and the pane popping up: nothing of
        // ours is drawn on the wallpaper at all, so there is no surface.
        if (!this._surfaceWanted())
            return;

        this._container = new St.Widget({
            name: 'MediaLibrariesContainer',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            can_focus: true,
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
        });

        // Escape is ours: it is the way back out, one level at a time. It
        // reaches the surface by bubbling up from whatever holds the keyboard.
        this._container.connect('key-press-event', (_actor, event) => this._onKeyPress(event));

        // The surface takes the clicks the wallpaper would have had, its menu
        // included. Handing it back with the shell's own addBackgroundMenu
        // (backgroundMenu.js) was tried and dropped: its long-press gesture
        // on the surface wins over a tile's click, so holding a poster opened
        // the wallpaper menu rather than the item.

        // Pages share the surface, one visible at a time.
        this._stack = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        this._container.add_child(this._stack);

        // Tab and the arrow keys move between launchers, tiles, rows and
        // buttons because what holds them is a focus group, as the shell's own
        // dialogs and menus are — St does the walking. The group is the stack
        // and not the surface around it: a focus group that can take the
        // keyboard itself yields the focus rather than passing it on
        // (st_widget_real_navigate_focus), and the surface is focusable
        // because it is what holds the keyboard while nothing else does.
        global.focus_manager.add_group(this._stack);

        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        if (this._detailOnSurface()) {
            this._detail = new DetailView({onOpen: path => this._open(path)});
            this._detail.setSize(bounds.width, bounds.height - HEADER_ALLOWANCE * scale);
            this._detail.actor.hide();
        }

        const onSurface = this._libraryOnSurface();
        if (onSurface)
            this._buildHome(bounds);

        // Clones in flight between the two views live above both.
        this._overlay = new Clutter.Actor({x_expand: true, y_expand: true});
        this._container.add_child(this._overlay);

        const group = Main.layoutManager._backgroundGroup;
        if (group)
            group.add_child(this._container);
        else
            global.window_group.insert_child_at_index(this._container, 0);

        // What the active workspace shows, or — on a workspace that is not
        // ours — what was last asked for, so that sliding onto one of ours
        // finds a page built rather than a blank surface.
        const place = this._placeForWorkspace(global.workspace_manager.get_active_workspace()) ??
            (onSurface ? this._place ?? HOME : this._picked ? DETAIL : null);
        if (place === DETAIL)
            this._showDetailNow({reveal: true});
        else if (place && place !== HOME)
            this._showSectionNow(place, {reveal: true});
        else if (place === HOME)
            this._showHomeNow({reveal: true});

        // The overview never shows this surface — it builds its own wallpaper
        // for every workspace preview — so each gets a clone of its page.
        this._previews = new OverviewPreview({
            placeForWorkspace: workspace => this._pictureFor(workspace),
            sourceFor: place => this._actorForPlace(place),
            bounds,
        });
        this._previews.enable();

        // Only the section pages are worth building ahead: the pane's page is
        // a header and nothing else until something is picked.
        if (onSurface)
            this._prebuildPages();
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
        // In the stack, with the pages: that is the focus group.
        this._stack.add_child(this._home.actor);
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
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const section = sectionByKey(key);
        const items = this._sections[key] ?? [];
        // Sized outright, as the home menu is, for the overview's clones.
        const actor = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, width, height, visible: false});
        const header = createHeader({
            title: section.title,
            subtitle: libraryCountLabel(items.length),
            onBack: () => this._goBack(),
            onHome: () => this._goHome(),
        });
        actor.add_child(header.actor);

        // Unclipped on purpose: the library grid overhangs it slightly so
        // hovered edge tiles are not cut off.
        const stack = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        actor.add_child(stack);

        // A section page is only ever built for a library of ours; a section
        // with nothing in it says so instead of showing an empty grid.
        let library = null;
        if (items.length) {
            library = createMediaView({
                section,
                items,
                width,
                height: height - HEADER_ALLOWANCE * scale,
                covers: this._covers(),
                onActivate: (_key, item, tile) => this._openItem(item, tile),
            });
            stack.add_child(library);
        } else {
            stack.add_child(createEmptyState({
                icon: section.icon,
                title: `No ${section.title.toLowerCase()} yet`,
                hint: section.emptyHint,
                actionLabel: 'Open Settings',
                onAction: () => this._extension.openPreferences(),
            }));
        }

        this._stack.add_child(actor);
        return {key, actor, header, stack, library};
    }

    // The pane's own page: a header over the shared pane, and no grid. One
    // serves every section, since there is one pane and one pick — its header
    // is retitled to whichever section the pick came from.
    _detailPageFor(section) {
        if (!this._detailPage) {
            const {width, height} = this._builtBounds;
            const actor = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                width, height, visible: false,
            });
            const header = createHeader({
                title: section.title,
                subtitle: '',
                onBack: () => this._goBack(),
                onHome: () => this._goHome(),
            });
            actor.add_child(header.actor);
            const stack = new St.Widget({
                layout_manager: new Clutter.BinLayout(),
                x_expand: true, y_expand: true,
            });
            actor.add_child(stack);
            this._stack.add_child(actor);
            this._detailPage = {key: DETAIL, actor, header, stack, library: null};
        }
        this._detailPage.header.setTitle(section.title);
        return this._detailPage;
    }

    // The actor the overview should clone for a place.
    _actorForPlace(place) {
        if (place === HOME)
            return this._home?.actor;
        if (place === DETAIL)
            return this._detailPage?.actor;
        return this._page(place).actor;
    }

    // What the shell's picture of a workspace shows. A section or a pane on
    // its way out is no longer open, but the slide it leaves by still draws it.
    _pictureFor(workspace) {
        if (!workspace)
            return null;
        if (this._leaving?.workspace === workspace)
            return this._leaving.key;
        return this._placeForWorkspace(workspace);
    }

    // The surface fills the monitor's work area (so docks and panels from
    // other extensions are respected), inset by a margin.
    _bounds() {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const margin = OUTER_MARGIN * scale;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return {x: margin, y: margin, width: 1920 - 2 * margin, height: 1080 - 2 * margin};
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        return {
            x: area.x + margin,
            y: area.y + margin,
            width: area.width - 2 * margin,
            height: area.height - 2 * margin,
        };
    }

    // ------------------------------------------------------------------
    // Navigation
    // ------------------------------------------------------------------
    // A grid of ours -> an item. The flight below is what a pick looks like
    // only when the pane lands on this very workspace, in the grid's place:
    // the artwork flies to the hero slot while the grid recedes and the pane
    // rises. A pick that pops up zooms the panel out of the tile and leaves
    // the page as it is; one that opens somewhere else goes there instead.
    async _openItem(item, tile) {
        if (this._busy || this._mode !== 'library')
            return;
        if (this._dialog) {
            this._dialog.popup(tile, item, sectionByKey(this._sectionKey));
            return;
        }
        if (!this._detailInPlace()) {
            this._showDetail(this._sectionKey, item);
            return;
        }
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

        const grid = page.library;
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

    // Detail -> library. In place, it is the flight mirrored: the hero flies
    // back to its tile while the grid comes forward again. From a pane that
    // is somewhere of its own, it is a move back to wherever the library is —
    // the section's workspace or page, or, with the library browsed
    // elsewhere, the workspace the pick was made on (which is `_goHome`).
    async _goBack() {
        if (!this._detailInPlace()) {
            if (!this._libraryOnSurface()) {
                this._goHome();
                return;
            }
            if (this._busy)
                return;
            const key = this._sectionKey;
            const detailWorkspace = this._detailWorkspace;
            this._picked = null;
            this._detailWorkspace = null;
            if (this._libraryClaimsWorkspaces()) {
                // Back to the section's own workspace, opening it again if it
                // was never claimed (the pane was reached from the home menu
                // with the library on a workspace it no longer holds). The
                // slide is the transition; `_openSection` queues no reveal.
                this._openSection(key);
            } else {
                // Every section shares the home workspace, which is where the
                // pane was opened from and so where Back goes.
                const wm = global.workspace_manager;
                const home = wm.get_workspace_by_index(this._targetWorkspace());
                const sliding = home && wm.get_active_workspace() !== home;
                this._showSectionNow(key, {reveal: !sliding});
                home?.activate(global.get_current_time());
            }
            this._syncVisibility(true);
            if (detailWorkspace)
                this._releaseWorkspace(DETAIL, detailWorkspace);
            else
                this._previews?.invalidate();
            return;
        }
        if (this._busy || this._mode !== 'detail')
            return;
        this._busy = true;
        this._mode = 'library';

        const detailActor = this._detail.actor;
        const hero = this._detail.hero;
        const page = this._page();
        const grid = page.library;
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
    // Keyboard
    // ------------------------------------------------------------------
    // Escape backs out a level, as it does everywhere in the shell: out of an
    // item to the library, out of a library to the home menu. Everything else
    // — Tab, the arrows, Enter on a tile — is St's own focus handling.
    _onKeyPress(event) {
        const symbol = event.get_key_symbol();
        if (symbol === Clutter.KEY_Escape) {
            if (this._mode === 'detail')
                this._goBack();
            else if (this._mode === 'library')
                this._goHome();
            else
                return Clutter.EVENT_PROPAGATE;
            return Clutter.EVENT_STOP;
        }
        // Nothing is focused until a navigation key asks for it — as the app
        // grid has it, where the first Tab lands on the first icon. From there
        // the focus manager walks the group on its own.
        if (NAVIGATION_KEYS.includes(symbol) &&
            global.stage.get_key_focus() === this._container) {
            // A grid says where its keyboard starts; anything else hands the
            // first key to St, which finds the first thing that can take it.
            const target = this._focusTarget();
            if (target?.focusFirst?.() ||
                target?.navigate_focus(null, St.DirectionType.TAB_FORWARD, false))
                return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // What the first key lands on: the launchers, the grid, or the detail
    // pane's first button — the thing being browsed, not the header above it.
    _focusTarget() {
        if (this._mode === HOME)
            return this._home?.actor;
        if (this._mode === 'detail')
            return this._detail?.actor;
        const page = this._pages.get(this._sectionKey);
        return page?.library ?? page?.actor;
    }

    // Is the active workspace one of ours — the home menu, or a section?
    _onTarget() {
        return this._placeForWorkspace(global.workspace_manager.get_active_workspace()) !== null;
    }

    // Key focus has gone somewhere: if it went nowhere at all, and the surface
    // is what the workspace shows, it is ours to take back. Focus that has
    // gone to another actor — a menu, the panel — is left where it is, and
    // so is the keyboard while the popup holds it.
    _onStageFocusChanged() {
        if (!this._container)
            return;
        if (Main.overview.visible || this._dialog?.isOpen || global.stage.get_key_focus())
            return;
        this._syncKeyFocus(this._onTarget());
    }

    // The surface takes the keyboard while it is what the workspace shows, and
    // gives it back when it is not. A window on the workspace keeps it either
    // way: its keys never reach the stage.
    _syncKeyFocus(onTarget) {
        if (!this._container)
            return;
        const focus = global.stage.get_key_focus();
        const ours = focus && this._container.contains(focus);
        if (onTarget && !ours)
            global.stage.set_key_focus(this._container);
        else if (!onTarget && ours)
            global.stage.set_key_focus(null);
    }

    // ------------------------------------------------------------------
    // Visibility
    // ------------------------------------------------------------------
    _syncVisibility(animate) {
        if (!this._container)
            return;
        const onTarget = this._onTarget();
        this._syncKeyFocus(onTarget);
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
