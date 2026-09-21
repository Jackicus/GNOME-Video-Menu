// Small St building blocks shared by the views. Everything paints through the
// stylesheet (ml-* classes); JS only sets sizes and wires behaviour.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

import {Duration, Ease, fadeTo} from './anim.js';
import {radiusStyle} from './shape.js';

// St bakes the corner radius into the artwork only when it renders the
// background image itself, so the radius has to travel in the same inline
// style as the image rather than being left to the stylesheet.
export function artworkStyle(path, part = 'art') {
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
export function createArtwork({path, title, icon, width, height, styleClass = 'ml-art', radius = 'art'}) {
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
    art.add_style_class_name('ml-art-placeholder');
    const stack = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
        y_expand: true,
        clip_to_allocation: true,
        style_class: 'ml-art-placeholder-content',
    });
    // `width` is physical pixels but `icon_size` is logical, so the share of
    // the artwork the icon takes is divided back down (iconGrid.js:143-147).
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    stack.add_child(new St.Icon({
        icon_name: icon,
        icon_size: Math.max(24, Math.round(width * 0.22 / scale)),
        style_class: 'ml-art-placeholder-icon',
        x_align: Clutter.ActorAlign.CENTER,
    }));
    if (title && width >= 120) {
        const label = new St.Label({
            text: title,
            style_class: 'ml-art-placeholder-title',
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

// A home-menu launcher: a large rounded card carrying the section's icon over
// a wash of its own artwork, with the title and item count beneath and a dot
// that lights while the section's workspace is open, like a running app's.
//
// The button itself is the shell's raised folder tile (`app-folder`), so the
// normal, hover, focus and pressed states — and the padding around the card —
// are the theme's (`_drawing.scss` tile_button($raised: true)).
export function createLauncher({section, count, art, size, onActivate}) {
    const launcher = new St.Button({
        style_class: 'app-folder',
        // Tracked: the theme paints the tile itself from `:hover`.
        can_focus: true,
        track_hover: true,
        accessible_name: section.title,
        y_align: Clutter.ActorAlign.START,
        style: radiusStyle('launcher'),
    });

    const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, width: size});
    const card = new St.Widget({
        style_class: 'ml-launcher-card',
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
        style_class: art ? 'ml-launcher-veil' : 'ml-launcher-veil ml-launcher-veil-plain',
        style: radiusStyle('launcher'),
        x_expand: true,
        y_expand: true,
    }));
    // `size` is physical pixels, `icon_size` logical.
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    card.add_child(new St.Icon({
        icon_name: section.icon,
        icon_size: Math.round(size * 0.36 / scale),
        style_class: 'ml-launcher-icon',
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
        y_expand: true,
    }));
    box.add_child(card);

    box.add_child(new St.Label({text: section.title, style_class: 'ml-launcher-title', x_align: Clutter.ActorAlign.CENTER}));
    box.add_child(new St.Label({
        text: count ? `${count} ${count === 1 ? 'item' : 'items'}` : 'Nothing indexed yet',
        style_class: 'ml-launcher-subtitle',
        x_align: Clutter.ActorAlign.CENTER,
    }));
    // The shell's own running dot, down to the way it is offset: `offset-y` is
    // a length the theme sets and the app icon reads back as a translation
    // (appDisplay.js:2998-3001), so it never takes part in the layout.
    const dot = new St.Widget({style_class: 'app-grid-running-dot', x_align: Clutter.ActorAlign.CENTER, opacity: 0});
    dot.connect('style-changed', () => (dot.translation_y = dot.get_theme_node().get_length('offset-y')));
    box.add_child(dot);
    launcher.set_child(box);

    launcher.connect('clicked', () => onActivate?.());

    // Faded rather than hidden, so opening a section never shifts the row.
    launcher.setOpen = open => dot.ease({opacity: open ? 255 : 0, duration: Duration.FAST, mode: Ease.OUT});
    return launcher;
}

