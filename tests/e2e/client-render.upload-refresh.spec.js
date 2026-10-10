const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");

const workerPortOffset = Number(process.env.DROPBOX_BROWSER_E2E_LANE_INDEX || "0") * 100;
process.env.PLAYWRIGHT_PORT = String(8032 + workerPortOffset);
const uploadRefreshBaseURL = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT}`;
test.use({ baseURL: uploadRefreshBaseURL });

const { startServer, stopServer } = require("./support/server");

// "Upload" here is the per-row Copy Local -> Dropbox sync action (POST /sync,
// rcat on the server). The browser has no generic upload route.
const repoRoot = path.resolve(__dirname, "..", "..");
const FOLDER = "upload-test";
const DROPBOX_ONLY = `${FOLDER}/dropbox-only.txt`;
const LOCAL_ONLY = `${FOLDER}/local-only.txt`;
const THROTTLE_STDERR = "Failed to lsjson: too_many_requests/..: Too many requests or write operations. Trying again in 1 seconds.";

// Fault-injection control file read by tests/fake_rclone.py. Faults stay
// dormant until the upload's rcat succeeds; then the next directory listings
// of the uploaded-to folder fail the way a throttled Dropbox API does.
const faultsDir = path.join(repoRoot, ".dropbox-browser-temp", "e2e", `upload-refresh-faults-${process.pid}`);
const faultsPath = path.join(faultsDir, "faults.json");

function writeFaults(folder, remaining, afterWrite) {
  fs.mkdirSync(faultsDir, { recursive: true });
  fs.writeFileSync(faultsPath, JSON.stringify({
    lsjson_target: `dropbox:${folder}`,
    remaining,
    after_write: afterWrite,
    stderr: THROTTLE_STDERR,
  }));
}

function armLsjsonFaultsAfterNextUpload(remaining, folder = FOLDER) {
  writeFaults(folder, remaining, true);
}

// Every directory listing of `folder` fails from now on (until disarmed).
function failLsjsonNow(folder) {
  writeFaults(folder, 1000, false);
}

function disarmFaults() {
  writeFaults("", 0, false);
}

function consumedFaultCount() {
  try {
    return (JSON.parse(fs.readFileSync(faultsPath, "utf8")).consumed || []).length;
  } catch (_error) {
    return 0;
  }
}

let server = null;
let previousFaultsEnv;

test.beforeAll(async () => {
  previousFaultsEnv = process.env.DROPBOX_BROWSER_FAKE_RCLONE_FAULTS;
  process.env.DROPBOX_BROWSER_FAKE_RCLONE_FAULTS = faultsPath;
  // Arm the first test's faults before the server starts: the readiness probe
  // (GET /) kicks off a background folder-cache pass that lists broken-test,
  // and a successful listing there would be cached before the test runs.
  failLsjsonNow("broken-test");
  server = await startServer({ clientRender: true, fixtureName: "upload-refresh.json" });
});

test.afterAll(async () => {
  await stopServer(server);
  server = null;
  if (previousFaultsEnv === undefined) delete process.env.DROPBOX_BROWSER_FAKE_RCLONE_FAULTS;
  else process.env.DROPBOX_BROWSER_FAKE_RCLONE_FAULTS = previousFaultsEnv;
  fs.rmSync(faultsDir, { recursive: true, force: true });
});

function row(page, relPath) {
  return page.locator(`#browse-rows tr[data-row-path="${relPath}"]`);
}

async function waitForFolderReady(page, folder = FOLDER) {
  const body = page.locator("body");
  await expect(body).toHaveAttribute("data-current-folder-path", folder);
  await expect(body).toHaveAttribute("data-browse-client", "ready");
}

function listingWarning(page) {
  return page.locator("#browse-listing-warning");
}

async function describeRows(page) {
  const rows = await page.locator("#browse-rows tr[data-row-path]").evaluateAll((elements) =>
    elements.map((element) => `${element.getAttribute("data-row-path")} [${(element.querySelector(".status") || {}).textContent || ""}]`),
  );
  return JSON.stringify(rows);
}

function inPlaceRefreshCount(page) {
  return page.evaluate(() => Number(document.body.dataset.browseInPlaceRefreshCount || 0));
}

// Open the folder, upload one Local Only file through the row sync button and
// wait for sync.js's automatic in-place folder refresh after /sync-status
// completes (no page reload: a window marker must survive).
async function uploadThroughUi(page, relPath, folder = FOLDER) {
  await page.goto(`/?path=${encodeURIComponent(folder)}`);
  await waitForFolderReady(page, folder);
  await expect(row(page, `${folder}/dropbox-only.txt`).locator(".status")).toHaveText("Dropbox Only");
  await expect(row(page, relPath).locator(".status")).toHaveText("Local Only");
  await expect(listingWarning(page)).toHaveCount(0);

  await page.locator("#enable-write-dropbox").check();
  const uploadButton = row(page, relPath).locator('form.sync-form[data-sync-direction="local_to_dropbox"] button');
  await expect(uploadButton).toBeEnabled();
  const refreshesBefore = await inPlaceRefreshCount(page);
  await page.evaluate(() => { window.__uploadRefreshMarker = "same-document"; });
  await uploadButton.click();
  await expect
    .poll(() => inPlaceRefreshCount(page), { timeout: 20000, message: "the folder should refresh in place after the upload" })
    .toBeGreaterThan(refreshesBefore);
  await waitForFolderReady(page, folder);
  expect(await page.evaluate(() => window.__uploadRefreshMarker)).toBe("same-document");
}

