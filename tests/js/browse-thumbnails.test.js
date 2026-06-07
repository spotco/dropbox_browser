const path = require("node:path");
const {pathToFileURL} = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  return import(pathToFileURL(absolutePath).href + `?t=${Date.now()}`);
}

class FakeClassList {
  constructor(initial) {
    this._values = new Set(initial || []);
  }

  add(value) {
    this._values.add(value);
  }

  contains(value) {
    return this._values.has(value);
  }
}

class FakeIcon {
  constructor(iconHref, thumbnailHref) {
    this.isConnected = true;
    this.attributes = new Map();
    this.classList = new FakeClassList(["file-icon"]);
    this.setAttribute("src", iconHref);
    this.setAttribute("data-thumbnail-state", "idle");
    if (thumbnailHref) this.setAttribute("data-thumbnail-href", thumbnailHref);
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
}

class FakeRoot {
  constructor(elements) {
    this.elements = elements || [];
  }

  querySelectorAll(selector) {
    if (selector !== ".file-icon[data-thumbnail-href]") return [];
    return this.elements.filter(function (element) {
      return !!element.getAttribute("data-thumbnail-href");
    });
  }
}

class FakeWindow {
  constructor() {
    this.listeners = new Map();
    this.ioInstances = [];
    this.imageInstances = [];
    const self = this;
    this.IntersectionObserver = class FakeIntersectionObserver {
      constructor(callback, options) {
        this.callback = callback;
        this.options = options;
        this.observed = [];
        self.ioInstances.push(this);
      }

      observe(element) {
        this.observed.push(element);
      }

      disconnect() {
        this.observed = [];
      }

      trigger(element, isIntersecting) {
        this.callback([{
          target: element,
          isIntersecting: !!isIntersecting,
          intersectionRatio: isIntersecting ? 1 : 0,
        }]);
      }
    };
    this.Image = class FakeImage {
      constructor() {
        this.decoding = "";
        this.onload = null;
        this.onerror = null;
        this._src = "";
        self.imageInstances.push(this);
      }

      set src(value) {
        this._src = String(value);
      }

      get src() {
        return this._src;
      }
    };
  }

  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(listener);
  }

  removeEventListener(name, listener) {
    const listeners = this.listeners.get(name) || [];
    this.listeners.set(name, listeners.filter(function (item) {
      return item !== listener;
    }));
  }

  dispatchEvent(event) {
    const listeners = this.listeners.get(event.type) || [];
    listeners.forEach(function (listener) {
      listener(event);
    });
  }
}

test("browse thumbnails requests only intersecting mounted rows", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/thumbnails.js");
  const win = new FakeWindow();
  const visible = new FakeIcon("/assets/icons/material-icon-theme/image.svg", "/thumbnail?path=one.png&source=remote");
  const hidden = new FakeIcon("/assets/icons/material-icon-theme/image.svg", "/thumbnail?path=two.png&source=remote");
  const root = new FakeRoot([visible, hidden]);
  const controller = mod.initBrowseThumbnails({document: {}, window: win, root: root});

  controller.refresh();

  assert.equal(win.imageInstances.length, 0);
  assert.equal(win.ioInstances.length, 1);
  win.ioInstances[0].trigger(visible, true);

  assert.equal(win.imageInstances.length, 1);
  assert.equal(win.imageInstances[0].src, "/thumbnail?path=one.png&source=remote");
  assert.equal(visible.getAttribute("src"), "/assets/icons/material-icon-theme/image.svg");
  assert.equal(visible.getAttribute("data-thumbnail-state"), "loading");

  win.imageInstances[0].onload();
  assert.equal(visible.getAttribute("src"), "/thumbnail?path=one.png&source=remote");
  assert.equal(visible.getAttribute("data-thumbnail-state"), "loaded");
  assert.equal(hidden.getAttribute("src"), "/assets/icons/material-icon-theme/image.svg");

  controller.cleanup();
});