// The shell's own round icon button — the shape it uses for a message's close
// button and the folder dialog's edit button — so the hover, focus ring and
// pressed state are the theme's rather than ours. No `St.Icon` child and no
// size: `.icon-button StIcon { icon-size }` sizes the glyph in em, so it
// follows Large Text, exactly as `appDisplay.js:2574-2582` builds it.
export function createIconButton(iconName, {styleClass = 'icon-button', accessibleName} = {}) {
    return new St.Button({
        style_class: styleClass,
        reactive: true,
        can_focus: true,
        track_hover: true,
        accessible_name: accessibleName,
        icon_name: iconName,
    });
}

// A primary action: the shell's own `button.default`, which brings the accent
// fill along with the hover, focus and pressed states; only the pill shape is
// ours. `ml-action-secondary` is the theme's plain button.
export function createActionButton({label, icon, styleClass = 'button default ml-action'}) {
    const content = new St.BoxLayout({style_class: 'ml-action-content', y_align: Clutter.ActorAlign.CENTER});
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

// The way back to the home menu, in the section header.
function createHomeButton() {
    const button = createActionButton({
        label: 'Home',
        icon: 'go-home-symbolic',
        styleClass: 'button ml-action-secondary',
    });
    button.y_align = Clutter.ActorAlign.CENTER;
    return button;
}

// Swap a label's text under a cross-fade, so the header reads as one thing
// changing rather than two labels being replaced.
function crossFade(label, text) {
    label.remove_all_transitions();
    label.ease({
        opacity: 0,
        duration: Duration.FAST / 2,
        mode: Ease.OUT,
        onComplete: () => {
            label.text = text;
            label.ease({opacity: 255, duration: Duration.FAST, mode: Ease.OUT});
        },
    });
}

// A section's name over its count. On its own it is the whole header of a
// surface that needs no buttons beside it — the modal library's panel, where the
// way out is the button it came from — and it is the middle of the one below.
export function createTitles(title = '', subtitle = '') {
    const actor = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        style_class: 'ml-header-titles',
        y_align: Clutter.ActorAlign.CENTER,
    });
    const titleLabel = new St.Label({style_class: 'ml-header-title', text: title});
    const subtitleLabel = new St.Label({style_class: 'ml-header-subtitle', text: subtitle});
    actor.add_child(titleLabel);
    actor.add_child(subtitleLabel);
    return {actor, titleLabel, subtitleLabel};
}

// The bar above a section's library: a Back button that only appears once the
// detail pane is open, the section's title and count, and the way home. The
// two modes are the same widgets with different text and one button or the
// other showing, so nothing is rebuilt when the pane opens or closes.
export function createHeader({title, subtitle, onBack, onHome}) {
    const actor = new St.BoxLayout({style_class: 'ml-header', x_expand: true, y_align: Clutter.ActorAlign.CENTER});

    const back = createIconButton('go-previous-symbolic', {accessibleName: 'Back'});
    back.connect('clicked', () => onBack?.());
    back.hide();
    actor.add_child(back);

    const {actor: titles, titleLabel, subtitleLabel} = createTitles(title, subtitle);
    actor.add_child(titles);

    actor.add_child(new St.Widget({x_expand: true}));

    // The way back to the menu, which closes this section's workspace.
    const home = createHomeButton();
    home.connect('clicked', () => onHome?.());
    actor.add_child(home);

    // What the header says now. A header that serves one section is built with
    // it and never changes; the pane's own page has one header for every
    // section, and `setTitle` is how it is pointed at the current one.
    let heading = title;
    let librarySubtitle = subtitle;

    const setMode = (text, animate, appearing, leaving) => {
        if (animate) {
            crossFade(titleLabel, heading);
            crossFade(subtitleLabel, text);
            fadeTo(leaving, 0, {duration: Duration.FAST});
            fadeTo(appearing, 255);
            return;
        }
        titleLabel.text = heading;
        subtitleLabel.text = text;
        leaving.hide();
        appearing.show();
        appearing.opacity = 255;
    };

    return {
        actor,
        setLibraryMode: animate => setMode(librarySubtitle, animate, home, back),
        setDetailMode: animate => setMode('Back to library', animate, back, home),
        setTitle: (text, sub = '') => {
            heading = text;
            librarySubtitle = sub;
        },
    };
}

