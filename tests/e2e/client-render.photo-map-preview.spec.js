const { test, expect } = require("@playwright/test");

process.env.PLAYWRIGHT_PORT = "8028";
test.use({baseURL: "http://127.0.0.1:8028"});
const { startServer, stopServer } = require("./support/server");

const OLD_IMAGE = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/4QCoRXhpZgAATU0AKgAAAAgAAgEyAAIAAAAUAAAAJoglAAQAAAABAAAAOgAAAAAyMDI0OjAzOjAxIDEyOjAwOjAwAAAEAAEAAgAAAAJOAAAAAAIABQAAAAMAAABwAAMAAgAAAAJXAAAAAAQABQAAAAMAAACIAAAAAAAAACgAAAABAAAAAAAAAAEAAAAAAAAAAQAAAEoAAAABAAAAAAAAAAEAAAAAAAAAAf/bAEMACAYGBwYFCAcHBwkJCAoMFA0MCwsMGRITDxQdGh8eHRocHCAkLicgIiwjHBwoNyksMDE0NDQfJzk9ODI8LjM0Mv/bAEMBCQkJDAsMGA0NGDIhHCEyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMv/AABEIACgAKAMBIgACEQEDEQH/xAAfAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgv/xAC1EAACAQMDAgQDBQUEBAAAAX0BAgMABBEFEiExQQYTUWEHInEUMoGRoQgjQrHBFVLR8CQzYnKCCQoWFxgZGiUmJygpKjQ1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4eLj5OXm5+jp6vHy8/T19vf4+fr/xAAfAQADAQEBAQEBAQEBAAAAAAAAAQIDBAUGBwgJCgv/xAC1EQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/AOWooorwz9UCiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooA//2Q=",
  "base64",
);
const PREVIEW_FIXTURE = require("./fixtures/photo-map-preview.json");
const NEW_IMAGE = Buffer.from(
  PREVIEW_FIXTURE.entries.find((entry) => entry.path.endsWith("group-newer.jpg")).base64,
  "base64",
);

function fixtureEntrySize(entry) {
  return entry.base64
    ? Buffer.from(entry.base64, "base64").length
    : Buffer.byteLength(String(entry.content || ""));
}

function mixedGroupCacheEntries() {
  return PREVIEW_FIXTURE.entries
    .filter((entry) => entry.type === "file" && entry.path.startsWith("Camera Uploads/group-"))
    .map((entry) => {
      const mediaKind = entry.path.endsWith(".mov") ? "video" : "photo";
      return {
        path: entry.path,
        source_path: entry.path,
        size: fixtureEntrySize(entry),
        modified_time: Date.parse(entry.mod_time) / 1000,
        status: "located",
        media_kind: mediaKind,
        latitude: 40.5,
        longitude: -74,
        capture_date: entry.mod_time,
        capture_date_ms: Date.parse(entry.mod_time),
        listing_date_ms: Date.parse(entry.mod_time),
        quicktime_parser_version: mediaKind === "video" ? "quicktime-iso6709-v3" : undefined,
      };
    });
}

let server = null;

async function mockGroupMedia(page) {
  await page.route("**/file?*", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).searchParams.get("path") || "";
    const media = path.startsWith("Camera Uploads/group-")
      ? (path.endsWith("group-newer.jpg") ? NEW_IMAGE : OLD_IMAGE) : null;
    if (!media) {
      await route.continue();
      return;
    }
    const range = request.headers().range || "";
    if (range && request.resourceType() !== "image") {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      const start = match ? Number(match[1]) : 0;
      const end = match && match[2] ? Math.min(Number(match[2]), media.length - 1) : media.length - 1;
      await route.fulfill({
        status: 206,
        contentType: "image/jpeg",
        headers: {"Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${media.length}`},
        body: media.subarray(start, end + 1),
      });
      return;
    }
    await route.fulfill({status: 200, contentType: "image/jpeg", body: media});
  });
  await page.route("**/thumbnail?*", async (route) => {
    const path = new URL(route.request().url()).searchParams.get("path") || "";
    if (!path.startsWith("Camera Uploads/group-")) {
      await route.continue();
      return;
    }
    await route.fulfill({status: 200, contentType: "image/jpeg", body: OLD_IMAGE});
  });
}

async function mockMixedGroupCache(page) {
  await page.route("**/photo-map/endpoints/cache?*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({status: "ok", entries: mixedGroupCacheEntries()}),
    });
  });
}

