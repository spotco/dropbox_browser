const path = require("node:path");
const {pathToFileURL} = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  return import(pathToFileURL(absolutePath).href);
}

test("buildFileSearchEndpoint normalizes path and query state", async () => {
  const api = await importModuleFromWorkspace("dropbox_browser/assets/js/file-search-api.js");
  assert.equal(
    api.buildFileSearchEndpoint({path: "Music\\Albums/./Dreams", query: "fantasy", recursive: true}),
    "/browse/endpoints/search?path=Music%2FAlbums%2FDreams&recursive=1&query=fantasy",
  );
  assert.equal(
    api.buildFileSearchEndpoint({path: "", query: "", recursive: true}),
    "/browse/endpoints/search?recursive=1",
  );
});
test("normalizeFileSearchState rejects parent traversal segments", async () => {
  const api = await importModuleFromWorkspace("dropbox_browser/assets/js/file-search-api.js");
  assert.throws(
    function () {
      api.normalizeFileSearchState({path: "../Music"});
    },
    /Parent path segments are not allowed/,
  );
});
test("buildFileSearchEndpoint emits bounded search session controls", async () => {
  const api = await importModuleFromWorkspace("dropbox_browser/assets/js/file-search-api.js");
  assert.equal(
    api.buildFileSearchEndpoint({path: "Music", query: "track", session: true, limit: 25}),
    "/browse/endpoints/search?path=Music&recursive=1&query=track&session=1&limit=25",
  );
  assert.equal(
    api.buildFileSearchEndpoint({path: "Music", sessionId: "abc123", cancel: true, limit: 25}),
    "/browse/endpoints/search?path=Music&recursive=1&session_id=abc123&cancel=1&limit=25",
  );
});
