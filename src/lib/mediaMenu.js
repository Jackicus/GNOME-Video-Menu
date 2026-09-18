// A second application menu, of media: one per section. The "menu" view.
//
// Nearly everything here is the shell's own: a view is a subclass of the class
// the app grid itself is built on (pages, swipe, page dots, arrows and the
// title that opens out on hover all come with it), a tile is an AppViewItem
// around a BaseIcon styled `overview-tile`.
//
// A view lives inside the app grid's slot — a child of the AppDisplay, shown
// in place of the grid's own box — so the overview allocates it, slides it up
// and hides it for search exactly as it does the apps.
//
// Each section gets a button made as Show Apps is — a DashItemContainer around
// a `show-apps` toggle — and put beside it: in the dash, or in Dash to Panel's
// panel when that has taken the dash away. They are the only way in: one opens
// the overview straight onto its section, pressed again it goes back to the
// window picker as Show Apps does, and Show Apps itself goes back to the apps.
//
// Three things are ours, because the shell's grid is made for square icons:
// the icon asks for the shape of its artwork rather than a square, the layout
// places cells of that shape a fixed gap apart, and while a view is up the
// row of workspaces above the grid is folded away so the posters get its room.
// And a fourth because a library is not a list of apps: a view builds the
// pages in reach of the one showing, not a tile for everything owned.

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as IconGrid from 'resource:///org/gnome/shell/ui/iconGrid.js';
import * as Dash from 'resource:///org/gnome/shell/ui/dash.js';
import {ControlsState} from 'resource:///org/gnome/shell/ui/overviewControls.js';

import {Duration, Ease} from './anim.js';
import {createArtwork} from './widgets.js';

// Not exported by the shell, but it is what AppDisplay extends.
const BaseAppView = Object.getPrototypeOf(AppDisplay.AppDisplay);

// The artwork height a page aims for; the rows are however many of that fit.
const TARGET_ART = 230;
const MIN_ART = 96;
const MAX_ART = 320;
// Between two tiles. A tile pads its artwork by 12px, so posters stand
// GAP + 24 apart.
const GAP = 8;
// What an `overview-tile` adds around its artwork: 12px of padding on each
// side, and beneath it a 6px gap and one line of label.
const TILE_PADDING = 24;
const TILE_CHROME = 56;
// The `icon-grid` theme's page padding.
const PAGE_PADDING_V = 48;
const PAGE_PADDING_H = 36;
// Beside the grid: a tenth of the width each side, where the page arrows
// stand (the shell's PAGE_PREVIEW_RATIO). Beneath it: the page dots.
const ARROWS_SHARE = 0.2;
const DOTS_HEIGHT = 36;
// The overview gives the dash no more than this share of its height
// (DASH_MAX_HEIGHT_RATIO, which the shell does not export).
const DASH_MAX_SHARE = 0.16;
// Pages built beyond the one showing, so the next is there to swipe to.
const PAGES_AHEAD = 2;

// Rows, columns and the artwork height that fills them, for the box a view
// is given. Decided once, before any item is added: the layout pages items as
// they arrive and does not page them again when the mode changes (the shell's
// own modes all hold twenty-four).
function gridFor(width, height, aspect) {
    const gridW = width * (1 - ARROWS_SHARE) - PAGE_PADDING_H;
    const gridH = height - DOTS_HEIGHT - PAGE_PADDING_V;
    const rows = Math.max(1, Math.round(gridH / (TARGET_ART + TILE_CHROME + GAP)));
    const cellH = Math.floor((gridH - GAP * (rows - 1)) / rows);
    const iconSize = Math.clamp(cellH - TILE_CHROME, MIN_ART, MAX_ART);
    const cellW = Math.round(iconSize / aspect) + TILE_PADDING;
    return {
        rows,
        columns: Math.max(1, Math.floor((gridW + GAP) / (cellW + GAP))),
        iconSize,
    };
}

