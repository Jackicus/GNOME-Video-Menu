// The library grid: the shell's own app grid, holding posters instead of apps.
//
// One grid serves every view — the pages drawn on the wallpaper (app.js), the
// pages in the overview's app-grid slot (mediaMenu.js) and the pages in the
// folder's panel (libraryWindow.js) — so paging, swipe, the page dots, the
// hover arrows, scroll-wheel paging and keyboard focus are the shell's
// everywhere, and Media Libraries only says what a tile is.
//
// A view is a subclass of the class the app grid itself is built on, and a
// tile is an AppViewItem around a BaseIcon styled `overview-tile`. Three
// things are ours, because the shell's grid is made for square icons: the icon
// asks for the shape of its artwork rather than a square, the layout places
// cells of that shape the theme's gap apart, and a view builds the pages in
// reach of the one showing rather than a tile for everything owned — a library
// runs to thousands where an app grid runs to dozens.

import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as IconGrid from 'resource:///org/gnome/shell/ui/iconGrid.js';

import {staggerIn} from './anim.js';
import {createArtwork} from './widgets.js';

// Not exported by the shell, but it is what AppDisplay extends.
const BaseAppView = Object.getPrototypeOf(AppDisplay.AppDisplay);

// Every number below is logical pixels, as the theme writes them, and is
// multiplied by the scale factor where it meets an allocation.
//
// The smallest a cover is allowed to get; it is what caps "columns" and "rows".
const MIN_ART = 96;
// .icon-grid column-spacing/row-spacing (data/theme/…/_app-grid.scss:8-9), the
// value the theme hands the layout; only gridFor, which runs before the grid
// exists, needs it here.
const GAP = 12;
// What an `overview-tile` adds around its artwork: 12px of padding on each
// side, and beneath it a 6px gap and one line of label.
const TILE_PADDING = 24;
const TILE_CHROME = 56;
// A second line of that label, left free under the bottom row: a hovered tile
// there wraps its title downwards like any other, and the page edge would
// otherwise cut the line off.
const TITLE_LINE = 20;
// The `icon-grid` theme's page padding.
const PAGE_PADDING_V = 48;
const PAGE_PADDING_H = 36;
// Beside the grid: a tenth of the width each side, where the page arrows
// stand (the shell's PAGE_PREVIEW_RATIO). Beneath it: the page dots.
const ARROWS_SHARE = 0.2;
const DOTS_HEIGHT = 36;
// Pages built beyond the one showing, so the next is there to swipe to.
const PAGES_AHEAD = 2;

// The `grid-align` setting: 'center' places a part-full row as the app grid
// does, under the middle of the full ones, 'start' lines it up on the leading
// edge. The block itself is always centred. Read by the layout as it
// allocates, so it is set before any grid is built and a change rebuilds them
// all (app.js).
let gridAlign = 'center';
export function setGridAlign(align) {
    gridAlign = align === 'start' ? 'start' : 'center';
}

// Rows, columns and the artwork height that fills them, for the box a view is
// given. Decided once, before any item is added: the layout pages items as
// they arrive and does not page them again when the mode changes (the shell's
// own modes all hold twenty-four).
//
// `columns` and `rows` are the two "covers per page" preferences, and they
// lead: the cover is whatever size that many of them come to in the width and
// height on offer. Each is capped by how many fit at MIN_ART, which is what
// makes the smallest box — the overview's grid slot — the bottleneck, in one
// place, for all three views.
function gridFor(width, height, aspect, wantColumns, wantRows) {
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const gap = GAP * scale;
    const pad = TILE_PADDING * scale;
    const chrome = TILE_CHROME * scale;
    const minArt = MIN_ART * scale;

    const gridW = width * (1 - ARROWS_SHARE) - PAGE_PADDING_H * scale;
    const gridH = height - (DOTS_HEIGHT + PAGE_PADDING_V + TITLE_LINE) * scale;

    // How many columns fit at the smallest cover.
    const fitColumns = Math.floor((gridW + gap) / (minArt / aspect + pad + gap));
    const columns = Math.max(1, Math.min(wantColumns, fitColumns));
    const cellW = Math.floor((gridW - gap * (columns - 1)) / columns);
    const byWidth = Math.floor((cellW - pad) * aspect);

    // How many rows fit at the smallest cover, the same way.
    const forRows = n => Math.floor((gridH + gap) / n - chrome - gap);
    const fitRows = Math.floor((gridH + gap) / (minArt + chrome + gap));
    const rows = Math.max(1, Math.min(wantRows, fitRows));

    // The cover is the largest it can be before either axis is hit: that many
    // columns across, or that many rows down. The other axis is left with
    // slack, and the layout centres the block in it.
    const iconSize = Math.max(minArt, Math.min(byWidth, forRows(rows)));

    return {rows, columns, iconSize};
}

