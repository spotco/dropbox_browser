const path = require("node:path");
const {pathToFileURL} = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  return import(pathToFileURL(absolutePath).href);
}

test("normalizeStoredColumnWidths keeps supported positive widths and clamps to the shared small minimum", async () => {
  global.window = {};

  const columns = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/columns.js");

  assert.deepEqual(columns.normalizeStoredColumnWidths({
    name: 4,
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

test("fitColumnWidthsToTotal keeps all columns inside the available width when the viewport can satisfy minimums", async () => {
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
  assert.equal(resized.status, columns.BROWSE_COLUMN_MIN_WIDTHS.status);
  assert.equal(resized.size, columns.BROWSE_COLUMN_MIN_WIDTHS.size);
  assert.equal(resized.date, columns.BROWSE_COLUMN_MIN_WIDTHS.date);
  assert.equal(resized.view, 70);
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
  assert.equal(resized.type, columns.BROWSE_COLUMN_MIN_WIDTHS.type);
  assert.equal(resized.name, 212);
  assert.equal(resized.date, 180);
});

test("resizeColumnPair stops growing once every column in the drag direction is at minimum width", async () => {
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
  assert.equal(resized.type, columns.BROWSE_COLUMN_MIN_WIDTHS.type);
  assert.equal(resized.status, columns.BROWSE_COLUMN_MIN_WIDTHS.status);
  assert.equal(resized.size, columns.BROWSE_COLUMN_MIN_WIDTHS.size);
  assert.equal(resized.date, columns.BROWSE_COLUMN_MIN_WIDTHS.date);
  assert.equal(resized.view, columns.BROWSE_COLUMN_MIN_WIDTHS.view);
  assert.equal(resized.sync, columns.BROWSE_COLUMN_MIN_WIDTHS.sync);
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

  const minimumTotal = columns.BROWSE_COLUMN_MIN_WIDTHS.name
    + columns.BROWSE_COLUMN_MIN_WIDTHS.type
    + columns.BROWSE_COLUMN_MIN_WIDTHS.sync;
  assert.equal(Object.values(normalized).reduce((sum, value) => sum + value, 0), minimumTotal);
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
    name: columns.BROWSE_COLUMN_MIN_WIDTHS.name,
    type: columns.BROWSE_COLUMN_MIN_WIDTHS.type,
    status: columns.BROWSE_COLUMN_MIN_WIDTHS.status,
  });
  assert.equal(nameCol.style.width, columns.BROWSE_COLUMN_MIN_WIDTHS.name + "px");
  assert.equal(typeCol.style.width, columns.BROWSE_COLUMN_MIN_WIDTHS.type + "px");
  assert.equal(statusCol.style.width, columns.BROWSE_COLUMN_MIN_WIDTHS.status + "px");
});

test("fitColumnWidthsToTotal supports custom column sets and minimum widths", async () => {
  global.window = {};

  const columns = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/columns.js");
  const keys = ["filename", "path", "reorder"];
  const minWidths = {filename: 120, path: 150, reorder: 56};
  const widths = columns.fitColumnWidthsToTotal(
    keys,
    {filename: 220, path: 340, reorder: 56},
    500,
    minWidths,
  );

  assert.equal(widths.filename + widths.path + widths.reorder, 500);
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
