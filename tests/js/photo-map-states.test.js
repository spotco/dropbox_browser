const path = require("node:path");
const {pathToFileURL} = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  return import(pathToFileURL(absolutePath).href);
}

test("Photo Map state summary distinguishes located, pending, no-location, unsupported, and errors", async () => {
  const states = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/states.js");
  const candidates = [
    {path: "located.jpg", photoMapSourcePath: "located.jpg"},
    {path: "pending.jpg", photoMapSourcePath: "pending.jpg"},
    {path: "no-location.jpg", photoMapSourcePath: "no-location.jpg"},
    {path: "unsupported.heic", photoMapSourcePath: "unsupported.heic"},
    {path: "broken.jpg", photoMapSourcePath: "broken.jpg"},
  ];
  const results = new Map([
    ["located.jpg", {status: "located", latitude: 40, longitude: -74}],
    ["no-location.jpg", {status: "no-location"}],
    ["unsupported.heic", {status: "unsupported"}],
    ["broken.jpg", {status: "error"}],
  ]);

  assert.deepEqual(states.summarizePhotoMapResults(candidates, results), {
    candidateCount: 5,
    pendingCount: 1,
    locatedCount: 1,
    noLocationCount: 1,
    unsupportedCount: 1,
    errorCount: 1,
    locatedItems: [{
      path: "located.jpg",
      photoMapSourcePath: "located.jpg",
      status: "located",
      latitude: 40,
      longitude: -74,
    }],
  });
});

test("Photo Map status messages cover loading, cached, empty, and partial states", async () => {
  const states = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/states.js");

  assert.equal(states.photoMapStatusForSummary({}, "loading").state, "loading");
  assert.equal(states.photoMapStatusForSummary({candidateCount: 0}, "complete").state, "no-media");
  assert.equal(states.photoMapStatusForSummary({candidateCount: 2, locatedCount: 1, pendingCount: 1}, "cached").state, "cached");
  assert.equal(states.photoMapStatusForSummary({candidateCount: 2, locatedCount: 0, noLocationCount: 2}, "complete").state, "no-geotagged");
  const unsupported = states.photoMapStatusForSummary({candidateCount: 2, locatedCount: 0, unsupportedCount: 2}, "complete");
  assert.equal(unsupported.state, "unsupported");
  assert.match(unsupported.message, /2 recognized media use unsupported formats/);
  const mixed = states.photoMapStatusForSummary({candidateCount: 2, locatedCount: 0, noLocationCount: 1, unsupportedCount: 1}, "complete");
  assert.equal(mixed.state, "unsupported");
  assert.match(mixed.message, /1 media had no location/);
  assert.match(mixed.message, /1 recognized media use unsupported formats/);
  assert.equal(states.photoMapStatusForSummary({candidateCount: 2, locatedCount: 1, errorCount: 1}, "complete").state, "partial-errors");
  assert.equal(states.photoMapStatusForSummary({candidateCount: 2, locatedCount: 2}, "complete").state, "ready");
});
