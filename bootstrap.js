/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/AddonManager.jsm");

// This will contain the file:// uri pointing to bartab.css
let css_uri;

let skipUpstreamCheck;

const ONTAB_ATTR = "bartab-ontab";
const ON_DEMAND_PREF = "browser.sessionstore.restore_on_demand";
const BACKUP_ON_DEMAND_PREF = "extensions.bartab.backup_on_demand";
const CONCURRENT_TABS_PREF = "browser.sessionstore.max_concurrent_tabs";
const BACKUP_CONCURRENT_PREF = "extensions.bartab.backup_concurrent_tabs";
const SKIP_UPSTREAM_CHECK_PREF = "extensions.bartab.skip_upstream_check";
const NS_XUL = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

XPCOMUtils.defineLazyServiceGetter(this, "gSessionStore",
                                   "@mozilla.org/browser/sessionstore;1",
                                   "nsISessionStore");

/**
 * Load and execute another file.
 */
let GLOBAL_SCOPE = this;
function include(src) {
  Services.scriptloader.loadSubScript(src, GLOBAL_SCOPE);
}

/**
 * Lots of rubbish that's necessary because we're a restartless add-on
 * (no default preferences, no chrome manifest)
 */
function startup(data, reason) {
  setupBackupPref();

  // Register the resource://bartablite/ mapping
  let res = Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler);
  res.setSubstitution("bartablite", Services.io.newURI(__SCRIPT_URI_SPEC__ + "/../", null, null));

  if (Services.prefs.prefHasUserValue(SKIP_UPSTREAM_CHECK_PREF)) {
    skipUpstreamCheck = Services.prefs.getBoolPref(SKIP_UPSTREAM_CHECK_PREF);
  }

  AddonManager.getAddonByID(data.id, function(addon) {
    css_uri = addon.getResourceURI("bartab.css").spec;

    // include pullstarter.js
    include(addon.getResourceURI("pullstarter.js").spec);

    // Register BarTabLite handler for all existing windows and windows
    // that will still be opened.
    PullStarter.watchWindows("navigator:browser", loadIntoWindow);
    PullStarter.watchWindows("navigator:browser", detectUpstream);
  });
}

function shutdown(data, reason) {
  if (reason == APP_SHUTDOWN) {
    return;
  }

  restoreBackupPref();

  PullStarter.unload();

  // Clear our resource registration
  let res = Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler);
  res.setSubstitution("bartablite", null);
}

function install(data, reason) {
}

function loadIntoWindow(win) {
  // Load stylesheet.
  let pi = win.document.createProcessingInstruction(
    "xml-stylesheet", "href=\"" + css_uri + "\" type=\"text/css\"");
  win.document.insertBefore(pi, win.document.firstChild);
  PullStarter.registerUnloader(function () {
    win.document.removeChild(pi);
  }, win);

  // Install BarTabLite hook.
  let barTabLite = new BarTabLite(win.gBrowser);
  PullStarter.registerUnloader(barTabLite.unload.bind(barTabLite), win);
}

function setupBackupPref() {
  let value;
  let done;
  if (!Services.prefs.prefHasUserValue(BACKUP_ON_DEMAND_PREF)) {
    try {
      value = Services.prefs.getBoolPref(ON_DEMAND_PREF);
    } catch (e) {};
    if (typeof(value) !== "undefined") {
      Services.prefs.setBoolPref(BACKUP_ON_DEMAND_PREF, value);
      Services.prefs.setBoolPref(ON_DEMAND_PREF, true);
      done = true;
    }
  } else {
    done = true;
  }
  if (!done && !Services.prefs.prefHasUserValue(BACKUP_CONCURRENT_PREF)) {
    Services.prefs.setIntPref(
      BACKUP_CONCURRENT_PREF, Services.prefs.getIntPref(CONCURRENT_TABS_PREF));
    Services.prefs.setIntPref(CONCURRENT_TABS_PREF, 0);
  }
}

function restoreBackupPref() {
  if (Services.prefs.prefHasUserValue(BACKUP_ON_DEMAND_PREF)) {
    Services.prefs.setBoolPref(
      ON_DEMAND_PREF, Services.prefs.getBoolPref(BACKUP_ON_DEMAND_PREF));
    Services.prefs.clearUserPref(BACKUP_ON_DEMAND_PREF);
  }
  else if (Services.prefs.prefHasUserValue(BACKUP_CONCURRENT_PREF)) {
    Services.prefs.setIntPref(
      CONCURRENT_TABS_PREF, Services.prefs.getIntPref(BACKUP_CONCURRENT_PREF));
    Services.prefs.clearUserPref(BACKUP_CONCURRENT_PREF);
  }
}

