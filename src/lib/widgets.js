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

// A poster: the image when there is one, otherwise a tinted placeholder built
// from the section icon and the title. Placeholders live in the stylesheet so
// they follow the system accent colour.
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
    // Room for a title, and the most it may take, in logical px against a
    // physical size.
    if (title && width >= 120 * scale) {
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
        label.height = Math.min(64 * scale, Math.round(height * 0.3));
        stack.add_child(label);
    }
    art.add_child(stack);
    return art;
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
    const text = new St.Label({text: label, y_align: Clutter.ActorAlign.CENTER});
    content.add_child(text);
    const button = new St.Button({
        style_class: styleClass,
        reactive: true,
        can_focus: true,
        track_hover: true,
        child: content,
    });
    // For a button whose words move on while it is up (Continue).
    button.setLabel = value => {
        text.text = value;
    };
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

// A section's name over a line beneath it: what the header says where there
// are no tabs to say it — an open item, a library of one section.
function createTitles(title = '', subtitle = '') {
    const actor = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        style_class: 'ml-header-titles',
        y_align: Clutter.ActorAlign.CENTER,
    });
    // One line each: a long title of a pick would otherwise run under the
    // buttons at the header's far end.
    const titleLabel = createLabel(title, 'ml-header-title');
    const subtitleLabel = createLabel(subtitle, 'ml-header-subtitle');
    actor.add_child(titleLabel);
    actor.add_child(subtitleLabel);
    return {actor, titleLabel, subtitleLabel};
}

// The switch between the libraries: a pill of buttons, one per section, one
// lit at a time — the shape of the shell's own screenshot/screencast switch
// (`.screenshot-ui-shot-cast-container`), with words in it. The keyboard
// landing on a tab chooses it, as tabs on a television do, so a remote's
// arrows alone go from one library to the other.
function createTabs(sections, active, onSwitch) {
    const actor = new St.BoxLayout({style_class: 'ml-tabs', y_align: Clutter.ActorAlign.CENTER});
    const tabs = new Map();
    const setActive = key => {
        for (const [k, tab] of tabs)
            tab.checked = k === key;
    };
    for (const section of sections) {
        const tab = new St.Button({
            style_class: 'ml-tab',
            label: section.title,
            can_focus: true,
            // Tracked: the tab paints its own `:hover`.
            track_hover: true,
        });
        const choose = () => {
            if (tab.checked)
                return;
            setActive(section.key);
            onSwitch?.(section.key);
        };
        tab.connect('clicked', choose);
        tab.connect('key-focus-in', choose);
        tabs.set(section.key, tab);
        actor.add_child(tab);
    }
    setActive(active);
    return {actor, setActive, lit: () => [...tabs.values()].find(tab => tab.checked) ?? null};
}

