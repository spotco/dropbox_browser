const path = require("node:path");
const {pathToFileURL} = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  return import(pathToFileURL(absolutePath).href);
}

test("filterBrowseRows matches query, kind, status, and type locally", async () => {
  const browseSearch = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/search.js");
  const rows = [
    { id: "folder:music", display_name: "Music", path: "Music", kind: "folder", status_label: "Loading", type_label: "folder" },
    { id: "file:mix", display_name: "Mix.FLAC", path: "Music/Mix.FLAC", kind: "file", status_label: "Dropbox Only", type_label: "audio" },
    { id: "file:notes", display_name: "notes.txt", path: "notes.txt", kind: "file", status_label: "Local Only", type_label: "txt" },
  ];

  assert.deepEqual(
    browseSearch.filterBrowseRows(rows, { query: "mix", kind: "all", status: "all", type: "all" }).map((row) => row.id),
    ["file:mix"],
  );
  assert.deepEqual(
    browseSearch.filterBrowseRows(rows, { query: "", kind: "folder", status: "all", type: "all" }).map((row) => row.id),
    ["folder:music"],
  );
  assert.deepEqual(
    browseSearch.filterBrowseRows(rows, { query: "", kind: "all", status: "Local Only", type: "all" }).map((row) => row.id),
    ["file:notes"],
  );
  assert.deepEqual(
    browseSearch.filterBrowseRows(rows, { query: "", kind: "all", status: "all", type: "audio" }).map((row) => row.id),
    ["file:mix"],
  );
});

test("filterBrowseRows query does not match parent folder segments from the full path", async () => {
  const browseSearch = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/search.js");
  const rows = [
    { id: "folder:alpha", display_name: "alpha", path: "music/alpha", kind: "folder", status_label: "Synced", type_label: "folder" },
    { id: "file:beta", display_name: "beta.mp3", path: "music/beta.mp3", kind: "file", status_label: "Synced", type_label: "audio" },
  ];

  assert.deepEqual(
    browseSearch.filterBrowseRows(rows, { query: "music", kind: "all", status: "all", type: "all" }).map((row) => row.id),
    [],
  );
});

test("collectBrowseTypeOptions returns unique sorted type labels", async () => {
  const browseSearch = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/search.js");
  const rows = [
    { type_label: "txt" },
    { type_label: "folder" },
    { type_label: "audio" },
    { type_label: "txt" },
  ];

  assert.deepEqual(browseSearch.collectBrowseTypeOptions(rows), ["audio", "folder", "txt"]);
});

test("hasActiveBrowseFilters ignores default empty filter values", async () => {
  const browseSearch = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/search.js");

  assert.equal(browseSearch.hasActiveBrowseFilters({ query: "", kind: "all", status: "all", type: "all" }), false);
  assert.equal(browseSearch.hasActiveBrowseFilters({ query: "music", kind: "all", status: "all", type: "all" }), true);
});
