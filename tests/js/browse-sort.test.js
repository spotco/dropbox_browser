const path = require("node:path");
const {pathToFileURL} = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  return import(pathToFileURL(absolutePath).href);
}

test("sortBrowseRows keeps folders ahead of files for name sorting", async () => {
  const browseSort = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/sort.js");
  const rows = [
    { id: "file:z", kind: "file", sort_name: "zebra", sort_type: "txt", sort_status: "Synced", sort_size: 1, sort_date: 10 },
    { id: "folder:b", kind: "folder", sort_name: "bravo", sort_type: "folder", sort_status: "Loading", sort_size: 0, sort_date: 20 },
    { id: "folder:a", kind: "folder", sort_name: "alpha", sort_type: "folder", sort_status: "Loading", sort_size: 0, sort_date: 30 },
    { id: "file:a", kind: "file", sort_name: "alpha", sort_type: "txt", sort_status: "Synced", sort_size: 2, sort_date: 40 },
  ];

  const sorted = browseSort.sortBrowseRows(rows, "name", "asc");

  assert.deepEqual(sorted.map((row) => row.id), ["folder:a", "folder:b", "file:a", "file:z"]);
});

test("sortBrowseRows applies descending numeric date sorting with name fallback", async () => {
  const browseSort = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/sort.js");
  const rows = [
    { id: "file:b", kind: "file", sort_name: "bravo", sort_type: "txt", sort_status: "Synced", sort_size: 1, sort_date: 50 },
    { id: "file:a", kind: "file", sort_name: "alpha", sort_type: "txt", sort_status: "Synced", sort_size: 1, sort_date: 50 },
    { id: "file:c", kind: "file", sort_name: "charlie", sort_type: "txt", sort_status: "Synced", sort_size: 1, sort_date: 10 },
  ];

  const sorted = browseSort.sortBrowseRows(rows, "date", "desc");

  assert.deepEqual(sorted.map((row) => row.id), ["file:b", "file:a", "file:c"]);
});

test("compareBrowseRows uses requested status field before name fallback", async () => {
  const browseSort = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/sort.js");
  const left = { id: "file:left", kind: "file", sort_name: "alpha", sort_type: "txt", sort_status: "Dropbox Only", sort_size: 1, sort_date: 1 };
  const right = { id: "file:right", kind: "file", sort_name: "bravo", sort_type: "txt", sort_status: "Local Only", sort_size: 1, sort_date: 1 };

  assert.ok(browseSort.compareBrowseRows(left, right, "status", "asc") < 0);
});

test("nextBrowseSortState toggles active sort direction and resets new sorts to ascending", async () => {
  const browseSort = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/sort.js");

  assert.deepEqual(
    browseSort.nextBrowseSortState("name", "asc", "name"),
    { sort: "name", dir: "desc" },
  );
  assert.deepEqual(
    browseSort.nextBrowseSortState("name", "desc", "date"),
    { sort: "date", dir: "asc" },
  );
});
