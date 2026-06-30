const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");

process.env.PLAYWRIGHT_PORT = "8013";
process.env.DROPBOX_BROWSER_E2E_FIXTURE = path.join(
  __dirname,
  "fixtures",
  "video_player_generated_fixture.py",
);

const { startIntegrationServer, stopIntegrationServer } = require("./support/integration_server");
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

test.describe.configure({ timeout: 90000 });

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
    }, { timeout: 30000 })
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
    }, { timeout: 30000 })
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

    const stage = document.getElementById("video-playback-stage");
    const overlay = document.getElementById("video-controls-overlay");
    const slider = document.getElementById("video-progress-slider");
    const fullscreenButton = document.getElementById("video-fullscreen-toggle");
    const elapsed = document.getElementById("video-elapsed-time");

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
  });
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
  await expect
    .poll(async () => page.locator("#video-library-list .video-library-row").count(), { timeout: 15000 })
    .toBeGreaterThanOrEqual(5);
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
  await clearStoredTrackPreferences(page);
});

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
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
  await page.locator("#video-audio-track").selectOption("2");
  await waitForLoadingOverlayWithoutPlaceholder(page);
  await bravoAudioRestart;
  await waitForVisibleVideo(page);
  await waitForPlaybackSurfaceWithoutOverlay(page);
  await expectTrackSelectors(page, { audioValue: "2", subtitleValue: "4" });
  await waitForSubtitleStreamIndex(page, 4);

  await scrubInSessionForward(page, 1);
  await expectTrackSelectors(page, { audioValue: "2", subtitleValue: "4" });
  await waitForSubtitleStreamIndex(page, 4);

  await page.locator("#video-subtitle-track").selectOption("");
  await expectNoMountedSubtitleTrack(page);
  await expectTrackSelectors(page, { subtitleValue: "" });

  await page.locator("#video-subtitle-track").selectOption("3");
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

test("WebVTT formatting tags render in the subtitle overlay", async ({ page }) => {
  test.setTimeout(90000);

  await openVideoPane(page);

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
  await waitForDisplayedSubtitleText(page, "ALPHA-SUBTITLE-ENG");
  await waitForSubtitleOverlayMarkup(page, {
    tagName: "i",
    expectedText: "ALPHA-SUBTITLE-ENG",
  });

  await page.locator("#video-subtitle-track").selectOption("4");
  await waitForSubtitleStreamIndex(page, 4);
  await waitForDisplayedSubtitleText(page, "ALPHA-SUBTITLE-FRA");
  await waitForSubtitleOverlayMarkup(page, {
    tagName: "b",
    expectedText: "ALPHA-SUBTITLE-FRA",
  });
});

