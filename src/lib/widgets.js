// Small St building blocks shared by the views. Everything paints through the
// stylesheet (gf-* classes); JS only sets sizes and wires behaviour.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

import {Duration, Ease} from './anim.js';
import {radiusStyle} from './shape.js';

const HOVER_SCALE = 1.05;
const HOVER_LIFT = -4;

// St bakes the corner radius into the artwork only when it renders the
// background image itself, so the radius has to travel in the same inline
// style as the image rather than being left to the stylesheet.
function artworkStyle(path, part) {
    return `background-image: url("file://${encodeURI(path)}"); background-size: cover; ${radiusStyle(part)}`;
}

// A poster or album cover: the image when there is one, otherwise a tinted
// placeholder built from the section icon and the title. Placeholders live in
// the stylesheet so they follow the system accent colour.
export function createArtwork({path, title, icon, width, height, styleClass = 'gf-art', radius = 'art'}) {
    const art = new St.Widget({
        style_class: styleClass,
        width,
        height,
        layout_manager: new Clutter.BinLayout(),
        clip_to_allocation: true,
        // Explicit, because a placeholder's inner box expands to centre its
        // icon, and Clutter would otherwise let that expansion leak upwards
        // and stretch the artwork itself.
        x_expand: false,
        y_expand: false,
    });
    if (path) {
        art.set_style(artworkStyle(path, radius));
        return art;
    }

    art.set_style(radiusStyle(radius));
    art.add_style_class_name('gf-art-placeholder');
    const stack = new St.BoxLayout({
        vertical: true,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
        y_expand: true,
        style_class: 'gf-art-placeholder-content',
    });
    stack.add_child(new St.Icon({
        icon_name: icon,
        icon_size: Math.max(24, Math.round(width * 0.22)),
        style_class: 'gf-art-placeholder-icon',
        x_align: Clutter.ActorAlign.CENTER,
    }));
    if (title && width >= 120) {
        const label = new St.Label({
            text: title,
            style_class: 'gf-art-placeholder-title',
            x_align: Clutter.ActorAlign.CENTER,
            width: Math.round(width * 0.8),
        });
        label.clutter_text.line_wrap = true;
        label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        label.clutter_text.x_align = Clutter.ActorAlign.CENTER;
        label.height = Math.min(64, Math.round(height * 0.3));
        stack.add_child(label);
    }
    art.add_child(stack);
    return art;
}

// A library grid tile: artwork with a title (and optional subtitle) beneath.
// Hover lifts and scales it, like a dash icon; the whole tile is the button.
export function createTile({item, icon, width, height, onActivate}) {
    const tile = new St.Button({
        style_class: 'gf-tile',
        reactive: true,
        can_focus: true,
        track_hover: true,
        x_align: Clutter.ActorAlign.START,
        y_align: Clutter.ActorAlign.START,
        style: radiusStyle('tile'),
    });
    tile.set_pivot_point(0.5, 0.5);

    const box = new St.BoxLayout({vertical: true, width});
    const art = createArtwork({path: item.art, title: item.title, icon, width, height});
    box.add_child(art);

    const title = new St.Label({text: item.title, style_class: 'gf-tile-title'});
    title.clutter_text.single_line_mode = true;
    title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    box.add_child(title);

    const subtitleText = item.subtitle ?? (item.year ? String(item.year) : item.countLabel);
    if (subtitleText) {
        const subtitle = new St.Label({text: String(subtitleText), style_class: 'gf-tile-subtitle'});
        subtitle.clutter_text.single_line_mode = true;
        subtitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(subtitle);
    }
    tile.set_child(box);

    tile.connect('notify::hover', () => {
        const hovered = tile.hover;
        tile.ease({
            scale_x: hovered ? HOVER_SCALE : 1,
            scale_y: hovered ? HOVER_SCALE : 1,
            translation_y: hovered ? HOVER_LIFT : 0,
            duration: Duration.FAST,
            mode: Ease.OUT,
        });
    });
    tile.connect('clicked', () => onActivate?.(item, tile));

    tile.artwork = art;
    tile.item = item;
    return tile;
}

// A circular icon button, the shape GNOME uses for back/close in header bars.
export function createIconButton(iconName, {styleClass = 'gf-icon-button', iconSize = 16, accessibleName} = {}) {
    const button = new St.Button({
        style_class: styleClass,
        reactive: true,
        can_focus: true,
        track_hover: true,
        accessible_name: accessibleName,
        child: new St.Icon({icon_name: iconName, icon_size: iconSize}),
    });
    return button;
}

// A pill button with an icon and a label, used for primary actions.
export function createActionButton({label, icon, styleClass = 'gf-action'}) {
    const content = new St.BoxLayout({style_class: 'gf-action-content', y_align: Clutter.ActorAlign.CENTER});
    if (icon)
        content.add_child(new St.Icon({icon_name: icon, icon_size: 16, y_align: Clutter.ActorAlign.CENTER}));
    content.add_child(new St.Label({text: label, y_align: Clutter.ActorAlign.CENTER}));
    return new St.Button({
        style_class: styleClass,
        reactive: true,
        can_focus: true,
        track_hover: true,
        child: content,
    });
}

