const path = require("node:path");
const {pathToFileURL} = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  return import(pathToFileURL(absolutePath).href);
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

test("clampCompatibilityRestartTargetSeconds keeps restart sessions away from exact EOF", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/video-core.js");

  assert.equal(mod.clampCompatibilityRestartTargetSeconds(24, 24), 23);
  assert.equal(mod.clampCompatibilityRestartTargetSeconds(30, 24), 23);
  assert.equal(mod.clampCompatibilityRestartTargetSeconds(23.5, 24), 23);
  assert.equal(mod.clampCompatibilityRestartTargetSeconds(22.5, 24), 22.5);
  assert.equal(mod.clampCompatibilityRestartTargetSeconds(0.2, 0.2), 0.1);
  assert.equal(mod.clampCompatibilityRestartTargetSeconds(5, NaN), 5);
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
    targetSeconds: 24,
    encodedMediaEndSeconds: 48,
    seekableRanges: [{start: 0, end: 30}],
  }));
  assert.equal(forwardWithinRange.action, "in-session");
  assert.equal(forwardWithinRange.mediaTargetSeconds, 24);
});

test("compatibilityInSessionSeekDecision restarts when target is beyond actual seekable range", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/video-core.js");

  const beyondSeekable = mod.compatibilityInSessionSeekDecision(baseSeekDecisionInput({
    targetSeconds: 42,
    encodedMediaEndSeconds: 48,
    seekableRanges: [{start: 0, end: 30}],
  }));
  assert.equal(beyondSeekable.action, "restart");
  assert.equal(beyondSeekable.reason, "beyond-seekable-range");
});

test("compatibilityInSessionSeekDecision falls back to encoded range when seekable is temporarily empty", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/video-core.js");

  const emptySeekable = mod.compatibilityInSessionSeekDecision(baseSeekDecisionInput({
    targetSeconds: 24,
    encodedMediaEndSeconds: 48,
    seekableRanges: [],
  }));
  assert.equal(emptySeekable.action, "in-session");
  assert.equal(emptySeekable.reason, "encoded-range");
  assert.equal(emptySeekable.mediaTargetSeconds, 24);
});

