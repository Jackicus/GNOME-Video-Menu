// One item up close: artwork and primary action on the left, title, facts,
// synopsis and the group list (seasons, tracks, files, photos) on the right.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';

import {slideSwap, staggerIn} from './anim.js';
import {fillOnScroll} from './lazyList.js';
import {createArtwork, createActionButton, createLabel, createPill, createRow, createThumb} from './widgets.js';
import {radiusStyle} from './shape.js';

// The hero fills the pane's height, less its padding and the two action
// buttons beneath it, within these bounds.
const HERO_MIN_HEIGHT = 300;
const HERO_MAX_HEIGHT = 720;
const HERO_RESERVED = 56 + 2 * 52 + 24;   // pane padding, two buttons, gaps
const HERO_MAX_WIDTH_FRACTION = 0.34;      // of the pane width
const THUMB_SIZE = 132;
const THUMB_GAP = 12;
const SUMMARY_LINES = 5;
// A season is a couple of dozen episodes, but a documents collection runs to
// hundreds and a photo album to thousands. The first batch is a screenful —
// and the one that is staggered in — and the rest follow as the list scrolls.
const FIRST_ROWS = 24;
const ROWS_PER_BATCH = 16;
const THUMB_ROWS_PER_BATCH = 3;

export class DetailView {
    constructor({onOpen}) {
        this._onOpen = onOpen;
        this._groups = [];
        this._groupIndex = 0;
        this._list = null;
        this._listHost = null;
        this._tabButtons = [];
        this._width = 0;
        this._height = 0;
        this._heroWidth = 240;
        this._deferredList = 0;
        this.hero = null;
        this.item = null;

        this.actor = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
            style_class: 'gf-detail',
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
    }

    // Hero size for this screen: as tall as the pane allows, capped so the
    // text column keeps its share of the width.
    _heroSize(aspect) {
        const byHeight = Math.max(HERO_MIN_HEIGHT, Math.min(HERO_MAX_HEIGHT, this._height - HERO_RESERVED));
        const byWidth = Math.round(this._width * HERO_MAX_WIDTH_FRACTION * aspect);
        const height = Math.min(byHeight, byWidth);
        return {width: Math.round(height / aspect), height};
    }

    populate(item, section) {
        this._cancelDeferred();
        this.actor.destroy_all_children();
        this.item = item;
        this._groups = item.groups ?? [];
        this._groupIndex = 0;
        this._list = null;
        this._tabButtons = [];

        // The pane stacks an optional backdrop (TMDB's wide artwork, dimmed)
        // beneath the two-column content, both clipped to the pane's corners.
        const pane = new St.Widget({
            style_class: 'gf-pane',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
            clip_to_allocation: true,
            style: radiusStyle('pane'),
        });
        this.actor.add_child(pane);

        if (item.backdrop) {
            const backdrop = new St.Widget({style_class: 'gf-backdrop', x_expand: true, y_expand: true});
            backdrop.set_style(`background-image: url("file://${encodeURI(item.backdrop)}"); background-size: cover; ${radiusStyle('pane')}`);
            pane.add_child(backdrop);
            // A dark veil keeps the text readable over bright artwork.
            pane.add_child(new St.Widget({
                style_class: 'gf-backdrop-veil',
                x_expand: true,
                y_expand: true,
                style: radiusStyle('pane'),
            }));
        }

        const columns = new St.BoxLayout({style_class: 'gf-pane-content', x_expand: true, y_expand: true});
        pane.add_child(columns);
        columns.add_child(this._buildSide(item, section));
        columns.add_child(this._buildMain(item, section));
    }

