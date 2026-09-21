// One item up close: artwork and primary action on the left, title, facts,
// synopsis and the group list (seasons, tracks, files, photos) on the right.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';

import {Duration, Ease, slideSwap, staggerIn} from './anim.js';
import {fillOnScroll} from './lazyList.js';
import {artworkStyle, createArtwork, createActionButton, createLabel, createPill, createRow, createThumb} from './widgets.js';
import {PANE_INSET, radiusStyle} from './shape.js';
import {adjustAnimationTime, ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';

// What the pane keeps around its content, per frame, and the gap between its
// two columns; the stylesheet carries the same numbers. Sizes are worked out
// here rather than read back off an allocation, because the popup has to know
// how wide the side column will be before anything is on screen.
//
// Everything below is logical pixels, as the stylesheet's are: each is
// multiplied by the scale factor where it meets an allocation, and left alone
// where it goes into a CSS string, which St scales itself.
// The bare frame keeps less than the pane's own, because the panel around it
// adds `shape.js` PANE_INSET on top: what shows between the panel's edge and
// the artwork is the two together, and it comes to the same 32 either way.
const PADDING = {pane: 28, bare: 32 - PANE_INSET};
const COLUMN_GAP = 32;
// What the main column gives up to the list's own padding and scrollbar.
const LIST_CHROME = 16;

// The hero fills the pane's height, less its padding and the two action
// buttons beneath it, up to this cap. It stops well short of a big screen:
// the popup is a panel the size of a folder's, not the work area, and the
// desktop pane keeps to the same proportions.
const HERO_MAX_HEIGHT = 560;
const HERO_RESERVED = 2 * 52 + 28;         // two action buttons and the gaps
const HERO_MAX_WIDTH_FRACTION = 0.34;      // of the pane width
const THUMB_SIZE = 132;
const THUMB_GAP = 12;
// `.ml-thumb` padding, 4px a side: what a thumbnail's tile adds to its art.
const THUMB_PADDING = 8;
// 14px type at the stylesheet's line-height: 1.5.
const SUMMARY_LINE = 21;
const SUMMARY_LINES = 5;
// A season is a couple of dozen episodes, but a photo album runs to thousands.
// The first batch is a screenful — and the one that is staggered in — and the
// rest follow as the list scrolls.
const FIRST_ROWS = 24;
const ROWS_PER_BATCH = 16;
const THUMB_ROWS_PER_BATCH = 3;

export class DetailView {
    // `frame` is what the pane draws around itself: its own rounded, bordered
    // surface ('pane'), or nothing ('bare') when what holds it is the surface —
    // the shell's folder panel, in the popup.
    constructor({onOpen, frame = 'pane'}) {
        this._onOpen = onOpen;
        this._section = null;
        this._frame = frame;
        this._groups = [];
        this._groupIndex = 0;
        this._list = null;
        this._listHost = null;
        this._tabButtons = [];
        this._width = 0;
        this._height = 0;
        this._heroWidth = 240;
        this._deferredList = 0;
        this._deferredMain = 0;
        this._columns = null;
        this._main = null;
        this._buildPendingMain = null;
        this.hero = null;
        this.side = null;
        this.item = null;

        this.actor = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
    }

    destroy() {
        this._cancelDeferred();
        this.actor.destroy();
    }

    setSize(width, height) {
        this._width = width;
        this._height = height;
    }

    _cancelDeferred() {
        if (this._deferredList) {
            GLib.source_remove(this._deferredList);
            this._deferredList = 0;
        }
        if (this._deferredMain) {
            GLib.source_remove(this._deferredMain);
            this._deferredMain = 0;
        }
    }

    // What the pane keeps between its frame and its columns, in physical
    // pixels — St has already scaled the stylesheet's copy of it. Public
    // because the popup sizes its panel around the side column and has to add
    // it back.
    get padding() {
        return (PADDING[this._frame] ?? PADDING.pane) * this._scale;
    }

    get _scale() {
        return St.ThemeContext.get_for_stage(global.stage).scale_factor;
    }

    // The corner the pane and everything that fills it to the edge — the
    // backdrop, its veil — are cut to. Inside the popup's panel that is the
    // panel's own curve less the frame it keeps, so the two stay concentric.
    get _paneRadius() {
        return this._frame === 'bare' ? 'paneInner' : 'pane';
    }

    // Hero size for this screen: as tall as the pane allows, capped so the
    // text column keeps its share of the width.
    _heroSize(aspect) {
        const scale = this._scale;
        const room = this._height - 2 * this.padding - HERO_RESERVED * scale;
        const byHeight = Math.min(HERO_MAX_HEIGHT * scale, room);
        const byWidth = Math.round(this._width * HERO_MAX_WIDTH_FRACTION * aspect);
        // A small screen at the smallest `detail-size` leaves less room than
        // the buttons under the artwork take, and the artwork would come out
        // at nothing or below it. A thumbnail's size is the floor; the panel
        // grows around it, since it is sized from the column's own height.
        const height = Math.max(THUMB_SIZE * scale, Math.min(byHeight, byWidth));
        return {width: Math.round(height / aspect), height};
    }

    // Everything the pane opens goes out with the section it was shown for,
    // since what a file opens with is that section's setting.
    _open(path) {
        this._onOpen(path, this._section);
    }

    // `mainColumn` is when the second column — the title, the facts and the
    // list — joins the first: 'auto' as soon as the frame it was built on is
    // free, 'held' when whatever is opening the pane will call `revealMain()`
    // itself (the popup does, as it starts to widen onto it).
    populate(item, section, {mainColumn = 'auto'} = {}) {
        this._cancelDeferred();
        this.actor.destroy_all_children();
        this.item = item;
        this._section = section;
        this._groups = item.groups ?? [];
        this._groupIndex = 0;
        this._list = null;
        this._listHost = null;
        this._main = null;
        this._tabButtons = [];

        // The pane stacks an optional backdrop (TMDB's wide artwork, dimmed)
        // beneath the two-column content, both clipped to the pane's corners.
        const radius = this._paneRadius;
        const pane = new St.Widget({
            style_class: this._frame === 'bare' ? 'ml-pane ml-pane-bare' : 'ml-pane',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
            clip_to_allocation: true,
            style: radiusStyle(radius),
        });
        this.actor.add_child(pane);

        if (item.backdrop) {
            const backdrop = new St.Widget({style_class: 'ml-backdrop', x_expand: true, y_expand: true});
            backdrop.set_style(artworkStyle(item.backdrop, radius));
            pane.add_child(backdrop);
            // A dark veil keeps the text readable over bright artwork.
            pane.add_child(new St.Widget({
                style_class: 'ml-backdrop-veil',
                x_expand: true,
                y_expand: true,
                style: radiusStyle(radius),
            }));
        }

        const columns = new St.BoxLayout({style_class: 'ml-pane-content', x_expand: true, y_expand: true});
        pane.add_child(columns);
        this._columns = columns;
        this.side = this._buildSide(item, section);
        columns.add_child(this.side);

        // Only the artwork and its buttons are built now. The rest is built on
        // the next idle, off the frames of the flight or the zoom that is
        // opening the pane, and the list inside it later still as it scrolls.
        this._buildPendingMain = () => this._buildMain(item, section);
        this._deferredMain = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._deferredMain = 0;
            this._addMain();
            if (mainColumn === 'auto')
                this.revealMain();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Build the second column, hidden, if it is not there yet.
    _addMain() {
        if (!this._buildPendingMain)
            return;
        const build = this._buildPendingMain;
        this._buildPendingMain = null;
        if (this._deferredMain) {
            GLib.source_remove(this._deferredMain);
            this._deferredMain = 0;
        }
        this._main = build();
        this._main.opacity = 0;
        this._columns.add_child(this._main);
    }

    // Fade the second column in — as the popup's panel opens out onto it, or
    // on its own once built when the pane is already the width it will be.
    // The list under it follows the fade rather than joining it: see _fillList.
    revealMain({delay = 0} = {}) {
        this._addMain();
        this._main?.ease({opacity: 255, delay, duration: Duration.NORMAL, mode: Ease.OUT});
        this._fillList(delay + Duration.NORMAL);
    }

    // The first screenful of the group list, once the pane has stopped moving.
    // It is the one piece of building left that would be felt — two dozen rows
    // at once, where everything above it is a handful of actors — so the zoom
    // and the widen that opened the pane, or the hero flight into it, get
    // every frame before this to themselves. A timer and not an idle: an idle
    // falls in the middle of an animation, which is the whole of what this
    // avoids. Whatever fills it afterwards is `lazyList` as it scrolls.
    _fillList(after) {
        if (this._deferredList || this._list || !this._listHost)
            return;
        this._deferredList = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            adjustAnimationTime(after), () => {
                this._deferredList = 0;
                this._showGroup(this._groupIndex, {animate: false});
                return GLib.SOURCE_REMOVE;
            });
    }

    // And back out, as the panel closes back down to its artwork.
    hideMain({duration = Duration.FAST} = {}) {
        this._main?.ease({opacity: 0, duration, mode: Ease.OUT});
    }

    // Left: artwork, primary action, folder shortcut.
    _buildSide(item, section) {
        // x_expand is set explicitly to false: Clutter otherwise treats a parent
        // as expanding when any descendant expands (the buttons do), and the
        // side column would swallow half of the free width.
        const side = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'ml-detail-side', x_expand: false, y_expand: true});

        const {width: heroW, height: heroH} = this._heroSize(section.aspect);
        this._heroWidth = heroW;
        this.hero = createArtwork({
            path: item.art,
            title: item.title,
            icon: section.icon,
            width: heroW,
            height: heroH,
            styleClass: 'ml-art ml-hero',
            radius: 'hero',
        });
        side.add_child(this.hero);

        if (item.playPath) {
            const opensFolder = item.playLabel === 'Open folder';
            const play = createActionButton({
                label: item.playLabel,
                icon: opensFolder ? 'folder-open-symbolic' : 'media-playback-start-symbolic',
            });
            play.set_x_expand(true);
            play.connect('clicked', () => this._open(item.playPath));
            side.add_child(play);
        }

        if (item.folder && item.playPath !== item.folder) {
            const folder = createActionButton({
                label: 'Show in Files',
                icon: 'folder-symbolic',
                styleClass: 'button ml-action-secondary',
            });
            folder.set_x_expand(true);
            folder.connect('clicked', () => this._open(item.folder));
            side.add_child(folder);
        }

        return side;
    }

    // Right: title, facts, synopsis, group tabs, list.
    _buildMain(item, section) {
        const main = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_expand: true, style_class: 'ml-detail-main'});

        main.add_child(createLabel(item.title, 'ml-detail-title'));
        if (item.tagline)
            main.add_child(createLabel(item.tagline, 'ml-tagline'));

        const facts = new St.BoxLayout({style_class: 'ml-facts', y_align: Clutter.ActorAlign.CENTER});
        if (item.subtitle)
            facts.add_child(createPill(item.subtitle, 'ml-fact ml-fact-strong'));
        if (item.year)
            facts.add_child(createPill(String(item.year), 'ml-fact'));
        if (item.rating)
            facts.add_child(createPill(`★ ${item.rating}`, 'ml-fact ml-fact-rating'));
        if (item.countLabel)
            facts.add_child(createPill(item.countLabel, 'ml-fact'));
        if (item.groupLabel)
            facts.add_child(createPill(item.groupLabel, 'ml-fact'));
        for (const tag of item.tags)
            facts.add_child(createPill(tag, 'ml-fact ml-fact-tag'));
        if (facts.get_n_children())
            main.add_child(facts);

        if (item.summary) {
            const summary = new St.Label({text: item.summary, style_class: 'ml-summary', x_expand: true});
            summary.clutter_text.line_wrap = true;
            summary.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            summary.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            // Height bounds the text so Pango ellipsises the last visible line.
            summary.height = SUMMARY_LINE * this._scale * SUMMARY_LINES;
            summary.y_expand = false;
            main.add_child(summary);
        }

        if (this._groups.length > 1)
            main.add_child(this._buildTabs());
        else if (this._groups.length === 1)
            main.add_child(new St.Label({text: this._groups[0].name, style_class: 'ml-group-heading'}));

        this._listHost = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
            clip_to_allocation: true,
        });
        main.add_child(this._listHost);
        // The list itself is `revealMain`'s to start, once the pane has
        // landed (_fillList).
        return main;
    }

    _buildTabs() {
        const tabs = new St.BoxLayout({style_class: 'ml-tabs', x_expand: true});
        this._groups.forEach((group, i) => {
            const tab = new St.Button({
                // The theme's button: `:checked` is what marks the open tab.
                style_class: 'button ml-tab',
                label: group.name,
                toggle_mode: true,
                reactive: true,
                can_focus: true,
                track_hover: true,
            });
            tab.connect('clicked', () => {
                if (!tab.checked) {
                    tab.checked = true;
                    return;
                }
                this._showGroup(i, {animate: true});
            });
            this._tabButtons.push(tab);
            tabs.add_child(tab);
        });
        return tabs;
    }

    _showGroup(index, {animate}) {
        const previous = this._groupIndex;
        this._groupIndex = index;
        this._tabButtons.forEach((tab, i) => (tab.checked = i === index));

        const group = this._groups[index];
        const old = this._list;
        const list = group?.entries.length
            ? (this.item.layout === 'grid' ? this._buildThumbGrid(group) : this._buildList(group))
            : new St.Label({text: 'Nothing here yet.', style_class: 'ml-empty-hint', x_expand: true});
        this._list = list;
        this._listHost.add_child(list);

        if (!animate) {
            old?.destroy();
            return;
        }
        slideSwap(old, list, index >= previous ? 1 : -1, {distance: 24, onComplete: () => old?.destroy()});
    }

    _buildList(group) {
        const scroll = new St.ScrollView({x_expand: true, y_expand: true, overlay_scrollbars: true, style_class: 'vfade ml-list-scroll'});
        scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, style_class: 'ml-list'});
        scroll.set_child(box);

        const entries = group.entries;
        let next = 0;
        let first = true;
        fillOnScroll(scroll, () => {
            const limit = Math.min(entries.length, next + (first ? FIRST_ROWS : ROWS_PER_BATCH));
            const batch = [];
            for (; next < limit; next++) {
                const entry = entries[next];
                const row = createRow({
                    index: entry.index,
                    title: entry.title,
                    subtitle: entry.subtitle,
                    badges: entry.badges,
                    size: entry.size,
                    icon: entry.icon ?? 'media-playback-start-symbolic',
                    onActivate: () => this._open(entry.path),
                });
                // Keyboard focus has to drag the view after it, or a Tab past
                // the fold never scrolls and so never tops the list up.
                row.connect('key-focus-in', () => ensureActorVisibleInScrollView(scroll, row));
                batch.push(row);
                box.add_child(row);
            }
            // Only the arriving screenful is staggered; the rest are appended
            // below the fold, where an animation would go unseen.
            if (first)
                staggerIn(batch, {step: 12, cap: 160, fromY: 8});
            first = false;
            return next < entries.length;
        });
        return scroll;
    }

    _buildThumbGrid(group) {
        const scroll = new St.ScrollView({x_expand: true, y_expand: true, overlay_scrollbars: true, style_class: 'vfade ml-list-scroll'});
        scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        const rows = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, style_class: 'ml-thumb-grid'});
        scroll.set_child(rows);

        const scale = this._scale;
        const thumbSize = THUMB_SIZE * scale;
        const gap = THUMB_GAP * scale;
        // A thumbnail takes its tile's padding as well as its artwork.
        const cell = thumbSize + THUMB_PADDING * scale;
        // The main column is the pane minus the side column and paddings.
        const taken = this._heroWidth + 2 * this.padding + (COLUMN_GAP + LIST_CHROME) * scale;
        const usable = Math.max(cell, this._width - taken);
        const columns = Math.max(1, Math.floor((usable + gap) / (cell + gap)));

        const entries = group.entries;
        let next = 0;
        let first = true;
        let batchRows = Math.max(1, Math.ceil(this._height / (cell + gap)) + 1);
        fillOnScroll(scroll, () => {
            const limit = Math.min(entries.length, next + batchRows * columns);
            const batch = [];
            while (next < limit) {
                const row = new St.BoxLayout({style: `spacing: ${THUMB_GAP}px; margin-bottom: ${THUMB_GAP}px;`});
                const end = Math.min(limit, next + columns);
                for (; next < end; next++) {
                    const entry = entries[next];
                    const thumb = createThumb({
                        path: entry.thumb,
                        size: thumbSize,
                        accessibleName: entry.title,
                        onActivate: () => this._open(entry.path),
                    });
                    // As in the list: Tab past the fold has to scroll, or the
                    // grid never tops itself up.
                    thumb.connect('key-focus-in', () => ensureActorVisibleInScrollView(scroll, thumb));
                    row.add_child(thumb);
                }
                batch.push(row);
                rows.add_child(row);
            }
            // The rows arrive one after another, not the four dozen thumbnails
            // in them: a transition apiece buys nothing once they share a delay,
            // and a row is one actor to fade rather than a screenful.
            if (first)
                staggerIn(batch, {step: 24, cap: 200, fromY: 8});
            first = false;
            batchRows = THUMB_ROWS_PER_BATCH;
            return next < entries.length;
        });
        return scroll;
    }
}
