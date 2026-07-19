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
  await playLibraryFileBase(page, filename);
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

test("video pane restores its separate saved widths immediately on startup", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/?path=Videos");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await page.evaluate(() => {
    Settings.set("bottom-pane-mode", "video-player");
    Settings.set("video-media-library-pane-widths", [20, 50, 30]);
    Settings.set("music-pane-widths", [70, 20, 10]);
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await expect(page.locator("#video-player-pane")).toBeVisible();

  const startupLayout = await page.evaluate(() => {
    const shell = document.querySelector("#video-player-pane .video-player-shell");
    const columns = shell ? shell.style.gridTemplateColumns.trim().split(/\s+/) : [];
    return {
      music: Settings.get("music-pane-widths", null),
      video: Settings.get("video-media-library-pane-widths", null),
      widths: columns.length === 5
        ? [Number.parseFloat(columns[0]), Number.parseFloat(columns[2]), Number.parseFloat(columns[4])]
        : [],
    };
  });
  expect(startupLayout).toMatchObject({
    music: [70, 20, 10],
    video: [20, 50, 30],
  });
  expect(startupLayout.widths).toHaveLength(3);

  const layout = await page.evaluate(() => {
    const shell = document.querySelector("#video-player-pane .video-player-shell");
    const columns = shell ? shell.style.gridTemplateColumns.trim().split(/\s+/) : [];
    return columns.length === 5
      ? [Number.parseFloat(columns[0]), Number.parseFloat(columns[2]), Number.parseFloat(columns[4])]
      : [];
  });
  expect(layout).toHaveLength(3);
  const total = layout.reduce((sum, value) => sum + value, 0);
  expect(layout[0] / total).toBeCloseTo(0.2, 1);
  expect(layout[1] / total).toBeCloseTo(0.5, 1);
  expect(layout[2] / total).toBeCloseTo(0.3, 1);
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

test("full-window mode hides library/playlist and stretches stage across the viewport", async ({ page }) => {
  // Regression: media-library layout.js sets inline grid-template-columns on the
  // shell after pane drag; full-window CSS must still force a single-column
  // playback layout (inline styles otherwise keep a multi-column track list and
  // pin the stage to the first column — video stuck on the left).
  await page.setViewportSize({ width: 1280, height: 720 });
  await openVideoPane(page);
  await playLibraryFile(page, "multiline.mkv");

  // Simulate a prior pane resize (layout.js applyMusicPanePercents).
  await page.evaluate(() => {
    const shell = document.querySelector("#video-player-pane .video-player-shell");
    if (!shell) throw new Error("video player shell missing");
    shell.style.gridTemplateColumns = "280px 8px 280px 8px 400px";
  });

  await revealControls(page);

  const fullWindowButton = page.locator("#video-full-window-toggle");
  await expect(fullWindowButton).toBeEnabled({ timeout: 15000 });
  await fullWindowButton.click();

  const bottomPaneFullWindowButton = page.locator("#bottom-pane-full-window-toggle");
  await expect(page.locator("body")).toHaveClass(/bottom-panel-full-window-mode/);
  await expect(bottomPaneFullWindowButton).toBeDisabled();
  await expect(bottomPaneFullWindowButton).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#video-player-pane")).toHaveClass(/video-full-window/);
  await expect(page.locator("#video-library-pane")).toBeHidden();
  await expect(page.locator("#video-playlist-pane")).toBeHidden();

  await expect
    .poll(async () => {
      return page.evaluate(() => {
        const body = document.body;
        const pane = document.getElementById("video-player-pane");
        const shell = pane ? pane.querySelector(".video-player-shell") : null;
        const stage = document.getElementById("video-playback-stage");
        const library = document.getElementById("video-library-pane");
        const playlist = document.getElementById("video-playlist-pane");
        if (!body || !pane || !shell || !stage) return null;
        const shellStyle = window.getComputedStyle(shell);
        const stageRect = stage.getBoundingClientRect();
        const paneRect = pane.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        return {
          bodyFullWindow: body.classList.contains("bottom-panel-full-window-mode"),
          paneFullWindow: pane.classList.contains("video-full-window"),
          libraryDisplay: library ? window.getComputedStyle(library).display : "none",
          playlistDisplay: playlist ? window.getComputedStyle(playlist).display : "none",
          shellGridColumns: shellStyle.gridTemplateColumns,
          stageWidth: stageRect.width,
          stageHeight: stageRect.height,
          paneWidth: paneRect.width,
          viewportWidth,
          // Stage should occupy essentially the full pane/viewport width.
          stageWidthRatioOfViewport: stageRect.width / Math.max(viewportWidth, 1),
          stageWidthRatioOfPane: stageRect.width / Math.max(paneRect.width, 1),
        };
      });
    }, { timeout: 10000 })
    .toMatchObject({
      bodyFullWindow: true,
      paneFullWindow: true,
      libraryDisplay: "none",
      playlistDisplay: "none",
    });

  const metrics = await page.evaluate(() => {
    const stage = document.getElementById("video-playback-stage");
    const pane = document.getElementById("video-player-pane");
    const shell = pane ? pane.querySelector(".video-player-shell") : null;
    const stageRect = stage.getBoundingClientRect();
    const paneRect = pane.getBoundingClientRect();
    return {
      stageWidth: stageRect.width,
      stageHeight: stageRect.height,
      paneWidth: paneRect.width,
      viewportWidth: window.innerWidth,
      stageWidthRatioOfViewport: stageRect.width / Math.max(window.innerWidth, 1),
      stageWidthRatioOfPane: stageRect.width / Math.max(paneRect.width, 1),
      shellGridColumns: shell ? window.getComputedStyle(shell).gridTemplateColumns : "",
      shellInlineGrid: shell ? shell.style.gridTemplateColumns : "",
    };
  });

  // Without the fix, inline 5-column grid leaves stage ~playback column width
  // (~30–45% of viewport). Full-window must use nearly the full width.
  expect(metrics.stageWidthRatioOfViewport).toBeGreaterThan(0.85);
  expect(metrics.stageWidthRatioOfPane).toBeGreaterThan(0.95);
  expect(metrics.stageHeight).toBeGreaterThan(0);
  // Single track, not multi-column pixel list like "280px 8px 280px 8px 400px".
  expect(metrics.shellGridColumns.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(2);

  await fullWindowButton.click();
  await expect(page.locator("body")).not.toHaveClass(/bottom-panel-full-window-mode/);
  await expect(page.locator("#video-player-pane")).not.toHaveClass(/video-full-window/);
  await expect(page.locator("#video-library-pane")).toBeVisible();

  // The video layout toggle is independent of the bottom-pane shell state in
  // both directions. The shell toolbar remains explicitly controllable.
  await bottomPaneFullWindowButton.click();
  await expect(page.locator("body")).toHaveClass(/bottom-panel-full-window-mode/);
  await expect(bottomPaneFullWindowButton).toBeDisabled();
  await page.locator("#bottom-pane-minimize").click();
  await expect(page.locator("body")).not.toHaveClass(/bottom-panel-full-window-mode/);
});

test("video full-window expands a partial bottom pane and restores it on exit", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openVideoPane(page);

  const partialHeight = 260;
  await page.evaluate((height) => {
    const panelApi = window.DropboxBrowserLogPanel;
    if (!panelApi || typeof panelApi.applyHeight !== "function") {
      throw new Error("bottom panel API is unavailable");
    }
    panelApi.applyHeight(height);
  }, partialHeight);
  await playLibraryFile(page, "multiline.mkv");
  await revealControls(page);

  const videoFullWindowButton = page.locator("#video-full-window-toggle");
  const bottomPaneFullWindowButton = page.locator("#bottom-pane-full-window-toggle");
  await expect(page.locator("body")).not.toHaveClass(/bottom-panel-full-window-mode/);
  await expect
    .poll(async () => page.locator("#log-panel").evaluate((node) => Math.round(node.getBoundingClientRect().height)))
    .toBe(partialHeight);

  await videoFullWindowButton.click();
  await expect(page.locator("body")).toHaveClass(/bottom-panel-full-window-mode/);
  await expect(page.locator("#video-player-pane")).toHaveClass(/video-full-window/);
  await expect(bottomPaneFullWindowButton).toBeDisabled();

  await videoFullWindowButton.click();
  await expect(page.locator("body")).not.toHaveClass(/bottom-panel-full-window-mode/);
  await expect(page.locator("#video-player-pane")).not.toHaveClass(/video-full-window/);
  await expect(bottomPaneFullWindowButton).toBeEnabled();
  await expect
    .poll(async () => page.locator("#log-panel").evaluate((node) => Math.round(node.getBoundingClientRect().height)))
    .toBe(partialHeight);
});
