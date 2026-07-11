const path = require("path");
const { test, expect } = require("@playwright/test");

const workerPortOffset = Number(process.env.TEST_WORKER_INDEX || "0") * 100;
process.env.PLAYWRIGHT_PORT = String(8020 + workerPortOffset);
process.env.DROPBOX_BROWSER_E2E_FIXTURE = path.join(
  __dirname,
  "fixtures",
  "video_player_generated_fixture.py",
);

const { startIntegrationServer, stopIntegrationServer } = require("./support/integration_server");

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

async function openVideoPane(page) {
  await page.goto("/?path=Videos");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await page.locator("#bottom-pane-mode").selectOption("video-player");
  await expect(page.locator("#video-player-pane")).toBeVisible();
  await waitForCompatibilityReady(page);
}

async function playLibraryFile(page, filename) {
  const row = page
    .locator("#video-library-list .video-library-row")
    .filter({ has: page.locator(".video-row-title", { hasText: filename }) })
    .first();
  await expect(row).toBeVisible();
  await row.dblclick();
  await expect
    .poll(async () => {
      const activeTitle = await page
        .locator("#video-queue-list .video-queue-row.is-active .video-row-title")
        .first()
        .textContent();
      return String(activeTitle || "").trim();
    }, { timeout: 15000 })
    .toBe(filename);
  await waitForDecodedVideo(page);
}

async function revealControls(page) {
  await page.locator("#video-playback-surface").hover({ position: { x: 40, y: 40 } });
  await expect
    .poll(async () => {
      return page.evaluate(() => {
        const overlay = document.getElementById("video-controls-overlay");
        if (!overlay) return null;
        const style = window.getComputedStyle(overlay);
        return {
          hidden: Boolean(overlay.hidden),
          display: style.display,
        };
      });
    }, { timeout: 10000 })
    .toMatchObject({
      hidden: false,
      display: "flex",
    });
}

test.use({
  baseURL,
  viewport: { width: 560, height: 420 },
});

test.beforeAll(async () => {
  test.setTimeout(120000);
  server = await startIntegrationServer();
});

test.afterAll(async () => {
  await stopIntegrationServer(server);
  server = null;
});

