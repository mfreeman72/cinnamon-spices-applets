const Gio = imports.gi.Gio;
const Gtk = imports.gi.Gtk;
const GLib = imports.gi.GLib;
const CMenu = imports.gi.CMenu;
const Clutter = imports.gi.Clutter;
const Cinnamon = imports.gi.Cinnamon;
const XApp = imports.gi.XApp;
const Util = imports.misc.util;
const St = imports.gi.St;
const Meta = imports.gi.Meta;
const Main = imports.ui.main;
const {getDocManager} = imports.misc.docInfo;
const Mainloop = imports.mainloop;
const {heightsUsedMonitor} = imports.ui.panel;
//const {SessionManager} = imports.misc.gnomeSession;
const {ScreenSaverProxy} = imports.misc.screenSaver;
const {PopupMenuManager, PopupMenuSection, PopupIconMenuItem} = imports.ui.popupMenu;
const {getAppFavorites} = imports.ui.appFavorites;
const {TextIconApplet, AllowedLayout, AppletPopupMenu} = imports.ui.applet;
const {PopupResizeHandler} = require('./resizer');
const {AppletSettings} = imports.ui.settings;
const {addTween} = imports.ui.tweener;
const {SignalManager} = imports.misc.signalManager;
const {launch_all} = imports.ui.searchProviderManager;
const {_, getThumbnail_gicon, searchStr} = require('./utils');
const ApplicationsViewModeLIST = 0, ApplicationsViewModeGRID = 1;
const REMEMBER_RECENT_KEY = 'remember-recent-files';
const {CategoryButton, AppButton, ContextMenu, SidebarButton} = require('./buttons');
const {BookmarksManager} = require('./browserBookmarks');
const {EMOJI} = require('./emoji');
const SEARCH_THRESHOLD = 0.45;
const PlacementTOP = 0, PlacementBOTTOM = 1, PlacementLEFT = 2, PlacementRIGHT = 3;
var time;

class CinnamenuApplet extends TextIconApplet {
    constructor(metadata, orientation, panel_height, instance_id) {
        super(orientation, panel_height, instance_id);
        this.setAllowedLayout(AllowedLayout.BOTH);
        if (orientation === St.Side.BOTTOM || orientation === St.Side.TOP) {
            this.set_applet_label(_('Initializing'));
        }
        this.privacy_settings = new Gio.Settings({schema_id: 'org.cinnamon.desktop.privacy'});
        this.appFavorites = getAppFavorites();
        this.recentsEnabled = this.privacy_settings.get_boolean(REMEMBER_RECENT_KEY);
        this.currentCategory = 'all';
        this.gpu_offload_supported = Main.gpu_offload_supported;
        this.isBumblebeeInstalled = GLib.file_test('/usr/bin/optirun', GLib.FileTest.EXISTS);
        this.recentManager = getDocManager();
        this.closeMenu = () => this.menu.close();
        this.orientation = orientation;
        this.menuManager = new PopupMenuManager(this);
        this.menu = new AppletPopupMenu(this, this.orientation);
        this.menuManager.addMenu(this.menu);
        this.menu.setCustomStyleClass('menu-background cinnamenu');//starkmenu-background');
        this.signals = new SignalManager(null);
        this.appSystem = Cinnamon.AppSystem.get_default();
        const searchFilesMenuItem = new PopupIconMenuItem(_('Find files...'), 'system-search',
                                                                            St.IconType.SYMBOLIC, false);
        this._applet_context_menu.addMenuItem(searchFilesMenuItem);
        searchFilesMenuItem.connect('activate', () => {
                            Util.spawnCommandLine(__meta.path + '/search.py ' + GLib.get_home_dir()); });
        this.resizer = new PopupResizeHandler(  this, this.menu.actor,
                                                400, this._getScreenWorkArea().width,
                                                300, this._getScreenWorkArea().height,
                                                (w,h) => this.onBoxResized(w,h),
                                                () => this.settings.customMenuWidth,
                                                () => this.settings.customMenuHeight);
        this.signals.connect(this.privacy_settings, 'changed::' + REMEMBER_RECENT_KEY, () => {
                                this.recentsEnabled = this.privacy_settings.get_boolean(REMEMBER_RECENT_KEY);
                                this.categoriesView.update();
                                if (this.currentCategory === 'recents' && !this.recentsEnabled) {
                                    this.currentCategory = 'all';
                                } });
        this.signals.connect(Main.themeManager, 'theme-set', () => {this._updateIconAndLabel();
                                                                    setTimeout(() => this._refresh(), 0); });
        this.iconTheme = Gtk.IconTheme.get_default();
        this.signals.connect(this.iconTheme, 'changed', () => this._updateIconAndLabel());
        this.signals.connect(this.appSystem, 'installed-changed', () => {   this.apps.installedChanged();
                                                                            this._refresh(); });
        this.signals.connect(this.appFavorites, 'changed', () => {
                                if (this.appsView) {// Check if the menu has been rendered at least once
                                    this.sidebar.populate();
                                    this.updateMenuSize();
                                    if (this.currentCategory === 'favorite_apps' && !this.searchActive) {
                                        this.setActiveCategory(this.currentCategory);
                                    }
                                } });
        this.signals.connect(this.menu, 'open-state-changed', (...args) => this._onOpenStateToggled(...args));
        //this.signals.connect(global, 'scale-changed', () => this._refresh() );
        this.apps = new Apps(this);
        //this.session = new SessionManager();
        this.screenSaverProxy = new ScreenSaverProxy();
        this.initSettings();
        if (this.settings.enableWebBookmarks) {
            this.bookmarksManager = new BookmarksManager(this.appSystem);
        }
        this.recentApps = new RecentApps(this);
        this._updateActivateOnHover();
        this._updateKeybinding();
        this._initDisplay();
        this.initialised = true;
        this._updateIconAndLabel();
    }

    initSettings() {
        this.settings = {};
        this.settingsObj = new AppletSettings(this.settings, __meta.uuid, this.instance_id);

        [
        { key: 'categories',                value: 'categories',            cb: null },
        { key: 'custom-menu-height',        value: 'customMenuHeight',      cb: null },
        { key: 'custom-menu-width',         value: 'customMenuWidth',       cb: null },
        { key: 'recent-apps',               value: 'recentApps',            cb: null },

        { key: 'applications-view-mode',    value: 'applicationsViewMode',  cb: this._refresh },
        { key: 'description-placement',     value: 'descriptionPlacement',  cb: this._refresh },
        { key: 'sidebar-placement',         value: 'sidebarPlacement',      cb: this._refresh },
        { key: 'add-favorites',             value: 'addFavorites',          cb: this._refresh },

        { key: 'show-places-category',      value: 'showPlaces',            cb: this._onEnablePlacesChange },
        { key: 'show-web-bookmarks-category', value: 'enableWebBookmarks',  cb: this._onEnableWebBookmarksChange },
        { key: 'show-favorite-apps-category', value: 'showFavAppsCategory', cb: this._onEnableFavAppsCategory },
        { key: 'show-home-folder-category', value: 'showHomeFolder',        cb: () => this.categoriesView.update()},

        { key: 'overlay-key',               value: 'overlayKey',            cb: this._updateKeybinding },
        { key: 'activate-on-hover',         value: 'activateOnHover',       cb: this._updateActivateOnHover },
        { key: 'hover-delay',               value: 'hoverDelayMs',          cb: this._updateActivateOnHover },
        { key: 'enable-animation',          value: 'enableAnimation',       cb: null },
        { key: 'open-on-category',          value: 'openOnCategory',        cb: null },

        { key: 'category-click',            value: 'categoryClick',         cb: null },
        { key: 'enable-autoscroll',         value: 'enableAutoScroll',      cb: this._refresh },
        { key: 'enable-emoji-search',       value: 'enableEmojiSearch',     cb: null },
        { key: 'web-search-option',         value: 'webSearchOption',       cb: null },
        { key: 'search-home-folder',        value: 'searchHomeFolder',      cb: null },
        { key: 'show-hidden-files',         value: 'showHiddenFiles',       cb: null },

        { key: 'menu-icon-custom',          value: 'menuIconCustom',        cb: this._updateIconAndLabel },
        { key: 'menu-icon',                 value: 'menuIcon',              cb: this._updateIconAndLabel },
        { key: 'menu-icon-size-custom',     value: 'menuIconSizeCustom',    cb: this._updateIconAndLabel },
        { key: 'menu-icon-size',            value: 'menuIconSize',          cb: this._updateIconAndLabel },
        { key: 'menu-label',                value: 'menuLabel',             cb: this._updateIconAndLabel },

        { key: 'category-icon-size',        value: 'categoryIconSize',      cb: this._refresh },
        { key: 'apps-list-icon-size',       value: 'appsListIconSize',      cb: this._refresh },
        { key: 'apps-grid-icon-size',       value: 'appsGridIconSize',      cb: this._refresh },
        { key: 'sidebar-icon-size',         value: 'sidebarIconSize',       cb: this._refresh },
        { key: 'use-box-style',             value: 'useBoxStyle',           cb: this._refresh }
        ].forEach(setting => this.settingsObj.bind(
                          setting.key,
                          setting.value,
                          setting.cb ? (...args) => setting.cb.call(this, ...args) : null ) );
    }

    getAppIconSize() {
        if (this.settings.applicationsViewMode === ApplicationsViewModeLIST) {
            return this.settings.appsListIconSize;
        } else {
            return this.settings.appsGridIconSize;
        }
    }

    getThemeForegroundColor() {
        return this.menu.actor.get_theme_node().get_foreground_color().to_string().substring(0, 7);
    }

    _getScreenWorkArea() {
        const monitor = Main.layoutManager.currentMonitor;
        const ws = global.screen.get_active_workspace();
        return ws.get_work_area_for_monitor(monitor.index);
    }
//----------------TextIconApplet overrides---------
    //on_applet_reloaded() {}

    on_orientation_changed(orientation) {
        this.orientation = orientation;
        if (this.orientation === St.Side.LEFT || this.orientation === St.Side.RIGHT) {
            this.hide_applet_label(true);
        } else {
            this.hide_applet_label(false);
        }
        this._updateIconAndLabel();
    }

    //on_applet_added_to_panel() {}

    on_applet_removed_from_panel() {
        this.willUnmount = true;
        Main.keybindingManager.removeHotKey('overlay-key-' + this.instance_id);
        if (!this.settingsObj) {
            return;
        }
        this.settingsObj.finalize();
        this.signals.disconnectAllSignals();
        this.apps.destroy();
        this._destroyDisplayed();
        this.menu.destroy();
    }

    on_applet_clicked() {
        if (!this.initialised) {
            this.set_applet_label(_('Please wait...'));
            return;
        }
        this.menu.toggle_with_options(this.settings.enableAnimation);
    }

    on_applet_instances_changed(instance) {
        if (instance && instance.instance_id !== this.instance_id) {
            this.getOtherInstance = () => instance;
            instance.getOtherInstance = () => this;
        } else if (!instance && !this.willUnmount) {
            this.getOtherInstance = null;
        }
    }

