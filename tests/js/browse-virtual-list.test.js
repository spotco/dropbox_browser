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

test("scroll preview row mapping respects the active filtered sort order", async () => {
  const virtualList = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/virtual-list.js");
  const browseSearch = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/search.js");
  const browseSort = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/sort.js");
  const rows = [
    { id: "file:0028", display_name: "2024-03-01 0028.jpg", path: "Camera Uploads/2024-03-01 0028.jpg", kind: "file", status_label: "Synced", type_label: "image", sort_name: "2024-03-01 0028.jpg", sort_type: "image", sort_status: "Synced", sort_size: 28, sort_date: 28 },
    { id: "file:0003", display_name: "2024-03-01 0003.jpg", path: "Camera Uploads/2024-03-01 0003.jpg", kind: "file", status_label: "Synced", type_label: "image", sort_name: "2024-03-01 0003.jpg", sort_type: "image", sort_status: "Synced", sort_size: 3, sort_date: 3 },
    { id: "file:0035", display_name: "2024-03-01 0035.jpg", path: "Camera Uploads/2024-03-01 0035.jpg", kind: "file", status_label: "Synced", type_label: "image", sort_name: "2024-03-01 0035.jpg", sort_type: "image", sort_status: "Synced", sort_size: 35, sort_date: 35 },
    { id: "file:0031", display_name: "2024-03-01 0031.jpg", path: "Camera Uploads/2024-03-01 0031.jpg", kind: "file", status_label: "Synced", type_label: "image", sort_name: "2024-03-01 0031.jpg", sort_type: "image", sort_status: "Synced", sort_size: 31, sort_date: 31 },
    { id: "file:0039", display_name: "2024-03-01 0039.jpg", path: "Camera Uploads/2024-03-01 0039.jpg", kind: "file", status_label: "Synced", type_label: "image", sort_name: "2024-03-01 0039.jpg", sort_type: "image", sort_status: "Synced", sort_size: 39, sort_date: 39 },
    { id: "file:0033", display_name: "2024-03-01 0033.jpg", path: "Camera Uploads/2024-03-01 0033.jpg", kind: "file", status_label: "Synced", type_label: "image", sort_name: "2024-03-01 0033.jpg", sort_type: "image", sort_status: "Synced", sort_size: 33, sort_date: 33 },
    { id: "file:0011", display_name: "2024-03-01 0011.jpg", path: "Camera Uploads/2024-03-01 0011.jpg", kind: "file", status_label: "Synced", type_label: "image", sort_name: "2024-03-01 0011.jpg", sort_type: "image", sort_status: "Synced", sort_size: 11, sort_date: 11 },
    { id: "file:0038", display_name: "2024-03-01 0038.jpg", path: "Camera Uploads/2024-03-01 0038.jpg", kind: "file", status_label: "Synced", type_label: "image", sort_name: "2024-03-01 0038.jpg", sort_type: "image", sort_status: "Synced", sort_size: 38, sort_date: 38 },
    { id: "file:0030", display_name: "2024-03-01 0030.jpg", path: "Camera Uploads/2024-03-01 0030.jpg", kind: "file", status_label: "Synced", type_label: "image", sort_name: "2024-03-01 0030.jpg", sort_type: "image", sort_status: "Synced", sort_size: 30, sort_date: 30 },
    { id: "file:0032", display_name: "2024-03-01 0032.jpg", path: "Camera Uploads/2024-03-01 0032.jpg", kind: "file", status_label: "Synced", type_label: "image", sort_name: "2024-03-01 0032.jpg", sort_type: "image", sort_status: "Synced", sort_size: 32, sort_date: 32 },
    { id: "file:0037", display_name: "2024-03-01 0037.jpg", path: "Camera Uploads/2024-03-01 0037.jpg", kind: "file", status_label: "Synced", type_label: "image", sort_name: "2024-03-01 0037.jpg", sort_type: "image", sort_status: "Synced", sort_size: 37, sort_date: 37 },
    { id: "file:0036", display_name: "2024-03-01 0036.jpg", path: "Camera Uploads/2024-03-01 0036.jpg", kind: "file", status_label: "Synced", type_label: "image", sort_name: "2024-03-01 0036.jpg", sort_type: "image", sort_status: "Synced", sort_size: 36, sort_date: 36 },
    { id: "file:0034", display_name: "2024-03-01 0034.jpg", path: "Camera Uploads/2024-03-01 0034.jpg", kind: "file", status_label: "Synced", type_label: "image", sort_name: "2024-03-01 0034.jpg", sort_type: "image", sort_status: "Synced", sort_size: 34, sort_date: 34 },
  ];

  const filteredRows = browseSearch.filterBrowseRows(rows, { query: "003", kind: "all", status: "all", type: "all" });
  const sortedRows = browseSort.sortBrowseRows(filteredRows, "name", "asc");
  const rowIndex = virtualList.rowIndexForScrollPosition({
    rowCount: sortedRows.length,
    rowHeight: 44,
    viewportHeight: 420,
    scrollTop: (sortedRows.length * 44) - 420,
  });

  assert.equal(sortedRows.length, 11);
  assert.equal(rowIndex, 10);
  assert.equal(sortedRows[rowIndex].display_name, "2024-03-01 0039.jpg");
});
