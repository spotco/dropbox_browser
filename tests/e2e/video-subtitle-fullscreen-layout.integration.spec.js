const path = require("path");
const { test, expect } = require("@playwright/test");

const workerPortOffset = Number(process.env.TEST_WORKER_INDEX || "0") * 100;
process.env.PLAYWRIGHT_PORT = String(8019 + workerPortOffset);
process.env.DROPBOX_BROWSER_E2E_FIXTURE = path.join(
  __dirname,
  "fixtures",
  "video_player_generated_fixture.py",
);

const { startIntegrationServer, stopIntegrationServer } = require("./support/integration_server");
const {
  expectEmbeddedSmallerThanFullscreenSubtitleLayout,
  expectStackedSubtitleLayout,
  readSubtitleLayoutMetrics,
} = require("./support/subtitle_layout");
const { playLibraryFile: playLibraryFileBase } = require("./support/video_library");

const baseURL = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT}`;

let server = null;

test.describe.configure({ mode: "serial", timeout: 120000 });

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

async function setBottomPaneHeight(page, heightPx) {
  await page.evaluate((height) => {
    document.documentElement.style.setProperty("--log-panel-height", `${height}px`);
  }, heightPx);
}

async function waitForPlaybackStageUsable(page) {
  await expect
    .poll(async () => {
      return page.evaluate(() => {
        const stage = document.getElementById("video-playback-stage");
        if (!stage) return null;
        const rect = stage.getBoundingClientRect();
        return {
          width: rect.width,
          height: rect.height,
        };
      });
    }, { timeout: 15000 })
    .toMatchObject({
      width: expect.any(Number),
      height: expect.any(Number),
    });

  const size = await page.evaluate(() => {
    const stage = document.getElementById("video-playback-stage");
    const rect = stage.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
  expect(size.width).toBeGreaterThan(240);
  expect(size.height).toBeGreaterThanOrEqual(180);
}

async function waitForDecodedVideo(page) {
  await expect
    .poll(async () => {
      return page.evaluate(() => {
        const video = document.getElementById("video-player-media");
        if (!video || video.hidden) return null;
        if (video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) {
          return null;
        }
        return {
          readyState: video.readyState,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
        };
      });
    }, { timeout: 45000 })
    .toMatchObject({
      readyState: expect.any(Number),
      videoWidth: expect.any(Number),
      videoHeight: expect.any(Number),
    });
}

async function waitForMultilineCue(page) {
  // Require the on-stage overlay itself (not just debug panel / TextTrack cues).
  // Debug text can update before syncSubtitleOverlayDisplay clears the `hidden`
  // attribute; measuring then races and flakes with display:"none".
  await expect
    .poll(async () => {
      return page.evaluate(() => {
        const overlay = document.getElementById("video-subtitle-overlay");
        if (!overlay || overlay.hidden || overlay.classList.contains("hidden")) {
          return null;
        }
        const style = window.getComputedStyle(overlay);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
          return null;
        }
        const overlayText = String(overlay.textContent || "").replace(/\s+/g, " ").trim();
        if (!overlayText.includes("MULTI-LINE-ONE") || !overlayText.includes("MULTI-LINE-TWO")) {
          return null;
        }
        return {
          display: style.display,
          text: overlayText,
        };
      });
    }, { timeout: 20000 })
    .toMatchObject({
      display: expect.stringMatching(/^(block|flex|inline-block|inline|grid)$/),
      text: expect.stringContaining("MULTI-LINE-ONE"),
    });
}

async function seekToMultilineCue(page) {
  await page.evaluate(() => {
    const video = document.getElementById("video-player-media");
    if (!video) return;
    video.pause();
    // Assign once; wait for the real seeked path rather than faking events that
    // can run before currentTime has actually settled.
    if (Math.abs(Number(video.currentTime) - 0.5) > 0.05) {
      video.currentTime = 0.5;
    }
  });
  await expect
    .poll(async () => {
      return page.evaluate(() => {
        const video = document.getElementById("video-player-media");
        if (!video) return null;
        return {
          seeking: Boolean(video.seeking),
          currentTime: Number(video.currentTime) || 0,
        };
      });
    }, { timeout: 10000 })
    .toMatchObject({
      seeking: false,
      currentTime: expect.any(Number),
    });
  await expect
    .poll(async () => {
      return page.evaluate(() => {
        const video = document.getElementById("video-player-media");
        return video ? Math.abs(Number(video.currentTime) - 0.5) < 0.2 : false;
      });
    }, { timeout: 10000 })
    .toBe(true);

  // Kick overlay/debug sync if the browser already sat at ~0.5s (no seek event).
  await page.evaluate(() => {
    const video = document.getElementById("video-player-media");
    if (!video) return;
    video.dispatchEvent(new Event("timeupdate"));
  });
  await waitForMultilineCue(page);
  // Brief layout settle for font metrics / screenshot band clustering.
  await page.waitForTimeout(250);
}

async function enterStageFullscreen(page) {
  await page.evaluate(async () => {
    const stage = document.getElementById("video-playback-stage");
    if (!stage || typeof stage.requestFullscreen !== "function") {
      throw new Error("video playback stage cannot enter fullscreen");
    }
    await stage.requestFullscreen();
  });
  await expect
    .poll(async () => page.evaluate(() => document.fullscreenElement?.id || ""), { timeout: 10000 })
    .toBe("video-playback-stage");
  await page.waitForTimeout(600);
}

async function exitStageFullscreen(page) {
  await page.evaluate(async () => {
    if (document.fullscreenElement && typeof document.exitFullscreen === "function") {
      await document.exitFullscreen();
    }
  });
  await expect
    .poll(async () => page.evaluate(() => document.fullscreenElement === null), { timeout: 10000 })
    .toBe(true);
}

async function openVideoPane(page) {
  await page.goto("/?path=Videos");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await page.locator("#bottom-pane-mode").selectOption("video-player");
  await expect(page.locator("#video-player-pane")).toBeVisible();
  await waitForCompatibilityReady(page);
}

async function playLibraryFile(page, filename) {
  await playLibraryFileBase(page, filename);
  await expect
    .poll(async () => {
      return page.evaluate(() => {
        const video = document.getElementById("video-player-media");
        return Boolean(video && !video.hidden);
      });
    }, { timeout: 45000 })
    .toBe(true);
  await waitForDecodedVideo(page);
  await expect
    .poll(async () => {
      return page.evaluate(() => {
        const video = document.getElementById("video-player-media");
        if (!video) return null;
        const trackNode = video.querySelector('track[data-video-subtitle-stream-index="3"]');
        if (!trackNode) return null;
        const textTrack = trackNode.track;
        return {
          readyState: Number(trackNode.readyState),
          mode: textTrack ? String(textTrack.mode || "") : "",
          cueCount: textTrack && textTrack.cues ? textTrack.cues.length : 0,
        };
      });
    }, { timeout: 15000 })
    .toMatchObject({
      readyState: 2,
      mode: "hidden",
      cueCount: expect.any(Number),
    });
}

test.use({
  baseURL,
  viewport: { width: 1400, height: 900 },
});

test.beforeAll(async () => {
  test.setTimeout(120000);
  server = await startIntegrationServer();
});

test.afterAll(async () => {
  await stopIntegrationServer(server);
  server = null;
});

test("multiline WebVTT subtitles stay smaller in embedded mode and full size in fullscreen", async ({ page }) => {
  test.setTimeout(120000);

  await openVideoPane(page);
  await setBottomPaneHeight(page, 560);
  await playLibraryFile(page, "multiline.mkv");
  await waitForPlaybackStageUsable(page);
  await seekToMultilineCue(page);

  const subtitlesResponse = await page.request.get(
    "/video/endpoints/subtitles?path=Videos%2Fmultiline.mkv&source=remote&track=3",
  );
  expect(subtitlesResponse.ok()).toBe(true);
  expect(await subtitlesResponse.text()).toContain("MULTI-LINE-ONE\nMULTI-LINE-TWO");

  const embeddedMetrics = await readSubtitleLayoutMetrics(page);
  expectStackedSubtitleLayout(embeddedMetrics.screenshot, "embedded");

  await enterStageFullscreen(page);
  await seekToMultilineCue(page);
  const fullscreenMetrics = await readSubtitleLayoutMetrics(page);
  expectEmbeddedSmallerThanFullscreenSubtitleLayout(
    embeddedMetrics,
    fullscreenMetrics,
  );

  await exitStageFullscreen(page);
});
