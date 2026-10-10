const { test, expect } = require("@playwright/test");

const workerPortOffset = Number(process.env.DROPBOX_BROWSER_E2E_LANE_INDEX || "0") * 100;
process.env.PLAYWRIGHT_PORT = String(8035 + workerPortOffset);
const baseURL = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT}`;
test.use({ baseURL, viewport: { width: 1280, height: 760 } });
test.describe.configure({ mode: "serial", timeout: 45000 });

const { startServer, stopServer } = require("./support/server");

// After a per-row sync (either direction) or a batch sync finishes, sync.js
// refreshes the current folder in place (DropboxBrowseClient
// .refreshCurrentFolderInPlace) instead of reloading the page, so the
// scroll position is kept and a playing music/video element is untouched.
//
// Fixture sync-in-place.json: sync-test/file-001..060.txt, odd numbers are
// Dropbox Only, even numbers Local Only (enough rows for <main> to scroll).
const FOLDER = "sync-test";
const SCROLL_TOLERANCE = 4;

let server = null;

test.beforeAll(async () => {
  server = await startServer({ fixtureName: "sync-in-place.json" });
});

test.afterAll(async () => {
  await stopServer(server);
  server = null;
});

function file(number) {
  return `${FOLDER}/file-${String(number).padStart(3, "0")}.txt`;
}

function row(page, relPath) {
  return page.locator(`#browse-rows tr[data-row-path="${relPath}"]`);
}

function syncButton(page, relPath, direction) {
  return row(page, relPath).locator(`form.sync-form[data-sync-direction="${direction}"] button`);
}

function inPlaceRefreshCount(page) {
  return page.evaluate(() => Number(document.body.dataset.browseInPlaceRefreshCount || 0));
}

function mainScrollTop(page) {
  return page.locator("main").evaluate((main) => main.scrollTop);
}

// Watches for anything that would mean the document was replaced.
function trackNavigation(page) {
  const counts = { load: 0, navigated: 0 };
  page.on("load", () => { counts.load += 1; });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) counts.navigated += 1;
  });
  return counts;
}

async function openSyncFolder(page) {
  await page.goto(`/?path=${FOLDER}`);
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await expect(row(page, file(1)).locator(".status")).toHaveText("Dropbox Only");
  await expect(row(page, file(2)).locator(".status")).toHaveText("Local Only");
  await page.locator("#enable-to-local").check();
  await page.locator("#enable-write-dropbox").check();
  await page.evaluate(() => { window.__syncInPlaceMarker = "same-document"; });
}

// Scroll <main> so the given row sits in the middle of the viewport. Rows
// are virtualized, so first jump to the row's estimated offset (rows are
// sorted by name and all 48px tall), then centre the mounted row.
async function scrollRowToMiddle(page, relPath) {
  const index = Number(relPath.match(/file-(\d+)/)[1]) - 1;
  await page.evaluate((rowIndex) => {
    const main = document.querySelector("main");
    const mount = document.getElementById("browse-rows");
    const mainRect = main.getBoundingClientRect();
    const tableTop = mount.getBoundingClientRect().top - mainRect.top + main.scrollTop;
    main.scrollTop = tableTop + rowIndex * 48 - main.clientHeight / 2;
  }, index);
  await expect(row(page, relPath)).toHaveCount(1);
  const scrollTop = await page.evaluate((path) => {
    const main = document.querySelector("main");
    const target = document.querySelector(`#browse-rows tr[data-row-path="${CSS.escape(path)}"]`);
    const mainRect = main.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    main.scrollTop += rect.top - mainRect.top - (main.clientHeight - rect.height) / 2;
    return main.scrollTop;
  }, relPath);
  expect(scrollTop).toBeGreaterThan(300);
  await page.waitForTimeout(200);
  await expect(row(page, relPath)).toBeInViewport();
  return mainScrollTop(page);
}

// Play a generated, muted WAV through the music player's own <audio> element.
async function startMusicAudio(page) {
  await page.locator("#bottom-pane-mode").selectOption("music-player");
  await page.evaluate(async () => {
    const seconds = 60;
    const rate = 8000;
    const samples = rate * seconds;
    const buffer = new ArrayBuffer(44 + samples * 2);
    const view = new DataView(buffer);
    const writeText = (offset, text) => { for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i)); };
    writeText(0, "RIFF");
    view.setUint32(4, 36 + samples * 2, true);
    writeText(8, "WAVE");
    writeText(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeText(36, "data");
    view.setUint32(40, samples * 2, true);
    for (let i = 0; i < samples; i += 1) view.setInt16(44 + i * 2, Math.round(Math.sin(i / 10) * 800), true);
    const audio = document.getElementById("music-audio");
    audio.__syncInPlaceMarker = "same-audio-element";
    audio.muted = true;
    audio.src = URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
    await audio.play();
  });
  await expect.poll(() => audioState(page).then((state) => state.currentTime)).toBeGreaterThan(0.2);
}