function detectUpstream(win) {
  if (skipUpstreamCheck)
    return;

  skipUpstreamCheck = true;

  function disableExtension(addon) {
    addon.userDisabled = true;
  }
  
  AddonManager.getAddonByID("bartablite@philikon.de", function(addon){
    if (addon) {
      if (addon.isActive) {
        let { gBrowser, PopupNotifications } = win;

        let disableThat = {
          label: "Disable the other one!",
          callback: function() {
            disableExtension(addon);
          },
          accessKey: "D"
        };

        let disableThis = {
          label: "Disable this one!",
          callback: function() {
            AddonManager.getAddonByID("bartablitex@szabolcs.hubai", function(addon){
              disableExtension(addon);
            });
          },
          accessKey: "T"
        };

        let leaveItUp = {
          label: "Leave it as is!",
          callback: function() {
            Services.prefs.setBoolPref(SKIP_UPSTREAM_CHECK_PREF, true);
          },
          accessKey: "L"
        };

        let secondaryActions = [ disableThis, leaveItUp ];
        
        let options = {
          timeout: Date.now() + 30000,
          persistWhileVisible: true,
        };

        let message = "An other (maybe the original) version of Bartab Lite is running.\n" +
          "It's recommended not to run both simultaneously to avoid interfering.\n" +
          "Should I disable one of them?"
        ;

        PopupNotifications.show(gBrowser.selectedBrowser, "bartab-upstream-popup",
          message, null /* anchor ID */,
          disableThat, secondaryActions,
          options
        );
      }
    }
  });
}


/**
 * This handler attaches to the tabbrowser.  It listens to various tab
 * related events.
 */
