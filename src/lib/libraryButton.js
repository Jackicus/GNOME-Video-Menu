// The library's button beside Show Apps: the one way in, wherever the library
// opens.
//
// The button is the shell's own `ShowAppsIcon` — a DashItemContainer around a
// `show-apps` toggle with a BaseIcon in it — subclassed for its icon and its
// label, so hover, focus, the tooltip and the dash's sizing all come from the
// dash (js/ui/dash.js:188-218). It sits in the dash, or in Dash to Panel's
// panel when that has taken the dash away.
//
// What a press means is the caller's (`onActivate`), and so is whether the
// button is lit (`sync`); everything else about it is here.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Dash from 'resource:///org/gnome/shell/ui/dash.js';

import {LIBRARY} from './library.js';

// Show Apps with our icon and our tooltip, and nothing to drop on it.
const LibraryIcon = GObject.registerClass(
class MediaLibrariesLibraryIcon extends Dash.ShowAppsIcon {
    _init() {
        super._init();
        this.setLabelText(LIBRARY.title);
    }

    _createIcon(size) {
        this._iconActor = new St.Icon({
            icon_name: LIBRARY.icon,
            icon_size: size,
            style_class: 'show-apps-icon',
            track_hover: true,
        });
        return this._iconActor;
    }

    // Show Apps doubles as the dash's unpin target; the library is not one.
    _canRemoveApp() {
        return false;
    }
});

export class LibraryButton {
    constructor({onActivate}) {
        this._onActivate = onActivate;
        this._button = null;
        this._buttonHost = null;
        this._dashToPanel = null;
        // Whether it is lit, kept so a re-attach lights it again.
        this._checked = false;
        this._attached = false;
    }

    // Put beside Show Apps, and kept there — across Dash to Panel rebuilding
    // its panels — until `detach`. Attaching what is attached does nothing.
    attach() {
        if (this._attached)
            return;
        this._attached = true;
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
        this._attached = false;
        Main.extensionManager.disconnectObject(this);
        this._dashToPanel?.disconnectObject?.(this);
        this._dashToPanel = null;
        this._detach();
    }

    // The button's icon, for a panel that wants to zoom out of it — or null
    // while it is not on screen (the dash is the overview's, and a shortcut
    // can be pressed on the desktop), which leaves nothing to zoom out of.
    get icon() {
        const icon = this._button?.icon;
        return icon?.mapped ? icon : null;
    }

    sync(checked) {
        this._checked = !!checked;
        this._buttonHost?.sync?.();
        if (this._button)
            this._button.toggleButton.checked = this._checked;
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
            console.warn(`[Media Libraries] No button beside Show Apps: ${e}`);
            this._detach();
        }
        this.sync(this._checked);
    }

    _detach() {
        const host = this._buttonHost;
        this._buttonHost = null;
        host?.release();
        this._button = null;
    }

    _newButton() {
        const container = new LibraryIcon();
        container.show(false);
        container.toggleButton.connect('clicked', () => this._onActivate());
        return container;
    }

    _attachToDash(dash) {
        const container = this._button = this._newButton();
        container.icon.setIconSize(dash.iconSize);
        dash._hookUpLabel?.(container);
        dash._dashContainer.add_child(container);
        dash.connectObject('icon-size-changed',
            () => container.icon.setIconSize(dash.iconSize), this);
        this._buttonHost = {
            release: () => {
                try {
                    dash.disconnectObject(this);
                    container.destroy();
                } catch {
                    // The dash is on its way out.
                }
            },
        };
    }

    // Dash to Panel lays out only the elements it knows, in groups it works
    // out from its settings. Ours is one more element, put into the group
    // Show Apps is in, straight after it, each time the groups are made.
    //
    // By wrapping the panel's own `_updateGroupedElements` — which another
    // extension can wrap as well (Games Menu puts its button there the same
    // way), so the wrap is taken off only while it is still the outermost,
    // and what was there before is put back rather than deleted. Wrapped over
    // since, it is left in place and goes inert instead: taking it out would
    // take the other one's with it.
    _attachToPanel(panel) {
        const showApps = panel.showAppsIconWrapper.realShowAppsIcon;
        const box = new St.BoxLayout({
            orientation: panel.geom?.vertical
                ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL,
        });
        const container = this._button = this._newButton();
        container.icon.setIconSize(showApps.icon.iconSize);
        const style = showApps.toggleButton.get_style();
        if (style)
            container.toggleButton.set_style(style);
        container.toggleButton.connect('notify::hover', button => {
            if (button.hover)
                container.showLabel();
            else
                container.hideLabel();
        });
        box.add_child(container);

        // The way out is in place before anything is put into the panel, so
        // a throw part-way through still has it to call.
        let released = false;
        box.connect('destroy', () => (released = true));
        const element = {actor: box, box: new Clutter.ActorBox()};
        const hadOwn = Object.hasOwn(panel, '_updateGroupedElements');
        const stock = panel._updateGroupedElements;
        let inert = false;
        const wrapped = function (positions) {
            stock.call(this, positions);
            if (inert)
                return;
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
        this._buttonHost = {
            // The panel sizes its icons after it is made, and again as it fills.
            sync: () => {
                container.icon.setIconSize(showApps.icon.iconSize);
                container.toggleButton.set_style(showApps.toggleButton.get_style());
            },
            release: () => {
                inert = true;
                if (panel._updateGroupedElements === wrapped) {
                    if (hadOwn)
                        panel._updateGroupedElements = stock;
                    else
                        delete panel._updateGroupedElements;
                }
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
        panel._updateGroupedElements = wrapped;
        panel.updateElementPositions?.();
    }
}
