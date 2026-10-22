const path = require("node:path");
const { test, expect } = require("@playwright/test");

const workerPortOffset = Number(process.env.DROPBOX_BROWSER_E2E_LANE_INDEX || "0") * 100;
process.env.PLAYWRIGHT_PORT = String(8016 + workerPortOffset);
// Tagged native-format songs; Lossless.flac also carries an embedded cover.
process.env.DROPBOX_BROWSER_E2E_FIXTURE = path.join(
  __dirname,
  "fixtures",
  "music_formats_generated_fixture.py",
);
process.env.DROPBOX_BROWSER_E2E_MUSIC_LIBRARY_POLL_DELAY_MS = "100";

const { startIntegrationServer, stopIntegrationServer } = require("./support/integration_server");
const {
  ALL_MEDIA_SESSION_ACTIONS,
  installMediaSessionRecorder,
  invokeMediaSessionAction,
  mediaSessionState,
} = require("./support/media-session");

const baseURL = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT}`;
let server = null;

test.describe.configure({ mode: "serial", timeout: 60000 });
test.use({ baseURL });

test.beforeAll(async () => {
  test.setTimeout(60000);
  server = await startIntegrationServer();
});

test.afterAll(async () => {
  await stopIntegrationServer(server);
  server = null;
});

async function openAndLoad(page) {
  await page.goto("/?path=music");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await page.locator("#bottom-pane-mode").selectOption("music-player");
  await expect(page.locator("#music-player-pane")).toBeVisible();
  await page.locator("#music-library-load").click();
  await expect
    .poll(() => page.locator("#music-player-status").innerText(), { timeout: 15000 })
    .toMatch(/Loaded 5 songs? and 0 folders?\./);
}

async function currentPlaylistSong(page) {
  return page.evaluate(() => {
    const current = document.querySelector("#music-playlist-list .music-playlist-entry.current");
    return current?.querySelector(".music-playlist-filename-cell")?.textContent?.trim() || "";
  });
}

async function audioState(page) {
  return page.evaluate(() => {
    const audio = document.getElementById("music-audio");
    return {
      paused: audio.paused,
      currentTime: audio.currentTime,
      duration: audio.duration,
    };
  });
}

async function waitForPlaying(page, filename) {
  await expect
    .poll(async () => page.evaluate((expected) => {
      const audio = document.getElementById("music-audio");
      const current = document.querySelector("#music-playlist-list .music-playlist-entry.current");
      const name = current?.querySelector(".music-playlist-filename-cell")?.textContent?.trim() || "";
      return Boolean(name === expected && audio && !audio.paused && audio.readyState >= 2);
    }, filename), { timeout: 15000 })
    .toBe(true);
}

async function pauseFromSystemControls(page) {
  expect(await invokeMediaSessionAction(page, "pause")).toBe(true);
  await expect.poll(async () => (await audioState(page)).paused).toBe(true);
  await expect.poll(async () => (await mediaSessionState(page)).playbackState).toBe("paused");
}

test("music publishes the playing song to the Media Session and follows its actions", async ({ page }) => {
  await installMediaSessionRecorder(page);
  await openAndLoad(page);

  // Nothing is published before playback starts.
  let session = await mediaSessionState(page);
  expect(session.metadata).toBeNull();
  expect(session.handlers).toEqual([]);

  await page.locator("#music-library-tree .music-tree-song").filter({ hasText: "Lossless.flac" }).dblclick();
  await waitForPlaying(page, "Lossless.flac");
  // The fixtures are 2 seconds long: pause from the OS card right away so the
  // song cannot end (and advance) while the assertions run.
  expect((await mediaSessionState(page)).playbackState).toBe("playing");
  await pauseFromSystemControls(page);

  // Display name first, then the embedded title/artist and cover once metadata loads.
  await expect.poll(async () => (await mediaSessionState(page)).title, { timeout: 10000 }).toBe("FLAC Fixture Title");
  await expect.poll(async () => (await mediaSessionState(page)).artwork?.length || 0, { timeout: 10000 }).toBe(1);
  session = await mediaSessionState(page);
  expect(session.titles[0]).toBe("Lossless.flac");
  expect(session.artist).toBe("FLAC Fixture Artist");
  expect(session.metadata.album).toBe("");
  expect(session.artwork[0].src).toMatch(/^blob:/);
  expect(session.artwork[0].type).toBe("image/png");
  expect(session.artwork[0].src).toBe(await page.locator("#music-cover-art").getAttribute("src"));
  expect(session.playbackState).toBe("paused");
  await expect.poll(async () => (await mediaSessionState(page)).handlers).toEqual(ALL_MEDIA_SESSION_ACTIONS);
  session = await mediaSessionState(page);
  expect(session.position.playbackRate).toBe(1);
  expect(session.position.duration).toBeCloseTo((await audioState(page)).duration, 1);

  // Scrub / step from the OS card move the audio element.
  expect(await invokeMediaSessionAction(page, "seekto", { seekTime: 1.25 })).toBe(true);
  await expect.poll(async () => (await audioState(page)).currentTime).toBeCloseTo(1.25, 1);
  await expect.poll(async () => (await mediaSessionState(page)).position?.position ?? -1).toBeCloseTo(1.25, 1);
  expect((await mediaSessionState(page)).playbackState).toBe("paused");
  // No interval seek handlers, so iOS keeps previous/next track buttons.
  expect(await invokeMediaSessionAction(page, "seekbackward")).toBe(false);
  expect(await invokeMediaSessionAction(page, "seekforward", { seekOffset: 0.5 })).toBe(false);
  expect((await mediaSessionState(page)).intervalSeekEverRegistered).toBe(false);
  expect(await invokeMediaSessionAction(page, "seekto", { seekTime: 0.5 })).toBe(true);
  await expect.poll(async () => (await audioState(page)).currentTime).toBeCloseTo(0.5, 1);

  expect(await invokeMediaSessionAction(page, "play")).toBe(true);
  await expect.poll(async () => (await audioState(page)).paused).toBe(false);
  await expect.poll(async () => (await mediaSessionState(page)).playbackState).toBe("playing");
  await pauseFromSystemControls(page);

  // A second song replaces the card; its missing cover drops the old artwork.
  await page.locator("#music-library-tree .music-tree-song").filter({ hasText: "Ogg Track.ogg" }).dblclick();
  await waitForPlaying(page, "Ogg Track.ogg");
  await pauseFromSystemControls(page);
  await expect.poll(async () => (await mediaSessionState(page)).title, { timeout: 10000 }).toBe("Ogg Fixture Title");
  session = await mediaSessionState(page);
  expect(session.artist).toBe("Ogg Fixture Artist");
  expect(session.artwork).toEqual([]);

  // Previous / next follow the playlist exactly like the pane buttons.
  expect(await invokeMediaSessionAction(page, "previoustrack")).toBe(true);
  await waitForPlaying(page, "Lossless.flac");
  await pauseFromSystemControls(page);
  await expect.poll(async () => (await mediaSessionState(page)).title, { timeout: 10000 }).toBe("FLAC Fixture Title");
  expect(await invokeMediaSessionAction(page, "nexttrack")).toBe(true);
  await waitForPlaying(page, "Ogg Track.ogg");
  await pauseFromSystemControls(page);
  expect(await currentPlaylistSong(page)).toBe("Ogg Track.ogg");

  // Switching panes keeps the session (music keeps its card while hidden).
  await page.locator("#bottom-pane-mode").selectOption("video-player");
  await expect(page.locator("#video-player-pane")).toBeVisible();
  session = await mediaSessionState(page);
  expect(session.title).toBe("Ogg Fixture Title");
  expect(session.playbackState).toBe("paused");
});

test("music media session is released when the last song advances onto nothing", async ({ page }) => {
  await installMediaSessionRecorder(page);
  await openAndLoad(page);
  await page.locator("#music-library-tree .music-tree-song").filter({ hasText: "Oga Track.oga" }).dblclick();
  await waitForPlaying(page, "Oga Track.oga");
  await expect.poll(async () => (await mediaSessionState(page)).playbackState).toBe("playing");

  // Single-song playlist without loop: "next" has no item, which clears the song.
  expect(await invokeMediaSessionAction(page, "nexttrack")).toBe(true);
  await expect.poll(async () => page.evaluate(() => {
    const audio = document.getElementById("music-audio");
    return Boolean(audio.getAttribute("src"));
  })).toBe(false);
  await expect.poll(async () => (await mediaSessionState(page)).metadata).toBeNull();
  const session = await mediaSessionState(page);
  expect(session.playbackState).toBe("none");
  expect(session.handlers).toEqual([]);
});

// Merged from the deleted music-formats.integration.spec.js
// (e2e-dedup-faster): that file booted a second integration server on
// the same generated fixture and redefined the same openAndLoad /
// waitForPlaying helpers defined above. The format matrix test itself is
// kept verbatim.
test("native Ogg, Oga, Opus, and FLAC formats are discoverable, playable, metadata-aware, and waveform-ready", async ({ page }) => {
  await openAndLoad(page);

  await expect(page.locator("#music-library-tree .music-tree-song")).toHaveCount(5);
  await expect(page.locator("#music-library-tree")).toContainText("Ogg Track.ogg");
  await expect(page.locator("#music-library-tree")).toContainText("Lossless.flac");
  await expect(page.locator("#music-library-tree")).toContainText("Oga Track.oga");
  await expect(page.locator("#music-library-tree")).toContainText("Opus Track.opus");
  await expect(page.locator("#music-library-tree")).toContainText("Audiobook.m4b");

  for (const [filename, title, artist] of [
    ["Ogg Track.ogg", "Ogg Fixture Title", "Ogg Fixture Artist"],
    ["Lossless.flac", "FLAC Fixture Title", "FLAC Fixture Artist"],
    ["Oga Track.oga", "Oga Fixture Title", "Oga Fixture Artist"],
    ["Opus Track.opus", "Opus Fixture Title", "Opus Fixture Artist"],
    ["Audiobook.m4b", "M4B Fixture Title", "M4B Fixture Artist"],
  ]) {
    await page.locator("#music-library-tree .music-tree-song").filter({hasText: filename}).dblclick();
    await waitForPlaying(page, filename);
    await expect(page.locator("#music-song-title")).toHaveText(title);
    await expect(page.locator("#music-song-artist")).toHaveText(artist);
    await expect.poll(() => page.evaluate(() => {
      const audio = document.getElementById("music-audio");
      return Number.isFinite(audio?.duration) && audio.duration > 0;
    }), {timeout: 5000}).toBe(true);
  }
});
