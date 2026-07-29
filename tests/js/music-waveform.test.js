const path = require("node:path");
const {pathToFileURL} = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  return import(pathToFileURL(absolutePath).href);
}

function createEventTarget(initial = {}) {
  const listeners = new Map();
  return {
    ...initial,
    addEventListener(name, handler) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(handler);
    },
    removeEventListener(name, handler) {
      listeners.set(name, (listeners.get(name) || []).filter((item) => item !== handler));
    },
    dispatch(name, event = {}) {
      for (const handler of listeners.get(name) || []) handler({type: name, ...event});
    },
  };
}

test("waveform cache keys include path, size, and modification identity", async () => {
  const cacheKey = await importModuleFromWorkspace("dropbox_browser/assets/js/music/waveform/cache-key.js");
  const first = {remote_path: "Music/track.wav", size: 100, mtime: "2024-01-01T00:00:00Z"};
  const changed = {...first, size: 101};

  assert.equal(cacheKey.waveformIdentityForSong(first).path, "Music/track.wav");
  assert.notEqual(cacheKey.waveformCacheKey(first), cacheKey.waveformCacheKey(changed));
  assert.equal(cacheKey.sameWaveformIdentity(
    cacheKey.waveformIdentityForSong(first),
    cacheKey.waveformIdentityForSong(first),
  ), true);
  assert.equal(cacheKey.waveformCacheKey({remote_path: ""}), null);
});

test("waveform summaries pack compactly and cache validation rejects malformed records", async () => {
  const summaries = await importModuleFromWorkspace("dropbox_browser/assets/js/music/waveform/peaks.js");
  const cache = await importModuleFromWorkspace("dropbox_browser/assets/js/music/waveform/cache.js");
  const packed = summaries.packWaveformSummaries({
    min: new Float32Array([-1, -0.5, 0]),
    max: new Float32Array([0.5, 0.75, 1]),
    rms: new Float32Array([0.25, 0.5, 0.8]),
  });
  const record = {
    version: cache.WAVEFORM_CACHE_SCHEMA_VERSION,
    key: "music-waveform-v1:[\"Music/track.wav\",\"100\",\"mtime\"]",
    lastUsed: 10,
    duration: 3,
    resolution: 3,
    summary: packed,
  };

  const unpacked = summaries.unpackWaveformSummaries(packed);
  assert.equal(unpacked.rms.length, 3);
  assert.ok(Math.abs(unpacked.min[0] + 1) < 0.01);
  assert.ok(Math.abs(unpacked.max[2] - 1) < 0.01);
  assert.ok(Math.abs(unpacked.rms[1] - 0.5) < 0.01);
  assert.ok(cache.validateWaveformCacheRecord(record, record.key));
  assert.equal(cache.findWaveformCacheRecord([record], record.key), record);
  assert.equal(cache.validateWaveformCacheRecord({...record, resolution: 4}, record.key), null);
  assert.equal(cache.validateWaveformCacheRecord({...record, summary: packed + "A"}, record.key), null);
  assert.equal(cache.validateWaveformCacheRecord({...record, key: "other"}, record.key), null);
  assert.deepEqual(
    cache.evictWaveformCacheEntries([
      {...record, key: "old", lastUsed: 1},
      {...record, key: "new", lastUsed: 3},
      {...record, key: "middle", lastUsed: 2},
    ], 2).map((entry) => entry.key),
    ["new", "middle"],
  );
  assert.deepEqual(
    cache.waveformCacheEntriesFromSettingsValue({version: cache.WAVEFORM_CACHE_SCHEMA_VERSION, entries: [record]}),
    [record],
  );
  assert.deepEqual(cache.waveformCacheEntriesFromSettingsValue({version: 99, entries: [record]}), []);
  assert.deepEqual(
    cache.mergeWaveformCacheRecord([record], {...record, lastUsed: 20}, 1).map((entry) => entry.lastUsed),
    [20],
  );
});

