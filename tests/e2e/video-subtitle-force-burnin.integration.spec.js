const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");

const workerPortOffset = Number(process.env.DROPBOX_BROWSER_E2E_LANE_INDEX || "0") * 100;
process.env.PLAYWRIGHT_PORT = String(8017 + workerPortOffset);
process.env.DROPBOX_BROWSER_E2E_FIXTURE = path.join(
  __dirname,
  "fixtures",
  "video_player_generated_fixture.py",
);

const { startIntegrationServer, stopIntegrationServer } = require("./support/integration_server");
const { libraryRow, loadVideoLibrary, playLibraryFile } = require("./support/video_library");
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
    }, { timeout: 30000 })
    .toBe(true);
}

async function waitForVisibleVideo(page) {
  await expect
    .poll(async () => {
      return page.evaluate(() => {
        const video = document.getElementById("video-player-media");
        return Boolean(video && !video.hidden);
      });
    }, { timeout: 30000 })
    .toBe(true);
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

test.use({ baseURL });

test.beforeAll(async () => {
  test.setTimeout(120000);
  server = await startIntegrationServer({ port: Number(process.env.PLAYWRIGHT_PORT) });
});

test.afterAll(async () => {
  await stopIntegrationServer(server);
  server = null;
});

test("force burn-in switch persists and routes text subtitle playback through burned-in sessions", async ({ page }) => {
  test.setTimeout(90000);

  const clearResponse = await page.request.post("/video/endpoints/cache/clear");
  expect(clearResponse.ok()).toBe(true);

  await installHlsStub(page);
  await page.goto("/?path=Videos");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await page.locator("#bottom-pane-mode").selectOption("video-player");
  await expect(page.locator("#video-player-pane")).toBeVisible();
  await waitForCompatibilityReady(page);

  // The switch exists in the Subtitle Style section and defaults to off.
  await ensureTrackPanelOpen(page);
  const forceSwitch = page.locator("#video-subtitle-force-burnin");
  await expect(forceSwitch).toBeVisible();
  await expect(forceSwitch).not.toBeChecked();

  // With the switch off, a WebVTT-capable track mounts as a sidecar overlay.
  const initialSession = waitForSessionPost(
    page,
    (body) => body.includes("path=Videos%2Fbitmap.mkv") && !body.includes("subtitle_stream_index="),
  );
  const row = await libraryRow(page, "bitmap.mkv");
  await row.dblclick();
  await initialSession;
  await waitForVisibleVideo(page);
  await expect(page.locator("#video-subtitle-track")).toHaveValue("3");
  await expect
    .poll(async () => page.evaluate(() => {
      const video = document.getElementById("video-player-media");
      return video ? video.querySelectorAll("track[data-video-subtitle-track]").length : 0;
    }), { timeout: 15000 })
    .toBe(1);

  // Enable force burn-in and apply; the next restart carries the burn-in fields.
  await forceSwitch.check();
  const forcedRestart = waitForSessionPost(
    page,
    (body) => (
      body.includes("path=Videos%2Fbitmap.mkv")
      && body.includes("subtitle_stream_index=3")
      && body.includes("force_subtitle_burn_in=1")
      && body.includes("subtitle_font_size_px=")
      && body.includes("subtitle_offset_px=")
    ),
  );
  await page.locator("#video-subtitle-style-apply").click();
  await forcedRestart;
  await waitForVisibleVideo(page);

  // No sidecar track is mounted while burn-in is forced.
  await expect
    .poll(async () => page.evaluate(() => {
      const video = document.getElementById("video-player-media");
      return video ? video.querySelectorAll("track[data-video-subtitle-track]").length : -1;
    }), { timeout: 15000 })
    .toBe(0);

  // The applied state survives a reload (persisted settings).
  await page.goto("/?path=Videos");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await page.locator("#bottom-pane-mode").selectOption("video-player");
  await expect(page.locator("#video-player-pane")).toBeVisible();
  await ensureTrackPanelOpen(page);
  await expect(page.locator("#video-subtitle-force-burnin")).toBeChecked();

  // Playing again after reload still uses forced burn-in from the setting.
  const reloadedForcedSession = waitForSessionPost(
    page,
    (body) => (
      body.includes("path=Videos%2Fbitmap.mkv")
      && body.includes("subtitle_stream_index=3")
      && body.includes("force_subtitle_burn_in=1")
    ),
  );
  await playLibraryFile(page, "bitmap.mkv");
  await reloadedForcedSession;
  await waitForVisibleVideo(page);

  // Turning the switch back off returns to sidecar behavior on the next apply.
  await ensureTrackPanelOpen(page);
  const sessionBodies = [];
  const onSessionRequest = (request) => {
    if (request.method() !== "POST") return;
    if (new URL(request.url()).pathname !== "/video/endpoints/session") return;
    sessionBodies.push(String(request.postData() || ""));
  };
  page.on("request", onSessionRequest);
  try {
    await page.locator("#video-subtitle-force-burnin").uncheck();
    await page.locator("#video-subtitle-style-apply").click();
    await expect
      .poll(async () => sessionBodies.some((body) => (
        body.includes("path=Videos%2Fbitmap.mkv")
        && !body.includes("force_subtitle_burn_in=1")
      )), { timeout: 15000 })
      .toBe(true);
  } finally {
    page.off("request", onSessionRequest);
  }
});
