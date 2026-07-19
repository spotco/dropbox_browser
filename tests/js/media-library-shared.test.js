const path = require("node:path");
const {pathToFileURL} = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importSharedModule() {
  const absolutePath = path.resolve(__dirname, "..", "..", "dropbox_browser/assets/js/media-library/shared.js");
  return import(pathToFileURL(absolutePath).href + `?t=${Date.now()}`);
}

test("setPlaylistPlaybackStatus formats the shared asset and playlist message", async () => {
  const {setPlaylistPlaybackStatus} = await importSharedModule();
  const messages = [];
  const ctx = {
    state: {activePlaylist: {name: "Road Trip"}},
    setStatus(message) {
      messages.push(message);
    },
  };

  setPlaylistPlaybackStatus(ctx, {filename: "TrackA.wav"});

  assert.deepEqual(messages, ['Playing "TrackA.wav" from playlist "Road Trip".']);
});