async function openSyntheticGroupedPopup(page, groupCount = 8) {
  await page.goto("/?path=Camera%20Uploads");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await page.locator("#bottom-pane-full-window-toggle").click();
  await expect(page.locator("body")).toHaveClass(/bottom-panel-full-window-mode/);
  await page.selectOption("#bottom-pane-mode", "photo-map");
  await expect(page.locator("#photo-map-status")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".photo-map-group-icon")).toBeVisible();
  await page.getByRole("button", {name: `Grouped media pin containing ${groupCount} media items`}).click();
  await expect(page.locator(".photo-map-group-grid")).toBeVisible();
}

async function photoMapDebugState(page) {
  return page.evaluate(() => window.DropboxBrowserPhotoMap.getDebugState());
}

test.beforeAll(async () => {
  server = await startServer({fixtureName: "photo-map-preview.json"});
});

test.afterAll(async () => {
  await stopServer(server);
  server = null;
});

test("grouped Photo Map restores the selected member after dismissing its full preview", async ({page}) => {
  await mockGroupMedia(page);
  await openSyntheticGroupedPopup(page);
  const selectedMember = page.locator('[data-photo-map-group-member-path="Camera Uploads/group-older.jpg"]');
  await selectedMember.click();
  await expect(selectedMember).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".photo-map-group-selection-details")).toBeVisible();

  await page.locator(".photo-map-group-selection a.photo-map-preview-link").click();
  await expect(page.locator("#photo-map-preview-overlay")).toBeVisible();
  await page.locator("[data-photo-map-preview-close]").click({position: {x: 1, y: 1}});

  await expect(page.locator("#photo-map-preview-overlay")).toBeHidden();
  await expect(page.locator(".photo-map-group-selection-details")).toBeVisible();
  await expect(selectedMember).toHaveAttribute("aria-pressed", "true");
});

test("grouped Photo Map restores the selected member when browser history closes its preview", async ({page}) => {
  await mockGroupMedia(page);
  await openSyntheticGroupedPopup(page);
  const selectedMember = page.locator('[data-photo-map-group-member-path="Camera Uploads/group-newer.jpg"]');
  await selectedMember.click();
  await page.locator(".photo-map-group-selection a.photo-map-preview-link").click();
  await expect(page.locator("#photo-map-preview-overlay")).toBeVisible();

  await page.goBack();

  await expect(page.locator("#photo-map-preview-overlay")).toBeHidden();
  await expect(page.locator(".photo-map-group-selection-details")).toBeVisible();
  await expect(selectedMember).toHaveAttribute("aria-pressed", "true");
});

test("grouped Photo Map returns to the grid and accepts another real member click", async ({page}) => {
  await mockGroupMedia(page);
  await openSyntheticGroupedPopup(page);
  const olderMember = page.locator('[data-photo-map-group-member-path="Camera Uploads/group-older.jpg"]');
  const newerMember = page.locator('[data-photo-map-group-member-path="Camera Uploads/group-newer.jpg"]');
  await olderMember.click();
  await expect(page.locator(".photo-map-group-selection-details")).toBeVisible();
  await page.getByRole("button", {name: "Close preview"}).click();
  await expect(page.locator(".photo-map-group-selection-details")).toHaveCount(0);
  await expect(olderMember).toHaveAttribute("aria-pressed", "false");

  await newerMember.click();
  await expect(page.locator(".photo-map-group-selection-details")).toBeVisible();
  await expect(newerMember).toHaveAttribute("aria-pressed", "true");
});

