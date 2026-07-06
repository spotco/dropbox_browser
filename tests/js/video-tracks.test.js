const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  return import(pathToFileURL(absolutePath).href + `?t=${Date.now()}`);
}

function makeEl() {
  return {
    value: "",
    checked: true,
    disabled: false,
    listeners: Object.create(null),
    addEventListener(type, handler) {
      this.listeners[type] = handler;
    },
  };
}

function createCtx(overrides = {}) {
  const shadowEl = makeEl();
  const strokeEl = makeEl();
  const fontSizeEl = makeEl();
  const offsetEl = makeEl();
  const applyEl = makeEl();
  const bodyStyleValues = Object.create(null);
  const writes = [];
  const reads = [];
  const settingsStore = overrides.settingsStore || {
    shadowEnabled: false,
    strokeEnabled: false,
    fontSizePx: 36,
    offsetPx: -14,
  };
  const ctx = {
    els: {
      subtitleShadowEnabledEl: shadowEl,
      subtitleStrokeEnabledEl: strokeEl,
      subtitleFontSizeInputEl: fontSizeEl,
      subtitleOffsetInputEl: offsetEl,
      subtitleStyleApplyButtonEl: applyEl,
    },
    body: {
      style: {
        setProperty(name, value) {
          bodyStyleValues[name] = value;
        },
      },
    },
    state: {
      probeCache: Object.create(null),
      selectedSubtitleStreamIndexByPath: Object.create(null),
      subtitleStyleDraft: null,
      subtitleStyleApplied: null,
      pendingSubtitleStyleApply: false,
      seekRestartInProgress: false,
      pendingAutoplay: false,
      transportWantsPlay: false,
    },
    restartCalls: [],
    readVideoSetting(key, fallback) {
      reads.push([key, fallback]);
      return settingsStore;
    },
    writeVideoSetting(key, value) {
      writes.push([key, value]);
    },
    activeQueueItem() {
      return null;
    },
    subtitleStreamsForPayload() {
      return [];
    },
    subtitleStreamRequiresBurnIn() {
      return false;
    },
    normalizeSubtitleStreamIndex(value) {
      return value;
    },
    selectedBurnedInSubtitleStreamIndex() {
      return null;
    },
    compatibilitySessionHasBurnedInSubtitles() {
      return Boolean(overrides.compatibilitySessionHasBurnedInSubtitles);
    },
    currentGlobalPlaybackSeconds() {
      return 0;
    },
    async restartCompatibilityAt(...args) {
      if (overrides.disallowRestart) {
        throw new Error("restartCompatibilityAt should not be called in this test");
      }
      ctx.restartCalls.push(args);
    },
    setStatus(text) {
      ctx.lastStatus = text;
    },
  };
  ctx.bodyStyleValues = bodyStyleValues;
  ctx.writes = writes;
  ctx.reads = reads;
  return ctx;
}

test("initTracks restores persisted subtitle style options on startup", async () => {
  const { initTracks } = await importModuleFromWorkspace("dropbox_browser/assets/js/video/tracks.js");
  const ctx = createCtx();

  initTracks(ctx);

  assert.deepEqual(ctx.reads[0][0], "video-subtitle-style");
  assert.equal(ctx.els.subtitleShadowEnabledEl.checked, false);
  assert.equal(ctx.els.subtitleStrokeEnabledEl.checked, false);
  assert.equal(ctx.els.subtitleFontSizeInputEl.value, "36");
  assert.equal(ctx.els.subtitleOffsetInputEl.value, "-14");
  assert.deepEqual(ctx.state.subtitleStyleApplied, {
    shadowEnabled: false,
    strokeEnabled: false,
    fontSizePx: 36,
    offsetPx: -14,
  });
  assert.deepEqual(ctx.state.subtitleStyleDraft, ctx.state.subtitleStyleApplied);
  assert.equal(ctx.bodyStyleValues["--video-subtitle-font-size"], "36px");
  assert.equal(ctx.bodyStyleValues["--video-subtitle-offset"], "-14px");
  assert.equal(ctx.bodyStyleValues["--video-subtitle-shadow"], "none");
});