function audioState(page) {
  return page.evaluate(() => {
    const audio = document.getElementById("music-audio");
    return {
      sameElement: !!(audio && audio.__syncInPlaceMarker === "same-audio-element"),
      paused: audio ? audio.paused : true,
      currentTime: audio ? audio.currentTime : 0,
    };
  });
}

async function expectAudioStillPlaying(page, before) {
  const now = await audioState(page);
  expect(now.sameElement, "the <audio> element was not recreated").toBe(true);
  expect(now.paused, "the <audio> element is still playing").toBe(false);
  await expect
    .poll(() => audioState(page).then((state) => state.currentTime), { message: "currentTime keeps advancing" })
    .toBeGreaterThan(Math.max(before.currentTime, now.currentTime) + 0.3);
}

async function syncRowAndWaitForInPlaceRefresh(page, relPath, direction) {
  const before = await inPlaceRefreshCount(page);
  const button = syncButton(page, relPath, direction);
  await expect(button).toBeEnabled();
  await button.click();
  await expect
    .poll(() => inPlaceRefreshCount(page), { timeout: 20000, message: `in-place refresh after ${direction}` })
    .toBeGreaterThan(before);
}

test("syncing in both directions refreshes the folder in place without interrupting playback", async ({ page }) => {
  const navigation = trackNavigation(page);
  await openSyncFolder(page);
  await startMusicAudio(page);
  const navigationBaseline = { ...navigation };

  // Download (Copy Dropbox -> Local) a Dropbox Only row far down the list.
  const downloaded = file(41);
  const scrollBefore = await scrollRowToMiddle(page, downloaded);
  const audioBefore = await audioState(page);
  await syncRowAndWaitForInPlaceRefresh(page, downloaded, "dropbox_to_local");
  await expect(row(page, downloaded).locator(".status")).toHaveText("Synced");
  await expect(row(page, downloaded).locator("form.sync-form")).toHaveCount(0);
  await expect(row(page, downloaded)).toBeInViewport();
  expect(Math.abs((await mainScrollTop(page)) - scrollBefore)).toBeLessThanOrEqual(SCROLL_TOLERANCE);
  await expectAudioStillPlaying(page, audioBefore);

  // Upload (Copy Local -> Dropbox) the Local Only neighbour.
  const uploaded = file(42);
  const scrollBeforeUpload = await scrollRowToMiddle(page, uploaded);
  const audioBeforeUpload = await audioState(page);
  await syncRowAndWaitForInPlaceRefresh(page, uploaded, "local_to_dropbox");
  await expect(row(page, uploaded).locator(".status")).toHaveText("Synced");
  await expect(row(page, uploaded)).toBeInViewport();
  expect(Math.abs((await mainScrollTop(page)) - scrollBeforeUpload)).toBeLessThanOrEqual(SCROLL_TOLERANCE);
  await expectAudioStillPlaying(page, audioBeforeUpload);

  // Other rows keep their statuses; toggles, URL and document are unchanged.
  await expect(row(page, file(43)).locator(".status")).toHaveText("Dropbox Only");
  await expect(row(page, file(44)).locator(".status")).toHaveText("Local Only");
  await expect(page.locator("#enable-to-local")).toBeChecked();
  await expect(page.locator("#enable-write-dropbox")).toBeChecked();
  await expect(page).toHaveURL(new RegExp(`\\?path=${FOLDER}$`));
  expect(await page.evaluate(() => window.__syncInPlaceMarker)).toBe("same-document");
  expect(navigation).toEqual(navigationBaseline);
  // The success popup hides itself again.
  await expect(page.locator("#sync-popup")).toBeHidden({ timeout: 5000 });
});