    _setStyle() {
        // Override js/applet.js so _updateIconAndLabel doesn't have to fight with size changes
        // from the panel configuration. This gets called any time set_applet_icon() variants are
        // called.

        let icon_type = this._applet_icon.get_icon_type();
        let size;

        if (this.settings.menuIconSizeCustom) {
            size = Math.max(Math.min(this.settings.menuIconSize, this.panel.height), 1);
        } else {
            size = this.getPanelIconSize(icon_type);
        }

        if (icon_type === St.IconType.FULLCOLOR) {
            this._applet_icon.set_style_class_name('applet-icon');
        } else {
            this._applet_icon.set_style_class_name('system-status-icon');
        }

        this._applet_icon.set_icon_size(size);
    }
//-------settings callbacks--------
    _onEnablePlacesChange() {
        this.categoriesView.update();
        if (this.currentCategory === 'places' && !this.settings.showPlaces) {
            this.currentCategory = 'all';
        }
    }

    _onEnableWebBookmarksChange() { //web bookmarks
        if (this.settings.enableWebBookmarks) {
            this.bookmarksManager = new BookmarksManager(this.appSystem);
        } else if (this.bookmarksManager) {
            this.bookmarksManager = null;
            if (this.currentCategory === 'bookmarks') {
                this.currentCategory = 'all';
            }
        }
        this.categoriesView.update();
    }

    _onEnableFavAppsCategory() {
        this.categoriesView.update();
        if (this.currentCategory === 'favorite_apps' && !this.settings.showFavAppsCategory) {
            this.currentCategory = 'all';
        }
    }

    launchEditor() {
        Util.spawnCommandLine('cinnamon-menu-editor');
    }

    _updateKeybinding() {
        Main.keybindingManager.addHotKey(
            'overlay-key-' + this.instance_id,
            this.settings.overlayKey,
            () => {
                if (Main.overview.visible || Main.expo.visible) return;
                if (!this.getOtherInstance || global.screen.get_current_monitor() === this.panel.monitorIndex) {
                    this.menu.toggle_with_options(this.settings.enableAnimation);
                } else if (typeof this.getOtherInstance === 'function') {
                    const instance = this.getOtherInstance();
                    instance.menu.toggle_with_options.call(instance.menu, instance.settings.enableAnimation);
                }
            }
        );
    }

    _updateIconAndLabel() {
        try {
            if (this.settings.menuIconCustom) {
                if (this.settings.menuIcon === '') {
                    this.set_applet_icon_name('');
                } else if (GLib.path_is_absolute(this.settings.menuIcon) &&
                                    GLib.file_test(this.settings.menuIcon, GLib.FileTest.EXISTS)) {
                    if (this.settings.menuIcon.includes('-symbolic')) {
                        this.set_applet_icon_symbolic_path(this.settings.menuIcon);
                    } else {
                        this.set_applet_icon_path(this.settings.menuIcon);
                    }
                } else if (this.iconTheme.has_icon(this.settings.menuIcon)) {
                    if (this.settings.menuIcon.includes('-symbolic')) {
                        this.set_applet_icon_symbolic_name(this.settings.menuIcon);
                    } else {
                        this.set_applet_icon_name(this.settings.menuIcon);
                    }
                }
            } else {
                this.set_applet_icon_path(__meta.path + '/icon.png');
                /*let iconName = global.settings.get_string('app-menu-icon-name');*/
            }
        } catch(e) {
            global.logWarning('Could not load icon file ' + this.settings.menuIcon + ' for menu button');
        }
        if (this.settings.menuIconCustom && this.settings.menuIcon === '' ||
                                this.settings.menuIconSizeCustom && this.settings.menuIconSize === 0) {
            this._applet_icon_box.hide();
        } else {
            this._applet_icon_box.show();
        }

        if (this.orientation === St.Side.LEFT || this.orientation === St.Side.RIGHT) {
            this.set_applet_label('');
        } else {
            if (!this.settings.menuLabel) {
                this.settings.menuLabel = '';
            }
            const menuLabel = this.settings.menuLabel.substring(0, 45);
            this.set_applet_label(menuLabel);
            this.set_applet_tooltip(menuLabel);
        }
    }

    _updateActivateOnHover() {
        const openMenu = () => {
            if (!this._applet_context_menu.isOpen) {
                this.menu.open(this.settings.enableAnimation);
            }
        };
        if (this.signals.isConnected('enter-event', this.actor)) {
            this.signals.disconnect('enter-event', this.actor);
        }
        if (this.settings.activateOnHover) {
            this.signals.connect(this.actor, 'enter-event', () => {
                                        setTimeout(() => openMenu(), this.settings.hoverDelayMs); });
        }
    }

    _refresh() {
        // TBD: For some reason the onEnable* settings callbacks get called several times per settings change,
        // This is causing the start up category to reset, so throttling this function to 250ms prevents excess
        // invocation.
        if (!this.lastRenderTime) this.lastRenderTime = 0;
        const now = Date.now();
        if ((now - this.lastRenderTime) <= 250) return;
        this.lastRenderTime = now;
        this.menu.removeAll();
        this._destroyDisplayed();
        if (this.currentCategory === 'places' && !this.settings.showPlaces ||
                        this.currentCategory === 'bookmarks' && !this.settings.enableWebBookmarks ||
                        this.currentCategory === 'recents' && !this.recentsEnabled ||
                        this.currentCategory === 'favorite_apps' && !this.settings.showFavAppsCategory) {
            this.currentCategory = 'all';
        }
        this._initDisplay();
        this.clearEnteredActors();
    }
//==================================================================
    addFavoriteAppToPos(add_id, pos_id) {
        const pos = this.appFavorites._getIds().indexOf(pos_id);
        if (pos >= 0) { //move
            this.appFavorites.moveFavoriteToPos(add_id, pos);
        } else {
            this.appFavorites.addFavoriteAtPos(add_id, pos);
        }
    }

    scrollToButton(button, fullyScrollFirstAndLast = false) {
        const container = button.actor.get_parent();
        let scrollBox = container;
        let children;
        let i = 0;
        while (!(scrollBox instanceof St.ScrollView)) {
            i++;
            if (i > 10) {
                global.logWarning('Cinnamenu: Unable to find scrollbox for', button.actor.toString());
                return false;
            }
            scrollBox = scrollBox.get_parent();
        }

        let adjustment = scrollBox.vscroll.adjustment;
        let [value, lower, upper, stepIncrement, pageIncrement, pageSize] = adjustment.get_values();

        if (fullyScrollFirstAndLast) children = container.get_children();
        if (fullyScrollFirstAndLast && button.actor === children[0]) {
            value = 0;
        } else if (fullyScrollFirstAndLast && button.actor === children[children.length - 1]) {
            value = scrollBox.height;
        } else {
            let offset = 0;
            const vfade = scrollBox.get_effect('fade');
            if (vfade) {
                offset = vfade.vfade_offset;
            }
            const box = button.actor.get_allocation_box();
            let y1 = box.y1, y2 = box.y2;
            let parent = button.actor.get_parent();
            while (parent !== scrollBox) {
                if (!parent) {
                    return false;
                }
                const box = parent.get_allocation_box();
                y1 += box.y1;
                y2 += box.y1;
                parent = parent.get_parent();
            }
            if (y1 < value + offset) {
                value = Math.max(0, y1 - offset);
            } else if (y2 > value + pageSize - offset) {
                value = Math.min(upper, y2 + offset - pageSize);
            } else {
                return false;
            }
        }

        if (this.settings.enableAnimation) {
            addTween(adjustment, { value: value, time: 0.1, transition: 'easeOutQuad' });
        } else {
            adjustment.set_value(value);
        }
    }

    clearEnteredActors() {
        if (this.contextMenu.isOpen) {
            this.contextMenu.close();
        }
        this.appsView.clearAppsViewEnteredActors();
        this.sidebar.clearSidebarEnteredActors();
    }
//----------
    _onOpenStateToggled(menu, open) {
        if (global.settings.get_boolean('panel-edit-mode')) {
            return false;
        }
        if (open) {
            this.searchView.tweakTheme();
            this.categoriesView.update();//in case menu editor updates
            this.sidebar.populate();//in case fav files changed
            global.stage.set_key_focus(this.searchView.searchEntry);
            let openOnCategory = this.currentCategory;
            if (this.settings.openOnCategory === 1 && this.settings.showFavAppsCategory) {
                openOnCategory = 'favorite_apps';
            } else if (this.settings.openOnCategory === 2 && this.recentsEnabled) {
                openOnCategory = 'recents';
            } else if (this.settings.openOnCategory === 3 && this.settings.showPlaces) {
                openOnCategory = 'places';
            } else if (this.settings.openOnCategory === 4) {
                openOnCategory = 'all';
            } else if (this.settings.openOnCategory === 5 && this.settings.showHomeFolder) {
                openOnCategory = GLib.get_home_dir();
            }
            this.updateMenuSize();
            //Mainloop.idle_add(() => this.setActiveCategory(currentCategory));
            this.setActiveCategory(openOnCategory);
            this.panel.peekPanel();
        } else {
            if (this.searchActive) {
                this._endSearchMode();
            }
            this.clearEnteredActors();
            this.appsView.clearApps();//for quicker opening of menu
            this.categoriesView.categoriesBox.remove_all_children();
        }
        return true;
    }

    onBoxResized(userWidth, userHeight){
        this.updateMenuSize(userWidth, userHeight);
        //when resizing, no adjustments to app buttons are needed for list view
        if (this.settings.applicationsViewMode === ApplicationsViewModeGRID) {
            this.appsView.resizeGrid();
        }
    }

