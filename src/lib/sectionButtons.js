// A button per section beside Show Apps, and the two places it can go.
//
// The button is the shell's own `ShowAppsIcon` — a DashItemContainer around a
// `show-apps` toggle with a BaseIcon in it — subclassed for its icon and its
// label, so hover, focus, the tooltip and the dash's sizing all come from the
// dash (js/ui/dash.js:188-218). It sits in the dash, or in Dash to Panel's
// panel when that has taken the dash away.
//
// Both libraries browsed outside the surface are opened from these: the "menu"
// library puts a grid in the overview's app-grid slot, the "modal" library pops
// a panel out of the button
// itself. The view says what a press means (`onActivate`) and which button is
// lit (`sync`); everything else about them is here.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Dash from 'resource:///org/gnome/shell/ui/dash.js';

// Show Apps with our icon and our tooltip, and nothing to drop on it.
const SectionIcon = GObject.registerClass(
class MediaLibrariesSectionIcon extends Dash.ShowAppsIcon {
    _init(section) {
        // Read by _createIcon, which the BaseIcon super._init() builds calls
        // straight away — so it is set before the chain-up, as the shell sets
        // _iconActor before setDragApp() reads it.
        this._section = section;
        super._init();
        this.setLabelText(section.title);
    }

    _createIcon(size) {
        this._iconActor = new St.Icon({
            icon_name: this._section.icon,
            icon_size: size,
            style_class: 'show-apps-icon',
            track_hover: true,
        });
        return this._iconActor;
    }

    // Show Apps doubles as the dash's unpin target; a section is not one.
    _canRemoveApp() {
        return false;
    }
});

export class SectionButtons {
    constructor({sections, onActivate}) {
        this._sections = sections;
        this._onActivate = onActivate;
        this._buttons = new Map();
        this._buttonHost = null;
        this._dashToPanel = null;
        // Which section is lit, kept so a re-attach lights it again.
        this._checked = null;
    }

    attach() {
        // Dash to Panel builds its panels when it is enabled and again when
        // its settings change, either of which can come after this.
        Main.extensionManager.connectObject('extension-state-changed',
            () => this._reattach(), this);
        // It also rebuilds them on monitors-changed, which no extension state
        // reflects, and says so with `panels-created` on its own emitter.
        this._armDashToPanel();
        this._attach();
    }

    detach() {
        Main.extensionManager.disconnectObject(this);
        this._dashToPanel?.disconnectObject?.(this);
        this._dashToPanel = null;
        this._detach();
    }

    // The section's button, for a view that wants to grow out of it.
    buttonFor(key) {
        return this._buttons.get(key) ?? null;
    }

    sync(checkedKey) {
        this._checked = checkedKey ?? null;
        this._buttonHost?.sync?.();
        for (const [key, container] of this._buttons)
            container.toggleButton.checked = key === checkedKey;
    }

    // ------------------------------------------------------------------

    _armDashToPanel() {
        const dashToPanel = global.dashToPanel;
        if (!dashToPanel || dashToPanel === this._dashToPanel)
            return;
        this._dashToPanel?.disconnectObject?.(this);
        this._dashToPanel = dashToPanel;
        dashToPanel.connectObject?.('panels-created', () => this._reattach(), this);
    }

    _reattach() {
        // Dash to Panel may only have appeared since we last looked.
        this._armDashToPanel();
        this._attach();
    }

    _attach() {
        this._detach();
        // The primary panel only: a button per panel would make the host's
        // release a list, and is not done.
        const panel = global.dashToPanel?.panels?.[0];
        try {
            if (panel?.showAppsIconWrapper && panel.panel && panel._updateGroupedElements)
                this._attachToPanel(panel);
            else if (Main.overview.dash?._dashContainer)
                this._attachToDash(Main.overview.dash);
        } catch (e) {
            console.warn(`[Media Libraries] No buttons beside Show Apps: ${e}`);
            this._detach();
        }
        this.sync(this._checked);
    }

    _detach() {
        const host = this._buttonHost;
        this._buttonHost = null;
        host?.release();
        this._buttons.clear();
    }

    _attachToDash(dash) {
        for (const section of this._sections) {
            const container = new SectionIcon(section);
            container.icon.setIconSize(dash.iconSize);
            container.show(false);
            container.toggleButton.connect('clicked', () => this._onActivate(section.key));
            dash._hookUpLabel?.(container);
            dash._dashContainer.add_child(container);
            this._buttons.set(section.key, container);
        }
        dash.connectObject('icon-size-changed', () => {
            for (const container of this._buttons.values())
                container.icon.setIconSize(dash.iconSize);
        }, this);
        const containers = [...this._buttons.values()];
        this._buttonHost = {
            release: () => {
                try {
                    dash.disconnectObject(this);
                    containers.forEach(c => c.destroy());
                } catch {
                    // The dash is on its way out.
                }
            },
        };
    }

    // Dash to Panel lays out only the elements it knows, in groups it works
    // out from its settings. Ours is one more element, put into the group
    // Show Apps is in, straight after it, each time the groups are made.
    _attachToPanel(panel) {
        const showApps = panel.showAppsIconWrapper.realShowAppsIcon;
        const box = new St.BoxLayout({
            orientation: panel.geom?.vertical
                ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL,
        });
        for (const section of this._sections) {
            const container = new SectionIcon(section);
            container.icon.setIconSize(showApps.icon.iconSize);
            const style = showApps.toggleButton.get_style();
            if (style)
                container.toggleButton.set_style(style);
            container.show(false);
            container.toggleButton.connect('clicked', () => this._onActivate(section.key));
            container.toggleButton.connect('notify::hover', button => {
                if (button.hover)
                    container.showLabel();
                else
                    container.hideLabel();
            });
            box.add_child(container);
            this._buttons.set(section.key, container);
        }
        // The way out is in place before anything is put into the panel, so
        // a throw part-way through still has it to call.
        let released = false;
        box.connect('destroy', () => (released = true));
        this._buttonHost = {
            // The panel sizes its icons after it is made, and again as it fills.
            sync: () => {
                for (const container of this._buttons.values()) {
                    container.icon.setIconSize(showApps.icon.iconSize);
                    container.toggleButton.set_style(showApps.toggleButton.get_style());
                }
            },
            release: () => {
                delete panel._updateGroupedElements;
                if (!released)
                    box.destroy();
                try {
                    panel.updateElementPositions?.();
                } catch {
                    // The panel itself is on its way out.
                }
            },
        };

        panel.panel.add_child(box);

        const element = {actor: box, box: new Clutter.ActorBox()};
        const stock = panel._updateGroupedElements;
        panel._updateGroupedElements = function (positions) {
            stock.call(this, positions);
            for (const group of this._elementGroups ?? []) {
                const at = group.elements.findIndex(e => e.actor === showApps);
                if (at < 0)
                    continue;
                element.position = group.elements[at].position;
                group.elements.splice(at + 1, 0, element);
                if (group.expandableIndex > at)
                    group.expandableIndex++;
                break;
            }
            box.visible = showApps.visible;
        };
        panel.updateElementPositions?.();
    }
}
