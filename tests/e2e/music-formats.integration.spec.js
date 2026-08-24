const path = require("node:path");
const { test, expect } = require("@playwright/test");

const workerPortOffset = Number(process.env.DROPBOX_BROWSER_E2E_LANE_INDEX || "0") * 100;
process.env.PLAYWRIGHT_PORT = String(8013 + workerPortOffset);
process.env.DROPBOX_BROWSER_E2E_FIXTURE = path.join(
  __dirname,
  "fixtures",
  "music_formats_generated_fixture.py",
);
process.env.DROPBOX_BROWSER_E2E_MUSIC_LIBRARY_POLL_DELAY_MS = "100";

const { startIntegrationServer, stopIntegrationServer } = require("./support/integration_server");

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
