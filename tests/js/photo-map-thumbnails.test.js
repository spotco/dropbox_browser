const path = require("node:path");
const {pathToFileURL} = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  return import(pathToFileURL(absolutePath).href);
}

function item(path, mediaKind = "photo") {
  return {path, photoMapSourcePath: path, photoMapMediaKind: mediaKind};
}

test("Photo Map thumbnail selection requires located visible/selected photos", async () => {
  const thumbnails = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/thumbnails.js");
  const candidates = [
    item("Camera Uploads/visible.jpg"),
    item("Camera Uploads/selected.jpg"),
    item("Camera Uploads/video.mov", "video"),
    item("Camera Uploads/not-located.jpg"),
  ];
  const selected = thumbnails.selectPhotoMapThumbnailItems(candidates, {
    visiblePaths: ["Camera Uploads/visible.jpg"],
    selectedPath: "Camera Uploads/selected.jpg",
    metadataResults: new Map([
      ["Camera Uploads/visible.jpg", {path: "Camera Uploads/visible.jpg", status: "located", mediaKind: "photo"}],
      ["Camera Uploads/selected.jpg", {path: "Camera Uploads/selected.jpg", status: "located", mediaKind: "photo"}],
      ["Camera Uploads/video.mov", {path: "Camera Uploads/video.mov", status: "located", mediaKind: "video"}],
      ["Camera Uploads/not-located.jpg", {path: "Camera Uploads/not-located.jpg", status: "no-location", mediaKind: "photo"}],
    ]),
  });

  assert.deepEqual(selected.map((candidate) => candidate.path), [
    "Camera Uploads/visible.jpg",
    "Camera Uploads/selected.jpg",
  ]);
  assert.equal(
    selected[0].photoMapThumbnailUrl,
    "/thumbnail?path=Camera+Uploads%2Fvisible.jpg&source=remote",
  );
});

test("Photo Map thumbnail queue limits work and returns loaded URLs", async () => {
  const thumbnails = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/thumbnails.js");
  const active = new Set();
  let maximumActive = 0;
  const results = await thumbnails.runPhotoMapThumbnailQueue([
    item("one.jpg"), item("two.jpg"), item("three.jpg"),
  ], {
    concurrency: 2,
    loader: async (candidate) => {
      active.add(candidate.path);
      maximumActive = Math.max(maximumActive, active.size);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active.delete(candidate.path);
      return {url: `/thumbnail?path=${candidate.path}&source=remote`};
    },
  });

  assert.equal(maximumActive, 2);
  assert.equal(results.results.length, 3);
  assert.deepEqual(results.results.map((entry) => entry.result.status), ["loaded", "loaded", "loaded"]);
});

test("Photo Map thumbnail queue aborts active and queued work", async () => {
  const thumbnails = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/thumbnails.js");
  const controller = new AbortController();
  const started = [];
  const running = thumbnails.runPhotoMapThumbnailQueue([
    item("one.jpg"), item("two.jpg"), item("three.jpg"),
  ], {
    concurrency: 1,
    signal: controller.signal,
    loader: async (candidate, signal) => {
      started.push(candidate.path);
      await new Promise((resolve) => signal.addEventListener("abort", resolve, {once: true}));
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  const report = await running;

  assert.deepEqual(started, ["one.jpg"]);
  assert.equal(report.aborted, true);
  assert.equal(report.queued, true);
  assert.deepEqual(report.results, []);
});
