// Small St building blocks shared by the views. Everything paints through the
// stylesheet (gf-* classes); JS only sets sizes and wires behaviour.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

import {Duration, Ease} from './anim.js';
import {radiusStyle} from './shape.js';

const HOVER_SCALE = 1.05;
const HOVER_LIFT = -4;

// Grow (and optionally lift) an actor while the pointer is on it, the way the
// dash does. The one hover animation in the design, so tiles, launchers and
// thumbnails all take it from here rather than restating the curve.
//
// Driven from the crossing events rather than `notify::hover`: `track_hover`
// raises the `hover` pseudo-class, and St answers that by restyling the widget
// and all of its children — twice per crossing, across a grid of eighty tiles,
// to do nothing but scale. Only `tracked` widgets, which paint something from
// `:hover` and are never many, still ask for it; a button's own click handling
// is a Clutter gesture and does not read the hover bit.
function addHoverScale(actor, {lift = 0, tracked = false} = {}) {
    actor.set_pivot_point(0.5, 0.5);
    const hover = on => actor.ease({
        scale_x: on ? HOVER_SCALE : 1,
        scale_y: on ? HOVER_SCALE : 1,
        translation_y: on ? lift : 0,
        duration: Duration.FAST,
        mode: Ease.OUT,
    });
    if (tracked) {
        actor.connect('notify::hover', () => hover(actor.hover));
        return;
    }
    const crossing = on => () => (hover(on), Clutter.EVENT_PROPAGATE);
    actor.connect('enter-event', crossing(true));
    actor.connect('leave-event', crossing(false));
}

// St bakes the corner radius into the artwork only when it renders the
// background image itself, so the radius has to travel in the same inline
// style as the image rather than being left to the stylesheet.
function artworkStyle(path, part = 'art') {
    return `background-image: url("file://${encodeURI(path)}"); background-size: cover; ${radiusStyle(part)}`;
}

// A single line of text that ellipsises rather than wraps: every title and
// subtitle in the design, on a tile, a row or in the detail pane.
export function createLabel(text, styleClass, props = {}) {
    const label = new St.Label({text, style_class: styleClass, ...props});
    label.clutter_text.single_line_mode = true;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return label;
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
        // Not clipped: the focus ring is a box-shadow and has to show past
        // the allocation. The placeholder's icon/label stack gets its own
        // clip below instead.
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
        clip_to_allocation: true,
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
    // No radius of its own: the button paints nothing, so an inline style fewer
    // here is a theme node fewer per tile.
    const tile = new St.Button({
        style_class: 'gf-tile',
        can_focus: true,
        x_align: Clutter.ActorAlign.START,
        y_align: Clutter.ActorAlign.START,
    });

    const box = new St.BoxLayout({vertical: true, width});
    const art = createArtwork({path: item.art, title: item.title, icon, width, height});
    box.add_child(art);

    box.add_child(createLabel(item.title, 'gf-tile-title'));

    const subtitle = item.subtitle ?? (item.year ? String(item.year) : item.countLabel);
    if (subtitle)
        box.add_child(createLabel(String(subtitle), 'gf-tile-subtitle'));
    tile.set_child(box);

    addHoverScale(tile, {lift: HOVER_LIFT});
    tile.connect('clicked', () => onActivate?.(item, tile));

    tile.artwork = art;
    tile.item = item;
    return tile;
}