// The shell's layout takes the larger of an item's width and height as the
// side of every cell. This one keeps the two apart, sets the cells the theme's
// gap apart and centres the block on the page. Paging is untouched.
const PosterGridLayout = GObject.registerClass(
class MediaLibrariesPosterGridLayout extends IconGrid.IconGridLayout {
    vfunc_allocate() {
        if (!this._pageWidth || !this._pageHeight)
            return;

        // Every tile of a view is the same size, so the cell is one tile's
        // answer rather than all of them — this runs on each frame the
        // overview moves.
        const first = this._pages[0]?.visibleChildren[0];
        if (!first)
            return;
        const cellW = first.get_preferred_width(-1)[0];
        const cellH = first.get_preferred_height(-1)[0];

        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        // IconGrid.vfunc_style_changed fills these from the theme, already
        // scaled (js/ui/iconGrid.js:1258-1263) — never scale them again. They
        // are 0 until the first style change, hence the fallback.
        const hGap = this.columnSpacing || GAP * scale;
        const vGap = this.rowSpacing || GAP * scale;

        const rtl = Clutter.get_default_text_direction() === Clutter.TextDirection.RTL;
        const {columnsPerPage: columns, rowsPerPage: rows, pagePadding: pad} = this;
        const blockW = columns * cellW + (columns - 1) * hGap;
        const blockH = rows * cellH + (rows - 1) * vGap;
        // IconGridLayout._calculateSpacing's pageHalign/pageValign CENTER
        // (iconGrid.js:591-630) done by hand, because that one takes a single
        // square childSize and ours is a poster. The block is centred
        // whatever `grid-align` says: the setting is where a part-full row
        // sits under the full ones, not where the block sits on the page.
        // gridFor shrinks the cover to fit the "rows" and "columns" settings
        // exactly, so the block can be well short of the page width, and a
        // block hugging the leading edge then left all of that as one gap on
        // the trailing side.
        const centred = gridAlign === 'center';
        const left = pad.left + Math.max(0, (this._pageWidth - pad.left - pad.right - blockW) / 2);
        const top = pad.top +
            Math.max(0, (this._pageHeight - pad.top - pad.bottom - TITLE_LINE * scale - blockH) / 2);

        const box = new Clutter.ActorBox();
        this._pages.forEach((page, pageIndex) => {
            if (rtl)
                pageIndex = this._pages.length - 1 - pageIndex;
            page.visibleChildren.forEach((item, index) => {
                const column = rtl ? columns - 1 - index % columns : index % columns;
                const row = Math.floor(index / columns);
                // _getRowPadding with lastRowAlign CENTER (iconGrid.js:649-683),
                // which this override skips past: a part-full last row is
                // centred under the full ones instead of hugging the start,
                // unless `grid-align` says start. Passing `last_row_align` in
                // the params would do nothing, since the parent's own loop
                // never runs.
                const inRow = Math.min(columns, page.visibleChildren.length - row * columns);
                const rowOffset = centred
                    ? (rtl ? -1 : 1) * (columns - inRow) * (cellW + hGap) / 2
                    : 0;
                box.set_origin(
                    Math.floor(pageIndex * this._pageWidth + left + rowOffset +
                        column * (cellW + hGap)),
                    Math.floor(top + row * (cellH + vGap)));
                // A tile whose title is too long for one line wraps it to
                // two while it is hovered or focused (AppViewItem does that
                // for us) and clips itself to its allocation as it goes, so
                // the cell is a floor and not a ceiling, exactly as the
                // shell's own layout has it. Asked for the same width every
                // time, the answer is Clutter's cached one until the wrap
                // actually changes.
                box.set_size(cellW, Math.max(cellH, item.get_preferred_height(cellW)[1]));
                item.allocate(box);
            });
        });

        this._pageSizeChanged = false;
        // The parent eases items into their new places when the grid is
        // reordered; nothing here ever reorders, so the flag is only cleared.
        this._shouldEaseItems = false;
    }
});

