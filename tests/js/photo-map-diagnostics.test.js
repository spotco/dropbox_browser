const path = require("node:path");
const {pathToFileURL} = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  return import(pathToFileURL(absolutePath).href);
}

test("Photo Map diagnostics stay quiet unless the subsystem is enabled", async () => {
  const diagnosticsModule = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/diagnostics.js");
  const calls = [];
  const diagnostics = diagnosticsModule.createPhotoMapDiagnostics({
    ClientLogger: {
      enabledFor: () => false,
      info: (...args) => calls.push(args),
    },
  });

  diagnostics.beginGeneration(4);
  diagnostics.increment("cacheHits", 3);
  diagnostics.logSummary("cache summary");

  assert.deepEqual(diagnostics.snapshot(), {
    generation: 4,
    cacheReads: 0,
    cacheReadErrors: 0,
    cacheEntries: 0,
    cacheHits: 3,
    cacheMisses: 0,
    cacheWriteBatches: 0,
    cacheWriteEntries: 0,
    cacheWriteErrors: 0,
    metadataQueued: 0,
    metadataCompleted: 0,
    metadataLocated: 0,
    metadataNoLocation: 0,
    metadataUnsupported: 0,
    metadataErrors: 0,
    metadataAborted: 0,
    thumbnailQueued: 0,
    thumbnailCompleted: 0,
    thumbnailErrors: 0,
    thumbnailAborted: 0,
    groupedThumbnailQueued: 0,
    groupedThumbnailCompleted: 0,
    groupedThumbnailErrors: 0,
    groupedThumbnailCancelled: 0,
    groupCount: 0,
    groupedMemberCount: 0,
    groupingDistanceMeters: 0,
  });
  assert.deepEqual(calls, []);
});

test("Photo Map diagnostics emit concise generation counters when enabled", async () => {
  const diagnosticsModule = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/diagnostics.js");
  const calls = [];
  const diagnostics = diagnosticsModule.createPhotoMapDiagnostics({
    ClientLogger: {
      enabledFor: (subsystem) => subsystem === "photo-map",
      info: (...args) => { calls.push(args); return true; },
    },
  });

  diagnostics.beginGeneration(8);
  diagnostics.increment("metadataQueued", 5);
  diagnostics.increment("metadataLocated", 2);
  diagnostics.increment("metadataNoLocation", 3);
  diagnostics.logSummary("Photo Map metadata queue summary", {queued: 5, completed: 5});

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "photo-map");
  assert.equal(calls[0][1], "Photo Map metadata queue summary");
  assert.deepEqual(calls[0][2], {
    generation: 8,
    cacheReads: 0,
    cacheReadErrors: 0,
    cacheEntries: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheWriteBatches: 0,
    cacheWriteEntries: 0,
    cacheWriteErrors: 0,
    metadataQueued: 5,
    metadataCompleted: 0,
    metadataLocated: 2,
    metadataNoLocation: 3,
    metadataUnsupported: 0,
    metadataErrors: 0,
    metadataAborted: 0,
    thumbnailQueued: 0,
    thumbnailCompleted: 0,
    thumbnailErrors: 0,
    thumbnailAborted: 0,
    groupedThumbnailQueued: 0,
    groupedThumbnailCompleted: 0,
    groupedThumbnailErrors: 0,
    groupedThumbnailCancelled: 0,
    groupCount: 0,
    groupedMemberCount: 0,
    groupingDistanceMeters: 0,
    queued: 5,
    completed: 5,
  });
});