export function createPill(text, styleClass = 'gf-pill') {
    return new St.Label({text, style_class: styleClass, y_align: Clutter.ActorAlign.CENTER});
}

// A segmented control: one pill container, one toggle button per option, one
// checked at a time. Returns the actor plus a setter the caller drives.
export function createSegmented(options, activeKey, onChange) {
    const box = new St.BoxLayout({style_class: 'gf-segmented', y_align: Clutter.ActorAlign.CENTER});
    const buttons = new Map();

    for (const opt of options) {
        const content = new St.BoxLayout({style_class: 'gf-segment-content', y_align: Clutter.ActorAlign.CENTER});
        content.add_child(new St.Icon({icon_name: opt.icon, icon_size: 16, y_align: Clutter.ActorAlign.CENTER}));
        content.add_child(new St.Label({text: opt.title, y_align: Clutter.ActorAlign.CENTER}));
        const button = new St.Button({
            style_class: 'gf-segment',
            toggle_mode: true,
            reactive: true,
            can_focus: true,
            track_hover: true,
            child: content,
        });
        button.connect('clicked', () => {
            // A toggle button unchecks itself on click; the control is radio-like.
            if (!button.checked) {
                button.checked = true;
                return;
            }
            setActive(opt.key);
            onChange?.(opt.key);
        });
        buttons.set(opt.key, button);
        box.add_child(button);
    }

    function setActive(key) {
        for (const [k, b] of buttons)
            b.checked = k === key;
    }
    setActive(activeKey);
    return {actor: box, setActive};
}

// One entry in a detail list: numbered circle, title/subtitle, badges, size and
// a play glyph that lights up on hover.
export function createRow({index, title, subtitle, badges = [], size, icon = 'media-playback-start-symbolic', onActivate}) {
    const row = new St.Button({
        style_class: 'gf-row',
        reactive: true,
        can_focus: true,
        track_hover: true,
        x_expand: true,
        style: radiusStyle('row'),
    });
    const content = new St.BoxLayout({x_expand: true, y_align: Clutter.ActorAlign.CENTER});

    content.add_child(new St.Label({
        text: String(index),
        style_class: 'gf-row-index',
        y_align: Clutter.ActorAlign.CENTER,
    }));

    const text = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'gf-row-text'});
    const titleLabel = new St.Label({text: title, style_class: 'gf-row-title'});
    titleLabel.clutter_text.single_line_mode = true;
    titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    text.add_child(titleLabel);
    if (subtitle) {
        const sub = new St.Label({text: subtitle, style_class: 'gf-row-subtitle'});
        sub.clutter_text.single_line_mode = true;
        sub.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(sub);
    }
    content.add_child(text);

    for (const badge of badges) {
        const pill = createPill(badge, 'gf-badge');
        pill.set_style(radiusStyle('badge'));
        content.add_child(pill);
    }
    if (size)
        content.add_child(new St.Label({text: size, style_class: 'gf-row-size', y_align: Clutter.ActorAlign.CENTER}));

    content.add_child(new St.Icon({
        icon_name: icon,
        icon_size: 16,
        style_class: 'gf-row-icon',
        y_align: Clutter.ActorAlign.CENTER,
    }));

    row.set_child(content);
    row.connect('clicked', () => onActivate?.());
    return row;
}

// A square photo thumbnail for grid-layout groups.
export function createThumb({path, size, onActivate}) {
    const button = new St.Button({
        style_class: 'gf-thumb',
        reactive: true,
        can_focus: true,
        track_hover: true,
        width: size,
        height: size,
        style: radiusStyle('thumb'),
    });
    button.set_pivot_point(0.5, 0.5);
    if (path)
        button.set_style(artworkStyle(path, 'thumb'));
    button.connect('notify::hover', () => {
        const s = button.hover ? 1.04 : 1;
        button.ease({scale_x: s, scale_y: s, duration: Duration.FAST, mode: Ease.OUT});
    });
    button.connect('clicked', () => onActivate?.());
    return button;
}

// Shown when a section has nothing in it.
export function createEmptyState({icon, title, hint, actionLabel, onAction}) {
    const box = new St.BoxLayout({
        vertical: true,
        style_class: 'gf-empty',
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
        y_expand: true,
    });
    box.add_child(new St.Icon({icon_name: icon, icon_size: 64, style_class: 'gf-empty-icon', x_align: Clutter.ActorAlign.CENTER}));
    box.add_child(new St.Label({text: title, style_class: 'gf-empty-title', x_align: Clutter.ActorAlign.CENTER}));
    box.add_child(new St.Label({text: hint, style_class: 'gf-empty-hint', x_align: Clutter.ActorAlign.CENTER}));
    if (actionLabel) {
        const button = createActionButton({label: actionLabel, icon: 'preferences-system-symbolic', styleClass: 'gf-action gf-action-secondary'});
        button.x_align = Clutter.ActorAlign.CENTER;
        button.connect('clicked', () => onAction?.());
        box.add_child(button);
    }
    return box;
}