test("a failed in-place refresh keeps the rows, shows the warning banner, and Refresh recovers", async ({ page }) => {
  const navigation = trackNavigation(page);
  await openSyncFolder(page);
  const navigationBaseline = { ...navigation };
  const target = file(46);
  const scrollBefore = await scrollRowToMiddle(page, target);

  let failListing = true;
  await page.route("**/browse/endpoints/listing**", async (route) => {
    if (failListing) {
      await route.fulfill({ status: 500, contentType: "text/plain", body: "listing broke" });
      return;
    }
    await route.continue();
  });

  await syncButton(page, target, "local_to_dropbox").click();
  const banner = page.locator("#browse-listing-warning");
  await expect(banner).toBeVisible({ timeout: 20000 });
  await expect(banner).toHaveAttribute("data-listing-state", "refresh-failed");
  await expect(banner).toContainText("Could not refresh the folder listing");
  await expect(page.locator("body")).toHaveAttribute("data-browse-in-place-refresh", "error");
  // Old rows stay on screen (the sync did run; the view is just stale).
  await expect(row(page, target)).toBeVisible();
  await expect(row(page, target).locator(".status")).toHaveText("Local Only");
  expect(Math.abs((await mainScrollTop(page)) - scrollBefore)).toBeLessThanOrEqual(SCROLL_TOLERANCE);
  // The banner sits above the table (possibly out of view), so the sync popup
  // also says the listing is stale and stays open.
  await expect(page.locator("#sync-popup")).toBeVisible();
  await expect(page.locator("#sync-popup-message")).toContainText("could not be refreshed");

  failListing = false;
  await banner.getByRole("button", { name: "Refresh" }).click();
  await expect(banner).toBeHidden();
  await expect(page.locator("body")).toHaveAttribute("data-browse-in-place-refresh", "done");
  await scrollRowToMiddle(page, target);
  await expect(row(page, target).locator(".status")).toHaveText("Synced");
  expect(await page.evaluate(() => window.__syncInPlaceMarker)).toBe("same-document");
  expect(navigation).toEqual(navigationBaseline);
});

test("a sync that finishes after navigating away does not overwrite the new folder", async ({ page }) => {
  await openSyncFolder(page);
  const target = file(48);
  await scrollRowToMiddle(page, target);

  // Hold /sync-status until the user has navigated elsewhere.
  let releaseStatus;
  const statusGate = new Promise((resolve) => { releaseStatus = resolve; });
  await page.route("**/sync-status**", async (route) => {
    await statusGate;
    await route.continue();
  });

  await syncButton(page, target, "local_to_dropbox").click();
  await page.locator("header .meta a[href='/']").click();
  await expect(page.locator("body")).toHaveAttribute("data-current-folder-path", "");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await expect(row(page, "other-folder")).toBeVisible();
  const refreshesBefore = await inPlaceRefreshCount(page);

  releaseStatus();
  await expect(page.locator("#sync-popup-message")).toContainText(/complete|Synced|Copied/i, { timeout: 20000 });
  await page.waitForTimeout(500);
  expect(await inPlaceRefreshCount(page)).toBe(refreshesBefore);
  await expect(page.locator("body")).toHaveAttribute("data-current-folder-path", "");
  await expect(row(page, "other-folder")).toBeVisible();
  await expect(row(page, target)).toHaveCount(0);
  expect(await page.evaluate(() => window.__syncInPlaceMarker)).toBe("same-document");

  // Going back shows the fresh status.
  await page.goBack();
  await expect(page.locator("body")).toHaveAttribute("data-current-folder-path", FOLDER);
  await expect(row(page, target).locator(".status")).toHaveText("Synced");
});

test("a batch sync refreshes the folder in place", async ({ page }) => {
  const navigation = trackNavigation(page);
  await openSyncFolder(page);
  const navigationBaseline = { ...navigation };
  const before = await inPlaceRefreshCount(page);

  // The batch buttons sit above the table; open the plan first, then scroll
  // down while the confirmation dialog is shown.
  await page.locator(".batch-sync[data-batch-action='dropbox_only_to_local_all']").click();
  await expect(page.locator("#batch-confirm")).toBeVisible({ timeout: 20000 });
  const scrollBefore = await scrollRowToMiddle(page, file(50));
  await page.locator("#batch-confirm-run").click();
  await expect
    .poll(() => inPlaceRefreshCount(page), { timeout: 30000, message: "in-place refresh after the batch sync" })
    .toBeGreaterThan(before);
  await expect(row(page, file(49)).locator(".status")).toHaveText("Synced");
  await expect(row(page, file(51)).locator(".status")).toHaveText("Synced");
  expect(Math.abs((await mainScrollTop(page)) - scrollBefore)).toBeLessThanOrEqual(SCROLL_TOLERANCE);
  expect(await page.evaluate(() => window.__syncInPlaceMarker)).toBe("same-document");
  expect(navigation).toEqual(navigationBaseline);
});
