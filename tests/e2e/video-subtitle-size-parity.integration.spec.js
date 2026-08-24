const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { test, expect } = require("@playwright/test");

const workerPortOffset = Number(process.env.DROPBOX_BROWSER_E2E_LANE_INDEX || "0") * 100;
process.env.PLAYWRIGHT_PORT = String(8019 + workerPortOffset);
process.env.DROPBOX_BROWSER_E2E_FIXTURE = path.join(
  __dirname,
  "fixtures",
  "video_player_generated_fixture.py",
);

const { startIntegrationServer, stopIntegrationServer } = require("./support/integration_server");
const { playLibraryFile } = require("./support/video_library");
const baseURL = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT}`;

const DEBUG_LOG = path.join(__dirname, "..", "..", ".dropbox-browser-temp", "size-parity-debug.log");
const METRICS_FILE = path.join(__dirname, "..", "..", ".dropbox-browser-temp", "size-parity-metrics.json");

let server = null;

test.describe.configure({ mode: "serial", timeout: 180000 });

function mark(t0, label) {
  fs.appendFileSync(DEBUG_LOG, `${label} +${Date.now() - t0}ms\n`, "utf8");
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

async function captureInCue(page, t0, label) {
  // While playing, catch the video inside the first cue (0.4s-2.0s) and
  // screenshot immediately - no pausing (pausing this real-HLS page closes
  // it in CI browsers).
  await expect
    .poll(async () => page.evaluate(() => {
      const video = document.getElementById("video-player-media");
      if (!video) return false;
      if (video.paused && !video.ended) video.play().catch(() => {});
      return video.readyState >= 2 && !video.paused
        && video.currentTime > 0.9 && video.currentTime < 1.4;
    }), { timeout: 45000, intervals: [50] })
    .toBe(true);
}

// Minimal PNG decoder for Chromium screenshots (8-bit RGB/RGBA,
// non-interlaced; covers everything Playwright emits).
function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error("not a png");
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(`unsupported png format (depth=${bitDepth} color=${colorType})`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);
  let pointer = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pointer];
    pointer += 1;
    const line = raw.subarray(pointer, pointer + stride);
    pointer += stride;
    const current = Buffer.alloc(stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? current[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += Math.floor((left + up) / 2);
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value += (pa <= pb && pa <= pc) ? left : (pb <= pc ? up : upLeft);
      }
      current[x] = value & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const srcIndex = x * channels;
      const dstIndex = (y * width + x) * 4;
      out[dstIndex] = current[srcIndex];
      out[dstIndex + 1] = current[srcIndex + 1];
      out[dstIndex + 2] = current[srcIndex + 2];
      out[dstIndex + 3] = channels === 4 ? current[srcIndex + 3] : 255;
    }
    previous = current;
  }
  return { width, height, data: out };
}

// Tallest contiguous band of near-white pixels above the controls region;
// returns its height as a fraction of the captured image height.
function measureTextFraction(png) {
  // Measure only the subtitle zone: skip the top 40% (scene) and the
  // bottom ~22% where the white scrubber/transport controls would
  // pollute the text-band measurement.
  const minY = Math.floor(png.height * 0.60);
  const maxY = Math.floor(png.height * 0.91);
  const rows = [];
  for (let y = minY; y < maxY; y += 1) {
    let whiteCount = 0;
    for (let x = 0; x < png.width; x += 1) {
      const i = (y * png.width + x) * 4;
      if (png.data[i] > 225 && png.data[i + 1] > 225 && png.data[i + 2] > 225) {
        whiteCount += 1;
      }
    }
    if (whiteCount > png.width * 0.05) rows.push(y);
  }
  if (!rows.length) return { fraction: 0, rows: 0 };
  let bestStart = rows[0];
  let bestEnd = rows[0];
  let curStart = rows[0];
  let curEnd = rows[0];
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index] - rows[index - 1] <= 3) {
      curEnd = rows[index];
    } else {
      if (curEnd - curStart > bestEnd - bestStart) {
        bestStart = curStart;
        bestEnd = curEnd;
      }
      curStart = rows[index];
      curEnd = rows[index];
    }
  }
  if (curEnd - curStart > bestEnd - bestStart) {
    bestStart = curStart;
    bestEnd = curEnd;
  }
  const bandRows = bestEnd - bestStart + 1;
  return { fraction: bandRows / png.height, rows: bandRows };
}

// Measure burned-in text height directly from the live video frames:
// draw the current frame to a canvas and find the white glyph band in the
// lower third. Returns the band height as a fraction of frame height.
async function measureBurnInFrameFraction(page) {
  return page.evaluate(async () => {
    const video = document.getElementById("video-player-media");
    if (!video || !video.videoWidth) return { fraction: 0, rows: 0, width: 0 };
    const w = video.videoWidth;
    const h = video.videoHeight;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx2d = canvas.getContext("2d", { willReadFrequently: true });
    let best = { fraction: 0, rows: 0, width: w };
    // The HLS frame can be one decode tick behind the media clock immediately
    // after a forced-burn-in restart. Sample the active cue for a short window
    // and retain the fullest glyph band instead of depending on one tick.
    for (let sample = 0; sample < 8; sample += 1) {
      if (video.currentTime < 0.4 || video.currentTime >= 2.0) break;
      ctx2d.drawImage(video, 0, 0, w, h);
      const data = ctx2d.getImageData(0, 0, w, h).data;
      // Subtitle zone: bottom third above libass bottom margin noise; scan
      // from 55% to 97% of frame height.
      const minY = Math.floor(h * 0.55);
      const maxY = Math.floor(h * 0.97);
      const rows = [];
      for (let y = minY; y < maxY; y += 1) {
        let whiteCount = 0;
        for (let x = 0; x < w; x += 1) {
          const i = (y * w + x) * 4;
          if (data[i] > 225 && data[i + 1] > 225 && data[i + 2] > 225) {
            whiteCount += 1;
          }
        }
        if (whiteCount > w * 0.05) rows.push(y);
      }
      if (rows.length) {
        let bestStart = rows[0];
        let bestEnd = rows[0];
        let curStart = rows[0];
        let curEnd = rows[0];
        for (let index = 1; index < rows.length; index += 1) {
          if (rows[index] - rows[index - 1] <= 4) {
            curEnd = rows[index];
          } else {
            if (curEnd - curStart > bestEnd - bestStart) {
              bestStart = curStart;
              bestEnd = curEnd;
            }
            curStart = rows[index];
            curEnd = rows[index];
          }
        }
        if (curEnd - curStart > bestEnd - bestStart) {
          bestStart = curStart;
          bestEnd = curEnd;
        }
        const bandRows = bestEnd - bestStart + 1;
        if (bandRows > best.rows) {
          best = { fraction: bandRows / h, rows: bandRows, width: w };
          window.__sizeParityFrameDataUrl = canvas.toDataURL("image/png");
        }
      }
      if (sample < 7) await new Promise((resolve) => setTimeout(resolve, 40));
    }
    return best;
  });
}

// The on-screen size the WebVTT overlay would have right now, as a fraction
// of the displayed video box height (glyph ink ≈ 0.72 em for this font).
async function expectedOverlayFraction(page) {
  return page.evaluate(() => {
    const el = document.getElementById("video-subtitle-overlay");
    const video = document.getElementById("video-player-media");
    if (!el || !video || !video.clientHeight) return 0;
    const computed = Number(parseFloat(window.getComputedStyle(el).fontSize));
    if (!Number.isFinite(computed) || computed <= 0) return 0;
    return (computed * 0.72) / video.clientHeight;
  });
}

test.use({ baseURL });

test.beforeAll(async () => {
  test.setTimeout(240000);
  server = await startIntegrationServer({ port: Number(process.env.PLAYWRIGHT_PORT) });
});

test.afterAll(async () => {
  await stopIntegrationServer(server);
  server = null;
});

test("forced burn-in subtitle size matches the WebVTT overlay size on screen", async ({ page }) => {
  test.setTimeout(240000);

  if (fs.existsSync(DEBUG_LOG)) fs.rmSync(DEBUG_LOG);
  const t0 = Date.now();
  mark(t0, "start");

  const clearResponse = await page.request.post("/video/endpoints/cache/clear");
  expect(clearResponse.ok()).toBe(true);

  // Real HLS playback (no stub): frames - and burned-in text - are genuine.
  await page.goto("/?path=Videos");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await page.locator("#bottom-pane-mode").selectOption("video-player");
  await expect(page.locator("#video-player-pane")).toBeVisible();
  await waitForCompatibilityReady(page);
  mark(t0, "ready");


  const sessionBodies = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    if (new URL(request.url()).pathname !== "/video/endpoints/session") return;
    sessionBodies.push(String(request.postData() || ""));
  });

  // --- Baseline: sidecar WebVTT overlay (burn-in off). ---
  await playLibraryFile(page, "bitmap.mkv");
  await waitForVisibleVideo(page);
  await expect(page.locator("#video-subtitle-track")).toHaveValue("3");
  mark(t0, "playing-overlay");
  await captureInCue(page, t0, "overlay");
  const overlayFraction = await expectedOverlayFraction(page);
  expect(overlayFraction).toBeGreaterThan(0.01);

  // --- Forced burn-in at the same style size. ---
  const panel = page.locator("#video-track-panel");
  if (!(await panel.evaluate((el) => el.open))) {
    await panel.locator("summary").click();
  }
  await page.locator("#video-subtitle-force-burnin").check();
  const forcedRestart = page.waitForRequest((request) => {
    if (request.method() !== "POST") return false;
    if (new URL(request.url()).pathname !== "/video/endpoints/session") return false;
    const body = String(request.postData() || "");
    return body.includes("path=Videos%2Fbitmap.mkv") && body.includes("force_subtitle_burn_in=1");
  }, { timeout: 15000 });
  await page.locator("#video-subtitle-style-apply").click();
  await forcedRestart;
  await waitForVisibleVideo(page);
  mark(t0, "restarted-burnin");
  await captureInCue(page, t0, "burnin");
  const burninMetric = await measureBurnInFrameFraction(page);
  try {
    const dataUrl = await page.evaluate(() => window.__sizeParityFrameDataUrl || null);
    if (dataUrl) {
      require("fs").writeFileSync(
        path.join(__dirname, "..", "..", ".dropbox-browser-temp", "size-parity-frame.png"),
        Buffer.from(String(dataUrl).split(",")[1], "base64"),
      );
    }
  } catch (_dumpError) {}
  expect(burninMetric.fraction).toBeGreaterThan(0.01);

  // The client must report the displayed video box height so the server can
  // convert CSS pixels into libass frame units.
  const forcedBody = sessionBodies.find((body) => body.includes("force_subtitle_burn_in=1")) || "";
  expect(forcedBody).toContain("subtitle_display_height_px=");

  // Size parity: burned-in text fraction of frame height must match the
  // overlay's within tolerance for antialiasing/stroke edges.
  // Browser and libass font rasterizers differ slightly across OSes; this
  // lower bound intentionally matches the styled-font parity check below.
  const ratio = burninMetric.fraction / overlayFraction;
  fs.writeFileSync(METRICS_FILE, JSON.stringify({
    overlayExpectedFraction: overlayFraction,
    burninMeasured: burninMetric,
    ratio,
  }), "utf8");
  expect(ratio, `burnin=${JSON.stringify(burninMetric)} overlayExpected=${overlayFraction}`)
    .toBeGreaterThan(0.75);
  expect(ratio).toBeLessThan(1.25);
});


test("styled-font ASS burn-in matches overlay size (sanitizer strips font markup)", async ({ page }) => {
  test.setTimeout(240000);

  const clearResponse = await page.request.post("/video/endpoints/cache/clear");
  expect(clearResponse.ok()).toBe(true);

  await page.goto("/?path=Videos");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await page.locator("#bottom-pane-mode").selectOption("video-player");
  await expect(page.locator("#video-player-pane")).toBeVisible();
  await waitForCompatibilityReady(page);
  const t0 = Date.now();
  mark(t0, "ready-styled");

  const sessionBodies = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    if (new URL(request.url()).pathname !== "/video/endpoints/session") return;
    sessionBodies.push(String(request.postData() || ""));
  });

  // Enable force burn-in before playing so the styled ASS track burns in.
  const panel = page.locator("#video-track-panel");
  await panel.waitFor({ state: "visible", timeout: 10000 });
  if (!(await panel.evaluate((el) => el.open))) {
    await panel.locator("summary").click();
  }
  await page.locator("#video-subtitle-force-burnin").check();
  await page.locator("#video-subtitle-style-apply").click();

  // Play with force burn-in on; the styled ASS track converts to SRT with
  // <font size="48"> tags that must be sanitized away.
  await playLibraryFile(page, "styled-font.mkv");
  await waitForVisibleVideo(page);
  mark(t0, "playing-styled");
  await captureInCue(page, t0, "styled-burnin");

  // The client must report the displayed video box height.
  const forcedBody = sessionBodies.find((body) => (
    body.includes("path=Videos%2Fstyled-font.mkv") && body.includes("force_subtitle_burn_in=1")
  )) || "";
  expect(forcedBody).toContain("subtitle_display_height_px=");

  const burninMetric = await measureBurnInFrameFraction(page);
  mark(t0, `burnin styled measured ${JSON.stringify(burninMetric)}`);
  try {
    const dataUrl = await page.evaluate(() => window.__sizeParityFrameDataUrl || null);
    if (dataUrl) {
      require("fs").writeFileSync(
        path.join(__dirname, "..", "..", ".dropbox-browser-temp", "size-parity-styled-frame.png"),
        Buffer.from(String(dataUrl).split(",")[1], "base64"),
      );
    }
  } catch (_dumpError) {}
  expect(burninMetric.fraction).toBeGreaterThan(0.01);

  const overlayFraction = await expectedOverlayFraction(page);
  mark(t0, `overlay expected ${overlayFraction.toFixed(4)}`);

  // Without the sanitizer the baked size="48" makes burned text ~16.7% of
  // frame height vs the overlay's ~4.5% - a ratio near 3.7. With it the
  // sizes match within font-metric tolerance.
  const ratio = burninMetric.fraction / overlayFraction;
  fs.writeFileSync(METRICS_FILE + ".styled", JSON.stringify({
    overlayExpectedFraction: overlayFraction,
    burninMeasured: burninMetric,
    ratio,
  }), "utf8");
  expect(ratio, `burnin=${JSON.stringify(burninMetric)} overlayExpected=${overlayFraction}`)
    .toBeGreaterThan(0.75);
  expect(ratio).toBeLessThan(1.33);
});


test("subtitle background box toggle applies to both WebVTT overlay and forced burn-in", async ({ page }) => {
  test.setTimeout(240000);

  const clearResponse = await page.request.post("/video/endpoints/cache/clear");
  expect(clearResponse.ok()).toBe(true);

  await page.goto("/?path=Videos");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await page.locator("#bottom-pane-mode").selectOption("video-player");
  await expect(page.locator("#video-player-pane")).toBeVisible();
  await waitForCompatibilityReady(page);

  // Known starting state: background off, force burn-in off.
  const panel = page.locator("#video-track-panel");
  await panel.waitFor({ state: "visible", timeout: 10000 });
  if (!(await panel.evaluate((el) => el.open))) {
    await panel.locator("summary").click();
  }
  const bgSwitch = page.locator("#video-subtitle-background-enabled");
  const forceSwitch = page.locator("#video-subtitle-force-burnin");
  let needsApply = false;
  if (await bgSwitch.isChecked()) { await bgSwitch.uncheck(); needsApply = true; }
  if (await forceSwitch.isChecked()) { await forceSwitch.uncheck(); needsApply = true; }
  if (needsApply) await page.locator("#video-subtitle-style-apply").click();

  // Default: background box unchecked.
  await expect(bgSwitch).not.toBeChecked();

  // --- WebVTT overlay mode ---
  await playLibraryFile(page, "styled-font-box.mkv");
  await waitForVisibleVideo(page);
  // Persisted track preferences may have subtitles off; select the ASS track.
  await expect(page.locator("#video-subtitle-track")).toBeEnabled({ timeout: 15000 });
  if (String(await page.locator("#video-subtitle-track").inputValue()) !== "3") {
    await page.locator("#video-subtitle-track").selectOption("3");
  }
  await expect
    .poll(async () => page.evaluate(() => {
      const video = document.getElementById("video-player-media");
      if (!video) return false;
      if (video.paused && !video.ended) video.play().catch(() => {});
      return !video.paused && video.currentTime > 0.2;
    }), { timeout: 30000 })
    .toBe(true);

  const overlayBgBefore = await page.evaluate(() => (
    getComputedStyle(document.getElementById("video-subtitle-overlay")).backgroundColor
  ));
  expect(overlayBgBefore).toBe("rgba(0, 0, 0, 0)");

  // Toggle the box on: preview updates immediately, no restart needed.
  await bgSwitch.check();
  await page.locator("#video-subtitle-style-apply").click();
  await expect
    .poll(async () => page.evaluate(() => (
      getComputedStyle(document.getElementById("video-subtitle-overlay")).backgroundColor
    )), { timeout: 10000 })
    .toBe("rgba(0, 0, 0, 0.75)");

  // --- Forced burn-in mode with the box enabled ---
  const forcedRestartWithBox = page.waitForRequest((request) => {
    if (request.method() !== "POST") return false;
    if (new URL(request.url()).pathname !== "/video/endpoints/session") return false;
    const body = String(request.postData() || "");
    return (
      body.includes("path=Videos%2Fstyled-font-box.mkv")
      && body.includes("force_subtitle_burn_in=1")
      && body.includes("subtitle_background_enabled=1")
    );
  }, { timeout: 15000 });
  await forceSwitch.check();
  await page.locator("#video-subtitle-style-apply").click();
  await forcedRestartWithBox;
  await waitForVisibleVideo(page);
  await captureInCue(page, null, "bg-on-burnin");

  async function countBoxRows(page) {
    // Detect the opaque background box as a WIDE CONTIGUOUS black run in the
    // subtitle zone (the fixture renders a bright scene, so box-on shows a
    // long black bar; box-off leaves only thin outline/shadow strokes).
    return page.evaluate(() => {
      const video = document.getElementById("video-player-media");
      const w = video.videoWidth;
      const h = video.videoHeight;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx2d = canvas.getContext("2d", { willReadFrequently: true });
      ctx2d.drawImage(video, 0, 0, w, h);
      const data = ctx2d.getImageData(0, 0, w, h).data;
      const minY = Math.floor(h * 0.55);
      const maxY = Math.floor(h * 0.97);
      let bestRunPx = 0;
      let bandRows = 0;
      for (let y = minY; y < maxY; y += 1) {
        let run = 0;
        let bestInRow = 0;
        for (let x = 0; x < w; x += 1) {
          const i = (y * w + x) * 4;
          if (data[i] < 45 && data[i + 1] < 45 && data[i + 2] < 45) {
            run += 1;
            if (run > bestInRow) bestInRow = run;
          } else {
            run = 0;
          }
        }
        if (bestInRow > w * 0.1) bandRows += 1;
        if (bestInRow > bestRunPx) bestRunPx = bestInRow;
      }
      return { widestBlackRunPx: bestRunPx, widthFraction: bestRunPx / w, bandRows };
    });
  }

  const boxOn = await countBoxRows(page);
  expect(boxOn.widthFraction).toBeGreaterThan(0.35);

  // --- Toggle the box off: restart carries subtitle_background_enabled=0 ---
  if (!(await panel.evaluate((el) => el.open))) {
    await panel.locator("summary").click();
  }
  const restartNoBox = page.waitForRequest((request) => {
    if (request.method() !== "POST") return false;
    if (new URL(request.url()).pathname !== "/video/endpoints/session") return false;
    const body = String(request.postData() || "");
    return (
      body.includes("path=Videos%2Fstyled-font-box.mkv")
      && body.includes("force_subtitle_burn_in=1")
      && body.includes("subtitle_background_enabled=0")
    );
  }, { timeout: 15000 });
  await bgSwitch.uncheck();
  await page.locator("#video-subtitle-style-apply").click();
  await restartNoBox;
  await waitForVisibleVideo(page);
  await captureInCue(page, null, "bg-off-burnin");
  const boxOff = await countBoxRows(page);
  try {
    const dataUrl = await page.evaluate(() => window.__sizeParityFrameDataUrl || null);
    if (dataUrl) {
      require("fs").writeFileSync(
        path.join(__dirname, "..", "..", ".dropbox-browser-temp", "size-parity-bgoff-frame.png"),
        Buffer.from(String(dataUrl).split(",")[1], "base64"),
      );
    }
  } catch (_dumpError) {}
  expect(boxOff.widthFraction).toBeLessThan(0.25);

  // Persisted across reload.
  await page.reload();
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await ensurePanelOpenForBackgroundCheck(page);
  await expect(bgSwitch).not.toBeChecked();
});

async function ensurePanelOpenForBackgroundCheck(page) {
  const panel = page.locator("#video-track-panel");
  await panel.waitFor({ state: "visible", timeout: 10000 });
  if (!(await panel.evaluate((el) => el.open))) {
    await panel.locator("summary").click();
  }
}