test("waveform resolution and pointer helpers stay ordered and clamp safely", async () => {
  const resolution = await importModuleFromWorkspace("dropbox_browser/assets/js/music/waveform/resolution.js");
  const scrub = await importModuleFromWorkspace("dropbox_browser/assets/js/music/waveform/scrub.js");

  const chosen = resolution.chooseWaveformResolution(300, 1);
  const stages = resolution.waveformResolutionStages(chosen);
  assert.ok(Number.isInteger(chosen) && chosen > 0);
  assert.ok(stages.length > 1);
  assert.ok(stages.every((value, index) => Number.isInteger(value) && value > 0 &&
    (index === 0 || value > stages[index - 1])));
  assert.ok(stages.at(-1) <= chosen);
  assert.equal(scrub.pointerPositionToPlaybackTime(-10, {left: 0, width: 100}, 20), 0);
  assert.equal(scrub.pointerPositionToPlaybackTime(150, {left: 0, width: 100}, 20), 20);
  assert.equal(scrub.pointerPositionToPlaybackTime(50, {left: 0, width: 100}, 20), 10);
  assert.equal(scrub.pointerPositionToPlaybackTime(50, {left: 0, width: 0}, 20), null);
});

test("worker summaries represent sections with min, max, and RMS", async () => {
  const worker = await importModuleFromWorkspace("dropbox_browser/assets/js/music/waveform/worker.js");
  const silence = worker.computeCombinedWaveformSummary([new Float32Array(8)], 2);
  assert.deepEqual(Array.from(silence.min), [0, 0]);
  assert.deepEqual(Array.from(silence.max), [0, 0]);
  assert.deepEqual(Array.from(silence.rms), [0, 0]);

  const steady = worker.computeCombinedWaveformSummary([new Float32Array(8).fill(0.5)], 2);
  assert.ok(steady.min.every((value) => Math.abs(value - 0.5) < 0.00001));
  assert.ok(steady.max.every((value) => Math.abs(value - 0.5) < 0.00001));
  assert.ok(steady.rms.every((value) => Math.abs(value - 0.5) < 0.00001));

  const ramp = worker.computeCombinedWaveformSummary([
    new Float32Array([-1, -0.5, 0, 0.5, 1]),
  ], 2);
  assert.equal(ramp.min[0], -1);
  assert.equal(ramp.max[0], 0);
  assert.ok(Math.abs(ramp.rms[0] - Math.sqrt(1.25 / 3)) < 0.00001);
  assert.equal(ramp.min[1], 0.5);
  assert.equal(ramp.max[1], 1);
  const mergedRamp = worker.mergeWaveformSummary(ramp, 1);
  assert.equal(mergedRamp.min[0], -1);
  assert.equal(mergedRamp.max[0], 1);
  assert.ok(Math.abs(mergedRamp.rms[0] - Math.sqrt(2.5 / 5)) < 0.00001);

  const tone = worker.computeCombinedWaveformSummary([
    new Float32Array([0, 1, 0, -1, 0, 1, 0, -1]),
  ], 2);
  assert.equal(tone.min[0], -1);
  assert.equal(tone.max[0], 1);
  assert.ok(Math.abs(tone.rms[0] - Math.sqrt(0.5)) < 0.00001);

  const impulse = worker.computeCombinedWaveformSummary([
    new Float32Array([0, 0, 1, 0, 0, 0, 0, 0]),
  ], 2);
  assert.equal(impulse.max[0], 1);
  assert.ok(impulse.rms[0] < impulse.max[0]);

  assert.equal(worker.WAVEFORM_WORKER_SLICE_BUDGET_MS, 3);
  assert.equal(worker.WAVEFORM_WORKER_YIELD_DELAY_MS, 8);
  assert.equal(worker.WAVEFORM_WORKER_SAMPLE_CHECK_INTERVAL, 512);
});

test("fast preview samples are stratified within each bucket", async () => {
  const worker = await importModuleFromWorkspace("dropbox_browser/assets/js/music/waveform/worker.js");
  const indices = worker.sampleIndicesForBucket(4096, 64, 10, 8);
  assert.equal(indices.length, 8);
  assert.ok(indices.every((value) => value >= 640 && value < 704));
  assert.ok(indices.every((value, index) => index === 0 || value >= indices[index - 1]));
});

