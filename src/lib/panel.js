// The panel the shell opens an app folder in, with the folder taken out of it.
//
// This is the shell's AppFolderDialog (appDisplay.js:2461-2523) — the shade,
// the panel that zooms out of the icon it was opened from, the grab, the
// click-away, the settle — with the folder's grid and its name entry removed.
// What goes inside is the subclass's: the detail pane (detailDialog.js) or the
// modal library's grid (libraryWindow.js). The shape and shade are the
// shell's own `app-folder-dialog` style, so the panel is the folder's; its
// corners follow `corner-radius` as every rounded surface here does.
//
// Two things the folder has no need of are options here. `dieWithSource` is
// the folder's own behaviour — the panel goes the moment the icon it came out
// of unmaps — which the `window` modes turn off, since they are meant to
// outlive the overview that was up when the pick was made. And a panel can be
// opened with no source at all, which fades it in centred (`_fadeIn`) rather
// than zooming it out of a tile that is not there.
//
// Sizing is in two halves: `_budget()` is the room the work area leaves, and
// `_sizePanel()` — the subclass's — is what it makes of it. Whatever it sets
// is the panel's size at rest, which `_settle` restores.

import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as GrabHelper from 'resource:///org/gnome/shell/ui/grabHelper.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Duration, Ease, POP_SCALE, rectIn} from './anim.js';
import {radiusStyle} from './shape.js';

// Between the panel and the edges of the work area, and the size it will not
// grow past however much room there is. A folder's panel is 720px square; this
// is one poster wider, and no taller. All three are logical pixels, multiplied
// by the scale factor where they meet an allocation.
const MARGIN = 48;
const MAX_WIDTH = 1180;
const MAX_HEIGHT = 760;
// The shade behind the panel: the shell's DIALOG_SHADE_NORMAL, not exported.
const SHADE = new Cogl.Color({red: 0, green: 0, blue: 0, alpha: 204});
const CLEAR = new Cogl.Color({red: 0, green: 0, blue: 0, alpha: 0});

