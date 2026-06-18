const { expect } = require("@playwright/test");

async function loadImageDataFromBase64Png(page, pngBase64) {
  return page.evaluate(async (b64) => {
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("failed to decode subtitle screenshot"));
      img.src = `data:image/png;base64,${b64}`;
    });

    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const imageData = context.getImageData(0, 0, image.width, image.height);
    return {
      width: image.width,
      height: image.height,
      data: Array.from(imageData.data),
    };
  }, pngBase64);
}

function clusterTextRows(textRows) {
  const bands = [];
  let bandStart = null;
  let bandEnd = null;

  for (const row of textRows) {
    if (bandStart === null) {
      bandStart = row;
      bandEnd = row;
      continue;
    }
    if (row - bandEnd <= 4) {
      bandEnd = row;
      continue;
    }
    bands.push({
      top: bandStart,
      bottom: bandEnd,
      center: (bandStart + bandEnd) / 2,
      height: bandEnd - bandStart + 1,
    });
    bandStart = row;
    bandEnd = row;
  }

  if (bandStart !== null) {
    bands.push({
      top: bandStart,
      bottom: bandEnd,
      center: (bandStart + bandEnd) / 2,
      height: bandEnd - bandStart + 1,
    });
  }

  return bands;
}

function analyzeSubtitleBandsFromImageData(imageData, {
  scanStartRatio = 0.42,
  scanEndRatio = 0.9,
  brightChannelThreshold = 200,
  minBrightPixelsPerRow = null,
} = {}) {
  const { width, height, data } = imageData;
  const scanStartY = Math.floor(height * scanStartRatio);
  const scanEndY = Math.floor(height * scanEndRatio);
  const rowThreshold = minBrightPixelsPerRow ?? Math.max(10, Math.floor(width * 0.008));
  const textRows = [];

  for (let y = scanStartY; y < scanEndY; y += 1) {
    let brightPixels = 0;
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const red = data[index];
      const green = data[index + 1];
      const blue = data[index + 2];
      if (red >= brightChannelThreshold && green >= brightChannelThreshold && blue >= brightChannelThreshold) {
        brightPixels += 1;
      }
    }
    if (brightPixels >= rowThreshold) {
      textRows.push(y);
    }
  }

  const bands = clusterTextRows(textRows);
  const gaps = [];
  for (let index = 1; index < bands.length; index += 1) {
    gaps.push(bands[index].top - bands[index - 1].bottom - 1);
  }

  const sortedGaps = [...gaps].sort((left, right) => left - right);
  const medianGap = sortedGaps.length
    ? sortedGaps[Math.floor(sortedGaps.length / 2)]
    : 0;

  return {
    width,
    height,
    bandCount: bands.length,
    bands,
    gaps,
    minGap: gaps.length ? Math.min(...gaps) : 0,
    maxGap: gaps.length ? Math.max(...gaps) : 0,
    medianGap,
    textRowCount: textRows.length,
  };
}

async function captureStageImageData(page) {
  const pngBuffer = await page.locator("#video-playback-stage").screenshot({
    type: "png",
    animations: "disabled",
  });
  return loadImageDataFromBase64Png(page, pngBuffer.toString("base64"));
}

async function captureVideoImageData(page) {
  const pngBuffer = await page.locator("#video-player-media").screenshot({
    type: "png",
    animations: "disabled",
  });
  return loadImageDataFromBase64Png(page, pngBuffer.toString("base64"));
}

function pickRicherSubtitleLayout(stageLayout, videoLayout) {
  if (videoLayout.bandCount > stageLayout.bandCount) {
    return { source: "video", ...videoLayout };
  }
  if (stageLayout.bandCount > videoLayout.bandCount) {
    return { source: "stage", ...stageLayout };
  }
  if (videoLayout.medianGap > stageLayout.medianGap) {
    return { source: "video", ...videoLayout };
  }
  return { source: "stage", ...stageLayout };
}

async function analyzeSubtitleLayout(page, options = {}) {
  const scanOptions = {
    scanEndRatio: 0.95,
    ...options,
  };

  await page.evaluate(() => {
    const overlay = document.getElementById("video-controls-overlay");
    if (!overlay) return;
    overlay.hidden = true;
    overlay.classList.add("is-hidden");
  });

  const stageLayout = analyzeSubtitleBandsFromImageData(
    await captureStageImageData(page),
    scanOptions,
  );
  const videoLayout = analyzeSubtitleBandsFromImageData(
    await captureVideoImageData(page),
    scanOptions,
  );
  return pickRicherSubtitleLayout(stageLayout, videoLayout);
}