test("worker protocol emits packed stages and completion through a narrow message surface", async () => {
  const worker = await importModuleFromWorkspace("dropbox_browser/assets/js/music/waveform/worker.js");
  const messages = [];
  const scheduled = [];
  let messageHandler = null;
  const scope = {
    addEventListener(_name, handler) {
      messageHandler = handler;
    },
    postMessage(message) {
      messages.push(message);
    },
    setTimeout(callback) {
      scheduled.push(callback);
    },
  };

  worker.installWaveformWorker(scope);
  messageHandler({
    data: {
      type: "start",
      generation: 7,
      channels: [new Float32Array([0.25, 0.75])],
      targetResolution: 1024,
      maxResolution: 1024,
    },
  });
  while (scheduled.length) scheduled.shift()();

  assert.equal(messages.at(-1).type, "complete");
  assert.equal(messages.at(-1).generation, 7);
  const summaryMessages = messages.filter((message) => message.type === "summary");
  assert.ok(summaryMessages.length > 1);
  assert.ok(summaryMessages.every((message) => Number.isInteger(message.resolution) &&
    message.resolution > 0 && typeof message.summary === "string" &&
    Number.isInteger(message.sampleRound) && Number.isInteger(message.sampleRounds) &&
    message.sampleRound >= 1 && message.sampleRound <= message.sampleRounds &&
    message.completedSamples === message.totalSamples));
  assert.equal(summaryMessages[0].preview, true);
  assert.equal(summaryMessages.find((message) => message.preview === false).sampleRound, 1);
  assert.equal(summaryMessages.at(-1).sampleRound, summaryMessages.at(-1).sampleRounds);
  assert.equal(messages.at(-1).type, "complete");
  assert.equal(worker.installWaveformWorker.length, 1);
});

test("incremental worker reduction matches the direct summary for uneven channels", async () => {
  const worker = await importModuleFromWorkspace("dropbox_browser/assets/js/music/waveform/worker.js");
  const summaries = await importModuleFromWorkspace("dropbox_browser/assets/js/music/waveform/peaks.js");
  const sampleCount = 123457;
  const first = new Float32Array(sampleCount);
  const second = new Float32Array(sampleCount - 17);
  for (let index = 0; index < first.length; index += 1) first[index] = Math.sin(index * 0.017) * 0.9;
  for (let index = 0; index < second.length; index += 1) second[index] = Math.cos(index * 0.011) * 0.7;

  const expected = summaries.packWaveformSummaries(
    worker.computeCombinedWaveformSummary([first, second], 256),
  );
  const messages = [];
  const scheduled = [];
  let messageHandler = null;
  const scope = {
    addEventListener(_name, handler) {
      messageHandler = handler;
    },
    postMessage(message) {
      messages.push(message);
    },
    setTimeout(callback) {
      scheduled.push(callback);
    },
  };

  worker.installWaveformWorker(scope);
  messageHandler({
    data: {
      type: "start",
      generation: 9,
      channels: [first, second],
      targetResolution: 256,
      maxResolution: 256,
    },
  });
  while (scheduled.length) scheduled.shift()();

  const finalSummary = messages.find((message) =>
    message.type === "summary" && message.preview === false && message.resolution === 256);
  assert.ok(finalSummary);
  assert.equal(finalSummary.summary, expected);
  assert.equal(messages.at(-1).type, "complete");
});

