// Media Libraries in the shell's own pictures of a workspace: the Activities
// overview, and the slide between workspaces.
//
// Neither shows the desktop background group: every workspace
// preview builds its own wallpaper actor and clones that workspace's windows
// over it, so a surface parented into `_backgroundGroup` is simply not there
// and the library's workspace reads as empty. This puts it back the way the
// shell puts the windows back — as a clone. Each preview gets a clone of the
// live page that its workspace shows, laid into the preview's own background
// group, where the overview's scaling carries it exactly as it carries the
// wallpaper. Nothing is built twice, and a page scrolled halfway down looks
// that way in its preview.
//
// A clone belongs to the overview that is open: the shell builds its previews
// when the overview opens and destroys them when it closes, and the clones go
// with them.
//
// The slide is the same story in miniature. For as long as it runs the shell
// covers the desktop with a strip of workspaces, each over a wallpaper of its
// own, and throws the strip away when it lands; a clone in each of ours means
// the library travels with its workspace instead of turning up afterwards.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';

// The slide is joined through one wrap of the shell's workspace animation,
// put in for the life of the extension rather than per build: the wrap goes
// on a shared prototype, where another extension's may sit over or under
// it, and a rebuild — every rescan — that took it out and put it back would
// take a later one's with it. It hands the slide to whichever OverviewPreview
// is current.
let current = null;
const injections = new InjectionManager();

export function installSlideHook() {
    const animation = Main.wm._workspaceAnimation;
    if (!animation?._prepareWorkspaceSwitch)
        return;
    injections.overrideMethod(Object.getPrototypeOf(animation), '_prepareWorkspaceSwitch',
        original => function (...args) {
            // It returns early, touching nothing, when a slide is already
            // under way (a swipe picked up mid-flight).
            const fresh = !this._switchData;
            original.apply(this, args);
            if (fresh && this._switchData)
                current?._joinSlide(this._switchData);
        });
}

export function removeSlideHook() {
    injections.clear();
}

// The preview's background group stands for the whole monitor, but it is
// allocated at whatever size the overview has animated the workspace to — and
// stretched independently in x and y while that animation runs, exactly as the
// wallpaper inside it is. Holding the picture in an actor that reads its own
// allocation back as a scale is the only way to follow that reliably: the
// group re-allocates without always notifying its size.
const PreviewHost = GObject.registerClass(
class PreviewHost extends Clutter.Actor {
    _init(props, monitor) {
        super._init(props);
        this._monitor = monitor;
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
        const frame = this.get_first_child();
        if (!frame)
            return;
        const scaleX = box.get_width() / this._monitor.width;
        const scaleY = box.get_height() / this._monitor.height;
        if (!isFinite(scaleX) || !isFinite(scaleY) || scaleX <= 0 || scaleY <= 0)
            return;
        // The overview re-allocates its previews on most frames of its own
        // animation; a scale that has not moved is not worth setting again.
        if (scaleX === this._scaleX && scaleY === this._scaleY)
            return;
        this._scaleX = scaleX;
        this._scaleY = scaleY;
        frame.set_scale(scaleX, scaleY);
    }
});

export class OverviewPreview {
    // `placeForWorkspace` names what a workspace shows (or null when it is not
    // one of ours) and `sourceFor` hands over the live actor showing that. It
    // is handed the Meta.Workspace itself: `index()` on a workspace the shell
    // has already removed — the one a closing section is sliding off — is a
    // failed assertion, and both of the pictures below can outlive one.
    constructor({placeForWorkspace, sourceFor, bounds}) {
        this._placeForWorkspace = placeForWorkspace;
        this._sourceFor = sourceFor;
        this._bounds = bounds;
        this._clones = [];
        this._attached = false;
    }

    enable() {
        current = this;
        // 'showing' is early enough: the previews exist before the overview
        // animates in, so the clones are there for the first frame rather
        // than appearing once it has settled.
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
        if (current === this)
            current = null;
        Main.overview.disconnectObject(this);
        this._detach();
    }

    // The strip is destroyed when the slide lands, and these with it.
    _joinSlide(switchData) {
        const monitor = Main.layoutManager.primaryMonitor;
        const strip = switchData.monitors?.find(m => m._monitor?.index === monitor?.index);
        for (const group of strip?._workspaceGroups ?? []) {
            const place = this._placeForWorkspace(group.workspace);
            const source = place ? this._sourceFor(place) : null;
            // Over the wallpaper and under the desktop's own windows.
            const wallpaper = group._background?.get_first_child();
            if (source && wallpaper)
                group._background.insert_child_above(this._cloneOf(source, this._bounds.x - monitor.x, this._bounds.y - monitor.y), wallpaper);
        }
    }

    // The layout changed under an open overview.
    invalidate() {
        if (!this._attached)
            return;
        this._detach();
        this._attach();
    }

    _attach() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        this._attached = true;

        for (const workspace of this._workspacePreviews()) {
            const background = workspace._background;
            const group = background?._backgroundGroup;
            // Media Libraries only ever draws on the primary monitor, so the other
            // monitors' previews are left as they are.
            if (!group || background._monitorIndex !== Main.layoutManager.primaryIndex)
                continue;

            const place = this._placeForWorkspace(workspace.metaWorkspace);
            const source = place ? this._sourceFor(place) : null;
            if (!source)
                continue;

            // A frame the size of the monitor, scaled as one to the preview,
            // so the surface keeps its margins in proportion. It is drawn
            // once into a texture and that is what the overview's animation
            // scales, rather than every tile of the page on every frame.
            const host = new PreviewHost({
                name: `MediaLibrariesPreview:${place}`,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.FILL,
                x_expand: true,
                y_expand: true,
                reactive: false,
            }, monitor);
            const frame = new Clutter.Actor({width: monitor.width, height: monitor.height, reactive: false});
            frame.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);
            frame.add_child(this._cloneOf(source, this._bounds.x - monitor.x, this._bounds.y - monitor.y));
            host.add_child(frame);
            group.add_child(host);
            this._track(host);

            // The strip at the top of the overview shows the same workspaces
            // at thumbnail size; its contents are laid out in stage
            // coordinates, as the window clones beside this one are.
            const thumbnails = Main.overview._overview?.controls?._thumbnailsBox?._thumbnails ?? [];
            const contents = thumbnails.find(t => t.metaWorkspace === workspace.metaWorkspace)?._contents;
            if (contents) {
                const clone = this._cloneOf(source, this._bounds.x, this._bounds.y);
                contents.add_child(clone);
                this._track(clone);
            }
        }
    }

    // A picture of `source` at the size of the surface. A clone is never
    // reactive, so the click that activates the workspace passes through it.
    _cloneOf(source, x, y) {
        return new Clutter.Clone({
            source,
            reactive: false,
            x,
            y,
            width: this._bounds.width,
            height: this._bounds.height,
        });
    }

    // The previews are the overview's, and it destroys them when it closes —
    // taking the clones with them — so nothing here outlives one overview.
    _detach() {
        this._attached = false;
        for (const actor of [...this._clones])
            actor.destroy();
        this._clones = [];
    }

    _track(actor) {
        this._clones.push(actor);
        actor.connect('destroy', () => {
            const at = this._clones.indexOf(actor);
            if (at >= 0)
                this._clones.splice(at, 1);
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
}
