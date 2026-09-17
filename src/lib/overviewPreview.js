// Gnomeflix in the Activities overview.
//
// The overview does not show the desktop background group: every workspace
// preview builds its own wallpaper actor and clones that workspace's windows
// over it, so a surface parented into `_backgroundGroup` is simply not there
// and each section's workspace reads as empty. This puts it back — a static,
// non-interactive copy of the section's library, built at monitor size and
// laid into the preview's own background group, where the overview's scaling
// carries it exactly as it carries the wallpaper.
//
// A copy belongs to the overview that is open: the shell builds its previews
// when the overview opens and destroys them when it closes, so the copies are
// built and thrown away with them.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {allocateNow} from './anim.js';
import {sectionByKey} from './library.js';
import {createSegmented} from './widgets.js';
import {LibraryView} from './libraryView.js';

// Rows of tiles to build per copy. The grid does not scroll in a picture, so
// this only has to cover what the preview shows.
const VISIBLE_ROWS = 3;

// The preview's background group stands for the whole monitor, but it is
// allocated at whatever size the overview has animated the workspace to — and
// stretched independently in x and y while that animation runs, exactly as the
// wallpaper inside it is. Holding the copy in an actor that reads its own
// allocation back as a scale is the only way to follow that reliably: the
// group re-allocates without always notifying its size.
const PreviewHost = GObject.registerClass(
class PreviewHost extends Clutter.Actor {
    _init(props, monitor) {
        super._init(props);
        this._monitor = monitor;
        this._mirrors = [];
    }

    // A clone paints its source through the source's own transform, so a
    // mirror of this copy inherits the preview's scale on top of whatever it
    // is given. Undoing it here keeps the two in step frame by frame.
    addMirror(clone) {
        this._mirrors.push(clone);
        this._syncMirrors();
    }

    _syncMirrors() {
        if (!this._scaleX || !this._scaleY)
            return;
        for (const mirror of this._mirrors)
            mirror.set_scale(1 / this._scaleX, 1 / this._scaleY);
    }

    // The preview sizes itself from its porthole, not from what is in it: a
    // size request here would stretch the workspace out of shape.
    vfunc_get_preferred_width() {
        return [0, 0];
    }

    vfunc_get_preferred_height() {
        return [0, 0];
    }

    vfunc_allocate(box) {
        super.vfunc_allocate(box);
        const surface = this.get_first_child();
        if (!surface)
            return;
        const scaleX = box.get_width() / this._monitor.width;
        const scaleY = box.get_height() / this._monitor.height;
        if (!isFinite(scaleX) || !isFinite(scaleY) || scaleX <= 0 || scaleY <= 0)
            return;
        this._scaleX = scaleX;
        this._scaleY = scaleY;
        surface.set_scale(scaleX, scaleY);
        this._syncMirrors();
    }
});

// Everything in a preview is a picture of the surface, never a control: a
// reactive actor here would eat the click that activates the workspace.
function deactivate(actor) {
    actor.reactive = false;
    if (actor instanceof St.Widget)
        actor.track_hover = false;
    for (const child of actor.get_children())
        deactivate(child);
}

export class OverviewPreview {
    constructor({sectionForWorkspace, itemsFor, enabledSections, columnsPreference, bounds, headerAllowance}) {
        this._sectionForWorkspace = sectionForWorkspace;
        this._itemsFor = itemsFor;
        this._enabledSections = enabledSections;
        this._columnsPreference = columnsPreference;
        this._bounds = bounds;
        this._headerAllowance = headerAllowance;
        this._copies = [];
    }

    enable() {
        // 'showing' is early enough: the previews exist before the overview
        // animates in, so the copies are there for the first frame rather than
        // appearing once it has settled.
        Main.overview.connectObject(
            'showing', () => this._attach(),
            'hidden', () => this._detach(),
            this);
        // A rebuild (a rescan landing, a setting changing) makes a new one of
        // these under an overview that is already open.
        if (Main.overview.visible)
            this._attach();
    }

    destroy() {
        Main.overview.disconnectObject(this);
        this._detach();
    }

    // The library or the layout changed under an open overview.
    invalidate() {
        if (!this._copies.length)
            return;
        this._detach();
        this._attach();
    }

