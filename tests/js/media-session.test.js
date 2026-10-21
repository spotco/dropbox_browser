const path = require("node:path");
const {pathToFileURL} = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

const MODULE_PATH = path.resolve(__dirname, "..", "..", "dropbox_browser/assets/js/media-library/media-session.js");
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const originalMediaMetadata = globalThis.MediaMetadata;

let mediaSessionModule = null;
let clockMs = 0;

async function loadModule() {
  if (!mediaSessionModule) mediaSessionModule = await import(pathToFileURL(MODULE_PATH).href);
  return mediaSessionModule;
}

class FakeMediaMetadata {
  constructor(init) {
    this.title = init.title;
    this.artist = init.artist;
    this.album = init.album;
    this.artwork = init.artwork;
  }
}

function createFakeSession(options = {}) {
  const session = {
    handlers: new Map(),
    metadataWrites: [],
    stateWrites: [],
    positionCalls: [],
    _metadata: null,
    _playbackState: "none",
    get metadata() {
      return this._metadata;
    },
    set metadata(value) {
      this._metadata = value;
      this.metadataWrites.push(value);
    },
    get playbackState() {
      return this._playbackState;
    },
    set playbackState(value) {
      this._playbackState = value;
      this.stateWrites.push(value);
    },
    setActionHandler(action, handler) {
      if (options.unsupportedActions && options.unsupportedActions.includes(action)) {
        throw new TypeError(`unsupported action ${action}`);
      }
      if (handler) this.handlers.set(action, handler);
      else this.handlers.delete(action);
    },
    setPositionState(state) {
      this.positionCalls.push(state);
      if (options.throwOnPosition) throw new TypeError("stale duration");
    },
  };
  return session;
}

function installNavigator(value) {
  Object.defineProperty(globalThis, "navigator", {value, configurable: true, writable: true});
}

async function setup(sessionOptions) {
  const mod = await loadModule();
  clockMs = 10_000;
  mod.resetMediaSessionForTests(() => clockMs);
  globalThis.MediaMetadata = FakeMediaMetadata;
  const session = sessionOptions === null ? null : createFakeSession(sessionOptions);
  installNavigator(session ? {mediaSession: session} : {});
  return {mod, session};
}

function recorder() {
  const calls = [];
  const actions = {
    play: () => calls.push(["play"]),
    pause: () => calls.push(["pause"]),
    next: () => calls.push(["next"]),
    previous: () => calls.push(["previous"]),
    seekBy: (delta) => calls.push(["seekBy", delta]),
    seekTo: (seconds) => calls.push(["seekTo", seconds]),
  };
  return {calls, actions};
}

function musicSnapshot(overrides = {}) {
  return Object.assign({
    title: "Song",
    artist: "Artist",
    album: "",
    artworkUrl: "blob:cover",
    artworkType: "image/png",
    playbackState: "playing",
    position: 12,
    duration: 200,
    playbackRate: 1,
    canSeek: true,
    seekStepSeconds: 15,
  }, overrides);
}

test.after(() => {
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
  else delete globalThis.navigator;
  globalThis.MediaMetadata = originalMediaMetadata;
});

test("missing navigator.mediaSession makes every call a no-op", async () => {
  const {mod} = await setup(null);
  const {actions} = recorder();
  assert.doesNotThrow(() => {
    mod.bindMediaSession("music", actions);
    assert.equal(mod.claimMediaSession("music"), false);
    mod.updateMediaSession("music", musicSnapshot());
    assert.equal(mod.releaseMediaSession("music"), false);
  });
  assert.equal(mod.mediaSessionOwner(), null);

  installNavigator(undefined);
  assert.doesNotThrow(() => mod.updateMediaSession("video", musicSnapshot()));
  assert.equal(mod.mediaSessionOwner(), null);
});

