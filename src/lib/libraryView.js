// The library grid: one section (TV, Films, Music, Photos) at a time, laid out
// in rows of tiles sized from the screen and the "columns" preference.

import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {staggerIn, slideSwap} from './anim.js';
import {SECTIONS, sectionByKey} from './library.js';
import {createTile, createEmptyState} from './widgets.js';

const GUTTER = 20;             // horizontal gap between tiles
const ROW_GAP = 24;            // vertical gap between rows
const MIN_TILE = 110;
const MAX_TILE = 320;
// Title (and subtitle) beneath the artwork, plus the row gap.
const TILE_CHROME = 48;
// Keep a partial row visible so the grid reads as scrollable, not cut off.
const MIN_VISIBLE_ROWS = 2.4;
// Breathing room around the grid so a hovered tile (scaled 5% and lifted)
// is never clipped by the scroll view's edges.
const INSET = 16;

export class LibraryView {
    constructor({columnsPreference, onActivate, onOpenSettings}) {
        this._columnsPreference = columnsPreference;
        this._onActivate = onActivate;
        this._onOpenSettings = onOpenSettings;
        this._sectionKey = null;
        this._items = [];
        this._grid = null;
        this._tiles = new Map();
        this._width = 0;
        this._height = 0;

        // A fixed layout (no layout manager) so the grid can be placed
        // deliberately: the scroll view is oversized by INSET on every side and
        // shifted up-left by the same amount, so hovered tiles at the edges
        // can grow past the container without being cut off by its clip.
        this.actor = new Clutter.Actor({x_expand: true, y_expand: true});
    }

    destroy() {
        this.actor.destroy();
        this._grid = null;
        this._tiles.clear();
    }

    get sectionKey() {
        return this._sectionKey;
    }

    tileFor(itemId) {
        return this._tiles.get(itemId) ?? null;
    }

    setSize(width, height) {
        this._width = width;
        this._height = height;
    }

    // Replace the grid with `items` from `sectionKey`. With animate, the old
    // grid slides out towards the previous section and the new one slides in.
    // `reveal` staggers the tiles in; `revealAfter` delays that, e.g. until the
    // shell's own workspace slide has uncovered the surface.
    showSection(sectionKey, items, {animate = false, reveal = false, revealAfter = 0} = {}) {
        const previousKey = this._sectionKey;
        const old = this._grid;
        this._sectionKey = sectionKey;
        this._items = items;
        this._tiles.clear();

        const section = sectionByKey(sectionKey);
        const grid = items.length
            ? this._buildGrid(section, items)
            : this._buildEmpty(section);
        this._grid = grid;
        this.actor.add_child(grid);

        if (!animate) {
            old?.destroy();
            if (reveal)
                staggerIn([...this._tiles.values()], {start: revealAfter});
            return;
        }

        const from = SECTIONS.findIndex(s => s.key === previousKey);
        const to = SECTIONS.findIndex(s => s.key === sectionKey);
        const direction = to >= from ? 1 : -1;
        slideSwap(old, grid, direction, {onComplete: () => old?.destroy()});
    }

    // Rows always span the full width with a fixed gutter, so every column
    // lines up and nothing is left ragged on the right. The column count is
    // the smallest that satisfies three limits: at least the preferred
    // number, enough that a tile is no taller than lets ~2.4 rows show, and
    // enough that a tile never exceeds MAX_TILE on a very wide screen.
    metrics(aspect) {
        const preferred = Math.max(1, this._columnsPreference() || 6);
        const availableW = Math.max(200, this._width - 2 * INSET);
        const availableH = Math.max(200, this._height - INSET);

        const tallest = Math.max(MIN_TILE, Math.floor((availableH / MIN_VISIBLE_ROWS - TILE_CHROME) / aspect));
        const columnsFor = tileW => Math.ceil((availableW + GUTTER) / (tileW + GUTTER));
        const columns = Math.max(preferred, columnsFor(tallest), columnsFor(MAX_TILE));
        const tileW = Math.max(MIN_TILE, Math.floor((availableW - GUTTER * (columns - 1)) / columns));
        return {columns, tileW, tileH: Math.round(tileW * aspect)};
    }

    _buildEmpty(section) {
        const host = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x: 0,
            y: 0,
            width: this._width,
            height: this._height,
        });
        host.add_child(createEmptyState({
            icon: section.icon,
            title: `No ${section.title.toLowerCase()} yet`,
            hint: section.emptyHint,
            actionLabel: 'Open Settings',
            onAction: this._onOpenSettings,
        }));
        return host;
    }

    _buildGrid(section, items) {
        // Oversized and shifted up-left by INSET, with the rows inset by the
        // same amount, so tiles sit flush with the container while the clip
        // edge lies INSET outside it.
        const scroll = new St.ScrollView({
            x: -INSET,
            y: -INSET,
            width: this._width + 2 * INSET,
            height: this._height + 2 * INSET,
            overlay_scrollbars: true,
            style_class: 'gf-grid-scroll',
        });
        scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);

        const {columns, tileW, tileH} = this.metrics(section.aspect);
        // The scroll child is an StViewport, which clips to its own content
        // box, inside any padding it carries. So the viewport stays unpadded
        // and the inset lives on a child box within it, where it sits inside
        // the clip rather than shrinking it.
        const viewport = new St.BoxLayout({vertical: true, x_expand: true});
        const rows = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'gf-grid',
            style: `padding: ${INSET}px;`,
        });
        viewport.add_child(rows);

        let row = null;
        items.forEach((item, i) => {
            if (i % columns === 0) {
                row = new St.BoxLayout({style: `spacing: ${GUTTER}px; margin-bottom: ${ROW_GAP}px;`});
                rows.add_child(row);
            }
            const tile = createTile({
                item,
                icon: section.icon,
                width: tileW,
                height: tileH,
                onActivate: this._onActivate,
            });
            this._tiles.set(item.id, tile);
            row.add_child(tile);
        });

        scroll.set_child(viewport);
        return scroll;
    }
}
