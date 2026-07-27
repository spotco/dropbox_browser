const path = require("node:path");
const {pathToFileURL} = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  return import(pathToFileURL(absolutePath).href);
}

test("Photo Map thumbnail store keeps a ready URL across scheduler demotion", async () => {
  const storeModule = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/thumbnail-store.js");
  const store = storeModule.createPhotoMapThumbnailStore();
  const item = {path: "group/photo.jpg", mediaKind: "photo"};
  const transitions = [];
  store.subscribe((next, previous, reason) => transitions.push({next, previous, reason}));

  store.setState(item, "loading", {reason: "request-started"});
  store.setResult(item, {path: item.path, status: "loaded", url: "/thumbnail?photo"});
  store.setState(item, "idle", {reason: "priority-preemption"});

  assert.equal(store.get(item.path).state, "ready");
  assert.equal(store.getResult(item.path).url, "/thumbnail?photo");
  assert.deepEqual(transitions.map((transition) => transition.next.state), ["loading", "ready"]);
});

test("Photo Map thumbnail store reports path-keyed state and supports reset", async () => {
  const storeModule = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/thumbnail-store.js");
  const store = storeModule.createPhotoMapThumbnailStore();

  store.setResult({photoMapSourcePath: "group/video.mov"}, {
    status: "loaded",
    url: "/video/endpoints/thumbnail?path=video.mov",
  });
  store.setState({path: "group/error.jpg"}, "error", {reason: "thumbnail-load-failure"});

  assert.deepEqual(store.readyPaths(), ["group/video.mov"]);
  assert.equal(store.get("group/error.jpg").errorReason, "thumbnail-load-failure");
  assert.equal(store.snapshot().length, 2);
  store.clear();
  assert.deepEqual(store.snapshot(), []);
});