test("a playing snapshot claims and writes metadata, playback state and clamped position", async () => {
  const {mod, session} = await setup();
  const {actions} = recorder();
  mod.bindMediaSession("music", actions);
  mod.updateMediaSession("music", musicSnapshot({position: 250}));

  assert.equal(mod.mediaSessionOwner(), "music");
  assert.ok(session.metadata instanceof FakeMediaMetadata);
  assert.equal(session.metadata.title, "Song");
  assert.equal(session.metadata.artist, "Artist");
  assert.deepEqual(session.metadata.artwork, [{src: "blob:cover", type: "image/png"}]);
  assert.equal(session.playbackState, "playing");
  assert.deepEqual(session.positionCalls.at(-1), {duration: 200, playbackRate: 1, position: 200});
  for (const action of ["play", "pause", "previoustrack", "nexttrack", "seekbackward", "seekforward", "seekto"]) {
    assert.equal(typeof session.handlers.get(action), "function", action);
  }
});

test("a paused or position update from a non-owner is ignored", async () => {
  const {mod, session} = await setup();
  mod.bindMediaSession("music", recorder().actions);
  mod.bindMediaSession("video", recorder().actions);
  mod.updateMediaSession("music", musicSnapshot());
  const metadataWrites = session.metadataWrites.length;
  const positionCalls = session.positionCalls.length;

  mod.updateMediaSession("video", musicSnapshot({title: "Video", playbackState: "paused"}), {flush: true});
  mod.updateMediaSession("video", {position: 5, duration: 60}, {flush: true});

  assert.equal(mod.mediaSessionOwner(), "music");
  assert.equal(session.metadataWrites.length, metadataWrites);
  assert.equal(session.positionCalls.length, positionCalls);
  assert.equal(session.metadata.title, "Song");
  assert.equal(session.playbackState, "playing");
});

test("a later playing claim replaces the owner and clears the previous metadata first", async () => {
  const {mod, session} = await setup();
  const music = recorder();
  const video = recorder();
  mod.bindMediaSession("music", music.actions);
  mod.bindMediaSession("video", video.actions);
  mod.updateMediaSession("music", musicSnapshot());
  const before = session.metadataWrites.length;

  mod.updateMediaSession("video", musicSnapshot({title: "Episode 1", artist: "", artworkUrl: ""}));

  assert.equal(mod.mediaSessionOwner(), "video");
  const writes = session.metadataWrites.slice(before);
  assert.equal(writes[0], null);
  assert.equal(writes[1].title, "Episode 1");
  assert.deepEqual(writes[1].artwork, []);

  session.handlers.get("nexttrack")();
  assert.deepEqual(video.calls, [["next"]]);
  assert.deepEqual(music.calls, []);

  // Position updates from the previous owner are ignored after replacement.
  clockMs += 5000;
  const positionCalls = session.positionCalls.length;
  mod.updateMediaSession("music", {position: 99, duration: 200}, {flush: true});
  assert.equal(session.positionCalls.length, positionCalls);
  assert.equal(session.metadata.title, "Episode 1");

  // An explicit claim (user pause/seek in music) takes it back.
  mod.claimMediaSession("music");
  assert.equal(mod.mediaSessionOwner(), "music");
  assert.equal(session.metadata.title, "Song");
  assert.deepEqual(session.positionCalls.at(-1), {duration: 200, playbackRate: 1, position: 99});
});

test("missing or non-finite duration skips setPositionState and seek handlers", async () => {
  const {mod, session} = await setup();
  mod.bindMediaSession("music", recorder().actions);
  mod.updateMediaSession("music", musicSnapshot({duration: null, canSeek: false}));
  assert.equal(session.positionCalls.length, 0);
  assert.equal(session.handlers.has("seekto"), false);
  assert.equal(session.handlers.has("seekbackward"), false);
  assert.equal(session.handlers.has("nexttrack"), true);
  assert.equal(session.handlers.has("previoustrack"), true);

  mod.updateMediaSession("music", {duration: Number.NaN, position: 3}, {flush: true});
  mod.updateMediaSession("music", {duration: Infinity, position: 3}, {flush: true});
  mod.updateMediaSession("music", {duration: 10, position: Number.NaN}, {flush: true});
  assert.equal(session.positionCalls.length, 0);

  // Duration arrives: seek handlers appear and position is written.
  mod.updateMediaSession("music", {duration: 180, position: 3, canSeek: true}, {flush: true});
  assert.equal(session.positionCalls.length, 1);
  assert.equal(typeof session.handlers.get("seekto"), "function");
});

