/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");
Components.utils.import("resource://gre/modules/Services.jsm");

/**
 * A collection of helpers that allow you to register various things while
 * making sure that they clean up after themselves when the add-on gets
 * unloaded or its context (e.g. DOM windows) get destroyed otherwise.
 * 
 * Call the various PullStarter.register* methods from your startup() function
 * and/or other places in your code.
 */
let PullStarter = {

  /**
   * Unload everything that has been registered with PullStarter.
   * This is called in PullStarter's default shutdown(), so if you're
   * redefining that you want to make sure you call PullStarter.unload().
   */
  _unloaders: [],
  unload: function unload() {
    this._unloaders.reverse();
    this._unloaders.forEach(function(func) {
      func.call(this);
    }, this);
    this._unloaders = [];
  },

  /**
   * Register an unloader function.
   * 
   * @param callback
   *        A function that performs some sort of unloading action.
   * @param window [optional]
   *        A DOM window object that, when closed, will also call the unloader.
   * 
   * @return a function that removes the unregisters unloader.
   */
  registerUnloader: function registerUnloader(callback, window) {
    let unloaders = this._unloaders;

    // Wrap the callback in a function that ignores failures.
    function unloader() {
      try {
        callback();
      } catch (ex) {
        // Ignore.
      }
    }
    unloaders.push(unloader);

    // Provide a way to remove the unloader.
    function removeUnloader() {
      let index = unloaders.indexOf(unloader);
      if (index != -1) {
        unloaders.splice(index, 1);
      }
    }

    // If an associated window was specified, we want to call the
    // unloader when the window dies, or when the extension unloads.
    if (window) {
      // That means when the window gets unloaded, we want to call the unloader
      // and remove it from the global unloader list.
      let onWindowUnload = function onWindowUnload() {
        unloader();
        removeUnloader();
      };
      window.addEventListener("unload", onWindowUnload, false);

      // When the unloader is called, we want to remove the window unload event
      // listener, too.
      let origCallback = callback;
      callback = function callback() {
        window.removeEventListener("unload", onWindowUnload, false);
        origCallback();
      };
    }

    return removeUnloader;
  },

  /**
   * Register the addon's directory as a resource protocol host. This will
   * allow you to refer to files packaged in the add-on as
   * resource://<host>/<filename>.
   * 
   * @param host
   *        The name of the resource protocol host.
   * @param data
   *        The add-on data object passed into the startup() function.
   */
  registerResourceHost: function registerResourceHost(host, data) {
    this._resProtocolHandler.setSubstitution(host, data.resourceURI);
    this.registerUnloader(function () {
      this._resProtocolHandler.setSubstitution(host, null);
    });
  },

  /**
   * Register an event handler on a DOM node.
   * 
   * @param element
   *        The DOM node.
   * @param event
   *        The name of the event, e.g. 'click'.
   * @param callback
   *        The event handler function.
   * @param capture
   *        Boolean flag to indicate whether to use capture or not.
   * 
   * @return a function that, when called, removes the event handler again.
   * 
   * @note When the window that the DOM node belongs to is closed, the
   * event handler will automatically be removed. It will not be removed
   * if the DOM node is removed from the document. The returned function
   * must be called in this case.
   */
  registerEventListener:
  function registerEventListener(element, event, callback, capture) {
    element.addEventListener(event, callback, !!capture);
    let window = element.ownerDocument.defaultView;
    function removeListener() {
      element.removeEventListener(event, callback, !!capture);
    }
    let removeUnloader = this.registerUnloader(removeListener, window);
    return function removeEventListener() {
      removeListener();
      removeUnloader();
    };
  },

  /**
   * Apply callback to all existing and future windows of a certain type.
   * 
   * @param type
   *        The window type, e.g. "navigator:browser" for the browser window.
   * @param callback
   *        The function to invoke. It will be called with the window object
   *        as its only parameter.
   */
  watchWindows: function watchWindows(type, callback) {
    // Wrap the callback in a function that ignores failures.
    function watcher(window) {
      try {
        let documentElement = window.document.documentElement;
        if (documentElement.getAttribute("windowtype") == type) {
          callback(window);
        }
      } catch (ex) {
        // Ignore.
      }
    }

    // Wait for the window to finish loading before running the callback.
    function runOnLoad(window) {
      // Listen for one load event before checking the window type
      window.addEventListener("load", function runOnce() {
        window.removeEventListener("load", runOnce, false);
        watcher(window);
      }, false);
    }

    // Enumerating existing windows.
    let windows = Services.wm.getEnumerator(type);
    while (windows.hasMoreElements()) {
      // Only run the watcher immediately if the window is completely loaded
      let window = windows.getNext();
      if (window.document.readyState == "complete") {
        watcher(window);
      } else {
        // Wait for the window to load before continuing
        runOnLoad(window);
      }
    }

    // Watch for new browser windows opening.
    function windowWatcher(subject, topic) {
      if (topic == "domwindowopened") {
        runOnLoad(subject);
      }
    }
    Services.ww.registerNotification(windowWatcher);
    this.registerUnloader(function () {
      Services.ww.unregisterNotification(windowWatcher);
    });
  },

  //TODO import + unload JSMs?
  //TODO l10n stringbundles
  //TODO stylesheets?
};
XPCOMUtils.defineLazyGetter(PullStarter, "_resProtocolHandler", function () {
  return Services.io.getProtocolHandler("resource")
                 .QueryInterface(Components.interfaces.nsIResProtocolHandler);
});