const MediaGrid = GObject.registerClass(
class MediaLibrariesMediaGrid extends AppDisplay.AppGrid {
    _init({rows, columns, iconSize}) {
        super._init({
            allow_incomplete_pages: true,
            rows_per_page: rows,
            columns_per_page: columns,
        });
        this.setGridModes([{rows, columns}]);

        // The grid makes its own layout and offers no way to choose it. The
        // one it made goes unreferenced here on purpose: IconGrid's destroy
        // handler closes over it (iconGrid.js:1178-1193), so it stays alive
        // and disconnects itself without our help.
        const layout = new PosterGridLayout({
            allow_incomplete_pages: true,
            orientation: Clutter.Orientation.HORIZONTAL,
            rows_per_page: rows,
            columns_per_page: columns,
            fixed_icon_size: iconSize,
        });
        layout.connect('pages-changed', () => this.emit('pages-changed'));
        this.layout_manager = layout;
    }
});

// A BaseIcon is a square bin: it asks for the larger of its child's width and
// height both ways. This one asks for what its child does, as a plain bin.
const PosterIcon = GObject.registerClass(
class MediaLibrariesPosterIcon extends IconGrid.BaseIcon {
    vfunc_get_preferred_width(forHeight) {
        const node = this.get_theme_node();
        const [min, nat] = this.child.get_preferred_width(node.adjust_for_height(forHeight));
        return node.adjust_preferred_width(min, nat);
    }

    vfunc_get_preferred_height(forWidth) {
        const node = this.get_theme_node();
        const [min, nat] = this.child.get_preferred_height(node.adjust_for_width(forWidth));
        return node.adjust_preferred_height(min, nat);
    }
});

const MediaItem = GObject.registerClass(
class MediaLibrariesMediaItem extends AppDisplay.AppViewItem {
    _init({item, section, order, onActivate}) {
        super._init({style_class: 'overview-tile'}, false, true);
        this._id = `${section.key}/${item.id}`;
        this._name = item.title;
        this.item = item;
        this.order = order;

        // The icon's size is the height of its artwork.
        this.icon = new PosterIcon(item.title, {
            setSizeManually: true,
            createIcon: size => createArtwork({
                path: item.art,
                title: item.title,
                icon: section.icon,
                width: Math.round(size / section.aspect),
                height: size,
            }),
        });
        this.set_child(this.icon);
        // The tile goes along, for whatever the pick zooms or flies out of.
        this.connect('clicked', () => onActivate(section.key, item, this));
    }

    // The artwork itself, which the hero flight takes off from. A BaseIcon
    // keeps what its createIcon built as `icon`.
    get artwork() {
        return this.icon.icon;
    }
});

// _createGrid() is called from the parent's _init, before there is a `this`
// to have kept the parameters on.
let pendingGrid = null;

