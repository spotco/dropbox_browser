const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");

process.env.PLAYWRIGHT_PORT = "8014";
process.env.DROPBOX_BROWSER_E2E_FIXTURE = path.join(
  __dirname,
  "fixtures",
  "video-subtitle-startup-delay.generated.py",
);

const { startIntegrationServer, stopIntegrationServer } = require("./support/integration_server");
const baseURL = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT}`;

const hlsStubSource = fs.readFileSync(
  path.join(__dirname, "support", "hls-stub.js"),
  "utf8",
);

test.describe.configure({ timeout: 90000 });

function isClosedRouteError(error) {
  const message = error && error.message ? String(error.message) : "";
  return message.includes("Target page, context or browser has been closed");
}

const LOADING_OVERLAY_MONITOR = () => {
  window.__loadingOverlayHistory = [];

  function isVisible(element) {
    if (!element || element.hidden) return false;
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }

  function sample(reason) {
    const overlay = document.getElementById("video-loading-overlay");
    const title = document.getElementById("video-loading-title");
    const meta = document.getElementById("video-loading-meta");
    const entry = {
      reason,
      visible: isVisible(overlay),
      loadingReason: overlay ? String(overlay.getAttribute("data-loading-reason") || "") : "",
      title: title ? String(title.textContent || "").trim() : "",
      meta: meta ? String(meta.textContent || "").trim() : "",
    };
    const history = window.__loadingOverlayHistory;
    const previous = history.length ? history[history.length - 1] : null;
    if (
      !previous
      || previous.visible !== entry.visible
      || previous.loadingReason !== entry.loadingReason
      || previous.title !== entry.title
      || previous.meta !== entry.meta
    ) {
      history.push(entry);
    }
  }

  function start() {
    const overlay = document.getElementById("video-loading-overlay");
    const title = document.getElementById("video-loading-title");
    const meta = document.getElementById("video-loading-meta");
    sample("init");
    const observer = new MutationObserver(() => sample("mutation"));
    [overlay, title, meta].forEach((node) => {
      if (!node) return;
      observer.observe(node, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
};

let server = null;

test.use({ baseURL });

test.beforeAll(async () => {
  test.setTimeout(90000);
  server = await startIntegrationServer();
});

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    window.localStorage.removeItem("dropbox-browser-video-audio-track-preferences");
    window.localStorage.removeItem("dropbox-browser-video-subtitle-track-preferences");
  });
  await page.addInitScript(LOADING_OVERLAY_MONITOR);
});

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test.afterAll(async () => {
  await stopIntegrationServer(server);
  server = null;
});

async function installHlsStub(page, {
  fragmentCount = 2,
  playlistFragmentCount = null,
  simulateMissingOnSeek = false,
} = {}) {
  await page.addInitScript((options) => {
    window.__HLS_STUB_FRAGMENT_COUNT = options.fragmentCount;
    window.__HLS_STUB_PLAYLIST_FRAGMENT_COUNT = options.playlistFragmentCount ?? options.fragmentCount;
    window.__HLS_STUB_SIMULATE_MISSING_ON_SEEK = options.simulateMissingOnSeek;
  }, {
    fragmentCount,
    playlistFragmentCount: playlistFragmentCount ?? fragmentCount,
    simulateMissingOnSeek,
  });
  await page.route("**/assets/js/vendor/hls.js", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/javascript",
      body: hlsStubSource,
    });
  });
}

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

function waitForSessionPost(page, predicate) {
  return page.waitForRequest((request) => {
    if (!request.url().includes("/video/endpoints/session") || request.method() !== "POST") {
      return false;
    }
    const body = request.postData() || "";
    return predicate(body);
  }, { timeout: 15000 });
}

async function openVideoPane(page) {
  await page.goto("/?path=Videos");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await page.locator("#bottom-pane-mode").selectOption("video-player");
  await expect(page.locator("#video-player-pane")).toBeVisible();
  await expect
    .poll(async () => page.locator("#video-library-list .video-library-row").count(), { timeout: 15000 })
    .toBeGreaterThanOrEqual(5);
  await waitForCompatibilityReady(page);
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

async function waitForLoadingOverlayVisible(page) {
  await expect
    .poll(async () => {
      return page.evaluate(() => {
        function isVisible(element) {
          if (!element || element.hidden) return false;
          const style = window.getComputedStyle(element);
          return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
        }
        return isVisible(document.getElementById("video-loading-overlay"));
      });
    }, { timeout: 10000 })
    .toBe(true);
}

async function waitForLoadingOverlayHidden(page) {
  await expect
    .poll(async () => {
      return page.evaluate(() => {
        const overlay = document.getElementById("video-loading-overlay");
        if (!overlay) return true;
        if (overlay.hidden) return true;
        const style = window.getComputedStyle(overlay);
        return style.display === "none" || style.visibility === "hidden" || style.opacity === "0";
      });
    }, { timeout: 30000 })
    .toBe(true);
}

async function readOverlayHistory(page) {
  return page.evaluate(() => window.__loadingOverlayHistory || []);
}

async function readPlaybackState(page) {
  return page.evaluate(() => {
    const video = document.getElementById("video-player-media");
    if (!video) return null;
    return {
      paused: Boolean(video.paused),
      currentTime: Number(video.currentTime || 0),
      readyState: Number(video.readyState || 0),
    };
  });
}

async function readProgressCoverageState(page) {
  return page.evaluate(() => {
    const slider = document.getElementById("video-progress-slider");
    const style = slider ? window.getComputedStyle(slider) : null;
    return {
      mediaStart: style ? String(style.getPropertyValue("--video-progress-media-start") || "").trim() : "",
      mediaEnd: style ? String(style.getPropertyValue("--video-progress-media-end") || "").trim() : "",
      subtitleStart: style ? String(style.getPropertyValue("--video-progress-subtitle-start") || "").trim() : "",
      subtitleEnd: style ? String(style.getPropertyValue("--video-progress-subtitle-end") || "").trim() : "",
      processedStart: style ? String(style.getPropertyValue("--video-progress-processed-start") || "").trim() : "",
      processedEnd: style ? String(style.getPropertyValue("--video-progress-processed-end") || "").trim() : "",
      subtitleCoverageState: slider ? String(slider.getAttribute("data-subtitle-coverage-state") || "") : "",
      title: slider ? String(slider.getAttribute("title") || "") : "",
    };
  });
}

async function readPlayToggleState(page) {
  return page.evaluate(() => {
    const button = document.getElementById("video-play-toggle");
    if (!button) return null;
    const icon = button.querySelector(".video-control-icon");
    return {
      disabled: Boolean(button.disabled),
      label: String(button.getAttribute("aria-label") || ""),
      title: String(button.getAttribute("title") || ""),
      icon: icon ? String(icon.getAttribute("src") || "") : "",
    };
  });
}

async function expectPlayToggleState(page, expectedLabel) {
  const expectedIcon = expectedLabel === "Pause"
    ? "/assets/icons/material-icon-theme/video-pause.svg"
    : "/assets/icons/material-icon-theme/video-play.svg";
  await expect
    .poll(async () => readPlayToggleState(page), { timeout: 10000 })
    .toMatchObject({
      disabled: false,
      label: expectedLabel,
      title: expectedLabel,
      icon: expectedIcon,
    });
}

async function readSubtitleSelectorState(page) {
  return page.evaluate(() => {
    const select = document.getElementById("video-subtitle-track");
    return {
      value: select ? String(select.value || "") : "",
      options: select ? Array.from(select.options).map((option) => ({
        value: String(option.value || ""),
        text: String(option.textContent || "").trim(),
      })) : [],
    };
  });
}

async function waitForMountedSubtitleTrack(page, streamIndex) {
  await expect
    .poll(async () => {
      return page.evaluate((expectedStreamIndex) => {
        const video = document.getElementById("video-player-media");
        if (!video) return null;
        const trackNode = video.querySelector(
          `track[data-video-subtitle-stream-index="${expectedStreamIndex}"]`,
        );
        if (!trackNode) return null;
        const textTrack = trackNode.track;
        return {
          readyState: Number(trackNode.readyState),
          mode: textTrack ? String(textTrack.mode || "") : "",
          cueCount: textTrack && textTrack.cues ? textTrack.cues.length : 0,
        };
      }, streamIndex);
    }, { timeout: 30000 })
    .toMatchObject({
      readyState: 2,
      mode: "hidden",
      cueCount: expect.any(Number),
    });
}

test("compatibility playback waits for delayed subtitle extraction before starting", async ({ page }) => {
  test.setTimeout(90000);

  await installHlsStub(page);
  await openVideoPane(page);

  const alphaRow = await libraryRow(page, "alpha.mkv");
  const initialSession = waitForSessionPost(page, (body) => body.includes("path=Videos%2Falpha.mkv"));
  await alphaRow.dblclick();
  await initialSession;
  await waitForLoadingOverlayVisible(page);
  await expect
    .poll(async () => readSubtitleSelectorState(page), { timeout: 10000 })
    .toMatchObject({
      value: "3",
      options: expect.arrayContaining([
        expect.objectContaining({ value: "3" }),
      ]),
    });

  await expect
    .poll(async () => {
      const history = await readOverlayHistory(page);
      return history.some((entry) => {
        return entry.visible && (
          String(entry.loadingReason || "") === "subtitle-wait"
          || String(entry.title || "").includes("Waiting for subtitles")
          || String(entry.meta || "").includes("Waiting for subtitles")
        );
      });
    }, { timeout: 10000 })
    .toBe(true);
  const overlayHistory = await readOverlayHistory(page);
  expect(overlayHistory.some((entry) => entry.visible && entry.loadingReason === "subtitle-wait")).toBe(true);
  const duringWaitPlayback = await readPlaybackState(page);
  expect(duringWaitPlayback).toMatchObject({
    paused: true,
    currentTime: 0,
  });

  await waitForMountedSubtitleTrack(page, 3);
  await waitForLoadingOverlayHidden(page);
  await waitForVisibleVideo(page);
  await expectPlayToggleState(page, "Pause");
});

test("startup scrubber reflects full cached subtitle coverage after delayed extraction finishes", async ({ page }) => {
  test.setTimeout(90000);

  await page.route("**/video/endpoints/subtitles/window?**path=Videos%2Falpha.mkv**", async (route) => {
    let response;
    try {
      response = await route.fetch();
    } catch (error) {
      if (isClosedRouteError(error)) return;
      throw error;
    }
    const payload = await response.json();
    payload.loaded_ranges = [{ start_seconds: 0, end_seconds: 3 }];
    payload.window_end_seconds = 3;
    await route.fulfill({
      status: response.status(),
      headers: response.headers(),
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
  });

  await installHlsStub(page);
  await openVideoPane(page);
  const clearResponse = await page.request.post("/video/endpoints/cache/clear");
  expect(clearResponse.ok()).toBe(true);

  const initialSession = waitForSessionPost(page, (body) => body.includes("path=Videos%2Falpha.mkv"));
  await (await libraryRow(page, "alpha.mkv")).dblclick();
  await initialSession;
  await waitForMountedSubtitleTrack(page, 3);
  await waitForLoadingOverlayHidden(page);

  await expect
    .poll(async () => readProgressCoverageState(page), { timeout: 10000 })
    .toMatchObject({
      mediaStart: "0.000%",
      mediaEnd: "100.000%",
      subtitleStart: "0.000%",
      processedStart: "0.000%",
      subtitleCoverageState: "full",
    });

  const coverage = await readProgressCoverageState(page);
  expect(Number.parseFloat(coverage.subtitleEnd)).toBeCloseTo(Number.parseFloat(coverage.mediaEnd), 3);
  expect(Number.parseFloat(coverage.processedEnd)).toBeCloseTo(Number.parseFloat(coverage.mediaEnd), 3);
  expect(coverage.title).toContain("Loaded video:");
  expect(coverage.title).toContain("Subtitle-ready:");
});
