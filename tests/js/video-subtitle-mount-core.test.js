const path = require("node:path");
const {pathToFileURL} = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  return import(pathToFileURL(absolutePath).href + `?t=${Date.now()}`);
}

test("createEmptySubtitleMountState and ensureSubtitleMountState normalize mount fields", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/video/subtitle-mount-core.js");
  const empty = mod.createEmptySubtitleMountState();
  assert.deepEqual(empty, {
    mode: "none",
    path: "",
    streamIndex: null,
    seekSeconds: 0,
    coverageStartSeconds: null,
    coverageEndSeconds: null,
    playbackSyncToken: null,
    generation: 0,
  });

  const normalized = mod.ensureSubtitleMountState({
    mode: 7,
    path: null,
    streamIndex: undefined,
    seekSeconds: "bad",
    generation: "bad",
  });
  assert.equal(normalized.mode, "none");
  assert.equal(normalized.path, "");
  assert.equal(normalized.streamIndex, null);
  assert.equal(normalized.seekSeconds, 0);
  assert.equal(normalized.coverageStartSeconds, null);
  assert.equal(normalized.coverageEndSeconds, null);
  assert.equal(normalized.playbackSyncToken, null);
  assert.equal(normalized.generation, 0);
});

test("recordWindowSubtitleMount records window coverage and increments generation", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/video/subtitle-mount-core.js");
  const mountState = mod.recordWindowSubtitleMount(mod.createEmptySubtitleMountState(), {
    path: "movie.mp4",
    streamIndex: 3,
    seekSeconds: 12,
    coverageStartSeconds: 10,
    coverageEndSeconds: 20,
    playbackSyncToken: 7,
  });
  assert.equal(mountState.mode, "window");
  assert.equal(mountState.path, "movie.mp4");
  assert.equal(mountState.streamIndex, 3);
  assert.equal(mountState.seekSeconds, 12);
  assert.equal(mountState.coverageStartSeconds, 10);
  assert.equal(mountState.coverageEndSeconds, 20);
  assert.equal(mountState.playbackSyncToken, 7);
  assert.equal(mountState.generation, 1);
});

test("recordFullSubtitleMount clears finite coverage and increments generation", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/video/subtitle-mount-core.js");
  const mountState = mod.recordWindowSubtitleMount(mod.createEmptySubtitleMountState(), {
    path: "movie.mp4",
    streamIndex: 3,
    seekSeconds: 0,
    coverageStartSeconds: 0,
    coverageEndSeconds: 12,
  });
  const upgraded = mod.recordFullSubtitleMount(mountState, {
    path: "movie.mp4",
    streamIndex: 3,
    seekSeconds: 0,
    playbackSyncToken: 7,
  });
  assert.equal(upgraded.mode, "full");
  assert.equal(upgraded.coverageStartSeconds, null);
  assert.equal(upgraded.coverageEndSeconds, null);
  assert.equal(upgraded.generation, 2);
});

test("subtitleMountCoversTarget respects none, window, and full states", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/video/subtitle-mount-core.js");
  const empty = mod.createEmptySubtitleMountState();
  assert.equal(mod.subtitleMountCoversTarget(empty, {
    path: "movie.mp4",
    streamIndex: 3,
    seekSeconds: 0,
    coverageTargetSeconds: 5,
    overlapSeconds: 0,
  }), false);

  const windowed = mod.recordWindowSubtitleMount(mod.createEmptySubtitleMountState(), {
    path: "movie.mp4",
    streamIndex: 3,
    seekSeconds: 0,
    coverageStartSeconds: 0,
    coverageEndSeconds: 12,
  });
  assert.equal(mod.subtitleMountCoversTarget(windowed, {
    path: "movie.mp4",
    streamIndex: 3,
    seekSeconds: 0,
    coverageTargetSeconds: 11,
    overlapSeconds: 0,
  }), true);
  assert.equal(mod.subtitleMountCoversTarget(windowed, {
    path: "movie.mp4",
    streamIndex: 3,
    seekSeconds: 0,
    coverageTargetSeconds: 13,
    overlapSeconds: 0,
  }), false);

  const full = mod.recordFullSubtitleMount(windowed, {
    path: "movie.mp4",
    streamIndex: 3,
    seekSeconds: 0,
  });
  assert.equal(mod.subtitleMountCoversTarget(full, {
    path: "movie.mp4",
    streamIndex: 3,
    seekSeconds: 0,
    coverageTargetSeconds: 130,
    overlapSeconds: 0,
  }), true);
});