    // ------------------------------------------------------------------
    // Attaching to the overview's own previews
    // ------------------------------------------------------------------
    _attach() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        for (const workspace of this._workspacePreviews()) {
            const background = workspace._background;
            const group = background?._backgroundGroup;
            // Gnomeflix only ever draws on the primary monitor, so the other
            // monitors' previews are left as they are.
            if (!group || background._monitorIndex !== Main.layoutManager.primaryIndex)
                continue;

            const index = workspace.metaWorkspace?.index?.();
            const key = this._sectionForWorkspace(index);
            if (!key)
                continue;

            const host = this._buildHost(key, monitor);
            group.add_child(host);
            // Lay it out now rather than next frame: the thumbnail's clone has
            // nothing to paint until the copy has an allocation, and a preview
            // that is already open may not allocate again on its own.
            allocateNow(host);
            this._track(host);
            this._attachThumbnail(index, host);
        }
    }

    // The previews are the overview's, and it destroys them when it closes —
    // taking the copies with them — so nothing here outlives one overview.
    _detach() {
        for (const actor of [...this._copies])
            actor.destroy();
        this._copies = [];
    }

    _track(actor) {
        this._copies.push(actor);
        actor.connect('destroy', () => {
            const at = this._copies.indexOf(actor);
            if (at >= 0)
                this._copies.splice(at, 1);
        });
    }

    // The workspace previews, across every monitor's view.
    _workspacePreviews() {
        const views = Main.overview._overview?.controls?._workspacesDisplay?._workspacesViews ?? [];
        const out = [];
        for (const view of views)
            out.push(...(view._workspaces ?? []));
        return out;
    }

    // The strip at the top of the overview shows the same workspaces at
    // thumbnail size. An actor has one parent, so rather than a second copy
    // the thumbnail gets a clone of the one already in the big preview, which
    // the host keeps at the right scale.
    _attachThumbnail(index, host) {
        const thumbnails = Main.overview._overview?.controls?._thumbnailsBox?._thumbnails ?? [];
        const contents = thumbnails[index]?._contents;
        const surface = host.get_first_child();
        if (!contents || !surface)
            return;
        const clone = new Clutter.Clone({source: surface, reactive: false});
        contents.add_child(clone);
        host.addMirror(clone);
        this._track(clone);
    }

    // ------------------------------------------------------------------
    // Building one section's copy
    // ------------------------------------------------------------------
    _buildHost(key, monitor) {
        const host = new PreviewHost({
            name: `GnomeflixPreview:${key}`,
            // Fill whatever box the preview hands out without asking for a
            // size of its own; the scale is read back off that box.
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
            x_expand: true,
            y_expand: true,
            reactive: false,
        }, monitor);

        const surface = this._buildSurface(key);
        surface.set_position(this._bounds.x - monitor.x, this._bounds.y - monitor.y);
        host.add_child(surface);
        deactivate(host);
        return host;
    }

    _buildSurface(key) {
        const {width, height} = this._bounds;
        const surface = new St.Widget({
            style_class: 'gf-surface',
            layout_manager: new Clutter.BinLayout(),
            width,
            height,
        });

        const column = new St.BoxLayout({vertical: true, x_expand: true, y_expand: true});
        surface.add_child(column);
        column.add_child(this._buildHeader(key));

        const library = new LibraryView({
            columnsPreference: this._columnsPreference,
            onActivate: () => {},
            onOpenSettings: () => {},
        });
        library.setSize(width, height - this._headerAllowance);

        const stack = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        stack.add_child(library.actor);
        column.add_child(stack);

        // Nothing scrolls in a picture, so only the rows the grid actually
        // shows are worth building — the rest would be laid out and clipped
        // away, six sections at a time, every time the overview opens.
        const {columns} = library.metrics(sectionByKey(key).aspect);
        library.showSection(key, this._itemsFor(key).slice(0, columns * VISIBLE_ROWS));

        return surface;
    }

    // The static twin of the app's header: the same classes and the same
    // switcher, without the back button or the mode it animates between.
    _buildHeader(key) {
        const actor = new St.BoxLayout({style_class: 'gf-header', x_expand: true, y_align: Clutter.ActorAlign.CENTER});

        const titles = new St.BoxLayout({vertical: true, style_class: 'gf-header-titles', y_align: Clutter.ActorAlign.CENTER});
        const count = this._itemsFor(key).length;
        titles.add_child(new St.Label({style_class: 'gf-header-title', text: sectionByKey(key).title}));
        titles.add_child(new St.Label({
            style_class: 'gf-header-subtitle',
            text: count ? `${count} in your library` : 'Nothing indexed yet',
        }));
        actor.add_child(titles);

        actor.add_child(new St.Widget({x_expand: true}));
        actor.add_child(createSegmented(this._enabledSections(), key, null).actor);
        return actor;
    }
}
