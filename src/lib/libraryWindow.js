// The "modal" library: a section's grid inside the folder's panel.
//
// The shell's own FolderView is a BaseAppView sitting in an AppFolderDialog
// (appDisplay.js:2085) — a grid of apps inside the panel that zoomed out of
// the folder's icon. This is that shape with posters: `panel.js` is the panel,
// `mediaGrid.js` the grid, and the icon it comes out of is the section's
// button beside Show Apps (sectionButtons.js). Nothing is drawn on the
// wallpaper and there is no home menu; the buttons are the way in and the
// panel is the whole view.
//
// Where it opens follows where its button is. On stock GNOME the dash lives in
// the overview, so the panel opens over the overview and goes with it, exactly
// as a folder does. With Dash to Panel the button is in the panel, on the
// desktop, and so is the panel it opens. Escape, a click on the shade, or a
// second press of the button closes it.
//
// One panel serves every section: a view per section is built the first time
// that section is opened and kept for the panel's life, so switching sections
// is a matter of which one is showing.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {libraryCountLabel} from './library.js';
import {createMediaView} from './mediaGrid.js';
import {MediaPanel} from './panel.js';
import {SectionButtons} from './sectionButtons.js';
import {createTitles} from './widgets.js';

// The panel: the section's name and count over the grid, and nothing else —
// the way back out is the button it came from, Escape, or a click away.
const LibraryPanel = GObject.registerClass(
class MediaLibrariesLibraryPanel extends MediaPanel {
    _init({columns, rows, onActivate}) {
        // The folder's own behaviour: the panel goes when the button it came
        // out of unmaps, which is what closes it with the overview.
        super._init({dieWithSource: true});

        this._columns = columns;
        this._rows = rows;
        this._onActivate = onActivate;
        this._views = new Map();
        // The budget the views were built for. Not `_budget`, which is the
        // host's method for working it out.
        this._room = null;

        // The section header without its buttons: the way out of this panel is
        // Escape, the shade, or the button it came out of.
        this._header = new St.BoxLayout({
            style_class: 'ml-header',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const titles = createTitles();
        this._title = titles.titleLabel;
        this._subtitle = titles.subtitleLabel;
        this._header.add_child(titles.actor);
        this._panel.add_child(this._header);

        // The views take turns in here, as the sections' pages do on the
        // wallpaper: built once and then shown or hidden.
        this._stack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this._panel.add_child(this._stack);
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
        // or after the work area changed under us — the views are built again
        // rather than stretched.
        if (this._room && (this._room.width !== budget.width || this._room.height !== budget.height))
            this._dropViews();
        this._room = budget;
    }

    // `section`'s library in the panel. Called from `open`, after `popup`, so
    // the panel is on stage and its theme padding can be measured.
    showSection(section, items) {
        this._title.text = section.title;
        this._subtitle.text = libraryCountLabel(items.length);

        for (const [key, other] of this._views) {
            if (key !== section.key)
                other.hide();
        }

        let view = this._views.get(section.key);
        if (!view) {
            const [width, height] = this._viewSize();
            view = createMediaView({
                section,
                items,
                width,
                height,
                columns: this._columns,
                rows: this._rows,
                onActivate: this._onActivate,
            });
            this._stack.add_child(view);
            this._views.set(section.key, view);
        }
        view.show();
        view.goToPage(0, false);
    }

    // The section's grid that is on show.
    get currentView() {
        return [...this._views.values()].find(view => view.visible) ?? null;
    }

    // Arrows with nothing inside focused go to the grid's first tile on show.
    _focusFirst() {
        return this.currentView?.focusFirst() ?? false;
    }

    // What the grid is allocated: the panel less the folder's own padding,
    // less the header. Both are asked of the widgets themselves — the padding
    // of the theme node (valid only once the panel is on stage), the header
    // of its preferred height at the width it will have.
    _viewSize() {
        const node = this._panel.get_theme_node();
        const width = Math.round(this._room.width -
            node.get_padding(St.Side.LEFT) - node.get_padding(St.Side.RIGHT));
        const [, headerHeight] = this._header.get_preferred_height(width);
        const height = Math.round(this._room.height - headerHeight -
            node.get_padding(St.Side.TOP) - node.get_padding(St.Side.BOTTOM));
        return [width, height];
    }

    _dropViews() {
        for (const view of this._views.values())
            view.destroy();
        this._views.clear();
    }
});

export class LibraryWindow {
    constructor({sections, itemsFor, onActivate, columns, rows}) {
        // A section with nothing in it gets no button, as in the menu library.
        this._sections = sections.filter(s => itemsFor(s.key).length);
        this._itemsFor = itemsFor;
        this._onActivate = onActivate;
        this._columns = columns;
        this._rows = rows;
        this._buttons = new SectionButtons({
            sections: this._sections,
            onActivate: key => this.toggle(key),
        });
        this._panel = null;
        this._current = null;
    }

    enable() {
        this._buttons.attach();
    }

    disable() {
        this.close();
        this._buttons.detach();
        this._panel?.destroy();
        this._panel = null;
        this._current = null;
    }

    // A section's button, or its shortcut: its library, or — when that is what is up — the way
    // out, as a second press of a folder's icon closes the folder.
    toggle(key) {
        if (this._panel?.isOpen && this._current === key) {
            this.close();
            return;
        }
        this.open(key);
    }

    // `key`'s library, out of `source` — its button, unless the caller has a
    // tile of its own for the panel to zoom out of.
    open(key, source = null) {
        const section = this._sections.find(s => s.key === key);
        if (!section)
            return;

        if (!this._panel) {
            this._panel = new LibraryPanel({
                columns: this._columns,
                rows: this._rows,
                onActivate: this._onActivate,
            });
            // However it closes — Escape, the shade, the button unmapping
            // with the overview — no section is up and none is lit.
            this._panel.connect('open-state-changed', (_panel, isOpen) => {
                if (isOpen)
                    return;
                this._current = null;
                this._buttons.sync(null);
            });
        }

        if (!this._panel.isOpen) {
            // The zoom comes out of the button's icon, which is a BaseIcon and
            // so is its own artwork. A shortcut pressed on the desktop finds
            // it unmapped, the dash being the overview's, and an unmapped
            // icon has nowhere to zoom out of: the panel fades in centred.
            const button = this._buttons.buttonFor(key)?.icon;
            this._panel.popup(source ?? (button?.mapped ? button : null));
            if (!this._panel.isOpen)
                return;
        }

        this._current = key;
        this._panel.showSection(section, this._itemsFor(key));
        this._buttons.sync(key);
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
        return {key: this._panel?.isOpen ? this._current : null};
    }

    // The panel back up on the section `state` names, out of the button the
    // rebuild has just made for it.
    restore(state) {
        if (state?.key)
            this.open(state.key);
    }
}
