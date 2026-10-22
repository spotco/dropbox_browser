const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");

async function loadMenuModule() {
  const href = pathToFileURL(path.resolve(
    __dirname,
    "..",
    "..",
    "dropbox_browser/assets/js/media-library/context-menu-position.js",
  )).href;
  return import(href);
}

function element(tag, parent) {
  return {
    tagName: tag,
    parentElement: parent || null,
    closest(selector) {
      const names = selector.split(",").map((part) => part.trim());
      let node = this;
      while (node) {
        if (names.includes(node.tagName.toLowerCase())) return node;
        node = node.parentElement;
      }
      return null;
    },
  };
}

test("touch long-press arms only for a primary touch on a non-control", async () => {
  const menu = await loadMenuModule();
  const row = element("div", null);
  assert.equal(menu.touchLongPressShouldArm({
    pointerType: "touch",
    button: 0,
    isPrimary: true,
    target: row,
  }), true);
  assert.equal(menu.touchLongPressShouldArm({
    pointerType: "mouse",
    button: 0,
    target: row,
  }), false);
  assert.equal(menu.touchLongPressShouldArm({
    pointerType: "touch",
    button: 0,
    isPrimary: false,
    target: row,
  }), false);
  assert.equal(menu.touchLongPressShouldArm({
    pointerType: "touch",
    button: 0,
    target: element("button", row),
  }), false);
});

test("touch long-press move threshold cancels before a short release can fire", async () => {
  const menu = await loadMenuModule();
  const gesture = menu.createLongPressGesture();
  const target = element("div", null);
  assert.equal(gesture.begin({
    pointerType: "touch",
    pointerId: 3,
    button: 0,
    clientX: 10,
    clientY: 20,
    target,
  }), true);
  assert.equal(gesture.move({ pointerId: 3, clientX: 40, clientY: 20 }), "cancel");
  gesture.markReady();
  assert.equal(gesture.end({ pointerId: 3 }), null);
});

test("touch long-press fires on release only after the hold is ready", async () => {
  const menu = await loadMenuModule();
  const gesture = menu.createLongPressGesture();
  const target = element("span", null);
  gesture.begin({
    pointerType: "touch",
    pointerId: 1,
    button: 0,
    clientX: 8,
    clientY: 9,
    target,
  });
  assert.equal(gesture.end({ pointerId: 1 }), null);

  const held = menu.createLongPressGesture();
  held.begin({
    pointerType: "touch",
    pointerId: 1,
    button: 0,
    clientX: 8,
    clientY: 9,
    target,
  });
  held.markReady();
  assert.equal(held.move({ pointerId: 1, clientX: 12, clientY: 11 }), "pending");
  assert.deepEqual(held.end({ pointerId: 1 }), {
    clientX: 8,
    clientY: 9,
    target,
  });
});

test("a touch menu stays open for clicks inside it and a mouse menu does not", async () => {
  const menu = await loadMenuModule();
  const touchMenu = {
    classList: { contains(name) { return name === "music-context-menu-touch"; } },
  };
  const mouseMenu = {
    classList: { contains() { return false; } },
  };
  function eventFor(menuNode) {
    return {
      target: {
        closest(selector) {
          return selector === ".music-context-menu" ? menuNode : null;
        },
      },
    };
  }
  assert.equal(menu.contextMenuEventShouldDismiss(eventFor(touchMenu)), false);
  assert.equal(menu.contextMenuEventShouldDismiss(eventFor(mouseMenu)), true);
  assert.equal(menu.contextMenuEventShouldDismiss({ target: { closest() { return null; } } }), true);
});

