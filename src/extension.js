import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

export default class GnomeflixExtension extends Extension {
    async enable() {
        console.log('[Gnomeflix] Enabling extension via dynamic loader...');
        try {
            // Dynamic cache-busting import ensures code updates hot-reload on disable/enable
            const moduleUrl = `${this.dir.get_uri()}/lib/mediaWorkspace.js?v=${Date.now()}`;
            const module = await import(moduleUrl);
            this._app = new module.GnomeflixApp(this);
            this._app.enable();
            console.log('[Gnomeflix] Extension loaded successfully via dynamic module!');
        } catch (e) {
            console.error('[Gnomeflix] Failed to load lib/mediaWorkspace.js:', e);
        }
    }

    disable() {
        console.log('[Gnomeflix] Disabling extension via dynamic loader...');
        if (this._app) {
            try {
                this._app.disable();
            } catch (e) {
                console.error('[Gnomeflix] Error during disable:', e);
            }
            this._app = null;
        }
    }
}