function BarTabLite(aTabBrowser) {
  this.init(aTabBrowser);
}
BarTabLite.prototype = {

  init: function(aTabBrowser) {
    this.tabBrowser = aTabBrowser;
    aTabBrowser.BarTabLite = this;
    let document = aTabBrowser.ownerDocument;
    document.addEventListener('SSTabRestoring', this, false);

    // hook tabs
    let tabs = aTabBrowser.tabs;
    for (let index = 0; index < tabs.length; index++) {
      let tab = tabs[index];
      if (tab && !tab.selected && typeof(tab._barTabRestoreProgressListener) !== "function") {
        let linkedBrowser = tab.linkedBrowser;
        let tabStillLoading = linkedBrowser.__SS_tabStillLoading ||
          linkedBrowser.__SS_data && linkedBrowser.__SS_data._tabStillLoading;
        if (!tabStillLoading) {
          continue;
        }

        (new BarTabRestoreProgressListener()).setup(tab);
      }
    }

    // add "Unload Tab" menuitem to tab context menu
    let menuitem_unloadTab = document.createElementNS(NS_XUL, "menuitem");
    menuitem_unloadTab.setAttribute("id", "bartab-unloadtab");
    menuitem_unloadTab.setAttribute("label", "Unload Tab"); // TODO l10n
    menuitem_unloadTab.setAttribute("tbattr", "tabbrowser-multiple");
    menuitem_unloadTab.setAttribute(
      "oncommand", "gBrowser.BarTabLite.unloadTab(gBrowser.mContextTab);");
    let tabContextMenu = document.getElementById("tabContextMenu");
    tabContextMenu.insertBefore(menuitem_unloadTab,
                                tabContextMenu.childNodes[1]);
    tabContextMenu.addEventListener('popupshowing', this, false);
  },

  unload: function() {
    let tabBrowser = this.tabBrowser;
    let document = tabBrowser.ownerDocument;
    document.removeEventListener('SSTabRestoring', this, false);

    // remove tab context menu related stuff
    let menuitem_unloadTab = document.getElementById("bartab-unloadtab");
    if (menuitem_unloadTab && menuitem_unloadTab.parentNode) {
      menuitem_unloadTab.parentNode.removeChild(menuitem_unloadTab);
    }
    let tabContextMenu = document.getElementById("tabContextMenu");
    tabContextMenu.removeEventListener('popupshowing', this, false);

    // unhook tabs
    let tabs = tabBrowser.tabs;
    for (let index = 0; index < tabs.length; index++) {
      let tab = tabs[index];
      if (tab && tab._barTabRestoreProgressListener) {
        tab._barTabRestoreProgressListener.cleanup();
      }
    }
    delete tabBrowser.BarTabLite;
  },

  handleEvent: function(aEvent) {
    switch (aEvent.type) {
      case 'SSTabRestoring':
        this.onTabRestoring(aEvent);
        return;
      case 'popupshowing':
        this.onPopupShowing(aEvent);
        return;
    }
  },

  /**
   * Handle the 'SSTabRestoring' event from the nsISessionStore service
   * and mark tabs that haven't loaded yet.
   */
  onTabRestoring: function(aEvent) {
    let tab = aEvent.originalTarget;
    if (tab.selected || tab.getAttribute(ONTAB_ATTR) == "true") {
      return;
    }
    (new BarTabRestoreProgressListener()).setup(tab);
  },

  /**
   * Handle the 'popupshowing' event from "tabContextMenu"
   * and disable "Unload Tab" if the context menu was opened on a pending tab.
   */
  onPopupShowing: function(aEvent) {
    let tabContextMenu = aEvent.originalTarget;
    let document = tabContextMenu.ownerDocument;
    let tab = tabContextMenu.contextTab;
    tab = tab || tabContextMenu.triggerNode.localName == "tab" ?
                 tabContextMenu.triggerNode : this.tabBrowser.selectedTab;
    let menuitem_unloadTab = document.getElementById("bartab-unloadtab");
    if (menuitem_unloadTab) {
      if (tab.getAttribute(ONTAB_ATTR) == "true") {
        menuitem_unloadTab.setAttribute("disabled", "true");
      } else {
        menuitem_unloadTab.removeAttribute("disabled");
      }
    }
  },

  /**
   * Unload a tab.
   */
  unloadTab: function(aTab) {
    // Ignore tabs that are already unloaded or are on the host whitelist.
    if (aTab.getAttribute(ONTAB_ATTR) == "true") {
      return;
    }

    let tabbrowser = this.tabBrowser;

    // Make sure that we're not on this tab.  If we are, find the
    // closest tab that isn't on the bar tab.
    if (aTab.selected) {
      let activeTab = this.findClosestLoadedTab(aTab);
      if (activeTab) {
        tabbrowser.selectedTab = activeTab;
      }
    }

    let state = gSessionStore.getTabState(aTab);
    let newtab = tabbrowser.addTab(null, {skipAnimation: true});
    // If we ever support a mode where 'browser.sessionstore.max_concurrent_tabs'
    // wasn't set to 0, we'd have to do some trickery here.
    gSessionStore.setTabState(newtab, state);

    // Move the new tab next to the one we're removing, but not in
    // front of it as that confuses Tree Style Tab.
    tabbrowser.moveTabTo(newtab, aTab._tPos + 1);

    // Restore tree when using Tree Style Tab
    if (tabbrowser.treeStyleTab) {
      let parent = tabbrowser.treeStyleTab.getParentTab(aTab);
      if (parent) {
        tabbrowser.treeStyleTab.attachTabTo(newtab, parent,
          {dontAnimate: true, insertBefore: aTab.nextSibling});
      }
      let children = tabbrowser.treeStyleTab.getChildTabs(aTab);
      children.forEach(function(aChild) {
        tabbrowser.treeStyleTab.attachTabTo(
          aChild, newtab, {dontAnimate: true});
      });
    }

    // Close the original tab.  We're taking the long way round to
    // ensure the nsISessionStore service won't save this in the
    // recently closed tabs.
    if (tabbrowser._beginRemoveTab(aTab, true, null, false)) {
      tabbrowser._endRemoveTab(aTab);
    }
  },

  unloadOtherTabs: function(aTab) {
    let tabbrowser = this.tabBrowser;

    // Make sure we're sitting on the tab that isn't going to be unloaded.
    if (tabbrowser.selectedTab != aTab) {
      tabbrowser.selectedTab = aTab;
    }

    // unloadTab() mutates the tabs so the only sane thing to do is to
    // copy the list of tabs now and then work off that list.
    //TODO can we use Array.slice() here?
    let tabs = [];
    for (let i = 0; i < tabbrowser.mTabs.length; i++) {
      tabs.push(tabbrowser.mTabs[i]);
    }
    for (let i = 0; i < tabs.length; i++) {
      if (tabs[i] != aTab) {
        this.unloadTab(tabs[i]);
      }
    }
  },

  /*
   * In relation to a given tab, find the closest tab that is loaded.
   * Note: if there's no such tab available, this will return unloaded
   * tabs as a last resort.
   */
  findClosestLoadedTab: function(aTab) {
    let visibleTabs = this.tabBrowser.visibleTabs;

    // Shortcut: if this is the only tab available, we're not going to
    // find another active one, are we...
    if (visibleTabs.length == 1) {
      return null;
    }

    // The most obvious choice would be the owner tab, if it's active and is
    // part of the same tab group.
    if (aTab.owner
        && Services.prefs.getBoolPref("browser.tabs.selectOwnerOnClose")
        && aTab.owner.getAttribute(ONTAB_ATTR) != "true") {
      let i = 0;
      while (i < visibleTabs.length) {
        if (visibleTabs[i] == aTab.owner) {
          return aTab.owner;
        }
        i++;
      }
    }

    // Otherwise walk the list of visible tabs and see if we can find an
    // active one.
    // To do that, first we need the index of the current tab in the visible-
    // tabs array.
    // However, if the current tab is being closed, it's already been removed
    // from that array. Therefore, we have to also accept its next-higher
    // sibling, if one is found. If one isn't, then the current tab was at
    // the end of the visible-tabs array, and the new end-of-array tab is the
    // best choice for a substitute index.
    let tabIndex = 0;
    while (tabIndex + 1 < visibleTabs.length &&
           visibleTabs[tabIndex] != aTab &&
           visibleTabs[tabIndex] != aTab.nextSibling) {
      // This loop will result in tabIndex pointing to one of three places:
      //    The current tab (visibleTabs[i] == aTab)
      //    The tab which had one index higher than the current tab, until the
      //      current tab was closed (visibleTabs[i] == aTab.nextSibling)
      //    The final tab in the array (tabIndex + 1 == visibleTabs.length)
      tabIndex++;
    }

    let i = 0;
    while ((tabIndex - i >= 0) ||
           (tabIndex + i < visibleTabs.length)) {
      let offsetIncremented = 0;
      if (tabIndex + i < visibleTabs.length) {
        if (visibleTabs[tabIndex + i].getAttribute(ONTAB_ATTR) != "true" &&
            visibleTabs[tabIndex + i] != aTab) {
          // The '!= aTab' test is to rule out the case where i == 0 and
          // aTab is being unloaded rather than closed, so that tabIndex
          // points to aTab instead of its nextSibling.
          return visibleTabs[tabIndex + i];
        }
      }
      if(i == 0 && visibleTabs[tabIndex] != aTab) {
        // This is ugly, but should work.
        // If aTab has been closed, and nextSibling is unloaded, then we
        // have to check previousSibling before the next loop, or we'll take
        // nextSibling.nextSibling (if loaded) over previousSibling, which is
        // closer to the true "x.5" tabIndex offset.
        offsetIncremented = 1;
        i++;
      }
      if (tabIndex - i >= 0) {
        if(visibleTabs[tabIndex - i].getAttribute(ONTAB_ATTR) != "true" &&
           visibleTabs[tabIndex - i] != aTab) {
          return visibleTabs[tabIndex - i];
        }
      }
      if(offsetIncremented > 0) {
        offsetIncremented = 0;
        i--;
      }
      i++;
    }

    // Fallback: there isn't an active tab available, so we're going
    // to have to nominate a non-active one.

    // Start with the owner, if appropriate.
    if (aTab.owner &&
        Services.prefs.getBoolPref("browser.tabs.selectOwnerOnClose")) {
      let i = 0;
      while (i < visibleTabs.length) {
        if (visibleTabs[i] == aTab.owner) {
          return aTab.owner;
        }
        i++;
      }
    }
    // Otherwise, fall back to one of the adjacent tabs.
    if (tabIndex < visibleTabs.length &&
        visibleTabs[tabIndex] != aTab) {
      // aTab was closed, so the tab at its previous index is the correct
      // first choice
      return visibleTabs[tabIndex];
    }
    if (tabIndex + 1 < visibleTabs.length) {
      return visibleTabs[tabIndex + 1];
    }
    if (tabIndex - 1 >= 0) {
      return visibleTabs[tabIndex - 1];
    }

    // If we get this far, something's wrong. It shouldn't be possible for
    // there to not be an adjacent tab unless (visibleTabs.length == 1).
    Cu.reportError("BarTab Lite X: there are " + visibleTabs.length + " visible tabs, which is greater than 1, but no suitable tab was found from index " + tabIndex);
    return null;
  }
};


