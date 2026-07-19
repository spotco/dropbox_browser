const path = require("node:path");
const {pathToFileURL} = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importBridgeModule() {
  const absolutePath = path.resolve(__dirname, "..", "..", "dropbox_browser/assets/js/video/media-library-bridge.js");
  return import(pathToFileURL(absolutePath).href + `?t=${Date.now()}`);
}

test("video playlist starts publish the shared asset and playlist message", async () => {
  const {initMediaLibraryBridge} = await importBridgeModule();
  const messages = [];
  const song = {
    filename: "Episode01.mkv",
    display_name: "Episode01.mkv",
    remote_path: "videos/Episode01.mkv",
    stream_path: "videos/Episode01.mkv",
  };
  const ctx = {
    state: {
      activePlaylist: {name: "Weekend Watch"},
      activeQueueIndex: -1,
      currentPlaylistIndex: -1,
      loopPlaylist: false,
      loopQueue: false,
      playlist: [song],
      selectedQueueIndex: -1,
      shuffleEnabled: false,
      shuffleSequence: [],
      shuffleCursor: -1,
    },
    els: {shuffleButton: null},
    playbackApi: {
      syncForActiveItem() {},
    },
    playlistApi: {
      renderPlaylist() {},
      resetShuffleBag() {},
      playlistIndexByRemotePath(remotePath) {
        return remotePath === song.remote_path ? 0 : -1;
      },
    },
    recentApi: {
      recordPlaybackStart() {},
    },
    setStatus(message) {
      messages.push(message);
    },
  };

  initMediaLibraryBridge(ctx);
  ctx.playbackApi.playPlaylistIndex(0);

  assert.deepEqual(messages, ['Playing "Episode01.mkv" from playlist "Weekend Watch".']);
});