test("position below zero and above duration is clamped", async () => {
  const {mod, session} = await setup();
  mod.updateMediaSession("music", musicSnapshot({position: -4}));
  assert.equal(session.positionCalls.at(-1).position, 0);
  mod.updateMediaSession("music", {position: 1000}, {flush: true});
  assert.equal(session.positionCalls.at(-1).position, 200);
});

test("a throwing setPositionState or setActionHandler does not throw outward", async () => {
  const {mod, session} = await setup({throwOnPosition: true, unsupportedActions: ["seekto", "previoustrack"]});
  const music = recorder();
  mod.bindMediaSession("music", music.actions);
  assert.doesNotThrow(() => mod.updateMediaSession("music", musicSnapshot()));
  assert.doesNotThrow(() => mod.updateMediaSession("music", {position: 30}, {flush: true}));
  assert.equal(mod.mediaSessionOwner(), "music");
  // Unsupported actions did not block the others.
  assert.equal(typeof session.handlers.get("nexttrack"), "function");
  assert.equal(typeof session.handlers.get("seekforward"), "function");
  assert.equal(session.handlers.has("seekto"), false);
  assert.ok(session.positionCalls.length >= 1);
  assert.doesNotThrow(() => mod.releaseMediaSession("music"));
});

test("seek backward/forward use details.seekOffset, then the snapshot step", async () => {
  const {mod, session} = await setup();
  const music = recorder();
  mod.bindMediaSession("music", music.actions);
  mod.updateMediaSession("music", musicSnapshot({seekStepSeconds: 15}));

  session.handlers.get("seekbackward")({action: "seekbackward", seekOffset: 5});
  session.handlers.get("seekforward")({action: "seekforward", seekOffset: 30});
  session.handlers.get("seekbackward")({action: "seekbackward"});
  session.handlers.get("seekforward")({action: "seekforward"});
  session.handlers.get("seekforward")();

  mod.updateMediaSession("music", {seekStepSeconds: Number.NaN}, {flush: true});
  session.handlers.get("seekforward")({action: "seekforward"});

  assert.deepEqual(music.calls, [
    ["seekBy", -5],
    ["seekBy", 30],
    ["seekBy", -15],
    ["seekBy", 15],
    ["seekBy", 15],
    ["seekBy", 15],
  ]);
});

test("seekto forwards seekTime and ignores a missing time", async () => {
  const {mod, session} = await setup();
  const music = recorder();
  mod.bindMediaSession("music", music.actions);
  mod.updateMediaSession("music", musicSnapshot());

  session.handlers.get("seekto")({action: "seekto", seekTime: 42.5, fastSeek: true});
  session.handlers.get("seekto")({action: "seekto"});
  session.handlers.get("seekto")({action: "seekto", seekTime: Number.NaN});
  session.handlers.get("seekto")();
  session.handlers.get("play")();
  session.handlers.get("pause")();
  session.handlers.get("previoustrack")();

  assert.deepEqual(music.calls, [["seekTo", 42.5], ["play"], ["pause"], ["previous"]]);
});

test("release by the owner clears the session; release by the other kind does not", async () => {
  const {mod, session} = await setup();
  mod.bindMediaSession("music", recorder().actions);
  mod.bindMediaSession("video", recorder().actions);
  mod.updateMediaSession("music", musicSnapshot());

  assert.equal(mod.releaseMediaSession("video"), false);
  assert.equal(mod.mediaSessionOwner(), "music");
  assert.equal(session.metadata.title, "Song");
  assert.equal(session.playbackState, "playing");
  assert.equal(session.handlers.size, 7);

  assert.equal(mod.releaseMediaSession("music"), true);
  assert.equal(mod.mediaSessionOwner(), null);
  assert.equal(session.metadata, null);
  assert.equal(session.playbackState, "none");
  assert.equal(session.handlers.size, 0);

  // After release, a paused update from the old owner is not written.
  const writes = session.metadataWrites.length;
  mod.updateMediaSession("music", musicSnapshot({playbackState: "paused"}));
  assert.equal(session.metadataWrites.length, writes);
});

