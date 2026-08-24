const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");

const workerPortOffset = Number(process.env.DROPBOX_BROWSER_E2E_LANE_INDEX || "0") * 100;
process.env.PLAYWRIGHT_PORT = String(8030 + workerPortOffset);
process.env.DROPBOX_BROWSER_E2E_FIXTURE = path.join(
  __dirname,
  "fixtures",
  "video_player_generated_fixture.py",
);

const { startIntegrationServer, stopIntegrationServer } = require("./support/integration_server");
const { libraryRow, loadVideoLibrary } = require("./support/video_library");
const baseURL = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT}`;
const hlsStubSource = fs.readFileSync(
  path.join(__dirname, "support", "hls-stub.js"),
  "utf8",
);

test.describe.configure({ mode: "serial", timeout: 120000 });
test.use({ baseURL });

let server = null;

async function waitForCompatibilityReady(page) {
  await expect
    .poll(async () => {
      const response = await page.request.get("/video/endpoints/status");
      if (!response.ok()) return null;
      const payload = await response.json();
      return payload.compatibility_available === true;
    }, { timeout: 15000 })
    .toBe(true);
}

async function installDelayedHlsStub(page) {
  await page.addInitScript(() => {
    window.__HLS_STUB_MANIFEST_LOAD_DELAY_MS = 1500;
  });
  await page.route("**/assets/js/vendor/hls.js", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/javascript",
      body: hlsStubSource,
    });
  });
}

async function hideProbeDuration(page) {
  await page.route("**/video/endpoints/probe?*", async (route) => {
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const payload = await response.json();
    payload.duration_seconds = 0;
    await route.fulfill({
      status: response.status(),
      headers: response.headers(),
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
  });
}

async function openVideoPane(page) {
  await page.goto("/?path=Videos");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await page.locator("#bottom-pane-mode").selectOption("video-player");
  await expect(page.locator("#video-player-pane")).toBeVisible();
  await loadVideoLibrary(page);
  await waitForCompatibilityReady(page);
}

async function waitForVideoDuringInitialLoad(page) {
  await expect
    .poll(async () => page.evaluate(() => {
      const video = document.getElementById("video-player-media");
      const overlay = document.getElementById("video-loading-overlay");
      if (!video || !overlay) return null;
      const style = window.getComputedStyle(overlay);
      const overlayVisible = !overlay.hidden
        && style.display !== "none"
        && style.visibility !== "hidden"
        && style.opacity !== "0";
      return {
        videoVisible: !video.hidden,
        loading: overlayVisible,
        durationKnown: Number.isFinite(Number(video.duration)) && Number(video.duration) > 0,
      };
    }), { timeout: 30000 })
    .toMatchObject({ videoVisible: true, loading: true, durationKnown: false });
}

async function readInitialLoadControls(page) {
  return page.evaluate(() => {
    const video = document.getElementById("video-player-media");
    const overlay = document.getElementById("video-loading-overlay");
    const slider = document.getElementById("video-progress-slider");
    const buttonState = (id) => {
      const element = document.getElementById(id);
      return element ? Boolean(element.disabled) : null;
    };
    return {
      videoVisible: Boolean(video && !video.hidden),
      loading: Boolean(overlay && !overlay.hidden),
      duration: video ? Number(video.duration) : Number.NaN,
      playDisabled: buttonState("video-play-toggle"),
      muteDisabled: buttonState("video-mute-toggle"),
      volumeDisabled: buttonState("video-volume-slider"),
      fullWindowDisabled: buttonState("video-full-window-toggle"),
      progressDisabled: Boolean(slider && slider.disabled),
      progressMax: slider ? String(slider.max) : "",
      progressValue: slider ? String(slider.value) : "",
    };
  });
}

async function readProgressState(page) {
  return page.evaluate(() => {
    const video = document.getElementById("video-player-media");
    const slider = document.getElementById("video-progress-slider");
    return {
      duration: video ? Number(video.duration) : Number.NaN,
      currentTime: video ? Number(video.currentTime) : Number.NaN,
      sliderDisabled: Boolean(slider && slider.disabled),
      sliderMax: slider ? Number(slider.max) : Number.NaN,
      sliderValue: slider ? Number(slider.value) : Number.NaN,
    };
  });
}

async function stopActiveSessions(page) {
  const statusResponse = await page.request.get("/video/endpoints/status");
  if (!statusResponse.ok()) return;
  const payload = await statusResponse.json();
  const sessions = Array.isArray(payload.active_sessions) ? payload.active_sessions : [];
  for (const session of sessions) {
    if (!session || !session.session_id) continue;
    const response = await page.request.post("/video/endpoints/session/stop", {
      data: { id: String(session.session_id) },
    });
    expect(response.ok()).toBe(true);
  }
}

test.beforeAll(async () => {
  test.setTimeout(120000);
  server = await startIntegrationServer();
});

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await stopActiveSessions(page);
});

test.afterAll(async () => {
  await stopIntegrationServer(server);
  server = null;
});

test("video controls remain usable before initial metadata and preserve percent scrubs", async ({ page }) => {
  await installDelayedHlsStub(page);
  await hideProbeDuration(page);
  const timingSummaries = [];
  page.on("request", (request) => {
    if (!request.url().endsWith("/client-log") || request.method() !== "POST") return;
    const params = new URLSearchParams(request.postData() || "");
    if (params.get("message") !== "Playback timing summary") return;
    let details = {};
    try {
      details = JSON.parse(params.get("details") || "{}");
    } catch (_error) {
      details = {};
    }
    timingSummaries.push(details);
  });

  await openVideoPane(page);
  const row = await libraryRow(page, "bravo.mkv");
  const sessionRequest = page.waitForRequest((request) => {
    return request.url().includes("/video/endpoints/session")
      && request.method() === "POST"
      && (request.postData() || "").includes("path=Videos%2Fbravo.mkv");
  }, { timeout: 30000 });
  await row.dblclick();
  await expect
    .poll(async () => page.evaluate(() => {
      const overlay = document.getElementById("video-loading-overlay");
      const meta = document.getElementById("video-loading-meta");
      return {
        visible: Boolean(overlay && !overlay.hidden),
        meta: meta ? String(meta.textContent || "").trim() : "",
      };
    }), { timeout: 10000 })
    .toMatchObject({
      visible: true,
      meta: "Inspecting video tracks and preparing compatibility playback.",
    });
  const inspectingState = await readInitialLoadControls(page);
  expect(inspectingState).toMatchObject({
    videoVisible: false,
    loading: true,
    progressDisabled: false,
    progressMax: "100",
  });
  const inspectingScrubPercent = 40;
  await page.locator("#video-progress-slider").evaluate((slider, percent) => {
    slider.value = String(percent);
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    slider.dispatchEvent(new Event("change", { bubbles: true }));
  }, inspectingScrubPercent);
  expect(await readInitialLoadControls(page)).toMatchObject({
    progressDisabled: false,
    progressMax: "100",
    progressValue: String(inspectingScrubPercent),
  });

  await sessionRequest;
  await waitForVideoDuringInitialLoad(page);

  const initialState = await readInitialLoadControls(page);
  expect(initialState).toMatchObject({
    videoVisible: true,
    loading: true,
    playDisabled: false,
    muteDisabled: false,
    volumeDisabled: false,
    fullWindowDisabled: false,
    progressDisabled: false,
    progressMax: "100",
  });
  expect(initialState.duration).toBeNaN();

  const scrubPercent = 40;
  await page.locator("#video-progress-slider").evaluate((slider, percent) => {
    slider.value = String(percent);
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    slider.dispatchEvent(new Event("change", { bubbles: true }));
  }, scrubPercent);
  const beforeMetadata = await readProgressState(page);
  expect(beforeMetadata).toMatchObject({
    sliderDisabled: false,
    sliderMax: 100,
    sliderValue: scrubPercent,
  });
  expect(beforeMetadata.duration).toBeNaN();

  await expect.poll(() => timingSummaries.length, { timeout: 30000 }).toBeGreaterThan(0);
  const initialTiming = timingSummaries[0];
  console.log("[video-initial-load]", JSON.stringify(initialTiming));
  expect(Number(initialTiming.total_to_playing_ms)).toBeGreaterThan(0);

  await expect
    .poll(async () => readProgressState(page), { timeout: 30000 })
    .toMatchObject({ sliderDisabled: false });
  const afterMetadata = await readProgressState(page);
  expect(afterMetadata.duration).toBeGreaterThan(0);
  expect(afterMetadata.sliderMax).toBeCloseTo(afterMetadata.duration, 5);
  expect(afterMetadata.sliderValue).toBeCloseTo(afterMetadata.duration * (scrubPercent / 100), 1);
  expect(afterMetadata.currentTime).toBeCloseTo(afterMetadata.duration * (scrubPercent / 100), 1);
});
