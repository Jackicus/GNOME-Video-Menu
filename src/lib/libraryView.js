// A section's library grid, laid out in rows of tiles sized from the screen
// and the "columns" preference. One is built per section the first time it is
// wanted and kept from then on, so going back to a section is showing an
// actor rather than building two hundred of them.

import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {staggerIn} from './anim.js';
import {fillOnScroll} from './lazyList.js';
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
// Rows added per batch once the first screenful is up. A section can hold
// thousands of items and the screen shows two and a bit rows of them.
const ROWS_PER_BATCH = 2;
// Matches the `columns` schema default; used only when there are no settings
// to read, so the grid still has a sensible width to lay out to.
export const DEFAULT_COLUMNS = 6;

export class LibraryView {
    constructor({section, items, width, height, columns, onActivate, onOpenSettings}) {
        this._columns = columns;
        this._onActivate = onActivate;
        this._onOpenSettings = onOpenSettings;
        this._tiles = new Map();
        this._width = width;
        this._height = height;

        // A fixed layout (no layout manager) so the grid can be placed
        // deliberately: the scroll view is oversized by INSET on every side and
        // shifted up-left by the same amount, so hovered tiles at the edges
        // can grow past the container without being cut off by its clip.
        this.actor = new Clutter.Actor({x_expand: true, y_expand: true});
        this.actor.add_child(items.length
            ? this._buildGrid(section, items)
            : this._buildEmpty(section));
    }

    destroy() {
        this.actor.destroy();
        this._tiles.clear();
    }

    tileFor(itemId) {
        return this._tiles.get(itemId) ?? null;
    }

    // Stagger in the tiles built so far, which is the screenful on show.
    reveal() {
        staggerIn([...this._tiles.values()]);
    }

    // Rows always span the full width with a fixed gutter, so every column
    // lines up and nothing is left ragged on the right. The column count is
    // the smallest that satisfies three limits: at least the preferred
    // number, enough that a tile is no taller than lets ~2.4 rows show, and
    // enough that a tile never exceeds MAX_TILE on a very wide screen.
    _metrics(aspect) {
        const preferred = Math.max(1, Math.round(this._columns) || 1);
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

        const {columns, tileW, tileH} = this._metrics(section.aspect);
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
        scroll.set_child(viewport);

        // The first batch covers the visible grid with a row to spare, so
        // nothing is missing on the frame the section appears; the rest follow
        // as it is scrolled. A tile is an St.Button with artwork and two
        // labels, and there can be thousands of them.
        let batch = Math.max(1, Math.ceil(this._height / (tileH + TILE_CHROME)) + 1);
        let next = 0;
        const buildRows = () => {
            const limit = Math.min(items.length, next + batch * columns);
            while (next < limit) {
                const row = new St.BoxLayout({style: `spacing: ${GUTTER}px; margin-bottom: ${ROW_GAP}px;`});
                const end = Math.min(limit, next + columns);
                for (; next < end; next++) {
                    const item = items[next];
                    const tile = createTile({
                        item,
                        icon: section.icon,
                        width: tileW,
                        height: tileH,
                        onActivate: this._onActivate,
                    });
                    this._tiles.set(item.id, tile);
                    row.add_child(tile);
                }
                rows.add_child(row);
            }
            batch = ROWS_PER_BATCH;
            return next < items.length;
        };
        fillOnScroll(scroll, buildRows);

        return scroll;
    }
}