test("pausing keeps the session and flushes position immediately", async () => {
  const {mod, session} = await setup();
  mod.updateMediaSession("music", musicSnapshot({position: 10}));
  clockMs += 100;
  mod.updateMediaSession("music", {playbackState: "paused", position: 11});
  assert.equal(mod.mediaSessionOwner(), "music");
  assert.equal(session.playbackState, "paused");
  assert.equal(session.positionCalls.at(-1).position, 11);
  assert.equal(session.metadata.title, "Song");
});

test("position updates are throttled to about once per second; a seek flush bypasses it", async () => {
  const {mod, session} = await setup();
  mod.updateMediaSession("music", musicSnapshot({position: 10}));
  assert.equal(session.positionCalls.length, 1);

  clockMs += 250;
  mod.updateMediaSession("music", {position: 10.25});
  assert.equal(session.positionCalls.length, 1);

  clockMs += 250;
  mod.updateMediaSession("music", {position: 90}, {flush: true});
  assert.equal(session.positionCalls.length, 2);
  assert.equal(session.positionCalls.at(-1).position, 90);

  clockMs += 400;
  mod.updateMediaSession("music", {position: 90.4});
  assert.equal(session.positionCalls.length, 2);

  clockMs += 700;
  mod.updateMediaSession("music", {position: 91.1});
  assert.equal(session.positionCalls.length, 3);

  // Unchanged metadata is not rewritten on position ticks.
  assert.equal(session.metadataWrites.length, 1);
  // A track change (new title) flushes position even inside the window.
  clockMs += 10;
  mod.updateMediaSession("music", {title: "Next Song", position: 0, duration: 120});
  assert.equal(session.positionCalls.length, 4);
  assert.equal(session.metadata.title, "Next Song");
});
test("a known -> unknown duration clears the published position instead of keeping the old one", async () => {
  const {mod, session} = await setup();
  const {actions} = recorder();
  mod.bindMediaSession("video", actions);
  mod.updateMediaSession("video", musicSnapshot({title: "Episode A", position: 40, duration: 600}));
  assert.deepEqual(session.positionCalls.at(-1), {duration: 600, playbackRate: 1, position: 40});

  // The next item has no metadata yet: the old 600s bar must not stay up.
  clockMs += 5000;
  mod.updateMediaSession("video", {title: "Episode B", position: 0, duration: null, canSeek: false}, {flush: true});
  assert.equal(session.positionCalls.length, 2);
  assert.equal(session.positionCalls.at(-1), undefined);
  assert.equal(session.handlers.has("seekto"), false);

  // Further unknown updates do not clear again.
  clockMs += 5000;
  mod.updateMediaSession("video", {position: 1, duration: Number.NaN}, {flush: true});
  assert.equal(session.positionCalls.length, 2);

  // Once the duration is known the position is written again at once.
  mod.updateMediaSession("video", {position: 2, duration: 300, canSeek: true});
  assert.deepEqual(session.positionCalls.at(-1), {duration: 300, playbackRate: 1, position: 2});

  // A new owner without a duration clears the previous owner's position.
  mod.bindMediaSession("music", recorder().actions);
  mod.updateMediaSession("music", musicSnapshot({duration: null, canSeek: false}));
  assert.equal(mod.mediaSessionOwner(), "music");
  assert.equal(session.positionCalls.length, 4);
  assert.equal(session.positionCalls.at(-1), undefined);
});

test("clearing the position is guarded when setPositionState throws", async () => {
  const {mod, session} = await setup({throwOnPosition: true});
  mod.bindMediaSession("music", recorder().actions);
  mod.updateMediaSession("music", musicSnapshot());
  assert.doesNotThrow(() => mod.updateMediaSession("music", {duration: null}, {flush: true}));
  assert.equal(session.positionCalls.length, 2);
});
