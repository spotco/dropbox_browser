const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  const source = await fs.readFile(absolutePath, "utf8");
  return import(`data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`);
}

function video(pathname) {
  return {
    path: pathname,
    display_name: pathname.split("/").pop(),
    compatibility_expected: pathname.endsWith(".mkv"),
  };
}

test("enqueueSelected appends items without changing the active queue item", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/video-core.js");
  const initialQueue = [video("Videos/alpha.mp4")];

  const result = mod.enqueueSelected(initialQueue, 0, [video("Videos/bravo.mkv"), video("Videos/charlie.mp4")]);

  assert.deepEqual(result.queue.map((item) => item.path), [
    "Videos/alpha.mp4",
    "Videos/bravo.mkv",
    "Videos/charlie.mp4",
  ]);
  assert.equal(result.activeIndex, 0);
});

test("enqueueAndPlay appends one item and selects it as active", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/video-core.js");
  const result = mod.enqueueAndPlay([video("Videos/alpha.mp4")], 0, video("Videos/bravo.mkv"));

  assert.deepEqual(result.queue.map((item) => item.path), ["Videos/alpha.mp4", "Videos/bravo.mkv"]);
  assert.equal(result.activeIndex, 1);
});

test("removeQueueIndex keeps the next sensible active queue item", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/video-core.js");
  const queue = [video("a.mp4"), video("b.mp4"), video("c.mp4")];

  const removingActive = mod.removeQueueIndex(queue, 1, 1);
  assert.deepEqual(removingActive.queue.map((item) => item.path), ["a.mp4", "c.mp4"]);
  assert.equal(removingActive.activeIndex, 1);

  const removingBeforeActive = mod.removeQueueIndex(queue, 2, 0);
  assert.deepEqual(removingBeforeActive.queue.map((item) => item.path), ["b.mp4", "c.mp4"]);
  assert.equal(removingBeforeActive.activeIndex, 1);
});

test("moveQueueIndex reorders the queue and carries the active item with it", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/video-core.js");
  const queue = [video("a.mp4"), video("b.mp4"), video("c.mp4"), video("d.mp4")];

  const result = mod.moveQueueIndex(queue, 1, 1, 3);

  assert.equal(result.moved, true);
  assert.deepEqual(result.queue.map((item) => item.path), ["a.mp4", "c.mp4", "d.mp4", "b.mp4"]);
  assert.equal(result.activeIndex, 3);
});

test("advanceQueueAfterPlaybackEnd moves to the next item and stops at the end", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/video-core.js");

  assert.equal(mod.advanceQueueAfterPlaybackEnd(3, 0), 1);
  assert.equal(mod.advanceQueueAfterPlaybackEnd(3, 1), 2);
  assert.equal(mod.advanceQueueAfterPlaybackEnd(3, 2), -1);
  assert.equal(mod.advanceQueueAfterPlaybackEnd(0, -1), -1);
});

test("playbackDurationSeconds uses finite media duration outside compatibility playback", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/video-core.js");

  assert.equal(mod.playbackDurationSeconds(12.5, {duration_seconds: 30}, "native"), 12.5);
});

test("playbackDurationSeconds uses probe duration before temporary HLS duration for compatibility streams", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/video-core.js");

  assert.equal(mod.playbackDurationSeconds(Infinity, {duration_seconds: 1501.25}, "compatibility"), 1501.25);
  assert.equal(mod.playbackDurationSeconds(6, {duration_seconds: 1501.25}, "compatibility"), 1501.25);
});

test("playbackDurationSeconds returns zero when duration is unavailable", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/video-core.js");

  assert.equal(mod.playbackDurationSeconds(Infinity, {duration_seconds: 1501.25}, "native"), 0);
  assert.equal(mod.playbackDurationSeconds(NaN, null, "compatibility"), 0);
});

function baseSeekDecisionInput(overrides = {}) {
  return {
    targetSeconds: 30,
    sessionStartSeconds: 0,
    seekableRanges: [{start: 0, end: 60}],
    encodedMediaEndSeconds: 60,
    hasActiveSession: true,
    sessionId: "session-1",
    playbackMode: "compatibility",
    itemPath: "Videos/alpha.mkv",
    sessionPath: "Videos/alpha.mkv",
    selectedAudioStreamIndex: 1,
    sessionAudioStreamIndex: 1,
    selectedBurnedInSubtitleStreamIndex: null,
    sessionSubtitleStreamIndex: null,
    ...overrides,
  };
}

