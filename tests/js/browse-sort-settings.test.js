const path = require("node:path");
const {pathToFileURL} = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  return import(pathToFileURL(absolutePath).href);
}

test("browse sort settings persist independently for each folder", async () => {
  const settings = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/sort-settings.js");

  let entries = {};
  assert.deepEqual(settings.readBrowseSortState("music", entries), {key: "name", direction: "asc"});

  entries = settings.writeBrowseSortState("music", "date", "desc", entries);
  entries = settings.writeBrowseSortState("music/album", "size", "asc", entries);

  assert.deepEqual(settings.readBrowseSortState("music", entries), {key: "date", direction: "desc"});
  assert.deepEqual(settings.readBrowseSortState("music/album", entries), {key: "size", direction: "asc"});
  assert.deepEqual(settings.readBrowseSortState("other", entries), {key: "name", direction: "asc"});
});

test("browse sort settings normalize malformed saved values", async () => {
  const settings = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/sort-settings.js");

  assert.deepEqual(
    settings.readBrowseSortState("music", {music: {key: "invalid", direction: "sideways"}}),
    {key: "name", direction: "asc"},
  );
  assert.deepEqual(settings.readBrowseSortState("music", {music: null}), {key: "name", direction: "asc"});
});
