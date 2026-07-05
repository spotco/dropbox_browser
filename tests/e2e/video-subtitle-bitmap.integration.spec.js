const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");

const workerPortOffset = Number(process.env.TEST_WORKER_INDEX || "0") * 100;
process.env.PLAYWRIGHT_PORT = String(8015 + workerPortOffset);
process.env.DROPBOX_BROWSER_E2E_FIXTURE = path.join(
  __dirname,
  "fixtures",
  "video_player_generated_fixture.py",
);

const { startIntegrationServer, stopIntegrationServer } = require("./support/integration_server");
const baseURL = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT}`;

const hlsStubSource = fs.readFileSync(
  path.join(__dirname, "support", "hls-stub.js"),
  "utf8",
);

let server = null;

test.describe.configure({ mode: "serial", timeout: 90000 });

async function installHlsStub(page, { fragmentCount = 2 } = {}) {
  await page.addInitScript((count) => {
    window.__HLS_STUB_FRAGMENT_COUNT = count;
  }, fragmentCount);
  await page.route("**/assets/js/vendor/hls.js", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/javascript",
      body: hlsStubSource,
    });
  });
}

async function pausePlayback(page) {
  const toggle = page.locator("#video-play-toggle");
  const label = String(await toggle.textContent() || "").trim();
  if (label === "Pause") {
    await toggle.click();
    await expect(toggle).toHaveText("Play");
  }
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

async function waitForLoadingOverlayHidden(page) {
  await expect
    .poll(async () => {
      return page.evaluate(() => {
        const loading = document.getElementById("video-loading-overlay");
        if (!loading) return true;
        if (loading.hidden) return true;
        const style = window.getComputedStyle(loading);
        return style.display === "none" || style.visibility === "hidden" || style.opacity === "0";
      });
    }, { timeout: 15000 })
    .toBe(true);
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

async function ensureTrackPanelOpen(page) {
  const panel = page.locator("#video-track-panel");
  await expect(panel).toBeVisible();
  if (await panel.evaluate((element) => Boolean(element.open))) return;
  await panel.locator("summary").click();
  await expect
    .poll(async () => panel.evaluate((element) => Boolean(element.open)), { timeout: 5000 })
    .toBe(true);
}

async function selectTrackOption(page, selector, value) {
  await ensureTrackPanelOpen(page);
  await page.locator(selector).selectOption(value);
}

function waitForSessionPost(page, predicate) {
  return page.waitForRequest((request) => {
    if (request.method() !== "POST") {
      return false;
    }
    const pathname = new URL(request.url()).pathname;
    if (pathname !== "/video/endpoints/session") {
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
  await sessionRequest;
  await waitForVisibleVideo(page);
}

async function scrubInSession(page, targetSeconds) {
  await pausePlayback(page);
  let sessionPosted = false;
  const onRequest = (request) => {
    if (request.method() !== "POST") return;
    if (new URL(request.url()).pathname === "/video/endpoints/session") {
      sessionPosted = true;
    }
  };
  page.on("request", onRequest);
  try {
    await page.locator("#video-progress-slider").evaluate((element, seconds) => {
      element.value = String(seconds);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }, targetSeconds);
    await page.waitForTimeout(300);
    expect(sessionPosted).toBe(false);
  } finally {
    page.off("request", onRequest);
  }
  await waitForVisibleVideo(page);
}

async function scrubInSessionForward(page, advanceSeconds = 1) {
  await pausePlayback(page);
  const sliderValue = await page.evaluate(() => {
    const slider = document.getElementById("video-progress-slider");
    return slider ? Number(slider.value) : NaN;
  });
  expect(Number.isFinite(sliderValue)).toBe(true);
  const target = Math.min(7.5, sliderValue + advanceSeconds);
  await scrubInSession(page, target);
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

test("bitmap subtitle tracks restart compatibility playback instead of mounting a sidecar track", async ({ page }) => {
  test.setTimeout(60000);

  await installHlsStub(page);
  await page.goto("/?path=Videos");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await page.locator("#bottom-pane-mode").selectOption("video-player");
  await expect(page.locator("#video-player-pane")).toBeVisible();
  await waitForCompatibilityReady(page);

  const row = page
    .locator("#video-library-list .video-library-row")
    .filter({ has: page.locator(".video-row-title", { hasText: "bitmap.mkv" }) })
    .first();
  await expect(row).toBeVisible();

  const initialSession = waitForSessionPost(page, (body) => body.includes("path=Videos%2Fbitmap.mkv"));
  await row.dblclick();
  await initialSession;
  await waitForVisibleVideo(page);

  await expect(page.locator("#video-subtitle-track")).toBeEnabled();
  await expect(page.locator("#video-subtitle-track option")).toHaveCount(4);
  await expect(page.locator("#video-subtitle-track")).toHaveValue("3");
  await waitForSubtitleStreamIndex(page, 3);

  await ensureTrackPanelOpen(page);
  await page.locator("#video-subtitle-shadow-enabled").uncheck();
  await page.locator("#video-subtitle-stroke-enabled").uncheck();
  await page.locator("#video-subtitle-font-size").fill("34");
  await page.locator("#video-subtitle-offset").fill("-18");
  await expect
    .poll(async () => {
      return page.evaluate(() => ({
        strokeWidth: document.body.style.getPropertyValue("--video-subtitle-stroke-width").trim(),
        fontSize: document.body.style.getPropertyValue("--video-subtitle-font-size").trim(),
        offset: document.body.style.getPropertyValue("--video-subtitle-offset").trim(),
      }));
    }, { timeout: 5000 })
    .toEqual({
      strokeWidth: "0px",
      fontSize: "34px",
      offset: "-18px",
    });

  const bitmapRestartBeforeApply = waitForSessionPost(
    page,
    (body) => (
      body.includes("path=Videos%2Fbitmap.mkv")
      && body.includes("subtitle_stream_index=5")
      && body.includes("subtitle_stroke_enabled=1")
    ),
  );
  await selectTrackOption(page, "#video-subtitle-track", "5");
  await bitmapRestartBeforeApply;
  await waitForVisibleVideo(page);
  await expect(page.locator("#video-subtitle-track")).toHaveValue("5");
  await expectNoMountedSubtitleTrack(page);

  const bitmapRestartAfterApply = waitForSessionPost(
    page,
    (body) => body.includes("path=Videos%2Fbitmap.mkv"),
  );
  await page.locator("#video-subtitle-style-apply").click();
  const bitmapApplyRequest = await bitmapRestartAfterApply;
  expect(String(bitmapApplyRequest.postData() || "")).toContain("subtitle_stream_index=5");
  expect(String(bitmapApplyRequest.postData() || "")).toContain("subtitle_stroke_enabled=0");
  expect(String(bitmapApplyRequest.postData() || "")).toContain("subtitle_shadow_enabled=0");
  await waitForVisibleVideo(page);
  await expectNoMountedSubtitleTrack(page);

  let styleOnlyRestartPosted = false;
  const onStyleOnlyRestartRequest = (request) => {
    if (request.method() !== "POST") return;
    if (new URL(request.url()).pathname !== "/video/endpoints/session") return;
    const body = String(request.postData() || "");
    if (body.includes("path=Videos%2Fbitmap.mkv")) {
      styleOnlyRestartPosted = true;
    }
  };
  page.on("request", onStyleOnlyRestartRequest);
  try {
    await page.locator("#video-subtitle-font-size").fill("40");
    await page.locator("#video-subtitle-offset").fill("-24");
    await page.locator("#video-subtitle-style-apply").click();
    await page.waitForTimeout(300);
  } finally {
    page.off("request", onStyleOnlyRestartRequest);
  }
  expect(styleOnlyRestartPosted).toBe(false);

  await scrubInSessionForward(page, 2);
  await expect(page.locator("#video-subtitle-track")).toHaveValue("5");
  await expectNoMountedSubtitleTrack(page);

  await scrubInSessionForward(page, 1);
  await expect(page.locator("#video-subtitle-track")).toHaveValue("5");
  await expectNoMountedSubtitleTrack(page);

  const subtitleOffRestart = waitForSessionPost(
    page,
    (body) => body.includes("path=Videos%2Fbitmap.mkv") && !body.includes("subtitle_stream_index="),
  );
  await selectTrackOption(page, "#video-subtitle-track", "");
  await subtitleOffRestart;
  await waitForVisibleVideo(page);
  await expect(page.locator("#video-subtitle-track")).toHaveValue("");
  await expectNoMountedSubtitleTrack(page);

  await selectTrackOption(page, "#video-subtitle-track", "3");
  await expect(page.locator("#video-subtitle-track")).toHaveValue("3");

  const subtitleResponse = await page.request.get("/video/endpoints/subtitles?path=Videos%2Fbitmap.mkv&source=remote&track=3");
  expect(subtitleResponse.ok()).toBe(true);
  expect(await subtitleResponse.text()).toContain("BITMAP-TEXT-SUBTITLE");
});

test("changing from WebVTT to burned-in subtitles during seek restart replays the mode change and clears loading", async ({ page }) => {
  test.setTimeout(60000);

  const sessionPosts = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    if (new URL(request.url()).pathname !== "/video/endpoints/session") return;
    sessionPosts.push(String(request.postData() || ""));
  });

  await page.route("**/video/endpoints/session", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const body = String(route.request().postData() || "");
    if (!body.includes("path=Videos%2Fbitmap.mkv")) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const payload = await response.json();
    const startSeconds = Number(new URLSearchParams(body).get("start_time_seconds"));
    if (startSeconds === 0) {
      payload.encoded_media_end_seconds = 2;
    }
    if (startSeconds > 0 && !body.includes("subtitle_stream_index=5")) {
      await page.waitForTimeout(500);
    }
    await route.fulfill({
      status: response.status(),
      headers: response.headers(),
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
  });

  await installHlsStub(page, { fragmentCount: 4 });
  await page.goto("/?path=Videos");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await page.locator("#bottom-pane-mode").selectOption("video-player");
  await expect(page.locator("#video-player-pane")).toBeVisible();
  await waitForCompatibilityReady(page);

  const row = page
    .locator("#video-library-list .video-library-row")
    .filter({ has: page.locator(".video-row-title", { hasText: "bitmap.mkv" }) })
    .first();
  await expect(row).toBeVisible();

  const initialSession = waitForSessionPost(page, (body) => (
    body.includes("path=Videos%2Fbitmap.mkv")
    && body.includes("start_time_seconds=0")
  ));
  await row.dblclick();
  await initialSession;
  await waitForVisibleVideo(page);
  await waitForSubtitleStreamIndex(page, 3);

  await page.locator("#video-progress-slider").evaluate((element) => {
    element.value = "7";
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForTimeout(150);

  await selectTrackOption(page, "#video-subtitle-track", "5");
  await page.locator("#video-progress-slider").evaluate((element) => {
    element.value = "7.5";
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });

  await expect
    .poll(() => sessionPosts.some((body) => {
      if (!body.includes("path=Videos%2Fbitmap.mkv")) return false;
      if (!body.includes("subtitle_stream_index=5")) return false;
      const startSeconds = Number(new URLSearchParams(body).get("start_time_seconds"));
      return Number.isFinite(startSeconds) && startSeconds > 0;
    }), { timeout: 15000 })
    .toBe(true);

  await waitForLoadingOverlayHidden(page);
  await waitForVisibleVideo(page);
  await expect(page.locator("#video-subtitle-track")).toHaveValue("5");
  await expectNoMountedSubtitleTrack(page);
});
