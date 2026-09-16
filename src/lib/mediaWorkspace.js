import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';

export class GnomeflixApp {
    constructor(extension) {
        this._extension = extension;
        this._container = null;
        this._viewStack = null;
        this._libraryView = null;
        this._seasonsView = null;
        this._episodesView = null;
        this._currentShow = null;
        this._currentSeason = null;
        this._shows = [];
        this._wsChangeId = null;
        this._monitorsChangeId = null;
        this._settingsChangeId = null;
        this._isAnimating = false;

        try {
            this._settings = extension.getSettings();
        } catch (e) {
            console.warn('[Gnomeflix] Failed to getSettings, using defaults:', e);
            this._settings = null;
        }
    }

    enable() {
        console.log('[Gnomeflix] Enabling GnomeflixApp...');
        this._loadLibraryData();
        this._buildDesktopUI();

        // Listen for workspace switches
        this._wsChangeId = global.workspace_manager.connectObject(
            'active-workspace-changed',
            () => this._syncVisibility(),
            this
        );

        // Listen for monitor layout changes
        this._monitorsChangeId = Main.layoutManager.connectObject(
            'monitors-changed',
            () => this._relayout(),
            this
        );

        // Listen for preferences changes
        if (this._settings) {
            this._settingsChangeId = this._settings.connect('changed', () => {
                console.log('[Gnomeflix] Settings changed, rebuilding UI...');
                this._loadLibraryData();
                this._rebuildUI();
            });
        }

        this._syncVisibility();
        console.log('[Gnomeflix] GnomeflixApp enabled successfully!');
    }

    disable() {
        console.log('[Gnomeflix] Disabling GnomeflixApp...');
        if (this._wsChangeId) {
            global.workspace_manager.disconnectObject(this);
            this._wsChangeId = null;
        }

        if (this._monitorsChangeId) {
            Main.layoutManager.disconnectObject(this);
            this._monitorsChangeId = null;
        }

        if (this._settings && this._settingsChangeId) {
            this._settings.disconnect(this._settingsChangeId);
            this._settingsChangeId = null;
        }

        if (this._container) {
            this._container.destroy();
            this._container = null;
        }

        this._viewStack = null;
        this._libraryView = null;
        this._seasonsView = null;
        this._episodesView = null;
        this._shows = [];
        this._isAnimating = false;
    }

    _loadLibraryData() {
        const libPath = GLib.build_filenamev([
            GLib.get_user_cache_dir(),
            'gnomeflix',
            'library.json'
        ]);

        const file = Gio.File.new_for_path(libPath);
        if (file.query_exists(null)) {
            try {
                const [ok, contents] = GLib.file_get_contents(libPath);
                if (ok) {
                    const decoder = new TextDecoder('utf-8');
                    this._shows = JSON.parse(decoder.decode(contents));
                    console.log(`[Gnomeflix] Loaded ${this._shows.length} shows from ${libPath}`);
                }
            } catch (e) {
                console.error(`[Gnomeflix] Failed to parse library.json: ${e}`);
            }
        }

        if (!this._shows || this._shows.length === 0) {
            this._shows = [
                { id: 'solo_leveling', title: 'Solo Leveling', episode_count: 25, poster_path: '' },
                { id: 'frieren', title: "Frieren: Beyond Journey's End", episode_count: 10, poster_path: '' },
                { id: 'black_clover', title: 'Black Clover', episode_count: 141, poster_path: '' }
            ];
        }
    }

    _rebuildUI() {
        if (this._container) {
            this._container.destroy();
            this._container = null;
        }
        this._buildDesktopUI();
        this._syncVisibility();
    }

