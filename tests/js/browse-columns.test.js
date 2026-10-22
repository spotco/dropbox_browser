const path = require("node:path");
const {pathToFileURL} = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  return import(pathToFileURL(absolutePath).href);
}

test("normalizeStoredColumnWidths clamps browse columns to the drag-handle minimum", async () => {
  global.window = {};

  const columns = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/columns.js");

  assert.deepEqual(columns.normalizeStoredColumnWidths({
    name: 0,
    type: 101.2,
    bogus: 999,
    status: "not-a-number",
    sync: 160,
  }), {
    name: columns.BROWSE_COLUMN_MIN_WIDTHS.name,
    type: 101,
    sync: 160,
  });
});

test("fitColumnWidthsToTotal keeps all columns inside the available width", async () => {
  global.window = {};

  const columns = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/columns.js");
  const widths = columns.fitColumnWidthsToTotal(
    columns.BROWSE_COLUMN_KEYS,
    {
      name: 200,
      type: 100,
      status: 150,
      size: 120,
      date: 180,
      view: 90,
      sync: 160,
    },
    900,
  );

  const total = Object.values(widths).reduce((sum, value) => sum + value, 0);
  assert.equal(total, 900);
  Object.entries(widths).forEach(([key, value]) => {
    assert.ok(value >= columns.BROWSE_COLUMN_MIN_WIDTHS[key]);
  });
});

test("resizeColumnPair cascades shrink across columns to the right when the adjacent column reaches minimum width", async () => {
  global.window = {};

  const columns = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/columns.js");
  const widths = {
    name: 260,
    type: 80,
    status: 130,
    size: 120,
    date: 180,
    view: 80,
    sync: 140,
  };

  const resized = columns.resizeColumnPair(widths, "name", "type", 120);

  assert.equal(
    Object.values(resized).reduce((sum, value) => sum + value, 0),
    Object.values(columns.normalizeStoredColumnWidths(widths)).reduce((sum, value) => sum + value, 0),
  );
  assert.equal(resized.name, 380);
  assert.equal(resized.type, columns.BROWSE_COLUMN_MIN_WIDTHS.type);
  assert.equal(resized.status, 74);
  assert.equal(resized.size, 120);
  assert.equal(resized.date, 180);
  assert.equal(resized.view, 80);
  assert.equal(resized.sync, 140);
});

test("resizeColumnPair cascades shrink across columns to the left when dragging the divider left", async () => {
  global.window = {};

  const columns = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/columns.js");
  const widths = {
    name: 260,
    type: 120,
    status: 140,
    size: 120,
    date: 180,
    view: 80,
    sync: 140,
  };

  const resized = columns.resizeColumnPair(widths, "status", "size", -140);

  assert.equal(
    Object.values(resized).reduce((sum, value) => sum + value, 0),
    Object.values(columns.normalizeStoredColumnWidths(widths)).reduce((sum, value) => sum + value, 0),
  );
  assert.equal(resized.size, 260);
  assert.equal(resized.status, columns.BROWSE_COLUMN_MIN_WIDTHS.status);
  assert.equal(resized.type, 104);
  assert.equal(resized.name, 260);
  assert.equal(resized.date, 180);
});

test("resizeColumnPair lets a column consume all following widths down to the handle minimum", async () => {
  global.window = {};

  const columns = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/columns.js");
  const widths = {
    name: 260,
    type: 80,
    status: 130,
    size: 120,
    date: 180,
    view: 80,
    sync: 140,
  };

  const resized = columns.resizeColumnPair(widths, "name", "type", 1000);

  const normalizedWidths = columns.normalizeStoredColumnWidths(widths);
  const maxGain = ["type", "status", "size", "date", "view", "sync"].reduce((sum, key) => (
    sum + (normalizedWidths[key] - columns.BROWSE_COLUMN_MIN_WIDTHS[key])
  ), 0);

  assert.equal(resized.name, normalizedWidths.name + maxGain);
  Object.keys(columns.BROWSE_COLUMN_MIN_WIDTHS).forEach((key) => {
    if (key !== "name") assert.equal(resized[key], columns.BROWSE_COLUMN_MIN_WIDTHS[key]);
  });
});