    updateMenuSize(newWidth, newHeight) {
        //----------height--------
        //the stored menu height value is middlePane + bottomPane which is smaller than the menu's actual height.

        if (!newHeight) {//newHeight is only supplied when risizing because settings have been finalised.
            newHeight = this.settings.customMenuHeight;
        }
        const appsHeight = newHeight - this.bottomPane.height;
        //---make middlePane actors the same height
        this.appsView.applicationsScrollBox.height = appsHeight;
        this.categoriesView.groupCategoriesWorkspacesScrollBox.height = appsHeight;
        //find sidebarOuterBox vertical padding
        const themeNode = this.sidebar.sidebarOuterBox.get_theme_node();
        const topAndBottomPadding = themeNode.lookup_length('padding-top', true)[1] +
                                            themeNode.lookup_length('padding-bottom', true)[1];
        let padding = Math.max(themeNode.lookup_length('padding', true)[1] * 2, topAndBottomPadding);
        this.sidebar.sidebarScrollBox.set_height(-1);
        this.sidebar.sidebarScrollBox.set_height(Math.min(appsHeight - padding, this.sidebar.sidebarScrollBox.height));
        //-----
        if (!this.resizer.resizingInProgress) {
            //due to a intermittent bug causing cinnamon to crash, don't update settings while resizing
            //https://github.com/linuxmint/cinnamon/pull/9771#issuecomment-755081805
            this.settings.customMenuHeight = newHeight;
        }
        //------------width-------------
        //the stored menu width value is less than the menu's actual width because it doesn't
        //include the outer menuBox padding, margin, etc.

        if (!newWidth) {
            newWidth = this.settings.customMenuWidth;
        }
        //---find minimum posible width for menu
        let leftSideWidth = this.categoriesView.groupCategoriesWorkspacesScrollBox.width;
        if (this.settings.sidebarPlacement === PlacementLEFT ||
                                                this.settings.sidebarPlacement === PlacementRIGHT) {
            leftSideWidth += this.sidebar.sidebarOuterBox.width;
        }
        this.searchView.searchEntry.width = 5;//don't know why this works.
        let bottomPaneMinWidth = 0;
        if (this.settings.sidebarPlacement === PlacementTOP ||
                                                this.settings.sidebarPlacement === PlacementBOTTOM) {
            bottomPaneMinWidth = this.bottomPane.width;
        }
        const minWidthForAppsView = 200;
        let minMenuWidth = Math.max(leftSideWidth + minWidthForAppsView, bottomPaneMinWidth);
        //---set menu to newWidth or minimum width
        let menuWidth = Math.max(minMenuWidth, newWidth);
        if (!this.resizer.resizingInProgress) {
            //due to a intermittent bug causing cinnamon to crash, don't update settings while resizing
            //https://github.com/linuxmint/cinnamon/pull/9771#issuecomment-755081805
            this.settings.customMenuWidth = menuWidth;
        }
        this.appsView.applicationsListBox.width = menuWidth - leftSideWidth;
        this.appsView.applicationsGridBox.width = menuWidth - leftSideWidth;
    }