    _buildDesktopUI() {
        // Master container on desktop
        this._container = new St.BoxLayout({
            name: 'GnomeflixContainer',
            vertical: true,
            reactive: true,
            style_class: 'mwd-desktop-container',
            x_expand: true,
            y_expand: true,
        });

        // VIEW STACK with BinLayout: all views occupy the EXACT same bounds.
        // Neither view displaces or pushes another vertically!
        this._viewStack = new Clutter.Actor({
            layout_manager: new Clutter.BinLayout(),
            clip_to_allocation: true,
            x_expand: true,
            y_expand: true,
        });
        this._container.add_child(this._viewStack);

        // LEVEL 1: Library View (All Shows Grid)
        this._libraryView = this._createLibraryView();
        this._viewStack.add_child(this._libraryView);

        // LEVEL 2: Seasons View (Show Details + Seasons Cards)
        this._seasonsView = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
        });
        this._seasonsView.hide();
        this._viewStack.add_child(this._seasonsView);

        // LEVEL 3: Episodes View (Show Overview + Season Episodes)
        this._episodesView = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
        });
        this._episodesView.hide();
        this._viewStack.add_child(this._episodesView);

        // Add container to the desktop background layer
        if (Main.layoutManager._backgroundGroup) {
            Main.layoutManager._backgroundGroup.reactive = true;
            Main.layoutManager._backgroundGroup.add_child(this._container);
        } else {
            global.window_group.insert_child_at_index(this._container, 0);
        }

        this._relayout();
    }

    // =========================================================================
    // LEVEL 1: LIBRARY VIEW
    // =========================================================================
    _createLibraryView() {
        const view = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
        });

        // Header Row
        const headerRow = new St.BoxLayout({
            vertical: false,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'margin-bottom: 4px;',
        });

        const titleLabel = new St.Label({
            text: 'Gnomeflix • TV Shows',
            style_class: 'mwd-header-title',
        });
        headerRow.add_child(titleLabel);

        const badgeLabel = new St.Label({
            text: `${this._shows.length} Shows`,
            style_class: 'mwd-header-badge',
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerRow.add_child(badgeLabel);

        view.add_child(headerRow);

        const subtitleLabel = new St.Label({
            text: 'Workspace 1 • Native Desktop Surface • Click any cover to explore seasons',
            style_class: 'mwd-header-subtitle',
        });
        view.add_child(subtitleLabel);

        // ScrollView for Cover Grid
        const scrollView = new St.ScrollView({
            x_expand: true,
            y_expand: true,
            overlay_scrollbars: true,
            style: 'margin-top: 8px;',
        });
        scrollView.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);

        const gridBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
        });

        const columnsCount = this._settings ? this._settings.get_int('columns') || 6 : 6;
        let currentRow = null;

        this._shows.forEach((show, idx) => {
            if (idx % columnsCount === 0) {
                currentRow = new St.BoxLayout({
                    vertical: false,
                    x_align: Clutter.ActorAlign.START,
                    style: 'margin-bottom: 20px;',
                });
                gridBox.add_child(currentRow);
            }
            const card = this._createCoverCard(show);
            currentRow.add_child(card);
        });

        scrollView.set_child(gridBox);
        view.add_child(scrollView);

        return view;
    }

    _createCoverCard(show) {
        const cardBox = new St.BoxLayout({
            vertical: true,
            style_class: 'mwd-card-box',
            x_align: Clutter.ActorAlign.CENTER,
        });

        const posterBtn = new St.Button({
            style_class: 'mwd-cover-btn',
            width: 150,
            height: 225,
            reactive: true,
            can_focus: true,
            track_hover: true,
        });

        if (show.poster_path && GLib.file_test(show.poster_path, GLib.FileTest.EXISTS)) {
            posterBtn.set_style(`
                background-image: url("file://${encodeURI(show.poster_path)}");
                background-size: cover;
                background-position: center;
            `);
        }

        // Episode badge bottom right
        const epsBadge = new St.Label({
            text: `${show.episode_count || 0} Eps`,
            style_class: 'mwd-eps-badge',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.END,
            x_expand: true,
            y_expand: true,
        });
        posterBtn.set_child(epsBadge);

        // Clicking a cover animates to LEVEL 2 (Seasons View)
        posterBtn.connect('clicked', () => {
            if (this._isAnimating) return;
            this._navigateToSeasonsView(show);
        });

        cardBox.add_child(posterBtn);

        // Show title label
        const titleLabel = new St.Label({
            text: show.title,
            style_class: 'mwd-show-title',
            width: 150,
        });
        if (titleLabel.clutter_text) {
            titleLabel.clutter_text.single_line_mode = true;
            titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        }
        cardBox.add_child(titleLabel);

        return cardBox;
    }

    // =========================================================================
    // LEVEL 2: SEASONS VIEW
    // =========================================================================
    _navigateToSeasonsView(show) {
        this._currentShow = show;
        this._populateSeasonsView(show);
        this._transitionForward(this._libraryView, this._seasonsView);
    }

    _populateSeasonsView(show) {
        this._seasonsView.destroy_all_children();
        const seasonsMap = this._getSeasonsForShow(show);
        const seasonNames = Object.keys(seasonsMap);

        // 1. Navigation Top Bar: Back to Library
        const topBar = new St.BoxLayout({
            vertical: false,
            x_align: Clutter.ActorAlign.START,
            style: 'margin-bottom: 16px;',
        });

        const backBtn = new St.Button({
            label: '← Back to Library',
            style_class: 'mwd-back-btn',
            reactive: true,
            can_focus: true,
        });
        backBtn.connect('clicked', () => {
            if (this._isAnimating) return;
            this._transitionBackward(this._seasonsView, this._libraryView);
        });
        topBar.add_child(backBtn);
        this._seasonsView.add_child(topBar);

        // 2. Split Dashboard
        const splitBox = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            y_expand: true,
            style_class: 'mwd-split-dashboard',
        });

        // --- LEFT COLUMN: EXPANDED HERO COVER & INFO ---
        const leftCol = new St.BoxLayout({
            vertical: true,
            style_class: 'mwd-detail-left-col',
            width: 440,
            style: 'margin-right: 32px;',
        });

        // Big Cover with GNOME-style Expand Zoom Animation
        const bigCover = new St.Widget({
            width: 340,
            height: 510,
            style_class: 'mwd-detail-big-cover',
            x_align: Clutter.ActorAlign.CENTER,
            style: 'margin-bottom: 16px;',
        });
        bigCover.set_pivot_point(0.5, 0.5);

        if (show.poster_path && GLib.file_test(show.poster_path, GLib.FileTest.EXISTS)) {
            bigCover.set_style(`
                background-image: url("file://${encodeURI(show.poster_path)}");
                background-size: cover;
                background-position: center;
            `);
        }

        // Hero cover smooth GNOME expand animation:
        // Scales from 72% to 100% with cubic easing for natural depth
        bigCover.scale_x = 0.72;
        bigCover.scale_y = 0.72;
        bigCover.ease({
            scale_x: 1.0,
            scale_y: 1.0,
            duration: 320,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });

        leftCol.add_child(bigCover);

        // Show Title
        const titleLabel = new St.Label({
            text: show.title,
            style_class: 'mwd-detail-title',
        });
        leftCol.add_child(titleLabel);

        // Badges Row
        const badgeRow = new St.BoxLayout({
            vertical: false,
            style: 'margin-top: 8px; margin-bottom: 12px;',
        });
        badgeRow.add_child(new St.Label({
            text: `${show.episode_count || 0} Episodes`,
            style_class: 'mwd-header-badge',
        }));

        if (show.rating) {
            badgeRow.add_child(new St.Label({
                text: `★ ${show.rating}`,
                style_class: 'mwd-rating-badge',
            }));
        }

        if (show.genres && show.genres.length > 0) {
            badgeRow.add_child(new St.Label({
                text: show.genres.join(' • '),
                style_class: 'mwd-genre-badge',
            }));
        }
        leftCol.add_child(badgeRow);

        // Synopsis
        const summaryText = show.summary || `Episodes and media collection for ${show.title}.`;
        const summaryLabel = new St.Label({
            text: summaryText,
            style_class: 'mwd-detail-summary',
            width: 420,
        });
        if (summaryLabel.clutter_text) {
            summaryLabel.clutter_text.line_wrap = true;
            summaryLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD;
        }
        leftCol.add_child(summaryLabel);

        // Quick Play First Episode button
        if (show.episodes && show.episodes.length > 0) {
            const playFirstBtn = new St.Button({
                label: '▶ Play From Start (S01E01)',
                style_class: 'mwd-play-first-btn',
                reactive: true,
                can_focus: true,
                style: 'margin-top: 16px;',
            });
            playFirstBtn.connect('clicked', () => {
                this._playEpisode(show.episodes[0].path);
            });
            leftCol.add_child(playFirstBtn);
        }

        // Left column subtle glide
        leftCol.translation_y = 15;
        leftCol.ease({
            translation_y: 0,
            duration: 300,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        splitBox.add_child(leftCol);

        // --- RIGHT COLUMN: SEASONS GALLERY (CARDS) ---
        const rightCol = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
            style_class: 'mwd-detail-right-col',
        });

        // Header for seasons section
        const seasonsSectionHeader = new St.BoxLayout({
            vertical: false,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'margin-bottom: 8px;',
        });
        const headerText = new St.Label({
            text: 'Available Seasons & Collections',
            style_class: 'mwd-section-heading',
        });
        seasonsSectionHeader.add_child(headerText);
        seasonsSectionHeader.add_child(new St.Label({
            text: `${seasonNames.length} Seasons`,
            style_class: 'mwd-header-badge',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        rightCol.add_child(seasonsSectionHeader);

        const subPrompt = new St.Label({
            text: 'Select a season to view and play its episode collection:',
            style_class: 'mwd-header-subtitle',
            style: 'margin-bottom: 20px;',
        });
        rightCol.add_child(subPrompt);

        // ScrollView for Seasons
        const seasonsScrollView = new St.ScrollView({
            x_expand: true,
            y_expand: true,
            overlay_scrollbars: true,
        });
        seasonsScrollView.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);

        const seasonsListBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
        });

        // Render each Season as a prominent, clickable card
        seasonNames.forEach((seasonName, index) => {
            const eps = seasonsMap[seasonName];
            const seasonCard = this._createSeasonCard(show, seasonName, eps, index);
            seasonsListBox.add_child(seasonCard);
        });

        seasonsScrollView.set_child(seasonsListBox);
        rightCol.add_child(seasonsScrollView);

        // Right column slides in smoothly with cubic deceleration
        rightCol.translation_x = 40;
        rightCol.ease({
            translation_x: 0,
            duration: 320,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });

        splitBox.add_child(rightCol);
        this._seasonsView.add_child(splitBox);
    }

    _createSeasonCard(show, seasonName, episodes, index) {
        const cardBtn = new St.Button({
            style_class: 'mwd-season-card',
            reactive: true,
            can_focus: true,
            x_expand: true,
            track_hover: true,
        });

        const cardContent = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        // Season Icon / Number Badge
        const iconBadge = new St.Label({
            text: `S${index + 1}`,
            style_class: 'mwd-season-number-badge',
            y_align: Clutter.ActorAlign.CENTER,
        });
        cardContent.add_child(iconBadge);

        // Middle: Season Title & Info
        const infoCol = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style: 'margin-left: 16px;',
            y_align: Clutter.ActorAlign.CENTER,
        });

        const titleLabel = new St.Label({
            text: seasonName,
            style_class: 'mwd-season-card-title',
        });
        infoCol.add_child(titleLabel);

        const countSub = new St.Label({
            text: `${episodes.length} Episodes available • Click to view`,
            style_class: 'mwd-season-card-subtitle',
        });
        infoCol.add_child(countSub);

        cardContent.add_child(infoCol);

        // Right side: "View Episodes →" pill
        const viewArrow = new St.Label({
            text: 'View Episodes →',
            style_class: 'mwd-season-arrow-badge',
            y_align: Clutter.ActorAlign.CENTER,
        });
        cardContent.add_child(viewArrow);

        cardBtn.set_child(cardContent);

        // Clicking a season animates to LEVEL 3 (Episode List View)
        cardBtn.connect('clicked', () => {
            if (this._isAnimating) return;
            this._navigateToEpisodesView(show, seasonName, episodes);
        });

        return cardBtn;
    }

    // =========================================================================
    // LEVEL 3: EPISODE LIST VIEW
    // =========================================================================
    _navigateToEpisodesView(show, seasonName, episodes) {
        this._currentSeason = seasonName;
        this._populateEpisodesView(show, seasonName, episodes);
        this._transitionForward(this._seasonsView, this._episodesView);
    }

    _populateEpisodesView(show, seasonName, episodes) {
        this._episodesView.destroy_all_children();

        // 1. Navigation Top Bar: Back to Seasons
        const topBar = new St.BoxLayout({
            vertical: false,
            x_align: Clutter.ActorAlign.START,
            style: 'margin-bottom: 16px;',
        });

        const backBtn = new St.Button({
            label: `← Back to Seasons (${show.title})`,
            style_class: 'mwd-back-btn',
            reactive: true,
            can_focus: true,
        });
        backBtn.connect('clicked', () => {
            if (this._isAnimating) return;
            this._transitionBackward(this._episodesView, this._seasonsView);
        });
        topBar.add_child(backBtn);
        this._episodesView.add_child(topBar);

        // 2. Split Dashboard
        const splitBox = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            y_expand: true,
            style_class: 'mwd-split-dashboard',
        });

        // --- LEFT COLUMN: COVER & SEASON RECAP ---
        const leftCol = new St.BoxLayout({
            vertical: true,
            style_class: 'mwd-detail-left-col',
            width: 440,
            style: 'margin-right: 32px;',
        });

        const cover = new St.Widget({
            width: 340,
            height: 510,
            style_class: 'mwd-detail-big-cover',
            x_align: Clutter.ActorAlign.CENTER,
            style: 'margin-bottom: 16px;',
        });
        cover.set_pivot_point(0.5, 0.5);

        if (show.poster_path && GLib.file_test(show.poster_path, GLib.FileTest.EXISTS)) {
            cover.set_style(`
                background-image: url("file://${encodeURI(show.poster_path)}");
                background-size: cover;
                background-position: center;
            `);
        }

        cover.scale_x = 0.95;
        cover.scale_y = 0.95;
        cover.ease({
            scale_x: 1.0,
            scale_y: 1.0,
            duration: 280,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });

        leftCol.add_child(cover);

        const titleLabel = new St.Label({
            text: show.title,
            style_class: 'mwd-detail-title',
        });
        leftCol.add_child(titleLabel);

        const seasonHeaderBadge = new St.BoxLayout({
            vertical: false,
            style: 'margin-top: 8px; margin-bottom: 12px;',
        });
        seasonHeaderBadge.add_child(new St.Label({
            text: seasonName,
            style_class: 'mwd-season-active-pill',
        }));
        seasonHeaderBadge.add_child(new St.Label({
            text: `${episodes.length} Episodes`,
            style_class: 'mwd-header-badge',
        }));
        leftCol.add_child(seasonHeaderBadge);

        if (episodes && episodes.length > 0) {
            const playSeasonBtn = new St.Button({
                label: `▶ Play ${seasonName} from Start`,
                style_class: 'mwd-play-first-btn',
                reactive: true,
                can_focus: true,
                style: 'margin-top: 16px;',
            });
            playSeasonBtn.connect('clicked', () => {
                this._playEpisode(episodes[0].path);
            });
            leftCol.add_child(playSeasonBtn);
        }

        splitBox.add_child(leftCol);

        // --- RIGHT COLUMN: EPISODES DIRECTORY ---
        const rightCol = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
            style_class: 'mwd-detail-right-col',
        });

        const listHeader = new St.BoxLayout({
            vertical: false,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'margin-bottom: 16px;',
        });
        listHeader.add_child(new St.Label({
            text: `${seasonName} Episodes`,
            style_class: 'mwd-section-heading',
        }));
        rightCol.add_child(listHeader);

        const episodeListScroll = new St.ScrollView({
            x_expand: true,
            y_expand: true,
            overlay_scrollbars: true,
            style_class: 'mwd-episodes-scroll',
        });
        episodeListScroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);

        const episodeListBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
        });

        episodes.forEach(ep => {
            const row = new St.Button({
                style_class: 'mwd-episode-row',
                reactive: true,
                can_focus: true,
                x_expand: true,
            });

            const rowContent = new St.BoxLayout({
                vertical: false,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });

            const playIcon = new St.Label({
                text: '▶',
                style_class: 'mwd-ep-play-icon',
                y_align: Clutter.ActorAlign.CENTER,
            });
            rowContent.add_child(playIcon);

            const epTitle = new St.Label({
                text: ep.title,
                style_class: 'mwd-ep-title',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            if (epTitle.clutter_text) {
                epTitle.clutter_text.single_line_mode = true;
                epTitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            }
            rowContent.add_child(epTitle);

            if (ep.has_subtitles) {
                rowContent.add_child(new St.Label({
                    text: 'SUB',
                    style_class: 'mwd-sub-badge',
                    y_align: Clutter.ActorAlign.CENTER,
                }));
            }

            if (ep.size_mb) {
                rowContent.add_child(new St.Label({
                    text: `${ep.size_mb} MB`,
                    style_class: 'mwd-ep-size',
                    y_align: Clutter.ActorAlign.CENTER,
                }));
            }

            row.set_child(rowContent);
            row.connect('clicked', () => {
                this._playEpisode(ep.path);
            });

            episodeListBox.add_child(row);
        });

        episodeListScroll.set_child(episodeListBox);
        rightCol.add_child(episodeListScroll);

        rightCol.translation_x = 40;
        rightCol.ease({
            translation_x: 0,
            duration: 300,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });

        splitBox.add_child(rightCol);
        this._episodesView.add_child(splitBox);
    }

    // =========================================================================
    // GNOME-STYLE FLUID TRANSITIONS (ZERO-SNAP BIN LAYOUT)
    // =========================================================================
    _transitionForward(fromView, toView) {
        this._isAnimating = true;

        // Position destination view ready to slide in from the right
        toView.translation_x = 80;
        toView.opacity = 0;
        toView.show();

        fromView.ease({
            opacity: 0,
            translation_x: -80,
            duration: 260,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                fromView.hide();
                fromView.translation_x = 0;
                fromView.opacity = 255;
                this._isAnimating = false;
            }
        });

        toView.ease({
            opacity: 255,
            translation_x: 0,
            duration: 260,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _transitionBackward(fromView, toView) {
        this._isAnimating = true;

        // Position destination view ready to slide in from the left
        toView.translation_x = -80;
        toView.opacity = 0;
        toView.show();

        fromView.ease({
            opacity: 0,
            translation_x: 80,
            duration: 240,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                fromView.hide();
                fromView.translation_x = 0;
                fromView.opacity = 255;
                this._isAnimating = false;
            }
        });

        toView.ease({
            opacity: 255,
            translation_x: 0,
            duration: 240,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    // =========================================================================
    // UTILITIES
    // =========================================================================
    _getSeasonsForShow(show) {
        const seasonsMap = {};
        if (!show.episodes) return seasonsMap;

        show.episodes.forEach(ep => {
            let seasonName = 'Season 1';
            const title = ep.title || '';
            if (title.startsWith('[')) {
                const endIdx = title.indexOf(']');
                if (endIdx !== -1) {
                    seasonName = title.substring(1, endIdx).trim();
                }
            } else {
                const m = (ep.filename || '').match(/S(\d+)/i);
                if (m) {
                    seasonName = `Season ${parseInt(m[1], 10)}`;
                }
            }
            if (!seasonsMap[seasonName]) {
                seasonsMap[seasonName] = [];
            }
            seasonsMap[seasonName].push(ep);
        });

        const sortedMap = {};
        Object.keys(seasonsMap).sort().forEach(k => {
            sortedMap[k] = seasonsMap[k];
        });
        return sortedMap;
    }

    _playEpisode(filePath) {
        if (!filePath) return;
        console.log(`[Gnomeflix] Launching episode: ${filePath}`);
        try {
            Gio.Subprocess.new(['vlc', filePath], Gio.SubprocessFlags.NONE);
        } catch (e) {
            Gio.Subprocess.new(['xdg-open', filePath], Gio.SubprocessFlags.NONE);
        }
    }

    _relayout() {
        if (!this._container) return;
        const monitor = Main.layoutManager.primaryMonitor;
        if (monitor) {
            const panelHeight = Main.panel ? Main.panel.height : 0;
            const topOffset = (Main.panel && Main.panel.y === 0) ? panelHeight : 0;
            const w = monitor.width - 60;
            const h = monitor.height - panelHeight - 40;
            this._container.set_position(monitor.x + 30, monitor.y + topOffset + 20);
            this._container.set_size(w, h);
            if (this._viewStack) {
                this._viewStack.set_size(w, h);
            }
        }
    }

    _syncVisibility() {
        if (!this._container) return;
        const activeWs = global.workspace_manager.get_active_workspace_index();
        const targetWs = this._settings ? this._settings.get_int('workspace-index') : 0;

        if (activeWs === targetWs) {
            this._container.show();
            this._container.opacity = 255;
        } else {
            this._container.hide();
            this._container.opacity = 0;
        }
    }
}
