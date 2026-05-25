const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  const source = await fs.readFile(absolutePath, "utf8");
  return import(`data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`);
}

test("sortLibraryItems sorts by date descending with name fallback", async () => {
  const helpers = await importModuleFromWorkspace("dropbox_browser/assets/js/music-library-helpers.js");
  const items = [
    { id: "song:b", type: "file", display_name: "Bravo.mp3", mtime: 20 },
    { id: "folder:a", type: "folder", display_name: "Album", mtime: 10, recursive_mtime: 50 },
    { id: "song:a", type: "file", display_name: "Alpha.mp3", mtime: 20 },
  ];

  const sorted = helpers.sortLibraryItems(items, "date", "desc");

  assert.deepEqual(
    sorted.map((item) => item.id),
    ["folder:a", "song:a", "song:b"],
  );
});

test("sortLibraryItems sorts by name descending when requested", async () => {
  const helpers = await importModuleFromWorkspace("dropbox_browser/assets/js/music-library-helpers.js");
  const items = [
    { id: "song:a", type: "file", display_name: "Alpha.mp3", mtime: 10 },
    { id: "song:c", type: "file", display_name: "charlie.mp3", mtime: 20 },
    { id: "song:b", type: "file", display_name: "Bravo.mp3", mtime: 30 },
  ];

  const sorted = helpers.sortLibraryItems(items, "name", "desc");

  assert.deepEqual(
    sorted.map((item) => item.id),
    ["song:c", "song:b", "song:a"],
  );
});

test("firstSelectedVisibleNodeId keeps the first selected row in tree order", async () => {
  const helpers = await importModuleFromWorkspace("dropbox_browser/assets/js/music-library-helpers.js");
  const visibleNodeIds = ["folder:root", "song:two", "song:one", "song:three"];
  const selectedIds = { "song:one": true, "song:two": true, "song:three": true };

  assert.equal(
    helpers.firstSelectedVisibleNodeId(visibleNodeIds, selectedIds, "song:three"),
    "song:two",
  );
});