test("playback pane keeps a usable embedded stage and scrolls vertically at small sizes", async ({ page }) => {
  await openVideoPane(page);
  await setBottomPaneHeight(page, 260);
  await playLibraryFile(page, "multiline.mkv");

  await expect
    .poll(async () => {
      return page.evaluate(() => {
        const pane = document.getElementById("video-playback-pane");
        const stage = document.getElementById("video-playback-stage");
        if (!pane || !stage) return null;
        const stageRect = stage.getBoundingClientRect();
        return {
          paneClientHeight: pane.clientHeight,
          paneScrollHeight: pane.scrollHeight,
          paneClientWidth: pane.clientWidth,
          paneScrollWidth: pane.scrollWidth,
          stageWidth: stageRect.width,
          stageHeight: stageRect.height,
          stageAspectRatio: stageRect.width / Math.max(stageRect.height, 1),
        };
      });
    }, { timeout: 15000 })
    .toMatchObject({
      paneClientHeight: expect.any(Number),
      paneScrollHeight: expect.any(Number),
      paneClientWidth: expect.any(Number),
      paneScrollWidth: expect.any(Number),
      stageWidth: expect.any(Number),
      stageHeight: expect.any(Number),
      stageAspectRatio: expect.any(Number),
    });

  const initialMetrics = await page.evaluate(() => {
    const pane = document.getElementById("video-playback-pane");
    const stage = document.getElementById("video-playback-stage");
    const trackPanel = document.getElementById("video-track-panel");
    const trackSummary = document.querySelector("#video-track-panel > summary");
    const debugSummary = document.querySelector("#video-debug-panel > summary");
    const paneRect = pane.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const trackRect = trackSummary.getBoundingClientRect();
    const debugRect = debugSummary.getBoundingClientRect();
    return {
      paneClientHeight: pane.clientHeight,
      paneScrollHeight: pane.scrollHeight,
      paneClientWidth: pane.clientWidth,
      paneScrollWidth: pane.scrollWidth,
      stageWidth: stageRect.width,
      stageHeight: stageRect.height,
      stageAspectRatio: stageRect.width / Math.max(stageRect.height, 1),
      trackPanelOpen: Boolean(trackPanel.open),
      trackSummaryAboveViewport: trackRect.top >= paneRect.bottom,
      debugSummaryAboveViewport: debugRect.top >= paneRect.bottom,
    };
  });

  expect(initialMetrics.stageWidth).toBeGreaterThan(0);
  expect(initialMetrics.stageHeight).toBeGreaterThanOrEqual(180);
  expect(initialMetrics.stageAspectRatio).toBeGreaterThan(1.2);
  expect(initialMetrics.stageAspectRatio).toBeLessThan(2.1);
  expect(initialMetrics.paneScrollHeight).toBeGreaterThan(initialMetrics.paneClientHeight);
  expect(initialMetrics.paneScrollWidth).toBeLessThanOrEqual(initialMetrics.paneClientWidth + 1);
  expect(initialMetrics.trackPanelOpen).toBe(false);
  expect(initialMetrics.trackSummaryAboveViewport).toBe(true);
  expect(initialMetrics.debugSummaryAboveViewport).toBe(true);

  const trackMetrics = await page.evaluate(() => {
    const pane = document.getElementById("video-playback-pane");
    const trackSummary = document.querySelector("#video-track-panel > summary");
    const audioSummary = document.getElementById("video-audio-track-summary");
    const subtitleSummary = document.getElementById("video-subtitle-track-summary");
    const paneRect = pane.getBoundingClientRect();
    pane.scrollTop = trackSummary.offsetTop;
    const summaryRect = trackSummary.getBoundingClientRect();
    const audioRect = audioSummary.getBoundingClientRect();
    const subtitleRect = subtitleSummary.getBoundingClientRect();
    const audioStyle = window.getComputedStyle(audioSummary);
    const subtitleStyle = window.getComputedStyle(subtitleSummary);
    const audioItem = audioSummary.closest(".video-track-summary-item");
    const subtitleItem = subtitleSummary.closest(".video-track-summary-item");
    const audioLabel = audioItem ? audioItem.querySelector(".video-track-summary-label") : null;
    const subtitleLabel = subtitleItem ? subtitleItem.querySelector(".video-track-summary-label") : null;
    const audioItemRect = audioItem ? audioItem.getBoundingClientRect() : null;
    const subtitleItemRect = subtitleItem ? subtitleItem.getBoundingClientRect() : null;
    const audioLabelRect = audioLabel ? audioLabel.getBoundingClientRect() : null;
    const subtitleLabelRect = subtitleLabel ? subtitleLabel.getBoundingClientRect() : null;
    return {
      paneScrollTop: pane.scrollTop,
      summaryTop: summaryRect.top,
      summaryBottom: summaryRect.bottom,
      paneTop: paneRect.top,
      paneBottom: paneRect.bottom,
      audioText: String(audioSummary.textContent || "").trim(),
      audioTitle: String(audioSummary.getAttribute("title") || "").trim(),
      subtitleText: String(subtitleSummary.textContent || "").trim(),
      subtitleTitle: String(subtitleSummary.getAttribute("title") || "").trim(),
      audioInside: audioRect.left >= summaryRect.left && audioRect.right <= summaryRect.right + 1,
      subtitleInside: subtitleRect.left >= summaryRect.left && subtitleRect.right <= summaryRect.right + 1,
      audioOverflowing: audioSummary.scrollWidth > audioSummary.clientWidth,
      subtitleOverflowing: subtitleSummary.scrollWidth > subtitleSummary.clientWidth,
      audioTextOverflow: audioStyle.textOverflow,
      subtitleTextOverflow: subtitleStyle.textOverflow,
      audioWhiteSpace: audioStyle.whiteSpace,
      subtitleWhiteSpace: subtitleStyle.whiteSpace,
      summaryHorizontalOverflow: trackSummary.scrollWidth > trackSummary.clientWidth,
      audioLabelBelowValueOverlap: audioLabelRect ? audioLabelRect.bottom > audioRect.top : false,
      subtitleLabelBelowValueOverlap: subtitleLabelRect ? subtitleLabelRect.bottom > subtitleRect.top : false,
      audioItemInside: audioItemRect ? audioItemRect.right <= summaryRect.right + 1 : false,
      subtitleItemInside: subtitleItemRect ? subtitleItemRect.right <= summaryRect.right + 1 : false,
    };
  });

  expect(trackMetrics.paneScrollTop).toBeGreaterThan(0);
  expect(trackMetrics.summaryTop).toBeGreaterThanOrEqual(trackMetrics.paneTop);
  expect(trackMetrics.summaryBottom).toBeLessThanOrEqual(trackMetrics.paneBottom + 1);
  expect(trackMetrics.audioText).not.toBe("");
  expect(trackMetrics.audioTitle).toBe(trackMetrics.audioText);
  expect(trackMetrics.subtitleText).not.toBe("");
  expect(trackMetrics.subtitleTitle).toBe(trackMetrics.subtitleText);
  expect(trackMetrics.audioInside).toBe(true);
  expect(trackMetrics.subtitleInside).toBe(true);
  expect(trackMetrics.audioItemInside).toBe(true);
  expect(trackMetrics.subtitleItemInside).toBe(true);
  expect(trackMetrics.audioLabelBelowValueOverlap).toBe(false);
  expect(trackMetrics.subtitleLabelBelowValueOverlap).toBe(false);
  expect(trackMetrics.summaryHorizontalOverflow).toBe(false);
  if (trackMetrics.audioOverflowing) {
    expect(trackMetrics.audioTextOverflow).toBe("ellipsis");
    expect(trackMetrics.audioWhiteSpace).toBe("nowrap");
  }
  if (trackMetrics.subtitleOverflowing) {
    expect(trackMetrics.subtitleTextOverflow).toBe("ellipsis");
    expect(trackMetrics.subtitleWhiteSpace).toBe("nowrap");
  }

  const scrolledMetrics = await page.evaluate(() => {
    const pane = document.getElementById("video-playback-pane");
    const debugSummary = document.querySelector("#video-debug-panel > summary");
    pane.scrollTop = pane.scrollHeight;
    const paneRect = pane.getBoundingClientRect();
    const debugRect = debugSummary.getBoundingClientRect();
    return {
      paneScrollTop: pane.scrollTop,
      debugText: String(debugSummary.textContent || "").trim(),
      debugTop: debugRect.top,
      debugBottom: debugRect.bottom,
      paneTop: paneRect.top,
      paneBottom: paneRect.bottom,
    };
  });

  expect(scrolledMetrics.paneScrollTop).toBeGreaterThan(0);
  expect(scrolledMetrics.debugText).toBe("Debug Info");
  expect(scrolledMetrics.debugTop).toBeGreaterThanOrEqual(scrolledMetrics.paneTop);
  expect(scrolledMetrics.debugBottom).toBeLessThanOrEqual(scrolledMetrics.paneBottom + 1);

  await revealControls(page);

  const controlsMetrics = await page.evaluate(() => {
    function rectFor(id) {
      const element = document.getElementById(id);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        width: rect.width,
        height: rect.height,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
      };
    }

    function verticallyOverlap(a, b) {
      return a && b && a.top < b.bottom && b.top < a.bottom;
    }

    function horizontallyOverlap(a, b) {
      return a && b && a.left < b.right && b.left < a.right;
    }

    const pane = document.getElementById("video-playback-pane");
    const overlay = document.getElementById("video-controls-overlay");
    const bar = overlay ? overlay.querySelector(".video-controls-bar") : null;
    const paneRect = pane.getBoundingClientRect();
    const overlayRect = overlay.getBoundingClientRect();
    const barRect = bar.getBoundingClientRect();
    const controlOrder = [
      "video-play-toggle",
      "video-back-15",
      "video-forward-15",
      "video-mute-toggle",
      "video-loop-toggle",
      "video-previous",
      "video-next",
      "video-full-window-toggle",
      "video-fullscreen-toggle",
    ];
    const rects = Object.fromEntries(controlOrder.map((id) => [id, rectFor(id)]));
    const overlappingPairs = [];
    for (let index = 0; index < controlOrder.length; index += 1) {
      for (let nextIndex = index + 1; nextIndex < controlOrder.length; nextIndex += 1) {
        const left = rects[controlOrder[index]];
        const right = rects[controlOrder[nextIndex]];
        if (verticallyOverlap(left, right) && horizontallyOverlap(left, right)) {
          overlappingPairs.push([controlOrder[index], controlOrder[nextIndex]]);
        }
      }
    }
    return {
      paneClientWidth: pane.clientWidth,
      paneScrollWidth: pane.scrollWidth,
      controlOrder,
      rects,
      overlappingPairs,
      overlayHorizontallyInsidePane:
        overlayRect.left >= paneRect.left
        && overlayRect.right <= paneRect.right + 1,
      barInsideOverlay:
        barRect.left >= overlayRect.left
        && barRect.right <= overlayRect.right + 1
        && barRect.bottom <= overlayRect.bottom + 1,
      playBeforeBack15: rects["video-play-toggle"].right <= rects["video-back-15"].left + 1
        || rects["video-play-toggle"].bottom <= rects["video-back-15"].top + 1,
      loopBeforePrevious: rects["video-loop-toggle"].right <= rects["video-previous"].left + 1
        || rects["video-loop-toggle"].bottom <= rects["video-previous"].top + 1,
      previousBeforeNext: rects["video-previous"].right <= rects["video-next"].left + 1
        || rects["video-previous"].bottom <= rects["video-next"].top + 1,
      back15BeforeForward15: rects["video-back-15"].right <= rects["video-forward-15"].left + 1
        || rects["video-back-15"].bottom <= rects["video-forward-15"].top + 1,
      forward15BeforeMute: rects["video-forward-15"].right <= rects["video-mute-toggle"].left + 1
        || rects["video-forward-15"].bottom <= rects["video-mute-toggle"].top + 1,
      nextBeforeFullWindow: rects["video-next"].right <= rects["video-full-window-toggle"].left + 1
        || rects["video-next"].bottom <= rects["video-full-window-toggle"].top + 1,
      forward15BeforeFullWindow: rects["video-forward-15"].right <= rects["video-full-window-toggle"].left + 1
        || rects["video-forward-15"].bottom <= rects["video-full-window-toggle"].top + 1,
      fullWindowBeforeFullscreen: rects["video-full-window-toggle"].right <= rects["video-fullscreen-toggle"].left + 1
        || rects["video-full-window-toggle"].bottom <= rects["video-fullscreen-toggle"].top + 1,
    };
  });

  expect(controlsMetrics.paneScrollWidth).toBeLessThanOrEqual(controlsMetrics.paneClientWidth + 1);
  expect(controlsMetrics.overlayHorizontallyInsidePane).toBe(true);
  expect(controlsMetrics.barInsideOverlay).toBe(true);
  expect(controlsMetrics.overlappingPairs).toEqual([]);
  expect(controlsMetrics.playBeforeBack15).toBe(true);
  expect(controlsMetrics.loopBeforePrevious).toBe(true);
  expect(controlsMetrics.previousBeforeNext).toBe(true);
  expect(controlsMetrics.back15BeforeForward15).toBe(true);
  expect(controlsMetrics.forward15BeforeMute).toBe(true);
  expect(controlsMetrics.nextBeforeFullWindow).toBe(true);
  expect(controlsMetrics.forward15BeforeFullWindow).toBe(true);
  expect(controlsMetrics.fullWindowBeforeFullscreen).toBe(true);
  for (const id of controlsMetrics.controlOrder) {
    expect(controlsMetrics.rects[id].width).toBeGreaterThan(0);
    expect(controlsMetrics.rects[id].height).toBeGreaterThan(0);
  }
});
