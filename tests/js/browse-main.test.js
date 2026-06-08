const path = require("node:path");
const {pathToFileURL} = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  return import(pathToFileURL(absolutePath).href + `?t=${Date.now()}`);
}

test("browse main module loads without throwing when startup is inactive", async () => {
  global.window = {
    location: {
      href: "http://127.0.0.1:8010/",
      origin: "http://127.0.0.1:8010",
      search: "",
    },
  };
  global.document = {
    body: {
      dataset: {
        clientRender: "0",
      },
    },
    getElementById() {
      return null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    addEventListener() {},
  };

  await assert.doesNotReject(async () => {
    await importModuleFromWorkspace("dropbox_browser/assets/js/browse/main.js");
  });
});

test("browse state carries reveal through state creation", async () => {
  const stateModule = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/state.js");
  const state = stateModule.createBrowseState({
    path: "music/album",
    reveal: "music/album/track.mp3",
    sort: "name",
    dir: "asc",
  });

  assert.equal(state.path, "music/album");
  assert.equal(state.reveal, "music/album/track.mp3");
});
