// The "modal" library: the library inside the folder's panel.
//
// The shell's own FolderView is a BaseAppView sitting in an AppFolderDialog
// (appDisplay.js:2085) — a grid of apps inside the panel that zoomed out of
// the folder's icon. This is that shape with posters: `panel.js` is the panel,
// `libraryView.js` the tabs and the grids in it, and the icon it comes out of
// is the library's button beside Show Apps (libraryButton.js). Nothing is
// drawn on the wallpaper; the button is the way in and the panel is the whole
// view.
//
// Where it opens follows where its button is. On stock GNOME the dash lives in
// the overview, so the panel opens over the overview and goes with it, exactly
// as a folder does. With Dash to Panel the button is in the panel, on the
// desktop, and so is the panel it opens. Escape, a click on the shade, or a
// second press of the button closes it.

import GObject from 'gi://GObject';
import St from 'gi://St';

import {LibraryView} from './libraryView.js';
import {MediaPanel} from './panel.js';

// The panel: the library and nothing else — the way back out is the button it
// came from, Escape, or a click away, so its header is the tabs alone.
const LibraryPanel = GObject.registerClass(
class MediaLibrariesLibraryPanel extends MediaPanel {
    _init({sections, itemsFor, columns, rows, onActivate, onSwitch}) {
        // The folder's own behaviour: the panel goes when the button it came
        // out of unmaps, which is what closes it with the overview.
        super._init({dieWithSource: true});

        this._sections = sections;
        this._itemsFor = itemsFor;
        this._columns = columns;
        this._rows = rows;
        this._onActivate = onActivate;
        this._onSwitch = onSwitch;
        this._library = null;
        // The budget the view was built for. Not `_budget`, which is the
        // host's method for working it out.
        this._room = null;
    }

    // The panel takes the whole budget: a library wants every pixel the work
    // area will give it. `set_size` is what overrides the 720px square the
    // theme pins `.app-folder-dialog` to.
    _sizePanel(budget) {
        this._panel.remove_all_transitions();
        this._panel.set_size(budget.width, budget.height);
        this._restSize = [budget.width, budget.height];

        // A grid's rows, columns and cover size are worked out once, for the
        // box it was given. Opened on a monitor that leaves a different box —
        // or after the work area changed under us — the view is built again
        // rather than stretched.
        if (this._room && (this._room.width !== budget.width || this._room.height !== budget.height)) {
            this._library?.destroy();
            this._library = null;
        }
        this._room = budget;
    }

    // `key`'s tab in the panel. Called from `open`, after `popup`, so the
    // panel is on stage and its theme padding can be measured.
    showSection(key) {
        if (!this._library) {
            const [width, height] = this._viewSize();
            this._library = new LibraryView({
                sections: this._sections,
                itemsFor: this._itemsFor,
                active: key,
                width,
                height,
                columns: this._columns,
                rows: this._rows,
                onActivate: this._onActivate,
                onSwitch: this._onSwitch,
            });
            this._panel.add_child(this._library.actor);
        }
        this._library.show(key);
        this._library.currentView?.goToPage(0, false);
    }

    // The grid on show.
    get currentView() {
        return this._library?.currentView ?? null;
    }

    // Arrows with nothing inside focused go to the grid's first tile on show.
    _focusFirst() {
        return this._library?.focusFirst() ?? false;
    }

    // What the view is allocated: the panel less the folder's own padding,
    // which is asked of its theme node — valid only once the panel is on
    // stage.
    _viewSize() {
        const node = this._panel.get_theme_node();
        const width = Math.round(this._room.width -
            node.get_padding(St.Side.LEFT) - node.get_padding(St.Side.RIGHT));
        const height = Math.round(this._room.height -
            node.get_padding(St.Side.TOP) - node.get_padding(St.Side.BOTTOM));
        return [width, height];
    }
});

export class LibraryWindow {
    // `button` is the library's button beside Show Apps, which the app holds
    // and hands to whichever place the library opens in; `onSwitch` hears of
    // a tab chosen here.
    constructor({sections, itemsFor, onActivate, columns, rows, button, onSwitch}) {
        this._sections = sections;
        this._itemsFor = itemsFor;
        this._onActivate = onActivate;
        this._columns = columns;
        this._rows = rows;
        this._button = button;
        this._onSwitch = onSwitch;
        this._panel = null;
        this._key = sections[0]?.key ?? null;
    }

    enable() {
    }

    disable() {
        this.close();
        this._panel?.destroy();
        this._panel = null;
    }

    // The button, or the shortcut: the library, or — when that is what is up
    // — the way out, as a second press of a folder's icon closes the folder.
    toggle(key = null) {
        if (this._panel?.isOpen) {
            this.close();
            return;
        }
        this.open(key);
    }

    // The library on `key`'s tab, or the one last shown, out of the button.
    open(key = null) {
        if (!this._sections.length)
            return;
        if (this._sections.some(s => s.key === key))
            this._key = key;

        if (!this._panel) {
            this._panel = new LibraryPanel({
                sections: this._sections,
                itemsFor: this._itemsFor,
                columns: this._columns,
                rows: this._rows,
                onActivate: this._onActivate,
                onSwitch: tab => {
                    this._key = tab;
                    this._onSwitch?.(tab);
                },
            });
            // However it closes — Escape, the shade, the button unmapping
            // with the overview — the button is no longer lit.
            this._panel.connect('open-state-changed', (_panel, isOpen) => {
                if (!isOpen)
                    this._button.sync(false);
            });
        }

        if (!this._panel.isOpen) {
            // The zoom comes out of the button's icon, which is a BaseIcon and
            // so is its own artwork. A shortcut pressed on the desktop finds
            // it unmapped, the dash being the overview's, and an unmapped
            // icon has nowhere to zoom out of: the panel fades in centred.
            this._panel.popup(this._button.icon);
            if (!this._panel.isOpen)
                return;
        }

        this._panel.showSection(this._key);
        this._button.sync(true);
    }

    close() {
        this._panel?.popdown();
    }

    get isShowing() {
        return !!this._panel?.isOpen;
    }

    get currentView() {
        return this._panel?.isOpen ? this._panel.currentView : null;
    }

    // What is up, for a rebuild to put back (see MediaMenu.state).
    get state() {
        return {key: this._panel?.isOpen ? this._key : null};
    }

    // The panel back up on the tab `state` names, out of the button the
    // rebuild has just made.
    restore(state) {
        if (state?.key)
            this.open(state.key);
    }
}
