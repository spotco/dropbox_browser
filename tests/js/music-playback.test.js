const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importPlaybackModuleFromWorkspace() {
  const absolutePath = path.resolve(__dirname, "..", "..", "dropbox_browser/assets/js/music/playback.js");
  let source = await fs.readFile(absolutePath, "utf8");
  const sharedSource = "export function formatPlaybackTime(value) { return String(value); }";
  const metadataSource = [
    "export function createMetadataController() {",
    "  return {",
    "    clearMetadataRequest() {},",
    "    revokeCurrentArtObjectUrl() {},",
    "    resetNowPlayingForSong() {},",
    "    maybeStartCurrentSongMetadataLoad() {},",
    "    scheduleNowPlayingMarqueeRefresh() {},",
    "    resumeDeferredArtworkLoad() {},",
    "    showUnknownMetadata() {}",
    "  };",
    "}",
  ].join("\n");
  const shufflePath = path.resolve(__dirname, "..", "..", "dropbox_browser/assets/js/music/shuffle-helpers.js");
  const shuffleSource = await fs.readFile(shufflePath, "utf8");
  const sharedUrl = `data:text/javascript;base64,${Buffer.from(sharedSource, "utf8").toString("base64")}`;
  const metadataUrl = `data:text/javascript;base64,${Buffer.from(metadataSource, "utf8").toString("base64")}`;
  const shuffleUrl = `data:text/javascript;base64,${Buffer.from(shuffleSource, "utf8").toString("base64")}`;
  source = source.replace("'../media-library/shared.js'", `'${sharedUrl}'`);
  source = source.replace("'./metadata.js'", `'${metadataUrl}'`);
  source = source.replace("'./shuffle-helpers.js'", `'${shuffleUrl}'`);
  return import(`data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`);
}

function song(remotePath) {
  return {
    display_name: remotePath.split("/").pop(),
    filename: remotePath.split("/").pop(),
    rel_path: remotePath,
    remote_path: remotePath,
    stream_path: remotePath,
  };
}

function createFakeAudio() {
  const listeners = new Map();
  return {
    currentTime: 0,
    duration: 0,
    ended: false,
    loadCalls: 0,
    pauseCalls: 0,
    paused: true,
    playCalls: 0,
    src: "",
    volume: 1,
    addEventListener(name, handler) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(handler);
    },
    dispatch(name) {
      const handlers = listeners.get(name) || [];
      handlers.forEach((handler) => handler());
    },
    load() {
      this.loadCalls += 1;
    },
    pause() {
      this.pauseCalls += 1;
      this.paused = true;
    },
    play() {
      this.playCalls += 1;
      this.paused = false;
      return Promise.resolve();
    },
    removeAttribute(name) {
      if (name === "src") this.src = "";
    },
  };
}

function createPlaybackContext(audio, songs, toastMessages, statusMessages) {
  const state = {
    currentPlaylistIndex: -1,
    currentArtObjectUrl: null,
    defaultLoopPlaylist: false,
    defaultShuffleEnabled: false,
    defaultVolume: 1,
    loopPlaylist: false,
    metadataLoadedRemotePath: null,
    playbackCurrentTimeDirty: false,
    playbackDurationDirty: false,
    playbackLoadRetryCount: 0,
    playbackLoadRetryDelayMs: 0,
    playbackLoadRetryLimit: 3,
    playbackRetryRemotePath: null,
    playbackRetryTimer: null,
    playbackUiLastPaintMs: 0,
    playbackUiPaintTimer: null,
    playlist: songs.slice(),
    scrubberDragging: false,
    shuffleBag: [],
    shuffleCursor: -1,
    shuffleEnabled: false,
    shuffleSequence: [],
  };
  return {
    pane: {dataset: {}},
    els: {
      audio,
      currentFilenameEl: null,
      elapsedTimeEl: null,
      loopButton: null,
      pauseButton: null,
      playButton: null,
      prevButton: null,
      progressSlider: null,
      shuffleButton: null,
      songArtistEl: null,
      songTitleEl: null,
      totalTimeEl: null,
      volumeSlider: null,
      nextButton: null,
    },
    layoutApi: {
      clearPlaybackUiPaintTimer() {},
      playbackUiMayPaint() {
        return true;
      },
      schedulePlaybackDisplayPaint() {},
    },
    playlistApi: {
      playlistIndexByRemotePath(remotePath) {
        return state.playlist.findIndex((entry) => entry.remote_path === remotePath);
      },
      renderPlaylist() {},
      resetShuffleBag() {},
      showPlaylistErrorToast(message) {
        toastMessages.push(message);
      },
      shuffleBagIndex() {
        return -1;
      },
    },
    setStatus(message) {
      statusMessages.push(message);
    },
    state,
  };
}

function createTimerHarness() {
  const callbacks = [];
  return {
    clearTimeout(id) {
      callbacks[id - 1] = null;
    },
    flushNext() {
      const index = callbacks.findIndex((callback) => typeof callback === "function");
      if (index === -1) return false;
      const callback = callbacks[index];
      callbacks[index] = null;
      callback();
      return true;
    },
    setTimeout(callback) {
      callbacks.push(callback);
      return callbacks.length;
    },
  };
}

