const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");

process.env.PLAYWRIGHT_PORT = "8015";
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
  await sessionRequest;
  await waitForVisibleVideo(page);
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

  const bitmapRestart = waitForSessionPost(
    page,
    (body) => body.includes("path=Videos%2Fbitmap.mkv") && body.includes("subtitle_stream_index=5"),
  );
  await page.locator("#video-subtitle-track").selectOption("5");
  await bitmapRestart;
  await waitForVisibleVideo(page);
  await expect(page.locator("#video-subtitle-track")).toHaveValue("5");
  await expectNoMountedSubtitleTrack(page);

  await scrubTo(
    page,
    5,
    (body) => body.includes("path=Videos%2Fbitmap.mkv") && body.includes("subtitle_stream_index=5") && body.includes("start_time_seconds=5"),
  );
  await expect(page.locator("#video-subtitle-track")).toHaveValue("5");
  await expectNoMountedSubtitleTrack(page);

  await scrubTo(
    page,
    1,
    (body) => body.includes("path=Videos%2Fbitmap.mkv") && body.includes("subtitle_stream_index=5") && body.includes("start_time_seconds=1"),
  );
  await expect(page.locator("#video-subtitle-track")).toHaveValue("5");
  await expectNoMountedSubtitleTrack(page);

  const subtitleOffRestart = waitForSessionPost(
    page,
    (body) => body.includes("path=Videos%2Fbitmap.mkv") && !body.includes("subtitle_stream_index="),
  );
  await page.locator("#video-subtitle-track").selectOption("");
  await subtitleOffRestart;
  await waitForVisibleVideo(page);
  await expect(page.locator("#video-subtitle-track")).toHaveValue("");
  await expectNoMountedSubtitleTrack(page);

  await page.locator("#video-subtitle-track").selectOption("3");
  await expect(page.locator("#video-subtitle-track")).toHaveValue("3");

  const subtitleResponse = await page.request.get("/video/endpoints/subtitles?path=Videos%2Fbitmap.mkv&source=remote&track=3");
  expect(subtitleResponse.ok()).toBe(true);
  expect(await subtitleResponse.text()).toContain("BITMAP-TEXT-SUBTITLE");
});