test("grouped Photo Map keeps loaded photo and video thumbnails plus grid scroll after preview close", async ({page}) => {
  await mockGroupMedia(page);
  await mockMixedGroupCache(page);
  await openSyntheticGroupedPopup(page, 10);
  const grid = page.locator(".photo-map-group-grid");
  const popupRoot = await page.locator(".leaflet-popup-content > .photo-map-grouped-preview").elementHandle();
  expect(popupRoot).not.toBeNull();
  const videoMember = page.locator('[data-photo-map-group-member-path="Camera Uploads/group-video-a.mov"]');
  await expect(videoMember).toBeVisible();
  await expect(grid.locator("img")).toHaveCount(10);
  const debugBeforePreview = await photoMapDebugState(page);
  expect(debugBeforePreview.activeGroupedPopupPath).not.toBe("");
  const scrollTop = await grid.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return element.scrollTop;
  });
  expect(scrollTop).toBeGreaterThan(0);
  await grid.evaluate((element) => { window.__photoMapGridForCoverage = element; });

  await videoMember.click();
  await expect(page.locator("#photo-map-preview-overlay")).toBeVisible();
  const scrollTopBeforeClose = await grid.evaluate((element) => element.scrollTop);
  expect(scrollTopBeforeClose).toBeGreaterThan(0);
  await page.locator("[data-photo-map-preview-close]").click({position: {x: 1, y: 1}});

  await expect(page.locator("#photo-map-preview-overlay")).toBeHidden();
  await expect(grid.locator("img")).toHaveCount(10);
  await expect(videoMember).toHaveAttribute("aria-pressed", "true");
  expect(await grid.evaluate((element) => element.scrollTop)).toBeGreaterThanOrEqual(scrollTopBeforeClose - 1);
  expect(await page.evaluate(() => document.querySelector(".photo-map-group-grid") === window.__photoMapGridForCoverage)).toBe(true);
  expect(await page.evaluate((root) => document.querySelector(".leaflet-popup-content > .photo-map-grouped-preview") === root, popupRoot)).toBe(true);
  const debugState = await photoMapDebugState(page);
  expect(debugState.selectedGroupedMemberPath).toBe("Camera Uploads/group-video-a.mov");
  expect(debugState.map.popupMounted).toBe(true);
  expect(debugState.map.gridScrollTop).toBeGreaterThanOrEqual(scrollTopBeforeClose - 1);
  expect(debugState.thumbnailScheduler).not.toBeNull();
  expect(debugState.activeGroupedPopupPath).toBe(debugBeforePreview.activeGroupedPopupPath);
  expect(debugState.thumbnailScheduler.desiredPaths).toContain("Camera Uploads/group-video-a.mov");
  expect(debugState.thumbnailScheduler.cachedPaths).toEqual(expect.any(Array));
});

test("grouped Photo Map preview hides the previous poster until the next member loads", async ({page}) => {
  let newerRequestSeen = false;
  let releaseNewer = null;
  const newerGate = new Promise((resolve) => { releaseNewer = resolve; });

  await page.route("**/file?*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.searchParams.get("path") || "";
    const image = path.startsWith("Camera Uploads/group-")
      ? (path.endsWith("group-newer.jpg") ? NEW_IMAGE : OLD_IMAGE) : null;
    if (!image) {
      await route.continue();
      return;
    }
    const range = request.headers().range || "";
    if (range && request.resourceType() !== "image") {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      const start = match ? Number(match[1]) : 0;
      const end = match && match[2] ? Math.min(Number(match[2]), image.length - 1) : image.length - 1;
      await route.fulfill({
        status: 206,
        contentType: "image/jpeg",
        headers: {
          "Accept-Ranges": "bytes",
          "Content-Range": `bytes ${start}-${end}/${image.length}`,
        },
        body: image.subarray(start, end + 1),
      });
      return;
    }
    if (path.endsWith("group-newer.jpg")) {
      newerRequestSeen = true;
      await newerGate;
      await route.fulfill({status: 200, contentType: "image/jpeg", body: NEW_IMAGE});
      return;
    }
    await route.fulfill({status: 200, contentType: "image/jpeg", body: OLD_IMAGE});
  });

  await page.goto("/?path=Camera%20Uploads");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await page.selectOption("#bottom-pane-mode", "photo-map");
  await expect(page.locator("#photo-map-pane")).toBeVisible();
  await expect(page.locator("#photo-map-status")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".photo-map-group-icon")).toBeVisible();

  await page.getByRole("button", {name: "Grouped media pin containing 8 media items"}).click();
  const grid = page.locator(".photo-map-group-grid");
  await expect(grid).toBeVisible();
  await page.locator('[data-photo-map-group-member-path="Camera Uploads/group-older.jpg"]').dispatchEvent("click");
  await page.locator(".photo-map-group-selection a.photo-map-preview-link").dispatchEvent("click");

  const poster = page.locator("#photo-map-preview-poster");
  await expect(poster).toBeVisible();
  await expect(poster).toHaveAttribute("src", /group-older\.jpg/);
  const oldSurface = await page.locator(".photo-map-preview-surface").screenshot();

  await page.locator("#photo-map-preview-close").click();
  await expect(page.locator("#photo-map-preview-overlay")).toBeHidden();
  // Returning from the preview URL reloads the browse state. Re-activate the
  // pane before selecting the next synthetic member so the regression checks
  // poster replacement rather than depending on pane-navigation timing.
  await page.selectOption("#bottom-pane-mode", "server-log");
  await page.selectOption("#bottom-pane-mode", "photo-map");
  await expect(page.locator("#photo-map-status")).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", {name: "Grouped media pin containing 8 media items"}).click();
  await expect(page.locator(".photo-map-group-grid")).toBeVisible();
  await page.locator('[data-photo-map-group-member-path="Camera Uploads/group-newer.jpg"]').dispatchEvent("click");
  await page.locator(".photo-map-group-selection a.photo-map-preview-link").dispatchEvent("click");
  await expect.poll(() => newerRequestSeen).toBe(true);
  await expect(poster).toHaveAttribute("src", /group-newer\.jpg/);
  expect(await poster.evaluate((element) => element.hidden)).toBe(true);
  const pendingSurface = await page.locator(".photo-map-preview-surface").screenshot();
  expect(pendingSurface.equals(oldSurface)).toBe(false);

  releaseNewer();
  await expect(poster).toBeVisible();
});

