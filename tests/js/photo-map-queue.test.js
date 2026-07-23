const path = require("node:path");
const {pathToFileURL} = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  return import(pathToFileURL(absolutePath).href);
}

function deferred() {
  let resolve;
  const promise = new Promise((finish) => { resolve = finish; });
  return {promise, resolve};
}

test("Photo Map metadata queue respects concurrency and aborts queued work", async () => {
  const queue = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/queue.js");
  const controller = new AbortController();
  const started = [];
  const completed = [];
  const gates = new Map();
  const items = ["one", "two", "three", "four"].map((path) => ({path}));

  const running = queue.runPhotoMapMetadataQueue(items, async (item, signal) => {
    started.push(item.path);
    const gate = deferred();
    gates.set(item.path, gate);
    await Promise.race([
      gate.promise,
      new Promise((resolve) => signal.addEventListener("abort", resolve, {once: true})),
    ]);
    if (signal.aborted) {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }
    completed.push(item.path);
    return {path: item.path, status: "no-location"};
  }, {concurrency: 2, signal: controller.signal});

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(started.sort(), ["one", "two"]);
  controller.abort();
  const report = await running;

  assert.deepEqual(completed, []);
  assert.equal(report.aborted, true);
  assert.equal(report.queued, true);
  assert.deepEqual(started.sort(), ["one", "two"]);
});

test("Photo Map metadata queue suppresses late results from an old generation", async () => {
  const queue = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/queue.js");
  const gate = deferred();
  let current = true;
  const callbacks = [];
  const running = queue.runPhotoMapMetadataQueue([{path: "old.jpg"}], async () => {
    await gate.promise;
    return {status: "located", path: "old.jpg"};
  }, {
    concurrency: 1,
    isCurrent: () => current,
    onResult: (_item, result) => callbacks.push(result),
  });

  current = false;
  gate.resolve();
  const report = await running;

  assert.equal(report.aborted, true);
  assert.deepEqual(report.results, []);
  assert.deepEqual(callbacks, []);
});
