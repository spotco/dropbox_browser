const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  let source = await fs.readFile(absolutePath, "utf8");
  if (relativePath.endsWith("music-library-helpers.js")) {
    const keyPath = path.resolve(path.dirname(absolutePath), "filename-compare-key.js");
    const keySource = await fs.readFile(keyPath, "utf8");
    const keyUrl = `data:text/javascript;base64,${Buffer.from(keySource, "utf8").toString("base64")}`;
    source = source.replace("'./filename-compare-key.js'", `'${keyUrl}'`);
  }
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

test("sortLibraryItems treats casefold-equivalent names as duplicates for ordering", async () => {
  const helpers = await importModuleFromWorkspace("dropbox_browser/assets/js/music-library-helpers.js");
  const items = [
    { id: "song:strasse", type: "file", display_name: "STRASSE.mp3", mtime: 10 },
    { id: "song:eszett", type: "file", display_name: "Stra\u00DFe.mp3", mtime: 20 },
    { id: "song:alpha", type: "file", display_name: "Alpha.mp3", mtime: 30 },
  ];

  const sorted = helpers.sortLibraryItems(items, "name", "asc");

  assert.deepEqual(
    sorted.map((item) => item.id),
    ["song:alpha", "song:strasse", "song:eszett"],
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

test("libraryNodeDateSortValue prefers recursive folder mtime over direct mtime", async () => {
  const helpers = await importModuleFromWorkspace("dropbox_browser/assets/js/music-library-helpers.js");

  assert.equal(
    helpers.libraryNodeDateSortValue({
      type: "folder",
      mtime: 10,
      recursive_mtime: 50,
    }),
    50,
  );
  assert.equal(
    helpers.libraryNodeDateSortValue({
      type: "folder",
      mtime: 10,
    }),
    10,
  );
  assert.equal(
    helpers.libraryNodeDateSortValue({
      type: "file",
      mtime: 22,
      recursive_mtime: 99,
    }),
    22,
  );
  assert.equal(helpers.libraryNodeDateSortValue(null), 0);
});

test("sortLibraryItems date ascending reverses the default date comparison", async () => {
  const helpers = await importModuleFromWorkspace("dropbox_browser/assets/js/music-library-helpers.js");
  const items = [
    { id: "song:new", type: "file", display_name: "New.mp3", mtime: 30 },
    { id: "song:old", type: "file", display_name: "Old.mp3", mtime: 10 },
    { id: "song:mid", type: "file", display_name: "Mid.mp3", mtime: 20 },
  ];

  assert.deepEqual(
    helpers.sortLibraryItems(items, "date", "asc").map((item) => item.id),
    ["song:old", "song:mid", "song:new"],
  );
});
