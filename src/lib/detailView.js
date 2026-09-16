// One item up close: artwork and primary action on the left, title, facts,
// synopsis and the group list (seasons, tracks, files, photos) on the right.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';

import {Duration, slideSwap, staggerIn} from './anim.js';
import {createArtwork, createActionButton, createPill, createRow, createThumb} from './widgets.js';
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

        const title = new St.Label({text: item.title, style_class: 'gf-detail-title'});
        title.clutter_text.single_line_mode = true;
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        main.add_child(title);

        if (item.tagline) {
            const tagline = new St.Label({text: item.tagline, style_class: 'gf-tagline'});
            tagline.clutter_text.single_line_mode = true;
            tagline.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            main.add_child(tagline);
        }

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
            : this._buildNothing();
        this._list = list;
        this._listHost.add_child(list);

        if (!animate) {
            old?.destroy();
            return;
        }
        slideSwap(old, list, index >= previous ? 1 : -1, {distance: 24, onComplete: () => old?.destroy()});
    }

    _buildNothing() {
        return new St.Label({text: 'Nothing here yet.', style_class: 'gf-empty-hint', x_expand: true});
    }

    _buildList(group) {
        const scroll = new St.ScrollView({x_expand: true, y_expand: true, overlay_scrollbars: true, style_class: 'gf-list-scroll'});
        scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        const box = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'gf-list'});
        const rows = group.entries.map(entry => createRow({
            index: entry.index,
            title: entry.title,
            subtitle: entry.subtitle,
            badges: entry.badges,
            size: entry.size,
            icon: entry.icon ?? 'media-playback-start-symbolic',
            onActivate: () => this._onOpen(entry.path),
        }));
        rows.forEach(row => box.add_child(row));
        scroll.set_child(box);
        staggerIn(rows.slice(0, 24), {step: 12, cap: 160, fromY: 8, duration: Duration.NORMAL});
        return scroll;
    }

    _buildThumbGrid(group) {
        const scroll = new St.ScrollView({x_expand: true, y_expand: true, overlay_scrollbars: true, style_class: 'gf-list-scroll'});
        scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        const rows = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'gf-thumb-grid'});

        // The main column is the pane minus the side column and paddings.
        const usable = Math.max(THUMB_SIZE, this._width - this._heroWidth - 140);
        const columns = Math.max(1, Math.floor((usable + THUMB_GAP) / (THUMB_SIZE + THUMB_GAP)));

        let row = null;
        const thumbs = [];
        group.entries.forEach((entry, i) => {
            if (i % columns === 0) {
                row = new St.BoxLayout({style: `spacing: ${THUMB_GAP}px; margin-bottom: ${THUMB_GAP}px;`});
                rows.add_child(row);
            }
            const thumb = createThumb({path: entry.thumb, size: THUMB_SIZE, onActivate: () => this._onOpen(entry.path)});
            thumbs.push(thumb);
            row.add_child(thumb);
        });
        scroll.set_child(rows);
        staggerIn(thumbs.slice(0, 40), {step: 10, cap: 200, fromY: 8});
        return scroll;
    }
}
