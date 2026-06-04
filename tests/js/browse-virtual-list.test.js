const path = require("node:path");
const {pathToFileURL} = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  return import(pathToFileURL(absolutePath).href);
}

test("computeVirtualWindow returns an overscanned visible slice with spacer heights", async () => {
  const virtualList = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/virtual-list.js");
  const windowState = virtualList.computeVirtualWindow({
    rowCount: 100,
    rowHeight: 40,
    scrollTop: 400,
    viewportHeight: 200,
    overscan: 2,
  });

  assert.deepEqual(windowState, {
    startIndex: 8,
    endIndex: 17,
    topSpacerHeight: 320,
    bottomSpacerHeight: 3320,
    totalHeight: 4000,
  });
});

test("shouldVirtualizeRows keeps small listings on the full-render path", async () => {
  global.window = {};
  global.document = {};

  const virtualList = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/virtual-list.js");
  assert.equal(virtualList.shouldVirtualizeRows(9, { threshold: 10 }), false);
  assert.equal(virtualList.shouldVirtualizeRows(10, { threshold: 10 }), true);
});

test("rowIndexForScrollPosition maps the scrollbar position across the full sorted result set", async () => {
  const virtualList = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/virtual-list.js");

  assert.equal(virtualList.rowIndexForScrollPosition({
    rowCount: 40,
    rowHeight: 44,
    viewportHeight: 420,
    scrollTop: 0,
  }), 0);

  assert.equal(virtualList.rowIndexForScrollPosition({
    rowCount: 40,
    rowHeight: 44,
    viewportHeight: 420,
    scrollTop: (40 * 44 - 420) / 2,
  }), 20);

  assert.equal(virtualList.rowIndexForScrollPosition({
    rowCount: 40,
    rowHeight: 44,
    viewportHeight: 420,
    scrollTop: (40 * 44) - 420,
  }), 39);
});