test("grouped Photo Map keeps the expanded member popup inside the map window", async ({page}) => {
  await page.route("**/file?*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.searchParams.get("path") || "";
    const media = path.startsWith("Camera Uploads/group-")
      ? (path.endsWith("group-newer.jpg") ? NEW_IMAGE : OLD_IMAGE) : null;
    if (!media) {
      await route.continue();
      return;
    }
    const range = request.headers().range || "";
    if (range && request.resourceType() !== "image") {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      const start = match ? Number(match[1]) : 0;
      const end = match && match[2] ? Math.min(Number(match[2]), media.length - 1) : media.length - 1;
      await route.fulfill({
        status: 206,
        contentType: "image/jpeg",
        headers: {
          "Accept-Ranges": "bytes",
          "Content-Range": `bytes ${start}-${end}/${media.length}`,
        },
        body: media.subarray(start, end + 1),
      });
      return;
    }
    await route.fulfill({status: 200, contentType: "image/jpeg", body: media});
  });
  await page.route("**/thumbnail?*", async (route) => {
    const path = new URL(route.request().url()).searchParams.get("path") || "";
    if (!path.startsWith("Camera Uploads/group-")) {
      await route.continue();
      return;
    }
    await route.fulfill({status: 200, contentType: "image/jpeg", body: OLD_IMAGE});
  });
  await page.setViewportSize({width: 1000, height: 720});
  await page.goto("/?path=Camera%20Uploads");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await page.locator("#bottom-pane-full-window-toggle").click();
  await expect(page.locator("body")).toHaveClass(/bottom-panel-full-window-mode/);
  await page.selectOption("#bottom-pane-mode", "photo-map");
  await expect(page.locator("#photo-map-status")).toHaveAttribute("aria-busy", "false");
  const primaryGroupPin = page.getByRole("button", {name: "Grouped media pin containing 8 media items"});
  await expect(primaryGroupPin).toBeVisible();
  await primaryGroupPin.click();
  await expect(page.locator(".photo-map-group-grid")).toBeVisible();
  await expect(page.locator("[data-photo-map-group-member-path]")).toHaveCount(8);

  const member = page.locator('[data-photo-map-group-member-path="Camera Uploads/group-older.jpg"]');
  await expect(member).toBeVisible();
  await page.waitForTimeout(750);
  await page.locator(".leaflet-popup-content").evaluate((content) => {
    // Simulate the progressive popup reconciliation that replaces the grid
    // inside Leaflet's stable popup element.
    content.innerHTML = content.innerHTML;
  });
  await page.evaluate(() => {
    const map = window.DropboxBrowserPhotoMap.getMap();
    window.__photoMapMoveEnds = 0;
    map.on("moveend", () => { window.__photoMapMoveEnds += 1; });
  });
  await member.click();
  await expect(page.locator(".photo-map-group-selection-details")).toBeVisible();

  // Cached thumbnail demand must settle after the selection. A repeated
  // moveend here makes other grouped pins impossible to click in the live UI.
  await page.waitForTimeout(750);
  // Leaflet reflows the popup on the next animation frame. The selected
  // details must survive that reflow rather than briefly appearing and then
  // being replaced by the popup's stale initial content.
  await expect(page.locator(".photo-map-group-selection-details")).toBeVisible();
  await expect(member).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => window.__photoMapMoveEnds)).toBeLessThanOrEqual(2);

  await expect.poll(async () => {
    const mapBox = await page.locator("#photo-map-map").boundingBox();
    const popupBox = await page.locator(".leaflet-popup").boundingBox();
    if (!mapBox || !popupBox) return false;
    return popupBox.y >= mapBox.y &&
      popupBox.x >= mapBox.x &&
      popupBox.y + popupBox.height <= mapBox.y + mapBox.height &&
      popupBox.x + popupBox.width <= mapBox.x + mapBox.width;
  }).toBe(true);
});