    _onMenuKeyPress(actor, event) {
        if (this.resizer.resizingInProgress) {
            return Clutter.EVENT_STOP;
        }
        const symbol = event.get_key_symbol();
        const keyCode = event.get_key_code();
        const modifierState = Cinnamon.get_event_state(event);
        /* check for a keybinding and quit early, otherwise we get a double hit
           of the keybinding callback */
        const action = global.display.get_keybinding_action(keyCode, modifierState);
        if (action === Meta.KeyBindingAction.CUSTOM) {
            return Clutter.EVENT_PROPAGATE;
        }

        const ctrlKey = modifierState === 4;
        const shiftKey = modifierState === 1;
        const altKey = modifierState === 8;
        const altgrKey = modifierState === 128;
        const noModifiers = modifierState === 0;

        //Because Clutter.EVENT_PROPAGATE is returned on KEY_Left and KEY_Right, ignore duplicate
        //event emitted by ibus. https://github.com/linuxmint/cinnamon-spices-applets/issues/3294
        if (!this.lastKeyEventTime) this.lastKeyEventTime = 0;
        const now = Date.now();
        if ((symbol === Clutter.KEY_Left || symbol === Clutter.KEY_Right) && noModifiers &&
                                                                (now - this.lastKeyEventTime) <= 80) {
            return Clutter.EVENT_PROPAGATE;
        }
        this.lastKeyEventTime = now;

        const appButtons = this.appsView.getActiveButtons();
        const sidebarButtons = this.sidebar.getButtons();
        const categoryButtons = this.categoriesView.buttons;

        const enteredAppItemIndex = appButtons.findIndex(button => button.entered);
        const enteredSidebarItemIndex = sidebarButtons.findIndex(button => button.entered);

        let currentlyActiveCategoryIndex = categoryButtons.findIndex(button =>
                                                                    this.currentCategory === button.id);
        if (currentlyActiveCategoryIndex < 0) {
            currentlyActiveCategoryIndex = 0;
        }
        let enteredCategoryIndex = categoryButtons.findIndex(button => button.entered);
        if (enteredCategoryIndex < 0) {
            enteredCategoryIndex = currentlyActiveCategoryIndex;
        }

        const enteredAppItemExists = enteredAppItemIndex > -1;
        const enteredCategoryExists = enteredCategoryIndex > -1;
        const enteredSidebarItemExists = enteredSidebarItemIndex > -1;

        let enteredContextMenuItemExists = false;
        let contextMenuChildren = [];
        let enteredContextMenuItemIndex = -1;
        if (this.contextMenu.isOpen) {
            contextMenuChildren = this.contextMenu.contextMenuButtons;
            enteredContextMenuItemIndex = contextMenuChildren.findIndex(button => button.entered);
            if (enteredContextMenuItemIndex < 0) {
                enteredContextMenuItemIndex = 0;
            }
            enteredContextMenuItemExists = true;
        }

        const leaveCurrentlyEnteredItem = () => {
            if (enteredContextMenuItemExists) {
                contextMenuChildren[enteredContextMenuItemIndex].handleLeave();
            } else if (enteredAppItemExists) {
                appButtons[enteredAppItemIndex].handleLeave();
            } else if (enteredSidebarItemExists) {
                sidebarButtons[enteredSidebarItemIndex].handleLeave();
            } else if (enteredCategoryExists) {
                categoryButtons[enteredCategoryIndex].handleLeave();
            }
        };

        const nextSidebarItem = () => {
            if (enteredSidebarItemIndex < sidebarButtons.length - 1) {
                sidebarButtons[enteredSidebarItemIndex + 1].handleEnter();
            } else {
                sidebarButtons[0].handleEnter();
            }
        };

        const previousSidebarItem = () => {
            if (enteredSidebarItemIndex === 0) {
                sidebarButtons[sidebarButtons.length -1].handleEnter();
            } else {
                sidebarButtons[enteredSidebarItemIndex - 1].handleEnter();
            }
        };

        const leftNavigation = () => {
            if (enteredContextMenuItemExists) {
                contextMenuChildren[enteredContextMenuItemIndex].handleEnter();//effectively ignore
            } else if (enteredAppItemExists) {
                if (this.settings.applicationsViewMode === ApplicationsViewModeLIST) {
                    categoryButtons[currentlyActiveCategoryIndex].handleEnter();
                } else {
                    if (enteredAppItemIndex > 0) {
                        appButtons[enteredAppItemIndex - 1].handleEnter();
                    } else {
                        appButtons[appButtons.length - 1].handleEnter();
                    }
                }
            } else if (enteredSidebarItemExists) {
                if (this.settings.sidebarPlacement === PlacementLEFT ||
                                                this.settings.sidebarPlacement === PlacementRIGHT) {
                    categoryButtons[currentlyActiveCategoryIndex].handleEnter();
                } else {
                    previousSidebarItem();
                }
            } else if (enteredCategoryExists) {
                sidebarButtons[0].handleEnter();
            }
        };

        const rightNavigation = () => {
            if (enteredContextMenuItemExists) {
                contextMenuChildren[enteredContextMenuItemIndex].handleEnter();//Ignore
            } else if (enteredAppItemExists) {
                if (this.settings.applicationsViewMode === ApplicationsViewModeLIST) {
                    appButtons[enteredAppItemIndex].handleEnter();//ignore
                } else {
                    if (appButtons[enteredAppItemIndex + 1]) {
                        appButtons[enteredAppItemIndex + 1].handleEnter();
                    } else {
                        appButtons[0].handleEnter();
                    }
                }
            } else if (enteredSidebarItemExists) {
                if (this.settings.sidebarPlacement === PlacementLEFT ||
                                                    this.settings.sidebarPlacement === PlacementRIGHT) {
                    categoryButtons[currentlyActiveCategoryIndex].handleEnter();
                } else {
                    nextSidebarItem();
                }
            } else if (enteredCategoryExists) {
                appButtons[0].handleEnter();
            }
        };

        const downNavigation = () => {
            if (enteredContextMenuItemExists) {
                let nextContextMenuItem = enteredContextMenuItemIndex + 1;
                while (!contextMenuChildren[nextContextMenuItem] ||
                                    contextMenuChildren[nextContextMenuItem].action === null) {
                    nextContextMenuItem++;
                    if (nextContextMenuItem >= contextMenuChildren.length) {
                        nextContextMenuItem = 0;
                    }
                }
                contextMenuChildren[nextContextMenuItem].handleEnter();
            } else if (enteredAppItemExists) {
                if (this.settings.applicationsViewMode === ApplicationsViewModeLIST) {
                    if (appButtons[enteredAppItemIndex + 1]) {
                        appButtons[enteredAppItemIndex + 1].handleEnter();
                    } else {
                        appButtons[0].handleEnter();
                    }
                } else {//grid view
                    if (appButtons[enteredAppItemIndex + this.appsView.getGridValues().columns]) {
                        appButtons[enteredAppItemIndex + this.appsView.getGridValues().columns].handleEnter();
                    } else {
                        appButtons[appButtons.length - 1].handleEnter();
                    }
                }
            } else if (enteredSidebarItemExists) {
                if (this.settings.sidebarPlacement === PlacementTOP ||
                                                    this.settings.sidebarPlacement === PlacementBOTTOM) {
                    categoryButtons[currentlyActiveCategoryIndex].handleEnter();
                } else {
                    nextSidebarItem();
                }
            } else if (enteredCategoryExists) {
                if (categoryButtons[enteredCategoryIndex + 1]) {
                    categoryButtons[enteredCategoryIndex + 1].handleEnter();
                } else {
                    categoryButtons[0].handleEnter();
                }
            }
        };

        const upNavigation = () => {
            if (enteredContextMenuItemExists) {
                let previousContextMenuItem = enteredContextMenuItemIndex - 1;
                while (!contextMenuChildren[previousContextMenuItem] ||
                                    contextMenuChildren[previousContextMenuItem].action === null) {
                    previousContextMenuItem--;
                    if (previousContextMenuItem < 0) {
                        previousContextMenuItem = contextMenuChildren.length -1;
                    }
                }
                contextMenuChildren[previousContextMenuItem].handleEnter();
            } else if (enteredAppItemExists) {
                if (this.settings.applicationsViewMode === ApplicationsViewModeLIST) {
                    if (enteredAppItemIndex > 0) {
                        appButtons[enteredAppItemIndex - 1].handleEnter();
                    } else {
                        appButtons[appButtons.length - 1].handleEnter();
                    }
                } else {
                    if (appButtons[enteredAppItemIndex - this.appsView.getGridValues().columns]) {
                        appButtons[enteredAppItemIndex - this.appsView.getGridValues().columns].handleEnter();
                    } else {
                        appButtons[0].handleEnter();
                    }
                }
            } else if (enteredSidebarItemExists) {
                if (this.settings.sidebarPlacement === PlacementTOP ||
                                                this.settings.sidebarPlacement === PlacementBOTTOM) {
                    categoryButtons[currentlyActiveCategoryIndex].handleEnter();
                } else {
                    previousSidebarItem();
                }
            } else if (enteredCategoryExists) {
                if (enteredCategoryIndex > 0) {
                    categoryButtons[enteredCategoryIndex - 1].handleEnter();
                } else {
                    categoryButtons[categoryButtons.length - 1].handleEnter();
                }
            }
        };

        switch (true) {
        case (symbol === Clutter.KP_Enter || symbol === Clutter.KEY_Return) && ctrlKey:
        case symbol === Clutter.KEY_Menu && noModifier:
            if (this.contextMenu.isOpen) {
                this.contextMenu.close();
            } else if (enteredAppItemExists) {
                appButtons[enteredAppItemIndex].openContextMenu();
            } else if (enteredSidebarItemExists) {
                sidebarButtons[enteredSidebarItemIndex].openContextMenu();
            } else if (enteredCategoryExists) {
                categoryButtons[enteredCategoryIndex].openContextMenu();
            }
            return Clutter.EVENT_STOP;
        case (symbol === Clutter.KP_Enter || symbol === Clutter.KEY_Return) && noModifiers:
            if (enteredContextMenuItemExists) {
                contextMenuChildren[enteredContextMenuItemIndex].activate();
            } else if (enteredAppItemExists) {
                appButtons[enteredAppItemIndex].activate();
            } else if (enteredSidebarItemExists) {
                sidebarButtons[enteredSidebarItemIndex].activate();
            } else if (enteredCategoryExists) {
                categoryButtons[enteredCategoryIndex].selectCategory();
            }
            return Clutter.EVENT_STOP;
        case (symbol === Clutter.KEY_Up && noModifiers):
            leaveCurrentlyEnteredItem();
            upNavigation();
            return Clutter.EVENT_STOP;
        case (symbol === Clutter.KEY_Down && noModifiers):
            leaveCurrentlyEnteredItem();
            downNavigation();
            return Clutter.EVENT_STOP;
        case (symbol === Clutter.KEY_Right && noModifiers):
            leaveCurrentlyEnteredItem();
            rightNavigation();
            return Clutter.EVENT_PROPAGATE; //so that left/right can also be used to navigate search entry
        case (symbol === Clutter.KEY_Left && noModifiers):
            leaveCurrentlyEnteredItem();
            leftNavigation();
            return Clutter.EVENT_PROPAGATE; //so that left/right can also be used to navigate search entry
        case (symbol === Clutter.ISO_Left_Tab || symbol === Clutter.Tab) && noModifiers:
            leaveCurrentlyEnteredItem();
            if (enteredContextMenuItemExists) {
                contextMenuChildren[enteredContextMenuItemIndex].handleEnter();//effectively ignore keypress
            } else if (enteredAppItemExists) {
                sidebarButtons[0].handleEnter();
            } else if (enteredSidebarItemExists && !this.searchActive) {
                categoryButtons[currentlyActiveCategoryIndex].handleEnter();
            } else {
                appButtons[0].handleEnter();
            }
            return Clutter.EVENT_STOP;
        case (symbol === Clutter.ISO_Left_Tab || symbol === Clutter.Tab) && shiftKey:
            leaveCurrentlyEnteredItem();
            if (enteredContextMenuItemExists) {
                contextMenuChildren[enteredContextMenuItemIndex].handleEnter();//effectively ignore keypress
            } else if (enteredAppItemExists) {
                categoryButtons[currentlyActiveCategoryIndex].handleEnter();
            } else if (enteredSidebarItemExists && !this.searchActive) {
                appButtons[0].handleEnter();
            } else {
                sidebarButtons[0].handleEnter();
            }
            return Clutter.EVENT_STOP;
        case (symbol === Clutter.ISO_Left_Tab || symbol === Clutter.Tab) && altKey:
            this.closeMenu();//Close menu as alt-tab is used for app-switcher in cinnamon
            return Clutter.EVENT_STOP;
        case (symbol === Clutter.Escape || symbol === Clutter.KEY_Escape) && noModifiers:
            if (this.contextMenu.isOpen) {
                this.contextMenu.close();
            } else {
                this.closeMenu();
            }
            return Clutter.EVENT_STOP;
        case (symbol === Clutter.KEY_Page_Up && noModifiers):
            leaveCurrentlyEnteredItem();
            if (enteredAppItemExists) {
                appButtons[0].handleEnter();
            } else if (enteredSidebarItemExists) {
                sidebarButtons[0].handleEnter();
            } else {
                categoryButtons[0].handleEnter();
            }
            return Clutter.EVENT_STOP;
        case (symbol === Clutter.KEY_Page_Down && noModifiers):
            leaveCurrentlyEnteredItem();
            if (enteredAppItemExists) {
                appButtons[appButtons.length - 1].handleEnter();
            } else if (enteredSidebarItemExists) {
                sidebarButtons[sidebarButtons.length - 1].handleEnter();
            } else {
                categoryButtons[categoryButtons.length - 1].handleEnter();
            }
            return Clutter.EVENT_STOP;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }

    setActiveCategory(categoryId) {
        this.currentCategory = categoryId;
        this.categoriesView.setSelectedCategoryStyle(categoryId);
        this.appsView.buttonStoreCleanup();
        switch (categoryId) {
        case 'places':
            this.appsView.populate(this.listPlaces());
            break;
        case 'recents':
            const recents = this.listRecent();
            if (recents.length > 0) {
                this.appsView.populate(recents);
            } else {
                this.appsView.populate([], _('No recent Items'));
            }
            break;
        case 'favorite_files':
            this.appsView.populate(this.listFavoriteFiles());
            break;
        case 'bookmarks':
            this.appsView.populate(this.listWebBookmarks());
            break;
        case 'favorite_apps':
            this.appsView.populate(this.listFavoriteApps());
            break;
        default:
            if (categoryId.startsWith('/')) {//folder view
                const folderContents = this.listFolder(categoryId);
                const headerText = folderContents.errorMsg? folderContents.errorMsg : categoryId;
                this.appsView.populate(folderContents.results, headerText);
            } else {//applications category
                this.appsView.populate(this.apps.listApplications(categoryId));
            }
        }
    }
//----search----
    _onSearchTextChanged() {
        const searchText = this.searchView.searchEntryText.get_text();

        if (searchText.length === 0) {//search text deleted, cancel search mode
            if (!this.searchActive) {//search mode already ended
                return;
            }
            this._endSearchMode();
            this.setActiveCategory(this.currentCategory);
            return;
        }
        //---start search---
        this.currentSearchStr = searchText;
        this.clearEnteredActors();
        if (!this.searchActive) {//set search mode
            this.searchActive = true;
            this.searchView.showAndConnectSecondaryIcon();//show edit-delete icon
            this.categoriesView.buttons.forEach(button => button.disable());
        }
        setTimeout(() => this._doSearch(searchText), 0);
    }

    _endSearchMode() {
        this.searchActive = false;
        this.searchView.hideAndDisconnectSecondaryIcon();//hide edit-delete icon
        this.appsView.buttonStoreCleanup();//delete all search result buttons as they won't be reused
        this.categoriesView.buttons.forEach(button => button.enable());
        this.searchView.searchEntry.set_text('');
        this.previousSearchPattern = '';
    }

    _doSearch(text) {
        //this fuction has been called asynchronously meaning that a keypress may have changed the
        //search query before this function is called. Check that this search is still valid.
        if (text !== this.currentSearchStr) return;
        //if (!text || !text.trim()) return;
        const pattern = Util.latinise(text.toLowerCase());
        //Don't repeat the same search. This can happen if a key and backspace are pressed in quick
        //succession while a previous search is being carried out.
        if (pattern === this.previousSearchPattern) {
            return false;
        }
        this.previousSearchPattern = pattern;
        let results = this.apps.listApplications('all', pattern)
                            .concat(this.settings.showPlaces ? this.listPlaces(pattern) : [])
                            .concat(this.settings.enableWebBookmarks ? this.listWebBookmarks(pattern) : [])
                            .concat(this.recentsEnabled ? this.listRecent(pattern) : [])
                            .concat(this.listFavoriteFiles(pattern));
        //---file search-------
        if (pattern.length > 1 && this.settings.searchHomeFolder) {
            this.filesSearched = 0;
            results = results.concat(this._searchDir(GLib.get_home_dir(), pattern, 0));
        }

        results.sort( (a, b) =>  a.score < b.score );
        if (results.length > 10) {
            results.length = 10;
        }
        //=======search providers==========
        //---calculator---
        const replacefn = (match) => {
            if (['E','PI','abs','acos','acosh','asin','asinh','atan','atanh','cbrt','ceil','cos',
            'cosh','exp','floor','fround','log','max','min','pow','random','round','sign','sin',
            'sinh','sqrt','tan','tanh','trunc'].includes(match)) {
                return 'Math.' + match;
            } else {
                validExp = false;
                return match;
            }
        };
        let validExp = true;
        let ans = null;
        const exp = text.replace(/([a-zA-Z]+)/g, replacefn);
        if (validExp) {
            try {
                ans = eval(exp);
            } catch(e) {
                global.log(e.message);
            }
        }
        if ((typeof ans === 'number' || typeof ans === 'boolean') && ans != text ) {
            const calcIcon = Gio.file_new_for_path(__meta.path + '/calc.png');
            results.push({  isSearchResult: true,
                            name: _('Solution:') + ' ' + ans,
                            description: _('Click to copy'),
                            deleteAfterUse: true,
                            icon: new St.Icon({ gicon: new Gio.FileIcon({ file: calcIcon }),
                                                                        icon_size: this.getAppIconSize() }),
                            activate: () => {   const clipboard = St.Clipboard.get_default();
                                                clipboard.set_text(St.ClipboardType.CLIPBOARD, ans.toString());}
                         });
        }
        //---web search option---
        if (this.settings.webSearchOption != 4) {//4=none
            const iconName = ['google_icon.png','bing_icon.png','yahoo_icon.png',
                                                'duckgo_icon.png'][this.settings.webSearchOption];
            const url = ['google.com/search?q=','www.bing.com/search?q=','search.yahoo.com/search?p=',
                                                    'duckduckgo.com/?q='][this.settings.webSearchOption];
            results.push(   {   isSearchResult: true,
                                name: _('Search web for') + ' "' + text + '"',
                                description: '',
                                deleteAfterUse: true,
                                icon: new St.Icon({ gicon: new Gio.FileIcon({
                                            file: Gio.file_new_for_path(__meta.path + '/' + iconName)}),
                                            icon_size: this.getAppIconSize() }),
                                activate: () => {Util.spawnCommandLineAsync(
                                        '/usr/bin/xdg-open https://' + url + encodeURIComponent(text));}
                            } );
        }
        //---emoji search------
        if (pattern.length > 2 && this.settings.enableEmojiSearch) {
            let emojiResults = [];
            EMOJI.forEach(emoji => {
                        const match1 = searchStr(pattern, emoji.name, true);
                        const match2 = searchStr(pattern, emoji.keywords, true);
                        match2.score *= 0.95; //slightly lower priority for keyword match
                        const bestMatchScore = Math.max(match1.score, match2.score);
                        if (bestMatchScore > SEARCH_THRESHOLD) {
                            emojiResults.push({
                                    name: emoji.name,
                                    score: bestMatchScore,
                                    description: _('Click to copy'),
                                    nameWithSearchMarkup: match1.result,
                                    isSearchResult: true,
                                    deleteAfterUse: true,
                                    emoji: emoji.code,
                                    activate: () => { const clipboard = St.Clipboard.get_default();
                                        clipboard.set_text(St.ClipboardType.CLIPBOARD, emoji.code);}
                                        });
                        } });
            //
            emojiResults.sort( (a, b) =>  a.score < b.score );
            results = results.concat(emojiResults);
        }
        //---search providers---
        const finish = () => {
            this.appsView.populate(results, null);
            const buttons = this.appsView.getActiveButtons();
            if (buttons.length > 0) {
                buttons[0].handleEnter();
            }
        };
        if (pattern.length > 2) {
            launch_all(pattern, (provider, providerResults) => {
                        providerResults.forEach(providerResult => {
                            if (!providerResult) {
                                return;
                            }
                            providerResult.isSearchResult = true;
                            providerResult.name = providerResult.label.replace(/ : /g, ': ');
                            providerResult.activate = provider.on_result_selected;
                            providerResult.deleteAfterUse = true;
                            providerResult.score = 0.1;
                            if (providerResult.icon) {
                                providerResult.icon.icon_size = this.getAppIconSize();
                            } else if (providerResult.icon_app){
                                providerResult.icon = providerResult.icon_app.create_icon_texture(
                                                                                            this.getAppIconSize());
                            } else if (providerResult.icon_filename){
                                providerResult.icon = new St.Icon({
                                      gicon: new Gio.FileIcon({
                                                file: Gio.file_new_for_path(providerResults[i].icon_filename)}),
                                                icon_size: this.getAppIconSize() });
                            }
                        });
                        if (!this.searchActive) {
                            return;
                        }
                        if (providerResults && providerResults.length > 0) {
                            results = results.concat(providerResults);
                        }
                        finish(); } );
            finish();
        } else {
            finish();
        }
        //----------------------------------
        return false;
    }

    _searchDir(folder, pattern, depth) {
        let res = [];
        const dir = Gio.file_new_for_path(folder);
        let enumerator;
        try {
            enumerator = dir.enumerate_children(
                'standard::name,standard::type,standard::icon,standard::content-type,standard::is-hidden',
                                                                            Gio.FileQueryInfoFlags.NONE, null);
        } catch(e) {
            global.log('enumerator:', e.message);
        }

        let next;
        if (enumerator) {
            next = enumerator.next_file(null);
        }
        while (next) {
            this.filesSearched++;
            const filename = next.get_name();
            const isDirectory = next.get_file_type() === Gio.FileType.DIRECTORY;
            const filePath = folder + (folder === '/' ? '' : '/') + filename;
            if (filename.toLowerCase().startsWith(pattern)) {
                const file = Gio.file_new_for_path(filePath);
                //if file then treat as isFolderviewFile and if directory then treat as isPlace
                const foundFile = { name: filename,
                                    score: pattern.length > 2 ? 1.2 : 1.1,
                                    nameWithSearchMarkup: '<b>' + filename.substr(0, pattern.length) +
                                                                '</b>' + filename.substr(pattern.length),
                                    gicon: next.get_icon(),
                                    uri: file.get_uri(),
                                    mimeType: next.get_content_type(),
                                    description: filePath,
                                    isPlace: isDirectory,
                                    isFolderviewFile: !isDirectory,
                                    deleteAfterUse: true };
                if (isDirectory) {
                    const defaultInfo = Gio.AppInfo.get_default_for_type('inode/directory', false);
                    if (defaultInfo) {
                        foundFile.launch = () => { defaultInfo.launch([file], null); };
                    }
                }
                res.push(foundFile);
            }
            if (isDirectory && depth < 4 && !next.get_is_hidden() && this.filesSearched < 10000) {
                res = res.concat(this._searchDir(filePath, pattern, depth + 1));
            }
            next = enumerator.next_file(null);
        }
        if (enumerator) {
            enumerator.close(null);
        }
        return res;
    }
//-----Create display----
    _initDisplay() {
        this.displaySignals = new SignalManager(null);
        const sidebarPlacement = this.settings.sidebarPlacement;
        //==================bottomPane================
        this.sidebar = new Sidebar(this, sidebarPlacement);
        this.searchView = new SearchView(this);
        this.displaySignals.connect(this.searchView.searchEntryText, 'text-changed',
                                                        (...args) => this._onSearchTextChanged(...args));
        this.displaySignals.connect(this.searchView.searchEntryText, 'key-press-event',
                                                            (...args) => this._onMenuKeyPress(...args));
        this.bottomPane = new St.BoxLayout({});
        if (sidebarPlacement === PlacementTOP || sidebarPlacement === PlacementBOTTOM) {
            this.bottomPane.add(this.sidebar.sidebarOuterBox, { expand: false, x_fill: false, y_fill: false,
                                                  x_align: St.Align.START, y_align: St.Align.MIDDLE });
        }
        this.bottomPane.add(this.searchView.searchBox, { expand: true, x_fill: true, y_fill: false,
                                                    x_align: St.Align.END, y_align: St.Align.MIDDLE });
        //=================middlePane======================
        this.appsView = new AppsView(this);
        this.categoriesView = new CategoriesView(this);
        this.middlePane = new St.BoxLayout();
        if (sidebarPlacement === PlacementLEFT) {
            this.middlePane.add(this.sidebar.sidebarOuterBox, { expand: false, x_fill: false, y_fill: false,
                                                    x_align: St.Align.START, y_align: St.Align.MIDDLE });
        }
        this.middlePane.add(this.categoriesView.groupCategoriesWorkspacesScrollBox, { x_fill: false, y_fill: false,
                                                    x_align: St.Align.START, y_align: St.Align.START });
        this.middlePane.add(this.appsView.applicationsScrollBox, { x_fill: false, y_fill: false,
                                            x_align: St.Align.START, y_align: St.Align.START, expand: false });
        if (sidebarPlacement === PlacementRIGHT) {
            this.middlePane.add(this.sidebar.sidebarOuterBox, { expand: false, x_fill: false, y_fill: false,
                                                    x_align: St.Align.START, y_align: St.Align.MIDDLE });
        }
        //=============mainBox================
        //set style: 'spacing: 0px' so that extra space is not added to mainBox when contextMenuBox is
        //added. Only happens with themes that have set a spacing value on this node.
        this.mainBox = new St.BoxLayout({ style_class: 'menu-applications-outer-box', style: 'spacing: 0px;',
                                        vertical: true, reactive: true,
                                        show_on_set_parent: false });
        this.mainBox.add_style_class_name('menu-applications-box'); //this is to support old themes
        if (sidebarPlacement === PlacementTOP) {
            this.mainBox.add(this.bottomPane);
        }
        this.mainBox.add_actor(this.middlePane);
        if (sidebarPlacement !== PlacementTOP) {
            this.mainBox.add(this.bottomPane);
        }

        this.contextMenu = new ContextMenu(this);//Context menu is added to the stage by adding it to mainBox
        //=============menu================
        const section = new PopupMenuSection();
        section.actor.add_actor(this.mainBox);
        this.menu.addMenuItem(section);

        //if a blank part of the menu was clicked on, close context menu
        this.displaySignals.connect(this.mainBox, 'button-release-event',() => this.clearEnteredActors());

        //monitor mouse motion to prevent category mis-selection
        const onMouseMotion = (actor, event) => {
            //keep track of mouse motion to prevent misselection of another category button when moving mouse
            //pointer from selected category button to app button by calculating angle of pointer movement
            let [x, y] = event.get_coords();
            if (!this.mTrack) {
                this.mTrack = [];
            }
            //compare current position with oldest position in last 0.1 seconds.
            this.mTrack.push({time: Date.now(), x: x, y: y});//push current position onto array
            while (this.mTrack[0].time + 100 < Date.now()) {//remove positions older than 0.1 seconds ago
                this.mTrack.shift();
            }
            const dx = x - this.mTrack[0].x;
            const dy = Math.abs(y - this.mTrack[0].y);

            const tan = dx / dy;
            this.badAngle = tan > 0.3;//if tan = +infinity, badAngle is true.
                                      //if tan = -infinity or NaN, badAngle is false.
        };
        this.categoriesView.categoriesBox.set_reactive(true);
        this.displaySignals.connect(this.categoriesView.categoriesBox, 'motion-event',
                                                        (...args) => onMouseMotion(...args));

        //When sidebar is not on the left, limit excessive mainBox left padding + categoriesBox left
        //padding to 20px by subtracting the difference from categoriesBox left padding.
        if (sidebarPlacement !== PlacementLEFT) {
            const catLpadding = this.categoriesView.categoriesBox.get_theme_node().get_padding(3);
            const mainBoxLpadding = this.mainBox.get_theme_node().get_padding(3);
            const excessPadding = Math.max(catLpadding + mainBoxLpadding - 20, 0);//=total padding > 20px
            if (excessPadding > 0) {
                this.categoriesView.categoriesBox.style = `padding-left: ${
                                            Math.max(catLpadding - excessPadding, 0)}px; `;
            }
        }

        this.sidebar.populate();

        if (this.settings.applicationsViewMode === ApplicationsViewModeLIST) {
            this.appsView.applicationsGridBox.hide();
            this.appsView.applicationsListBox.show();
        } else {
            this.appsView.applicationsListBox.hide();
            this.appsView.applicationsGridBox.show();
        }

        //const vscroll = this.applicationsScrollBox.get_vscroll_bar();
        //const newScrollValue = this.applicationsScrollBox.get_allocation_box().y1;
        //vscroll.get_adjustment().set_value(newScrollValue);
        this.mainBox.show();
    }

    _destroyDisplayed() {
        this.displaySignals.disconnectAllSignals();
        this.searchView.destroy();
        this.searchView = null;
        this.appsView.destroy();
        this.appsView = null;
        this.sidebar.destroy();
        this.sidebar = null;
        this.categoriesView.destroy();
        this.categoriesView = null;
        this.contextMenu.destroy();
        this.contextMenu = null;
        this.bottomPane.destroy();
        this.middlePane.destroy();
        this.mainBox.destroy();
    }
//-----below are all functions creating app objects excluding _doSearch(), _searchDir() and
//-----listApplications() which is in Apps class.
    listFavoriteApps() {
        let res = this.appFavorites.getFavorites();
        res.forEach(favApp => {
            favApp.name = favApp.get_name();
            favApp.description = favApp.get_description();
            favApp.isApplication = true;
        });
        return res;
    }

    listRecent(pattern) {
        let res = [];
        //------add recent apps
        if (!pattern) {
            this.recentApps.getApps().forEach(recentId => {
                const app = this.apps.listApplications('all').find(app => app.id === recentId);
                if (app) {//Check because app may have been uninstalled
                    res.push(app);
                }
            });
        }

        //-----add recent files
        let {_infosByTimestamp} = this.recentManager;
        //_infosByTimestamp doesn't update synchronously so _infosByTimestamp may not be cleared even
        //if user has just cleared them.
        if (this.recentsJustCleared) {
            _infosByTimestamp = [];
            this.recentsJustCleared = false;
        }
        _infosByTimestamp.forEach(recentInfo => {
            /*if (!GLib.file_test(Gio.File.new_for_uri(recentInfo.uri).get_path(), GLib.FileTest.EXISTS)) {
                continue;
            }*/
            const found = this.appsView.buttonStore.find(button =>
                                            button.app.isRecentFile && button.app.uri === recentInfo.uri);
            if (found) {
                res.push(found.app);
            } else {
                recentInfo.description = Gio.File.new_for_uri(recentInfo.uri).get_path();
                recentInfo.isRecentFile = true;
                res.push(recentInfo);
            }
        });
        //----add "Clear list" button
        if (res.length > 0  && !pattern) {
            const clearRecentsButton = this.appsView.buttonStore.find(button => button.app.isClearRecentsButton);
            if (clearRecentsButton) {
                res.push(clearRecentsButton.app);
            } else {
                res.push( { name: _('Clear List'),
                            description: '',
                            icon: new St.Icon({ icon_name: 'edit-clear',
                                                icon_type: St.IconType.SYMBOLIC,
                                                icon_size: this.getAppIconSize()}),
                            isClearRecentsButton: true });
            }
        }

        if (pattern) {
            const _res = [];
            res.forEach(recentItem => {
                const match = searchStr(pattern, recentItem.name);
                if (recentItem.name && match.score > SEARCH_THRESHOLD) {
                    recentItem.score = match.score;
                    recentItem.nameWithSearchMarkup = match.result;
                    _res.push(recentItem);
                }
            });
            res = _res;
        }
        return res;
    }

    listPlaces(pattern) {
        let res = [];
        Main.placesManager.getAllPlaces().forEach(place => {
            let selectedAppId = place.idDecoded.substr(place.idDecoded.indexOf(':') + 1);
            const fileIndex = selectedAppId.indexOf('file:///');
            if (fileIndex !== -1) {
                selectedAppId = selectedAppId.substr(fileIndex + 7);
            }
            if (selectedAppId === 'home' || selectedAppId === 'desktop' || selectedAppId === 'connect') {
                selectedAppId = place.name;
            }
            place.isPlace = true;
            place.description = selectedAppId;
            res.push(place);
        });

        if (pattern) {
            const _res = [];
            res.forEach(place => {
                const match = searchStr(pattern, place.name);
                if (match.score > SEARCH_THRESHOLD) {
                    place.nameWithSearchMarkup = match.result;
                    place.score = match.score;
                    _res.push(place);
                }
            });
            res = _res;
        }
        return res;
    }

    listFavoriteFiles(pattern) {
        if (!XApp.Favorites) {
            return [];
        }
        let res = [];
        const favorite_infos = XApp.Favorites.get_default().get_favorites(null);
        favorite_infos.forEach(info => {
            res.push({  name: info.display_name,
                        description: Gio.File.new_for_uri(info.uri).get_path(),
                        gicon: Gio.content_type_get_icon(info.cached_mimetype),
                        isFavoriteFile: true,
                        mimeType: info.cached_mimetype,
                        uri: info.uri,
                        deleteAfterUse: true // favorite_infos returns new .app objs each
                                            //time so buttons cannot be reused.
                      });
        });

        res.sort( (a, b) => a.name.toLowerCase() > b.name.toLowerCase() );

        if (pattern) {
            const _res = [];
            res.forEach(item => {
                const match = searchStr(pattern, item.name);
                if (item.name && match.score > SEARCH_THRESHOLD) {
                    item.score = match.score;
                    item.nameWithSearchMarkup = match.result;
                    _res.push(item);
                }
            });
            res = _res;
        }
        return res;
    }

    listWebBookmarks(pattern) {
        let res = this.bookmarksManager.state;

        if (pattern) {
            const _res = [];
            res.forEach(bookmark => {
                        if (bookmark.name) {
                            const match = searchStr(pattern, bookmark.name);
                            if (match.score > SEARCH_THRESHOLD) {
                                bookmark.score = match.score;
                                bookmark.nameWithSearchMarkup = match.result;
                                _res.push(bookmark);
                            }
                        } });
            res = _res;
        }
        return res;
    }

    listFolder(folder) {
        const res = [];
        const dir = Gio.file_new_for_path(folder);
        let enumerator;
        let errorMsg = null;
        try {
            enumerator = dir.enumerate_children(
                    'standard::name,standard::type,standard::icon,standard::content-type,standard::is-hidden',
                                                                                                    0, null);
        } catch(e) {//folder access permission denied probably
            errorMsg = e.message;
        }
        let next;
        if (enumerator) {
            next = enumerator.next_file(null);
        }
        while (next) {
            const filename = next.get_name();
            if (this.settings.showHiddenFiles || !next.get_is_hidden()) {
                let file = Gio.file_new_for_path(folder + (folder === '/' ? '' : '/') + filename);
                const isDirectory = next.get_file_type() === Gio.FileType.DIRECTORY;
                res.push({  name: next.get_name(),
                            gicon: next.get_icon(),
                            uri: file.get_uri(),
                            mimeType: next.get_content_type(),
                            isFolderviewDirectory: isDirectory,
                            description: '',
                            isFolderviewFile: !isDirectory,
                            deleteAfterUse: true });
                file = null;
            }
            next = enumerator.next_file(null);
        }
        if (enumerator) {
            enumerator.close(null);
        }

        res.sort((a, b) => {    if (!a.isFolderviewDirectory && b.isFolderviewDirectory) return 1;
                                else if (a.isFolderviewDirectory && !b.isFolderviewDirectory) return -1;
                                else if (a.isFolderviewDirectory && b.isFolderviewDirectory &&
                                            a.name.startsWith('.') && !b.name.startsWith('.')) return 1;
                                else if (a.isFolderviewDirectory && b.isFolderviewDirectory &&
                                            !a.name.startsWith('.') && b.name.startsWith('.')) return -1;
                                else {
                                    const nameA = a.name.toLowerCase();
                                    const nameB = b.name.toLowerCase();
                                    return (nameA > nameB) ? 1 : ( (nameA < nameB) ? -1 : 0 );
                                } });
        const parent = dir.get_parent();
        if (parent) {// Add back button
            res.unshift({   name: 'Back',
                            uri: parent.get_uri(),
                            mimeType: 'inode/directory',
                            isBackButton: true,
                            description: '',
                            deleteAfterUse: true
                        });
        }

        return {results: res, errorMsg: errorMsg};
    }
}

class Apps {//This obj provides the .app objects for all the applications categories
    constructor(appThis) {
        this.appThis = appThis;
        this.appsByCategory = {};
        this.knownApps = [];
        this.newInstance = true;
        this.appsNeedRefresh = true;
    }