export const MediaPanel = GObject.registerClass({
    Signals: {
        'open-state-changed': {param_types: [GObject.TYPE_BOOLEAN]},
    },
}, class MediaLibrariesPanel extends St.Bin {
    _init({host = null, dieWithSource = true, size = 1, accessibleName = ''} = {}) {
        super._init({
            visible: false,
            x_expand: true,
            y_expand: true,
            reactive: true,
            accessible_role: Atk.Role.PANEL,
            accessible_name: accessibleName,
        });

        // The monitor the panel is shown on is picked per open, so the
        // constraint is held rather than pinned to the primary.
        this._constraint = new Layout.MonitorConstraint({index: Main.layoutManager.primaryIndex});
        this.add_constraint(this._constraint);

        this._host = host;
        this._dieWithSource = dieWithSource;
        this._size = size;

        this._addClickAway();

        this._panel = new St.BoxLayout({
            style_class: 'app-folder-dialog',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            orientation: Clutter.Orientation.VERTICAL,
            style: radiusStyle('pane'),
        });
        this._panel.set_pivot_point(0, 0);

        // The container is the monitor; its padding is what the work area
        // leaves out, so the panel is centred in the work area (_budget).
        this.child = new St.Bin({
            child: this._panel,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });

        global.focus_manager.add_group(this);

        this._grabHelper = new GrabHelper.GrabHelper(this, {
            actionMode: Shell.ActionMode.POPUP,
        });

        this._source = null;
        this._isOpen = false;
        this._needsZoomAndFade = false;
        // How far ahead of the zoom the panel's own closing move leaves it,
        // for the tile that is waiting to come back. The subclass sets it.
        this._closingLead = 0;
        // The size the panel has at rest, set by `_sizePanel`.
        this._restSize = [320, 320];

        // The tile goes as the panel comes, and comes back as it goes, as a
        // folder's icon does.
        this.connect('open-state-changed', (_panel, isOpen) => {
            const source = this._source;
            if (!source)
                return;
            const duration = Duration.NORMAL / 2;
            source.ease({
                opacity: isOpen ? 0 : 255,
                duration,
                mode: isOpen ? Ease.OUT : Ease.IN,
                delay: isOpen ? 0 : this._closingLead + Duration.NORMAL - duration,
            });
        });

        // Whatever inside held the keyboard can be destroyed under it — a
        // list, as its tab is switched — and Clutter then drops key focus to
        // the stage; while the panel is up it is the panel's.
        global.stage.connectObject('notify::key-focus', () => {
            if (this._isOpen && !global.stage.get_key_focus())
                this.grab_key_focus();
        }, this);

        this.connect('destroy', () => this._onDestroy());
    }

    // A click on the shade, outside the panel, closes it. Clutter.ClickGesture
    // is 49 and later; on 48 this is the shell's own AppFolderDialog click
    // action (`git show 48.0:js/ui/appDisplay.js`, line 2497). Chosen once,
    // here, so nothing else in the extension has to know the difference.
    _addClickAway() {
        if (Clutter.ClickGesture) {
            const clickGesture = new Clutter.ClickGesture();
            clickGesture.connect('may-recognize', () => {
                const coords = clickGesture.get_coords_abs();
                const [, x, y] = this.child.transform_stage_point(coords.x, coords.y);
                return !this._panel.allocation.contains(x, y);
            });
            clickGesture.connect('recognize', () => this.popdown());
            this.add_action(clickGesture);
            return;
        }

        const clickAction = new Clutter.ClickAction();
        clickAction.connect('clicked', () => {
            const [x, y] = clickAction.get_coords();
            if (global.stage.get_actor_at_pos(Clutter.PickMode.ALL, x, y) === this)
                this.popdown();
        });
        this.add_action(clickAction);
    }

    get isOpen() {
        return this._isOpen;
    }

    _onDestroy() {
        if (this._isOpen) {
            this._isOpen = false;
            this._grabHelper.ungrab({actor: this});
            this._grabHelper = null;
        }
        this._source?.disconnectObject(this);
        this._source = null;
        global.stage.disconnectObject(this);
        global.focus_manager.remove_group(this);
    }

    // The artwork the panel comes out of and goes back into, not the tile with
    // its label around it. A source that is nothing but its artwork is used
    // whole, which is how a section button serves as one.
    _sourceArt(source = this._source) {
        return source?.artwork ?? source;
    }

    // The panel is a fixed size, centred in the work area; the container fills
    // the monitor, so the work area's insets become its padding. This is the
    // room the panel has — what it makes of it is `_sizePanel`.
    _budget() {
        const monitor = Main.layoutManager.monitors[this._constraint.index] ??
            Main.layoutManager.primaryMonitor;
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        // The insets are physical pixels and St scales a CSS length itself, so
        // they go into the style divided rather than multiplied.
        const top = (area.y - monitor.y) / scale;
        const left = (area.x - monitor.x) / scale;
        const right = (monitor.x + monitor.width - area.x - area.width) / scale;
        const bottom = (monitor.y + monitor.height - area.y - area.height) / scale;
        this.child.set_style(`padding: ${top}px ${right}px ${bottom}px ${left}px;`);

        // `_size` is the `detail-size` setting as a fraction: how much of the
        // room available the panel fills.
        return {
            width: Math.round(Math.min(MAX_WIDTH * scale, area.width - 2 * MARGIN * scale) * this._size),
            height: Math.round(Math.min(MAX_HEIGHT * scale, area.height - 2 * MARGIN * scale) * this._size),
        };
    }

    // What the subclass makes of the budget: it sets `this._panel`'s size and
    // records it in `this._restSize`.
    _sizePanel(_budget) {
        throw new GObject.NotImplementedError(`_sizePanel in ${this.constructor.name}`);
    }

    // Landed, open and at rest. The detail dialog opens out onto its second
    // column here; a plain panel has nothing more to do.
    _opened() {
    }

    // How the panel leaves. The detail dialog narrows back to its artwork
    // first; the default is the folder's own zoom home.
    _closeSequence() {
        this._zoomAndFadeOut();
    }

    // The tile the panel comes out of and goes back into. It can be unmapped
    // while the panel is up — the overview closing, the surface hidden by a
    // change of workspace — which is the folder's cue to go at once, unless
    // this panel is one of the `window` modes and means to outlive it.
    _setSource(source) {
        this._source?.disconnectObject(this);
        this._source = source;
        if (this._dieWithSource) {
            source.connectObject('notify::mapped', () => {
                if (!source.mapped)
                    this.popdown();
            }, this);
        }
        source.connectObject('destroy', () => {
            this._source = null;
            this.popdown();
        }, this);
    }

    _zoomAndFadeIn() {
        // The panel is at identity here — it has been allocated and nothing
        // has transformed it yet — so its own box is the frame to read the
        // artwork's rectangle in, and that rectangle is the translation.
        const {x, y, width, height} = rectIn(this._sourceArt(), this._panel);

        this._panel.set({
            translation_x: x,
            translation_y: y,
            scale_x: width / this._panel.width,
            scale_y: height / this._panel.height,
            opacity: 0,
        });

        this.ease({
            background_color: SHADE,
            duration: Duration.NORMAL,
            mode: Ease.OUT,
        });
        this._panel.ease({
            translation_x: 0,
            translation_y: 0,
            scale_x: 1,
            scale_y: 1,
            opacity: 255,
            duration: Duration.NORMAL,
            mode: Ease.OUT_EXPO,
            onComplete: () => this._opened(),
        });

        this._needsZoomAndFade = false;
    }

    _zoomAndFadeOut() {
        if (!this._source?.mapped) {
            this._fadeOut();
            return;
        }

        const {x, y, width, height} = rectIn(this._sourceArt(), this._panel);

        this.ease({
            background_color: CLEAR,
            duration: Duration.NORMAL,
            mode: Ease.OUT,
        });
        this._panel.ease({
            opacity: 0,
            duration: Duration.NORMAL,
            mode: Ease.OUT,
        });
        this._panel.ease({
            translation_x: x,
            translation_y: y,
            scale_x: width / this._panel.width,
            scale_y: height / this._panel.height,
            duration: Duration.NORMAL,
            mode: Ease.OUT_EXPO,
            onComplete: () => this._settle(),
        });

        this._needsZoomAndFade = false;
    }

    // No tile to come out of: the panel arrives where it is, centred, the way
    // the shell pops a window in — from just under full size, over the shade.
    _fadeIn() {
        this._panel.set_pivot_point(0.5, 0.5);
        this._panel.set({scale_x: POP_SCALE, scale_y: POP_SCALE, opacity: 0});

        this.ease({
            background_color: SHADE,
            duration: Duration.NORMAL,
            mode: Ease.OUT,
        });
        this._panel.ease({
            scale_x: 1,
            scale_y: 1,
            opacity: 255,
            duration: Duration.NORMAL,
            mode: Ease.OUT,
            onComplete: () => this._opened(),
        });
    }

    _fadeOut() {
        this.ease({
            background_color: CLEAR,
            duration: Duration.NORMAL,
            mode: Ease.OUT,
        });
        this._panel.ease({
            opacity: 0,
            duration: Duration.NORMAL,
            mode: Ease.OUT,
            onComplete: () => this._settle(),
        });
    }

    // At rest and out of sight, ready to come out of the next tile.
    _settle() {
        this.remove_all_transitions();
        this._panel.remove_all_transitions();
        this._panel.set_pivot_point(0, 0);
        this._panel.set_size(...this._restSize);
        this._panel.set({
            translation_x: 0,
            translation_y: 0,
            scale_x: 1,
            scale_y: 1,
            opacity: 255,
        });
        this.background_color = CLEAR;
        this.hide();
    }

    vfunc_allocate(box) {
        super.vfunc_allocate(box);

        // We can only start zooming after receiving an allocation
        if (this._needsZoomAndFade)
            this._zoomAndFadeIn();
    }

    vfunc_key_press_event(event) {
        if (global.focus_manager.navigate_from_event(event))
            return Clutter.EVENT_STOP;

        return Clutter.EVENT_PROPAGATE;
    }

    // Out of `source`, a tile or a button; centred on the current monitor when
    // there is none. Hosted where the pick was made — over the overview when
    // that is up, as a folder is, over everything else otherwise — unless the
    // caller named a host of its own.
    popup(source = null) {
        if (this._isOpen)
            return;

        const art = this._sourceArt(source);
        if (art) {
            const [x, y] = art.get_transformed_position();
            const [width, height] = art.get_transformed_size();
            this._constraint.index = global.display.get_monitor_index_for_rect(
                new Mtk.Rectangle({
                    x: Math.floor(x),
                    y: Math.floor(y),
                    width: Math.max(1, Math.ceil(width)),
                    height: Math.max(1, Math.ceil(height)),
                }));
        } else {
            this._constraint.index = global.display.get_current_monitor();
        }

        const host = this._host ?? (Main.overview.visible
            ? Main.layoutManager.overviewGroup : Main.layoutManager.uiGroup);
        if (this.get_parent() !== host) {
            this.get_parent()?.remove_child(this);
            host.add_child(this);
        }

        this._isOpen = this._grabHelper.grab({
            actor: this,
            focus: this,
            onUngrab: () => this.popdown(),
        });

        if (!this._isOpen)
            return;

        host.set_child_above_sibling(this, null);

        if (source) {
            this._setSource(source);
        } else {
            this._source?.disconnectObject(this);
            this._source = null;
        }

        // The budget is settled before anything is filled in: the subclass
        // fills at that size (`_prepare`) and is then measured (`_sizePanel`).
        const budget = this._budget();
        this._prepare?.(budget);
        this._sizePanel(budget);

        if (source) {
            this._needsZoomAndFade = true;
            this.show();
        } else {
            this.show();
            this._fadeIn();
        }

        this.emit('open-state-changed', true);
    }

    popdown() {
        if (!this._isOpen)
            return;

        this._isOpen = false;
        this._closeSequence();
        this._grabHelper.ungrab({actor: this});
        this.emit('open-state-changed', false);
    }
});
