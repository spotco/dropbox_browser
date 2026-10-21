const path = require("path");
const { test, expect } = require("@playwright/test");

const workerPortOffset = Number(process.env.DROPBOX_BROWSER_E2E_LANE_INDEX || "0") * 100;
process.env.PLAYWRIGHT_PORT = String(8018 + workerPortOffset);
process.env.DROPBOX_BROWSER_E2E_FIXTURE = path.join(
  __dirname,
  "fixtures",
  "video_player_generated_fixture.py",
);

const { startIntegrationServer, stopIntegrationServer } = require("./support/integration_server");
const { playLibraryFile } = require("./support/video_library");
const {
  ALL_MEDIA_SESSION_ACTIONS,
  installMediaSessionRecorder,
  invokeMediaSessionAction,
  mediaSessionState,
} = require("./support/media-session");

const baseURL = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT}`;
let server = null;

test.describe.configure({ mode: "serial", timeout: 120000 });
test.use({ baseURL, viewport: { width: 1280, height: 800 } });

test.beforeAll(async () => {
  test.setTimeout(120000);
  server = await startIntegrationServer();
});

test.afterAll(async () => {
  await stopIntegrationServer(server);
  server = null;
});

async function openVideoPane(page) {
  await page.goto("/?path=Videos");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await page.locator("#bottom-pane-mode").selectOption("video-player");
  await expect(page.locator("#video-player-pane")).toBeVisible();
  await expect
    .poll(async () => {
      const response = await page.request.get("/video/endpoints/status");
      if (!response.ok()) return null;
      return (await response.json()).compatibility_available === true;
    }, { timeout: 15000 })
    .toBe(true);
}

async function videoState(page) {
  return page.evaluate(() => {
    const video = document.getElementById("video-player-media");
    const slider = document.getElementById("video-progress-slider");
    return {
      paused: video.paused,
      readyState: video.readyState,
      videoWidth: video.videoWidth,
      progress: Number(slider.value),
    };
  });
}

test("video publishes the active item to the Media Session with a captured frame and routes seeks through restart", async ({ page }) => {
  const thumbnailRequests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/video/endpoints/thumbnail")) {
      thumbnailRequests.push(request.url());
    }
  });
  await installMediaSessionRecorder(page);
  await openVideoPane(page);

  await playLibraryFile(page, "seek-window.mkv");
  // Probe / "preparing HLS" states publish nothing; the claim comes with a loaded, playing element.
  await expect
    .poll(async () => (await mediaSessionState(page)).title, { timeout: 45000 })
    .toBe("seek-window.mkv");
  // The browse listing requests its own file thumbnails right after load
  // (long before the HLS session is playing); from here on the media session
  // must not add any (its artwork is a captured frame).
  thumbnailRequests.length = 0;
  let session = await mediaSessionState(page);
  expect(session.playbackState).toBe("playing");
  expect(session.artist).toBe("");
  expect((await videoState(page)).readyState).toBeGreaterThanOrEqual(1);

  // One frame from the playing element becomes the artwork (JPEG object URL).
  await expect.poll(async () => (await mediaSessionState(page)).artwork?.length || 0, { timeout: 15000 }).toBe(1);
  session = await mediaSessionState(page);
  expect(session.artwork[0].src).toMatch(/^blob:/);
  expect(session.artwork[0].type).toBe("image/jpeg");
  const artworkBytes = await page.evaluate(async (src) => (await (await fetch(src)).blob()).size, session.artwork[0].src);
  expect(artworkBytes).toBeGreaterThan(100);

  await expect.poll(async () => (await mediaSessionState(page)).handlers).toEqual(ALL_MEDIA_SESSION_ACTIONS);
  await expect.poll(async () => (await mediaSessionState(page)).position?.duration ?? 0).toBeCloseTo(24, 0);
  expect((await mediaSessionState(page)).position.playbackRate).toBe(1);

  // Pause from the OS card follows the transport's pause branch.
  expect(await invokeMediaSessionAction(page, "pause")).toBe(true);
  await expect.poll(async () => (await videoState(page)).paused).toBe(true);
  await expect.poll(async () => (await mediaSessionState(page)).playbackState).toBe("paused");
  await expect(page.locator("#video-play-toggle")).toHaveAttribute("aria-label", /Play/);

  // A forward step without seekOffset is 15 seconds through the compatibility
  // restart; the card shows the target right away instead of jumping back.
  const before = (await mediaSessionState(page)).position.position;
  expect(await invokeMediaSessionAction(page, "seekforward")).toBe(true);
  await expect
    .poll(async () => (await mediaSessionState(page)).position?.position ?? 0)
    .toBeGreaterThanOrEqual(Math.min(before + 15, 23) - 0.5);
  await expect.poll(async () => (await videoState(page)).progress, { timeout: 45000 }).toBeGreaterThanOrEqual(Math.min(before + 15, 23) - 1);

  // Scrub from the OS card: seekto restarts at the requested time.
  expect(await invokeMediaSessionAction(page, "seekto", { seekTime: 4 })).toBe(true);
  await expect.poll(async () => (await mediaSessionState(page)).position?.position ?? -1).toBeCloseTo(4, 0);
  await expect.poll(async () => (await videoState(page)).progress, { timeout: 45000 }).toBeLessThan(6);

  // Same artwork for the same item: captured once, not re-requested.
  session = await mediaSessionState(page);
  expect(session.artwork?.length).toBe(1);

  // Leaving the video pane stops the session and clears a video-owned card.
  await page.locator("#bottom-pane-mode").selectOption("music-player");
  await expect.poll(async () => (await mediaSessionState(page)).metadata).toBeNull();
  session = await mediaSessionState(page);
  expect(session.playbackState).toBe("none");
  expect(session.handlers).toEqual([]);

  expect(thumbnailRequests).toEqual([]);
});