    installedChanged() {
        this.appsNeedRefresh = true;
    }

    _initAppCategories() {
        const apps_sort = arr => arr.sort( (a, b) => {
                        if (!a.name || !b.name) return -1;
                        return (a.name.toLowerCase() > b.name.toLowerCase()) ?
                                1 : (a.name.toLowerCase() < b.name.toLowerCase()) ? -1 : 0;  });
        const dirs = [];
        const iter = this.appThis.appSystem.get_tree().get_root_directory().iter();
        let nextType;
        while ((nextType = iter.next()) !== CMenu.TreeItemType.INVALID) {
            if (nextType === CMenu.TreeItemType.DIRECTORY) {
                dirs.push(iter.get_directory());
            }
        }

        dirs.forEach(dir => {
            if (!dir.get_is_nodisplay()) {
                const dirId = dir.get_menu_id();
                this.appsByCategory[dirId] = [];
                this._loadAppCategories(dir, null, dirId);
                apps_sort(this.appsByCategory[dirId]);
            }
        });
        //create "All applications" category
        let all = [];
        Object.keys(this.appsByCategory).forEach(key => {
                                            if (key !== 'all') {
                                                all = all.concat(this.appsByCategory[key]);
                                            } });
        this.appsByCategory.all = Array.from(new Set(all));//remove duplicates
        apps_sort(this.appsByCategory.all);

        this.appsNeedRefresh = false;
        this.newInstance = false;
    }

