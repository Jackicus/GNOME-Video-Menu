import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export default class GnomeflixPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'Gnomeflix Settings',
            icon_name: 'video-display-symbolic'
        });
        window.add(page);

        // Group 1: Media Sources
        const sourcesGroup = new Adw.PreferencesGroup({
            title: 'Media Sources',
            description: 'Configure your video and media collection directories'
        });
        page.add(sourcesGroup);

        // TV Shows Path entry
        const tvShowsRow = new Adw.EntryRow({
            title: 'TV Shows Directory',
            text: settings.get_string('tv-shows-path')
        });
        tvShowsRow.connect('changed', () => {
            settings.set_string('tv-shows-path', tvShowsRow.get_text());
        });
        sourcesGroup.add(tvShowsRow);

        // Films Path entry
        const filmsRow = new Adw.EntryRow({
            title: 'Films Directory',
            text: settings.get_string('films-path')
        });
        filmsRow.connect('changed', () => {
            settings.set_string('films-path', filmsRow.get_text());
        });
        sourcesGroup.add(filmsRow);

        // Rescan Library Action Row
        const scanRow = new Adw.ActionRow({
            title: 'Library Scanning',
            subtitle: 'Index TV show directories and download poster artwork'
        });

        const scanBtn = new Adw.ButtonContent({
            label: 'Rescan Library Now',
            icon_name: 'view-refresh-symbolic'
        });
        const button = new Gtk.Button({
            child: scanBtn,
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action']
        });
        button.connect('clicked', () => {
            button.set_sensitive(false);
            scanBtn.set_label('Scanning...');

            // Resolve the scanner relative to this extension, wherever it is installed
            const scriptPath = GLib.build_filenamev([this.path, 'backend', 'scan_library.py']);
            const argv = ['python3', scriptPath];

            const tvPath = settings.get_string('tv-shows-path');
            if (tvPath)
                argv.push('--tv-path', tvPath);

            try {
                const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDERR_PIPE);
                proc.wait_check_async(null, (source, result) => {
                    button.set_sensitive(true);
                    try {
                        source.wait_check_finish(result);
                        scanBtn.set_label('Scan Complete ✓');
                    } catch (e) {
                        console.error(`[Gnomeflix] Library scan failed: ${e.message}`);
                        scanBtn.set_label('Scan Failed');
                    }
                });
            } catch (e) {
                console.error(`[Gnomeflix] Could not launch ${scriptPath}: ${e.message}`);
                button.set_sensitive(true);
                scanBtn.set_label('Scan Failed');
            }
        });
        scanRow.add_suffix(button);
        sourcesGroup.add(scanRow);

        // Group 2: Desktop Display
        const displayGroup = new Adw.PreferencesGroup({
            title: 'Desktop Placement',
            description: 'Configure which workspace displays the Gnomeflix dashboard'
        });
        page.add(displayGroup);

        const wsRow = new Adw.SpinRow({
            title: 'Target Workspace',
            subtitle: 'Workspace index (1 for first workspace, 2 for second, etc.)',
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 10,
                step_increment: 1,
                value: settings.get_int('workspace-index') + 1
            })
        });
        wsRow.connect('changed', () => {
            settings.set_int('workspace-index', Math.round(wsRow.get_value()) - 1);
        });
        displayGroup.add(wsRow);

        const colRow = new Adw.SpinRow({
            title: 'Columns on Desktop',
            subtitle: 'Minimum covers per row — fewer means larger covers. A wide screen may fit more.',
            adjustment: new Gtk.Adjustment({
                lower: 3,
                upper: 12,
                step_increment: 1,
                value: settings.get_int('columns')
            })
        });
        colRow.connect('changed', () => {
            settings.set_int('columns', Math.round(colRow.get_value()));
        });
        displayGroup.add(colRow);
    }
}