function medianGapForBands(bands) {
  const gaps = [];
  for (let index = 1; index < bands.length; index += 1) {
    gaps.push(bands[index].top - bands[index - 1].bottom - 1);
  }
  if (!gaps.length) return 0;
  const sorted = [...gaps].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

async function readActiveCueLineCenters(page) {
  return page.evaluate(() => {
    const video = document.getElementById("video-player-media");
    if (!video || !video.textTracks) {
      return { lineCenters: [], cueText: "", lineCount: 0 };
    }

    let cueText = "";
    for (let index = 0; index < video.textTracks.length; index += 1) {
      const track = video.textTracks[index];
      if (!track || (track.mode !== "showing" && track.mode !== "hidden") || !track.activeCues || !track.activeCues.length) {
        continue;
      }
      cueText = String(track.activeCues[0].text || "");
      break;
    }

    const lines = cueText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) {
      return { lineCenters: [], cueText, lineCount: 0 };
    }

    if (!video.shadowRoot) {
      return { lineCenters: [], cueText, lineCount: lines.length };
    }

    const nodes = Array.from(video.shadowRoot.querySelectorAll("*"))
      .map((node) => {
        const text = String(node.textContent || "").trim();
        const rect = node.getBoundingClientRect();
        return {
          text,
          top: rect.top,
          bottom: rect.bottom,
          height: rect.height,
          width: rect.width,
        };
      })
      .filter((node) => node.text && node.width > 0 && node.height > 0);

    const lineCenters = [];
    for (const line of lines) {
      const match = nodes.find((node) => node.text.includes(line));
      if (match) {
        lineCenters.push((match.top + match.bottom) / 2);
      }
    }

    return {
      lineCenters,
      cueText,
      lineCount: lines.length,
      nodes,
    };
  });
}

async function readSubtitleLayoutMetrics(page, options = {}) {
  const screenshotLayout = await analyzeSubtitleLayout(page, options);
  const cueLayout = await readActiveCueLineCenters(page);
  const cueGaps = [];
  for (let index = 1; index < cueLayout.lineCenters.length; index += 1) {
    cueGaps.push(Math.abs(cueLayout.lineCenters[index] - cueLayout.lineCenters[index - 1]));
  }

  return {
    screenshot: screenshotLayout,
    cue: {
      ...cueLayout,
      gaps: cueGaps,
      medianGap: cueGaps.length
        ? [...cueGaps].sort((left, right) => left - right)[Math.floor(cueGaps.length / 2)]
        : 0,
    },
  };
}

function expectStackedSubtitleLayout(layout, label) {
  expect(layout.bandCount, `${label} band count`).toBeGreaterThanOrEqual(3);
  expect(layout.medianGap, `${label} median gap`).toBeGreaterThan(2);
  expect(layout.medianGap, `${label} median gap`).toBeLessThan(48);
}

function expectConsistentStackedSubtitleLayout(embeddedLayout, fullscreenLayout) {
  expectStackedSubtitleLayout(embeddedLayout, "embedded");
  expectStackedSubtitleLayout(fullscreenLayout, "fullscreen");

  const gapDelta = Math.abs(fullscreenLayout.medianGap - embeddedLayout.medianGap);
  expect(
    gapDelta,
    "fullscreen and embedded subtitle line spacing should match closely",
  ).toBeLessThanOrEqual(10);

  if (embeddedLayout.medianGap > 0) {
    const spacingRatio = fullscreenLayout.medianGap / embeddedLayout.medianGap;
    expect(
      spacingRatio,
      "fullscreen subtitle spacing should not diverge from embedded mode",
    ).toBeGreaterThan(0.65);
    expect(spacingRatio).toBeLessThan(1.45);
  }
}

module.exports = {
  analyzeSubtitleBandsFromImageData,
  analyzeSubtitleLayout,
  captureStageImageData,
  captureVideoImageData,
  expectConsistentStackedSubtitleLayout,
  expectStackedSubtitleLayout,
  medianGapForBands,
  readActiveCueLineCenters,
  readSubtitleLayoutMetrics,
};