test("subtitle style number inputs stay local until Apply is pressed", async () => {
  const { initTracks } = await importModuleFromWorkspace("dropbox_browser/assets/js/video/tracks.js");
  const ctx = createCtx({ disallowRestart: true });

  initTracks(ctx);
  ctx.els.subtitleFontSizeInputEl.value = "42";
  ctx.els.subtitleOffsetInputEl.value = "-20";

  assert.equal(ctx.writes.length, 0);
  assert.deepEqual(ctx.state.subtitleStyleApplied, {
    shadowEnabled: false,
    strokeEnabled: false,
    fontSizePx: 36,
    offsetPx: -14,
  });
  assert.equal(ctx.bodyStyleValues["--video-subtitle-font-size"], "36px");
  assert.equal(ctx.bodyStyleValues["--video-subtitle-offset"], "-14px");

  await ctx.handleSubtitleStyleApply();

  assert.equal(ctx.writes.length, 1);
  assert.deepEqual(ctx.writes[0], [
    "video-subtitle-style",
    {
      shadowEnabled: false,
      strokeEnabled: false,
      fontSizePx: 42,
      offsetPx: -20,
    },
  ]);
  assert.deepEqual(ctx.state.subtitleStyleApplied, ctx.state.subtitleStyleDraft);
  assert.equal(ctx.lastStatus, "Subtitle style applied.");
});

test("subtitle style checkbox preview uses applied size and offset values", async () => {
  const { initTracks } = await importModuleFromWorkspace("dropbox_browser/assets/js/video/tracks.js");
  const ctx = createCtx({ disallowRestart: true });

  initTracks(ctx);
  ctx.els.subtitleStrokeEnabledEl.checked = true;
  ctx.els.subtitleFontSizeInputEl.value = "42";
  ctx.els.subtitleOffsetInputEl.value = "-20";
  ctx.els.subtitleStrokeEnabledEl.listeners.change();

  assert.equal(ctx.writes.length, 0);
  assert.deepEqual(ctx.state.subtitleStyleDraft, {
    shadowEnabled: false,
    strokeEnabled: true,
    fontSizePx: 42,
    offsetPx: -20,
  });
  assert.equal(ctx.bodyStyleValues["--video-subtitle-font-size"], "36px");
  assert.equal(ctx.bodyStyleValues["--video-subtitle-offset"], "-14px");
  assert.match(
    ctx.bodyStyleValues["--video-subtitle-shadow"],
    /-1\.25px -1\.25px 0 rgba\(0, 0, 0, 0\.94\)/
  );
  assert.doesNotMatch(
    ctx.bodyStyleValues["--video-subtitle-shadow"],
    /0 2px 10px rgba\(0, 0, 0, 0\.55\)/
  );
});

test("subtitle style Apply skips burned-in restart for size and offset only changes", async () => {
  const { initTracks } = await importModuleFromWorkspace("dropbox_browser/assets/js/video/tracks.js");
  const ctx = createCtx({
    compatibilitySessionHasBurnedInSubtitles: true,
  });

  initTracks(ctx);
  ctx.els.subtitleFontSizeInputEl.value = "44";
  ctx.els.subtitleOffsetInputEl.value = "-22";

  await ctx.handleSubtitleStyleApply();

  assert.equal(ctx.restartCalls.length, 0);
  assert.equal(ctx.state.pendingSubtitleStyleApply, false);
  assert.equal(
    ctx.lastStatus,
    "Subtitle style applied. Burned-in subtitles restart only for shadow or stroke changes."
  );
});

test("subtitle style Apply restarts burned-in playback for shadow changes", async () => {
  const { initTracks } = await importModuleFromWorkspace("dropbox_browser/assets/js/video/tracks.js");
  const ctx = createCtx({
    compatibilitySessionHasBurnedInSubtitles: true,
  });

  initTracks(ctx);
  ctx.els.subtitleShadowEnabledEl.checked = true;
  ctx.els.subtitleShadowEnabledEl.listeners.change();

  await ctx.handleSubtitleStyleApply();

  assert.equal(ctx.restartCalls.length, 1);
  assert.deepEqual(ctx.restartCalls[0], [
    0,
    "subtitle-style-apply",
    { forceSessionRestart: true },
  ]);
  assert.equal(ctx.lastStatus, "Applying subtitle style to burned-in subtitles.");
});

test("subtitle style Apply accepts values outside the old input limits", async () => {
  const { initTracks } = await importModuleFromWorkspace("dropbox_browser/assets/js/video/tracks.js");
  const ctx = createCtx({ disallowRestart: true });

  initTracks(ctx);
  ctx.els.subtitleFontSizeInputEl.value = "120";
  ctx.els.subtitleOffsetInputEl.value = "-240";

  await ctx.handleSubtitleStyleApply();

  assert.deepEqual(ctx.writes[0][1], {
    shadowEnabled: false,
    strokeEnabled: false,
    fontSizePx: 120,
    offsetPx: -240,
  });
  assert.equal(ctx.bodyStyleValues["--video-subtitle-font-size"], "120px");
  assert.equal(ctx.bodyStyleValues["--video-subtitle-offset"], "-240px");
});

