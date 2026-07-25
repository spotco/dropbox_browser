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

function deferred() {
  let resolve;
  const promise = new Promise((finish) => { resolve = finish; });
  return {promise, resolve};
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

test("Photo Map thumbnail scheduler prioritizes selected pins and drops offscreen work", async () => {
  const thumbnails = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/thumbnails.js");
  const firstGate = deferred();
  const selectedGate = deferred();
  const started = [];
  const states = [];
  const scheduler = thumbnails.createPhotoMapThumbnailScheduler({
    concurrency: 1,
    loader: async (candidate, signal) => {
      started.push(candidate.path);
      if (candidate.path === "two.jpg") {
        await Promise.race([
          selectedGate.promise,
          new Promise((resolve) => signal.addEventListener("abort", resolve, {once: true})),
        ]);
        if (signal.aborted) {
          const error = new Error("aborted");
          error.name = "AbortError";
          throw error;
        }
      }
      if (candidate.path === "one.jpg") {
        await Promise.race([
          firstGate.promise,
          new Promise((resolve) => signal.addEventListener("abort", resolve, {once: true})),
        ]);
        if (signal.aborted) {
          const error = new Error("aborted");
          error.name = "AbortError";
          throw error;
        }
      }
      return {url: `/thumbnail?path=${candidate.path}&source=remote`};
    },
    onState: (candidate, state) => states.push([candidate.path, state]),
  });

  scheduler.update([{path: "one.jpg"}, {path: "two.jpg"}], {selectedPath: "two.jpg"});
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(started, ["two.jpg"]);

  // The selected request is active; removing it from view aborts it and lets
  // the remaining visible pin become the next job.
  scheduler.update([{path: "one.jpg"}]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(started, ["two.jpg", "one.jpg"]);
  assert.deepEqual(scheduler.getPendingPaths(), []);
  assert.ok(states.some(([path, state]) => path === "two.jpg" && state === "idle"));
  selectedGate.resolve();
  firstGate.resolve();
});

test("Photo Map thumbnail scheduler gives visible grouped popup cells priority over map pins", async () => {
  const thumbnails = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/thumbnails.js");
  const firstGate = deferred();
  const secondGate = deferred();
  const started = [];
  const scheduler = thumbnails.createPhotoMapThumbnailScheduler({
    concurrency: 1,
    loader: async (candidate) => {
      started.push(candidate.path);
      if (candidate.path === "group-first.jpg") await firstGate.promise;
      if (candidate.path === "group-second.jpg") await secondGate.promise;
      return {url: `/thumbnail?path=${candidate.path}&source=remote`};
    },
  });

  scheduler.update([
    {path: "selected-map-pin.jpg"},
    {path: "group-first.jpg", photoMapThumbnailPriority: -1000000},
    {path: "group-second.jpg", photoMapThumbnailPriority: -999999},
  ], {selectedPath: "selected-map-pin.jpg"});
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(started, ["group-first.jpg"]);

  firstGate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(started, ["group-first.jpg", "group-second.jpg"]);
  secondGate.resolve();
});

test("Photo Map thumbnail scheduler keeps popup priority when a group-pin representative is duplicated", async () => {
  const thumbnails = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/thumbnails.js");
  const started = [];
  const gate = deferred();
  const scheduler = thumbnails.createPhotoMapThumbnailScheduler({
    concurrency: 1,
    loader: async (candidate) => {
      started.push(candidate.path);
      await gate.promise;
      return {url: `/thumbnail?path=${candidate.path}&source=remote`};
    },
  });

  scheduler.update([
    {path: "map-pin.jpg"},
    {path: "group-latest.jpg"},
    {path: "group-latest.jpg", photoMapThumbnailPriority: -1000000},
  ]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(started, ["group-latest.jpg"]);
  gate.resolve();
});

test("Photo Map thumbnail scheduler promotes an active group-pin representative without restarting it", async () => {
  const thumbnails = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/thumbnails.js");
  const started = [];
  const active = deferred();
  const scheduler = thumbnails.createPhotoMapThumbnailScheduler({
    concurrency: 1,
    loader: async (candidate) => {
      started.push(candidate.path);
      await active.promise;
      return {url: `/thumbnail?path=${candidate.path}&source=remote`};
    },
  });

  scheduler.update([{path: "group-latest.jpg"}]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  scheduler.update([
    {path: "group-latest.jpg", photoMapThumbnailPriority: -1000000},
    {path: "group-next.jpg", photoMapThumbnailPriority: -999999},
  ]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(started, ["group-latest.jpg"]);
  active.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(started, ["group-latest.jpg", "group-next.jpg"]);
  scheduler.cancel();
});

test("Photo Map thumbnail scheduler preempts lower-priority active map pins for a grouped popup", async () => {
  const thumbnails = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/thumbnails.js");
  const started = [];
  const groupGate = deferred();
  const scheduler = thumbnails.createPhotoMapThumbnailScheduler({
    concurrency: 1,
    loader: async (candidate, signal) => {
      started.push(candidate.path);
      if (candidate.path === "map-pin.jpg") {
        await new Promise((resolve) => signal.addEventListener("abort", resolve, {once: true}));
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }
      await groupGate.promise;
      return {url: `/thumbnail?path=${candidate.path}&source=remote`};
    },
  });

  scheduler.update([{path: "map-pin.jpg"}]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(started, ["map-pin.jpg"]);

  scheduler.update([
    {path: "map-pin.jpg"},
    {path: "group-visible.jpg", photoMapThumbnailPriority: -1000000},
  ]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(started, ["map-pin.jpg", "group-visible.jpg"]);
  groupGate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  scheduler.cancel();
});

test("Photo Map thumbnail scheduler suppresses late offscreen results and reuses loaded cache", async () => {
  const thumbnails = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/thumbnails.js");
  const late = deferred();
  const loaded = deferred();
  let loadCount = 0;
  const results = [];
  const scheduler = thumbnails.createPhotoMapThumbnailScheduler({
    concurrency: 1,
    loader: async (candidate) => {
      loadCount += 1;
      if (candidate.path === "late.jpg") return late.promise;
      return loaded.promise;
    },
    onResult: (_candidate, result) => results.push(result),
  });

  scheduler.update([{path: "late.jpg"}]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  scheduler.update([]);
  late.resolve({url: "/thumbnail?path=late.jpg&source=remote"});
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(scheduler.getCached("late.jpg"), null);
  assert.equal(results.length, 0);

  scheduler.update([{path: "cached.jpg"}]);
  loaded.resolve({url: "/thumbnail?path=cached.jpg&source=remote"});
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(scheduler.getCached("cached.jpg"));
  scheduler.update([]);
  scheduler.update([{path: "cached.jpg"}]);
  assert.equal(loadCount, 2);
  assert.equal(results.length, 1);
});