test("browse thumbnails limits concurrent image loads", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/thumbnails.js");
  const win = new FakeWindow();
  const first = new FakeIcon("/assets/icons/material-icon-theme/image.svg", "/thumbnail?path=one.png&source=remote");
  const second = new FakeIcon("/assets/icons/material-icon-theme/image.svg", "/thumbnail?path=two.png&source=remote");
  const root = new FakeRoot([first, second]);
  const controller = mod.initBrowseThumbnails({document: {}, window: win, root: root, maxConcurrentLoads: 1});

  controller.refresh();
  win.ioInstances[0].trigger(first, true);
  win.ioInstances[0].trigger(second, true);

  assert.equal(win.imageInstances.length, 1);
  assert.equal(win.imageInstances[0].src, "/thumbnail?path=one.png&source=remote");

  win.imageInstances[0].onload();
  assert.equal(first.getAttribute("src"), "/thumbnail?path=one.png&source=remote");
  assert.equal(win.imageInstances.length, 2);
  assert.equal(win.imageInstances[1].src, "/thumbnail?path=two.png&source=remote");

  controller.cleanup();
});

test("browse thumbnails keeps fallback icon after load failure and does not retry in the same page state", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/thumbnails.js");
  const win = new FakeWindow();
  const iconHref = "/assets/icons/material-icon-theme/image.svg";
  const icon = new FakeIcon(iconHref, "/thumbnail?path=broken.png&source=remote");
  const root = new FakeRoot([icon]);
  const controller = mod.initBrowseThumbnails({document: {}, window: win, root: root});

  controller.refresh();
  win.ioInstances[0].trigger(icon, true);

  assert.equal(win.imageInstances.length, 1);
  win.imageInstances[0].onerror();
  assert.equal(icon.getAttribute("src"), iconHref);
  assert.equal(icon.getAttribute("data-thumbnail-state"), "error");

  controller.refresh();
  win.ioInstances[0].trigger(icon, true);
  assert.equal(win.imageInstances.length, 1);

  controller.cleanup();
});

test("browse thumbnails restores loaded thumbnails after virtual rerender without another request", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/thumbnails.js");
  const win = new FakeWindow();
  const iconHref = "/assets/icons/material-icon-theme/image.svg";
  const thumbnailHref = "/thumbnail?path=cover.png&source=remote";
  const first = new FakeIcon(iconHref, thumbnailHref);
  const root = new FakeRoot([first]);
  const controller = mod.initBrowseThumbnails({document: {}, window: win, root: root});

  controller.refresh();
  win.ioInstances[0].trigger(first, true);
  win.imageInstances[0].onload();

  first.isConnected = false;
  const replacement = new FakeIcon(iconHref, thumbnailHref);
  root.elements = [replacement];
  controller.refresh();
  win.ioInstances[0].trigger(replacement, true);

  assert.equal(win.imageInstances.length, 1);
  assert.equal(replacement.getAttribute("src"), thumbnailHref);
  assert.equal(replacement.getAttribute("data-thumbnail-state"), "loaded");

  controller.cleanup();
});

test("browse thumbnails applies in-flight success to remounted rows", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/thumbnails.js");
  const win = new FakeWindow();
  const iconHref = "/assets/icons/material-icon-theme/image.svg";
  const thumbnailHref = "/thumbnail?path=cover.png&source=remote";
  const first = new FakeIcon(iconHref, thumbnailHref);
  const root = new FakeRoot([first]);
  const controller = mod.initBrowseThumbnails({document: {}, window: win, root: root});

  controller.refresh();
  win.ioInstances[0].trigger(first, true);
  assert.equal(win.imageInstances.length, 1);

  first.isConnected = false;
  const replacement = new FakeIcon(iconHref, thumbnailHref);
  root.elements = [replacement];
  controller.refresh();
  win.ioInstances[0].trigger(replacement, true);
  assert.equal(win.imageInstances.length, 1);

  win.imageInstances[0].onload();
  assert.equal(first.getAttribute("src"), iconHref);
  assert.equal(replacement.getAttribute("src"), thumbnailHref);
  assert.equal(replacement.getAttribute("data-thumbnail-state"), "loaded");

  controller.cleanup();
});