test("shouldRefreshSubtitlesForPlaybackTime triggers once per uncovered mount identity and resets after generation change", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/video/subtitle-mount-core.js");
  const mountState = mod.recordWindowSubtitleMount(mod.createEmptySubtitleMountState(), {
    path: "movie.mp4",
    streamIndex: 3,
    seekSeconds: 0,
    coverageStartSeconds: 0,
    coverageEndSeconds: 12,
    playbackSyncToken: 7,
  });
  const syncState = mod.createEmptySubtitlePlaybackSyncState();

  assert.equal(mod.shouldRefreshSubtitlesForPlaybackTime(mountState, syncState, {
    path: "movie.mp4",
    streamIndex: 3,
    targetSeconds: 10,
    playbackSyncToken: 7,
    overlapSeconds: 0,
  }), false);
  assert.equal(mod.shouldRefreshSubtitlesForPlaybackTime(mountState, syncState, {
    path: "movie.mp4",
    streamIndex: 3,
    targetSeconds: 17,
    playbackSyncToken: 7,
    overlapSeconds: 0,
  }), true);
  assert.equal(mod.shouldRefreshSubtitlesForPlaybackTime(mountState, syncState, {
    path: "movie.mp4",
    streamIndex: 3,
    targetSeconds: 18,
    playbackSyncToken: 7,
    overlapSeconds: 0,
  }), false);

  mod.recordWindowSubtitleMount(mountState, {
    path: "movie.mp4",
    streamIndex: 3,
    seekSeconds: 12,
    coverageStartSeconds: 12,
    coverageEndSeconds: 24,
    playbackSyncToken: 7,
  });
  assert.equal(mod.shouldRefreshSubtitlesForPlaybackTime(mountState, syncState, {
    path: "movie.mp4",
    streamIndex: 3,
    targetSeconds: 27,
    playbackSyncToken: 7,
    overlapSeconds: 0,
  }), true);
});

test("shouldRefreshSubtitlesForPlaybackTime resets stale sync identity when playback token changes", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/video/subtitle-mount-core.js");
  const mountState = mod.recordFullSubtitleMount(mod.createEmptySubtitleMountState(), {
    path: "movie.mp4",
    streamIndex: 3,
    seekSeconds: 0,
    playbackSyncToken: 7,
  });
  const syncState = mod.createEmptySubtitlePlaybackSyncState();

  assert.equal(mod.shouldRefreshSubtitlesForPlaybackTime(mountState, syncState, {
    path: "movie.mp4",
    streamIndex: 3,
    targetSeconds: 17,
    playbackSyncToken: 7,
    overlapSeconds: 0,
  }), false);
  syncState.outsideCoverageObserved = true;
  assert.equal(mod.shouldRefreshSubtitlesForPlaybackTime(mountState, syncState, {
    path: "movie.mp4",
    streamIndex: 3,
    targetSeconds: 18,
    playbackSyncToken: 8,
    overlapSeconds: 0,
  }), false);
  assert.equal(syncState.outsideCoverageObserved, false);
  assert.equal(syncState.playbackSyncToken, 8);
});

test("resetSubtitleMountState and resetSubtitlePlaybackSyncState clear state but preserve generation increment", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/video/subtitle-mount-core.js");
  const mountState = mod.recordWindowSubtitleMount(mod.createEmptySubtitleMountState(), {
    path: "movie.mp4",
    streamIndex: 3,
    seekSeconds: 12,
    coverageStartSeconds: 10,
    coverageEndSeconds: 20,
    playbackSyncToken: 7,
  });
  const syncState = mod.ensureSubtitlePlaybackSyncState({
    path: "movie.mp4",
    streamIndex: 3,
    mountedSeekSeconds: 12,
    playbackSyncToken: 7,
    mountGeneration: mountState.generation,
    outsideCoverageObserved: true,
  });

  mod.resetSubtitleMountState(mountState);
  mod.resetSubtitlePlaybackSyncState(syncState);

  assert.equal(mountState.mode, "none");
  assert.equal(mountState.path, "");
  assert.equal(mountState.streamIndex, null);
  assert.equal(mountState.seekSeconds, 0);
  assert.equal(mountState.coverageStartSeconds, null);
  assert.equal(mountState.coverageEndSeconds, null);
  assert.equal(mountState.generation, 2);
  assert.deepEqual(syncState, {
    path: "",
    streamIndex: null,
    mountedSeekSeconds: 0,
    playbackSyncToken: null,
    mountGeneration: 0,
    outsideCoverageObserved: false,
  });
});