test("waveform controller owns generation and worker cleanup without creating work on init", async () => {
  const controllerModule = await importModuleFromWorkspace("dropbox_browser/assets/js/music/waveform/controller.js");
  const details = createEventTarget({open: false});
  const audio = createEventTarget({});
  const status = {textContent: ""};
  const liveStatus = {textContent: ""};
  let workerCreated = 0;
  let workerTerminated = 0;
  const ctx = {
    els: {
      audio,
      waveformDetails: details,
      waveformLiveStatusEl: liveStatus,
      waveformStatusEl: status,
    },
    playbackApi: {
      currentSong() {
        return null;
      },
    },
  };
  const controller = controllerModule.initWaveformController(ctx, {
    workerFactory() {
      workerCreated += 1;
      return {
        postMessage() {},
        terminate() {
          workerTerminated += 1;
        },
      };
    },
  });

  assert.equal(workerCreated, 0);
  details.open = true;
  details.dispatch("toggle");
  assert.match(status.textContent, /Start playback to build/);
  controller.setActiveSong({remote_path: "Music/track.wav", size: 4, mtime: "now"});
  assert.equal(controller.lookupCache([], {remote_path: "Music/track.wav", size: 4, mtime: "now"}), null);
  const worker = controller.createWorker();
  assert.equal(workerCreated, 1);
  assert.equal(controller.state.worker, worker);
  controller.cancel("test");
  assert.equal(workerTerminated, 1);
  controller.destroy();
  assert.equal(controller.state.destroyed, true);
});

test("waveform panel open state persists across controller initialization", async () => {
  const controllerModule = await importModuleFromWorkspace("dropbox_browser/assets/js/music/waveform/controller.js");
  const settingsStore = Object.create(null);
  const settings = {
    get(key, fallback) {
      return Object.prototype.hasOwnProperty.call(settingsStore, key) ? settingsStore[key] : fallback;
    },
    set(key, value) {
      settingsStore[key] = value;
    },
  };
  const firstDetails = createEventTarget({open: false});
  const firstController = controllerModule.initWaveformController({
    els: {
      audio: createEventTarget({}),
      waveformDetails: firstDetails,
      waveformLiveStatusEl: {textContent: ""},
      waveformStatusEl: {textContent: ""},
    },
    playbackApi: {currentSong() { return null; }},
  }, {settings});

  firstDetails.open = true;
  firstDetails.dispatch("toggle");
  assert.equal(settings.get("music-waveform-open", null), true);
  firstController.destroy();

  const secondDetails = createEventTarget({open: false});
  const secondController = controllerModule.initWaveformController({
    els: {
      audio: createEventTarget({}),
      waveformDetails: secondDetails,
      waveformLiveStatusEl: {textContent: ""},
      waveformStatusEl: {textContent: ""},
    },
    playbackApi: {currentSong() { return null; }},
  }, {settings});
  assert.equal(secondDetails.open, true);
  assert.equal(secondController.isOpen(), true);

  secondDetails.open = false;
  secondDetails.dispatch("toggle");
  assert.equal(settings.get("music-waveform-open", null), false);
  secondController.destroy();
});

test("waveform fetch waits for both an open panel and confirmed audio playback", async () => {
  const controllerModule = await importModuleFromWorkspace("dropbox_browser/assets/js/music/waveform/controller.js");
  const details = createEventTarget({open: false});
  const audio = createEventTarget({ended: false, paused: true});
  const song = {remote_path: "Music/track.wav", stream_path: "Music/track.wav", size: 12, mtime: "now"};
  const calls = [];
  const originalFetch = global.fetch;
  const ctx = {
    els: {
      audio,
      waveformDetails: details,
      waveformLiveStatusEl: {textContent: ""},
      waveformStatusEl: {textContent: ""},
    },
    playbackApi: {
      currentSong() {
        return song;
      },
      streamUrl() {
        return "/file?path=Music%2Ftrack.wav&source=remote";
      },
    },
  };

  global.fetch = async (url, options) => {
    calls.push({url, options});
    return {ok: true, arrayBuffer: async () => new ArrayBuffer(8)};
  };
  try {
    const controller = controllerModule.initWaveformController(ctx, {
      audioContextFactory() {
        return {
          decodeAudioData() {
            return Promise.resolve({
              numberOfChannels: 1,
              getChannelData() {
                return new Float32Array([0.25, 0.75]);
              },
            });
          },
          close() {},
        };
      },
      workerFactory() {
        return {postMessage() {}, terminate() {}};
      },
    });
    audio.dispatch("playing");
    assert.equal(calls.length, 0);
    details.open = true;
    details.dispatch("toggle");
    assert.equal(calls.length, 0);
    audio.paused = false;
    audio.dispatch("playing");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/file?path=Music%2Ftrack.wav&source=remote");
    assert.equal(calls[0].options.signal.aborted, false);
    assert.equal(controller.state.sourceState, "processing");
    assert.equal(controller.state.sourceBytes, null);
    controller.destroy();
  } finally {
    global.fetch = originalFetch;
  }
});