// Runs first on purpose: later tests trigger recursive folder-cache passes that
// would list (and cache) broken-test before its faults are armed.
test("a persistently failing Dropbox listing shows local rows as Unknown with a banner, and Refresh recovers", async ({ page }) => {
  test.setTimeout(30000);
  const folder = "broken-test";
  const localFile = `${folder}/local-file.txt`;
  const remoteFile = `${folder}/remote-file.txt`;
  failLsjsonNow(folder);

  await page.goto(`/?path=${encodeURIComponent(folder)}`);
  await waitForFolderReady(page, folder);

  const banner = listingWarning(page);
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute("data-listing-state", "local-only");
  await expect(banner).toContainText("Dropbox listing unavailable, showing local files");
  await expect(banner).toHaveAttribute("title", /too_many_requests/);
  await expect(row(page, localFile).locator(".status")).toHaveText("Unknown");
  await expect(row(page, localFile).locator(".status")).toHaveClass(/\bunknown\b/);
  await expect(row(page, localFile).locator("form.sync-form")).toHaveCount(0);
  await expect(row(page, remoteFile)).toHaveCount(0);

  disarmFaults();
  await banner.getByRole("button", { name: "Refresh" }).click();

  await expect(row(page, remoteFile).locator(".status")).toHaveText("Dropbox Only");
  await expect(row(page, localFile).locator(".status")).toHaveText("Local Only");
  await expect(banner).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`path=${folder}`));
});

test("the in-place refresh right after an upload keeps Dropbox-only files when the first listing is throttled", async ({ page }) => {
  test.setTimeout(30000);
  const uploaded = `${FOLDER}/upload-a.txt`;
  armLsjsonFaultsAfterNextUpload(1);

  await uploadThroughUi(page, uploaded);

  await expect.poll(consumedFaultCount, { message: "the post-upload lsjson failure should be hit" }).toBe(1);
  await expect(
    row(page, DROPBOX_ONLY),
    `rows after the post-upload refresh: ${await describeRows(page)}`,
  ).toHaveCount(1);
  await expect(row(page, uploaded).locator(".status")).toHaveText("Synced");
  await expect(row(page, LOCAL_ONLY).locator(".status")).toHaveText("Local Only");
  await expect(listingWarning(page)).toHaveCount(0);
});

test("once Dropbox recovers, reloading shows the Dropbox listing again instead of a cached local-only view", async ({ page }) => {
  test.setTimeout(30000);
  const uploaded = `${FOLDER}/upload-b.txt`;
  // One throttled listing right after the upload, then Dropbox is healthy.
  armLsjsonFaultsAfterNextUpload(1);

  await uploadThroughUi(page, uploaded);
  await expect.poll(consumedFaultCount, { message: "the post-upload lsjson failure should be hit" }).toBe(1);

  // Dropbox is healthy from here on; plain reloads must recover.
  await page.reload();
  await waitForFolderReady(page);
  await page.reload();
  await waitForFolderReady(page);
  await expect(
    row(page, DROPBOX_ONLY),
    `rows on a healthy reload after the throttling ended: ${await describeRows(page)}`,
  ).toHaveCount(1);
  await expect(row(page, uploaded).locator(".status")).toHaveText("Synced");
});

test("persistent throttling after an upload shows the last known Dropbox listing marked stale", async ({ page }) => {
  test.setTimeout(30000);
  const folder = "stale-test";
  const uploaded = `${folder}/upload-c.txt`;
  const dropboxOnly = `${folder}/dropbox-only.txt`;
  armLsjsonFaultsAfterNextUpload(1000, folder);

  await uploadThroughUi(page, uploaded, folder);

  const banner = listingWarning(page);
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute("data-listing-state", "stale");
  await expect(banner).toContainText("last known Dropbox listing");
  await expect(
    row(page, dropboxOnly),
    `rows while Dropbox listings fail: ${await describeRows(page)}`,
  ).toHaveCount(1);

  disarmFaults();
  await banner.getByRole("button", { name: "Refresh" }).click();

  await expect(banner).toBeHidden();
  await expect(row(page, uploaded).locator(".status")).toHaveText("Synced");
  await expect(row(page, dropboxOnly).locator(".status")).toHaveText("Dropbox Only");
});