test("compatibilityInSessionSeekDecision restarts when target is beyond encoded range", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/video-core.js");

  const beyondEncoded = mod.compatibilityInSessionSeekDecision(baseSeekDecisionInput({
    targetSeconds: 55,
    encodedMediaEndSeconds: 48,
    seekableRanges: [{start: 0, end: 60}],
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

test("compatibilityRecoveryRequiresSessionRestart forces a new session for recovery reasons", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/video-core.js");

  assert.equal(mod.compatibilityRecoveryRequiresSessionRestart("hls-missing-segment"), true);
  assert.equal(mod.compatibilityRecoveryRequiresSessionRestart("hls-fatal-error"), true);
  assert.equal(mod.compatibilityRecoveryRequiresSessionRestart("media-element-error"), true);
  assert.equal(mod.compatibilityRecoveryRequiresSessionRestart("restart-failed"), true);
  assert.equal(mod.compatibilityRecoveryRequiresSessionRestart("initial-start-failed"), true);
  assert.equal(mod.compatibilityRecoveryRequiresSessionRestart("scrub"), false);
  assert.equal(mod.compatibilityRecoveryRequiresSessionRestart("audio-track-change"), false);
  assert.equal(mod.compatibilityRecoveryRequiresSessionRestart(""), false);
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

test("compatibilityProcessedRange clamps the processed window to the full runtime", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/video-core.js");

  assert.deepEqual(
    mod.compatibilityProcessedRange({
      durationSeconds: 120,
      sessionStartSeconds: 30,
      encodedMediaEndSeconds: 42,
    }),
    {
      startSeconds: 30,
      endSeconds: 72,
      startPercent: 25,
      endPercent: 60,
    },
  );

  assert.deepEqual(
    mod.compatibilityProcessedRange({
      durationSeconds: 120,
      sessionStartSeconds: 110,
      encodedMediaEndSeconds: 42,
    }),
    {
      startSeconds: 110,
      endSeconds: 120,
      startPercent: 91.66666666666666,
      endPercent: 100,
    },
  );

  assert.deepEqual(
    mod.compatibilityProcessedRange({
      durationSeconds: 0,
      sessionStartSeconds: 30,
      encodedMediaEndSeconds: 42,
    }),
    {
      startSeconds: 0,
      endSeconds: 0,
      startPercent: 0,
      endPercent: 0,
    },
  );
});

test("webvttCueTextToHtml renders common WebVTT formatting tags", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/video-core.js");

  assert.equal(mod.webvttCueTextToHtml("plain text"), "plain text");
  assert.equal(mod.webvttCueTextToHtml("<i>italic</i>"), "<i>italic</i>");
  assert.equal(mod.webvttCueTextToHtml("<b>bold</b>"), "<b>bold</b>");
  assert.equal(mod.webvttCueTextToHtml("<u>underline</u>"), "<u>underline</u>");
  assert.equal(
    mod.webvttCueTextToHtml("<i>mixed <b>styles</b></i>"),
    "<i>mixed <b>styles</b></i>",
  );
  assert.equal(
    mod.webvttCueTextToHtml('<c.red>classed</c>'),
    '<span class="vtt-c red">classed</span>',
  );
  assert.equal(
    mod.webvttCueTextToHtml("<v John>hello</v>"),
    '<span class="vtt-v" data-voice="John">hello</span>',
  );
  assert.equal(
    mod.webvttCueTextToHtml("<lang en>colour</lang>"),
    '<span lang="en">colour</span>',
  );
  assert.equal(
    mod.webvttCueTextToHtml("<ruby>漢<rt>kan</rt></ruby>"),
    "<ruby>漢<rt>kan</rt></ruby>",
  );
  assert.equal(mod.webvttCueTextToHtml("a &amp; b"), "a &amp; b");
  assert.equal(mod.webvttCueTextToHtml("a <not-a-tag> b"), "a &lt;not-a-tag&gt; b");
  assert.equal(mod.webvttCueTextToHtml("cue<00:00:01.000> text"), "cue text");
});

test("stripWebVttMarkup removes tags and timestamp annotations", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/video-core.js");

  assert.equal(mod.stripWebVttMarkup("<i>ALPHA-SUBTITLE-ENG</i>"), "ALPHA-SUBTITLE-ENG");
  assert.equal(mod.stripWebVttMarkup("line<00:00:01.000> two"), "line two");
});

test("findActiveParsedCues returns every cue active at the media time", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/video-core.js");
  const cues = [
    { start: 0, end: 2, rawText: "one" },
    { start: 1, end: 3, rawText: "two" },
    { start: 4, end: 6, rawText: "three" },
  ];

  assert.deepEqual(mod.findActiveParsedCues(cues, 1.5).map((cue) => cue.rawText), ["one", "two"]);
  assert.deepEqual(mod.findActiveParsedCues(cues, 4.5).map((cue) => cue.rawText), ["three"]);
  assert.deepEqual(mod.findActiveParsedCues(cues, 3.5), []);
});

test("compatibilitySeekableRange clamps the displayed seekable window to actual seekable media", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/video-core.js");

  assert.deepEqual(
    mod.compatibilitySeekableRange({
      durationSeconds: 120,
      sessionStartSeconds: 30,
      seekableRanges: [{start: 0, end: 18}],
    }),
    {
      startSeconds: 30,
      endSeconds: 48,
      startPercent: 25,
      endPercent: 40,
    },
  );

  assert.deepEqual(
    mod.compatibilitySeekableRange({
      durationSeconds: 120,
      sessionStartSeconds: 110,
      seekableRanges: [{start: 0, end: 18}],
    }),
    {
      startSeconds: 110,
      endSeconds: 120,
      startPercent: 91.66666666666666,
      endPercent: 100,
    },
  );
});
