const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");

const workerPortOffset = Number(process.env.TEST_WORKER_INDEX || "0") * 100;
process.env.PLAYWRIGHT_PORT = String(8013 + workerPortOffset);
process.env.DROPBOX_BROWSER_E2E_FIXTURE = path.join(
  __dirname,
  "fixtures",
  "video_player_generated_fixture.py",
);

const { startIntegrationServer, stopIntegrationServer } = require("./support/integration_server");
const {
  libraryRow,
  playLibraryFile: playLibraryFileBase,
  queueLibraryFile,
  expectActivePlaylistTitle,
  expectPlaylistCount,
  loadVideoLibrary,
} = require("./support/video_library");
const baseURL = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT}`;

const hlsStubSource = fs.readFileSync(
  path.join(__dirname, "support", "hls-stub.js"),
  "utf8",
);

let server = null;

function isClosedRouteError(error) {
  const message = error && error.message ? String(error.message) : "";
  return message.includes("Target page, context or browser has been closed");
}

function isIgnorableRouteFetchError(error) {
  const message = error && error.message ? String(error.message) : "";
  return isClosedRouteError(error)
    || message.includes("ECONNREFUSED")
    || message.includes("socket hang up")
    || message.includes("ERR_CONNECTION_REFUSED");
}

async function fetchJsonRoute(route, { ignoreErrors = false } = {}) {
  let response;
  try {
    response = await route.fetch();
  } catch (error) {
    if (ignoreErrors && isIgnorableRouteFetchError(error)) return null;
    throw error;
  }
  return {
    response,
    payload: await response.json(),
  };
}

async function fulfillJsonRoute(route, response, payload) {
  await route.fulfill({
    status: response.status(),
    headers: response.headers(),
    contentType: "application/json",
    body: JSON.stringify(payload),
  });
}

test.describe.configure({ mode: "serial", timeout: 90000 });

async function installHlsStub(page, {
  fragmentCount = 2,
  playlistFragmentCount = null,
  simulateMissingOnSeek = false,
  fragmentLoadDelayMs = 0,
  fragmentLoadIntervalMs = 0,
} = {}) {
  await page.addInitScript((options) => {
    window.__HLS_STUB_FRAGMENT_COUNT = options.fragmentCount;
    window.__HLS_STUB_PLAYLIST_FRAGMENT_COUNT = options.playlistFragmentCount ?? options.fragmentCount;
    window.__HLS_STUB_SIMULATE_MISSING_ON_SEEK = options.simulateMissingOnSeek;
    window.__HLS_STUB_FRAGMENT_LOAD_DELAY_MS = options.fragmentLoadDelayMs;
    window.__HLS_STUB_FRAGMENT_LOAD_INTERVAL_MS = options.fragmentLoadIntervalMs;
  }, {
    fragmentCount,
    playlistFragmentCount: playlistFragmentCount ?? fragmentCount,
    simulateMissingOnSeek,
    fragmentLoadDelayMs,
    fragmentLoadIntervalMs,
  });
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
    const activeTitle = document.querySelector("#video-playlist-list .music-playlist-entry.current .music-playlist-filename-cell");
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
    }, { timeout: 30000 })
    .toBe(true);
}

async function waitForVisibleVideo(page, timeout = 30000) {
  try {
    await expect
      .poll(async () => {
        return page.evaluate(() => {
          const video = document.getElementById("video-player-media");
          return Boolean(video && !video.hidden);
        });
      }, { timeout })
      .toBe(true);
  } catch (error) {
    const clientState = await page.evaluate(() => {
      const video = document.getElementById("video-player-media");
      const loading = document.getElementById("video-loading-overlay");
      const placeholder = document.getElementById("video-playback-placeholder");
      const status = document.getElementById("video-player-status");
      return {
        videoHidden: video ? Boolean(video.hidden) : null,
        videoReadyState: video ? video.readyState : null,
        videoNetworkState: video ? video.networkState : null,
        loadingHidden: loading ? Boolean(loading.hidden) : null,
        loadingText: loading ? String(loading.textContent || "").trim() : "",
        placeholderHidden: placeholder ? Boolean(placeholder.hidden) : null,
        statusText: status ? String(status.textContent || "").trim() : "",
      };
    });
    let serverState = null;
    try {
      const response = await page.request.get("/video/endpoints/status");
      if (response.ok()) serverState = await response.json();
    } catch (_statusError) {
      serverState = { statusError: true };
    }
    throw new Error(`${error.message}\nPlayback startup state: ${JSON.stringify({clientState, serverState})}`);
  }
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
    }, { timeout: 30000 })
    .toBe(true);
}

async function readPlayToggleState(page) {
  return page.evaluate(() => {
    const button = document.getElementById("video-play-toggle");
    if (!button) return null;
    const icon = button.querySelector(".video-control-icon");
    return {
      disabled: Boolean(button.disabled),
      label: String(button.getAttribute("aria-label") || ""),
      title: String(button.getAttribute("title") || ""),
      icon: icon ? String(icon.getAttribute("src") || "") : "",
    };
  });
}

async function expectPlayToggleState(page, expectedLabel) {
  const expectedIcon = expectedLabel === "Pause"
    ? "/assets/icons/material-icon-theme/video-pause.svg"
    : "/assets/icons/material-icon-theme/video-play.svg";
  await expect
    .poll(async () => readPlayToggleState(page), { timeout: 10000 })
    .toMatchObject({
      disabled: false,
      label: expectedLabel,
      title: expectedLabel,
      icon: expectedIcon,
    });
}

async function clickPlayToggle(page) {
  await page.evaluate(() => {
    const button = document.getElementById("video-play-toggle");
    if (!button || button.disabled) {
      throw new Error("play toggle is not usable");
    }
    button.click();
  });
}

async function readControlsOverlayState(page) {
  return page.evaluate(() => {
    const overlay = document.getElementById("video-controls-overlay");
    if (!overlay) return null;
    const style = window.getComputedStyle(overlay);
    const rect = overlay.getBoundingClientRect();
    return {
      hidden: Boolean(overlay.hidden),
      className: String(overlay.className || ""),
      display: style.display,
      opacity: style.opacity,
      pointerEvents: style.pointerEvents,
      width: rect.width,
      height: rect.height,
    };
  });
}

async function readFullscreenPlaybackState(page) {
  return page.evaluate(() => {
    function isVisible(element) {
      if (!element || element.hidden) return false;
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") return false;
      if (Number(style.opacity) === 0) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

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

    const stage = document.getElementById("video-playback-stage");
    const overlay = document.getElementById("video-controls-overlay");
    const slider = document.getElementById("video-progress-slider");
    const fullscreenButton = document.getElementById("video-fullscreen-toggle");
    const elapsed = document.getElementById("video-elapsed-time");
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
    const controlRects = Object.fromEntries(controlOrder.map((id) => [id, rectFor(id)]));
    const overlappingControlPairs = [];
    for (let index = 0; index < controlOrder.length; index += 1) {
      for (let nextIndex = index + 1; nextIndex < controlOrder.length; nextIndex += 1) {
        const left = controlRects[controlOrder[index]];
        const right = controlRects[controlOrder[nextIndex]];
        if (verticallyOverlap(left, right) && horizontallyOverlap(left, right)) {
          overlappingControlPairs.push([controlOrder[index], controlOrder[nextIndex]]);
        }
      }
    }

    return {
      fullscreenElementId: document.fullscreenElement ? String(document.fullscreenElement.id || "") : "",
      stageVisible: isVisible(stage),
      overlayVisible: isVisible(overlay),
      sliderVisible: isVisible(slider),
      sliderDisabled: slider ? Boolean(slider.disabled) : true,
      sliderValue: slider ? Number(slider.value) : NaN,
      sliderMax: slider ? Number(slider.max) : NaN,
      fullscreenLabel: fullscreenButton ? String(fullscreenButton.getAttribute("aria-label") || "") : "",
      elapsedText: elapsed ? String(elapsed.textContent || "").trim() : "",
      controlOrder,
      controlRects,
      overlappingControlPairs,
      playBeforeBack15: controlRects["video-play-toggle"].right <= controlRects["video-back-15"].left + 1
        || controlRects["video-play-toggle"].bottom <= controlRects["video-back-15"].top + 1,
      loopBeforePrevious: controlRects["video-loop-toggle"].right <= controlRects["video-previous"].left + 1
        || controlRects["video-loop-toggle"].bottom <= controlRects["video-previous"].top + 1,
      previousBeforeNext: controlRects["video-previous"].right <= controlRects["video-next"].left + 1
        || controlRects["video-previous"].bottom <= controlRects["video-next"].top + 1,
      back15BeforeForward15: controlRects["video-back-15"].right <= controlRects["video-forward-15"].left + 1
        || controlRects["video-back-15"].bottom <= controlRects["video-forward-15"].top + 1,
      forward15BeforeMute: controlRects["video-forward-15"].right <= controlRects["video-mute-toggle"].left + 1
        || controlRects["video-forward-15"].bottom <= controlRects["video-mute-toggle"].top + 1,
      nextBeforeFullWindow: controlRects["video-next"].right <= controlRects["video-full-window-toggle"].left + 1
        || controlRects["video-next"].bottom <= controlRects["video-full-window-toggle"].top + 1,
      forward15BeforeFullWindow: controlRects["video-forward-15"].right <= controlRects["video-full-window-toggle"].left + 1
        || controlRects["video-forward-15"].bottom <= controlRects["video-full-window-toggle"].top + 1,
      fullWindowBeforeFullscreen: controlRects["video-full-window-toggle"].right <= controlRects["video-fullscreen-toggle"].left + 1
        || controlRects["video-full-window-toggle"].bottom <= controlRects["video-fullscreen-toggle"].top + 1,
    };
  });
}

async function readStoredTrackPreferences(page) {
  return page.evaluate(() => {
    return {
      audio: window.localStorage.getItem("dropbox-browser-video-audio-track-preferences") || "",
      subtitle: window.localStorage.getItem("dropbox-browser-video-subtitle-track-preferences") || "",
    };
  });
}

async function clearStoredTrackPreferences(page) {
  await page.goto("/");
  await page.evaluate(() => {
    window.localStorage.removeItem("dropbox-browser-video-audio-track-preferences");
    window.localStorage.removeItem("dropbox-browser-video-subtitle-track-preferences");
    window.localStorage.removeItem("dropbox-browser.video-loop-queue");
  });
}

async function clearActiveVideoSessionAndCache(page) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const statusResponse = await page.request.get("/video/endpoints/status");
    expect(statusResponse.ok()).toBe(true);
    const statusPayload = await statusResponse.json();
    const sessionIds = [];
    const clientIds = new Set();
    if (statusPayload && Array.isArray(statusPayload.active_sessions)) {
      statusPayload.active_sessions.forEach((session) => {
        if (session && session.session_id) sessionIds.push(String(session.session_id));
        if (session && session.client_id) clientIds.add(String(session.client_id));
      });
    }
    if (!sessionIds.length && statusPayload && statusPayload.active_session && statusPayload.active_session.session_id) {
      sessionIds.push(String(statusPayload.active_session.session_id));
      if (statusPayload.active_session.client_id) {
        clientIds.add(String(statusPayload.active_session.client_id));
      }
    }
    if (!sessionIds.length && !clientIds.size) break;
    for (const sessionId of sessionIds) {
      const stopResponse = await page.request.post("/video/endpoints/session/stop", {
        data: { id: sessionId },
      });
      expect(stopResponse.ok()).toBe(true);
    }
    for (const clientId of clientIds) {
      const stopResponse = await page.request.post("/video/endpoints/session/stop", {
        data: {client_id: clientId},
      });
      expect(stopResponse.ok()).toBe(true);
    }
    await page.waitForTimeout(50);
  }
  const clearResponse = await page.request.post("/video/endpoints/cache/clear");
  expect(clearResponse.ok()).toBe(true);
}

async function readActiveVideoSessions(page) {
  const response = await page.request.get("/video/endpoints/status");
  expect(response.ok()).toBe(true);
  const payload = await response.json();
  return payload && Array.isArray(payload.active_sessions) ? payload.active_sessions : [];
}

async function waitForActiveVideoSession(page, expectedPath) {
  let matchingSession = null;
  await expect
    .poll(async () => {
      const sessions = await readActiveVideoSessions(page);
      matchingSession = sessions.find((session) => session && session.path === expectedPath) || null;
      return matchingSession ? matchingSession.session_id : "";
    }, { timeout: 15000 })
    .not.toBe("");
  return matchingSession;
}

async function expectOnlyActiveVideoSession(page, expectedPath, absentSessionId, expectedSessionId) {
  await expect
    .poll(async () => {
      const sessions = await readActiveVideoSessions(page);
      if (expectedSessionId) {
        const expectedSession = sessions.find((session) => session && session.session_id === expectedSessionId);
        const unexpectedLivePaths = sessions
          .filter((session) => session && session.state === "active" && session.session_id !== expectedSessionId)
          .map((session) => session.path)
          .filter(Boolean);
        return {
          expectedSession: expectedSession && expectedSession.path === expectedPath,
          unexpectedLivePaths,
        };
      }
      return sessions.map((session) => session && session.path).filter(Boolean);
    }, { timeout: 15000 })
    .toEqual(expectedSessionId
      ? { expectedSession: true, unexpectedLivePaths: [] }
      : [expectedPath]);
  if (absentSessionId) {
    await expect
      .poll(async () => {
        const sessions = await readActiveVideoSessions(page);
        return sessions.map((session) => session && session.session_id).filter(Boolean);
      }, { timeout: 15000 })
      .not.toContain(absentSessionId);
  }
}

async function expectOnlyActiveVideoClientSession(page, expectedPath, clientId) {
  await expect
    .poll(async () => {
      const sessions = await readActiveVideoSessions(page);
      return sessions
        .filter((session) => session && session.client_id === clientId)
        .map((session) => session.path)
        .filter(Boolean);
    }, { timeout: 15000 })
    .toEqual([expectedPath]);
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

async function selectTrackOption(page, selector, value) {
  await ensureTrackPanelOpen(page);
  await page.locator(selector).selectOption(value);
}

async function expectControlsOverlayVisible(page) {
  await expect
    .poll(async () => readControlsOverlayState(page), { timeout: 10000 })
    .toMatchObject({
      hidden: false,
      display: "flex",
      opacity: "1",
      pointerEvents: "auto",
    });
}

async function expectControlsOverlayHidden(page) {
  await expect
    .poll(async () => {
      const state = await readControlsOverlayState(page);
      if (!state) return false;
      return state.hidden === true
        || state.display === "none"
        || state.opacity === "0"
        || state.pointerEvents === "none";
    }, { timeout: 30000 })
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
    }, { timeout: 30000 })
    .toBe(true);
}

async function waitForLoadingOverlayHidden(page) {
  await expect
    .poll(async () => {
      return page.evaluate(() => {
        const loading = document.getElementById("video-loading-overlay");
        if (!loading || loading.hidden) return true;
        const style = window.getComputedStyle(loading);
        return style.display === "none" || style.visibility === "hidden" || style.opacity === "0";
      });
    }, { timeout: 30000 })
    .toBe(true);
}

async function startSyntheticControlsPointerStorm(page, {
  xOffset = 0,
  yOffset = 0,
  intervalMs = 50,
} = {}) {
  await page.evaluate(({ xOffset: nextXOffset, yOffset: nextYOffset, intervalMs: nextIntervalMs }) => {
    if (window.__videoControlsPointerStormStop) {
      window.__videoControlsPointerStormStop();
    }
    const surface = document.getElementById("video-playback-surface");
    const stage = document.getElementById("video-playback-stage");
    const overlay = document.getElementById("video-controls-overlay");
    if (!surface || !stage || !overlay) {
      throw new Error("video controls elements are not ready");
    }
    const rect = surface.getBoundingClientRect();
    const clientX = Math.round(rect.left + (rect.width / 2) + Number(nextXOffset || 0));
    const clientY = Math.round(rect.top + (rect.height / 2) + Number(nextYOffset || 0));
    const targets = [overlay, stage, surface];
    const timerId = window.setInterval(() => {
      targets.forEach((target) => {
        target.dispatchEvent(new MouseEvent("mousemove", {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          movementX: 0,
          movementY: 0,
          view: window,
        }));
      });
    }, Number(nextIntervalMs || 50));
    window.__videoControlsPointerStormStop = () => {
      window.clearInterval(timerId);
      window.__videoControlsPointerStormStop = null;
    };
  }, { xOffset, yOffset, intervalMs });
}

async function stopSyntheticControlsPointerStorm(page) {
  await page.evaluate(() => {
    if (window.__videoControlsPointerStormStop) {
      window.__videoControlsPointerStormStop();
    }
  });
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
        if (track.mode === "showing" || track.mode === "hidden") {
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
      mode: "hidden",
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

async function waitForSubtitleOverlayMarkup(page, { tagName, expectedText }) {
  await expect
    .poll(async () => {
      return page.evaluate(({ expectedTagName, text }) => {
        const overlay = document.getElementById("video-subtitle-overlay");
        if (!overlay || overlay.hidden) {
          return { found: false, html: "" };
        }
        const element = overlay.querySelector(expectedTagName);
        return {
          found: Boolean(element),
          text: element ? String(element.textContent || "").trim() : "",
          html: overlay.innerHTML,
        };
      }, { expectedTagName: tagName, text: expectedText });
    }, { timeout: 10000 })
    .toMatchObject({
      found: true,
      text: expectedText,
    });
}

async function waitForSubtitleOverlayText(page, expectedText) {
  await expect
    .poll(async () => {
      return page.evaluate(() => {
        const overlay = document.getElementById("video-subtitle-overlay");
        if (!overlay || overlay.hidden) return "";
        return String(overlay.textContent || "").trim();
      });
    }, { timeout: 10000 })
    .toContain(expectedText);
}

async function readSubtitleOverlayState(page) {
  return page.evaluate(() => {
    const overlay = document.getElementById("video-subtitle-overlay");
    if (!overlay) {
      return {
        hidden: true,
        text: "",
        html: "",
      };
    }
    return {
      hidden: Boolean(overlay.hidden),
      text: String(overlay.textContent || "").trim(),
      html: String(overlay.innerHTML || ""),
    };
  });
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
    const activeTitle = document.querySelector("#video-playlist-list .music-playlist-entry.current .music-playlist-filename-cell");
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

async function readVideoControlState(page) {
  return page.evaluate(() => {
    function buttonState(id) {
      const button = document.getElementById(id);
      if (!button) return null;
      const icon = button.querySelector(".video-control-icon");
      const rect = button.getBoundingClientRect();
      const style = window.getComputedStyle(button);
      return {
        disabled: Boolean(button.disabled),
        label: String(button.getAttribute("aria-label") || ""),
        title: String(button.getAttribute("title") || ""),
        pressed: String(button.getAttribute("aria-pressed") || ""),
        icon: icon ? String(icon.getAttribute("src") || "") : "",
        visible:
          !button.hidden
          && style.display !== "none"
          && style.visibility !== "hidden"
          && Number(style.opacity) !== 0
          && rect.width > 0
          && rect.height > 0,
      };
    }

    return {
      loop: buttonState("video-loop-toggle"),
      previous: buttonState("video-previous"),
      next: buttonState("video-next"),
      back15: buttonState("video-back-15"),
      forward15: buttonState("video-forward-15"),
    };
  });
}

async function expectVideoControlState(page, expected) {
  await expect
    .poll(async () => readVideoControlState(page), { timeout: 10000 })
    .toMatchObject(expected);
}

async function clickVideoControl(page, id) {
  await page.evaluate((buttonId) => {
    const button = document.getElementById(buttonId);
    if (!button || button.disabled) {
      throw new Error(`${buttonId} is not usable`);
    }
    button.click();
  }, id);
}

async function setMediaPlaybackTime(page, seconds) {
  await page.evaluate((targetSeconds) => {
    const video = document.getElementById("video-player-media");
    if (!video) {
      throw new Error("video element missing");
    }
    video.currentTime = Number(targetSeconds);
    video.dispatchEvent(new Event("timeupdate"));
  }, seconds);
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
  await expectActivePlaylistTitle(page, filename);
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

async function pausePlayback(page) {
  const toggle = page.locator("#video-play-toggle");
  const label = String(await toggle.textContent() || "").trim();
  if (label === "Pause") {
    await toggle.click();
    await expect(toggle).toHaveText("Play");
  }
}

async function waitForScrubberReady(page) {
  await expect
    .poll(async () => page.evaluate(() => {
      const slider = document.getElementById("video-progress-slider");
      const video = document.getElementById("video-player-media");
      return Boolean(slider && video && !slider.disabled && Number(slider.max) > 0);
    }), { timeout: 15000 })
    .toBe(true);
}

async function inflateVideoSeekableEnd(page, endSeconds) {
  await page.evaluate((end) => {
    const video = document.getElementById("video-player-media");
    if (!video) {
      throw new Error("video element missing");
    }
    const seekable = {
      length: 1,
      start(index) {
        return index === 0 ? 0 : Number.NaN;
      },
      end(index) {
        return index === 0 ? end : Number.NaN;
      },
    };
    Object.defineProperty(video, "seekable", {
      configurable: true,
      get() {
        return seekable;
      },
    });
  }, endSeconds);
}

async function scrubInSession(page, targetSeconds) {
  await pausePlayback(page);
  let sessionPosted = false;
  const onRequest = (request) => {
    if (request.method() !== "POST") return;
    if (new URL(request.url()).pathname === "/video/endpoints/session") {
      sessionPosted = true;
    }
  };
  page.on("request", onRequest);
  try {
    await page.locator("#video-progress-slider").evaluate((element, seconds) => {
      element.value = String(seconds);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }, targetSeconds);
    await page.waitForTimeout(300);
    expect(sessionPosted).toBe(false);
  } finally {
    page.off("request", onRequest);
  }
  await waitForVisibleVideo(page);
  await waitForPlaybackSurfaceWithoutOverlay(page);
  await expectPlaybackNearSeconds(page, targetSeconds, 1);
}

async function scrubInSessionForward(page, advanceSeconds = 1) {
  await pausePlayback(page);
  const state = await readPlaybackProgressState(page);
  const current = Number(state.sliderValue);
  expect(Number.isFinite(current)).toBe(true);
  const target = Math.min(7.5, current + advanceSeconds);
  await scrubInSession(page, target);
  return target;
}

async function startScrub(page, targetSeconds) {
  await page.locator("#video-progress-slider").evaluate((element, seconds) => {
    element.value = String(seconds);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, targetSeconds);
  await waitForLoadingOverlayWithoutPlaceholder(page);
}

async function startScrubInSession(page, targetSeconds) {
  await page.locator("#video-progress-slider").evaluate((element, seconds) => {
    element.value = String(seconds);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, targetSeconds);
  await page.waitForTimeout(100);
}

async function openVideoPane(page) {
  await page.goto("/?path=Videos");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await page.locator("#bottom-pane-mode").selectOption("video-player");
  await expect(page.locator("#video-player-pane")).toBeVisible();
  await loadVideoLibrary(page);
  await expect
    .poll(async () => page.locator("#video-library-tree .music-tree-song").count(), { timeout: 45000 })
    .toBeGreaterThanOrEqual(5);
  await waitForCompatibilityReady(page);
}

async function playLibraryFile(page, filename, { visibleVideoTimeout = 30000 } = {}) {
  await playLibraryFileBase(page, filename);
  await waitForLoadingOverlayWithoutPlaceholder(page);
  await expectActiveQueueTitle(page, filename);
  await waitForVisibleVideo(page, visibleVideoTimeout);
  await waitForPlaybackSurfaceWithoutOverlay(page);
}

function parseElapsedClock(text) {
  const parts = String(text || "").split(":").map(Number);
  if (parts.length !== 3 || parts.some((value) => !Number.isFinite(value))) return NaN;
  return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
}

async function readPlaybackProgressState(page) {
  return page.evaluate(() => {
    const slider = document.getElementById("video-progress-slider");
    const elapsed = document.getElementById("video-elapsed-time");
    return {
      sliderValue: slider ? Number(slider.value) : NaN,
      elapsedText: elapsed ? String(elapsed.textContent || "").trim() : "",
    };
  });
}

async function readLoadedSeekWindowState(page) {
  return page.evaluate(() => {
    const slider = document.getElementById("video-progress-slider");
    const video = document.getElementById("video-player-media");
    const style = slider ? window.getComputedStyle(slider) : null;
    let seekableEnd = NaN;
    if (video && video.seekable && video.seekable.length > 0) {
      try {
        seekableEnd = Number(video.seekable.end(video.seekable.length - 1));
      } catch (_error) {
        seekableEnd = NaN;
      }
    }
    return {
      displayedStartPercent: style ? Number.parseFloat(style.getPropertyValue("--video-progress-processed-start")) : NaN,
      displayedEndPercent: style ? Number.parseFloat(style.getPropertyValue("--video-progress-processed-end")) : NaN,
      sliderMax: slider ? Number(slider.max) : NaN,
      sliderValue: slider ? Number(slider.value) : NaN,
      seekableEnd,
    };
  });
}

async function readProgressCoverageState(page) {
  return page.evaluate(() => {
    const slider = document.getElementById("video-progress-slider");
    const style = slider ? window.getComputedStyle(slider) : null;
    return {
      mediaStart: style ? Number.parseFloat(style.getPropertyValue("--video-progress-media-start")) : NaN,
      mediaEnd: style ? Number.parseFloat(style.getPropertyValue("--video-progress-media-end")) : NaN,
      subtitleStart: style ? Number.parseFloat(style.getPropertyValue("--video-progress-subtitle-start")) : NaN,
      subtitleEnd: style ? Number.parseFloat(style.getPropertyValue("--video-progress-subtitle-end")) : NaN,
      processedStart: style ? Number.parseFloat(style.getPropertyValue("--video-progress-processed-start")) : NaN,
      processedEnd: style ? Number.parseFloat(style.getPropertyValue("--video-progress-processed-end")) : NaN,
      subtitleCoverageState: slider ? String(slider.getAttribute("data-subtitle-coverage-state") || "") : "",
      sliderMax: slider ? Number(slider.max) : NaN,
    };
  });
}

async function readSubtitleFailureState(page) {
  return page.evaluate(() => {
    function isVisible(element) {
      if (!element || element.hidden) return false;
      const style = window.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
    }
    const stage = document.getElementById("video-playback-stage");
    const banner = document.getElementById("video-subtitle-status-banner");
    const title = document.getElementById("video-subtitle-status-title");
    const meta = document.getElementById("video-subtitle-status-meta");
    const select = document.getElementById("video-subtitle-track");
    return {
      stageSubtitleState: stage ? String(stage.getAttribute("data-subtitle-state") || "") : "",
      bannerVisible: isVisible(banner),
      title: title ? String(title.textContent || "").trim() : "",
      meta: meta ? String(meta.textContent || "").trim() : "",
      selectorState: select ? String(select.getAttribute("data-subtitle-state") || "") : "",
      selectorTitle: select ? String(select.getAttribute("title") || "") : "",
    };
  });
}

function percentToSeconds(percent, maxSeconds) {
  const normalizedPercent = Number(percent);
  const normalizedMax = Number(maxSeconds);
  if (!Number.isFinite(normalizedPercent) || !Number.isFinite(normalizedMax) || normalizedMax <= 0) {
    return NaN;
  }
  return (normalizedPercent / 100) * normalizedMax;
}

async function waitForStableLoadedSeekWindowState(page, {
  timeout = 15000,
  stableMs = 400,
  toleranceSeconds = 0.1,
} = {}) {
  const deadline = Date.now() + timeout;
  let previous = null;
  let stableSince = 0;
  while (Date.now() < deadline) {
    const state = await readLoadedSeekWindowState(page);
    const displayedEndSeconds = percentToSeconds(
      state.displayedEndPercent,
      state.sliderMax,
    );
    const valid = [
      state.sliderMax,
      state.seekableEnd,
      displayedEndSeconds,
    ].every((value) => Number.isFinite(value) && value > 0);
    const unchanged = valid && previous
      && Math.abs(state.seekableEnd - previous.seekableEnd) <= toleranceSeconds
      && Math.abs(displayedEndSeconds - previous.displayedEndSeconds) <= toleranceSeconds;
    if (unchanged) {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince >= stableMs) {
        return state;
      }
    } else {
      stableSince = valid ? Date.now() : 0;
    }
    previous = {
      ...state,
      displayedEndSeconds,
    };
    await page.waitForTimeout(100);
  }
  throw new Error(`Loaded seek window did not stabilize: ${JSON.stringify(previous)}`);
}

async function expectPlaybackNearSeconds(page, targetSeconds, toleranceSeconds = 1) {
  await expect
    .poll(async () => {
      const state = await readPlaybackProgressState(page);
      const elapsedSeconds = parseElapsedClock(state.elapsedText);
      const candidates = [elapsedSeconds, Number(state.sliderValue)]
        .filter((value) => Number.isFinite(value));
      if (!candidates.length) return false;
      return candidates.some(
        (seconds) => Math.abs(seconds - targetSeconds) <= toleranceSeconds,
      );
    }, { timeout: 15000 })
    .toBe(true);
}

async function readDisplayedSubtitleDebugState(page) {
  return page.evaluate(() => {
    const currentTitle = document.getElementById("video-debug-current-title");
    const currentCue = document.getElementById("video-debug-current-cue");
    const nextTitle = document.getElementById("video-debug-next-title");
    const meta = document.getElementById("video-debug-meta");
    return {
      currentTitleText: currentTitle ? String(currentTitle.textContent || "").trim() : "",
      currentCueText: currentCue ? String(currentCue.textContent || "").trim() : "",
      nextTitleText: nextTitle ? String(nextTitle.textContent || "").trim() : "",
      metaText: meta ? String(meta.textContent || "").trim() : "",
    };
  });
}

async function waitForDisplayedSubtitleDebugText(page, expectedText) {
  await expect
    .poll(async () => {
      const state = await readDisplayedSubtitleDebugState(page);
      return state.currentCueText;
    }, { timeout: 15000 })
    .toContain(expectedText);
}

async function expectDisplayedSubtitleDebugRangeNear(page, targetSeconds, toleranceSeconds = 1.5) {
  await expect
    .poll(async () => {
      const state = await readDisplayedSubtitleDebugState(page);
      const match = state.currentCueText.match(/^(\d{2}:\d{2}:\d{2}\.\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}\.\d{3})/);
      if (!match) return false;
      const parts = match[1].split(":");
      const secondsParts = parts[2].split(".");
      const cueStartSeconds =
        (Number(parts[0]) * 3600)
        + (Number(parts[1]) * 60)
        + Number(secondsParts[0])
        + (Number(secondsParts[1]) / 1000);
      return Math.abs(cueStartSeconds - targetSeconds) <= toleranceSeconds;
    }, { timeout: 15000 })
    .toBe(true);
}

test.use({ baseURL });

test.beforeAll(async () => {
  test.setTimeout(90000);
  server = await startIntegrationServer();
});

test.beforeEach(async ({ page }) => {
  await clearActiveVideoSessionAndCache(page);
  await clearStoredTrackPreferences(page);
});

test.afterEach(async ({ page }) => {
  await clearActiveVideoSessionAndCache(page);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test.afterAll(async () => {
  await stopIntegrationServer(server);
  server = null;
});

test("video playlist labels and export filename use video terminology", async ({ page }) => {
  await openVideoPane(page);

  await expect(page.locator("#video-playlist-load")).toHaveText("Load Playlist: Videos");
  await queueLibraryFile(page, "alpha.mkv");
  await page.locator("#video-playlist-save").click();
  await page.locator("#video-playlist-rename-input").fill("Video Export");
  await page.locator("#video-playlist-rename-confirm").click();
  await expect(page.locator("#video-active-playlist-name")).toHaveText("Video Export");

  await page.locator("#video-playlist-load").click();
  await expect(page.locator("#video-playlist-load-dialog")).toBeVisible();
  await expect(page.locator("#video-playlist-load-title")).toHaveText("Load Playlist: Videos");
  await expect(
    page.locator("#video-playlist-load-list .music-playlist-load-entry").filter({hasText: "Video Export"})
      .locator(".music-playlist-load-song-count"),
  ).toHaveText("1 video");
  await page.locator("#video-playlist-load-cancel").click();

  const downloadPromise = page.waitForEvent("download", { timeout: 10000 });
  await page.locator("#video-playlist-export").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("dropbox_browser_videos_playlists.json");
});

test("video controls navigate the queue, persist loop, and wrap natural end when enabled", async ({ page }) => {
  test.setTimeout(90000);

  await installHlsStub(page);
  await openVideoPane(page);

  await expectVideoControlState(page, {
    loop: {
      disabled: false,
      label: "Loop queue",
      title: "Loop queue",
      pressed: "false",
      icon: "/assets/icons/material-icon-theme/music-loop.svg",
    },
  });

  await clickVideoControl(page, "video-loop-toggle");
  await expectVideoControlState(page, {
    loop: {
      label: "Loop queue on",
      title: "Loop queue on",
      pressed: "true",
    },
  });
  await expect
    .poll(async () => page.evaluate(() => window.localStorage.getItem("dropbox-browser.video-loop-queue")))
    .toBe("true");

  await page.reload();
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await page.locator("#bottom-pane-mode").selectOption("video-player");
  await expect(page.locator("#video-player-pane")).toBeVisible();
  await expectVideoControlState(page, { loop: { pressed: "true", label: "Loop queue on" } });

  const alphaSession = waitForSessionPost(page, (body) => body.includes("path=Videos%2Falpha.mkv"));
  await playLibraryFile(page, "alpha.mkv");
  await alphaSession;
  const alphaActiveSession = await waitForActiveVideoSession(page, "Videos/alpha.mkv");
  await queueLibraryFile(page, "bravo.mkv");
  await expectPlaylistCount(page, 2);

  const icons = await readVideoControlState(page);
  expect([
    icons.loop.icon,
    icons.previous.icon,
    icons.next.icon,
    icons.back15.icon,
    icons.forward15.icon,
  ]).toEqual([
    "/assets/icons/material-icon-theme/music-loop.svg",
    "/assets/icons/material-icon-theme/shared-prev.svg",
    "/assets/icons/material-icon-theme/shared-next.svg",
    "/assets/icons/material-icon-theme/video-back-15.svg",
    "/assets/icons/material-icon-theme/video-forward-15.svg",
  ]);
  expect(new Set([
    icons.previous.icon,
    icons.next.icon,
    icons.back15.icon,
    icons.forward15.icon,
  ]).size).toBe(4);

  await expectVideoControlState(page, {
    previous: { disabled: false, label: "Previous video", visible: true },
    next: { disabled: false, label: "Next video", visible: true },
    back15: { disabled: false, label: "Back 15 seconds", visible: true },
    forward15: { disabled: false, label: "Forward 15 seconds", visible: true },
  });

  const bravoSessionFromNext = waitForSessionPost(page, (body) => body.includes("path=Videos%2Fbravo.mkv"));
  await clickVideoControl(page, "video-next");
  await bravoSessionFromNext;
  await expectActiveQueueTitle(page, "bravo.mkv");
  await expectOnlyActiveVideoSession(page, "Videos/bravo.mkv", alphaActiveSession.session_id);

  const alphaSessionFromPrevious = waitForSessionPost(page, (body) => body.includes("path=Videos%2Falpha.mkv"));
  await clickVideoControl(page, "video-previous");
  await alphaSessionFromPrevious;
  await expectActiveQueueTitle(page, "alpha.mkv");
  await expectOnlyActiveVideoSession(page, "Videos/alpha.mkv");

  const bravoSessionFromPreviousWrap = waitForSessionPost(page, (body) => body.includes("path=Videos%2Fbravo.mkv"));
  await clickVideoControl(page, "video-previous");
  await bravoSessionFromPreviousWrap;
  await expectActiveQueueTitle(page, "bravo.mkv");
  await expectOnlyActiveVideoSession(page, "Videos/bravo.mkv");

  const alphaSessionFromLoopEnd = waitForSessionPost(page, (body) => body.includes("path=Videos%2Falpha.mkv"));
  await page.locator("#video-player-media").evaluate((video) => {
    video.dispatchEvent(new Event("ended"));
  });
  await alphaSessionFromLoopEnd;
  await expectActiveQueueTitle(page, "alpha.mkv");
  await expectOnlyActiveVideoSession(page, "Videos/alpha.mkv");

  await clickVideoControl(page, "video-loop-toggle");
  await expectVideoControlState(page, {
    loop: { pressed: "false", label: "Loop queue" },
    previous: { disabled: true },
    next: { disabled: false },
  });

  const bravoSessionFromNextAgain = waitForSessionPost(page, (body) => body.includes("path=Videos%2Fbravo.mkv"));
  await clickVideoControl(page, "video-next");
  await bravoSessionFromNextAgain;
  await expectActiveQueueTitle(page, "bravo.mkv");
  await expectOnlyActiveVideoSession(page, "Videos/bravo.mkv");
  await expectVideoControlState(page, {
    previous: { disabled: false },
    next: { disabled: true },
  });

  await page.locator("#video-player-media").evaluate((video) => {
    video.dispatchEvent(new Event("ended"));
  });
  await expect(page.locator("#video-playlist-list .music-playlist-entry.current")).toHaveCount(0);
});

test("video session cleanup stops the active session on reload", async ({ page }) => {
  test.setTimeout(90000);

  await installHlsStub(page);
  await openVideoPane(page);

  const alphaSession = waitForSessionPost(page, (body) => body.includes("path=Videos%2Falpha.mkv"));
  await playLibraryFile(page, "alpha.mkv");
  await alphaSession;
  const alphaActiveSession = await waitForActiveVideoSession(page, "Videos/alpha.mkv");

  await page.reload();
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await expect
    .poll(async () => {
      const sessions = await readActiveVideoSessions(page);
      return sessions.some((session) => session && session.session_id === alphaActiveSession.session_id);
    }, { timeout: 15000 })
    .toBe(false);
});

test("closing during session creation stops the server session before the response arrives", async ({ page }) => {
  test.setTimeout(90000);
  const playingPage = await page.context().newPage();
  let releaseResponse;
  let responseReached;
  let responseReleased = false;
  const responseReleasedPromise = new Promise((resolve) => {
    releaseResponse = () => {
      if (responseReleased) return;
      responseReleased = true;
      resolve();
    };
  });
  const responseReachedPromise = new Promise((resolve) => {
    responseReached = resolve;
  });
  try {
    await playingPage.route("**/video/endpoints/session", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const body = await response.body();
      responseReached();
      await responseReleasedPromise;
      try {
        await route.fulfill({
          status: response.status(),
          headers: response.headers(),
          body,
        });
      }
      catch (_error) {
        // Closing the page may cancel the held browser response.
      }
    });
    await installHlsStub(playingPage);
    await openVideoPane(playingPage);

    const alphaRow = await libraryRow(playingPage, "alpha.mkv");
    await alphaRow.dblclick();
    await expectActiveQueueTitle(playingPage, "alpha.mkv");
    await responseReachedPromise;
    const serverSession = await waitForActiveVideoSession(page, "Videos/alpha.mkv");

    await playingPage.close();
    releaseResponse();
    await expect
      .poll(async () => {
        const sessions = await readActiveVideoSessions(page);
        return sessions.some((session) => session && session.session_id === serverSession.session_id);
      }, { timeout: 15000 })
      .toBe(false);
  }
  finally {
    releaseResponse();
    if (!playingPage.isClosed()) await playingPage.close();
  }
});

test("rapid next and previous navigation keeps the final subtitle item isolated", async ({ page }) => {
  test.setTimeout(90000);

  await page.route("**/video/endpoints/session/stop", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await route.continue();
  });
  await installHlsStub(page);
  await openVideoPane(page);

  const alphaSession = waitForSessionPost(page, (body) => body.includes("path=Videos%2Falpha.mkv"));
  await playLibraryFile(page, "alpha.mkv");
  await alphaSession;
  await selectTrackOption(page, "#video-subtitle-track", "4");
  await waitForSubtitleStreamIndex(page, 4);
  await waitForMountedSubtitleTrackReady(page, 4);
  await setPlaybackTimeForSubtitleChecks(page, 1);
  await waitForNativeSubtitleCueText(page, "ALPHA-SUBTITLE-FRA");

  await queueLibraryFile(page, "bravo.mkv");
  await expectVideoControlState(page, {
    next: {disabled: false},
  });
  const bravoSession = waitForSessionPost(page, (body) => body.includes("path=Videos%2Fbravo.mkv"));
  const finalAlphaSession = waitForSessionPost(page, (body) => body.includes("path=Videos%2Falpha.mkv"));
  await page.locator("#video-next").click();
  const bravoRequest = await bravoSession;
  const bravoParams = new URLSearchParams(bravoRequest.postData() || "");
  const bravoTransitionToken = Number(bravoParams.get("transition_token"));
  expect(Number.isSafeInteger(bravoTransitionToken)).toBe(true);
  await expectVideoControlState(page, {previous: {disabled: false}});
  await page.locator("#video-previous").click();
  const finalAlphaRequest = await finalAlphaSession;
  const finalAlphaClientId = new URLSearchParams(finalAlphaRequest.postData() || "").get("client_id") || "";
  const finalAlphaTransitionToken = Number(
    new URLSearchParams(finalAlphaRequest.postData() || "").get("transition_token"),
  );
  expect(finalAlphaTransitionToken).toBeGreaterThan(bravoTransitionToken);

  await expectActiveQueueTitle(page, "alpha.mkv");
  await expectOnlyActiveVideoClientSession(page, "Videos/alpha.mkv", finalAlphaClientId);
  await waitForVisibleVideo(page);
  await waitForPlaybackSurfaceWithoutOverlay(page);
  await expectNativeSubtitleSurfaceClearOf(page, ["BRAVO-SUBTITLE-FRA", "BRAVO-SUBTITLE-ENG"]);
  await setPlaybackTimeForSubtitleChecks(page, 1);
  await waitForNativeSubtitleCueText(page, "ALPHA-SUBTITLE-FRA");
});

test("delayed prior client stop cannot stop a newer session", async ({ page }) => {
  test.setTimeout(90000);
  const clientId = "e2e-transition-order-client";
  const createSession = (transitionToken) => page.evaluate(async ({clientId: id, transitionToken: token}) => {
    const body = new URLSearchParams({
      path: "Videos/alpha.mkv",
      source: "remote",
      client_id: id,
      transition_token: String(token),
    });
    const response = await fetch("/video/endpoints/session", {
      method: "POST",
      headers: {"Content-Type": "application/x-www-form-urlencoded; charset=utf-8"},
      body,
    });
    return {ok: response.ok, payload: await response.json()};
  }, {clientId, transitionToken});

  await page.goto("/");
  const firstSession = await createSession(1);
  expect(firstSession.ok).toBe(true);

  let releaseFirstStop;
  let firstStopSeen;
  const firstStopReleased = new Promise((resolve) => {
    releaseFirstStop = resolve;
  });
  const firstStopSeenPromise = new Promise((resolve) => {
    firstStopSeen = resolve;
  });
  await page.route("**/video/endpoints/session/stop", async (route) => {
    firstStopSeen();
    await firstStopReleased;
    await route.continue();
  });

  const priorStop = page.evaluate(async (id) => {
    const body = new URLSearchParams({client_id: id, transition_token: "1"});
    const response = await fetch("/video/endpoints/session/stop", {
      method: "POST",
      headers: {"Content-Type": "application/x-www-form-urlencoded; charset=utf-8"},
      body,
    });
    return {ok: response.ok, payload: await response.json()};
  }, clientId);
  await firstStopSeenPromise;

  const finalSession = await createSession(2);
  expect(finalSession.ok).toBe(true);
  expect(finalSession.payload.session_id).not.toBe(firstSession.payload.session_id);

  releaseFirstStop();
  const priorStopResult = await priorStop;
  expect(priorStopResult.ok).toBe(true);
  await expect
    .poll(async () => {
      const sessions = await readActiveVideoSessions(page);
      return sessions.some((session) => session && session.session_id === finalSession.payload.session_id);
    }, {timeout: 15000})
    .toBe(true);
});

test("switching during delayed subtitle extraction ignores the old item response", async ({ page }) => {
  test.setTimeout(90000);

  await page.route("**/video/endpoints/subtitles/all**", async (route) => {
    const path = new URL(route.request().url()).searchParams.get("path") || "";
    if (path !== "Videos/alpha.mkv") {
      await route.continue();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  await installHlsStub(page);
  await openVideoPane(page);

  const alphaSession = waitForSessionPost(page, (body) => body.includes("path=Videos%2Falpha.mkv"));
  const alphaSubtitleRequest = page.waitForRequest((request) => {
    if (request.method() !== "GET" || !request.url().includes("/video/endpoints/subtitles/all")) return false;
    return (new URL(request.url()).searchParams.get("path") || "") === "Videos/alpha.mkv";
  }, {timeout: 15000});
  await playLibraryFile(page, "alpha.mkv");
  await alphaSession;
  await alphaSubtitleRequest;

  const bravoSession = waitForSessionPost(page, (body) => body.includes("path=Videos%2Fbravo.mkv"));
  await playLibraryFile(page, "bravo.mkv");
  await bravoSession;
  await expectActiveQueueTitle(page, "bravo.mkv");
  await waitForVisibleVideo(page);
  await waitForPlaybackSurfaceWithoutOverlay(page);
  await selectTrackOption(page, "#video-subtitle-track", "4");
  await waitForSubtitleStreamIndex(page, 4);
  await waitForMountedSubtitleTrackReady(page, 4);
  await setPlaybackTimeForSubtitleChecks(page, 1);
  await waitForNativeSubtitleCueText(page, "BRAVO-SUBTITLE-FRA");
  await expectNativeSubtitleSurfaceClearOf(page, ["ALPHA-SUBTITLE-FRA", "ALPHA-SUBTITLE-ENG"]);
});

test("video controls seek backward and forward by 15 seconds in embedded playback", async ({ page }) => {
  test.setTimeout(90000);

  await installHlsStub(page, { fragmentCount: 4, playlistFragmentCount: 5 });
  await openVideoPane(page);

  const seekSession = waitForSessionPost(page, (body) => body.includes("path=Videos%2Fseek-window.mkv"));
  await playLibraryFile(page, "seek-window.mkv");
  await seekSession;
  await waitForScrubberReady(page);
  await pausePlayback(page);

  await setMediaPlaybackTime(page, 18);
  await expectPlaybackNearSeconds(page, 18, 1);
  await clickVideoControl(page, "video-back-15");
  await expectPlaybackNearSeconds(page, 3, 1);

  await clickVideoControl(page, "video-forward-15");
  await expectPlaybackNearSeconds(page, 18, 1);
  await expectControlsOverlayVisible(page);
  await page.locator("#video-playback-surface").click();

  await setMediaPlaybackTime(page, 18);
  await expectPlaybackNearSeconds(page, 18, 1);
  await page.keyboard.press("ArrowLeft");
  await expectPlaybackNearSeconds(page, 3, 1);

  await page.keyboard.press("ArrowRight");
  await expectPlaybackNearSeconds(page, 18, 1);
  await expectControlsOverlayVisible(page);
});

test("video Space shortcut toggles playback in embedded and fullscreen modes without hijacking text inputs", async ({ page }) => {
  test.setTimeout(90000);

  await installHlsStub(page, { fragmentCount: 4, playlistFragmentCount: 5 });
  await openVideoPane(page);

  const alphaSession = waitForSessionPost(page, (body) => body.includes("path=Videos%2Falpha.mkv"));
  await playLibraryFile(page, "alpha.mkv");
  await alphaSession;
  await waitForScrubberReady(page);

  await expectPlayToggleState(page, "Pause");
  await page.keyboard.press("Space");
  await expectPlayToggleState(page, "Play");
  await page.keyboard.press("Space");
  await expectPlayToggleState(page, "Pause");

  await ensureTrackPanelOpen(page);
  await page.locator("#video-subtitle-font-size").focus();
  await page.keyboard.press("Space");
  await expectPlayToggleState(page, "Pause");

  const surface = page.locator("#video-playback-surface");
  await surface.hover({ position: { x: 40, y: 40 } });
  await expectControlsOverlayVisible(page);
  await surface.dblclick({ position: { x: 48, y: 48 } });

  await expect
    .poll(async () => readFullscreenPlaybackState(page), { timeout: 10000 })
    .toMatchObject({
      fullscreenElementId: "video-playback-stage",
      fullscreenLabel: "Exit fullscreen",
    });

  await page.keyboard.press("Space");
  await expectPlayToggleState(page, "Play");
  await page.keyboard.press("Space");
  await expectPlayToggleState(page, "Pause");

  await page.evaluate(async () => {
    if (document.fullscreenElement && typeof document.exitFullscreen === "function") {
      await document.exitFullscreen();
    }
  });
});

test("video controls stay visible and usable in fullscreen", async ({ page }) => {
  test.setTimeout(90000);

  await installHlsStub(page, { fragmentCount: 4, playlistFragmentCount: 5 });
  await openVideoPane(page);

  const alphaSession = waitForSessionPost(page, (body) => body.includes("path=Videos%2Falpha.mkv"));
  await playLibraryFile(page, "alpha.mkv");
  await alphaSession;
  await queueLibraryFile(page, "bravo.mkv");
  await waitForScrubberReady(page);

  const surface = page.locator("#video-playback-surface");
  await surface.hover({ position: { x: 40, y: 40 } });
  await expectControlsOverlayVisible(page);
  await surface.dblclick({ position: { x: 48, y: 48 } });

  await expect
    .poll(async () => readFullscreenPlaybackState(page), { timeout: 10000 })
    .toMatchObject({
      fullscreenElementId: "video-playback-stage",
      stageVisible: true,
      overlayVisible: true,
      sliderVisible: true,
      sliderDisabled: false,
      fullscreenLabel: "Exit fullscreen",
      overlappingControlPairs: [],
      playBeforeBack15: true,
      loopBeforePrevious: true,
      previousBeforeNext: true,
      back15BeforeForward15: true,
      forward15BeforeMute: true,
      nextBeforeFullWindow: true,
      forward15BeforeFullWindow: true,
      fullWindowBeforeFullscreen: true,
    });

  await expectVideoControlState(page, {
    loop: { visible: true, disabled: false },
    previous: { visible: true, disabled: true },
    next: { visible: true, disabled: false },
    back15: { visible: true, disabled: false },
    forward15: { visible: true, disabled: false },
  });

  await clickVideoControl(page, "video-loop-toggle");
  await expectVideoControlState(page, { loop: { pressed: "true" }, previous: { disabled: false } });

  const bravoSession = waitForSessionPost(page, (body) => body.includes("path=Videos%2Fbravo.mkv"));
  await clickVideoControl(page, "video-next");
  await bravoSession;
  await expectActiveQueueTitle(page, "bravo.mkv");

  const alphaSessionFromPrevious = waitForSessionPost(page, (body) => body.includes("path=Videos%2Falpha.mkv"));
  await clickVideoControl(page, "video-previous");
  await alphaSessionFromPrevious;
  await expectActiveQueueTitle(page, "alpha.mkv");

  await setMediaPlaybackTime(page, 18);
  await clickVideoControl(page, "video-back-15");
  await expectPlaybackNearSeconds(page, 3, 1);

  await page.evaluate(async () => {
    if (document.fullscreenElement && typeof document.exitFullscreen === "function") {
      await document.exitFullscreen();
    }
  });
  await expect
    .poll(async () => readFullscreenPlaybackState(page), { timeout: 10000 })
    .toMatchObject({
      fullscreenElementId: "",
      fullscreenLabel: "Fullscreen",
    });
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
  await waitForMountedSubtitleTrackReady(page, 3);
  await setPlaybackTimeForSubtitleChecks(page, 1);
  await waitForDisplayedSubtitleText(page, "ALPHA-SUBTITLE-ENG");
  await waitForSubtitleOverlayMarkup(page, {
    tagName: "i",
    expectedText: "ALPHA-SUBTITLE-ENG",
  });
  await expect(page.locator("#video-player-status")).not.toContainText("Compatibility playback failed");

  await selectTrackOption(page, "#video-subtitle-track", "4");
  await waitForSubtitleStreamIndex(page, 4);
  await expectTrackSelectors(page, { subtitleValue: "4" });
  await waitForMountedSubtitleTrackReady(page, 4);
  await setPlaybackTimeForSubtitleChecks(page, 1);
  await waitForDisplayedSubtitleText(page, "ALPHA-SUBTITLE-FRA");
  await waitForNativeSubtitleCueText(page, "ALPHA-SUBTITLE-FRA");
  await waitForSubtitleOverlayMarkup(page, {
    tagName: "b",
    expectedText: "ALPHA-SUBTITLE-FRA",
  });
  await page.waitForTimeout(500);

  await page.evaluate(() => {
    window.__subtitleTeardownEvents = [];
  });

  const staleAlphaSubtitleTexts = ["ALPHA-SUBTITLE-FRA", "ALPHA-SUBTITLE-ENG"];
  const bravoSession = waitForSessionPost(page, (body) => body.includes("path=Videos%2Fbravo.mkv"));
  await armSubtitleStaleMonitor(page, staleAlphaSubtitleTexts);
  await bravoRow.dblclick();
  await waitForDisplayedSubtitleToClear(page);
  await expectNativeSubtitleSurfaceClearOf(page, staleAlphaSubtitleTexts);
  await bravoSession;

  await expect
    .poll(async () => {
      const events = await page.evaluate(() => window.__subtitleTeardownEvents || []);
      return events.length;
    }, { timeout: 10000 })
    .toBeGreaterThan(0);
  const teardownEvents = await page.evaluate(() => window.__subtitleTeardownEvents || []);
  expect(teardownEvents.every((event) => event.videoHidden)).toBe(true);

  await expectActiveQueueTitle(page, "bravo.mkv");
  await expectNoStaleNativeSubtitleOnVideoResume(page, staleAlphaSubtitleTexts);

  await waitForVisibleVideo(page);
  await waitForPlaybackSurfaceWithoutOverlay(page);
  await setPlaybackTimeForSubtitleChecks(page, 0.5);
  await expectNativeSubtitleSurfaceClearOf(page, staleAlphaSubtitleTexts);
  await expectNoSubtitleStaleMonitorViolations(page);
  for (const event of teardownEvents) {
    const staleAtTeardown = staleAlphaSubtitleTexts.filter((text) => String(event.nativeHaystack || "").includes(text));
    expect(staleAtTeardown, JSON.stringify(event)).toEqual([]);
  }
  await expectTrackSelectors(page, {
    audioOptionCount: 2,
    subtitleOptionCount: 4,
    audioValue: "1",
    subtitleValue: "4",
  });
  await waitForSubtitleStreamIndex(page, 4);
  await waitForMountedSubtitleTrackReady(page, 4);
  await waitForNativeSubtitleCueText(page, "BRAVO-SUBTITLE-FRA");

  await scrubInSessionForward(page, 1);
  await expectTrackSelectors(page, { audioValue: "1", subtitleValue: "4" });
  await waitForSubtitleStreamIndex(page, 4);

  const bravoAudioRestart = waitForSessionPost(
    page,
    (body) => body.includes("path=Videos%2Fbravo.mkv") && body.includes("audio_stream_index=2"),
  );
  await selectTrackOption(page, "#video-audio-track", "2");
  await waitForLoadingOverlayWithoutPlaceholder(page);
  await bravoAudioRestart;
  await waitForVisibleVideo(page);
  await waitForPlaybackSurfaceWithoutOverlay(page);
  await expectTrackSelectors(page, { audioValue: "2", subtitleValue: "4" });
  await waitForSubtitleStreamIndex(page, 4);

  await scrubInSessionForward(page, 1);
  await expectTrackSelectors(page, { audioValue: "2", subtitleValue: "4" });
  await waitForSubtitleStreamIndex(page, 4);

  await selectTrackOption(page, "#video-subtitle-track", "");
  await expectNoMountedSubtitleTrack(page);
  await expectTrackSelectors(page, { subtitleValue: "" });

  await selectTrackOption(page, "#video-subtitle-track", "3");
  await waitForSubtitleStreamIndex(page, 3);
  await expectTrackSelectors(page, { subtitleValue: "3" });
});

test("empty successful subtitle batch preload falls back to per-track extraction", async ({ page }) => {
  test.setTimeout(60000);

  await installHlsStub(page);
  await page.route("**/video/endpoints/subtitles/all?path=Videos%2Falpha.mkv&source=remote", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ok", tracks: {} }),
    });
  });
  await openVideoPane(page);

  const subtitleTrackFetch = page.waitForRequest((request) => {
    return request.method() === "GET"
      && request.url().includes("/video/endpoints/subtitles?path=Videos%2Falpha.mkv&source=remote&track=3");
  });

  const initialSession = waitForSessionPost(page, (body) => body.includes("path=Videos%2Falpha.mkv"));
  await playLibraryFile(page, "alpha.mkv");
  await initialSession;
  await subtitleTrackFetch;

  await expectTrackSelectors(page, {
    audioOptionCount: 2,
    subtitleOptionCount: 4,
    audioValue: "1",
    subtitleValue: "3",
  });
  await waitForSubtitleStreamIndex(page, 3);
  await waitForMountedSubtitleTrackReady(page, 3);
  await setPlaybackTimeForSubtitleChecks(page, 1);
  await waitForDisplayedSubtitleText(page, "ALPHA-SUBTITLE-ENG");
  await waitForNativeSubtitleCueText(page, "ALPHA-SUBTITLE-ENG");
});

test("ASS subtitles are converted into clean browser-rendered WebVTT cues", async ({ page }) => {
  test.setTimeout(90000);

  await installHlsStub(page);
  await openVideoPane(page);

  const probeResponse = await page.request.get("/video/endpoints/probe?path=Videos%2Fass-fruits.mkv&source=remote");
  expect(probeResponse.ok()).toBe(true);
  const probePayload = await probeResponse.json();
  expect(probePayload.subtitle_streams).toHaveLength(1);
  expect(probePayload.subtitle_streams[0].codec_name).toBe("ass");
  expect(probePayload.default_subtitle_stream_index).toBe(3);

  const allSubtitlesResponse = await page.request.get("/video/endpoints/subtitles/all?path=Videos%2Fass-fruits.mkv&source=remote");
  expect(allSubtitlesResponse.ok()).toBe(true);
  const allSubtitlesPayload = await allSubtitlesResponse.json();
  expect(Object.keys(allSubtitlesPayload.tracks)).toEqual(["3"]);
  const assVtt = String(allSubtitlesPayload.tracks["3"].vtt || "");
  expect(assVtt).toContain("Logo");
  expect(assVtt).toContain("Mine and Mine Alone");
  expect(assVtt).toContain("First line\nSecond line");
  expect(assVtt).toContain("<i>Italic</i><b>Bold</b><u>Underline</u>");
  expect(assVtt).not.toContain("\\pos");
  expect(assVtt).not.toContain("\\fad");
  expect(assVtt).not.toContain("{*");
  expect(assVtt).not.toContain("m 0 0 l 50 0 50 20 0 20");

  const initialSession = waitForSessionPost(page, (body) => body.includes("path=Videos%2Fass-fruits.mkv"));
  await playLibraryFile(page, "ass-fruits.mkv");
  await initialSession;

  await expectTrackSelectors(page, {
    audioOptionCount: 2,
    subtitleOptionCount: 2,
    audioValue: "1",
    subtitleValue: "3",
  });
  await waitForSubtitleStreamIndex(page, 3);
  await waitForMountedSubtitleTrackReady(page, 3);

  await setPlaybackTimeForSubtitleChecks(page, 1.0);
  await waitForDisplayedSubtitleText(page, "Logo");
  await waitForNativeSubtitleCueText(page, "Logo");
  await waitForSubtitleOverlayText(page, "Logo");
  let overlayState = await readSubtitleOverlayState(page);
  expect(overlayState.text).toContain("Logo");
  expect(overlayState.html).not.toContain("\\pos");
  expect(overlayState.html).not.toContain("frz3.2");

  await setPlaybackTimeForSubtitleChecks(page, 2.3);
  await waitForDisplayedSubtitleToClear(page);
  await expectNativeSubtitleSurfaceClearOf(page, ["Logo", "Mine and Mine Alone", "First line", "Italic"]);

  await setPlaybackTimeForSubtitleChecks(page, 3.4);
  await waitForDisplayedSubtitleText(page, "Mine and Mine Alone");
  await waitForNativeSubtitleCueText(page, "Mine and Mine Alone");
  await waitForSubtitleOverlayText(page, "Mine and Mine Alone");
  overlayState = await readSubtitleOverlayState(page);
  expect(overlayState.text).toContain("Mine and Mine Alone");
  expect(overlayState.html).not.toContain("\\fad");
  expect(overlayState.html).not.toContain("{*");

  await setPlaybackTimeForSubtitleChecks(page, 5.2);
  await waitForDisplayedSubtitleText(page, "First line");
  await waitForNativeSubtitleCueText(page, "First line");
  await waitForSubtitleOverlayText(page, "Second line");
  overlayState = await readSubtitleOverlayState(page);
  expect(overlayState.text).toContain("First line");
  expect(overlayState.text).toContain("Second line");

  await setPlaybackTimeForSubtitleChecks(page, 6.8);
  await waitForDisplayedSubtitleText(page, "Italic");
  await waitForNativeSubtitleCueText(page, "Italic");
  await waitForSubtitleOverlayMarkup(page, {
    tagName: "i",
    expectedText: "Italic",
  });
  await waitForSubtitleOverlayMarkup(page, {
    tagName: "b",
    expectedText: "Bold",
  });
  await waitForSubtitleOverlayMarkup(page, {
    tagName: "u",
    expectedText: "Underline",
  });
});

test("WebVTT subtitle debug timing stays aligned after in-session scrub remount", async ({ page }) => {
  test.setTimeout(90000);

  await openVideoPane(page);

  const initialSession = waitForSessionPost(page, (body) => body.includes("path=Videos%2Foffset.mkv"));
  // This real-media startup can follow a serial run of FFmpeg-backed tests;
  // keep the normal playback wait unchanged while allowing its surface reveal
  // to finish after the session response has already hidden the placeholder.
  await playLibraryFile(page, "offset.mkv", { visibleVideoTimeout: 60000 });
  await initialSession;

  await expectTrackSelectors(page, {
    audioOptionCount: 2,
    subtitleOptionCount: 4,
    audioValue: "1",
    subtitleValue: "3",
  });
  await waitForSubtitleStreamIndex(page, 3);
  await waitForMountedSubtitleTrackReady(page, 3);

  await page.locator("#video-progress-slider").evaluate((element) => {
    element.value = "4.8";
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });

  await waitForVisibleVideo(page);
  await waitForPlaybackSurfaceWithoutOverlay(page);
  await expectPlaybackNearSeconds(page, 4.8, 0.75);
  await waitForDisplayedSubtitleDebugText(page, "OFFSET-SUBTITLE-ENG");
  await waitForNativeSubtitleCueText(page, "OFFSET-SUBTITLE-ENG");
  await expectDisplayedSubtitleDebugRangeNear(page, 4.8, 1.5);
});

test("WebVTT subtitle timing stays aligned after restart at offset and later in-session scrub", async ({ page }) => {
  test.setTimeout(90000);

  await page.route("**/video/endpoints/session", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const body = route.request().postData() || "";
    if (!(body.includes("path=Videos%2Foffset.mkv") && body.includes("start_time_seconds=0"))) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const payload = await response.json();
    payload.encoded_media_end_seconds = 2;
    await route.fulfill({
      status: response.status(),
      headers: response.headers(),
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
  });

  await openVideoPane(page);

  const initialSession = waitForSessionPost(
    page,
    (body) => body.includes("path=Videos%2Foffset.mkv") && body.includes("start_time_seconds=0"),
  );
  await playLibraryFile(page, "offset.mkv");
  await initialSession;

  await expectTrackSelectors(page, {
    audioOptionCount: 2,
    subtitleOptionCount: 4,
    audioValue: "1",
    subtitleValue: "3",
  });
  await waitForSubtitleStreamIndex(page, 3);
  await waitForMountedSubtitleTrackReady(page, 3);

  // Force the first scrub down the restart path even if the session encodes
  // farther ahead before the test can move the slider.
  await inflateVideoSeekableEnd(page, 2);
  await scrubTo(
    page,
    7,
    (body) => body.includes("path=Videos%2Foffset.mkv") && body.includes("start_time_seconds=7"),
  );
  await expectPlaybackNearSeconds(page, 7, 0.75);
  await waitForDisplayedSubtitleDebugText(page, "OFFSET-SUBTITLE-ENG AGAIN");
  await waitForNativeSubtitleCueText(page, "OFFSET-SUBTITLE-ENG AGAIN");
  await expectDisplayedSubtitleDebugRangeNear(page, 7, 1.5);

  await inflateVideoSeekableEnd(page, 12);
  await scrubInSession(page, 7.8);
  await expectPlaybackNearSeconds(page, 7.8, 0.75);
  await waitForDisplayedSubtitleDebugText(page, "OFFSET-SUBTITLE-ENG AGAIN");
  await waitForNativeSubtitleCueText(page, "OFFSET-SUBTITLE-ENG AGAIN");
  await expectDisplayedSubtitleDebugRangeNear(page, 7.8, 1.5);
});

test("automatic playlist next clears old subtitles and mounts the next video track", async ({ page }) => {
  test.setTimeout(90000);

  await page.addInitScript(TRACK_REMOVAL_INSTRUMENTATION);
  await installSubtitleStaleMonitor(page);
  await openVideoPane(page);

  const alphaSession = waitForSessionPost(page, (body) => body.includes("path=Videos%2Falpha.mkv"));
  await playLibraryFile(page, "alpha.mkv");
  await alphaSession;
  await selectTrackOption(page, "#video-subtitle-track", "4");
  await waitForSubtitleStreamIndex(page, 4);
  await waitForMountedSubtitleTrackReady(page, 4);
  await setPlaybackTimeForSubtitleChecks(page, 1);
  await waitForDisplayedSubtitleText(page, "ALPHA-SUBTITLE-FRA");
  await waitForNativeSubtitleCueText(page, "ALPHA-SUBTITLE-FRA");

  await queueLibraryFile(page, "bravo.mkv");
  await expectPlaylistCount(page, 2);

  await page.evaluate(() => {
    window.__subtitleTeardownEvents = [];
  });
  const staleAlphaSubtitleTexts = ["ALPHA-SUBTITLE-FRA", "ALPHA-SUBTITLE-ENG"];
  await armSubtitleStaleMonitor(page, staleAlphaSubtitleTexts);
  const bravoSession = waitForSessionPost(page, (body) => body.includes("path=Videos%2Fbravo.mkv"));
  await page.evaluate(() => {
    const video = document.getElementById("video-player-media");
    if (!video) throw new Error("video element missing");
    video.dispatchEvent(new Event("ended"));
  });
  await waitForLoadingOverlayWithoutPlaceholder(page);
  await waitForDisplayedSubtitleToClear(page);
  await expectNativeSubtitleSurfaceClearOf(page, staleAlphaSubtitleTexts);
  const bravoSessionRequest = await bravoSession;
  const bravoSessionResponse = await bravoSessionRequest.response();
  if (!bravoSessionResponse) throw new Error("Bravo session response was unavailable.");
  const bravoSessionPayload = await bravoSessionResponse.json();
  await expectActiveQueueTitle(page, "bravo.mkv");
  await waitForVisibleVideo(page);
  await waitForPlaybackSurfaceWithoutOverlay(page);
  await expectOnlyActiveVideoSession(page, "Videos/bravo.mkv", undefined, bravoSessionPayload.session_id);
  await expectTrackSelectors(page, { subtitleValue: "4" });
  await waitForSubtitleStreamIndex(page, 4);
  await waitForMountedSubtitleTrackReady(page, 4);
  await setPlaybackTimeForSubtitleChecks(page, 1);
  await waitForDisplayedSubtitleText(page, "BRAVO-SUBTITLE-FRA");
  await waitForNativeSubtitleCueText(page, "BRAVO-SUBTITLE-FRA");
  await expectNoSubtitleStaleMonitorViolations(page);
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

  await waitForPlaybackSurfaceWithoutOverlay(page);
  const alphaPlayText = await playbackStageInnerText(page);
  expect(alphaPlayText).not.toContain("Playing through a local HLS compatibility session.");
  expect(alphaPlayText).not.toContain("alpha.mkv");
  await selectTrackOption(page, "#video-subtitle-track", "4");
  await waitForSubtitleStreamIndex(page, 4);
  await expectNoPlaybackSurfaceViolations(page);

  await scrubInSessionForward(page, 1);

  const bravoRow = await libraryRow(page, "bravo.mkv");
  await expect(bravoRow).toBeVisible();
  await bravoRow.dblclick();
  await waitForLoadingOverlayWithoutPlaceholder(page);
  await expectActiveQueueTitle(page, "bravo.mkv");
  await expect
    .poll(async () => playbackStageInnerText(page), { timeout: 10000 })
    .toContain("Creating the local HLS compatibility session.");
  const bravoLoadingText = await playbackStageInnerText(page);
  expect(bravoLoadingText).not.toContain("Preparing an HLS compatibility session for this queue item.");
  expect(countOccurrences(bravoLoadingText, "bravo.mkv")).toBe(1);
  await expectControlsOverlayUsableDuringLoading(page, "Creating the local HLS compatibility session.");

  await waitForPlaybackSurfaceWithoutOverlay(page);
  const bravoPlayText = await playbackStageInnerText(page);
  expect(bravoPlayText).not.toContain("Playing through a local HLS compatibility session.");
  expect(bravoPlayText).not.toContain("bravo.mkv");
  await expectNoPlaybackSurfaceViolations(page);
});

test("forward scrub beyond encoded range keeps the requested playback position", async ({ page }) => {
  test.setTimeout(90000);

  const sessionPosts = [];
  page.on("request", (request) => {
    if (request.url().includes("/video/endpoints/session") && request.method() === "POST") {
      sessionPosts.push(request.postData() || "");
    }
  });

  await page.route("**/video/endpoints/session", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const payload = await response.json();
    const body = route.request().postData() || "";
    if (body.includes("start_time_seconds=0")) {
      payload.encoded_media_end_seconds = 6;
    }
    await route.fulfill({
      status: response.status(),
      headers: response.headers(),
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
  });

  await installHlsStub(page, { fragmentCount: 1 });
  await openVideoPane(page);
  const alphaRow = await libraryRow(page, "alpha.mkv");
  const initialSession = waitForSessionPost(
    page,
    (body) => body.includes("path=Videos%2Falpha.mkv") && body.includes("start_time_seconds=0"),
  );
  await expect(alphaRow).toBeVisible();
  await alphaRow.dblclick();
  await waitForLoadingOverlayWithoutPlaceholder(page);
  await initialSession;
  await waitForScrubberReady(page);
  await pausePlayback(page);

  const postsBeforeScrub = sessionPosts.length;
  const restartSession = waitForSessionPost(
    page,
    (body) => body.includes("path=Videos%2Falpha.mkv") && body.includes("start_time_seconds=7"),
  );
  await page.locator("#video-progress-slider").evaluate((element) => {
    element.value = "7";
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await restartSession;
  await waitForLoadingOverlayWithoutPlaceholder(page);
  await waitForVisibleVideo(page);
  await waitForPlaybackSurfaceWithoutOverlay(page);
  await expectPlaybackNearSeconds(page, 7, 1);

  const postsAfterScrub = sessionPosts.slice(postsBeforeScrub);
  expect(postsAfterScrub.some((body) => body.includes("start_time_seconds=7"))).toBe(true);
  expect(postsAfterScrub.some((body) => /start_time_seconds=0(?:&|$)/.test(body))).toBe(false);
});

test("scrub beyond tracked encoded range restarts when seekable overstates duration", async ({ page }) => {
  test.setTimeout(90000);

  const sessionPosts = [];
  page.on("request", (request) => {
    if (request.url().includes("/video/endpoints/session") && request.method() === "POST") {
      sessionPosts.push(request.postData() || "");
    }
  });

  await page.route("**/video/endpoints/session", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const payload = await response.json();
    const body = route.request().postData() || "";
    if (body.includes("start_time_seconds=0")) {
      payload.encoded_media_end_seconds = 6;
    }
    await route.fulfill({
      status: response.status(),
      headers: response.headers(),
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
  });

  await installHlsStub(page, { fragmentCount: 1 });
  await openVideoPane(page);
  const alphaRow = await libraryRow(page, "alpha.mkv");
  const initialSession = waitForSessionPost(
    page,
    (body) => body.includes("path=Videos%2Falpha.mkv") && body.includes("start_time_seconds=0"),
  );
  await expect(alphaRow).toBeVisible();
  await alphaRow.dblclick();
  await waitForLoadingOverlayWithoutPlaceholder(page);
  await initialSession;
  await waitForScrubberReady(page);
  await pausePlayback(page);
  await inflateVideoSeekableEnd(page, 1500);

  const postsBeforeScrub = sessionPosts.length;
  const restartSession = waitForSessionPost(
    page,
    (body) => body.includes("path=Videos%2Falpha.mkv") && body.includes("start_time_seconds=7"),
  );
  await page.locator("#video-progress-slider").evaluate((element) => {
    element.value = "7";
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await restartSession;
  await waitForLoadingOverlayWithoutPlaceholder(page);
  await waitForVisibleVideo(page);
  await waitForPlaybackSurfaceWithoutOverlay(page);
  await expectPlaybackNearSeconds(page, 7, 1);

  const postsAfterScrub = sessionPosts.slice(postsBeforeScrub);
  expect(postsAfterScrub.some((body) => body.includes("start_time_seconds=7"))).toBe(true);
  expect(postsAfterScrub.some((body) => /start_time_seconds=0(?:&|$)/.test(body))).toBe(false);
});

test("fairy-tail-like PGS burned-in subtitle session creates successfully", async ({ page }) => {
  test.setTimeout(90000);

  const clearResponse = await page.request.post("/video/endpoints/cache/clear");
  expect(clearResponse.ok()).toBe(true);

  const probeResponse = await page.request.get("/video/endpoints/probe?path=Videos%2Ffairy-tail-like.mkv&source=remote");
  expect(probeResponse.ok()).toBe(true);
  const probePayload = await probeResponse.json();
  expect(probePayload.video_streams.map((stream) => stream.codec_name)).toEqual(["hevc"]);
  expect(probePayload.audio_streams.map((stream) => stream.codec_name)).toEqual(["opus", "opus"]);
  expect(probePayload.subtitle_streams.map((stream) => stream.codec_name)).toEqual([
    "hdmv_pgs_subtitle",
    "hdmv_pgs_subtitle",
  ]);
  expect(probePayload.default_audio_stream_index).toBe(1);
  expect(probePayload.default_subtitle_stream_index).toBe(null);
  expect(probePayload.subtitle_off_default).toBe(true);

  const sessionResponse = await page.request.post("/video/endpoints/session", {
    form: {
      path: "Videos/fairy-tail-like.mkv",
      source: "remote",
      audio_stream_index: "2",
      subtitle_stream_index: "4",
      subtitle_shadow_enabled: "1",
      subtitle_stroke_enabled: "1",
      start_time_seconds: "0",
    },
  });
  expect(sessionResponse.ok()).toBe(true);

  const sessionPayload = await sessionResponse.json();
  expect(sessionPayload.video_mode).toBe("video_transcode");
  expect(sessionPayload.video_mode_reason).toBe("subtitle_burn_in_requires_filter");
  expect(sessionPayload.audio_mode).toBe("audio_transcode");
  expect(sessionPayload.audio_mode_reason).toBe("audio_codec_not_aac");
  expect(Number(sessionPayload.encoded_media_end_seconds) || 0).toBeGreaterThan(0);

  const stopResponse = await page.request.post("/video/endpoints/session/stop", {
    form: {
      id: String(sessionPayload.session_id || ""),
    },
  });
  expect(stopResponse.ok()).toBe(true);
});

test("displayed loaded seek band matches actual instant-seek range during real HLS playback", async ({ page }) => {
  test.setTimeout(120000);

  const sessionPosts = [];
  page.on("request", (request) => {
    if (request.url().includes("/video/endpoints/session") && request.method() === "POST") {
      sessionPosts.push(request.postData() || "");
    }
  });

  await page.route("**/video/endpoints/status**", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    if (
      payload
      && payload.active_session
      && payload.active_session.path === "Videos/seek-window.mkv"
    ) {
      payload.active_session.encoded_media_end_seconds = 18;
    }
    await route.fulfill({
      status: response.status(),
      headers: response.headers(),
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
  });

  await openVideoPane(page);

  const initialSession = waitForSessionPost(
    page,
    (body) => body.includes("path=Videos%2Fseek-window.mkv") && body.includes("start_time_seconds=0"),
  );
  const statusPoll = page.waitForRequest((request) => {
    return request.method() === "GET" && request.url().includes("/video/endpoints/status");
  }, { timeout: 15000 });
  await playLibraryFile(page, "seek-window.mkv");
  await initialSession;
  await statusPoll;
  await waitForScrubberReady(page);
  await pausePlayback(page);

  // The browser's live HLS seekable range can move while paused as the
  // playlist finishes buffering. Capture the range only after it has settled;
  // otherwise the test can choose a target from an older range and then
  // correctly observe the player restarting because that target is no longer
  // in the current in-session range.
  const loadedWindowState = await waitForStableLoadedSeekWindowState(page);
  const displayedStartSeconds = percentToSeconds(
    loadedWindowState.displayedStartPercent,
    loadedWindowState.sliderMax,
  );
  const displayedEndSeconds = percentToSeconds(
    loadedWindowState.displayedEndPercent,
    loadedWindowState.sliderMax,
  );

  expect(displayedStartSeconds).toBeCloseTo(0, 1);
  expect(displayedEndSeconds).toBeCloseTo(loadedWindowState.seekableEnd, 0);

  const targetSeconds = Math.max(1, displayedEndSeconds - 0.5);
  await scrubInSession(page, targetSeconds);

  const beyondLoadedTarget = Number(loadedWindowState.sliderMax);
  expect(beyondLoadedTarget).toBeGreaterThan(displayedEndSeconds + 0.5);

  const postsBeforeBeyondScrub = sessionPosts.length;
  const restartSession = waitForSessionPost(
    page,
    (body) => body.includes("path=Videos%2Fseek-window.mkv") && !body.includes("start_time_seconds=0"),
  );
  await page.locator("#video-progress-slider").evaluate((element, seconds) => {
    element.value = String(seconds);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, beyondLoadedTarget);
  await waitForLoadingOverlayWithoutPlaceholder(page);
  await restartSession;

  const postsAfterBeyondScrub = sessionPosts.slice(postsBeforeBeyondScrub);
  const restartBody = postsAfterBeyondScrub.find((body) => body.includes("path=Videos%2Fseek-window.mkv")) || "";
  const restartStartSeconds = Number(new URLSearchParams(restartBody).get("start_time_seconds"));
  const expectedClampedRestartSeconds = Math.max(
    0,
    beyondLoadedTarget - Math.min(1, beyondLoadedTarget / 2),
  );
  expect(restartStartSeconds).toBeLessThan(beyondLoadedTarget);
  expect(restartStartSeconds).toBeCloseTo(expectedClampedRestartSeconds, 0);
  await waitForLoadingOverlayHidden(page);
  await waitForPlaybackSurfaceWithoutOverlay(page);
  await expectPlaybackNearSeconds(page, expectedClampedRestartSeconds, 1);
});

test("seek-triggered subtitle extraction expands scrubber coverage without a session restart", async ({ page }) => {
  test.setTimeout(90000);

  const sessionPosts = [];
  page.on("request", (request) => {
    if (request.url().includes("/video/endpoints/session") && request.method() === "POST") {
      sessionPosts.push(request.postData() || "");
    }
  });
  const subtitleWindowRequests = [];
  await page.route("**/video/endpoints/subtitles/all?path=Videos%2Fseek-window.mkv&source=remote", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ status: "error" }),
    });
  });
  await page.route("**/video/endpoints/subtitles?path=Videos%2Fseek-window.mkv&source=remote&track=*", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "text/plain",
      body: "subtitle preload disabled for windowed seek coverage test",
    });
  });
  await page.route("**/video/endpoints/subtitles/window**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("path") !== "Videos/seek-window.mkv") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const payload = await response.json();
    const windowStatus = String(url.searchParams.get("window_status") || "requested");
    const start = Number(url.searchParams.get("start") || "0");
    subtitleWindowRequests.push({ windowStatus, start });
    if (windowStatus === "seek") {
      payload.loaded_ranges = [{ start_seconds: 0, end_seconds: 24 }];
      payload.window_end_seconds = 24;
    } else {
      payload.loaded_ranges = [{ start_seconds: 0, end_seconds: 12 }];
      payload.window_end_seconds = 12;
    }
    await route.fulfill({
      status: response.status(),
      headers: response.headers(),
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
  });

  await installHlsStub(page, { fragmentCount: 4 });
  await openVideoPane(page);

  const initialSession = waitForSessionPost(
    page,
    (body) => body.includes("path=Videos%2Fseek-window.mkv") && body.includes("start_time_seconds=0"),
  );
  await playLibraryFile(page, "seek-window.mkv");
  await initialSession;
  await waitForScrubberReady(page);
  await waitForMountedSubtitleTrackReady(page, 3);

  await expect
    .poll(async () => readProgressCoverageState(page), { timeout: 10000 })
    .toMatchObject({
      subtitleCoverageState: "limited",
    });

  const initialCoverage = await readProgressCoverageState(page);
  expect(initialCoverage.subtitleEnd).toBeCloseTo(50, 0);
  expect(initialCoverage.processedEnd).toBeCloseTo(50, 0);

  const postsBeforeSeek = sessionPosts.length;
  await startScrubInSession(page, 18);
  await waitForLoadingOverlayWithoutPlaceholder(page);

  await expect
    .poll(async () => subtitleWindowRequests.some((request) => request.windowStatus === "seek"), { timeout: 10000 })
    .toBe(true);

  expect(sessionPosts.slice(postsBeforeSeek)).toEqual([]);

  await expect
    .poll(async () => {
      const state = await readProgressCoverageState(page);
      return {
        mediaStart: state.mediaStart,
        mediaEndAtFull: state.mediaEnd > 99,
        subtitleStart: state.subtitleStart,
        subtitleEndAtFull: state.subtitleEnd > 99,
        processedStart: state.processedStart,
        processedEndAtFull: state.processedEnd > 99,
        subtitleCoverageState: state.subtitleCoverageState,
      };
    }, { timeout: 10000 })
    .toMatchObject({
      mediaStart: 0,
      mediaEndAtFull: true,
      subtitleStart: 0,
      subtitleEndAtFull: true,
      processedStart: 0,
      processedEndAtFull: true,
      subtitleCoverageState: "full",
    });
});

test("windowed subtitles remount when playback crosses mounted coverage", async ({ page }) => {
  test.setTimeout(90000);

  const sessionPosts = [];
  page.on("request", (request) => {
    if (request.url().includes("/video/endpoints/session") && request.method() === "POST") {
      sessionPosts.push(request.postData() || "");
    }
  });

  const subtitleWindowRequests = [];
  await page.route("**/video/endpoints/subtitles/all?path=Videos%2Fseek-window.mkv&source=remote", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ status: "error" }),
    });
  });
  await page.route("**/video/endpoints/subtitles?path=Videos%2Fseek-window.mkv&source=remote&track=*", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "text/plain",
      body: "subtitle preload disabled for window boundary test",
    });
  });
  await page.route("**/video/endpoints/subtitles/window**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("path") !== "Videos/seek-window.mkv") {
      await route.continue();
      return;
    }
    const windowStatus = String(url.searchParams.get("window_status") || "requested");
    const requestStart = Number(url.searchParams.get("start") || "0");
    subtitleWindowRequests.push({ windowStatus, requestStart });
    const fetched = await fetchJsonRoute(route, { ignoreErrors: true });
    if (!fetched) return;
    const { response, payload } = fetched;
    if (windowStatus === "startup") {
      payload.window_start_seconds = 0;
      payload.window_end_seconds = 12;
      payload.loaded_ranges = [{ start_seconds: 0, end_seconds: 12 }];
      payload.vtt = "WEBVTT\n\n00:00:10.000 --> 00:00:12.000\nSEEK-WINDOW-ENG\n";
    } else {
      payload.window_start_seconds = 12;
      payload.window_end_seconds = 24;
      payload.loaded_ranges = [{ start_seconds: 12, end_seconds: 24 }];
      payload.vtt = "WEBVTT\n\n00:00:16.000 --> 00:00:18.000\nSEEK-WINDOW-ENG AGAIN\n";
    }
    await fulfillJsonRoute(route, response, payload);
  });

  await installHlsStub(page, { fragmentCount: 4 });
  await openVideoPane(page);
  await playLibraryFile(page, "seek-window.mkv");
  await waitForScrubberReady(page);
  await waitForMountedSubtitleTrackReady(page, 3);

  await setPlaybackTimeForSubtitleChecks(page, 10.5);
  await waitForDisplayedSubtitleDebugText(page, "SEEK-WINDOW-ENG");

  const postsBeforeBoundaryCross = sessionPosts.length;
  await setPlaybackTimeForSubtitleChecks(page, 17);
  await waitForDisplayedSubtitleDebugText(page, "SEEK-WINDOW-ENG AGAIN");

  expect(subtitleWindowRequests.some((request) => request.windowStatus === "startup")).toBe(true);
  expect(subtitleWindowRequests.some((request) => request.windowStatus === "seek")).toBe(true);
  expect(sessionPosts.slice(postsBeforeBoundaryCross)).toEqual([]);
});

test("full cached subtitles stay mounted across timeupdate without remount flicker", async ({ page }) => {
  test.setTimeout(90000);

  const subtitleWindowRequests = [];
  await page.route("**/video/endpoints/subtitles?path=Videos%2Fseek-window.mkv&source=remote&track=*", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "text/plain",
      body: "per-track subtitle preload disabled for full-cache remount test",
    });
  });
  await page.route("**/video/endpoints/subtitles/window**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("path") !== "Videos/seek-window.mkv") {
      await route.continue();
      return;
    }
    const windowStatus = String(url.searchParams.get("window_status") || "requested");
    subtitleWindowRequests.push({
      windowStatus,
      start: Number(url.searchParams.get("start") || "0"),
      track: Number(url.searchParams.get("track") || "0"),
    });
    if (windowStatus !== "startup") {
      await route.fulfill({
        status: 502,
        contentType: "text/plain",
        body: "seek windows disabled after startup for full-cache remount test",
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "ok",
        track: Number(url.searchParams.get("track") || "3"),
        window_start_seconds: 0,
        window_end_seconds: 12,
        coverage_complete: false,
        loaded_ranges: [{ start_seconds: 0, end_seconds: 12 }],
        gap_action: "pause-until-ready",
        window_status: "ready",
        vtt: "WEBVTT\n\n00:00:10.000 --> 00:00:12.000\nSEEK-WINDOW-ENG\n",
      }),
    });
  });

  await page.addInitScript(TRACK_REMOVAL_INSTRUMENTATION);
  await installHlsStub(page, { fragmentCount: 4 });
  await openVideoPane(page);
  const fullPreloadResponse = page.waitForResponse(
    (response) => (
      response.url().includes("/video/endpoints/subtitles/all?path=Videos%2Fseek-window.mkv")
      && response.ok()
    ),
    { timeout: 30000 },
  );
  await playLibraryFile(page, "seek-window.mkv");
  await waitForScrubberReady(page);
  await fullPreloadResponse;
  await waitForMountedSubtitleTrackReady(page, 3);
  await setPlaybackTimeForSubtitleChecks(page, 10.5);
  await waitForDisplayedSubtitleDebugText(page, "SEEK-WINDOW-ENG");

  await setPlaybackTimeForSubtitleChecks(page, 17);
  await waitForDisplayedSubtitleDebugText(page, "SEEK-WINDOW-ENG AGAIN");
  await page.evaluate(() => {
    window.__subtitleTeardownEvents = [];
  });
  const windowRequestsBeforeTimeupdates = subtitleWindowRequests.length;

  await page.evaluate(() => {
    const video = document.getElementById("video-player-media");
    if (!video) throw new Error("video element missing");
    for (let index = 0; index < 40; index += 1) {
      video.dispatchEvent(new Event("timeupdate"));
    }
  });

  const teardownEvents = await page.evaluate(() => window.__subtitleTeardownEvents || []);
  expect(teardownEvents).toEqual([]);
  expect(subtitleWindowRequests).toEqual([
    { windowStatus: "startup", start: 0, track: 3 },
  ]);
  expect(subtitleWindowRequests.slice(windowRequestsBeforeTimeupdates)).toEqual([]);

  const debugState = await readDisplayedSubtitleDebugState(page);
  expect(debugState.metaText).toContain("Track:");
  expect(debugState.metaText).not.toMatch(/Track: none\b/);
  expect(debugState.currentCueText).toContain("SEEK-WINDOW-ENG AGAIN");
});

test("seek subtitle extraction failure keeps playback running and shows subtitle refresh failure state", async ({ page }) => {
  test.setTimeout(90000);

  const sessionPosts = [];
  page.on("request", (request) => {
    if (request.url().includes("/video/endpoints/session") && request.method() === "POST") {
      sessionPosts.push(request.postData() || "");
    }
  });

  await page.route("**/video/endpoints/subtitles/all?path=Videos%2Fseek-window.mkv&source=remote", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ status: "error" }),
    });
  });
  await page.route("**/video/endpoints/subtitles?path=Videos%2Fseek-window.mkv&source=remote&track=*", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "text/plain",
      body: "subtitle preload disabled for seek failure state test",
    });
  });
  await page.route("**/video/endpoints/subtitles/window**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("path") !== "Videos/seek-window.mkv") {
      await route.continue();
      return;
    }
    if (url.searchParams.get("window_status") === "seek") {
      await route.fulfill({
        status: 502,
        contentType: "text/plain; charset=utf-8",
        body: "subtitle seek window extraction failed for e2e coverage",
      });
      return;
    }
    const response = await route.fetch();
    const payload = await response.json();
    payload.loaded_ranges = [{ start_seconds: 0, end_seconds: 12 }];
    payload.window_end_seconds = 12;
    await route.fulfill({
      status: response.status(),
      headers: response.headers(),
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
  });

  await installHlsStub(page, { fragmentCount: 4 });
  await openVideoPane(page);

  const initialSession = waitForSessionPost(
    page,
    (body) => body.includes("path=Videos%2Fseek-window.mkv") && body.includes("start_time_seconds=0"),
  );
  await playLibraryFile(page, "seek-window.mkv");
  await initialSession;
  await waitForScrubberReady(page);
  await waitForMountedSubtitleTrackReady(page, 3);

  await expect
    .poll(async () => readProgressCoverageState(page), { timeout: 10000 })
    .toMatchObject({
      subtitleCoverageState: "limited",
    });

  const postsBeforeSeek = sessionPosts.length;
  await startScrubInSession(page, 18);
  await waitForPlaybackSurfaceWithoutOverlay(page);
  await waitForVisibleVideo(page);
  expect(sessionPosts.slice(postsBeforeSeek)).toEqual([]);
  await expectPlaybackNearSeconds(page, 18, 1);
  await expect(page.locator("#video-player-status")).toHaveText("Subtitle refresh failed; keeping the previous subtitle track.");

  await expect
    .poll(async () => readSubtitleFailureState(page), { timeout: 10000 })
    .toMatchObject({
      stageSubtitleState: "error",
      bannerVisible: true,
      title: "Subtitle refresh failed",
      selectorState: "error",
    });

  const failureState = await readSubtitleFailureState(page);
  expect(failureState.meta).toContain("Keeping the previous subtitle window");
  expect(failureState.selectorTitle).toContain("requested subtitle range");
});

test("subtitle track switch and audio restart keep windowed subtitles correct at non-zero playback", async ({ page }) => {
  test.setTimeout(90000);

  const sessionPosts = [];
  page.on("request", (request) => {
    if (request.url().includes("/video/endpoints/session") && request.method() === "POST") {
      sessionPosts.push(request.postData() || "");
    }
  });

  const subtitleWindowRequests = [];
  await page.route("**/video/endpoints/subtitles/all?path=Videos%2Fseek-window.mkv&source=remote", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ status: "error" }),
    });
  });
  await page.route("**/video/endpoints/subtitles?path=Videos%2Fseek-window.mkv&source=remote&track=*", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "text/plain",
      body: "subtitle preload disabled for track-switch windowed coverage test",
    });
  });
  await page.route("**/video/endpoints/subtitles/window**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("path") !== "Videos/seek-window.mkv") {
      await route.continue();
      return;
    }
    subtitleWindowRequests.push({
      track: Number(url.searchParams.get("track") || "0"),
      start: Number(url.searchParams.get("start") || "0"),
      windowStatus: String(url.searchParams.get("window_status") || ""),
    });
    const fetched = await fetchJsonRoute(route, { ignoreErrors: true });
    if (!fetched) return;
    const { response, payload } = fetched;
    if (url.searchParams.get("window_status") === "seek") {
      payload.loaded_ranges = [{ start_seconds: 0, end_seconds: 24 }];
      payload.window_end_seconds = 24;
    } else {
      payload.loaded_ranges = [{ start_seconds: 0, end_seconds: 12 }];
      payload.window_end_seconds = 12;
    }
    await fulfillJsonRoute(route, response, payload);
  });

  await installHlsStub(page, { fragmentCount: 4 });
  await openVideoPane(page);

  const initialSession = waitForSessionPost(
    page,
    (body) => body.includes("path=Videos%2Fseek-window.mkv") && body.includes("start_time_seconds=0"),
  );
  await playLibraryFile(page, "seek-window.mkv");
  await initialSession;
  await waitForScrubberReady(page);
  await waitForMountedSubtitleTrackReady(page, 3);
  await startScrubInSession(page, 18);
  await waitForLoadingOverlayWithoutPlaceholder(page);

  const postsBeforeSubtitleSwitch = sessionPosts.length;
  await selectTrackOption(page, "#video-subtitle-track", "4");
  await waitForLoadingOverlayWithoutPlaceholder(page);
  await expect
    .poll(
      async () => subtitleWindowRequests.some((request) => (
        request.track === 4
        && request.windowStatus === "seek"
        && request.start === 3
      )),
      { timeout: 10000 },
    )
    .toBe(true);
  expect(sessionPosts.slice(postsBeforeSubtitleSwitch)).toEqual([]);
  await waitForVisibleVideo(page);
  await expectTrackSelectors(page, { subtitleValue: "4" });
  await waitForSubtitleStreamIndex(page, 4);
  await waitForMountedSubtitleTrackReady(page, 4);

  const audioRestart = waitForSessionPost(page, (body) => {
    if (!body.includes("path=Videos%2Fseek-window.mkv")) return false;
    if (!body.includes("audio_stream_index=2")) return false;
    const startSeconds = Number(new URLSearchParams(body).get("start_time_seconds"));
    return Number.isFinite(startSeconds) && startSeconds > 0;
  });
  await selectTrackOption(page, "#video-audio-track", "2");
  await waitForLoadingOverlayWithoutPlaceholder(page);
  await audioRestart;
  await waitForVisibleVideo(page);
  await expectTrackSelectors(page, { audioValue: "2", subtitleValue: "4" });
  await waitForSubtitleStreamIndex(page, 4);
  await waitForMountedSubtitleTrackReady(page, 4);
});

test("turning subtitles off clears only the mounted track and remounts cached windowed subtitles without refetch", async ({ page }) => {
  test.setTimeout(90000);

  const sessionPosts = [];
  page.on("request", (request) => {
    if (request.url().includes("/video/endpoints/session") && request.method() === "POST") {
      sessionPosts.push(request.postData() || "");
    }
  });

  const subtitleWindowRequests = [];
  await page.route("**/video/endpoints/subtitles/all?path=Videos%2Fseek-window.mkv&source=remote", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ status: "error" }),
    });
  });
  await page.route("**/video/endpoints/subtitles?path=Videos%2Fseek-window.mkv&source=remote&track=*", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "text/plain",
      body: "subtitle preload disabled for subtitle-off windowed coverage test",
    });
  });
  await page.route("**/video/endpoints/subtitles/window**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("path") !== "Videos/seek-window.mkv") {
      await route.continue();
      return;
    }
    subtitleWindowRequests.push({
      track: Number(url.searchParams.get("track") || "0"),
      start: Number(url.searchParams.get("start") || "0"),
      windowStatus: String(url.searchParams.get("window_status") || ""),
    });
    const response = await route.fetch();
    const payload = await response.json();
    if (url.searchParams.get("window_status") === "seek") {
      payload.loaded_ranges = [{ start_seconds: 0, end_seconds: 24 }];
      payload.window_end_seconds = 24;
    } else {
      payload.loaded_ranges = [{ start_seconds: 0, end_seconds: 12 }];
      payload.window_end_seconds = 12;
    }
    await route.fulfill({
      status: response.status(),
      headers: response.headers(),
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
  });

  await installHlsStub(page, { fragmentCount: 4 });
  await openVideoPane(page);

  const initialSession = waitForSessionPost(
    page,
    (body) => body.includes("path=Videos%2Fseek-window.mkv") && body.includes("start_time_seconds=0"),
  );
  await playLibraryFile(page, "seek-window.mkv");
  await initialSession;
  await waitForScrubberReady(page);
  await waitForMountedSubtitleTrackReady(page, 3);

  const postsBeforeSeek = sessionPosts.length;
  await startScrubInSession(page, 18);
  await expect
    .poll(async () => subtitleWindowRequests.some((request) => request.track === 3 && request.windowStatus === "seek"), {
      timeout: 10000,
    })
    .toBe(true);
  expect(sessionPosts.slice(postsBeforeSeek)).toEqual([]);
  await waitForVisibleVideo(page);
  await waitForMountedSubtitleTrackReady(page, 3);
  await expect
    .poll(async () => {
      const state = await readProgressCoverageState(page);
      return {
        subtitleEndAtFull: state.subtitleEnd > 99,
        processedEndAtFull: state.processedEnd > 99,
        subtitleCoverageState: state.subtitleCoverageState,
      };
    }, { timeout: 10000 })
    .toMatchObject({
      subtitleEndAtFull: true,
      processedEndAtFull: true,
      subtitleCoverageState: "full",
    });

  const requestsBeforeOff = subtitleWindowRequests.length;
  const postsBeforeOff = sessionPosts.length;
  await selectTrackOption(page, "#video-subtitle-track", "");
  await expectTrackSelectors(page, { subtitleValue: "" });
  await expectNoMountedSubtitleTrack(page);
  expect(subtitleWindowRequests).toHaveLength(requestsBeforeOff);
  expect(sessionPosts.slice(postsBeforeOff)).toEqual([]);

  const postsBeforeRemount = sessionPosts.length;
  await selectTrackOption(page, "#video-subtitle-track", "3");
  await expectTrackSelectors(page, { subtitleValue: "3" });
  await waitForSubtitleStreamIndex(page, 3);
  await waitForMountedSubtitleTrackReady(page, 3);
  expect(subtitleWindowRequests).toHaveLength(requestsBeforeOff);
  expect(sessionPosts.slice(postsBeforeRemount)).toEqual([]);
});

test("missing HLS segment recovery restarts session instead of looping in-session seek", async ({ page }) => {
  test.setTimeout(90000);

  const sessionPosts = [];
  page.on("request", (request) => {
    if (request.url().includes("/video/endpoints/session") && request.method() === "POST") {
      sessionPosts.push(request.postData() || "");
    }
  });

  const encodedMediaEndSeconds = 24;
  const seekTargetSeconds = 18;
  const expectedRestartSeconds = 18;

  await clearActiveVideoSessionAndCache(page);

  await page.route("**/video/endpoints/session", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const fetched = await fetchJsonRoute(route, { ignoreErrors: true });
    if (!fetched) return;
    const { response, payload } = fetched;
    if ((route.request().postData() || "").includes("path=Videos%2Fseek-window.mkv")) {
      payload.encoded_media_end_seconds = encodedMediaEndSeconds;
    }
    await fulfillJsonRoute(route, response, payload);
  });

  await page.route("**/video/endpoints/status**", async (route) => {
    const fetched = await fetchJsonRoute(route, { ignoreErrors: true });
    if (!fetched) return;
    const { response, payload } = fetched;
    if (
      payload
      && payload.active_session
      && payload.active_session.path === "Videos/seek-window.mkv"
    ) {
      payload.active_session.encoded_media_end_seconds = encodedMediaEndSeconds;
    }
    await fulfillJsonRoute(route, response, payload);
  });

  await installHlsStub(page, {
    fragmentCount: 2,
    playlistFragmentCount: 4,
    simulateMissingOnSeek: true,
  });
  await openVideoPane(page);

  const initialSession = waitForSessionPost(
    page,
    (body) => body.includes("path=Videos%2Fseek-window.mkv") && body.includes("start_time_seconds=0"),
  );
  await playLibraryFile(page, "seek-window.mkv");
  await initialSession;
  await waitForScrubberReady(page);
  await pausePlayback(page);

  const postsBeforeMissingSegmentSeek = sessionPosts.length;
  const recoverySession = waitForSessionPost(
    page,
    (body) => {
      if (!body.includes("path=Videos%2Fseek-window.mkv")) return false;
      const startSeconds = Number(new URLSearchParams(body).get("start_time_seconds"));
      return Number.isFinite(startSeconds) && startSeconds > 0;
    },
  );
  await page.locator("#video-progress-slider").evaluate((element, seconds) => {
    element.value = String(seconds);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, seekTargetSeconds);
  await recoverySession;
  await waitForLoadingOverlayHidden(page);
  await waitForPlaybackSurfaceWithoutOverlay(page);
  await expectPlaybackNearSeconds(page, expectedRestartSeconds, 1);

  const postsAfterMissingSegmentSeek = sessionPosts.slice(postsBeforeMissingSegmentSeek);
  expect(postsAfterMissingSegmentSeek.length).toBeGreaterThanOrEqual(1);
  const restartBody = postsAfterMissingSegmentSeek.find((body) => body.includes("path=Videos%2Fseek-window.mkv")) || "";
  const restartStartSeconds = Number(new URLSearchParams(restartBody).get("start_time_seconds"));
  expect(restartStartSeconds).toBeCloseTo(expectedRestartSeconds, 0);

  await expect
    .poll(async () => {
      return page.evaluate(() => {
        const loading = document.getElementById("video-loading-overlay");
        if (!loading || loading.hidden) return "";
        return String(loading.textContent || "").trim();
      });
    }, { timeout: 3000 })
    .not.toContain("Recovering compatibility playback");
});

test("video play toggle keeps intended state during compatibility seek loading", async ({ page }) => {
  test.setTimeout(90000);

  await installHlsStub(page);
  await openVideoPane(page);

  const alphaSession = waitForSessionPost(page, (body) => body.includes("path=Videos%2Falpha.mkv"));
  await playLibraryFile(page, "alpha.mkv");
  await alphaSession;
  await expectPlayToggleState(page, "Pause");

  await startScrubInSession(page, 1);
  await expectPlayToggleState(page, "Pause");
  await clickPlayToggle(page);
  await expectPlayToggleState(page, "Play");
  await waitForVisibleVideo(page);
  await expectPlayToggleState(page, "Play");

  await clickPlayToggle(page);
  await expectPlayToggleState(page, "Pause");
  await clickPlayToggle(page);
  await expectPlayToggleState(page, "Play");

  await startScrubInSession(page, 2);
  await expectPlayToggleState(page, "Play");
  await clickPlayToggle(page);
  await expectPlayToggleState(page, "Pause");
  await page.waitForTimeout(300);
  await waitForVisibleVideo(page);
  await expectPlayToggleState(page, "Pause");
});

test("video controls follow standard hover and idle visibility behavior", async ({ page }) => {
  test.setTimeout(90000);

  await installHlsStub(page);
  await openVideoPane(page);

  const alphaSession = waitForSessionPost(page, (body) => body.includes("path=Videos%2Falpha.mkv"));
  await playLibraryFile(page, "alpha.mkv");
  await alphaSession;
  await waitForVisibleVideo(page);
  await waitForPlaybackSurfaceWithoutOverlay(page);

  await expectPlayToggleState(page, "Pause");

  const surface = page.locator("#video-playback-surface");
  await surface.hover({ position: { x: 40, y: 40 } });
  await expectControlsOverlayVisible(page);

  await page.mouse.move(4, 4);
  await expectControlsOverlayHidden(page);

  await surface.hover({ position: { x: 48, y: 48 } });
  await expectControlsOverlayVisible(page);

  await page.waitForTimeout(3200);
  await expectControlsOverlayHidden(page);

  await surface.hover({ position: { x: 56, y: 56 } });
  await expectControlsOverlayVisible(page);

  const box = await surface.boundingBox();
  expect(box).not.toBeNull();
  // Keep the pointer on the surface via locator.hover. Absolute page.mouse.move
  // to the bounding-box center can leave the hit target (and fire mouseleave,
  // which hides controls) when layout/chrome shifts under the cursor.
  await surface.hover({
    position: {
      x: Math.max(8, Math.floor(box.width / 2)),
      y: Math.max(8, Math.floor(box.height / 2)),
    },
  });
  await expectControlsOverlayVisible(page);

  try {
    await startSyntheticControlsPointerStorm(page);
    await page.waitForTimeout(3200);
    await expectControlsOverlayHidden(page);
  } finally {
    await stopSyntheticControlsPointerStorm(page);
  }
});

test("video fullscreen keeps the scrubber overlay visible and functional", async ({ page }) => {
  test.setTimeout(90000);

  await installHlsStub(page);
  await openVideoPane(page);

  const alphaSession = waitForSessionPost(page, (body) => body.includes("path=Videos%2Falpha.mkv"));
  await playLibraryFile(page, "alpha.mkv");
  await alphaSession;
  await waitForVisibleVideo(page);
  await waitForPlaybackSurfaceWithoutOverlay(page);

  const surface = page.locator("#video-playback-surface");
  await surface.hover({ position: { x: 40, y: 40 } });
  await expectControlsOverlayVisible(page);
  await surface.dblclick({ position: { x: 48, y: 48 } });

  await expect
    .poll(async () => readFullscreenPlaybackState(page), { timeout: 10000 })
    .toMatchObject({
      fullscreenElementId: "video-playback-stage",
      stageVisible: true,
      overlayVisible: true,
      sliderVisible: true,
      sliderDisabled: false,
      fullscreenLabel: "Exit fullscreen",
    });

  await page.waitForTimeout(3200);
  await expectControlsOverlayHidden(page);

  const scrubTarget = await scrubInSessionForward(page, 1);

  await expect
    .poll(async () => readFullscreenPlaybackState(page), { timeout: 10000 })
    .toMatchObject({
      fullscreenElementId: "video-playback-stage",
      stageVisible: true,
      sliderVisible: true,
      sliderDisabled: false,
      fullscreenLabel: "Exit fullscreen",
    });

  const fullscreenState = await readFullscreenPlaybackState(page);
  expect(fullscreenState.sliderMax).toBeGreaterThan(0);
  expect(fullscreenState.sliderValue).toBeGreaterThanOrEqual(scrubTarget - 1);
  expect(fullscreenState.overlappingControlPairs).toEqual([]);
  expect(fullscreenState.playBeforeBack15).toBe(true);
  expect(fullscreenState.loopBeforePrevious).toBe(true);
  expect(fullscreenState.previousBeforeNext).toBe(true);
  expect(fullscreenState.back15BeforeForward15).toBe(true);
  expect(fullscreenState.forward15BeforeMute).toBe(true);
  expect(fullscreenState.nextBeforeFullWindow).toBe(true);
  expect(fullscreenState.forward15BeforeFullWindow).toBe(true);
  expect(fullscreenState.fullWindowBeforeFullscreen).toBe(true);
  for (const id of fullscreenState.controlOrder) {
    expect(fullscreenState.controlRects[id].width).toBeGreaterThan(0);
    expect(fullscreenState.controlRects[id].height).toBeGreaterThan(0);
  }

  await page.evaluate(async () => {
    if (document.fullscreenElement && typeof document.exitFullscreen === "function") {
      await document.exitFullscreen();
    }
  });
  await expect
    .poll(async () => readFullscreenPlaybackState(page), { timeout: 10000 })
    .toMatchObject({
      fullscreenElementId: "",
      fullscreenLabel: "Fullscreen",
    });
});


async function seedIncompleteProbeCache(request, relPath) {
  const response = await request.post("/__integration/seed-probe-cache", {
    form: {
      path: relPath,
      variant: "incomplete",
    },
  });
  expect(response.ok()).toBe(true);
  const payload = await response.json();
  expect(payload.status).toBe("seeded");
  expect(payload.cache_file_exists).toBe(true);
  return payload;
}

async function seedCorruptHeaderCache(request, relPath) {
  const response = await request.post("/__integration/seed-header-cache", {
    form: {
      path: relPath,
      variant: "corrupt",
    },
  });
  expect(response.ok()).toBe(true);
  const payload = await response.json();
  expect(payload.status).toBe("seeded");
  expect(payload.cache_file_exists).toBe(true);
  return payload;
}

test("clear cache button recovers track selectors from stale server and client probe cache", async ({ page }) => {
  test.setTimeout(60000);

  await installHlsStub(page);
  const clearResponse = await page.request.post("/video/endpoints/cache/clear");
  expect(clearResponse.ok()).toBe(true);
  await seedIncompleteProbeCache(page.request, "Videos/alpha.mkv");
  await page.evaluate(() => {
    const path = "Videos/alpha.mkv";
    const stalePayload = {
      status: "ok",
      source: "remote",
      path,
      stream_path: path,
      duration_seconds: 8,
      video_streams: [],
      audio_streams: [],
      subtitle_streams: [],
      default_audio_stream_index: null,
      default_subtitle_stream_index: null,
      subtitle_off_default: true,
    };
    window.sessionStorage.setItem(
      "dropbox-browser:video-probe-v1",
      JSON.stringify({
        entries: {
          [path]: {
            payload: stalePayload,
            cachedAt: Date.now(),
            accessedAt: Date.now(),
          },
        },
        totalBytes: 512,
      }),
    );
  });
  await openVideoPane(page);
  await playLibraryFile(page, "alpha.mkv");
  await expectTrackSelectors(page, {
    audioEnabled: false,
    subtitleEnabled: false,
  });

  await page.locator("#video-debug-panel").evaluate((panel) => {
    panel.open = true;
  });
  await page.locator("#video-clear-cache-button").click();
  await expect(page.locator("#video-player-status")).toContainText("Video caches cleared.");
  await expectTrackSelectors(page, {
    audioOptionCount: 2,
    subtitleOptionCount: 4,
  });
});

test("clear cache button reloads track selectors after stale client probe cache", async ({ page }) => {
  test.setTimeout(60000);

  await installHlsStub(page);
  await openVideoPane(page);
  await playLibraryFile(page, "alpha.mkv");
  await waitForVisibleVideo(page);
  await waitForPlaybackSurfaceWithoutOverlay(page);
  await expectTrackSelectors(page, {
    audioOptionCount: 2,
    subtitleOptionCount: 4,
  });

  await page.evaluate(() => {
    const path = "Videos/alpha.mkv";
    const stalePayload = {
      status: "ok",
      source: "remote",
      path,
      stream_path: path,
      duration_seconds: 8,
      video_streams: [],
      audio_streams: [],
      subtitle_streams: [],
      default_audio_stream_index: null,
      default_subtitle_stream_index: null,
      subtitle_off_default: true,
    };
    window.sessionStorage.setItem(
      "dropbox-browser:video-probe-v1",
      JSON.stringify({
        entries: {
          [path]: {
            payload: stalePayload,
            cachedAt: Date.now(),
            accessedAt: Date.now(),
          },
        },
        totalBytes: 512,
      }),
    );
  });

  await page.reload();
  await openVideoPane(page);
  await playLibraryFile(page, "alpha.mkv");
  await expectTrackSelectors(page, {
    audioEnabled: false,
    subtitleEnabled: false,
  });

  await page.locator("#video-debug-panel").evaluate((panel) => {
    panel.open = true;
  });
  await page.locator("#video-clear-cache-button").click();
  await expect(page.locator("#video-player-status")).toContainText("Video caches cleared.");
  await expectTrackSelectors(page, {
    audioOptionCount: 2,
    subtitleOptionCount: 4,
  });
});

test("ignores incomplete probe disk cache and still loads track selectors", async ({ page }) => {
  test.setTimeout(60000);

  await installHlsStub(page);
  const clearResponse = await page.request.post("/video/endpoints/cache/clear");
  expect(clearResponse.ok()).toBe(true);
  await seedIncompleteProbeCache(page.request, "Videos/alpha.mkv");
  await openVideoPane(page);

  const probeResponse = await page.request.get("/video/endpoints/probe?path=Videos%2Falpha.mkv&source=remote");
  expect(probeResponse.ok()).toBe(true);
  const probePayload = await probeResponse.json();
  expect(probePayload.audio_streams).toHaveLength(2);
  expect(probePayload.subtitle_streams).toHaveLength(3);

  await playLibraryFile(page, "alpha.mkv");
  await waitForVisibleVideo(page);
  await waitForPlaybackSurfaceWithoutOverlay(page);
  await expectTrackSelectors(page, {
    audioOptionCount: 2,
    subtitleOptionCount: 4,
    audioValue: "1",
    subtitleValue: "3",
  });
});

test("falls back to probing the remote file when cached header bytes are corrupt", async ({ page }) => {
  test.setTimeout(60000);

  await installHlsStub(page);
  const clearResponse = await page.request.post("/video/endpoints/cache/clear");
  expect(clearResponse.ok()).toBe(true);
  await seedCorruptHeaderCache(page.request, "Videos/alpha.mkv");
  await openVideoPane(page);

  const probeResponse = await page.request.get("/video/endpoints/probe?path=Videos%2Falpha.mkv&source=remote");
  expect(probeResponse.ok()).toBe(true);
  const probePayload = await probeResponse.json();
  expect(probePayload.audio_streams).toHaveLength(2);
  expect(probePayload.subtitle_streams).toHaveLength(3);

  await playLibraryFile(page, "alpha.mkv");
  await waitForVisibleVideo(page);
  await waitForPlaybackSurfaceWithoutOverlay(page);
  await expectTrackSelectors(page, {
    audioOptionCount: 2,
    subtitleOptionCount: 4,
    audioValue: "1",
    subtitleValue: "3",
  });
});

test("loaded HLS segment average reflects fragment load timing", async ({ page }) => {
  test.setTimeout(60000);

  const statusResponse = await page.request.get("/video/endpoints/status");
  expect(statusResponse.ok()).toBe(true);
  const statusPayload = await statusResponse.json();
  if (statusPayload && statusPayload.active_session && statusPayload.active_session.session_id) {
    const stopResponse = await page.request.post("/video/endpoints/session/stop", {
      data: { id: statusPayload.active_session.session_id },
    });
    expect(stopResponse.ok()).toBe(true);
  }
  const clearResponse = await page.request.post("/video/endpoints/cache/clear");
  expect(clearResponse.ok()).toBe(true);
  await installHlsStub(page, {
    fragmentCount: 8,
    playlistFragmentCount: 8,
    fragmentLoadDelayMs: 20,
    fragmentLoadIntervalMs: 80,
  });
  await openVideoPane(page);
  await playLibraryFile(page, "alpha.mkv");
  await waitForVisibleVideo(page);
  await waitForPlaybackSurfaceWithoutOverlay(page);
  await waitForMountedSubtitleTrackReady(page, 3);
  await expect
    .poll(async () => {
      const state = await readDisplayedSubtitleDebugState(page);
      const match = state.metaText.match(/avg load: ([0-9]+\.[0-9]{2})s/);
      return match ? Number.parseFloat(match[1]) : Number.NaN;
    }, { timeout: 10000 })
    .toBeGreaterThan(0.05);
});

test("subtitle-ready scrubber debug info reflects full cached subtitle coverage after reload", async ({ page }) => {
  test.setTimeout(90000);

  await page.route("**/video/endpoints/probe?path=Videos%2Falpha.mkv&source=remote*", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.duration_seconds = 360;
    await route.fulfill({
      status: response.status(),
      headers: response.headers(),
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
  });

  await installHlsStub(page, { fragmentCount: 60, playlistFragmentCount: 60 });
  await openVideoPane(page);
  await playLibraryFile(page, "alpha.mkv");
  await waitForVisibleVideo(page);
  await waitForPlaybackSurfaceWithoutOverlay(page);
  await waitForMountedSubtitleTrackReady(page, 3);

  await page.reload();
  await openVideoPane(page);
  await playLibraryFile(page, "alpha.mkv");
  await waitForVisibleVideo(page);
  await waitForPlaybackSurfaceWithoutOverlay(page);
  await waitForMountedSubtitleTrackReady(page, 3);
  await expect
    .poll(async () => {
      const state = await readProgressCoverageState(page);
      return {
        subtitleEndAtFull: state.subtitleEnd > 99,
        processedEndAtFull: state.processedEnd > 99,
        subtitleCoverageState: state.subtitleCoverageState,
      };
    }, { timeout: 10000 })
    .toMatchObject({
      subtitleEndAtFull: true,
      processedEndAtFull: true,
      subtitleCoverageState: "full",
    });
  await expect
    .poll(async () => {
      const state = await readDisplayedSubtitleDebugState(page);
      return state.metaText;
    }, { timeout: 10000 })
    .toContain("CPU priority:");
  await expect
    .poll(async () => {
      const state = await readDisplayedSubtitleDebugState(page);
      return state.metaText;
    }, { timeout: 10000 })
    .toContain("HLS segment:");
  await expect
    .poll(async () => {
      const state = await readDisplayedSubtitleDebugState(page);
      return state.metaText;
    }, { timeout: 10000 })
    .toContain("Loaded HLS segments:");
  await expect
    .poll(async () => {
      const state = await readDisplayedSubtitleDebugState(page);
      return state.metaText;
    }, { timeout: 10000 })
    .toContain("Subtitle mode: webvtt");
  await expect
    .poll(async () => {
      const state = await readDisplayedSubtitleDebugState(page);
      return state.metaText;
    }, { timeout: 10000 })
    .toContain("Loaded video: 0:00 - 6:00. Subtitle-ready: 0:00 - 6:00.");
  await expect
    .poll(async () => {
      const state = await readDisplayedSubtitleDebugState(page);
      return state.currentTitleText;
    }, { timeout: 10000 })
    .toMatch(/^Current Subtitle(?: \[\d+\/\d+\])?$/);
  await expect
    .poll(async () => {
      const state = await readDisplayedSubtitleDebugState(page);
      return state.nextTitleText;
    }, { timeout: 10000 })
    .toMatch(/^Next Subtitle(?: \[\d+\/\d+\])?$/);
});

test("video track selections persist across reload and matching track layouts", async ({ page }) => {
  test.setTimeout(90000);

  await installHlsStub(page);
  await openVideoPane(page);

  const alphaSession = waitForSessionPost(page, (body) => body.includes("path=Videos%2Falpha.mkv"));
  await playLibraryFile(page, "alpha.mkv");
  await alphaSession;

  await expectTrackSelectors(page, {
    audioValue: "1",
    subtitleValue: "3",
    audioOptionCount: 2,
    subtitleOptionCount: 4,
  });

  const alphaAudioRestart = waitForSessionPost(
    page,
    (body) => body.includes("path=Videos%2Falpha.mkv") && body.includes("audio_stream_index=2"),
  );
  await selectTrackOption(page, "#video-audio-track", "2");
  await waitForLoadingOverlayWithoutPlaceholder(page);
  await alphaAudioRestart;
  await waitForVisibleVideo(page);
  await waitForPlaybackSurfaceWithoutOverlay(page);

  await selectTrackOption(page, "#video-subtitle-track", "4");
  await waitForSubtitleStreamIndex(page, 4);
  await expectTrackSelectors(page, { audioValue: "2", subtitleValue: "4" });
  await expect
    .poll(async () => readStoredTrackPreferences(page), { timeout: 10000 })
    .toMatchObject({
      audio: expect.stringContaining("\"signature\""),
      subtitle: expect.stringContaining("\"signature\""),
    });

  await page.reload();
  await openVideoPane(page);
  await expect
    .poll(async () => readStoredTrackPreferences(page), { timeout: 10000 })
    .toMatchObject({
      audio: expect.stringContaining("\"signature\""),
      subtitle: expect.stringContaining("\"signature\""),
    });

  await playLibraryFile(page, "alpha.mkv");
  await waitForVisibleVideo(page);
  await waitForPlaybackSurfaceWithoutOverlay(page);
  await expectTrackSelectors(page, {
    audioValue: "2",
    subtitleValue: "4",
    audioOptionCount: 2,
    subtitleOptionCount: 4,
  });
  await waitForSubtitleStreamIndex(page, 4);

  await playLibraryFile(page, "bravo.mkv");
  await waitForVisibleVideo(page);
  await waitForPlaybackSurfaceWithoutOverlay(page);
  await expectTrackSelectors(page, {
    audioValue: "2",
    subtitleValue: "4",
    audioOptionCount: 2,
    subtitleOptionCount: 4,
  });
  await waitForSubtitleStreamIndex(page, 4);
});