test("waveform decode copies channels once, transfers them, and retains packed worker stages", async () => {
  const controllerModule = await importModuleFromWorkspace("dropbox_browser/assets/js/music/waveform/controller.js");
  const summaries = await importModuleFromWorkspace("dropbox_browser/assets/js/music/waveform/peaks.js");
  const details = createEventTarget({open: true});
  const audio = createEventTarget({ended: false, paused: false});
  const song = {remote_path: "Music/track.wav", stream_path: "Music/track.wav", size: 12, mtime: "now"};
  const posted = [];
  let workerTerminated = 0;
  let decodeBytes = null;
  const worker = {
    onmessage: null,
    onerror: null,
    postMessage(message, transferables) {
      posted.push({message, transferables});
    },
    terminate() {
      workerTerminated += 1;
    },
  };
  const originalFetch = global.fetch;
  const ctx = {
    els: {
      audio,
      waveformDetails: details,
      waveformCanvas: {clientWidth: 300},
      waveformLiveStatusEl: {textContent: ""},
      waveformStatusEl: {textContent: ""},
    },
    playbackApi: {
      currentSong() {
        return song;
      },
      streamUrl() {
        return "/file?path=Music%2Ftrack.wav&source=remote";
      },
    },
  };

  global.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(8),
  });
  try {
    const controller = controllerModule.initWaveformController(ctx, {
      audioContextFactory() {
        return {
          decodeAudioData(bytes) {
            decodeBytes = bytes;
            return Promise.resolve({
              numberOfChannels: 2,
              getChannelData(index) {
                return index === 0
                  ? new Float32Array([0.1, 0.5])
                  : new Float32Array([0.2, 0.8]);
              },
            });
          },
          close() {},
        };
      },
      workerFactory() {
        return worker;
      },
    });

    await controller.startForCurrentSong();
    assert.ok(decodeBytes instanceof ArrayBuffer);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].message.type, "start");
    assert.ok(Number.isInteger(posted[0].message.targetResolution));
    assert.ok(posted[0].message.targetResolution > 0);
    assert.equal(posted[0].message.channels.length, 2);
    assert.equal(posted[0].transferables.length, 2);
    assert.equal(controller.state.sourceBytes, null);
    assert.equal(controller.state.sourceState, "processing");

    const generation = controller.state.workerGeneration;
    const firstSummary = summaries.packWaveformSummaries({
      min: new Float32Array([-0.5, -0.2, 0]),
      max: new Float32Array([0.5, 0.8, 1]),
      rms: new Float32Array([0.2, 0.4, 0.6]),
    });
    const finalSummary = summaries.packWaveformSummaries({
      min: new Float32Array([-1, -0.5, 0, -0.25, -0.1, 0, -0.4, -0.2, 0]),
      max: new Float32Array([0.5, 0.8, 1, 0.4, 0.6, 0.7, 0.9, 0.8, 1]),
      rms: new Float32Array([0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.3, 0.4, 0.5]),
    });
    worker.onmessage({data: {
      type: "summary", generation, resolution: 3, summary: firstSummary,
      sampleRound: 1, sampleRounds: 2, completedSamples: 3, totalSamples: 3,
    }});
    assert.equal(controller.state.summaryByResolution["3"], firstSummary);
    assert.match(ctx.els.waveformStatusEl.textContent, /sample round 1\/\d+: \d+ of \d+ samples completed/);
    worker.onmessage({data: {
      type: "progress", generation, completedSamples: 3, totalSamples: 10,
    }});
    assert.match(ctx.els.waveformStatusEl.textContent,
      /Audio visualization exact scan: 3 of 10 source samples completed \(30%\)\./);
    worker.onmessage({data: {
      type: "summary", generation, resolution: 9, summary: finalSummary,
      sampleRound: 2, sampleRounds: 2, completedSamples: 9, totalSamples: 9,
    }});
    assert.equal(controller.state.latestSummaryResolution, 9);
    worker.onmessage({data: {type: "complete", generation}});
    assert.equal(controller.state.sourceState, "ready");
    assert.match(ctx.els.waveformStatusEl.textContent, /Audio visualization ready at \d+ samples\./);
    assert.equal(workerTerminated, 1);
    controller.destroy();
  } finally {
    global.fetch = originalFetch;
  }
});