    // Left: artwork, primary action, folder shortcut.
    _buildSide(item, section) {
        // x_expand is set explicitly to false: Clutter otherwise treats a parent
        // as expanding when any descendant expands (the buttons do), and the
        // side column would swallow half of the free width.
        const side = new St.BoxLayout({vertical: true, style_class: 'gf-detail-side', x_expand: false, y_expand: true});

        const {width: heroW, height: heroH} = this._heroSize(section.aspect);
        this._heroWidth = heroW;
        this.hero = createArtwork({
            path: item.art,
            title: item.title,
            icon: section.icon,
            width: heroW,
            height: heroH,
            styleClass: 'gf-art gf-hero',
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
            play.connect('clicked', () => this._onOpen(item.playPath));
            side.add_child(play);
        }

        if (item.folder && item.playPath !== item.folder) {
            const folder = createActionButton({
                label: 'Show in Files',
                icon: 'folder-symbolic',
                styleClass: 'gf-action gf-action-secondary',
            });
            folder.set_x_expand(true);
            folder.connect('clicked', () => this._onOpen(item.folder));
            side.add_child(folder);
        }

        return side;
    }

    // Right: title, facts, synopsis, group tabs, list.
    _buildMain(item, section) {
        const main = new St.BoxLayout({vertical: true, x_expand: true, y_expand: true, style_class: 'gf-detail-main'});

        main.add_child(createLabel(item.title, 'gf-detail-title'));
        if (item.tagline)
            main.add_child(createLabel(item.tagline, 'gf-tagline'));

        const facts = new St.BoxLayout({style_class: 'gf-facts', y_align: Clutter.ActorAlign.CENTER});
        if (item.subtitle)
            facts.add_child(createPill(item.subtitle, 'gf-fact gf-fact-strong'));
        if (item.year)
            facts.add_child(createPill(String(item.year), 'gf-fact'));
        if (item.rating)
            facts.add_child(createPill(`★ ${item.rating}`, 'gf-fact gf-fact-rating'));
        if (item.countLabel)
            facts.add_child(createPill(item.countLabel, 'gf-fact'));
        if (item.groupLabel)
            facts.add_child(createPill(item.groupLabel, 'gf-fact'));
        for (const tag of item.tags)
            facts.add_child(createPill(tag, 'gf-fact gf-fact-tag'));
        if (facts.get_n_children())
            main.add_child(facts);

        if (item.summary) {
            const summary = new St.Label({text: item.summary, style_class: 'gf-summary', x_expand: true});
            summary.clutter_text.line_wrap = true;
            summary.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            summary.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            // Height bounds the text so Pango ellipsises the last visible line.
            const lineHeight = 21;
            summary.height = lineHeight * SUMMARY_LINES;
            summary.y_expand = false;
            main.add_child(summary);
        }

        if (this._groups.length > 1)
            main.add_child(this._buildTabs());
        else if (this._groups.length === 1)
            main.add_child(new St.Label({text: this._groups[0].name, style_class: 'gf-group-heading'}));

        this._listHost = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
            clip_to_allocation: true,
        });
        main.add_child(this._listHost);
        // Build the list on the next idle so the pane and hero can start
        // animating this frame; a long season would otherwise stall the
        // first frame of the transition.
        this._deferredList = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._deferredList = 0;
            this._showGroup(0, {animate: false});
            return GLib.SOURCE_REMOVE;
        });

        return main;
    }

    _buildTabs() {
        const tabs = new St.BoxLayout({style_class: 'gf-tabs', x_expand: true});
        this._groups.forEach((group, i) => {
            const tab = new St.Button({
                style_class: 'gf-tab',
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
            : new St.Label({text: 'Nothing here yet.', style_class: 'gf-empty-hint', x_expand: true});
        this._list = list;
        this._listHost.add_child(list);

        if (!animate) {
            old?.destroy();
            return;
        }
        slideSwap(old, list, index >= previous ? 1 : -1, {distance: 24, onComplete: () => old?.destroy()});
    }

    _buildList(group) {
        const scroll = new St.ScrollView({x_expand: true, y_expand: true, overlay_scrollbars: true, style_class: 'gf-list-scroll'});
        scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        const box = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'gf-list'});
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
                    onActivate: () => this._onOpen(entry.path),
                });
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
        const scroll = new St.ScrollView({x_expand: true, y_expand: true, overlay_scrollbars: true, style_class: 'gf-list-scroll'});
        scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        const rows = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'gf-thumb-grid'});
        scroll.set_child(rows);

        // The main column is the pane minus the side column and paddings.
        const usable = Math.max(THUMB_SIZE, this._width - this._heroWidth - 140);
        const columns = Math.max(1, Math.floor((usable + THUMB_GAP) / (THUMB_SIZE + THUMB_GAP)));

        const entries = group.entries;
        let next = 0;
        let first = true;
        let batchRows = Math.max(1, Math.ceil(this._height / (THUMB_SIZE + THUMB_GAP)) + 1);
        fillOnScroll(scroll, () => {
            const limit = Math.min(entries.length, next + batchRows * columns);
            const batch = [];
            while (next < limit) {
                const row = new St.BoxLayout({style: `spacing: ${THUMB_GAP}px; margin-bottom: ${THUMB_GAP}px;`});
                const end = Math.min(limit, next + columns);
                for (; next < end; next++) {
                    const entry = entries[next];
                    row.add_child(createThumb({
                        path: entry.thumb,
                        size: THUMB_SIZE,
                        onActivate: () => this._onOpen(entry.path),
                    }));
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
