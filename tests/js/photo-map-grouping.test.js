const path = require("node:path");
const {pathToFileURL} = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  return import(pathToFileURL(absolutePath).href);
}

function photo(path, latitude, longitude = 0) {
  return {
    path,
    photoMapSourcePath: path,
    photoMapMediaKind: "photo",
    mediaKind: "photo",
    latitude,
    longitude,
  };
}

test("Photo Map grouping keeps Off mode and videos unchanged", async () => {
  const grouping = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/grouping.js");
  const items = [
    photo("one.jpg", 0),
    Object.assign(photo("clip.mov", 0.00001), {photoMapMediaKind: "video", mediaKind: "video"}),
  ];

  const result = grouping.groupPhotoMapItems(items, 0);
  assert.deepEqual(result, items);
  assert.equal(grouping.groupPhotoMapItems(items, 20)[1].path, "clip.mov");
});

test("Photo Map grouping uses stable anchors and does not form transitive chains", async () => {
  const grouping = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/grouping.js");
  // One degree of latitude is about 111 km: these are approximately 15 m
  // apart, so the third item is outside the first anchor's 20 m radius.
  const items = [
    photo("first.jpg", 0),
    photo("second.jpg", 0.000135),
    photo("third.jpg", 0.000270),
    photo("separate.jpg", 0.001),
  ];

  const result = grouping.groupPhotoMapItems(items, 20);
  assert.deepEqual(result.map((item) => item.path), [
    "photo-map-group:first.jpg",
    "third.jpg",
    "separate.jpg",
  ]);
  assert.equal(result[0].photoMapGroupCount, 2);
  assert.deepEqual(result[0].photoMapGroupMembers.map((item) => item.path), [
    "first.jpg",
    "second.jpg",
  ]);
});

test("Photo Map grouping preserves order, metadata, and large group counts", async () => {
  const grouping = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/grouping.js");
  const items = Array.from({length: 25}, (_value, index) => photo(
    String(index).padStart(2, "0") + ".jpg",
    39 + index * 0.000001,
    -77,
  ));
  items[0].captureDate = "2024:01:01 12:00:00";

  const result = grouping.groupPhotoMapItems(items, 20);
  assert.equal(result.length, 1);
  assert.equal(result[0].photoMapGroupCount, 25);
  assert.equal(result[0].photoMapGroupMembers[0].captureDate, "2024:01:01 12:00:00");
  assert.equal(result[0].photoMapGroupId, "photo-map-group:00.jpg");
});