test("WebVTT subtitle debug timing stays aligned after in-session scrub remount", async ({ page }) => {
  test.setTimeout(90000);

  await openVideoPane(page);

  const initialSession = waitForSessionPost(page, (body) => body.includes("path=Videos%2Foffset.mkv"));
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
  await page.locator("#video-subtitle-track").selectOption("4");
  await waitForSubtitleStreamIndex(page, 4);
  await waitForMountedSubtitleTrackReady(page, 4);
  await setPlaybackTimeForSubtitleChecks(page, 1);
  await waitForDisplayedSubtitleText(page, "ALPHA-SUBTITLE-FRA");
  await waitForNativeSubtitleCueText(page, "ALPHA-SUBTITLE-FRA");

  const bravoRow = await libraryRow(page, "bravo.mkv");
  await bravoRow.click();
  await page.locator("#video-library-add-selected").click();
  await expect(page.locator("#video-queue-list .video-queue-row")).toHaveCount(2);

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
  await bravoSession;
  await expectActiveQueueTitle(page, "bravo.mkv");
  await waitForVisibleVideo(page);
  await waitForPlaybackSurfaceWithoutOverlay(page);
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
  await page.locator("#video-subtitle-track").selectOption("4");
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

  await expect
    .poll(async () => {
      const state = await readLoadedSeekWindowState(page);
      return {
        ...state,
        displayedStartSeconds: percentToSeconds(state.displayedStartPercent, state.sliderMax),
        displayedEndSeconds: percentToSeconds(state.displayedEndPercent, state.sliderMax),
      };
    }, { timeout: 15000 })
    .toMatchObject({
      sliderMax: expect.any(Number),
      seekableEnd: expect.any(Number),
      displayedEndSeconds: expect.any(Number),
    });

  const loadedWindowState = await readLoadedSeekWindowState(page);
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
    let response;
    try {
      response = await route.fetch();
    } catch (error) {
      if (isClosedRouteError(error)) return;
      throw error;
    }
    const payload = await response.json();
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
    await route.fulfill({
      status: response.status(),
      headers: response.headers(),
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
  });

  await installHlsStub(page, { fragmentCount: 4 });
  await openVideoPane(page);
  await playLibraryFile(page, "seek-window.mkv");
  await waitForScrubberReady(page);
  await waitForMountedSubtitleTrackReady(page, 3);

  await setPlaybackTimeForSubtitleChecks(page, 10.5);
  await waitForDisplayedSubtitleDebugText(page, "SEEK-WINDOW-ENG");

  await setPlaybackTimeForSubtitleChecks(page, 17);
  await waitForDisplayedSubtitleDebugText(page, "SEEK-WINDOW-ENG AGAIN");

  expect(subtitleWindowRequests.some((request) => request.windowStatus === "startup")).toBe(true);
  expect(subtitleWindowRequests.some((request) => request.windowStatus === "seek")).toBe(true);
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
    let response;
    try {
      response = await route.fetch();
    } catch (error) {
      if (isClosedRouteError(error)) return;
      throw error;
    }
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
  await startScrubInSession(page, 18);
  await waitForLoadingOverlayWithoutPlaceholder(page);

  const postsBeforeSubtitleSwitch = sessionPosts.length;
  await page.locator("#video-subtitle-track").selectOption("4");
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
  await page.locator("#video-audio-track").selectOption("2");
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
  await page.locator("#video-subtitle-track").selectOption("");
  await expectTrackSelectors(page, { subtitleValue: "" });
  await expectNoMountedSubtitleTrack(page);
  expect(subtitleWindowRequests).toHaveLength(requestsBeforeOff);
  expect(sessionPosts.slice(postsBeforeOff)).toEqual([]);

  const postsBeforeRemount = sessionPosts.length;
  await page.locator("#video-subtitle-track").selectOption("3");
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

  await page.route("**/video/endpoints/session", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const payload = await response.json();
    if ((route.request().postData() || "").includes("path=Videos%2Fseek-window.mkv")) {
      payload.encoded_media_end_seconds = encodedMediaEndSeconds;
    }
    await route.fulfill({
      status: response.status(),
      headers: response.headers(),
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
  });

  await page.route("**/video/endpoints/status**", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    if (
      payload
      && payload.active_session
      && payload.active_session.path === "Videos/seek-window.mkv"
    ) {
      payload.active_session.encoded_media_end_seconds = encodedMediaEndSeconds;
    }
    await route.fulfill({
      status: response.status(),
      headers: response.headers(),
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
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
  const box = await surface.boundingBox();
  expect(box).not.toBeNull();

  await page.mouse.move(box.x + (box.width / 2), box.y + (box.height / 2));
  await expectControlsOverlayVisible(page);

  await page.mouse.move(4, 4);
  await expectControlsOverlayHidden(page);

  await page.mouse.move(box.x + (box.width / 2), box.y + (box.height / 2));
  await expectControlsOverlayVisible(page);

  await page.waitForTimeout(3200);
  await expectControlsOverlayHidden(page);

  await page.mouse.move(box.x + (box.width / 2) + 8, box.y + (box.height / 2) + 8);
  await expectControlsOverlayVisible(page);
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
  const box = await surface.boundingBox();
  expect(box).not.toBeNull();

  await page.mouse.move(box.x + (box.width / 2), box.y + (box.height / 2));
  await expectControlsOverlayVisible(page);
  await page.mouse.dblclick(box.x + (box.width / 2), box.y + (box.height / 2));

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

test("video controls hide after idle even when pointermove repeats while playing", async ({ page }) => {
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
  const box = await surface.boundingBox();
  expect(box).not.toBeNull();

  await page.mouse.move(box.x + (box.width / 2), box.y + (box.height / 2));
  await expectControlsOverlayVisible(page);

  try {
    await startSyntheticControlsPointerStorm(page);
    await page.waitForTimeout(3200);
    await expectControlsOverlayHidden(page);
  } finally {
    await stopSyntheticControlsPointerStorm(page);
  }
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
  await page.locator("#video-audio-track").selectOption("2");
  await waitForLoadingOverlayWithoutPlaceholder(page);
  await alphaAudioRestart;
  await waitForVisibleVideo(page);
  await waitForPlaybackSurfaceWithoutOverlay(page);

  await page.locator("#video-subtitle-track").selectOption("4");
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