test("compatibilityInSessionSeekDecision uses in-session seek inside encoded range", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/video-core.js");

  const backward = mod.compatibilityInSessionSeekDecision(baseSeekDecisionInput({
    targetSeconds: 12,
    encodedMediaEndSeconds: 48,
    seekableRanges: [{start: 0, end: 48}],
  }));
  assert.equal(backward.action, "in-session");
  assert.equal(backward.reason, "encoded-range");
  assert.equal(backward.mediaTargetSeconds, 12);

  const forwardWithinRange = mod.compatibilityInSessionSeekDecision(baseSeekDecisionInput({
    targetSeconds: 42,
    encodedMediaEndSeconds: 48,
    seekableRanges: [{start: 0, end: 30}],
  }));
  assert.equal(forwardWithinRange.action, "in-session");
  assert.equal(forwardWithinRange.mediaTargetSeconds, 42);
});

test("compatibilityInSessionSeekDecision restarts when target is beyond encoded range", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/video-core.js");

  const beyondEncoded = mod.compatibilityInSessionSeekDecision(baseSeekDecisionInput({
    targetSeconds: 55,
    encodedMediaEndSeconds: 48,
    seekableRanges: [{start: 0, end: 48}],
  }));
  assert.equal(beyondEncoded.action, "restart");
  assert.equal(beyondEncoded.reason, "beyond-encoded-range");

  const inflatedSeekable = mod.compatibilityInSessionSeekDecision(baseSeekDecisionInput({
    targetSeconds: 164.9,
    encodedMediaEndSeconds: 54,
    seekableRanges: [{start: 0, end: 1500}],
  }));
  assert.equal(inflatedSeekable.action, "restart");
  assert.equal(inflatedSeekable.reason, "beyond-encoded-range");

  const beforeSessionStart = mod.compatibilityInSessionSeekDecision(baseSeekDecisionInput({
    targetSeconds: 690,
    sessionStartSeconds: 696,
    encodedMediaEndSeconds: 48,
    seekableRanges: [{start: 0, end: 48}],
  }));
  assert.equal(beforeSessionStart.action, "restart");
  assert.equal(beforeSessionStart.reason, "before-session-start");
});

test("compatibilityInSessionSeekDecision restarts when tracks or session context changed", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/video-core.js");

  const audioChanged = mod.compatibilityInSessionSeekDecision(baseSeekDecisionInput({
    selectedAudioStreamIndex: 2,
    sessionAudioStreamIndex: 1,
  }));
  assert.equal(audioChanged.action, "restart");
  assert.equal(audioChanged.reason, "track-selection");

  const burnedInChanged = mod.compatibilityInSessionSeekDecision(baseSeekDecisionInput({
    selectedBurnedInSubtitleStreamIndex: 5,
    sessionSubtitleStreamIndex: null,
  }));
  assert.equal(burnedInChanged.action, "restart");
  assert.equal(burnedInChanged.reason, "track-selection");

  const noSession = mod.compatibilityInSessionSeekDecision(baseSeekDecisionInput({
    hasActiveSession: false,
    sessionId: "",
  }));
  assert.equal(noSession.action, "restart");
  assert.equal(noSession.reason, "no-session");
});

test("shouldApplyDeferredCompatibilitySeek ignores cleared null seek state", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/video-core.js");

  assert.equal(mod.shouldApplyDeferredCompatibilitySeek(null, 250.5, 0.05), false);
  assert.equal(mod.shouldApplyDeferredCompatibilitySeek(undefined, 250.5, 0.05), false);
  assert.equal(mod.shouldApplyDeferredCompatibilitySeek("", 250.5, 0.05), false);
  assert.equal(mod.shouldApplyDeferredCompatibilitySeek(250.5, 250.5, 0.05), false);
  assert.equal(mod.shouldApplyDeferredCompatibilitySeek(260, 250.5, 0.05), true);
});

test("compatibilityEncodedMediaEndSeconds prefers the widest known encoded extent", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/video-core.js");

  assert.equal(
    mod.compatibilityEncodedMediaEndSeconds([{start: 0, end: 18}], 12),
    18,
  );
  assert.equal(
    mod.compatibilityEncodedMediaEndSeconds([], 12),
    12,
  );
  assert.equal(
    mod.compatibilityEncodedMediaEndSeconds([], 0),
    0,
  );
});