    _loadAppCategories(dir, rootDir, dirId) {
        const iter = dir.iter();
        let nextType;
        while ((nextType = iter.next()) !== CMenu.TreeItemType.INVALID) {
            if (nextType === CMenu.TreeItemType.ENTRY) {
                const entry = iter.get_entry();
                const appInfo = entry.get_app_info();
                if (appInfo && !appInfo.get_nodisplay()) {
                    const id = entry.get_desktop_file_id();
                    const app = this.appThis.appSystem.lookup_app(id);
                    let found = false;
                    if (rootDir && typeof rootDir.get_menu_id === 'function') {
                        const rootDirId = rootDir.get_menu_id();
                        if (rootDirId) {
                            this.appsByCategory[rootDirId].push(app);
                            found = true;
                        }
                    } else {
                        if (dirId) {
                            this.appsByCategory[dirId].push(app);
                            found = true;
                        }
                    }
                    if (found) {
                        app.name = app.get_name();
                        app.description = app.get_description();
                        app.isApplication = true;
                        app.id = app.get_id();
                    }
                    if (this.knownApps.indexOf(id) < 0) {//unknown app
                        if (!this.newInstance) {
                            app.newAppShouldHighlight = true;
                        }
                        this.knownApps.push(id);
                    }
                }
            } else if (nextType === CMenu.TreeItemType.DIRECTORY) {
                if (rootDir) {
                    this._loadAppCategories(iter.get_directory(), rootDir, null);
                } else {
                    this._loadAppCategories(iter.get_directory(), dir, dirId);
                }
            }
        }
    }

    listApplications(categoryMenuId, pattern) {
        if (this.appsNeedRefresh) {
            this._initAppCategories();
        }
        let res = this.appsByCategory[categoryMenuId];

        if (pattern) {
            const _res = [];
            res.forEach(app => {
                const keywords = app.get_keywords() || '';
                const id = app.id.replace(/\.desktop$/, '');
                const match1 = searchStr(pattern, app.name);
                const match2 = searchStr(pattern, app.description);
                match2.score *= 0.95; //slightly lower priority for description match
                const match3 = searchStr(pattern, keywords);
                match3.score *= 0.6; //low priority for keyword match
                const match4 = searchStr(pattern, id);
                match4.score *= 0.6; //low priority for id match
                const bestMatchScore = Math.max(match1.score, match2.score, match3.score, match4.score);
                if (bestMatchScore > SEARCH_THRESHOLD) {
                    app.score = bestMatchScore;
                    app.nameWithSearchMarkup = match1.result;
                    app.descriptionWithSearchMarkup = match2.result;
                    _res.push(app);
                }
            });
            res = _res;
        }
        return res;
    }
}

class RecentApps {// simple class to remember the last 3 used apps which are shown in the "recent" category
    constructor(appThis) {
        this.appThis = appThis;
    }

