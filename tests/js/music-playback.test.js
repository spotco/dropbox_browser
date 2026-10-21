const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importPlaybackModuleFromWorkspace() {
  const absolutePath = path.resolve(__dirname, "..", "..", "dropbox_browser/assets/js/music/playback.js");
  let source = await fs.readFile(absolutePath, "utf8");
  const sharedSource = [
    "export function formatPlaybackTime(value) { return String(value); }",
    "export function setPlaylistPlaybackStatus(ctx, item) {",
    "  const playlistName = ctx.state.activePlaylist && ctx.state.activePlaylist.name || 'New Playlist';",
    "  ctx.setStatus('Playing \\\"' + (item.filename || item.display_name) + '\\\" from playlist \\\"' + playlistName + '\\\".');",
    "}",
  ].join("\n");
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
  // Recording stand-in for the shared media-session owner.
  const mediaSessionSource = [
    "const log = globalThis.__musicMediaSessionLog || (globalThis.__musicMediaSessionLog = {calls: [], actions: null});",

    "export function bindMediaSession(kind, actions) { log.actions = actions; log.calls.push(['bind', kind]); }",
    "export function claimMediaSession(kind) { log.calls.push(['claim', kind]); return true; }",
    "export function updateMediaSession(kind, snapshot, options) { log.calls.push(['update', kind, Object.assign({}, snapshot), Object.assign({}, options || {})]); }",
    "export function releaseMediaSession(kind) { log.calls.push(['release', kind]); return true; }",
  ].join("\n");
  const mediaSessionUrl = `data:text/javascript;base64,${Buffer.from(mediaSessionSource, "utf8").toString("base64")}`;
  source = source.replace("'../media-library/media-session.js'", `'${mediaSessionUrl}'`);
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
    activePlaylist: {name: "Test Playlist"},
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
    assert.equal(statusMessages.at(-1), 'Playing "alpha.mp3" from playlist "Test Playlist".');

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

function mediaSessionLog() {
  if (!globalThis.__musicMediaSessionLog) globalThis.__musicMediaSessionLog = {calls: [], actions: null};
  return globalThis.__musicMediaSessionLog;
}

test("initPlayback publishes media-session claim, pause, seek and release from playback events", async () => {
  const playbackModule = await importPlaybackModuleFromWorkspace();
  const audio = createFakeAudio();
  const ctx = createPlaybackContext(audio, [song("music/alpha.mp3"), song("music/bravo.mp3")], [], []);
  const originalSettings = global.Settings;
  const originalWindow = global.window;
  const windowListeners = new Map();
  const log = mediaSessionLog();
  log.calls.length = 0;
  log.actions = null;

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
    addEventListener(name, handler) {
      windowListeners.set(name, handler);
    },
  };

  const updates = () => log.calls.filter((call) => call[0] === "update").map((call) => ({...call[2], flush: call[3].flush}));
  const lastUpdate = () => updates().at(-1);
  const claims = () => log.calls.filter((call) => call[0] === "claim").length;

  try {
    playbackModule.initPlayback(ctx);
    assert.deepEqual(log.calls[0], ["bind", "music"]);
    assert.deepEqual(
      Object.keys(log.actions).sort(),
      ["next", "pause", "play", "previous", "seekTo"],
    );
    assert.equal(typeof windowListeners.get("pagehide"), "function");
    assert.equal(typeof windowListeners.get("beforeunload"), "function");

    // Track start claims with the playlist display name, before metadata.
    ctx.playbackApi.playPlaylistIndex(0);
    assert.equal(lastUpdate().playbackState, "playing");
    assert.equal(lastUpdate().title, "alpha.mp3");
    assert.equal(lastUpdate().artist, "");
    assert.equal(lastUpdate().canSeek, false);
    assert.equal("seekStepSeconds" in lastUpdate(), false);
    assert.equal(lastUpdate().playbackRate, 1);
    assert.equal(lastUpdate().flush, true);

    // Duration arrives: position-only update (no playbackState => owner-only).
    audio.duration = 200;
    audio.dispatch("durationchange");
    assert.equal("playbackState" in lastUpdate(), false);
    assert.equal(lastUpdate().duration, 200);
    assert.equal(lastUpdate().canSeek, true);

    audio.currentTime = 10;
    audio.dispatch("timeupdate");
    assert.equal(lastUpdate().position, 10);
    assert.equal(lastUpdate().flush, false);

    // Scrubbing suppresses position writes until 'seeked' flushes.
    const beforeSeek = updates().length;
    audio.dispatch("seeking");
    audio.currentTime = 50;
    audio.dispatch("timeupdate");
    assert.equal(updates().length, beforeSeek);
    audio.dispatch("seeked");
    assert.equal(lastUpdate().position, 50);
    assert.equal(lastUpdate().flush, true);

    // OS scrubs seek the audio element (clamped) and claim. There is no
    // interval-seek action (iOS would hide previous/next track).
    const claimsBefore = claims();
    log.actions.seekTo(500);
    assert.equal(audio.currentTime, 200);
    log.actions.seekTo(-1000);
    assert.equal(audio.currentTime, 0);
    log.actions.seekTo(42);
    assert.equal(audio.currentTime, 42);
    log.actions.seekTo(Number.NaN);
    assert.equal(audio.currentTime, 42);
    assert.equal(claims(), claimsBefore + 3);

    // Embedded metadata and cover art replace the display name.
    ctx.state.mediaSessionTitle = "Real Title";
    ctx.state.mediaSessionArtist = "Real Artist";
    ctx.state.currentArtObjectUrl = "blob:cover";
    ctx.state.currentArtMime = "image/jpeg";
    ctx.playbackApi.refreshMediaSessionMetadata();
    assert.equal(lastUpdate().title, "Real Title");
    assert.equal(lastUpdate().artist, "Real Artist");
    assert.equal(lastUpdate().artworkUrl, "blob:cover");
    assert.equal(lastUpdate().artworkType, "image/jpeg");
    assert.equal("playbackState" in lastUpdate(), false);

    // Pause from the OS calls the pane pause; the element event publishes "paused".
    log.actions.pause();
    assert.equal(audio.pauseCalls, 1);
    assert.deepEqual(log.calls.at(-1), ["claim", "music"]);
    audio.dispatch("pause");
    assert.equal(lastUpdate().playbackState, "paused");
    assert.equal(lastUpdate().flush, true);

    // Next from the OS follows the playlist.
    log.actions.next();
    assert.equal(ctx.state.currentPlaylistIndex, 1);
    assert.equal(lastUpdate().playbackState, "playing");
    log.actions.previous();
    assert.equal(ctx.state.currentPlaylistIndex, 0);

    // Clearing the song releases; leaving the page releases.
    ctx.playbackApi.clearCurrentSong();
    assert.deepEqual(log.calls.at(-1), ["release", "music"]);
    const updatesAfterRelease = updates().length;
    audio.dispatch("pause");
    assert.equal(updates().length, updatesAfterRelease);
    windowListeners.get("pagehide")();
    assert.deepEqual(log.calls.at(-1), ["release", "music"]);

    // Advancing past the last song (no loop) releases too.
    ctx.playbackApi.playPlaylistIndex(1);
    ctx.playbackApi.playNextSong();
    assert.equal(ctx.state.currentPlaylistIndex, -1);
    assert.deepEqual(log.calls.at(-1), ["release", "music"]);
  }
  finally {
    global.Settings = originalSettings;
    global.window = originalWindow;
  }
});
test("a rejected play() (autoplay block) publishes paused unless a newer request or song took over", async () => {
  const playbackModule = await importPlaybackModuleFromWorkspace();
  const audio = createFakeAudio();
  const ctx = createPlaybackContext(audio, [song("music/alpha.mp3"), song("music/bravo.mp3")], [], []);
  const originalSettings = global.Settings;
  const originalWindow = global.window;
  const log = mediaSessionLog();
  log.calls.length = 0;
  log.actions = null;
  const plays = [];
  audio.play = function () {
    this.playCalls += 1;
    let resolvePlay;
    let rejectPlay;
    const promise = new Promise((resolve, reject) => {
      resolvePlay = resolve;
      rejectPlay = reject;
    });
    plays.push({
      resolve: () => {
        this.paused = false;
        resolvePlay();
      },
      reject: () => rejectPlay(new Error("NotAllowedError: play() blocked")),
    });
    return promise;
  };
  const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));
  const updates = () => log.calls.filter((call) => call[0] === "update").map((call) => ({...call[2], flush: call[3].flush}));
  const lastUpdate = () => updates().at(-1);

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
    addEventListener() {},
  };

  try {
    playbackModule.initPlayback(ctx);
    ctx.playbackApi.playPlaylistIndex(0);
    assert.equal(lastUpdate().playbackState, "playing");
    plays[0].reject();
    await flushMicrotasks();
    assert.equal(lastUpdate().playbackState, "paused");
    assert.equal(lastUpdate().title, "alpha.mp3");
    assert.equal(lastUpdate().flush, true);

    // A stale rejection (a newer song request is pending) does not clobber it.
    ctx.playbackApi.playPlaylistIndex(1);
    ctx.playbackApi.playPlaylistIndex(0);
    const before = updates().length;
    plays[1].reject();
    await flushMicrotasks();
    assert.equal(updates().length, before);
    assert.equal(lastUpdate().playbackState, "playing");

    // The newer request resolves and keeps "playing".
    plays[2].resolve();
    await flushMicrotasks();
    audio.dispatch("playing");
    assert.equal(lastUpdate().playbackState, "playing");

    // A rejection for a song that is no longer current is ignored too.
    audio.paused = true;
    ctx.playbackApi.playCurrentOrFirst();
    ctx.state.currentPlaylistIndex = 1;
    const beforeSongChange = updates().length;
    plays[3].reject();
    await flushMicrotasks();
    assert.equal(updates().length, beforeSongChange);
  }
  finally {
    global.Settings = originalSettings;
    global.window = originalWindow;
  }
});