// The bar above a library: the tabs between its sections in the middle, a
// Back button at the start that shows only while an item is open, and at the
// far end whatever buttons the place it heads has room for (`end`). With
// fewer than two sections there is nothing to switch between, and the name
// stands where the tabs would. An open item puts its section's name in the
// tabs' place, over the way back; the two modes are the same widgets with one
// or the other showing, so nothing is rebuilt as the pane opens or closes.
//
// A bin rather than a row, so the tabs sit in the middle of the header however
// wide what is either side of them is. A bin places a child by its alignment
// only when the child expands; one that does not is centred, whatever it asks.
export function createHeader({sections, active, onSwitch, onBack = null, end = []}) {
    const actor = new St.Widget({
        style_class: 'ml-header',
        layout_manager: new Clutter.BinLayout(),
        x_expand: true,
    });

    const start = new St.BoxLayout({
        style_class: 'ml-header-start',
        x_expand: true,
        x_align: Clutter.ActorAlign.START,
        y_align: Clutter.ActorAlign.CENTER,
    });
    const back = createIconButton('go-previous-symbolic', {accessibleName: 'Back'});
    back.y_align = Clutter.ActorAlign.CENTER;
    back.connect('clicked', () => onBack?.());
    back.hide();
    start.add_child(back);
    const single = sections.length < 2;
    const name = single ? sections[0]?.title ?? '' : '';
    const {actor: titles, titleLabel, subtitleLabel} = createTitles(name);
    titles.visible = single;
    start.add_child(titles);
    actor.add_child(start);

    const tabs = single ? null : createTabs(sections, active, onSwitch);
    if (tabs) {
        tabs.actor.x_align = Clutter.ActorAlign.CENTER;
        actor.add_child(tabs.actor);
    }

    if (end.length) {
        const buttons = new St.BoxLayout({
            style_class: 'ml-header-end',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        for (const button of end) {
            button.y_align = Clutter.ActorAlign.CENTER;
            buttons.add_child(button);
        }
        actor.add_child(buttons);
    }

    const swap = (appearing, leaving, animate) => {
        for (const part of leaving) {
            if (animate) {
                fadeTo(part, 0, {duration: Duration.FAST});
            } else {
                part.remove_all_transitions();
                part.hide();
            }
        }
        for (const part of appearing) {
            if (animate) {
                fadeTo(part, 255);
            } else {
                part.remove_all_transitions();
                part.opacity = 255;
                part.show();
            }
        }
    };
    const say = (title, subtitle, animate) => {
        if (animate) {
            crossFade(titleLabel, title);
            crossFade(subtitleLabel, subtitle);
        } else {
            titleLabel.text = title;
            subtitleLabel.text = subtitle;
        }
    };

    return {
        actor,
        setActive: key => tabs?.setActive(key),
        // The lit tab takes the keyboard, for an arrow up out of the grid.
        focusTabs: () => {
            const tab = tabs?.lit();
            tab?.grab_key_focus();
            return !!tab;
        },
        setLibraryMode: (animate = false) => {
            if (tabs) {
                swap([tabs.actor], [back, titles], animate);
            } else {
                say(name, '', animate);
                swap([titles], [back], animate);
            }
        },
        setDetailMode: (title, animate = false) => {
            say(title, 'Back to library', animate);
            swap([back, titles], tabs ? [tabs.actor] : [], animate);
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
// `watched` is null for a row with nothing to track; true or false makes the
// disc a toggle of its own, showing a tick once watched, and `onWatched` is
// told each time it is flipped. Such a row also has `setWatched(watched)`,
// for a mark made somewhere else — by playing the file — to show on it.
export function createRow({index, title, subtitle, badges = [], size, onActivate, watched = null, onWatched}) {
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
    const number = new St.Label({
        text: String(index),
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
    });
    if (watched === null) {
        content.add_child(new St.Bin({
            style_class: 'ml-row-index',
            y_align: Clutter.ActorAlign.CENTER,
            child: number,
        }));
    } else {
        // A button inside the row's button: the press is the disc's alone,
        // so ticking an episode off does not also play it.
        const tick = new St.Icon({icon_name: 'object-select-symbolic', icon_size: 16});
        const face = new St.Widget({layout_manager: new Clutter.BinLayout()});
        face.add_child(number);
        face.add_child(tick);
        const disc = new St.Button({
            style_class: 'ml-row-index ml-row-watch',
            y_align: Clutter.ActorAlign.CENTER,
            toggle_mode: true,
            checked: watched,
            reactive: true,
            track_hover: true,
            accessible_name: 'Watched',
            child: face,
        });
        const sync = () => {
            number.visible = !disc.checked;
            tick.visible = disc.checked;
        };
        sync();
        disc.connect('clicked', () => {
            sync();
            onWatched?.(disc.checked);
        });
        row.setWatched = value => {
            disc.checked = value;
            sync();
        };
        // The disc from the keyboard: it sits inside the row's button, and
        // St's focus stops at the row, so a remote or a controller reaches it
        // through the row that has the focus (controls.js, Mark watched).
        row.toggleWatched = () => {
            disc.checked = !disc.checked;
            sync();
            onWatched?.(disc.checked);
        };
        content.add_child(disc);
    }

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
        icon_name: 'media-playback-start-symbolic',
        icon_size: 16,
        style_class: 'ml-row-icon',
        y_align: Clutter.ActorAlign.CENTER,
    }));

    row.set_child(content);
    row.connect('clicked', () => onActivate?.());
    return row;
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