test("applyBrowseColumnWidths fits to the visible shell width instead of preserving an oversized table width", async () => {
  global.window = {};

  const columns = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/columns.js");

  function createColumn(key) {
    return {
      getAttribute(name) {
        return name === "data-browse-column" ? key : "";
      },
      style: {
        width: "",
        removeProperty(name) {
          if (name === "width") this.width = "";
        },
      },
    };
  }

  const nameCol = createColumn("name");
  const typeCol = createColumn("type");
  const syncCol = createColumn("sync");
  const table = {
    parentElement: {
      clientWidth: 300,
      getBoundingClientRect() {
        return {width: 300};
      },
    },
    getBoundingClientRect() {
      return {width: 640};
    },
    querySelectorAll(selector) {
      assert.equal(selector, 'col[data-browse-column]');
      return [nameCol, typeCol, syncCol];
    },
  };

  const normalized = columns.applyBrowseColumnWidths(table, {
    name: 150,
    type: 90,
    sync: 60,
  });

  assert.equal(Object.values(normalized).reduce((sum, value) => sum + value, 0), 300);
  assert.equal(nameCol.style.width, normalized.name + "px");
  assert.equal(typeCol.style.width, normalized.type + "px");
  assert.equal(syncCol.style.width, normalized.sync + "px");
});

test("writeBrowseColumnWidths preserves the provided widths without refitting other columns", async () => {
  global.window = {};

  const columns = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/columns.js");

  function createColumn(key) {
    return {
      getAttribute(name) {
        return name === "data-browse-column" ? key : "";
      },
      style: {
        width: "",
        removeProperty(name) {
          if (name === "width") this.width = "";
        },
      },
    };
  }

  const nameCol = createColumn("name");
  const typeCol = createColumn("type");
  const statusCol = createColumn("status");
  const table = {
    querySelectorAll(selector) {
      assert.equal(selector, 'col[data-browse-column]');
      return [nameCol, typeCol, statusCol];
    },
  };

  const widths = columns.writeBrowseColumnWidths(table, {
    name: 150,
    type: 50,
    status: 70,
  });

  assert.deepEqual(widths, {
    name: 150,
    type: 50,
    status: 70,
  });
  assert.equal(nameCol.style.width, "150px");
  assert.equal(typeCol.style.width, "50px");
  assert.equal(statusCol.style.width, "70px");
});

test("fitColumnWidthsToTotal supports custom column sets and minimum widths", async () => {
  global.window = {};

  const columns = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/columns.js");
  const keys = ["index", "filename", "path", "reorder"];
  const minWidths = {index: 48, filename: 120, path: 150, reorder: 56};
  const widths = columns.fitColumnWidthsToTotal(
    keys,
    {index: 52, filename: 220, path: 340, reorder: 56},
    568,
    minWidths,
  );

  assert.equal(widths.index + widths.filename + widths.path + widths.reorder, 568);
  assert.ok(widths.index >= 48);
  assert.ok(widths.filename >= 120);
  assert.ok(widths.path >= 150);
  assert.ok(widths.reorder >= 56);
});

test("fitColumnWidthsToTotal gives extra default width to the name column when no saved widths exist", async () => {
  global.window = {};

  const columns = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/columns.js");
  const widths = columns.fitColumnWidthsToTotal(columns.BROWSE_COLUMN_KEYS, {}, 1100);

  assert.equal(Object.values(widths).reduce((sum, value) => sum + value, 0), 1100);
  assert.ok(widths.name > widths.type);
  assert.ok(widths.name > widths.view);
  assert.ok(widths.date > widths.type);
});

function sumWidths(widths) {
  return Object.values(widths).reduce((sum, value) => sum + value, 0);
}

function installListenerTarget(target) {
  const listeners = new Map();
  target.addEventListener = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  };
  target.removeEventListener = (type, fn) => {
    const list = listeners.get(type) || [];
    const index = list.indexOf(fn);
    if (index >= 0) list.splice(index, 1);
  };
  target.dispatch = (type, event) => {
    (listeners.get(type) || []).slice().forEach((fn) => fn(event));
  };
  return target;
}