test("waveform cache hits render without fetching or decoding and touch recency", async () => {
  const controllerModule = await importModuleFromWorkspace("dropbox_browser/assets/js/music/waveform/controller.js");
  const cacheKey = await importModuleFromWorkspace("dropbox_browser/assets/js/music/waveform/cache-key.js");
  const cache = await importModuleFromWorkspace("dropbox_browser/assets/js/music/waveform/cache.js");
  const summaries = await importModuleFromWorkspace("dropbox_browser/assets/js/music/waveform/peaks.js");
  const details = createEventTarget({open: true});
  const audio = createEventTarget({ended: false, paused: false, duration: 12, currentTime: 2});
  const song = {remote_path: "Music/cached.wav", size: 24, mtime: "now"};
  const key = cacheKey.waveformCacheKey(song);
  const packed = summaries.packWaveformSummaries({
    min: new Float32Array([-0.1, -0.8]),
    max: new Float32Array([0.1, 0.8]),
    rms: new Float32Array([0.1, 0.8]),
  });
  const stored = {
    version: cache.WAVEFORM_CACHE_SCHEMA_VERSION,
    entries: [{version: cache.WAVEFORM_CACHE_SCHEMA_VERSION, key, lastUsed: 1, duration: 12, resolution: 2, summary: packed}],
  };
  const settingsCalls = {get: 0, set: []};
  const settings = {
    get() {
      settingsCalls.get += 1;
      return stored;
    },
    set(keyName, value) {
      settingsCalls.set.push({keyName, value});
    },
  };
  let fetchCalls = 0;
  let decodeCalls = 0;
  const originalFetch = global.fetch;
  const ctx = {
    state: {waveformCacheEntryLimit: 2},
    els: {
      audio,
      waveformDetails: details,
      waveformLiveStatusEl: {textContent: ""},
      waveformStatusEl: {textContent: ""},
    },
    playbackApi: {
      currentSong() {
        return song;
      },
      streamUrl() {
        fetchCalls += 1;
        return "/file?path=Music%2Fcached.wav&source=remote";
      },
    },
  };
  global.fetch = async () => {
    fetchCalls += 1;
    return {ok: true, arrayBuffer: async () => new ArrayBuffer(8)};
  };
  try {
    const controller = controllerModule.initWaveformController(ctx, {
      settings,
      audioContextFactory() {
        decodeCalls += 1;
        return null;
      },
      workerFactory() {
        throw new Error("cache hit must not create a worker");
      },
    });
    assert.equal(await controller.startForCurrentSong(), true);
    assert.equal(controller.state.sourceState, "ready");
    assert.equal(controller.state.latestSummaryResolution, 2);
    assert.equal(fetchCalls, 0);
    assert.equal(decodeCalls, 0);
    assert.ok(settingsCalls.get >= 1);
    assert.equal(settingsCalls.set.length, 1);
    assert.equal(settingsCalls.set[0].keyName, "music-waveform-cache");
    assert.equal(settingsCalls.set[0].value.entries[0].lastUsed > 1, true);
    controller.destroy();
  } finally {
    global.fetch = originalFetch;
  }
});