    add(appId) {
        const recentApps = this.appThis.settings.recentApps.slice();
        const duplicate = recentApps.indexOf(appId);
        if (duplicate > -1) {
            recentApps.splice(duplicate,1);
        }
        recentApps.unshift(appId);
        if (recentApps.length > 3) {
            recentApps.length = 3;
        }
        this.appThis.settings.recentApps = recentApps;
    }

    clear() {
        this.appThis.settings.recentApps = [];
    }

    getApps() {
        return this.appThis.settings.recentApps;
    }
}

/* Creates the categories box and array of CategoryButtons (buttons[]). Updates the categories and
 * populates the categoriesBox. */
class CategoriesView {
    constructor(appThis) {
        this.appThis = appThis;
        this.buttons = [];

        this.categoriesBox = new St.BoxLayout({ style_class: 'menu-categories-box', vertical: true });
        this.groupCategoriesWorkspacesWrapper = new St.BoxLayout({/*style: 'max-width: 185px;',*/ vertical: true });
        this.groupCategoriesWorkspacesWrapper.add(this.categoriesBox, {
                                              x_fill: false, y_fill: true,
                                              x_align: St.Align.START, y_align: St.Align.END,
                                              y_expand: true, expand: false });
        this.groupCategoriesWorkspacesScrollBox = new St.ScrollView({ x_fill: true, y_fill: false,
                                    y_align: St.Align.START, style_class: 'vfade menu-categories-scrollbox' });

        const vscrollCategories = this.groupCategoriesWorkspacesScrollBox.get_vscroll_bar();
        this.groupCategoriesWorkspacesScrollBox.add_actor(this.groupCategoriesWorkspacesWrapper);
        this.groupCategoriesWorkspacesScrollBox.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.NEVER);
        this.groupCategoriesWorkspacesScrollBox.set_auto_scrolling(this.appThis.settings.enableAutoScroll);
        this.groupCategoriesWorkspacesScrollBox.set_mouse_scrolling(true);
    }

    update() {
        //Put all enabled categories into newButtons[] in default order by reusing the
        //buttons in this.buttons[] or creating new button.
        const newButtons = [];

        let button = this.buttons.find(button => button.id === 'all');
        if (!button) {
            button = new CategoryButton(this.appThis, 'all', _('All applications'), 'computer');
        }
        newButtons.push(button);

        const dirs = [];
        const iter = this.appThis.appSystem.get_tree().get_root_directory().iter();
        let nextType;
        while ((nextType = iter.next()) !== CMenu.TreeItemType.INVALID) {
            if (nextType === CMenu.TreeItemType.DIRECTORY) {
                dirs.push(iter.get_directory());
            }
        }
        dirs.sort((a, b) => {
                        const prefCats = ['administration', 'preferences'];
                        const prefIdA = prefCats.indexOf(a.get_menu_id().toLowerCase());
                        const prefIdB = prefCats.indexOf(b.get_menu_id().toLowerCase());
                        if (prefIdA < 0 && prefIdB >= 0) return -1;
                        if (prefIdA >= 0 && prefIdB < 0) return 1;
                        const nameA = a.get_name().toLowerCase();
                        const nameB = b.get_name().toLowerCase();
                        return (nameA > nameB) ? 1 : ( (nameA < nameB) ? -1 : 0 );  });
        dirs.forEach(dir => {
                if (!dir.get_is_nodisplay()) {
                    const dirId = dir.get_menu_id();
                    const categoryApps = this.appThis.apps.listApplications(dirId);
                    if (categoryApps.length > 0) {
                        let button = this.buttons.find(button => button.id === dirId);
                        if (!button) {
                            button = new CategoryButton(this.appThis, dirId, dir.get_name(), null, dir.get_icon());
                        }
                        const newAppIndex = categoryApps.findIndex(app => app.newAppShouldHighlight);
                        button.setHighlight(newAppIndex >= 0);//highlight category if it contains a new app
                        newButtons.push(button);
                    }
                } });

        const enableFavFiles = XApp.Favorites && XApp.Favorites.get_default().get_favorites(null).length > 0;
        const homeDir = GLib.get_home_dir();
        [   [enableFavFiles, 'favorite_files', _('Favorites'), 'xapp-user-favorites'],
            [this.appThis.settings.showPlaces, 'places', _('Places'), 'folder'],
            [this.appThis.recentsEnabled, 'recents', _('Recent'), 'document-open-recent'],
            [this.appThis.settings.enableWebBookmarks, 'bookmarks', _('Bookmarks'), 'user-bookmarks'],
            [this.appThis.settings.showFavAppsCategory, 'favorite_apps', _('Favorite apps'), 'emblem-favorite'],
            [this.appThis.settings.showHomeFolder, homeDir,_('Home folder'), 'user-home']
        ].forEach(param => {
                if (param[0]) {
                    let button = this.buttons.find(button => button.id === param[1]);
                    if (!button) {
                        button = new CategoryButton(this.appThis, param[1], param[2], param[3]);
                    }
                    newButtons.push(button);
                } });
        //set user category order to default if none already
        if (this.appThis.settings.categories.length === 0) {
            this.appThis.settings.categories = newButtons.map( button => button.id);
        }
        //add new found categories to end of user category order
        newButtons.forEach(newButton => {
            if (this.appThis.settings.categories.indexOf(newButton.id) === -1) {
                this.appThis.settings.categories.push(newButton.id);
            }
        });
        //set this.buttons[] to newButtons[] in user prefered order
        this.buttons = [];
        this.appThis.settings.categories.forEach(buttonId => {
            const foundButton = newButtons.find(newButton => newButton.id === buttonId);
            if (foundButton) {
                this.buttons.push(foundButton);
            }
        });
        //populate categoriesBox with buttons
        this.categoriesBox.remove_all_children();
        this.buttons.forEach((button) => this.categoriesBox.add_actor(button.actor));
    }

    setSelectedCategoryStyle(categoryId) {
        this.buttons.forEach(categoryButton => {
                    if (categoryButton.id === categoryId) {
                        categoryButton.setButtonStyleSelected();
                    } else {
                        categoryButton.setButtonStyleNormal();
                    } });
    }

    destroy() {
        this.buttons.forEach(button => button.destroy());
        this.buttons = [];
        this.categoriesBox.destroy();
        this.groupCategoriesWorkspacesWrapper.destroy();
        this.groupCategoriesWorkspacesScrollBox.destroy();
    }
}

/*Creates and populates the main applications view. Takes .app objects and creates AppButton objs with
 *.app as a property. this.buttonStore[] array is used to store AppButton objs for performance only
 *otherwise new AppButton's would need to created each time a category is clicked on.*/
class AppsView {
    constructor(appThis) {
        this.appThis = appThis;
        this.buttonStore = [];
        this.appsViewSignals = new SignalManager(null);

        this.applicationsListBox = new St.BoxLayout({ vertical: true });
        this.applicationsGridBox = new Clutter.Actor({ layout_manager: new Clutter.GridLayout() });
        this.headerText = new St.Label({ style_class: 'menu-applications-header-text' });
        this.applicationsBoxWrapper = new St.BoxLayout({ style_class: 'menu-applications-inner-box',
                                                                                            vertical: true});
        this.applicationsBoxWrapper.add_style_class_name('menu-applications-box'); //this is to support old themes

        this.applicationsBoxWrapper.add(this.headerText, {  x_fill: false, y_fill: false,
                                                            x_align: St.Align.MIDDLE, y_align: St.Align.START });
        this.applicationsBoxWrapper.add(this.applicationsGridBox, { x_fill: false, y_fill: false,
                                                            x_align: St.Align.START, y_align: St.Align.START });
        this.applicationsBoxWrapper.add(this.applicationsListBox, { x_fill: true, y_fill: false,
                                                            x_align: St.Align.START, y_align: St.Align.START });
        this.applicationsScrollBox = new St.ScrollView({  x_fill: true, y_fill: false,
                            y_align: St.Align.START, style_class: 'vfade menu-applications-scrollbox' });
        const vscrollApplications = this.applicationsScrollBox.get_vscroll_bar();
        this.appsViewSignals.connect(vscrollApplications, 'scroll-start',
                                                                () => { this.appThis.menu.passEvents = true; });
        this.appsViewSignals.connect(vscrollApplications, 'scroll-stop',
                                                                () => { this.appThis.menu.passEvents = false; });
        this.applicationsScrollBox.add_actor(this.applicationsBoxWrapper);
        this.applicationsScrollBox.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC);
        this.applicationsScrollBox.set_auto_scrolling(this.appThis.settings.enableAutoScroll);
        this.applicationsScrollBox.set_mouse_scrolling(true);
    }

    populate(appList, headerText = null) {
        let column = 0;
        let rownum = 0;

        this.applicationsListBox.hide();//hide while populating for performance.
        this.applicationsGridBox.hide();//

        this.clearApps();
        //too many actors in applicationsGridBox causes display errors, don't know why. Plus, it takes a long time
        if (appList.length > 1000) {
            appList.length = 1000; //truncate array
            headerText = _('Too many entries - showing first 1000 entries only');
        }
        if (headerText) {
            this.headerText.set_text(headerText);
            this.headerText.show();
        } else {
            this.headerText.hide();
        }
        appList.forEach(app => {
            let appButton = this.buttonStore.find(button => button.app === app);

            if (!appButton) {
                appButton = new AppButton(this.appThis, app);
                this.buttonStore.push(appButton);
            }
            if (this.appThis.settings.applicationsViewMode === ApplicationsViewModeLIST) {
                this.applicationsListBox.add_actor(appButton.actor);
            } else {
                const gridLayout = this.applicationsGridBox.layout_manager;
                appButton.setGridButtonWidth();// In case menu has been resized.
                gridLayout.attach(appButton.actor, column, rownum, 1, 1);
                column++;

                if (column > this.getGridValues().columns - 1) {
                    column = 0;
                    rownum++;
                }
            }
        });
        if (this.appThis.settings.applicationsViewMode === ApplicationsViewModeLIST) {
            this.applicationsListBox.show();
        } else {
            this.applicationsGridBox.show();
        }

        this.currentGridViewColumnCount = this.getGridValues().columns;
    }

    resizeGrid() {
        this.applicationsGridBox.hide();//for performance
        const newcolumnCount = this.getGridValues().columns;
        if (this.currentGridViewColumnCount === newcolumnCount) {
            //Number of columns are the same so just adjust button widths only.
            this.applicationsGridBox.get_children().forEach(actor =>
                                                    actor.width = this.getGridValues().columnWidth );
        } else {//Rearrange buttons to fit new number of columns.
            const buttons = this.applicationsGridBox.get_children();
            this.applicationsGridBox.remove_all_children();
            let column = 0;
            let rownum = 0;
            const gridLayout = this.applicationsGridBox.layout_manager;
            const newColumnWidth = this.getGridValues().columnWidth;
            buttons.forEach(actor => {
                actor.width = newColumnWidth;
                gridLayout.attach(actor, column, rownum, 1, 1);
                column++;
                if (column > newcolumnCount - 1) {
                    column = 0;
                    rownum++;
                }
            });
        }
        this.applicationsGridBox.show();
        this.currentGridViewColumnCount = newcolumnCount;
    }

    getGridValues() {
        const appsBoxWidth = this.applicationsGridBox.width;
        const minColumnWidth = Math.max(140, this.appThis.settings.appsGridIconSize * 1.2);
        const columns = Math.floor(appsBoxWidth / (minColumnWidth * global.ui_scale));
        const columnWidth = Math.floor(appsBoxWidth / columns);

        return {columnWidth: columnWidth, columns: columns};
    }

    getActiveButtons() {
        const buttons = [];
        this.getActiveContainer().get_children().forEach(child =>
            buttons.push(this.buttonStore.find(button => button.actor === child) ));
        return buttons;
    }

    clearApps() {
        this.clearAppsViewEnteredActors();
        this.getActiveContainer().remove_all_children();
    }

    clearAppsViewEnteredActors() {
        this.getActiveButtons().forEach(button => { if (button.entered) button.handleLeave(); });
    }

    getActiveContainer() {
        return this.appThis.settings.applicationsViewMode === ApplicationsViewModeLIST ?
                                                this.applicationsListBox : this.applicationsGridBox;
    }

    buttonStoreCleanup() {
        //delete all buttons which won't be reused
        const buttonStore = this.buttonStore.filter(button => {
            if (button.app.deleteAfterUse) {
                button.destroy();
                return false;
            } else {
                return true;
            } });
        this.buttonStore = buttonStore;
    }

    destroy() {
        this.appsViewSignals.disconnectAllSignals();
        this.headerText.destroy();
        this.applicationsListBox.destroy();
        this.applicationsGridBox.destroy();
        this.applicationsBoxWrapper.destroy();
        this.applicationsScrollBox.destroy();
        this.buttonStore.forEach(button => { if (button) button.destroy(); });
        this.buttonStore = [];
    }
}

