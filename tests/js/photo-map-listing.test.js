const path = require("node:path");
const {pathToFileURL} = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  return import(pathToFileURL(absolutePath).href);
}

function row(path, sortDate, extra) {
  return Object.assign({
    path: path,
    display_name: path.split('/').pop(),
    kind: 'file',
    remote: true,
    sort_date: sortDate,
  }, extra || {});
}

test("selectPhotoMapCandidates keeps direct remote iPhone media and orders newest first", async () => {
  const listing = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/listing.js");
  const candidates = listing.selectPhotoMapCandidates([
    row("Camera Uploads/old.jpg", 100),
    row("Camera Uploads/new.MOV", 300),
    row("Camera Uploads/other.mp4", 200),
    row("Camera Uploads/nested/new.jpg", 400),
    row("Camera Uploads/local.jpg", 500, {remote: false}),
    row("Camera Uploads/unsupported.heic", 600),
  ], "Camera Uploads", "all");

  assert.deepEqual(candidates.map((item) => item.path), [
    "Camera Uploads/unsupported.heic",
    "Camera Uploads/new.MOV",
    "Camera Uploads/other.mp4",
    "Camera Uploads/old.jpg",
  ]);
  assert.equal(candidates[0].photoMapMediaKind, "photo");
  assert.equal(candidates[0].photoMapRecognition.status, "unsupported");
  assert.equal(candidates[1].photoMapSourcePath, "Camera Uploads/new.MOV");
  assert.equal(candidates[1].photoMapRecognition.parser, "quicktime-location");
});

test("Photo Map config recognizes supported formats and reports unsupported formats", async () => {
  const config = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/config.js");

  assert.equal(config.PHOTO_MAP_DATE_PRESETS.all.usesFromTo, false);
  assert.equal(config.PHOTO_MAP_DATE_PRESETS["90-days"].usesFromTo, false);
  assert.equal(config.PHOTO_MAP_DATE_PRESETS["1-year"].usesFromTo, false);
  assert.equal(config.PHOTO_MAP_DATE_PRESETS.custom.usesFromTo, true);

  assert.deepEqual(config.classifyPhotoMapCandidate({display_name: "IMG_0001.JPG"}), {
    status: "supported",
    extension: ".jpg",
    mediaKind: "photo",
    parser: "jpeg-exif-gps",
  });
  assert.deepEqual(config.classifyPhotoMapCandidate({display_name: "IMG_0002.MP4"}), {
    status: "supported",
    extension: ".mp4",
    mediaKind: "video",
    parser: "quicktime-location",
  });
  assert.equal(config.classifyPhotoMapCandidate({display_name: "IMG_0003.HEIC"}).status, "unsupported");
  assert.equal(config.classifyPhotoMapCandidate({display_name: "image.png"}).reason, "format-not-supported");
  assert.equal(config.classifyPhotoMapCandidate({display_name: "notes.txt"}).mediaKind, null);
});

test("Photo Map config exposes bounded range and queue defaults", async () => {
  const config = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/config.js");

  assert.deepEqual(config.PHOTO_MAP_JPEG_EXTENSIONS, [".jpg", ".jpeg"]);
  assert.deepEqual(config.PHOTO_MAP_VIDEO_EXTENSIONS, [".mov", ".mp4"]);
  assert.equal(config.PHOTO_MAP_JPEG_HEAD_RANGE_BYTES, 256 * 1024);
  assert.equal(config.PHOTO_MAP_QUICKTIME_HEAD_RANGE_BYTES, 1024 * 1024);
  assert.equal(config.PHOTO_MAP_QUICKTIME_TAIL_RANGE_BYTES, 1024 * 1024);
  assert.equal(config.PHOTO_MAP_METADATA_CONCURRENCY, 3);
  assert.equal(config.PHOTO_MAP_THUMBNAIL_CONCURRENCY, 2);
});

test("selectPhotoMapCandidates applies preset and custom date ranges", async () => {
  const listing = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/listing.js");
  const now = Date.UTC(2026, 6, 22, 12);
  const rows = [
    row("folder/today.jpg", now / 1000),
    row("folder/recent.jpg", (now - 89 * 24 * 60 * 60 * 1000) / 1000),
    row("folder/old.jpg", (now - 91 * 24 * 60 * 60 * 1000) / 1000),
  ];

  assert.deepEqual(
    listing.selectPhotoMapCandidates(rows, "folder", "90-days", now).map((item) => item.path),
    ["folder/today.jpg", "folder/recent.jpg"],
  );
  assert.deepEqual(
    listing.selectPhotoMapCandidates(rows, "folder", {
      preset: "custom",
      from: new Date(now - 89 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      to: new Date(now - 89 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    }, now).map((item) => item.path),
    ["folder/recent.jpg"],
  );
});

test("buildPhotoMapListingEndpoint requests only the current folder", async () => {
  const listing = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/listing.js");

  assert.equal(
    listing.buildPhotoMapListingEndpoint("Camera Uploads"),
    "/browse/endpoints/listing?path=Camera+Uploads",
  );
  assert.equal(
    listing.buildPhotoMapListingEndpoint("Camera Uploads", true),
    "/browse/endpoints/listing?path=Camera+Uploads&refresh=1",
  );
});