test("completed waveform stages persist only the validated packed summary", async () => {
  const controllerModule = await importModuleFromWorkspace("dropbox_browser/assets/js/music/waveform/controller.js");
  const cache = await importModuleFromWorkspace("dropbox_browser/assets/js/music/waveform/cache.js");
  const summaries = await importModuleFromWorkspace("dropbox_browser/assets/js/music/waveform/peaks.js");
  const details = createEventTarget({open: true});
  const audio = createEventTarget({ended: false, paused: false, duration: 8, currentTime: 1});
  const song = {remote_path: "Music/write-cache.wav", size: 30, mtime: "now"};
  const packed = summaries.packWaveformSummaries({
    min: new Float32Array([-0.2, -0.9]),
    max: new Float32Array([0.2, 0.9]),
    rms: new Float32Array([0.2, 0.9]),
  });
  const settingsWrites = [];
  const worker = {
    onmessage: null,
    onerror: null,
    postMessage() {},
    terminate() {},
  };
  const ctx = {
    state: {waveformCacheEntryLimit: 2},
    els: {
      audio,
      waveformDetails: details,
      waveformLiveStatusEl: {textContent: ""},
      waveformStatusEl: {textContent: ""},
    },
    playbackApi: {
      currentSong() {
        return song;
      },
      streamUrl() {
        return "/file?path=Music%2Fwrite-cache.wav&source=remote";
      },
    },
  };
  const originalFetch = global.fetch;
  global.fetch = async () => ({ok: true, arrayBuffer: async () => new ArrayBuffer(8)});
  try {
    const controller = controllerModule.initWaveformController(ctx, {
      settings: {
        get() {
          return {version: cache.WAVEFORM_CACHE_SCHEMA_VERSION, entries: []};
        },
        set(_key, value) {
          settingsWrites.push(value);
        },
      },
      audioContextFactory() {
        return {
          decodeAudioData() {
            return Promise.resolve({
              duration: 8,
              numberOfChannels: 1,
              getChannelData() {
                return new Float32Array([0.2, 0.9]);
              },
            });
          },
          close() {},
        };
      },
      workerFactory() {
        return worker;
      },
      maxResolution: 2,
    });
    await controller.startForCurrentSong();
    const generation = controller.state.workerGeneration;
    worker.onmessage({data: {type: "summary", generation, resolution: 2, summary: packed}});
    worker.onmessage({data: {type: "complete", generation}});
    assert.equal(settingsWrites.length, 1);
    assert.equal(settingsWrites[0].version, cache.WAVEFORM_CACHE_SCHEMA_VERSION);
    assert.equal(settingsWrites[0].entries.length, 1);
    assert.equal(settingsWrites[0].entries[0].duration, 8);
    assert.equal(settingsWrites[0].entries[0].resolution, 2);
    assert.equal(settingsWrites[0].entries[0].summary, packed);
    controller.destroy();
  } finally {
    global.fetch = originalFetch;
  }
});