// The shell's layout takes the larger of an item's width and height as the
// side of every cell. This one keeps the two apart, sets the cells GAP apart
// and centres the block on the page. Paging is untouched.
const PosterGridLayout = GObject.registerClass(
class GnomeflixPosterGridLayout extends IconGrid.IconGridLayout {
    vfunc_allocate() {
        if (!this._pageWidth || !this._pageHeight)
            return;

        // Every tile of a view is the same size, and this runs on each frame
        // the overview moves, so one is asked rather than all of them.
        const first = this._pages[0]?.visibleChildren[0];
        if (!first)
            return;
        const cellW = first.get_preferred_width(-1)[0];
        const cellH = first.get_preferred_height(-1)[0];

        const rtl = Clutter.get_default_text_direction() === Clutter.TextDirection.RTL;
        const {columnsPerPage: columns, rowsPerPage: rows, pagePadding: pad} = this;
        const blockW = columns * cellW + (columns - 1) * GAP;
        const blockH = rows * cellH + (rows - 1) * GAP;
        const left = pad.left + Math.max(0, (this._pageWidth - pad.left - pad.right - blockW) / 2);
        const top = pad.top + Math.max(0, (this._pageHeight - pad.top - pad.bottom - blockH) / 2);

        const box = new Clutter.ActorBox();
        this._pages.forEach((page, pageIndex) => {
            if (rtl)
                pageIndex = this._pages.length - 1 - pageIndex;
            page.visibleChildren.forEach((item, index) => {
                const column = rtl ? columns - 1 - index % columns : index % columns;
                const row = Math.floor(index / columns);
                box.set_origin(
                    Math.floor(pageIndex * this._pageWidth + left + column * (cellW + GAP)),
                    Math.floor(top + row * (cellH + GAP)));
                box.set_size(cellW, cellH);
                item.allocate(box);
            });
        });

        this._pageSizeChanged = false;
        this._shouldEaseItems = false;
    }
});

