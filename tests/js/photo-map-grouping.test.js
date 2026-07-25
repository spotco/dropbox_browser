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

test("Photo Map grouping keeps Off mode and groups nearby photos and videos", async () => {
  const grouping = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/grouping.js");
  const items = [
    photo("one.jpg", 0),
    Object.assign(photo("clip.mov", 0.00001), {photoMapMediaKind: "video", mediaKind: "video"}),
    Object.assign(photo("song.m4a", 0.00002), {photoMapMediaKind: "audio", mediaKind: "audio"}),
  ];

  const result = grouping.groupPhotoMapItems(items, 0);
  assert.deepEqual(result, items);
  const grouped = grouping.groupPhotoMapItems(items, 20);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].path, "photo-map-group:one.jpg");
  assert.equal(grouped[0].photoMapGroupCount, 2);
  assert.equal(grouped[0].photoMapGroupPhotoCount, 1);
  assert.equal(grouped[0].photoMapGroupVideoCount, 1);
  assert.equal(grouped[0].display_name, "2 media items");
  assert.deepEqual(grouped[0].photoMapGroupMembers.map((item) => item.path), ["one.jpg", "clip.mov"]);
  assert.equal(grouped[1].path, "song.m4a");
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

test("Photo Map grouping chooses the newest photo as its pin-thumbnail member", async () => {
  const grouping = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/grouping.js");
  const items = [
    Object.assign(photo("older.jpg", 39, -77), {photoMapListingDateMs: 100}),
    Object.assign(photo("video-newest.mov", 39.000001, -77), {
      photoMapMediaKind: "video",
      mediaKind: "video",
      photoMapListingDateMs: 300,
    }),
    Object.assign(photo("newest.jpg", 39.000002, -77), {photoMapListingDateMs: 200}),
  ];

  const [group] = grouping.groupPhotoMapItems(items, 20);
  assert.equal(group.photoMapGroupThumbnailPath, "newest.jpg");
  assert.equal(group.photoMapThumbnailUrl, "");
  assert.equal(group.photoMapThumbnailState, "");
});