function createBrowseColumnHarness(columns, availableWidth) {
  const observers = [];
  const store = {
    "browse-column-widths-v1": {
      preferred: {
        name: 16, type: 16, status: 16, size: 16, date: 16, view: 16, sync: 16,
      },
    },
  };
  const win = installListenerTarget({
    Settings: {
      get(key, fallback) {
        return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : fallback;
      },
      set(key, value) {
        store[key] = value;
      },
    },
    ResizeObserver: function ResizeObserver(callback) {
      this.callback = callback;
      observers.push(this);
    },
  });
  win.ResizeObserver.prototype.observe = function observe() {};
  win.ResizeObserver.prototype.disconnect = function disconnect() {};

  const cols = columns.BROWSE_COLUMN_KEYS.map((key) => ({
    getAttribute(name) {
      return name === "data-browse-column" ? key : "";
    },
    style: {
      width: "",
      removeProperty(name) {
        if (name === "width") this.width = "";
      },
    },
  }));
  const shell = {
    clientWidth: availableWidth,
    getBoundingClientRect() {
      return {width: this.clientWidth, height: this.clientWidth ? 40 : 0};
    },
  };
  const nameHandle = {
    classList: {add() {}, remove() {}},
    getAttribute(name) {
      return name === "data-browse-column-resizer" ? "name" : "";
    },
    closest(selector) {
      return String(selector).includes("browse-column-resizer") ? nameHandle : null;
    },
    setPointerCapture() {},
    getBoundingClientRect() {
      return {left: 40, right: 54, top: 0, bottom: 39, width: 14, height: 39};
    },
  };
  const table = installListenerTarget({
    parentElement: shell,
    querySelectorAll(selector) {
      if (selector === "col[data-browse-column]") return cols;
      return [];
    },
  });
  const doc = {
    body: {classList: {add() {}, remove() {}}},
    querySelector() {
      return null;
    },
  };
  const api = columns.initBrowseColumnResizing({document: doc, window: win, table});
  return {
    api,
    observers,
    shell,
    dragName(delta) {
      table.dispatch("pointerdown", {
        target: nameHandle,
        currentTarget: table,
        clientX: 47,
        clientY: 10,
        pointerId: 1,
        preventDefault() {},
      });
      win.dispatch("pointermove", {clientX: 47 + delta, clientY: 10, pointerId: 1});
      win.dispatch("pointerup", {clientX: 47 + delta, clientY: 10, pointerId: 1});
    },
    notifyShellResize() {
      observers.forEach((observer) => observer.callback());
    },
  };
}

test("browse columns loaded while the shell is hidden become resizable once it has a width", async () => {
  const columns = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/columns.js");
  const harness = createBrowseColumnHarness(columns, 0);

  assert.equal(sumWidths(harness.api.getWidths()), 16 * columns.BROWSE_COLUMN_KEYS.length);
  assert.equal(harness.observers.length, 1);

  harness.shell.clientWidth = 328;
  harness.notifyShellResize();

  const fitted = harness.api.getWidths();
  assert.equal(sumWidths(fitted), 328);
  assert.deepEqual(harness.api.getPreferredWidths(), {
    name: 16, type: 16, status: 16, size: 16, date: 16, view: 16, sync: 16,
  });
  harness.dragName(80);
  const dragged = harness.api.getWidths();
  assert.ok(dragged.name > fitted.name);
  assert.equal(sumWidths(dragged), 328);
  columns.BROWSE_COLUMN_KEYS.forEach((key) => {
    assert.ok(dragged[key] >= columns.BROWSE_COLUMN_MIN_WIDTHS[key]);
  });
});

test("browse columns loaded with the shell already visible stay resizable", async () => {
  const columns = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/columns.js");
  const harness = createBrowseColumnHarness(columns, 328);
  const fitted = harness.api.getWidths();

  assert.equal(sumWidths(fitted), 328);
  harness.dragName(80);
  const dragged = harness.api.getWidths();
  assert.ok(dragged.name > fitted.name);
  assert.equal(sumWidths(dragged), 328);
  columns.BROWSE_COLUMN_KEYS.forEach((key) => {
    assert.ok(dragged[key] >= columns.BROWSE_COLUMN_MIN_WIDTHS[key]);
  });
});

test("hiding the browse shell does not leave columns stuck at the minimum when it is shown again", async () => {
  const columns = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/columns.js");
  const harness = createBrowseColumnHarness(columns, 400);

  harness.shell.clientWidth = 0;
  harness.notifyShellResize();
  harness.shell.clientWidth = 360;
  harness.notifyShellResize();

  const fitted = harness.api.getWidths();
  assert.equal(sumWidths(fitted), 360);
  harness.dragName(40);
  assert.ok(harness.api.getWidths().name > fitted.name);
  columns.BROWSE_COLUMN_KEYS.forEach((key) => {
    assert.ok(harness.api.getWidths()[key] >= columns.BROWSE_COLUMN_MIN_WIDTHS[key]);
  });
});