test("initPlayback retries audio load failures and then skips to the next playlist song", async () => {
  const playbackModule = await importPlaybackModuleFromWorkspace();
  const audio = createFakeAudio();
  const toastMessages = [];
  const statusMessages = [];
  const ctx = createPlaybackContext(
    audio,
    [song("music/alpha.mp3"), song("music/bravo.mp3")],
    toastMessages,
    statusMessages,
  );
  const timers = createTimerHarness();
  const originalSettings = global.Settings;
  const originalWindow = global.window;

  global.Settings = {
    get(_key, fallback) {
      return fallback;
    },
    set() {},
  };
  global.window = timers;

  try {
    playbackModule.initPlayback(ctx);
    ctx.playbackApi.playPlaylistIndex(0);

    assert.equal(audio.src, "/file?path=music%2Falpha.mp3&source=remote");
    assert.equal(audio.playCalls, 1);

    audio.dispatch("error");
    assert.match(statusMessages.at(-1), /Retrying "music\/alpha\.mp3" \(1\/3\)\.\.\./);
    assert.equal(timers.flushNext(), true);
    assert.equal(audio.playCalls, 2);

    audio.dispatch("error");
    assert.match(statusMessages.at(-1), /Retrying "music\/alpha\.mp3" \(2\/3\)\.\.\./);
    assert.equal(timers.flushNext(), true);
    assert.equal(audio.playCalls, 3);

    audio.dispatch("error");
    assert.match(statusMessages.at(-1), /Retrying "music\/alpha\.mp3" \(3\/3\)\.\.\./);
    assert.equal(timers.flushNext(), true);
    assert.equal(audio.playCalls, 4);

    audio.dispatch("error");
    assert.deepEqual(toastMessages, [
      'Could not load "music/alpha.mp3" after 3 retries. Skipping to next song.',
    ]);
    assert.equal(ctx.state.currentPlaylistIndex, 1);
    assert.equal(audio.src, "/file?path=music%2Fbravo.mp3&source=remote");
    assert.equal(audio.playCalls, 5);
  }
  finally {
    global.Settings = originalSettings;
    global.window = originalWindow;
  }
});

test("initPlayback resets the retry counter after the current song finally loads", async () => {
  const playbackModule = await importPlaybackModuleFromWorkspace();
  const audio = createFakeAudio();
  const toastMessages = [];
  const statusMessages = [];
  const ctx = createPlaybackContext(
    audio,
    [song("music/alpha.mp3"), song("music/bravo.mp3")],
    toastMessages,
    statusMessages,
  );
  const timers = createTimerHarness();
  const originalSettings = global.Settings;
  const originalWindow = global.window;

  global.Settings = {
    get(_key, fallback) {
      return fallback;
    },
    set() {},
  };
  global.window = timers;

  try {
    playbackModule.initPlayback(ctx);
    ctx.playbackApi.playPlaylistIndex(0);

    audio.dispatch("error");
    assert.equal(ctx.state.playbackLoadRetryCount, 1);
    assert.equal(timers.flushNext(), true);

    audio.dispatch("loadedmetadata");
    assert.equal(ctx.state.playbackLoadRetryCount, 0);

    audio.dispatch("error");
    assert.match(statusMessages.at(-1), /Retrying "music\/alpha\.mp3" \(1\/3\)\.\.\./);
  }
  finally {
    global.Settings = originalSettings;
    global.window = originalWindow;
  }
});

test("initPlayback keeps a stable shuffle order when moving next and previous", async () => {
  const playbackModule = await importPlaybackModuleFromWorkspace();
  const audio = createFakeAudio();
  const toastMessages = [];
  const statusMessages = [];
  const ctx = createPlaybackContext(
    audio,
    [
      song("music/alpha.mp3"),
      song("music/bravo.mp3"),
      song("music/charlie.mp3"),
      song("music/delta.mp3"),
    ],
    toastMessages,
    statusMessages,
  );
  const originalMathRandom = Math.random;
  const originalSettings = global.Settings;
  const originalWindow = global.window;

  ctx.state.shuffleEnabled = true;
  Math.random = () => 0;
  global.Settings = {
    get(_key, fallback) {
      return fallback;
    },
    set() {},
  };
  global.window = {
    clearTimeout() {},
    setTimeout() {
      return 1;
    },
  };

  try {
    playbackModule.initPlayback(ctx);
    ctx.playbackApi.playPlaylistIndex(0);
    ctx.playbackApi.playNextSong();
    const firstNextIndex = ctx.state.currentPlaylistIndex;
    assert.notEqual(firstNextIndex, 0);

    ctx.playbackApi.playNextSong();
    const secondNextIndex = ctx.state.currentPlaylistIndex;
    assert.notEqual(secondNextIndex, firstNextIndex);

    ctx.playbackApi.playPreviousSong();
    assert.equal(ctx.state.currentPlaylistIndex, firstNextIndex);

    ctx.playbackApi.playPreviousSong();
    assert.equal(ctx.state.currentPlaylistIndex, 0);

    ctx.playbackApi.playNextSong();
    assert.equal(ctx.state.currentPlaylistIndex, firstNextIndex);

    ctx.playbackApi.playNextSong();
    assert.equal(ctx.state.currentPlaylistIndex, secondNextIndex);
  }
  finally {
    Math.random = originalMathRandom;
    global.Settings = originalSettings;
    global.window = originalWindow;
  }
});
