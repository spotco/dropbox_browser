const path = require("node:path");
const {pathToFileURL} = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  return import(pathToFileURL(absolutePath).href);
}

test("applyBrowseSnapshot clears folder path when navigating back to root", async () => {
  const stateModule = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/state.js");

  const state = stateModule.createBrowseState({path: "folder", sort: "name", dir: "asc"});
  stateModule.applyBrowseSnapshot(state, {
    page: {path: ""},
    sort: {current_key: "name", current_direction: "asc"},
    rows: [{id: "root-file", path: "remote-only.txt"}],
  });

  assert.equal(state.path, "");
});

test("applyBrowseSnapshot normalizes sort state from listing payload", async () => {
  const stateModule = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/state.js");

  const state = stateModule.createBrowseState({path: "", sort: "name", dir: "asc"});
  stateModule.applyBrowseSnapshot(state, {
    page: {path: "music"},
    sort: {current_key: "date", current_direction: "desc"},
    rows: [],
  });

  assert.equal(state.path, "music");
  assert.equal(state.sort, "date");
  assert.equal(state.dir, "desc");
});