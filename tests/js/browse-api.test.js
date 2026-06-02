const path = require("node:path");
const {pathToFileURL} = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  return import(pathToFileURL(absolutePath).href);
}

test("normalizeBrowsePath matches server path cleanup assumptions", async () => {
  const browseApi = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/api.js");

  assert.equal(browseApi.normalizeBrowsePath("music\\albums/./disc 1"), "music/albums/disc 1");
  assert.throws(() => browseApi.normalizeBrowsePath("../music"), /Parent path segments/);
});

test("buildBrowseListingEndpoint emits canonical browse query params", async () => {
  const browseApi = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/api.js");

  assert.equal(
    browseApi.buildBrowseListingEndpoint({ path: "Music/Album", sort: "date", dir: "desc", refresh: true }),
    "/browse/endpoints/listing?path=Music%2FAlbum&sort=date&dir=desc&refresh=1",
  );
  assert.equal(
    browseApi.buildBrowseListingEndpoint({ path: "", sort: "bogus", dir: "sideways", refresh: false }),
    "/browse/endpoints/listing",
  );
});

test("buildBrowsePageHref omits default sort and direction params", async () => {
  const browseApi = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/api.js");

  assert.equal(
    browseApi.buildBrowsePageHref({ path: "Music" }),
    "/?path=Music",
  );
  assert.equal(
    browseApi.buildBrowsePageHref({ path: "Music", sort: "size", dir: "desc" }),
    "/?path=Music&sort=size&dir=desc",
  );
});

test("buildFolderInfoQuery appends repeated paths and current folder", async () => {
  const folderInfo = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/folder-info.js");

  assert.equal(
    folderInfo.buildFolderInfoQuery(["Music", "Music/Album"], "Music"),
    "/folder-info?paths=Music&paths=Music%2FAlbum&current=Music",
  );
});

test("readBrowseLocation normalizes path and sort state from URL search", async () => {
  const navigation = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/navigation.js");

  assert.deepEqual(
    navigation.readBrowseLocation("?path=Music%2FAlbum&sort=date&dir=desc&refresh=1"),
    { path: "Music/Album", sort: "date", dir: "desc", refresh: true },
  );
  assert.deepEqual(
    navigation.readBrowseLocation("?path=..%2Fbad&sort=nope"),
    { path: "", sort: "name", dir: "asc", refresh: false },
  );
});
