// One item up close, popped up the way the shell opens an app folder: the
// tile fades away, the panel zooms out of its artwork over a shade, and a
// click on the shade or Escape zooms it back. This is `panel.js` — the
// shell's folder panel — with the detail pane inside it where the folder
// holds its grid, and nothing else added.
//
// It serves both pop-up places a pick can open in (`detail-opens-in`), either
// of which any library can use. In "menu" it is the folder exactly: hosted
// where the pick was made — over the overview when the pick came from there,
// over the wallpaper when it came off a page of ours — and gone the moment its
// tile unmaps, as a folder goes with its icon. "modal" is the same panel with
// two flags turned: it is hosted in `uiGroup` always (the overview is hidden
// first, and the pick then has no tile to come out of, so it fades in centred)
// and it does not die with its source, so a change of workspace leaves it up.
// Escape or a click away is what closes it either way.
//
// It opens in two moves, so that the first is the folder's exactly. The panel
// zooms out of the tile at the width of the artwork alone — poster-shaped, as
// the folder's square panel is icon-shaped, so the zoom is near enough uniform
// — and only then opens out sideways onto the title, the facts and the season
// or track list, which were built while it zoomed. Closing mirrors it: the
// second column goes, the panel narrows back to its artwork, and that is what
// zooms home. Nothing here waits on anything: the list fills as it scrolls.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Duration, Ease, ensureStyleDeep} from './anim.js';
import {DetailView} from './detailView.js';
import {MediaPanel} from './panel.js';
import {PANE_INSET} from './shape.js';

export const DetailDialog = GObject.registerClass(
class MediaLibrariesDetailDialog extends MediaPanel {
    _init({onOpen, size = 1, mode = 'menu'}) {
        super._init({
            size,
            // In "modal" the panel outlives the overview that may have been
            // up when the pick was made, so it is never hosted in it.
            host: mode === 'modal' ? Main.layoutManager.uiGroup : null,
            dieWithSource: mode !== 'modal',
            // The folder's panel frames what it holds; the pane sits inside
            // that frame rather than running to the panel's edge.
            inset: PANE_INSET,
        });

        this._mode = mode;

        // The pane is laid out once, at the width the panel ends up, inside a
        // clip that is the panel. Widening the panel then reveals the second
        // column instead of reflowing every label and row under it on each
        // frame of the animation — a fixed layout hands the pane the size it
        // asks for whatever the panel around it currently is.
        this._clip = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            x_expand: true,
            y_expand: true,
            clip_to_allocation: true,
        });
        this._panel.add_child(this._clip);

        // The folder's panel is the surface here, so the pane draws none.
        this._detail = new DetailView({onOpen, frame: 'bare'});
        this._detail.actor.set_position(0, 0);
        this._clip.add_child(this._detail.actor);

        // Panel widths: what it zooms out of the tile at, and what it opens to.
        this._narrowWidth = 320;
        this._wideWidth = 320;

        this._item = null;
        this._section = null;

        this.connect('destroy', () => this._detail.destroy());
    }

    // Filled before it is measured: the panel's size comes from the side
    // column, so the pane has to hold the item first. What the pane is given
    // is the budget less the frame the panel keeps around it.
    _prepare(budget) {
        const frame = 2 * this._framePx;
        this._detail.setSize(budget.width - frame, budget.height - frame);
        // Held back: the panel zooms out of the tile on the artwork alone, and
        // `_widen` brings the rest in once it has landed.
        this._detail.populate(this._item, this._section, {mainColumn: 'held'});
    }

    // Closed, the panel is the pane's side column and nothing else: the
    // artwork and the buttons under it. What that comes to is asked of the
    // column itself, now it is built — a preferred size needs no allocation —
    // rather than added up here from the sizes the pane used.
    _sizePanel(budget) {
        const frame = 2 * this._framePx;

        // Asked before its styles are resolved, a freshly built column answers
        // without its own `spacing` and without the hero's margin — twenty-six
        // pixels short on the default theme. The panel then came out shorter
        // than the pane inside it, and the clip that holds the pane cut the
        // backdrop's bottom corners off square against the panel's rounded
        // ones. Nothing here may be measured before this call.
        ensureStyleDeep(this._detail.actor);

        const pad = 2 * this._detail.padding;
        const [, sideWidth] = this._detail.side.get_preferred_width(-1);
        const [, sideHeight] = this._detail.side.get_preferred_height(sideWidth);

        // The pane is what the column comes to; the panel is that plus its
        // frame. `detail-size` caps it, but never below what the column takes:
        // a small work area at the smallest size leaves the hero on its floor
        // (detailView.js THUMB_SIZE) and the column can then want more than
        // the fraction allows — and a panel shorter than its pane is cut
        // square again. The work area itself is the ceiling instead.
        const paneWidth = budget.width - frame;
        const paneHeight = Math.min(Math.ceil(sideHeight) + pad, budget.maxHeight - frame);
        this._wideWidth = budget.width;
        this._narrowWidth = Math.min(budget.width, Math.ceil(sideWidth) + pad + frame);

        // The pane is laid out once, at the width it opens to; the panel is
        // the clip that starts narrower than it.
        this._detail.setSize(paneWidth, paneHeight);
        this._detail.actor.set_size(paneWidth, paneHeight);
        this._panel.remove_all_transitions();
        this._panel.set_size(this._narrowWidth, paneHeight + frame);
        this._restSize = [this._narrowWidth, paneHeight + frame];
    }

    _opened() {
        this._widen();
    }

    _closeSequence() {
        this._narrowAndZoomOut();
    }

    // Second move: the panel opens out onto the second column. It follows the
    // zoom rather than overlapping it — the zoom's scale is a ratio of the
    // panel's width, so changing that width under it would move the panel's
    // edges twice over.
    _widen() {
        if (!this.isOpen)
            return;
        this._detail.revealMain({delay: Duration.NORMAL / 4});
        if (this._wideWidth <= this._narrowWidth)
            return;
        this._panel.ease({
            width: this._wideWidth,
            duration: Duration.NORMAL,
            mode: Ease.OUT_EXPO,
        });
    }

    // And back: the column goes and the panel closes down to its artwork, so
    // that what zooms home is the shape the tile is. `_closingLead` is how far
    // ahead of the zoom that leaves it, for the tile that is waiting to return.
    _narrowAndZoomOut() {
        this._panel.remove_transition('width');
        this._closingLead = 0;
        if (!this._source?.mapped || this._panel.width <= this._narrowWidth) {
            this._zoomAndFadeOut();
            return;
        }
        this._detail.hideMain();
        this._closingLead = Duration.FAST;
        this._panel.ease({
            width: this._narrowWidth,
            duration: Duration.FAST,
            mode: Ease.OUT,
            onComplete: () => this._zoomAndFadeOut(),
        });
    }

    // `item` of `section`, out of `source`, its tile.
    popup(source, item, section) {
        if (this.isOpen)
            return;

        this.accessible_name = item.title;
        this._item = item;
        this._section = section;

        // In "modal" the pane lives on the desktop, so the overview goes
        // first — which unmaps the tile the pick was made on, leaving nothing
        // to zoom out of; the panel fades in centred instead.
        if (this._mode === 'modal' && Main.overview.visible) {
            Main.overview.hide();
            source = null;
        }

        super.popup(source);
    }
});