// A small rounded label: a fact in the detail pane, a badge on a row. The class
// is not optional — there is no bare `ml-pill` rule for one to fall back to.
export function createPill(text, styleClass, style = null) {
    return new St.Label({text, style_class: styleClass, style, y_align: Clutter.ActorAlign.CENTER});
}

// One entry in a detail list: numbered circle, title/subtitle, badges, size and
// a play glyph. Hover is a single background change on the row itself — nothing
// inside it restyles, so one pointer crossing is one repaint rather than four.
export function createRow({index, title, subtitle, badges = [], size, icon = 'media-playback-start-symbolic', onActivate}) {
    const row = new St.Button({
        // The theme's flat button: hover, focus and pressed come with it, and
        // the inline radius below overrides the one it brings.
        style_class: 'button flat ml-row',
        reactive: true,
        can_focus: true,
        track_hover: true,
        x_expand: true,
        style: radiusStyle(),
    });
    const content = new St.BoxLayout({x_expand: true, y_align: Clutter.ActorAlign.CENTER});

    // A disc with the number centred in it. A label given the disc's size
    // in CSS draws its text at the top, so the disc is a bin around it.
    content.add_child(new St.Bin({
        style_class: 'ml-row-index',
        y_align: Clutter.ActorAlign.CENTER,
        child: new St.Label({
            text: String(index),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        }),
    }));

    const titleLabel = createLabel(title, 'ml-row-title', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    if (subtitle) {
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'ml-row-text'});
        text.add_child(titleLabel);
        text.add_child(createLabel(subtitle, 'ml-row-subtitle'));
        content.add_child(text);
    } else {
        // One line needs no column to stack in; it takes the column's margins.
        titleLabel.add_style_class_name('ml-row-text');
        content.add_child(titleLabel);
    }

    for (const badge of badges)
        content.add_child(createPill(badge, 'ml-badge', radiusStyle('badge')));
    if (size)
        content.add_child(new St.Label({text: size, style_class: 'ml-row-size', y_align: Clutter.ActorAlign.CENTER}));

    content.add_child(new St.Icon({
        icon_name: icon,
        icon_size: 16,
        style_class: 'ml-row-icon',
        y_align: Clutter.ActorAlign.CENTER,
    }));

    row.set_child(content);
    row.connect('clicked', () => onActivate?.());
    return row;
}

// A square photo thumbnail for grid-layout groups: the grid's own tile with a
// photo in it, so the hover and the focus ring are the ones a poster has.
export function createThumb({path, size, accessibleName, onActivate}) {
    const button = new St.Button({
        style_class: 'overview-tile ml-thumb',
        can_focus: true,
        accessible_name: accessibleName,
        child: createArtwork({
            path,
            title: null,
            icon: 'image-x-generic-symbolic',
            width: size,
            height: size,
        }),
    });
    button.connect('clicked', () => onActivate?.());
    return button;
}

// Shown when a section has nothing in it.
export function createEmptyState({icon, title, hint, actionLabel, onAction}) {
    const box = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        style_class: 'ml-empty',
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
        y_expand: true,
    });
    box.add_child(new St.Icon({icon_name: icon, icon_size: 64, style_class: 'ml-empty-icon', x_align: Clutter.ActorAlign.CENTER}));
    box.add_child(new St.Label({text: title, style_class: 'ml-empty-title', x_align: Clutter.ActorAlign.CENTER}));
    box.add_child(new St.Label({text: hint, style_class: 'ml-empty-hint', x_align: Clutter.ActorAlign.CENTER}));
    if (actionLabel) {
        const button = createActionButton({label: actionLabel, icon: 'preferences-system-symbolic', styleClass: 'button ml-action-secondary'});
        button.x_align = Clutter.ActorAlign.CENTER;
        button.connect('clicked', () => onAction?.());
        box.add_child(button);
    }
    return box;
}