// A home-menu launcher: a large rounded card carrying the section's icon over
// a wash of its own artwork, with the title and item count beneath and a dot
// that lights while the section's workspace is open, like a running app's.
export function createLauncher({section, count, art, size, onActivate}) {
    const launcher = new St.Button({
        style_class: 'gf-launcher',
        // Tracked: the veil and the title are painted from `:hover`.
        can_focus: true,
        track_hover: true,
        accessible_name: section.title,
        y_align: Clutter.ActorAlign.START,
    });

    const box = new St.BoxLayout({vertical: true, width: size});
    const card = new St.Widget({
        style_class: 'gf-launcher-card',
        width: size,
        height: size,
        layout_manager: new Clutter.BinLayout(),
        x_expand: false,
        y_expand: false,
        style: radiusStyle('launcher'),
    });
    // The artwork is a layer of its own: St shadows an image-backed widget as
    // a square box, so the card that casts the shadow must not carry the image.
    if (art)
        card.add_child(new St.Widget({style: artworkStyle(art, 'launcher'), x_expand: true, y_expand: true}));
    // The veil tints the artwork towards the accent so the icon always reads;
    // without artwork it is simply the card's colour.
    card.add_child(new St.Widget({
        style_class: art ? 'gf-launcher-veil' : 'gf-launcher-veil gf-launcher-veil-plain',
        style: radiusStyle('launcher'),
        x_expand: true,
        y_expand: true,
    }));
    card.add_child(new St.Icon({
        icon_name: section.icon,
        icon_size: Math.round(size * 0.36),
        style_class: 'gf-launcher-icon',
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
        y_expand: true,
    }));
    box.add_child(card);

    box.add_child(new St.Label({text: section.title, style_class: 'gf-launcher-title', x_align: Clutter.ActorAlign.CENTER}));
    box.add_child(new St.Label({
        text: count ? `${count} ${count === 1 ? 'item' : 'items'}` : 'Nothing indexed yet',
        style_class: 'gf-launcher-subtitle',
        x_align: Clutter.ActorAlign.CENTER,
    }));
    const dot = new St.Widget({style_class: 'gf-launcher-dot', x_align: Clutter.ActorAlign.CENTER, opacity: 0});
    box.add_child(dot);
    launcher.set_child(box);

    addHoverScale(launcher, {lift: HOVER_LIFT, tracked: true});
    launcher.connect('clicked', () => onActivate?.());

    // Faded rather than hidden, so opening a section never shifts the row.
    launcher.setOpen = open => dot.ease({opacity: open ? 255 : 0, duration: Duration.FAST, mode: Ease.OUT});
    return launcher;
}

// A circular icon button, the shape GNOME uses for back/close in header bars.
export function createIconButton(iconName, {styleClass = 'gf-icon-button', iconSize = 16, accessibleName} = {}) {
    return new St.Button({
        style_class: styleClass,
        reactive: true,
        can_focus: true,
        track_hover: true,
        accessible_name: accessibleName,
        child: new St.Icon({icon_name: iconName, icon_size: iconSize}),
    });
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

// The way back to the home menu, which takes the section switcher's place in
// the header when sections are opened from there.
export function createHomeButton() {
    const button = createActionButton({
        label: 'Home',
        icon: 'go-home-symbolic',
        styleClass: 'gf-action gf-action-secondary',
    });
    button.y_align = Clutter.ActorAlign.CENTER;
    return button;
}

// A small rounded label: a fact in the detail pane, a badge on a row. The class
// is not optional — there is no bare `gf-pill` rule for one to fall back to.
export function createPill(text, styleClass, style = null) {
    return new St.Label({text, style_class: styleClass, style, y_align: Clutter.ActorAlign.CENTER});
}

// One entry in a detail list: numbered circle, title/subtitle, badges, size and
// a play glyph. Hover is a single background change on the row itself — nothing
// inside it restyles, so one pointer crossing is one repaint rather than four.
export function createRow({index, title, subtitle, badges = [], size, icon = 'media-playback-start-symbolic', onActivate}) {
    const row = new St.Button({
        style_class: 'gf-row',
        reactive: true,
        can_focus: true,
        track_hover: true,
        x_expand: true,
        style: radiusStyle(),
    });
    const content = new St.BoxLayout({x_expand: true, y_align: Clutter.ActorAlign.CENTER});

    content.add_child(new St.Label({
        text: String(index),
        style_class: 'gf-row-index',
        y_align: Clutter.ActorAlign.CENTER,
    }));

    const titleLabel = createLabel(title, 'gf-row-title', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    if (subtitle) {
        const text = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'gf-row-text'});
        text.add_child(titleLabel);
        text.add_child(createLabel(subtitle, 'gf-row-subtitle'));
        content.add_child(text);
    } else {
        // One line needs no column to stack in; it takes the column's margins.
        titleLabel.add_style_class_name('gf-row-text');
        content.add_child(titleLabel);
    }

    for (const badge of badges)
        content.add_child(createPill(badge, 'gf-badge', radiusStyle('badge')));
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
        can_focus: true,
        width: size,
        height: size,
        style: path ? artworkStyle(path) : radiusStyle(),
    });
    addHoverScale(button);
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