const MediaGrid = GObject.registerClass(
class GnomeflixMediaGrid extends AppDisplay.AppGrid {
    _init({rows, columns, iconSize}) {
        super._init({
            allow_incomplete_pages: true,
            rows_per_page: rows,
            columns_per_page: columns,
        });
        this.setGridModes([{rows, columns}]);

        // The grid makes its own layout and offers no way to choose it. The
        // one it made is kept, because the grid disconnects from it when it
        // is destroyed.
        this._stockLayout = this.layout_manager;
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
class GnomeflixPosterIcon extends IconGrid.BaseIcon {
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
class GnomeflixMediaItem extends AppDisplay.AppViewItem {
    _init({item, section, order, onActivate}) {
        super._init({style_class: 'overview-tile'}, false, true);
        this._id = `${section.key}/${item.id}`;
        this._name = item.title;
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
        this.connect('clicked', () => onActivate(section.key, item));
    }
});

let pendingGrid = null;

const MediaView = GObject.registerClass(
class GnomeflixMediaView extends BaseAppView {
    _init({section, items, onActivate}) {
        super._init({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this.add_child(this._box);

        this._section = section;
        this._data = items;
        this._onActivate = onActivate;
        this._perPage = pendingGrid.rows * pendingGrid.columns;
        this._media = [];
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
            this._addItem(item, -1, -1);
        }
    }

    // Every way of turning the page comes through here.
    goToPage(page, animate = true) {
        if (this._data)
            this._fillTo(page);
        super.goToPage(page, animate);
    }

    // Called from the parent's _init, before there is a `this` to keep the
    // parameters on.
    _createGrid() {
        return new MediaGrid(pendingGrid);
    }

    // The view asks again whenever the favourites change; the answer is the
    // items built so far, not new ones.
    _loadApps() {
        return [...this._media];
    }

    _compareItems(a, b) {
        return a.order - b.order;
    }
});

export class MediaMenu {
    constructor({sections, itemsFor, onActivate}) {
        // A section with nothing in it gets no button.
        this._sections = sections.filter(s => itemsFor(s.key).length);
        this._itemsFor = itemsFor;
        this._onActivate = onActivate;
        this._views = new Map();
        this._buttons = new Map();
        this._buttonHost = null;
        this._current = null;
        // How far the workspaces were last left folded, 0 to 1.
        this._fold = 0;
    }

    enable() {
        this._controls = Main.overview._overview?.controls ?? null;
        this._appDisplay = this._controls?.appDisplay ?? null;
        // The app grid's own content; ours take turns with it.
        this._appsBox = this._appDisplay?._box ?? null;
        if (!this._appDisplay || !this._appsBox || !this._sections.length) {
            if (this._sections.length)
                console.warn('[Gnomeflix] The overview is not laid out as expected; no media menu.');
            this._appsBox = null;
            return;
        }

        // Gone from view is back to apps, so Show Apps always shows apps.
        this._appDisplay.connectObject('notify::visible', () => {
            if (!this._appDisplay.visible)
                this._show(null);
        }, this);

        // The end of a search shows the workspaces again, whatever is up.
        this._controls._searchController?.connectObject('notify::search-active', controller => {
            if (!controller.searchActive && this._current)
                this._syncWorkspaces(true);
        }, this);

        this._adjustment = this._controls._stateAdjustment ?? null;
        this._adjustment?.connectObject('notify::value', () => this._syncWorkspaces(), this);

        this._foldWorkspaces();

        // Dash to Panel builds its panels when it is enabled and again when
        // its settings change, either of which can come after this.
        Main.extensionManager.connectObject('extension-state-changed',
            () => this._attachButtons(), this);
        this._attachButtons();
    }

    disable() {
        if (!this._appsBox)
            return;
        this._show(null);
        Main.extensionManager.disconnectObject(this);
        this._detachButtons();
        // Only if it is still ours: someone may have wrapped it since.
        const layout = this._controls.layout_manager;
        if (this._foldedBox && layout._getAppDisplayBoxForState === this._foldedBox)
            delete layout._getAppDisplayBoxForState;
        this._foldedBox = null;
        this._controls.queue_relayout();
        this._appDisplay.disconnectObject(this);
        this._controls._searchController?.disconnectObject(this);
        this._adjustment?.disconnectObject(this);
        this._adjustment = null;
        for (const view of this._views.values())
            view.destroy();
        this._views.clear();
        this._controls = this._appDisplay = this._appsBox = null;
    }

    // In the app grid state the overview keeps a row of small workspaces above
    // the grid and gives the grid what is left. While a media view is up the
    // grid's box is grown over that row instead, and the row faded out (see
    // _syncWorkspaces) — the workspaces keep their box, because the shell
    // divides by its height.
    _foldWorkspaces() {
        const layout = this._controls.layout_manager;
        const stock = layout._getAppDisplayBoxForState;
        if (typeof stock !== 'function')
            return;
        const menu = this;
        this._foldedBox = layout._getAppDisplayBoxForState = function (state, box, searchHeight, dashHeight, workspacesBox, spacing) {
            const slot = stock.call(this, state, box, searchHeight, dashHeight, workspacesBox, spacing);
            if (!menu._current)
                return slot;
            // The same size in every state, as the shell has it, so the slide
            // up from the window picker moves the slot without stretching it.
            const extra = workspacesBox.get_height() + spacing;
            const [x, y] = slot.get_origin();
            const [width, height] = slot.get_size();
            slot.set_origin(x, state === ControlsState.APP_GRID ? y - extra : y);
            slot.set_size(width, height + extra);
            return slot;
        };
    }

    // How far the row of workspaces is folded away follows the overview's own
    // state: not at all up to the window picker, wholly in the app grid. So
    // the workspace shrinks towards its row and fades on the way in, and grows
    // back out of it on the way out, in step with whatever is moving the
    // overview — Show Apps, Super, a swipe — rather than on a clock of ours.
    // Only a change of view, when the overview is standing still, is eased.
    _syncWorkspaces(animate = false) {
        // An ease of ours can outlast the menu.
        const workspaces = this._controls?._workspacesDisplay;
        // A search has them hidden, and brings them back itself.
        if (!workspaces || this._controls._searchController?.searchActive)
            return;
        const state = this._adjustment?.value ?? ControlsState.WINDOW_PICKER;
        const fold = this._current
            ? Math.clamp(state - ControlsState.WINDOW_PICKER, 0, 1) : 0;
        // Nothing of ours to undo, which is every frame the overview moves
        // with the apps up: the workspaces are the shell's to animate.
        if (!fold && !this._fold)
            return;
        const opacity = Math.round(255 * (1 - fold));

        // As the shell hides them for a search: out of sight, and then out
        // of picking. The row lies over the top of the grown slot, and a
        // workspace that is only transparent still takes a poster's click.
        if (fold < 1) {
            workspaces.reactive = true;
            workspaces.setPrimaryWorkspaceVisible?.(true);
        }
        workspaces.remove_transition('opacity');
        if (animate && workspaces.mapped && workspaces.opacity !== opacity) {
            workspaces.ease({
                opacity,
                duration: Duration.NORMAL,
                mode: Ease.OUT,
                onComplete: () => this._syncWorkspaces(),
            });
            return;
        }
        this._fold = fold;
        workspaces.opacity = opacity;
        if (fold === 1) {
            workspaces.reactive = false;
            workspaces.setPrimaryWorkspaceVisible?.(false);
        }
    }

    // ------------------------------------------------------------------
    // Buttons beside Show Apps
    // ------------------------------------------------------------------
    _attachButtons() {
        this._detachButtons();
        const panel = global.dashToPanel?.panels?.[0];
        try {
            if (panel?.showAppsIconWrapper && panel.panel && panel._updateGroupedElements)
                this._attachToPanel(panel);
            else if (Main.overview.dash?._dashContainer)
                this._attachToDash(Main.overview.dash);
        } catch (e) {
            console.warn(`[Gnomeflix] No buttons beside Show Apps: ${e}`);
            this._detachButtons();
        }
        this._setAppsButtonsHeld(!!this._current);
        this._syncButtons();
    }

    _detachButtons() {
        this._setAppsButtonsHeld(false);
        const host = this._buttonHost;
        this._buttonHost = null;
        host?.release();
        this._buttons.clear();
    }

    _attachToDash(dash) {
        for (const section of this._sections) {
            const container = this._buildButton(section, dash.iconSize);
            dash._hookUpLabel?.(container);
            dash._dashContainer.add_child(container);
            this._buttons.set(section.key, container);
        }
        dash.connectObject('icon-size-changed', () => {
            for (const container of this._buttons.values())
                container.icon.setIconSize(dash.iconSize);
        }, this);
        const containers = [...this._buttons.values()];
        this._buttonHost = {
            appsButtons: [dash.showAppsButton],
            release: () => {
                dash.disconnectObject(this);
                containers.forEach(c => c.destroy());
            },
        };
    }

    // Dash to Panel lays out only the elements it knows, in groups it works
    // out from its settings. Ours is one more element, put into the group
    // Show Apps is in, straight after it, each time the groups are made.
    _attachToPanel(panel) {
        const showApps = panel.showAppsIconWrapper.realShowAppsIcon;
        const box = new St.BoxLayout({vertical: !!panel.geom?.vertical});
        for (const section of this._sections) {
            const container = this._buildButton(section, showApps.icon.iconSize,
                showApps.toggleButton.get_style());
            container.toggleButton.connect('notify::hover', button => {
                if (button.hover)
                    container.showLabel();
                else
                    container.hideLabel();
            });
            box.add_child(container);
            this._buttons.set(section.key, container);
        }
        // The way out is in place before anything is put into the panel, so
        // a throw part-way through still has it to call.
        let released = false;
        box.connect('destroy', () => (released = true));
        this._buttonHost = {
            appsButtons: [Main.overview.dash.showAppsButton, showApps.toggleButton],
            // The panel sizes its icons after it is made, and again as it fills.
            sync: () => {
                for (const container of this._buttons.values()) {
                    container.icon.setIconSize(showApps.icon.iconSize);
                    container.toggleButton.set_style(showApps.toggleButton.get_style());
                }
            },
            release: () => {
                delete panel._updateGroupedElements;
                if (!released)
                    box.destroy();
                try {
                    panel.updateElementPositions?.();
                } catch {
                    // The panel itself is on its way out.
                }
            },
        };

        panel.panel.add_child(box);

        const element = {actor: box, box: new Clutter.ActorBox()};
        const stock = panel._updateGroupedElements;
        panel._updateGroupedElements = function (positions) {
            stock.call(this, positions);
            for (const group of this._elementGroups ?? []) {
                const at = group.elements.findIndex(e => e.actor === showApps);
                if (at < 0)
                    continue;
                element.position = group.elements[at].position;
                group.elements.splice(at + 1, 0, element);
                if (group.expandableIndex > at)
                    group.expandableIndex++;
                break;
            }
            box.visible = showApps.visible;
        };
        panel.updateElementPositions?.();
    }

    _buildButton(section, iconSize, style = null) {
        const container = new Dash.DashItemContainer();
        const button = new St.Button({
            style_class: 'show-apps',
            track_hover: true,
            can_focus: true,
            toggle_mode: true,
        });
        if (style)
            button.set_style(style);
        container.icon = new IconGrid.BaseIcon(section.title, {
            setSizeManually: true,
            showLabel: false,
            createIcon: size => new St.Icon({
                icon_name: section.icon,
                icon_size: size,
                style_class: 'show-apps-icon',
                track_hover: true,
            }),
        });
        container.icon.y_align = Clutter.ActorAlign.CENTER;
        container.icon.setIconSize(iconSize);
        button.child = container.icon;
        button._delegate = container;
        container.toggleButton = button;
        container.setChild(button);
        container.setLabelText(section.title);
        container.show(false);
        button.connect('clicked', () => this._toggle(section.key));
        return container;
    }

    // A section's button: its view, opening the overview onto it if need be;
    // or, when that view is what is up, what Show Apps does when the apps
    // are: unchecked, which the shell takes back to the window picker.
    _toggle(key) {
        const showApps = Main.overview.dash.showAppsButton;
        if (Main.overview.visible && showApps.checked && this._current === key) {
            showApps.checked = false;
            return;
        }
        this.open(key);
    }

    // The overview, on a section's view: opened onto it, or brought up to the
    // grid if it is already showing.
    open(key) {
        if (!this._appsBox || !this._sections.some(s => s.key === key))
            return;
        this._show(key);
        if (Main.overview.visible)
            Main.overview.dash.showAppsButton.checked = true;
        else
            Main.overview.show(ControlsState.APP_GRID);
    }

    // While a media view is up, Show Apps is the way back to the apps rather
    // than out of the grid: it is kept from toggling, and its click is ours.
    _setAppsButtonsHeld(held) {
        for (const button of this._buttonHost?.appsButtons ?? []) {
            if (held && !button._gnomeflixHeld) {
                button._gnomeflixHeld = [
                    button.connect('clicked', () => this._show(null)),
                    // It is checked whenever the grid is up, which a media
                    // view is too, and the shell checks it as the grid opens.
                    button.connect('notify::checked', () => button.remove_style_pseudo_class('checked')),
                ];
                button.toggle_mode = false;
            } else if (!held && button._gnomeflixHeld) {
                button._gnomeflixHeld.forEach(id => button.disconnect(id));
                delete button._gnomeflixHeld;
                button.toggle_mode = true;
            }
            if (held)
                button.remove_style_pseudo_class('checked');
            else if (button.checked)
                button.add_style_pseudo_class('checked');
        }
    }

    _syncButtons() {
        this._buttonHost?.sync?.();
        for (const [key, container] of this._buttons)
            container.toggleButton.checked = key === this._current;
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------
    // A section's view in the app grid's slot, or (null) the apps again.
    _show(key) {
        if (!this._appsBox)
            return;
        if (key !== this._current) {
            // Measured while the slot is still as the last view left it.
            const view = key ? this._view(key) : null;
            this._views.get(this._current)?.hide();
            this._current = key;
            this._appsBox.visible = !key;
            if (view) {
                view.show();
                view.goToPage(0, false);
            }
            this._syncWorkspaces(true);
            this._setAppsButtonsHeld(!!key);
            this._controls.queue_relayout();
        }
        // A toggle button unchecks itself when the one that is up is clicked.
        this._syncButtons();
    }

    // The slot as the overview will lay it out under a media view, worked out
    // as its layout does: a button can ask for a view before the overview has
    // ever been shown, and what the slot was last given says nothing of which
    // of the two sizes that was.
    _slotSize() {
        let [width, height] = this._controls.allocation.get_size();
        if (!(width > 0 && height > 0)) {
            const area = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
            [width, height] = [area.width, area.height];
        }
        const spacing = this._controls.get_theme_node().get_length('spacing');
        const search = Main.overview.searchEntry?.get_parent();
        const dash = Main.overview.dash;
        const searchHeight = search ? search.get_preferred_height(width)[0] : 0;
        const dashHeight = dash.visible
            ? Math.min(dash.get_preferred_height(width)[1], Math.round(height * DASH_MAX_SHARE))
            : 0;
        // What the apps get, plus the row of workspaces folded away above them.
        return [width, height - searchHeight - dashHeight - 2 * spacing];
    }

    // Built the first time it is wanted.
    _view(key) {
        let view = this._views.get(key);
        if (view)
            return view;

        const section = this._sections.find(s => s.key === key);
        const [width, height] = this._slotSize();

        pendingGrid = gridFor(width, height, section.aspect);
        view = new MediaView({
            section,
            items: this._itemsFor(key),
            onActivate: this._onActivate,
        });
        view.visible = false;
        this._appDisplay.add_child(view);
        this._views.set(key, view);
        return view;
    }
}