test("waveform canvas renders packed peaks and pointer scrubbing uses the audio seek path", async () => {
  const controllerModule = await importModuleFromWorkspace("dropbox_browser/assets/js/music/waveform/controller.js");
  const details = createEventTarget({open: true});
  const audio = createEventTarget({ended: false, paused: false, duration: 20, currentTime: 5});
  const song = {remote_path: "Music/track.wav", size: 12, mtime: "now"};
  const drawCalls = [];
  let syncCount = 0;
  let capturedPointerId = null;
  let releasedPointerId = null;
  const context = {
    beginPath() { drawCalls.push("beginPath"); },
    clearRect() { drawCalls.push("clearRect"); },
    closePath() { drawCalls.push("closePath"); },
    clip() { drawCalls.push("clip"); },
    fill() { drawCalls.push("fill"); },
    fillRect() { drawCalls.push("fillRect"); },
    lineTo() {},
    moveTo() {},
    restore() { drawCalls.push("restore"); },
    save() { drawCalls.push("save"); },
    setTransform() { drawCalls.push("setTransform"); },
    stroke() { drawCalls.push("stroke"); },
    rect() {},
  };
  const canvas = createEventTarget({
    clientWidth: 200,
    clientHeight: 100,
    getBoundingClientRect() {
      return {left: 10, top: 0, width: 200, height: 100};
    },
    getContext() {
      return context;
    },
    setAttribute(name, value) {
      this[name] = value;
    },
    setPointerCapture(pointerId) {
      capturedPointerId = pointerId;
    },
    releasePointerCapture(pointerId) {
      releasedPointerId = pointerId;
    },
  });
  const ctx = {
    els: {
      audio,
      waveformCanvas: canvas,
      waveformDetails: details,
      waveformLiveStatusEl: {textContent: ""},
      waveformStatusEl: {textContent: ""},
    },
    playbackApi: {
      currentSong() {
        return song;
      },
      syncCurrentTimeDisplay() {
        syncCount += 1;
      },
    },
  };
  const controller = controllerModule.initWaveformController(ctx);
  controller.state.latestSummary = {
    min: new Float32Array([-0.1, -0.5, -1]),
    max: new Float32Array([0.1, 0.5, 1]),
    rms: new Float32Array([0.1, 0.5, 0.8]),
  };
  controller.state.latestSummaryResolution = 3;
  controller.state.latestSummaryPayload = "test-summary";
  controller.renderNow();

  assert.equal(canvas.width, 200);
  assert.equal(canvas.height, 100);
  assert.ok(drawCalls.includes("fillRect"));
  assert.ok(drawCalls.includes("stroke"));
  assert.match(canvas["aria-label"], /5\.0 of 20\.0 seconds/);

  canvas.dispatch("pointerdown", {clientX: 110, pointerId: 4, preventDefault() {}});
  assert.equal(audio.currentTime, 10);
  assert.equal(capturedPointerId, 4);
  canvas.dispatch("pointermove", {clientX: 210, pointerId: 4, preventDefault() {}});
  assert.equal(audio.currentTime, 20);
  canvas.dispatch("pointerup", {clientX: 60, pointerId: 4, preventDefault() {}});
  assert.equal(audio.currentTime, 5);
  assert.equal(releasedPointerId, 4);
  assert.equal(syncCount, 3);

  audio.duration = NaN;
  canvas.dispatch("pointerdown", {clientX: 110, pointerId: 5, preventDefault() {}});
  assert.equal(audio.currentTime, 5);
  controller.destroy();
});

test("closing the waveform panel aborts its deferred fetch and rejects late bytes", async () => {
  const controllerModule = await importModuleFromWorkspace("dropbox_browser/assets/js/music/waveform/controller.js");
  const details = createEventTarget({open: true});
  const audio = createEventTarget({ended: false, paused: false});
  const song = {remote_path: "Music/track.wav", stream_path: "Music/track.wav", size: 12, mtime: "now"};
  const calls = [];
  const originalFetch = global.fetch;
  let resolveFetch;
  const ctx = {
    els: {
      audio,
      waveformDetails: details,
      waveformLiveStatusEl: {textContent: ""},
      waveformStatusEl: {textContent: ""},
    },
    playbackApi: {
      currentSong() {
        return song;
      },
      streamUrl() {
        return "/file?path=Music%2Ftrack.wav&source=remote";
      },
    },
  };

  global.fetch = (url, options) => {
    calls.push({url, options});
    return new Promise((resolve) => {
      resolveFetch = resolve;
    });
  };
  try {
    const controller = controllerModule.initWaveformController(ctx);
    audio.dispatch("playing");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1);
    details.open = false;
    details.dispatch("toggle");
    assert.equal(calls[0].options.signal.aborted, true);
    resolveFetch({ok: true, arrayBuffer: async () => new ArrayBuffer(8)});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(controller.state.sourceBytes, null);
    assert.equal(controller.state.sourceState, "idle");
    controller.destroy();
  } finally {
    global.fetch = originalFetch;
  }
});