const MediaView = GObject.registerClass(
class MediaLibrariesMediaView extends BaseAppView {
    _init({section, items, onActivate}) {
        super._init({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this.add_child(this._box);

        // BaseAppView re-runs _redisplay — a diff over every tile built so
        // far — whenever an app is pinned to the dash or the parental filter
        // changes (appDisplay.js:620-628). Neither has anything to say about
        // media, so both hooks go.
        this._parentalControlsManager.disconnectObject(this);
        this._appFavorites.disconnectObject(this);

        // The arrow keys walk a grid because St is asked to walk it: the focus
        // manager navigates within the nearest registered group around what is
        // focused. The shell registers the app grid the long way round, as a
        // Ctrl+Alt+Tab target (overviewControls.js:393-403, which calls
        // focus_manager.add_group for it); a grid of ours is not one of those,
        // so it registers itself. A group further out — the whole surface,
        // say — leaves the arrows with nothing to move between.
        global.focus_manager.add_group(this);
        this.connect('destroy', () => global.focus_manager.remove_group(this));

        // The page dots keep their room whether or not they show. The shell
        // hides them for a single page (pageIndicators.js setNPages), which
        // hands the grid their height and re-centres it: a section with one
        // page sat seven pixels lower than one with two, for the same
        // covers. gridFor budgets DOTS_HEIGHT for every view, so the dots
        // are faded rather than dropped and every section lands the same.
        const dots = this._pageIndicators;
        const holdRoom = () => {
            if (!dots.visible) {
                dots.visible = true;
                dots.opacity = 0;
            } else if (dots.get_n_children() > 1) {
                dots.opacity = 255;
            }
        };
        dots.connect('notify::visible', holdRoom);
        holdRoom();

        this._section = section;
        this._data = items;
        this._onActivate = onActivate;
        this._perPage = pendingGrid.rows * pendingGrid.columns;
        this._media = [];
        this._byId = new Map();
        this._fillTo(0);
    }

    // Tiles up to PAGES_AHEAD pages past `page`, appended in order. Straight
    // into the grid: the view's own _redisplay diffs every item against every
    // other, which is nothing for the apps and seconds for a big library.
    _fillTo(page) {
        const want = Math.min(this._data.length, (page + 1 + PAGES_AHEAD) * this._perPage);
        while (this._media.length < want) {
            const order = this._media.length;
            const item = new MediaItem({
                item: this._data[order],
                section: this._section,
                order,
                onActivate: this._onActivate,
            });
            this._media.push(item);
            this._byId.set(this._data[order].id, item);
            // Placed outright rather than appended: told to append, the grid
            // keeps its own counsel about where a new tile goes (an app that
            // has just been installed is kept off the first page), and the
            // library's own order is the only one that makes sense here.
            this._addItem(item, Math.floor(order / this._perPage), order % this._perPage);
        }
    }

    // Every way of turning the page comes through here.
    goToPage(page, animate = true) {
        if (this._data)
            this._fillTo(page);
        super.goToPage(page, animate);
    }

    // The tile showing `itemId`, if it has been built: where the detail pane's
    // artwork flies back to.
    tileFor(itemId) {
        return this._byId.get(itemId) ?? null;
    }

    // Stagger in the tiles of the page on show, the way the app grid settles.
    reveal() {
        staggerIn(this._media.slice(0, this._perPage));
    }

    // Where the keyboard starts: the first tile of the page being shown, not
    // wherever the focus chain happens to begin — that can be a page away, and
    // the grid would page over to it.
    focusFirst() {
        // Which page is showing is the scroll adjustment's answer, not the
        // grid's: the grid's own idea of it is whatever the last batch of
        // tiles left behind.
        const {value, page_size: pageSize} = this._adjustment;
        const page = pageSize > 0 ? Math.round(value / pageSize) : 0;
        const item = this._media[page * this._perPage] ?? this._media[0];
        item?.grab_key_focus();
        return !!item;
    }

    _createGrid() {
        return new MediaGrid(pendingGrid);
    }

    // Whatever asks the view to redisplay, the answer is the items built so
    // far, not new ones.
    _loadApps() {
        return [...this._media];
    }

    _compareItems(a, b) {
        return a.order - b.order;
    }
});

// A view of `items` for the box it is given. `columns` and `rows` are the
// grid-shape settings, which every caller passes.
export function createMediaView({section, items, width, height, columns, rows, onActivate}) {
    pendingGrid = gridFor(width, height, section.aspect, columns, rows);
    const view = new MediaView({section, items, onActivate});
    // Filling the grid moves it: each batch of tiles makes another page, and
    // the grid follows the one it has just made. Start at the first.
    view.goToPage(0, false);
    return view;
}
