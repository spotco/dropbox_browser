const path = require("node:path");
const {pathToFileURL} = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  return import(pathToFileURL(absolutePath).href);
}

test("Photo Map cache client builds canonical reads and bounded writes", async () => {
  const cache = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/cache.js");
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({url, options});
    return {
      ok: true,
      json: async () => ({status: "ok", entries: [], written: 1}),
    };
  };

  await cache.readPhotoMapCache(fetchImpl, "Camera Uploads");
  await cache.writePhotoMapCache(fetchImpl, "Camera Uploads", [{path: "x.jpg"}]);

  assert.equal(calls[0].url, "/photo-map/endpoints/cache?path=Camera+Uploads");
  assert.equal(calls[1].url, "/photo-map/endpoints/cache");
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[1].options.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    path: "Camera Uploads",
    entries: [{path: "x.jpg"}],
  });
});

test("Photo Map cache records preserve listing identity and parsed metadata", async () => {
  const cache = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/cache.js");
  const record = cache.photoMapCacheRecordForResult({
    path: "Camera Uploads/photo.jpg",
    photoMapListingSize: 123,
    photoMapListingModifiedTime: 1700000000,
    photoMapListingDateMs: 1700000000000,
    photoMapMediaKind: "photo",
  }, {
    status: "located",
    sourcePath: "Camera Uploads/photo.jpg",
    mediaKind: "photo",
    listingSize: 123,
    listingModifiedTime: 1700000000,
    listingDateMs: 1700000000000,
    latitude: 40.5,
    longitude: -74,
    captureDate: "2024:01:01 12:00:00",
    captureDateMs: 1704110400000,
  });

  assert.deepEqual(record, {
    path: "Camera Uploads/photo.jpg",
    source_path: "Camera Uploads/photo.jpg",
    size: 123,
    modified_time: 1700000000,
    status: "located",
    media_kind: "photo",
    latitude: 40.5,
    longitude: -74,
    capture_date: "2024:01:01 12:00:00",
    capture_date_ms: 1704110400000,
    listing_date_ms: 1700000000000,
    reason: null,
  });
});

test("Photo Map cache merge reuses only matching listing identities", async () => {
  const cache = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/cache.js");
  const candidates = [
    {
      path: "Camera Uploads/current.jpg",
      photoMapSourcePath: "Camera Uploads/current.jpg",
      photoMapListingSize: 10,
      photoMapListingModifiedTime: 20,
      photoMapListingDateMs: 20000,
      photoMapMediaKind: "photo",
    },
    {
      path: "Camera Uploads/changed.jpg",
      photoMapSourcePath: "Camera Uploads/changed.jpg",
      photoMapListingSize: 11,
      photoMapListingModifiedTime: 21,
      photoMapMediaKind: "photo",
    },
  ];
  const merged = cache.mergePhotoMapCacheCandidates(candidates, [
    {
      path: "Camera Uploads/current.jpg",
      size: 10,
      modified_time: 20,
      status: "located",
      media_kind: "photo",
      latitude: 40,
      longitude: -74,
      listing_date_ms: 20000,
    },
    {
      path: "Camera Uploads/changed.jpg",
      size: 10,
      modified_time: 20,
      status: "located",
      media_kind: "photo",
      latitude: 41,
      longitude: -75,
    },
  ]);

  assert.deepEqual(merged.cached.map((entry) => entry.item.path), ["Camera Uploads/current.jpg"]);
  assert.deepEqual(merged.pending.map((item) => item.path), ["Camera Uploads/changed.jpg"]);
  assert.equal(merged.cached[0].result.cached, true);
});

test("Photo Map cache client rejects oversized writes and bad responses", async () => {
  const cache = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/cache.js");
  const config = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/config.js");
  const entries = Array.from({length: config.PHOTO_MAP_CACHE_BATCH_LIMIT + 1}, () => ({}));

  await assert.rejects(
    cache.writePhotoMapCache(async () => ({ok: true, json: async () => ({status: "ok"})}), "", entries),
    /batch is too large/,
  );
  await assert.rejects(
    cache.readPhotoMapCache(async () => ({ok: true, json: async () => ({status: "ok"})}), ""),
    /cache response is invalid/,
  );
});