test("subtitle style Reset restores defaults and applies them", async () => {
  const { initTracks } = await importModuleFromWorkspace("dropbox_browser/assets/js/video/tracks.js");
  const ctx = createCtx({ disallowRestart: true });

  initTracks(ctx);
  ctx.els.subtitleShadowEnabledEl.checked = false;
  ctx.els.subtitleStrokeEnabledEl.checked = false;
  ctx.els.subtitleFontSizeInputEl.value = "52";
  ctx.els.subtitleOffsetInputEl.value = "-30";
  await ctx.handleSubtitleStyleApply();

  await ctx.handleSubtitleStyleReset();

  assert.equal(ctx.els.subtitleShadowEnabledEl.checked, true);
  assert.equal(ctx.els.subtitleStrokeEnabledEl.checked, true);
  assert.equal(ctx.els.subtitleFontSizeInputEl.value, "28");
  assert.equal(ctx.els.subtitleOffsetInputEl.value, "0");
  assert.deepEqual(ctx.state.subtitleStyleApplied, {
    shadowEnabled: true,
    strokeEnabled: true,
    fontSizePx: 28,
    offsetPx: 0,
  });
  assert.equal(ctx.bodyStyleValues["--video-subtitle-font-size"], "28px");
  assert.equal(ctx.bodyStyleValues["--video-subtitle-offset"], "0px");
  assert.match(
    ctx.bodyStyleValues["--video-subtitle-shadow"],
    /0 2px 10px rgba\(0, 0, 0, 0\.55\)/
  );
  assert.equal(ctx.writes[ctx.writes.length - 1][0], "video-subtitle-style");
  assert.deepEqual(ctx.writes[ctx.writes.length - 1][1], ctx.state.subtitleStyleApplied);
});

test("subtitle style Apply with unchanged values is a no-op", async () => {
  const { initTracks } = await importModuleFromWorkspace("dropbox_browser/assets/js/video/tracks.js");
  const ctx = createCtx({ disallowRestart: true });

  initTracks(ctx);
  await ctx.handleSubtitleStyleApply();

  assert.equal(ctx.writes.length, 0);
  assert.equal(ctx.restartCalls.length, 0);
  assert.equal(ctx.lastStatus, "Subtitle style is already applied.");
});

test("subtitle track change during seek restart defers replay until playback seek completes", async () => {
  const { initTracks } = await importModuleFromWorkspace("dropbox_browser/assets/js/video/tracks.js");
  const item = {path: "movie.mp4"};
  const ctx = createCtx({ disallowRestart: true });
  const probePayload = {
    subtitle_streams: [
      {index: 3, webvtt_compatible: true, language: "eng", title: "English"},
      {index: 5, webvtt_compatible: false, language: "eng", title: "Bitmap"},
    ],
    default_subtitle_stream_index: 3,
  };
  ctx.state.probeCache[item.path] = probePayload;
  ctx.state.selectedSubtitleStreamIndexByPath[item.path] = 3;
  ctx.state.seekRestartInProgress = true;
  ctx.els.subtitleTrackSelectEl = makeEl();
  ctx.els.subtitleTrackSelectEl.value = "5";
  ctx.els.subtitleTrackSelectEl.disabled = false;
  ctx.subtitleStreamsForPayload = function (payload) {
    return Array.isArray(payload && payload.subtitle_streams) ? payload.subtitle_streams : [];
  };
  ctx.normalizeSubtitleStreamIndex = function (value) {
    if (value === "" || value === null || value === undefined) return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  };
  ctx.selectedSubtitleStream = function (active, payload) {
    const selected = ctx.state.selectedSubtitleStreamIndexByPath[active.path] || "";
    return ctx.subtitleStreamsForPayload(payload).find((stream) => Number(stream.index) === Number(selected)) || null;
  };
  ctx.subtitleStreamRequiresBurnIn = function (stream) {
    return Boolean(stream && stream.webvtt_compatible === false);
  };
  ctx.persistSubtitleSelectionFromUi = function () {};
  ctx.activeQueueItem = function () {
    return item;
  };

  initTracks(ctx);
  await ctx.handleSubtitleTrackChange();

  assert.equal(ctx.state.selectedSubtitleStreamIndexByPath[item.path], 5);
  assert.equal(ctx.state.pendingSubtitleTrackChange, true);
  assert.equal(ctx.restartCalls.length, 0);
  assert.equal(ctx.lastStatus, "Subtitle track will load when playback seek completes.");
});
