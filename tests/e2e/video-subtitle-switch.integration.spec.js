const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");

process.env.PLAYWRIGHT_PORT = "8013";
process.env.DROPBOX_BROWSER_E2E_FIXTURE = path.join(
  __dirname,
  "fixtures",
  "video_player_generated_fixture.py",
);

const { baseURL, startIntegrationServer, stopIntegrationServer } = require("./support/integration_server");

const hlsStubSource = fs.readFileSync(
  path.join(__dirname, "support", "hls-stub.js"),
  "utf8",
);

let server = null;

test.describe.configure({ timeout: 90000 });

async function installHlsStub(page) {
  await page.route("**/assets/js/vendor/hls.js", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/javascript",
      body: hlsStubSource,
    });
  });
}

const PLAYBACK_SURFACE_MONITOR = () => {
  window.__playbackSurfaceViolations = [];

  function isVisible(element) {
    if (!element || element.hidden) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function sampleState(reason) {
    const loading = document.getElementById("video-loading-overlay");
    const placeholder = document.getElementById("video-playback-placeholder");
    const video = document.getElementById("video-player-media");
    const state = {
      reason,
      loadingVisible: isVisible(loading),
      placeholderVisible: isVisible(placeholder),
      videoVisible: isVisible(video),
      loadingText: loading ? String(loading.textContent || "").trim() : "",
      placeholderText: placeholder ? String(placeholder.textContent || "").trim() : "",
    };
    if (
      (state.loadingVisible && state.placeholderVisible)
      || (state.videoVisible && state.placeholderVisible)
      || (state.videoVisible && state.loadingVisible)
    ) {
      window.__playbackSurfaceViolations.push(state);
    }
  }

  function start() {
    sampleState("init");
    window.setInterval(() => sampleState("interval"), 16);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
};

async function installPlaybackSurfaceMonitor(page) {
  await page.addInitScript(PLAYBACK_SURFACE_MONITOR);
}

const TRACK_REMOVAL_INSTRUMENTATION = () => {
  window.__subtitleTeardownEvents = [];

  function recordTrackRemoved(video) {
    if (!video || video.id !== "video-player-media") return;
    window.__subtitleTeardownEvents.push({
      type: "track-removed",
      videoHidden: Boolean(video.hidden),
      videoHasHiddenClass: video.classList.contains("hidden"),
    });
  }

  const originalRemove = Element.prototype.remove;
  Element.prototype.remove = function removeWithInstrumentation() {
    if (this.tagName === "TRACK") {
      const parent = this.parentElement;
      if (parent && parent.id === "video-player-media") {
        recordTrackRemoved(parent);
      }
    }
    return originalRemove.call(this);
  };
};

async function waitForCompatibilityReady(page) {
  await expect
    .poll(async () => {
      const response = await page.request.get("/video/endpoints/status");
      if (!response.ok()) return null;
      const payload = await response.json();
      return payload.compatibility_available === true;
    }, { timeout: 10000 })
    .toBe(true);
}

async function libraryRow(page, filename) {
  return page
    .locator("#video-library-list .video-library-row")
    .filter({ has: page.locator(".video-row-title", { hasText: filename }) })
    .first();
}

async function waitForVisibleVideo(page) {
  await expect
    .poll(async () => {
      return page.evaluate(() => {
        const video = document.getElementById("video-player-media");
        return Boolean(video && !video.hidden);
      });
    }, { timeout: 10000 })
    .toBe(true);
}

async function waitForLoadingOverlayWithoutPlaceholder(page) {
  await expect
    .poll(async () => {
      return page.evaluate(() => {
        function isVisible(element) {
          if (!element || element.hidden) return false;
          const style = window.getComputedStyle(element);
          return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
        }
        const loading = document.getElementById("video-loading-overlay");
        const placeholder = document.getElementById("video-playback-placeholder");
        return Boolean(isVisible(loading) && !isVisible(placeholder));
      });
    }, { timeout: 10000 })
    .toBe(true);
}

async function waitForPlaybackSurfaceWithoutOverlay(page) {
  await expect
    .poll(async () => {
      return page.evaluate(() => {
        function isVisible(element) {
          if (!element || element.hidden) return false;
          const style = window.getComputedStyle(element);
          return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
        }
        const loading = document.getElementById("video-loading-overlay");
        const placeholder = document.getElementById("video-playback-placeholder");
        const video = document.getElementById("video-player-media");
        return Boolean(isVisible(video) && !isVisible(loading) && !isVisible(placeholder));
      });
    }, { timeout: 10000 })
    .toBe(true);
}

async function setPlaybackTimeForSubtitleChecks(page, seconds) {
  await page.evaluate((targetSeconds) => {
    const video = document.getElementById("video-player-media");
    if (!video) return;
    try {
      video.currentTime = Number(targetSeconds);
    } catch (_error) {
      return;
    }
    video.dispatchEvent(new Event("timeupdate"));
  }, seconds);
}

async function waitForDisplayedSubtitleText(page, expectedText) {
  await expect
    .poll(async () => {
      return page.evaluate(() => {
        const debugCue = document.getElementById("video-debug-current-cue");
        return debugCue ? String(debugCue.textContent || "").trim() : "";
      });
    }, { timeout: 10000 })
    .toContain(expectedText);
}

async function waitForDisplayedSubtitleToClear(page) {
  await expect
    .poll(async () => {
      return page.evaluate(() => {
        const debugCue = document.getElementById("video-debug-current-cue");
        return debugCue ? String(debugCue.textContent || "").trim() : "";
      });
    }, { timeout: 10000 })
    .toBe("No active subtitle cue.");
}

async function expectNoPlaybackSurfaceViolations(page) {
  const violations = await page.evaluate(() => window.__playbackSurfaceViolations || []);
  expect(violations).toEqual([]);
}

async function playbackStageInnerText(page) {
  return page.locator("#video-playback-stage").innerText();
}

function countOccurrences(text, needle) {
  return String(text || "").split(String(needle || "")).length - 1;
}

async function waitForSubtitleStreamIndex(page, streamIndex) {
  const selector = `track[data-video-subtitle-stream-index="${streamIndex}"]`;
  await expect
    .poll(async () => {
      return page.evaluate((trackSelector) => {
        const video = document.getElementById("video-player-media");
        if (!video) return false;
        return Boolean(video.querySelector(trackSelector));
      }, selector);
    }, { timeout: 15000 })
    .toBe(true);
}

async function expectNoMountedSubtitleTrack(page) {
  await expect
    .poll(async () => {
      return page.evaluate(() => {
        const video = document.getElementById("video-player-media");
        if (!video) return 0;
        return video.querySelectorAll("track[data-video-subtitle-track]").length;
      });
    }, { timeout: 10000 })
    .toBe(0);
}

async function expectActiveQueueTitle(page, filename) {
  const activeRow = page.locator("#video-queue-list .video-queue-row.is-active").first();
  await expect(activeRow.locator(".video-row-title")).toHaveText(filename);
}

async function expectTrackSelectors(page, {
  audioEnabled = true,
  subtitleEnabled = true,
  audioValue,
  subtitleValue,
  audioOptionCount,
  subtitleOptionCount,
}) {
  const audioSelect = page.locator("#video-audio-track");
  const subtitleSelect = page.locator("#video-subtitle-track");

  if (audioEnabled) {
    await expect(audioSelect).toBeEnabled();
  } else {
    await expect(audioSelect).toBeDisabled();
  }
  if (subtitleEnabled) {
    await expect(subtitleSelect).toBeEnabled();
  } else {
    await expect(subtitleSelect).toBeDisabled();
  }

  if (audioValue !== undefined) {
    await expect(audioSelect).toHaveValue(String(audioValue));
  }
  if (subtitleValue !== undefined) {
    await expect(subtitleSelect).toHaveValue(String(subtitleValue));
  }
  if (audioOptionCount !== undefined) {
    await expect(audioSelect.locator("option")).toHaveCount(audioOptionCount);
  }
  if (subtitleOptionCount !== undefined) {
    await expect(subtitleSelect.locator("option")).toHaveCount(subtitleOptionCount);
  }
}

function waitForSessionPost(page, predicate) {
  return page.waitForRequest((request) => {
    if (!request.url().includes("/video/endpoints/session") || request.method() !== "POST") {
      return false;
    }
    const body = request.postData() || "";
    return predicate(body);
  }, { timeout: 15000 });
}

async function scrubTo(page, targetSeconds, sessionPredicate) {
  const sessionRequest = waitForSessionPost(page, sessionPredicate);
  await page.locator("#video-progress-slider").evaluate((element, seconds) => {
    element.value = String(seconds);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, targetSeconds);
  await waitForLoadingOverlayWithoutPlaceholder(page);
  await sessionRequest;
  await waitForVisibleVideo(page);
  await waitForPlaybackSurfaceWithoutOverlay(page);
}

async function openVideoPane(page) {
  await page.goto("/?path=Videos");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await page.locator("#bottom-pane-mode").selectOption("video-player");
  await expect(page.locator("#video-player-pane")).toBeVisible();
  await expect(page.locator("#video-library-list .video-library-row")).toHaveCount(3);
  await waitForCompatibilityReady(page);
}

async function playLibraryFile(page, filename) {
  const row = await libraryRow(page, filename);
  await expect(row).toBeVisible();
  await row.dblclick();
  await waitForLoadingOverlayWithoutPlaceholder(page);
  await expectActiveQueueTitle(page, filename);
  await waitForVisibleVideo(page);
  await waitForPlaybackSurfaceWithoutOverlay(page);
}

test.use({ baseURL });

test.beforeAll(async () => {
  test.setTimeout(90000);
  server = await startIntegrationServer();
});

test.afterAll(async () => {
  await stopIntegrationServer(server);
  server = null;
});

test("video playback loads tracks, switches tracks, and hides video before subtitle teardown", async ({ page }) => {
  test.setTimeout(60000);

  page.on("pageerror", (error) => {
    console.log("pageerror:", error);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      console.log("console.error:", message.text());
    }
  });

  await installHlsStub(page);
  await page.addInitScript(TRACK_REMOVAL_INSTRUMENTATION);
  await openVideoPane(page);

  const probeResponse = await page.request.get("/video/endpoints/probe?path=Videos%2Falpha.mkv&source=remote");
  expect(probeResponse.ok()).toBe(true);
  const probePayload = await probeResponse.json();
  expect(probePayload.audio_streams).toHaveLength(2);
  expect(probePayload.subtitle_streams).toHaveLength(3);
  expect(probePayload.default_subtitle_stream_index).toBe(3);
  expect(probePayload.subtitle_streams.map((stream) => stream.codec_name)).toEqual(["subrip", "subrip", "hdmv_pgs_subtitle"]);

  const allSubtitlesResponse = await page.request.get("/video/endpoints/subtitles/all?path=Videos%2Falpha.mkv&source=remote");
  expect(allSubtitlesResponse.ok()).toBe(true);
  const allSubtitlesPayload = await allSubtitlesResponse.json();
  expect(Object.keys(allSubtitlesPayload.tracks).sort()).toEqual(["3", "4"]);
  expect(allSubtitlesPayload.tracks["3"].vtt).toContain("ALPHA-SUBTITLE-ENG");
  expect(allSubtitlesPayload.tracks["4"].vtt).toContain("ALPHA-SUBTITLE-FRA");

  const alphaRow = await libraryRow(page, "alpha.mkv");
  const bravoRow = await libraryRow(page, "bravo.mkv");

  const initialSession = waitForSessionPost(page, (body) => body.includes("path=Videos%2Falpha.mkv"));
  await playLibraryFile(page, "alpha.mkv");
  await initialSession;

  await expectTrackSelectors(page, {
    audioOptionCount: 2,
    subtitleOptionCount: 4,
    audioValue: "1",
    subtitleValue: "3",
  });
  await waitForSubtitleStreamIndex(page, 3);
  await expect(page.locator("#video-player-status")).not.toContainText("Compatibility playback failed");

  await page.locator("#video-subtitle-track").selectOption("4");
  await waitForSubtitleStreamIndex(page, 4);
  await expectTrackSelectors(page, { subtitleValue: "4" });
  await setPlaybackTimeForSubtitleChecks(page, 1);
  await waitForDisplayedSubtitleText(page, "ALPHA-SUBTITLE-FRA");

  await scrubTo(
    page,
    5,
    (body) => body.includes("path=Videos%2Falpha.mkv") && body.includes("start_time_seconds=5"),
  );
  await expectTrackSelectors(page, { audioValue: "1", subtitleValue: "4" });
  await waitForSubtitleStreamIndex(page, 4);

  const alphaAudioRestart = waitForSessionPost(
    page,
    (body) => body.includes("path=Videos%2Falpha.mkv") && body.includes("audio_stream_index=2"),
  );
  await page.locator("#video-audio-track").selectOption("2");
  await waitForLoadingOverlayWithoutPlaceholder(page);
  await alphaAudioRestart;
  await waitForVisibleVideo(page);
  await waitForPlaybackSurfaceWithoutOverlay(page);
  await expectTrackSelectors(page, { audioValue: "2", subtitleValue: "4" });
  await waitForSubtitleStreamIndex(page, 4);

  await scrubTo(
    page,
    1,
    (body) => body.includes("path=Videos%2Falpha.mkv") && body.includes("audio_stream_index=2") && body.includes("start_time_seconds=1"),
  );
  await expectTrackSelectors(page, { audioValue: "2", subtitleValue: "4" });
  await waitForSubtitleStreamIndex(page, 4);

  await page.evaluate(() => {
    window.__subtitleTeardownEvents = [];
  });

  const bravoSession = waitForSessionPost(page, (body) => body.includes("path=Videos%2Fbravo.mkv"));
  await bravoRow.dblclick();
  await waitForLoadingOverlayWithoutPlaceholder(page);
  await waitForDisplayedSubtitleToClear(page);
  await bravoSession;
  await expectActiveQueueTitle(page, "bravo.mkv");

  await expect
    .poll(async () => {
      const events = await page.evaluate(() => window.__subtitleTeardownEvents || []);
      return events.length;
    }, { timeout: 10000 })
    .toBeGreaterThan(0);

  const teardownEvents = await page.evaluate(() => window.__subtitleTeardownEvents || []);
  for (const event of teardownEvents) {
    expect(event.videoHidden, JSON.stringify(event)).toBe(true);
  }

  await waitForVisibleVideo(page);
  await waitForPlaybackSurfaceWithoutOverlay(page);
  await expectTrackSelectors(page, {
    audioOptionCount: 2,
    subtitleOptionCount: 4,
    audioValue: "1",
    subtitleValue: "3",
  });
  await waitForSubtitleStreamIndex(page, 3);

  await page.locator("#video-subtitle-track").selectOption("4");
  await waitForSubtitleStreamIndex(page, 4);
  await expectTrackSelectors(page, { subtitleValue: "4" });

  await scrubTo(
    page,
    6,
    (body) => body.includes("path=Videos%2Fbravo.mkv") && body.includes("start_time_seconds=6"),
  );
  await expectTrackSelectors(page, { audioValue: "1", subtitleValue: "4" });
  await waitForSubtitleStreamIndex(page, 4);

  const bravoAudioRestart = waitForSessionPost(
    page,
    (body) => body.includes("path=Videos%2Fbravo.mkv") && body.includes("audio_stream_index=2"),
  );
  await page.locator("#video-audio-track").selectOption("2");
  await waitForLoadingOverlayWithoutPlaceholder(page);
  await bravoAudioRestart;
  await waitForVisibleVideo(page);
  await waitForPlaybackSurfaceWithoutOverlay(page);
  await expectTrackSelectors(page, { audioValue: "2", subtitleValue: "4" });
  await waitForSubtitleStreamIndex(page, 4);

  await scrubTo(
    page,
    2,
    (body) => body.includes("path=Videos%2Fbravo.mkv") && body.includes("audio_stream_index=2") && body.includes("start_time_seconds=2"),
  );
  await expectTrackSelectors(page, { audioValue: "2", subtitleValue: "4" });
  await waitForSubtitleStreamIndex(page, 4);

  await page.locator("#video-subtitle-track").selectOption("");
  await expectNoMountedSubtitleTrack(page);
  await expectTrackSelectors(page, { subtitleValue: "" });

  await page.locator("#video-subtitle-track").selectOption("3");
  await waitForSubtitleStreamIndex(page, 3);
  await expectTrackSelectors(page, { subtitleValue: "3" });
});

test("video playback never shows loading or placeholder copy on top of active playback during real HLS switching", async ({ page }) => {
  test.setTimeout(90000);

  await installPlaybackSurfaceMonitor(page);
  await openVideoPane(page);

  const alphaSession = waitForSessionPost(page, (body) => body.includes("path=Videos%2Falpha.mkv"));
  const alphaRow = await libraryRow(page, "alpha.mkv");
  await alphaRow.dblclick();
  await waitForLoadingOverlayWithoutPlaceholder(page);
  await alphaSession;
  await expect
    .poll(async () => playbackStageInnerText(page), { timeout: 10000 })
    .toContain("Creating the local HLS compatibility session.");
  const alphaLoadingText = await playbackStageInnerText(page);
  expect(alphaLoadingText).not.toContain("Preparing an HLS compatibility session for this queue item.");
  expect(countOccurrences(alphaLoadingText, "alpha.mkv")).toBe(1);

  await waitForVisibleVideo(page);
  await page.waitForTimeout(1500);
  const alphaPlayText = await playbackStageInnerText(page);
  expect(alphaPlayText).not.toContain("Playing through a local HLS compatibility session.");
  expect(alphaPlayText).not.toContain("alpha.mkv");
  await page.locator("#video-subtitle-track").selectOption("4");
  await waitForSubtitleStreamIndex(page, 4);
  await expectNoPlaybackSurfaceViolations(page);

  const bravoRow = await libraryRow(page, "bravo.mkv");
  const bravoSession = waitForSessionPost(page, (body) => body.includes("path=Videos%2Fbravo.mkv"));
  await bravoRow.dblclick();
  await waitForLoadingOverlayWithoutPlaceholder(page);
  await bravoSession;
  await expect
    .poll(async () => playbackStageInnerText(page), { timeout: 10000 })
    .toContain("Creating the local HLS compatibility session.");
  const bravoLoadingText = await playbackStageInnerText(page);
  expect(bravoLoadingText).not.toContain("Preparing an HLS compatibility session for this queue item.");
  expect(countOccurrences(bravoLoadingText, "bravo.mkv")).toBe(1);

  await waitForVisibleVideo(page);
  await page.waitForTimeout(2000);
  const bravoPlayText = await playbackStageInnerText(page);
  expect(bravoPlayText).not.toContain("Playing through a local HLS compatibility session.");
  expect(bravoPlayText).not.toContain("bravo.mkv");
  await expectNoPlaybackSurfaceViolations(page);
});
