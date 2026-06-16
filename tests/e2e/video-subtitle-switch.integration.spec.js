const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");

process.env.PLAYWRIGHT_PORT = "8013";
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

const PLAYBACK_SURFACE_MONITOR = () => {
  window.__playbackSurfaceViolations = [];

  function isVisible(element) {
    if (!element || element.hidden) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function sampleState(reason) {
    const loading = document.getElementById("video-loading-overlay");
    const placeholder = document.getElementById("video-playback-placeholder");
    const video = document.getElementById("video-player-media");
    const state = {
      reason,
      loadingVisible: isVisible(loading),
      placeholderVisible: isVisible(placeholder),
      videoVisible: isVisible(video),
      loadingText: loading ? String(loading.textContent || "").trim() : "",
      placeholderText: placeholder ? String(placeholder.textContent || "").trim() : "",
    };
    if (
      (state.loadingVisible && state.placeholderVisible)
      || (state.videoVisible && state.placeholderVisible)
    ) {
      window.__playbackSurfaceViolations.push(state);
    }
  }

  function start() {
    sampleState("init");
    window.setInterval(() => sampleState("interval"), 16);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
};

async function installPlaybackSurfaceMonitor(page) {
  await page.addInitScript(PLAYBACK_SURFACE_MONITOR);
}

const TRACK_REMOVAL_INSTRUMENTATION = () => {
  window.__subtitleTeardownEvents = [];

  function collectNativeSubtitleHaystack(video) {
    const chunks = [];
    const stage = document.getElementById("video-playback-stage");
    const mediaTime = video ? Number(video.currentTime) : NaN;

    if (video && video.textTracks) {
      for (let index = 0; index < video.textTracks.length; index += 1) {
        const track = video.textTracks[index];
        if (!track || track.mode === "disabled") continue;
        if (track.activeCues) {
          for (let cueIndex = 0; cueIndex < track.activeCues.length; cueIndex += 1) {
            const text = String(track.activeCues[cueIndex].text || "").trim();
            if (text) chunks.push(text);
          }
        }
        if (track.cues && Number.isFinite(mediaTime)) {
          for (let cueIndex = 0; cueIndex < track.cues.length; cueIndex += 1) {
            const cue = track.cues[cueIndex];
            if (mediaTime >= cue.startTime && mediaTime < cue.endTime) {
              const text = String(cue.text || "").trim();
              if (text) chunks.push(text);
            }
          }
        }
      }
    }

    if (video && video.shadowRoot) {
      video.shadowRoot.querySelectorAll("*").forEach((node) => {
        const text = String(node.textContent || "").trim();
        if (text) chunks.push(text);
      });
    }

    if (stage) chunks.push(String(stage.innerText || "").trim());
    return chunks.join("\n");
  }

  function recordTrackRemoved(video) {
    if (!video || video.id !== "video-player-media") return;
    const haystack = collectNativeSubtitleHaystack(video);
    const activeTitle = document.querySelector("#video-queue-list .video-queue-row.is-active .video-row-title");
    window.__subtitleTeardownEvents.push({
      type: "track-removed",
      videoHidden: Boolean(video.hidden),
      videoHasHiddenClass: video.classList.contains("hidden"),
      activeTitle: activeTitle ? String(activeTitle.textContent || "").trim() : "",
      nativeHaystack: haystack,
    });
  }

  const originalRemove = Element.prototype.remove;
  Element.prototype.remove = function removeWithInstrumentation() {
    if (this.tagName === "TRACK") {
      const parent = this.parentElement;
      if (parent && parent.id === "video-player-media") {
        recordTrackRemoved(parent);
      }
    }
    return originalRemove.call(this);
  };
};

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

async function libraryRow(page, filename) {
  return page
    .locator("#video-library-list .video-library-row")
    .filter({ has: page.locator(".video-row-title", { hasText: filename }) })
    .first();
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

async function waitForLoadingOverlayWithoutPlaceholder(page) {
  await expect
    .poll(async () => {
      return page.evaluate(() => {
        function isVisible(element) {
          if (!element || element.hidden) return false;
          const style = window.getComputedStyle(element);
          return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
        }
        const loading = document.getElementById("video-loading-overlay");
        const placeholder = document.getElementById("video-playback-placeholder");
        return Boolean(isVisible(loading) && !isVisible(placeholder));
      });
    }, { timeout: 10000 })
    .toBe(true);
}

async function waitForPlaybackSurfaceWithoutOverlay(page) {
  await expect
    .poll(async () => {
      return page.evaluate(() => {
        function isVisible(element) {
          if (!element || element.hidden) return false;
          const style = window.getComputedStyle(element);
          return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
        }
        const loading = document.getElementById("video-loading-overlay");
        const placeholder = document.getElementById("video-playback-placeholder");
        const video = document.getElementById("video-player-media");
        return Boolean(isVisible(video) && !isVisible(loading) && !isVisible(placeholder));
      });
    }, { timeout: 10000 })
    .toBe(true);
}

async function setPlaybackTimeForSubtitleChecks(page, seconds) {
  await page.evaluate((targetSeconds) => {
    const video = document.getElementById("video-player-media");
    if (!video) return;
    try {
      video.currentTime = Number(targetSeconds);
    } catch (_error) {
      return;
    }
    video.dispatchEvent(new Event("timeupdate"));
  }, seconds);
}

async function readNativeSubtitleSurfaceState(page) {
  return page.evaluate(() => {
    const video = document.getElementById("video-player-media");
    const stage = document.getElementById("video-playback-stage");
    const mediaTime = video ? Number(video.currentTime) : NaN;
    const activeCueTexts = [];
    const showingTracks = [];

    if (video && video.textTracks) {
      for (let index = 0; index < video.textTracks.length; index += 1) {
        const track = video.textTracks[index];
        if (!track) continue;
        if (track.mode === "showing") {
          showingTracks.push({
            label: String(track.label || ""),
            language: String(track.language || ""),
          });
        }
        if (track.mode === "disabled") continue;

        if (track.activeCues) {
          for (let cueIndex = 0; cueIndex < track.activeCues.length; cueIndex += 1) {
            const cue = track.activeCues[cueIndex];
            const text = String(cue.text || "").trim();
            if (text) activeCueTexts.push(text);
          }
        }

        if (track.cues) {
          for (let cueIndex = 0; cueIndex < track.cues.length; cueIndex += 1) {
            const cue = track.cues[cueIndex];
            if (mediaTime >= cue.startTime && mediaTime < cue.endTime) {
              const text = String(cue.text || "").trim();
              if (text) activeCueTexts.push(text);
            }
          }
        }
      }
    }

    const shadowCueTexts = [];
    if (video && video.shadowRoot) {
      const nodes = video.shadowRoot.querySelectorAll("*");
      nodes.forEach((node) => {
        const text = String(node.textContent || "").trim();
        if (text) shadowCueTexts.push(text);
      });
    }

    const mountedTracks = [];
    if (video) {
      video.querySelectorAll("track[data-video-subtitle-track]").forEach((node) => {
        mountedTracks.push({
          streamIndex: String(node.getAttribute("data-video-subtitle-stream-index") || ""),
          label: String(node.getAttribute("label") || node.label || ""),
        });
      });
    }

    return {
      activeCueTexts: [...new Set(activeCueTexts)],
      showingTracks,
      shadowCueTexts: [...new Set(shadowCueTexts)],
      mountedTracks,
      stageText: stage ? String(stage.innerText || "").trim() : "",
      videoVisible: Boolean(video && !video.hidden),
      mediaTime,
    };
  });
}

function nativeSubtitleHaystack(state) {
  return [
    ...(state?.activeCueTexts || []),
    ...(state?.shadowCueTexts || []),
    state?.stageText || "",
  ].join("\n");
}

async function waitForMountedSubtitleTrackReady(page, streamIndex) {
  await expect
    .poll(async () => {
      return page.evaluate((expectedStreamIndex) => {
        const video = document.getElementById("video-player-media");
        if (!video) return null;
        const trackNode = video.querySelector(
          `track[data-video-subtitle-stream-index="${expectedStreamIndex}"]`,
        );
        if (!trackNode) return null;
        const textTrack = trackNode.track;
        return {
          readyState: Number(trackNode.readyState),
          mode: textTrack ? String(textTrack.mode || "") : "",
          cueCount: textTrack && textTrack.cues ? textTrack.cues.length : 0,
        };
      }, streamIndex);
    }, { timeout: 15000 })
    .toMatchObject({
      readyState: 2,
      mode: "showing",
      cueCount: expect.any(Number),
    });
}

async function waitForDisplayedSubtitleText(page, expectedText) {
  await expect
    .poll(async () => {
      return page.evaluate(() => {
        const debugCue = document.getElementById("video-debug-current-cue");
        return debugCue ? String(debugCue.textContent || "").trim() : "";
      });
    }, { timeout: 10000 })
    .toContain(expectedText);
}

async function waitForNativeSubtitleCueText(page, expectedText) {
  await expect
    .poll(async () => {
      const state = await readNativeSubtitleSurfaceState(page);
      await page.evaluate(() => {
        const video = document.getElementById("video-player-media");
        if (!video) return;
        video.dispatchEvent(new Event("timeupdate"));
      });
      return nativeSubtitleHaystack(state);
    }, { timeout: 15000 })
    .toContain(expectedText);
}

async function waitForDisplayedSubtitleToClear(page) {
  await expect
    .poll(async () => {
      return page.evaluate(() => {
        const debugCue = document.getElementById("video-debug-current-cue");
        return debugCue ? String(debugCue.textContent || "").trim() : "";
      });
    }, { timeout: 10000 })
    .toBe("No active subtitle cue.");
}

async function expectNativeSubtitleSurfaceClearOf(page, staleTexts) {
  await expect
    .poll(async () => {
      const state = await readNativeSubtitleSurfaceState(page);
      const haystack = nativeSubtitleHaystack(state);
      const staleMatches = staleTexts.filter((text) => haystack.includes(text));
      return {
        staleMatches,
        state,
      };
    }, { timeout: 10000 })
    .toMatchObject({ staleMatches: [] });
}

const SUBTITLE_STALE_MONITOR = () => {
  window.__subtitleStaleViolations = [];
  window.__subtitleSwitchArmed = false;

  function collectNativeSubtitleHaystack() {
    const video = document.getElementById("video-player-media");
    const stage = document.getElementById("video-playback-stage");
    const chunks = [];
    const mediaTime = video ? Number(video.currentTime) : NaN;

    if (video && video.textTracks) {
      for (let index = 0; index < video.textTracks.length; index += 1) {
        const track = video.textTracks[index];
        if (!track || track.mode === "disabled") continue;
        if (track.activeCues) {
          for (let cueIndex = 0; cueIndex < track.activeCues.length; cueIndex += 1) {
            const text = String(track.activeCues[cueIndex].text || "").trim();
            if (text) chunks.push(text);
          }
        }
        if (track.cues && Number.isFinite(mediaTime)) {
          for (let cueIndex = 0; cueIndex < track.cues.length; cueIndex += 1) {
            const cue = track.cues[cueIndex];
            if (mediaTime >= cue.startTime && mediaTime < cue.endTime) {
              const text = String(cue.text || "").trim();
              if (text) chunks.push(text);
            }
          }
        }
      }
    }

    if (video && video.shadowRoot) {
      video.shadowRoot.querySelectorAll("*").forEach((node) => {
        const text = String(node.textContent || "").trim();
        if (text) chunks.push(text);
      });
    }

    if (stage) chunks.push(String(stage.innerText || "").trim());
    return chunks.join("\n");
  }

  function sampleState(reason) {
    if (!window.__subtitleSwitchArmed) return;
    const needles = Array.isArray(window.__subtitleStaleNeedles) ? window.__subtitleStaleNeedles : [];
    if (!needles.length) return;
    const activeTitle = document.querySelector("#video-queue-list .video-queue-row.is-active .video-row-title");
    const activeFilename = activeTitle ? String(activeTitle.textContent || "").trim() : "";
    if (!activeFilename || activeFilename === "alpha.mkv") return;
    const haystack = collectNativeSubtitleHaystack();
    const staleMatches = needles.filter((needle) => haystack.includes(needle));
    if (!staleMatches.length) return;
    window.__subtitleStaleViolations.push({
      reason,
      staleMatches,
      activeTitle: activeFilename,
      haystack,
    });
  }

  window.__armSubtitleStaleMonitor = (needles) => {
    window.__subtitleStaleNeedles = needles;
    window.__subtitleStaleViolations = [];
    window.__subtitleSwitchArmed = true;
    sampleState("armed");
  };

  window.setInterval(() => sampleState("interval"), 16);
};

async function installSubtitleStaleMonitor(page) {
  await page.addInitScript(SUBTITLE_STALE_MONITOR);
}

async function armSubtitleStaleMonitor(page, staleTexts) {
  await page.evaluate((needles) => {
    window.__armSubtitleStaleMonitor(needles);
  }, staleTexts);
}

async function expectNoSubtitleStaleMonitorViolations(page) {
  const violations = await page.evaluate(() => window.__subtitleStaleViolations || []);
  expect(violations).toEqual([]);
}

async function expectNoStaleNativeSubtitleOnVideoResume(page, staleTexts) {
  await expect
    .poll(async () => {
      const state = await readNativeSubtitleSurfaceState(page);
      if (!state.videoVisible) return null;
      const haystack = nativeSubtitleHaystack(state);
      const staleMatches = staleTexts.filter((text) => haystack.includes(text));
      return { ready: true, staleMatches, state };
    }, { timeout: 10000 })
    .toMatchObject({ ready: true, staleMatches: [] });
}

async function expectNoPlaybackSurfaceViolations(page) {
  const violations = await page.evaluate(() => window.__playbackSurfaceViolations || []);
  expect(violations).toEqual([]);
}

async function playbackStageInnerText(page) {
  return page.locator("#video-playback-stage").innerText();
}

function countOccurrences(text, needle) {
  return String(text || "").split(String(needle || "")).length - 1;
}

async function expectControlsOverlayUsableDuringLoading(page, expectedLoadingMetaSubstring) {
  await expect
    .poll(async () => playbackStageInnerText(page), { timeout: 10000 })
    .toContain(expectedLoadingMetaSubstring);

  const controlsState = await expect
    .poll(async () => {
      return page.evaluate(() => {
        function isVisible(element) {
          if (!element || element.hidden) return false;
          const style = window.getComputedStyle(element);
          if (style.display === "none" || style.visibility === "hidden") return false;
          if (Number(style.opacity) === 0) return false;
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }

        const loading = document.getElementById("video-loading-overlay");
        const controls = document.getElementById("video-controls-overlay");
        const muteButton = document.getElementById("video-mute-toggle");
        if (!isVisible(loading) || !controls || !muteButton) return null;

        const loadingStyle = window.getComputedStyle(loading);
        const controlsStyle = window.getComputedStyle(controls);
        return {
          controlsVisible: isVisible(controls),
          controlsPointerEvents: controlsStyle.pointerEvents,
          controlsAboveLoading: Number(controlsStyle.zIndex) > Number(loadingStyle.zIndex),
          muteEnabled: !muteButton.disabled,
        };
      });
    }, { timeout: 10000 })
    .toMatchObject({
      controlsVisible: true,
      controlsPointerEvents: "auto",
      controlsAboveLoading: true,
      muteEnabled: true,
    });

  const initialMuted = await page.evaluate(() => document.getElementById("video-player-media")?.muted);
  await page.evaluate(() => {
    const button = document.getElementById("video-mute-toggle");
    if (!button || button.disabled) {
      throw new Error("mute toggle is not usable");
    }
    button.click();
  });
  await expect
    .poll(async () => page.evaluate(() => document.getElementById("video-player-media")?.muted))
    .not.toBe(initialMuted);
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

async function expectActiveQueueTitle(page, filename) {
  const activeRow = page.locator("#video-queue-list .video-queue-row.is-active").first();
  await expect(activeRow.locator(".video-row-title")).toHaveText(filename);
}

async function expectTrackSelectors(page, {
  audioEnabled = true,
  subtitleEnabled = true,
  audioValue,
  subtitleValue,
  audioOptionCount,
  subtitleOptionCount,
}) {
  const audioSelect = page.locator("#video-audio-track");
  const subtitleSelect = page.locator("#video-subtitle-track");

  if (audioEnabled) {
    await expect(audioSelect).toBeEnabled();
  } else {
    await expect(audioSelect).toBeDisabled();
  }
  if (subtitleEnabled) {
    await expect(subtitleSelect).toBeEnabled();
  } else {
    await expect(subtitleSelect).toBeDisabled();
  }

  if (audioValue !== undefined) {
    await expect(audioSelect).toHaveValue(String(audioValue));
  }
  if (subtitleValue !== undefined) {
    await expect(subtitleSelect).toHaveValue(String(subtitleValue));
  }
  if (audioOptionCount !== undefined) {
    await expect(audioSelect.locator("option")).toHaveCount(audioOptionCount);
  }
  if (subtitleOptionCount !== undefined) {
    await expect(subtitleSelect.locator("option")).toHaveCount(subtitleOptionCount);
  }
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
  await waitForLoadingOverlayWithoutPlaceholder(page);
  await sessionRequest;
  await waitForVisibleVideo(page);
  await waitForPlaybackSurfaceWithoutOverlay(page);
}

async function openVideoPane(page) {
  await page.goto("/?path=Videos");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await page.locator("#bottom-pane-mode").selectOption("video-player");
  await expect(page.locator("#video-player-pane")).toBeVisible();
  await expect(page.locator("#video-library-list .video-library-row")).toHaveCount(3);
  await waitForCompatibilityReady(page);
}

async function playLibraryFile(page, filename) {
  const row = await libraryRow(page, filename);
  await expect(row).toBeVisible();
  await row.dblclick();
  await waitForLoadingOverlayWithoutPlaceholder(page);
  await expectActiveQueueTitle(page, filename);
  await waitForVisibleVideo(page);
  await waitForPlaybackSurfaceWithoutOverlay(page);
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

test("video playback loads tracks, switches tracks, and hides video before subtitle teardown", async ({ page }) => {
  test.setTimeout(60000);

  page.on("pageerror", (error) => {
    console.log("pageerror:", error);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      console.log("console.error:", message.text());
    }
  });

  await installHlsStub(page);
  await page.addInitScript(TRACK_REMOVAL_INSTRUMENTATION);
  await installSubtitleStaleMonitor(page);
  await openVideoPane(page);

  const probeResponse = await page.request.get("/video/endpoints/probe?path=Videos%2Falpha.mkv&source=remote");
  expect(probeResponse.ok()).toBe(true);
  const probePayload = await probeResponse.json();
  expect(probePayload.audio_streams).toHaveLength(2);
  expect(probePayload.subtitle_streams).toHaveLength(3);
  expect(probePayload.default_subtitle_stream_index).toBe(3);
  expect(probePayload.subtitle_streams.map((stream) => stream.codec_name)).toEqual(["subrip", "subrip", "hdmv_pgs_subtitle"]);

  const allSubtitlesResponse = await page.request.get("/video/endpoints/subtitles/all?path=Videos%2Falpha.mkv&source=remote");
  expect(allSubtitlesResponse.ok()).toBe(true);
  const allSubtitlesPayload = await allSubtitlesResponse.json();
  expect(Object.keys(allSubtitlesPayload.tracks).sort()).toEqual(["3", "4"]);
  expect(allSubtitlesPayload.tracks["3"].vtt).toContain("ALPHA-SUBTITLE-ENG");
  expect(allSubtitlesPayload.tracks["4"].vtt).toContain("ALPHA-SUBTITLE-FRA");

  const alphaRow = await libraryRow(page, "alpha.mkv");
  const bravoRow = await libraryRow(page, "bravo.mkv");

  const initialSession = waitForSessionPost(page, (body) => body.includes("path=Videos%2Falpha.mkv"));
  await playLibraryFile(page, "alpha.mkv");
  await initialSession;

  await expectTrackSelectors(page, {
    audioOptionCount: 2,
    subtitleOptionCount: 4,
    audioValue: "1",
    subtitleValue: "3",
  });
  await waitForSubtitleStreamIndex(page, 3);
  await expect(page.locator("#video-player-status")).not.toContainText("Compatibility playback failed");

  await page.locator("#video-subtitle-track").selectOption("4");
  await waitForSubtitleStreamIndex(page, 4);
  await expectTrackSelectors(page, { subtitleValue: "4" });
  await waitForMountedSubtitleTrackReady(page, 4);
  await setPlaybackTimeForSubtitleChecks(page, 1);
  await waitForDisplayedSubtitleText(page, "ALPHA-SUBTITLE-FRA");
  await waitForNativeSubtitleCueText(page, "ALPHA-SUBTITLE-FRA");
  await page.waitForTimeout(500);

  await page.evaluate(() => {
    window.__subtitleTeardownEvents = [];
  });

  const staleAlphaSubtitleTexts = ["ALPHA-SUBTITLE-FRA", "ALPHA-SUBTITLE-ENG"];
  const bravoSession = waitForSessionPost(page, (body) => body.includes("path=Videos%2Fbravo.mkv"));
  await armSubtitleStaleMonitor(page, staleAlphaSubtitleTexts);
  await bravoRow.dblclick();
  await waitForLoadingOverlayWithoutPlaceholder(page);
  await waitForDisplayedSubtitleToClear(page);
  await expectNativeSubtitleSurfaceClearOf(page, staleAlphaSubtitleTexts);
  await bravoSession;
  await expectActiveQueueTitle(page, "bravo.mkv");
  await expectNoStaleNativeSubtitleOnVideoResume(page, staleAlphaSubtitleTexts);

  await waitForVisibleVideo(page);
  await waitForPlaybackSurfaceWithoutOverlay(page);
  await setPlaybackTimeForSubtitleChecks(page, 0.5);
  await expectNativeSubtitleSurfaceClearOf(page, staleAlphaSubtitleTexts);
  await expectNoSubtitleStaleMonitorViolations(page);

  await expect
    .poll(async () => {
      const events = await page.evaluate(() => window.__subtitleTeardownEvents || []);
      return events.length;
    }, { timeout: 10000 })
    .toBeGreaterThan(0);

  const teardownEvents = await page.evaluate(() => window.__subtitleTeardownEvents || []);
  for (const event of teardownEvents) {
    const staleAtTeardown = staleAlphaSubtitleTexts.filter((text) => String(event.nativeHaystack || "").includes(text));
    expect(staleAtTeardown, JSON.stringify(event)).toEqual([]);
  }
  await expectTrackSelectors(page, {
    audioOptionCount: 2,
    subtitleOptionCount: 4,
    audioValue: "1",
    subtitleValue: "3",
  });
  await waitForSubtitleStreamIndex(page, 3);
  await waitForMountedSubtitleTrackReady(page, 3);
  await waitForNativeSubtitleCueText(page, "BRAVO-SUBTITLE-ENG");

  await page.locator("#video-subtitle-track").selectOption("4");
  await waitForSubtitleStreamIndex(page, 4);
  await expectTrackSelectors(page, { subtitleValue: "4" });

  await scrubTo(
    page,
    6,
    (body) => body.includes("path=Videos%2Fbravo.mkv") && body.includes("start_time_seconds=6"),
  );
  await expectTrackSelectors(page, { audioValue: "1", subtitleValue: "4" });
  await waitForSubtitleStreamIndex(page, 4);

  const bravoAudioRestart = waitForSessionPost(
    page,
    (body) => body.includes("path=Videos%2Fbravo.mkv") && body.includes("audio_stream_index=2"),
  );
  await page.locator("#video-audio-track").selectOption("2");
  await waitForLoadingOverlayWithoutPlaceholder(page);
  await bravoAudioRestart;
  await waitForVisibleVideo(page);
  await waitForPlaybackSurfaceWithoutOverlay(page);
  await expectTrackSelectors(page, { audioValue: "2", subtitleValue: "4" });
  await waitForSubtitleStreamIndex(page, 4);

  await scrubTo(
    page,
    2,
    (body) => body.includes("path=Videos%2Fbravo.mkv") && body.includes("audio_stream_index=2") && body.includes("start_time_seconds=2"),
  );
  await expectTrackSelectors(page, { audioValue: "2", subtitleValue: "4" });
  await waitForSubtitleStreamIndex(page, 4);

  await page.locator("#video-subtitle-track").selectOption("");
  await expectNoMountedSubtitleTrack(page);
  await expectTrackSelectors(page, { subtitleValue: "" });

  await page.locator("#video-subtitle-track").selectOption("3");
  await waitForSubtitleStreamIndex(page, 3);
  await expectTrackSelectors(page, { subtitleValue: "3" });
});

test("video playback never shows loading or placeholder copy on top of active playback during real HLS switching", async ({ page }) => {
  test.setTimeout(90000);

  await installPlaybackSurfaceMonitor(page);
  await openVideoPane(page);

  const alphaSession = waitForSessionPost(page, (body) => body.includes("path=Videos%2Falpha.mkv"));
  const alphaRow = await libraryRow(page, "alpha.mkv");
  await alphaRow.dblclick();
  await waitForLoadingOverlayWithoutPlaceholder(page);
  await alphaSession;
  await expect
    .poll(async () => playbackStageInnerText(page), { timeout: 10000 })
    .toContain("Creating the local HLS compatibility session.");
  const alphaLoadingText = await playbackStageInnerText(page);
  expect(alphaLoadingText).not.toContain("Preparing an HLS compatibility session for this queue item.");
  expect(countOccurrences(alphaLoadingText, "alpha.mkv")).toBe(1);
  await expectControlsOverlayUsableDuringLoading(page, "Creating the local HLS compatibility session.");

  await waitForVisibleVideo(page);
  await page.waitForTimeout(1500);
  const alphaPlayText = await playbackStageInnerText(page);
  expect(alphaPlayText).not.toContain("Playing through a local HLS compatibility session.");
  expect(alphaPlayText).not.toContain("alpha.mkv");
  await page.locator("#video-subtitle-track").selectOption("4");
  await waitForSubtitleStreamIndex(page, 4);
  await expectNoPlaybackSurfaceViolations(page);

  const alphaScrubSession = waitForSessionPost(
    page,
    (body) => body.includes("path=Videos%2Falpha.mkv") && body.includes("start_time_seconds=1"),
  );
  await page.locator("#video-progress-slider").evaluate((element, seconds) => {
    element.value = String(seconds);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, 1);
  await expectControlsOverlayUsableDuringLoading(page, "Creating a compatibility stream at");
  await alphaScrubSession;
  await waitForVisibleVideo(page);
  await waitForPlaybackSurfaceWithoutOverlay(page);

  const bravoRow = await libraryRow(page, "bravo.mkv");
  const bravoSession = waitForSessionPost(page, (body) => body.includes("path=Videos%2Fbravo.mkv"));
  await bravoRow.dblclick();
  await waitForLoadingOverlayWithoutPlaceholder(page);
  await bravoSession;
  await expect
    .poll(async () => playbackStageInnerText(page), { timeout: 10000 })
    .toContain("Creating the local HLS compatibility session.");
  const bravoLoadingText = await playbackStageInnerText(page);
  expect(bravoLoadingText).not.toContain("Preparing an HLS compatibility session for this queue item.");
  expect(countOccurrences(bravoLoadingText, "bravo.mkv")).toBe(1);
  await expectControlsOverlayUsableDuringLoading(page, "Creating the local HLS compatibility session.");

  await waitForVisibleVideo(page);
  await page.waitForTimeout(2000);
  const bravoPlayText = await playbackStageInnerText(page);
  expect(bravoPlayText).not.toContain("Playing through a local HLS compatibility session.");
  expect(bravoPlayText).not.toContain("bravo.mkv");
  await expectNoPlaybackSurfaceViolations(page);
});
