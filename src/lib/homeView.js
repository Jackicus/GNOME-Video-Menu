// The home menu: one large launcher per enabled section, centred on the Home
// workspace. It is the only thing Gnomeflix keeps open; a section's workspace
// exists from the moment its launcher is clicked.

import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {staggerIn} from './anim.js';
import {createEmptyState, createIconButton, createLauncher} from './widgets.js';

// The name of the launcher's own workspace wherever a workspace is mapped to
// what it shows.
export const HOME = 'home';

const GAP = 32;                // between launchers, both ways
const MIN_LAUNCHER = 120;
const MAX_LAUNCHER = 208;
// Title, subtitle and open dot beneath a launcher's card.
const LAUNCHER_CHROME = 64;
// The heading above the launchers and the space beneath it.
const HEADING_ALLOWANCE = 120;

export class HomeView {
    constructor({sections, itemsFor, onActivate, onOpenSettings}) {
        this._sections = sections;
        this._itemsFor = itemsFor;
        this._onActivate = onActivate;
        this._onOpenSettings = onOpenSettings;
        this._launchers = new Map();
        this._width = 0;
        this._height = 0;

        this.actor = new St.Widget({
            style_class: 'gf-home',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
    }

    destroy() {
        this.actor.destroy();
        this._launchers.clear();
    }

    setSize(width, height) {
        this._width = width;
        this._height = height;
    }

    // Mark the sections whose workspaces are open, like a running app's dot.
    setOpened(keys) {
        const opened = new Set(keys);
        for (const [key, launcher] of this._launchers)
            launcher.setOpen(opened.has(key));
    }

    reveal() {
        staggerIn([...this._launchers.values()], {step: 30});
    }

    // As many launchers per row as fit at a comfortable size, as few rows as
    // that allows, and every row centred.
    _metrics(count) {
        const perRowMax = Math.max(1, Math.floor((this._width + GAP) / (MIN_LAUNCHER + GAP)));
        const rows = Math.ceil(count / perRowMax);
        const perRow = Math.ceil(count / rows);
        const fitW = Math.floor((this._width - GAP * (perRow - 1)) / perRow);
        const fitH = Math.floor((this._height - HEADING_ALLOWANCE - GAP * (rows - 1)) / rows) - LAUNCHER_CHROME;
        const size = Math.max(MIN_LAUNCHER, Math.min(MAX_LAUNCHER, fitW, fitH));
        return {perRow, size};
    }

    build(openedKeys = []) {
        this.actor.destroy_all_children();
        this._launchers.clear();

        if (!this._sections.length) {
            this.actor.add_child(createEmptyState({
                icon: 'folder-videos-symbolic',
                title: 'Nothing to show yet',
                hint: 'Turn on a section and point it at a folder in Settings.',
                actionLabel: 'Open Settings',
                onAction: this._onOpenSettings,
            }));
            return;
        }

        const column = new St.BoxLayout({
            vertical: true,
            style_class: 'gf-home-column',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        column.add_child(new St.Label({text: 'Gnomeflix', style_class: 'gf-home-title', x_align: Clutter.ActorAlign.CENTER}));
        column.add_child(new St.Label({
            text: 'Choose a library to open',
            style_class: 'gf-home-subtitle',
            x_align: Clutter.ActorAlign.CENTER,
        }));

        const {perRow, size} = this._metrics(this._sections.length);
        let row = null;
        this._sections.forEach((section, i) => {
            if (i % perRow === 0) {
                row = new St.BoxLayout({
                    style: `spacing: ${GAP}px; margin-top: ${GAP}px;`,
                    x_align: Clutter.ActorAlign.CENTER,
                });
                column.add_child(row);
            }
            const items = this._itemsFor(section.key);
            const launcher = createLauncher({
                section,
                count: items.length,
                art: items.find(item => item.art)?.art ?? null,
                size,
                onActivate: () => this._onActivate?.(section.key),
            });
            this._launchers.set(section.key, launcher);
            row.add_child(launcher);
        });
        this.actor.add_child(column);

        const settings = createIconButton('preferences-system-symbolic', {accessibleName: 'Settings'});
        settings.x_align = Clutter.ActorAlign.END;
        settings.y_align = Clutter.ActorAlign.START;
        settings.x_expand = settings.y_expand = true;
        settings.connect('clicked', () => this._onOpenSettings?.());
        this.actor.add_child(settings);

        this.setOpened(openedKeys);
    }
}
