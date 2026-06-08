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
    700,
  );

  const total = Object.values(widths).reduce((sum, value) => sum + value, 0);
  assert.equal(total, 700);
  Object.entries(widths).forEach(([key, value]) => {
    assert.ok(value >= columns.BROWSE_COLUMN_MIN_WIDTHS[key]);
  });
});

test("resizeColumnPair only changes the two columns around the dragged divider", async () => {
  global.window = {};

  const columns = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/columns.js");
  const widths = {
    name: 120,
    type: 80,
    status: 80,
    size: 80,
    date: 80,
    view: 80,
    sync: 80,
  };

  const resized = columns.resizeColumnPair(widths, "name", "type", 30);

  assert.deepEqual(resized, {
    name: 150,
    type: 50,
    status: 80,
    size: 80,
    date: 80,
    view: 80,
    sync: 80,
  });
});

test("applyBrowseColumnWidths writes a full fitted width set onto matching columns", async () => {
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
      getBoundingClientRect() {
        return {width: 300};
      },
    },
    getBoundingClientRect() {
      return {width: 300};
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

  assert.deepEqual(widths, {name: 150, type: 50, status: 70});
  assert.equal(nameCol.style.width, "150px");
  assert.equal(typeCol.style.width, "50px");
  assert.equal(statusCol.style.width, "70px");
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