class SearchView {
    constructor(appThis) {
        this.appThis = appThis;
        this.searchInactiveIcon = new St.Icon({ style_class: 'menu-search-entry-icon', icon_name: 'edit-find' });
        this.searchActiveIcon = new St.Icon({ style_class: 'menu-search-entry-icon', icon_name: 'edit-clear' });
        this.searchEntry = new St.Entry({ name: 'menu-search-entry', track_hover: true, can_focus: true});
        this.searchEntryText = this.searchEntry.clutter_text;
        this.searchEntry.set_primary_icon(this.searchInactiveIcon);
        this.searchBox = new St.BoxLayout({ style_class: 'menu-search-box' });
        this.searchBox.add(this.searchEntry, { expand: true, x_align: St.Align.START, y_align: St.Align.MIDDLE });
    }

    showAndConnectSecondaryIcon() {
        this.searchEntry.set_secondary_icon(this.searchActiveIcon);
        this.appThis.signals.connect(this.searchEntry, 'secondary-icon-clicked', () => { //todo
                                                                    this.searchEntryText.set_text('');});
    }

    hideAndDisconnectSecondaryIcon() {
        this.searchEntry.set_secondary_icon(null);
        this.appThis.signals.disconnect('secondary-icon-clicked', this.searchEntry);
    }

    tweakTheme() {
        this.searchBox.style = 'min-width: 160px; ';

        //make searchBox l/r padding & margin symmetrical when it uses the full width of the menu.
        if (this.appThis.settings.sidebarPlacement === PlacementRIGHT ||
                                        this.appThis.settings.sidebarPlacement === PlacementLEFT) {
            //set left padding of searchBox to match right padding
            const searchBoxNode = this.searchBox.get_theme_node();
            const searchBoxPaddingRight = searchBoxNode.get_padding(1);
            this.searchBox.style += `padding-left: ${searchBoxPaddingRight}px; `;

            //deal with uneven searchBox margins and uneven mainBox paddings by setting searchBox margins.
            const searchBoxRightMargin = searchBoxNode.get_margin(3);
            const mainBoxNode = this.appThis.mainBox.get_theme_node();
            const mainBoxPaddingRight = mainBoxNode.get_padding(1);
            const mainBoxPaddingLeft = mainBoxNode.get_padding(3);
            const newMargin = Math.max(searchBoxRightMargin, mainBoxPaddingRight, mainBoxPaddingLeft);
            this.searchBox.style += `margin-left: ${newMargin - mainBoxPaddingLeft}px; ` +
                                                `margin-right: ${newMargin - mainBoxPaddingRight}px; `;
        }
    }

    destroy() {
        this.searchInactiveIcon.destroy();
        this.searchActiveIcon.destroy();
        this.searchEntry.destroy();
        this.searchBox.destroy();
    }

}

class Sidebar {//Creates the sidebar and populates it with SidebarButtons
    constructor (appThis, sidebarPlacement) {
        this.appThis = appThis;
        this.items = [];
        this.innerBox = new St.BoxLayout({
                        vertical: (sidebarPlacement === PlacementLEFT || sidebarPlacement === PlacementRIGHT) });
        //Cinnamox themes draw a border at the bottom of sidebarScrollBox so remove menu-favorites-scrollbox class.
        let themePath = Main.getThemeStylesheet();
        if (!themePath) themePath = '';
        const scroll_style = themePath.includes('Cinnamox') ? 'vfade' : 'vfade menu-favorites-scrollbox';
        this.sidebarScrollBox = new St.ScrollView({x_fill: true, y_fill: false, x_align: St.Align.MIDDLE,
                                                        y_align: St.Align.MIDDLE, style_class: scroll_style });

        const vscroll_bar = this.sidebarScrollBox.get_vscroll_bar();
        this.sidebarScrollBox.add_actor(this.innerBox);
        this.sidebarScrollBox.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.NEVER);
        this.sidebarScrollBox.set_auto_scrolling(this.appThis.settings.enableAutoScroll);
        this.sidebarScrollBox.set_mouse_scrolling(true);
        const style_class = this.appThis.settings.useBoxStyle ? 'menu-favorites-box' : '';
        this.sidebarOuterBox = new St.BoxLayout({style_class: style_class});
        this.sidebarOuterBox.add(this.sidebarScrollBox, { expand: false, x_fill: false, y_fill: false,
                                                x_align: St.Align.MIDDLE, y_align: St.Align.MIDDLE });
        this.separator = new St.BoxLayout({x_expand: false, y_expand: false});
    }

    populate () {
        this.innerBox.remove_all_children();
        this.items.forEach(item => item.destroy());
        this.items = [];
        //----add session buttons to this.items[]
        const newSessionIcon = (iconName) => {
            return new St.Icon( { icon_name: iconName, icon_size: this.appThis.settings.sidebarIconSize,
                          icon_type: this.appThis.settings.sidebarIconSize <= 24 ? St.IconType.SYMBOLIC :
                                                                                    St.IconType.FULLCOLOR });
        };
        this.items.push(new SidebarButton( this.appThis, newSessionIcon('system-shutdown'), null, _('Quit'),
                    _('Shutdown the computer'), () => { Util.spawnCommandLine('cinnamon-session-quit --power-off');
                                                                this.appThis.closeMenu(); } ));
        this.items.push(new SidebarButton( this.appThis, newSessionIcon('system-log-out'), null, _('Logout'),
                                    _('Leave the session'), () => { Util.spawnCommandLine('cinnamon-session-quit');
                                                                        this.appThis.closeMenu(); } ));
        this.items.push(new SidebarButton( this.appThis, newSessionIcon('system-lock-screen'), null, _('Lock screen'),
                    _('Lock the screen'), () => {
                        const screensaver_settings = new Gio.Settings({
                                                    schema_id: 'org.cinnamon.desktop.screensaver' });
                        const screensaver_dialog = Gio.file_new_for_path('/usr/bin/cinnamon-screensaver-command');
                        if (screensaver_dialog.query_exists(null)) {
                            if (screensaver_settings.get_boolean('ask-for-away-message')) {
                                Util.spawnCommandLine('cinnamon-screensaver-lock-dialog');
                            } else {
                                Util.spawnCommandLine('cinnamon-screensaver-command --lock');//
                            }
                        } else {
                            this.screenSaverProxy.LockRemote('');
                        }
                        this.appThis.closeMenu(); }));
        //----add favorite apps and favorite files to this.items[]
        if (this.appThis.settings.addFavorites) {
            this.appThis.listFavoriteApps().forEach(fav => {
                this.items.push(new SidebarButton( this.appThis,
                                fav.create_icon_texture(this.appThis.settings.sidebarIconSize),
                                        fav, fav.name, fav.description, null));
            });
            this.appThis.listFavoriteFiles().forEach(fav => {
                let gicon = getThumbnail_gicon(fav.uri, fav.mimeType) || fav.gicon;
                this.items.push(new SidebarButton( this.appThis,
                                new St.Icon({ gicon: gicon, icon_size: this.appThis.settings.sidebarIconSize}),
                                fav, fav.name, fav.description, null));
            });
        }
        //----change order of all items depending on buttons placement
        const reverseOrder = this.appThis.settings.sidebarPlacement === PlacementLEFT ||
                                                this.appThis.settings.sidebarPlacement === PlacementRIGHT;
        if (reverseOrder) {
            this.items.reverse();
        }
        //----populate box with items[]
        for (let i = 0; i < this.items.length; i++) {
            if ((reverseOrder && i == this.items.length - 3 && this.items.length > 3) ||
                        (!reverseOrder && i === 3 && this.items.length > 3)){
                this._addSeparator();
            }
            this.innerBox.add(this.items[i].actor, { x_fill: false, y_fill: false,
                                                        x_align: St.Align.MIDDLE, y_align: St.Align.MIDDLE });
        }
        return;
    }

    _addSeparator() {
        this.innerBox.add(this.separator, { x_fill: false, y_fill: false, x_align: St.Align.MIDDLE,
                                                                                y_align: St.Align.MIDDLE });
        let width = this.appThis.settings.sidebarIconSize + 8;
        let height = 2;
        if (this.appThis.settings.sidebarPlacement === PlacementTOP ||
                                        this.appThis.settings.sidebarPlacement === PlacementBOTTOM) {
            [width, height] = [height, width];
        }
        this.separator.style = `width: ${width}px; height: ${height}px; background-color: ${
                    this.appThis.getThemeForegroundColor()}; margin: 1px; border: 0px; border-radius: 10px; `;
        this.separator.set_opacity(35);
    }

    getButtons() {
        return this.items;
    }

    clearSidebarEnteredActors() {
        const foundItem = this.items.findIndex(button => button.entered);
        if (foundItem > -1) {
            this.items[foundItem].handleLeave();
        }
    }

    destroy() {
        this.items.forEach(item => item.destroy());
        this.items = null;
        this.separator.destroy();
        this.innerBox.destroy();
        this.sidebarScrollBox.destroy();
        this.sidebarOuterBox.destroy();
    }
}

function main(metadata, orientation, panel_height, instance_id) {
    return new CinnamenuApplet(metadata, orientation, panel_height, instance_id);
}