test("browse thumbnails defers scroll-one rows until remount but keeps in-flight and loaded results", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/thumbnails.js");
  const win = new FakeWindow();
  const iconHref = "/assets/icons/material-icon-theme/image.svg";
  const firstHref = "/thumbnail?path=one.png&source=remote";
  const secondHref = "/thumbnail?path=two.png&source=remote";
  const thirdHref = "/thumbnail?path=three.png&source=remote";
  const scrollOneRows = [
    new FakeIcon(iconHref, firstHref),
    new FakeIcon(iconHref, secondHref),
    new FakeIcon(iconHref, thirdHref),
  ];
  const root = new FakeRoot(scrollOneRows);
  const controller = mod.initBrowseThumbnails({
    document: {},
    window: win,
    root: root,
    maxConcurrentLoads: 1,
  });

  controller.refresh();
  win.ioInstances[0].trigger(scrollOneRows[0], true);
  win.ioInstances[0].trigger(scrollOneRows[1], true);
  win.ioInstances[0].trigger(scrollOneRows[2], true);
  assert.equal(win.imageInstances.length, 1);
  assert.equal(win.imageInstances[0].src, firstHref);
  assert.equal(scrollOneRows[1].getAttribute("data-thumbnail-state"), "idle");

  scrollOneRows.forEach(function (row) {
    row.isConnected = false;
  });
  const scrollTwoRow = new FakeIcon(iconHref, "/thumbnail?path=four.png&source=remote");
  root.elements = [scrollTwoRow];
  controller.refresh();
  win.ioInstances[0].trigger(scrollTwoRow, true);
  assert.equal(win.imageInstances.length, 1);

  win.imageInstances[0].onload();
  assert.equal(scrollOneRows[0].getAttribute("src"), iconHref);
  assert.equal(scrollTwoRow.getAttribute("src"), iconHref);
  assert.equal(win.imageInstances.length, 2);
  assert.equal(win.imageInstances[1].src, scrollTwoRow.getAttribute("data-thumbnail-href"));

  scrollTwoRow.isConnected = false;
  const remounted = [firstHref, secondHref, thirdHref].map(function (href) {
    return new FakeIcon(iconHref, href);
  });
  root.elements = remounted;
  controller.refresh();
  remounted.forEach(function (row) {
    win.ioInstances[0].trigger(row, true);
  });

  assert.equal(remounted[0].getAttribute("src"), firstHref);
  assert.equal(remounted[0].getAttribute("data-thumbnail-state"), "loaded");
  assert.equal(remounted[1].getAttribute("src"), iconHref);
  assert.equal(remounted[2].getAttribute("src"), iconHref);

  win.imageInstances[1].onload();
  assert.equal(win.imageInstances.length, 3);
  assert.equal(win.imageInstances[2].src, secondHref);

  win.imageInstances[2].onload();
  assert.equal(remounted[1].getAttribute("src"), secondHref);
  assert.equal(win.imageInstances.length, 4);
  assert.equal(win.imageInstances[3].src, thirdHref);

  controller.cleanup();
});

test("browse thumbnails resets failed and loaded urls on folder change", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/thumbnails.js");
  const win = new FakeWindow();
  const iconHref = "/assets/icons/material-icon-theme/image.svg";
  const thumbnailHref = "/thumbnail?path=cover.png&source=remote";
  const icon = new FakeIcon(iconHref, thumbnailHref);
  const root = new FakeRoot([icon]);
  const controller = mod.initBrowseThumbnails({document: {}, window: win, root: root});

  controller.refresh();
  win.ioInstances[0].trigger(icon, true);
  win.imageInstances[0].onerror();
  assert.equal(icon.getAttribute("data-thumbnail-state"), "error");

  win.dispatchEvent({type: "browse-folder-changed"});
  controller.refresh();
  win.ioInstances[0].trigger(icon, true);
  assert.equal(win.imageInstances.length, 2);

  controller.cleanup();
});