test("bindTouchLongPress opens from the touch release and not from a mouse hold", async () => {
  const menu = await loadMenuModule();
  const targetListeners = new Map();
  const windowListeners = new Map();
  let scheduled = null;
  const fakeWindow = {
    setTimeout(fn) {
      scheduled = fn;
      return 1;
    },
    clearTimeout() {
      scheduled = null;
    },
    addEventListener(type, fn) {
      windowListeners.set(type, fn);
    },
    removeEventListener(type) {
      windowListeners.delete(type);
    },
  };
  const previousWindow = global.window;
  const previousDocument = global.document;
  global.window = fakeWindow;
  global.document = { addEventListener() {} };
  const opened = [];
  const target = {
    addEventListener(type, fn) {
      targetListeners.set(type, fn);
    },
  };
  try {
    menu.bindTouchLongPress(target, (info) => opened.push(info));
    const onPointerDown = targetListeners.get("pointerdown");
    onPointerDown({
      pointerType: "mouse",
      pointerId: 1,
      button: 0,
      clientX: 1,
      clientY: 2,
      target: element("div", null),
    });
    assert.equal(scheduled, null);

    const row = element("div", null);
    onPointerDown({
      pointerType: "touch",
      pointerId: 7,
      button: 0,
      clientX: 30,
      clientY: 40,
      target: row,
    });
    assert.equal(typeof scheduled, "function");
    windowListeners.get("pointerup")({ pointerId: 7 });
    assert.deepEqual(opened, []);

    onPointerDown({
      pointerType: "touch",
      pointerId: 8,
      button: 0,
      clientX: 30,
      clientY: 40,
      target: row,
    });
    scheduled();
    windowListeners.get("pointerup")({ pointerId: 8 });
    assert.deepEqual(opened, [{ clientX: 30, clientY: 40, target: row }]);
  } finally {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
    if (previousDocument === undefined) delete global.document;
    else global.document = previousDocument;
  }
});

test("a second short touch on the same row is a double tap and a different row is not", async () => {
  const menu = await loadMenuModule();
  const taps = menu.createTouchDoubleTap({
    keyFor(target) { return target && target.key; },
  });
  const row = {key: "song-a"};
  const other = {key: "song-b"};
  assert.equal(taps.note({pointerType: "mouse", target: row}, 1000), false);
  assert.equal(taps.note({pointerType: "touch", target: row}, 1000), false);
  assert.equal(taps.note({pointerType: "touch", target: other}, 1200), false);
  assert.equal(taps.note({pointerType: "touch", target: other}, 1400), true);
  assert.equal(taps.note({pointerType: "touch", target: row}, 1500), false);
  assert.equal(taps.note({pointerType: "touch", target: row}, 1500), true);
  assert.equal(taps.note({pointerType: "touch", target: row}, 1600), false);
  assert.equal(taps.note({pointerType: "touch", target: row}, 1600 + menu.TOUCH_DOUBLE_TAP_MS + 1), false);
  assert.equal(taps.note({pointerType: "touch", target: {key: ""}}, 1600), false);
});

function touchHarness(menu) {
  const targetListeners = new Map();
  const windowListeners = new Map();
  let scheduled = null;
  const fakeWindow = {
    setTimeout(fn) {
      scheduled = fn;
      return 1;
    },
    clearTimeout() {
      scheduled = null;
    },
    addEventListener(type, fn) {
      windowListeners.set(type, fn);
    },
    removeEventListener(type) {
      windowListeners.delete(type);
    },
  };
  const target = {
    addEventListener(type, fn) {
      targetListeners.set(type, fn);
    },
  };
  return {
    fakeWindow,
    target,
    tap(pointerId, node, hold) {
      targetListeners.get("pointerdown")({
        pointerType: "touch",
        pointerId,
        button: 0,
        clientX: 12,
        clientY: 14,
        target: node,
      });
      if (hold) scheduled();
      windowListeners.get("pointerup")({
        pointerType: "touch",
        pointerId,
        clientX: 12,
        clientY: 14,
        target: node,
      });
    },
  };
}