/**
 * Progress listener for tabs that are being restored but haven't
 * loaded yet.
 */
function BarTabRestoreProgressListener () {}
BarTabRestoreProgressListener.prototype = {

  hook: function (aTab) {
    this._tab = aTab;
    aTab._barTabRestoreProgressListener = this;
    aTab.linkedBrowser.webProgress.addProgressListener(
      this, Ci.nsIWebProgress.NOTIFY_STATE_NETWORK);
  },

  unhook: function () {
    this._tab.linkedBrowser.webProgress.removeProgressListener(this);
    delete this._tab._barTabRestoreProgressListener;
    delete this._tab;
  },

  setup: function(aTab) {
    aTab.setAttribute(ONTAB_ATTR, "true");
    this.hook(aTab);
  },

  cleanup: function() {
    this._tab.removeAttribute(ONTAB_ATTR);
    this.unhook();
  },

  /*** nsIWebProgressListener ***/

  onStateChange: function (aWebProgress, aRequest, aStateFlags, aStatus) {
    this.cleanup();
  },
  onProgressChange: function () {},
  onLocationChange: function () {},
  onStatusChange:   function () {},
  onSecurityChange: function () {},

  QueryInterface: XPCOMUtils.generateQI([Ci.nsIWebProgressListener,
                                         Ci.nsISupportsWeakReference])
};