test("two short touches play the playlist row and a long press still opens the menu", async () => {
  const menu = await loadMenuModule();
  const harness = touchHarness(menu);
  const previousWindow = global.window;
  const previousDocument = global.document;
  global.window = harness.fakeWindow;
  global.document = {addEventListener() {}};
  const played = [];
  const opened = [];
  const rowA = {key: "song-a"};
  const rowB = {key: "song-b"};
  try {
    assert.equal(menu.touchDoubleTapSuppressesNativeDblclick(), false);
    menu.bindTouchLongPress(harness.target, (info) => opened.push(info), {
      doubleTapKey(target) { return target.key; },
      onDoubleTap(ev) { played.push(ev.target.key); },
    });

    harness.tap(1, rowA, false);
    assert.deepEqual(played, []);
    assert.deepEqual(opened, []);

    harness.tap(2, rowB, false);
    assert.deepEqual(played, []);

    harness.tap(3, rowA, false);
    harness.tap(4, rowA, false);
    assert.deepEqual(played, ["song-a"]);
    assert.equal(menu.touchDoubleTapSuppressesNativeDblclick(), true);
    assert.equal(menu.touchDoubleTapSuppressesNativeDblclick(Date.now() + 1000), false);

    harness.tap(5, rowA, true);
    assert.equal(opened.length, 1);
    assert.deepEqual(played, ["song-a"]);
    assert.equal(opened[0].target, rowA);

    harness.tap(6, rowA, false);
    assert.deepEqual(played, ["song-a"]);
    harness.tap(7, rowA, false);
    assert.deepEqual(played, ["song-a", "song-a"]);
  } finally {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
    if (previousDocument === undefined) delete global.document;
    else global.document = previousDocument;
  }
});

function treeTarget(kind, id, tagName) {
  const row = {
    tagName: "div",
    dataset: {nodeId: id, nodeKind: kind},
    parentElement: null,
  };
  const node = {
    tagName: tagName || "span",
    dataset: {},
    parentElement: row,
  };
  function closest(selector) {
    const names = String(selector).split(",").map((part) => part.trim());
    let current = this;
    while (current) {
      if (names.includes(".music-tree-row") && current === row) return row;
      if (names.includes(current.tagName.toLowerCase())) return current;
      current = current.parentElement;
    }
    return null;
  }
  row.closest = closest;
  node.closest = closest;
  return node;
}

test("a library song double tap adds and plays while a long press still opens the menu", async () => {
  const menu = await loadMenuModule();
  const library = await import(pathToFileURL(path.resolve(
    __dirname,
    "..",
    "..",
    "dropbox_browser/assets/js/media-library/library.js",
  )).href);
  const harness = touchHarness(menu);
  const previousWindow = global.window;
  const previousDocument = global.document;
  global.window = harness.fakeWindow;
  global.document = {addEventListener() {}};
  const songs = {
    "song:alpha": {id: "song:alpha", display_name: "Alpha.mp3"},
  };
  const added = [];
  const opened = [];
  const song = treeTarget("song", "song:alpha");
  const folder = treeTarget("folder", "folder:album");
  const expandButton = treeTarget("song", "song:alpha", "button");
  try {
    assert.equal(library.libraryTouchDoubleTapNodeId(song), "song:alpha");
    assert.equal(library.libraryTouchDoubleTapNodeId(folder), "");
    assert.equal(library.libraryTouchDoubleTapNodeId(expandButton), "");
    menu.bindTouchLongPress(harness.target, (info) => {
      opened.push(info.target.closest(".music-tree-row").dataset.nodeKind);
    }, {
      doubleTapKey: library.libraryTouchDoubleTapNodeId,
      onDoubleTap(ev) {
        const node = songs[library.libraryTouchDoubleTapNodeId(ev.target)];
        if (!node) return;
        added.push(node.id);
      },
    });

    harness.tap(1, song, false);
    harness.tap(2, song, false);
    assert.deepEqual(added, ["song:alpha"]);
    assert.equal(menu.touchDoubleTapSuppressesNativeDblclick(), true);

    harness.tap(3, folder, false);
    harness.tap(4, folder, false);
    assert.deepEqual(added, ["song:alpha"]);

    harness.tap(5, song, true);
    assert.deepEqual(opened, ["song"]);
    assert.deepEqual(added, ["song:alpha"]);

    harness.tap(6, folder, true);
    assert.deepEqual(opened, ["song", "folder"]);
    assert.deepEqual(added, ["song:alpha"]);
  } finally {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
    if (previousDocument === undefined) delete global.document;
    else global.document = previousDocument;
  }
});
