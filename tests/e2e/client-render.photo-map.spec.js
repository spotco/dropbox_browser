const { test, expect } = require("@playwright/test");

process.env.PLAYWRIGHT_PORT = "8026";
test.use({baseURL: "http://127.0.0.1:8026"});
const { startServer, stopServer } = require("./support/server");

let server = null;

test.beforeAll(async () => {
  server = await startServer({fixtureName: "camera-uploads-lifecycle.json"});
});

test.afterAll(async () => {
  await stopServer(server);
  server = null;
});

test("Photo Map starts only when selected, tears down on mode changes, and reopens from cache", async ({page}) => {
  const photoMapRequests = [];
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/photo-map/endpoints/") || url.includes("/assets/vendor/leaflet/") || url.includes("/file?")) {
      photoMapRequests.push({method: request.method(), url});
    }
  });

  await page.goto("/?path=Camera%20Uploads");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await expect(page.locator("#bottom-pane-mode")).toBeEnabled();

  await page.selectOption("#bottom-pane-mode", "music-player");
  await expect(page.locator("#music-player-pane")).toBeVisible();
  await page.selectOption("#bottom-pane-mode", "video-player");
  await expect(page.locator("#video-player-pane")).toBeVisible();
  expect(photoMapRequests).toEqual([]);

  await page.selectOption("#bottom-pane-mode", "photo-map");
  await expect(page.locator("#photo-map-pane")).toBeVisible();
  await expect.poll(() => page.evaluate(() => Boolean(
    window.DropboxBrowserPhotoMap && window.DropboxBrowserPhotoMap.getMap()
  ))).toBe(true);
  await expect.poll(() => photoMapRequests.some((request) => request.url.includes("/photo-map/endpoints/cache?"))).toBe(true);
  await expect.poll(() => photoMapRequests.filter((request) => request.url.includes("/file?")).length).toBe(2);
  await expect(page.locator("#photo-map-status")).toHaveAttribute("aria-busy", "false");

  const firstRangeCount = photoMapRequests.filter((request) => request.url.includes("/file?")).length;
  expect(firstRangeCount).toBe(2);

  await page.selectOption("#bottom-pane-mode", "music-player");
  await expect(page.locator("#photo-map-pane")).toBeHidden();
  await expect.poll(() => page.evaluate(() => Boolean(
    window.DropboxBrowserPhotoMap && window.DropboxBrowserPhotoMap.getMap()
  ))).toBe(false);
  await page.waitForTimeout(250);
  expect(photoMapRequests.filter((request) => request.url.includes("/file?")).length).toBe(firstRangeCount);

  await page.selectOption("#bottom-pane-mode", "video-player");
  await expect(page.locator("#video-player-pane")).toBeVisible();
  await page.selectOption("#bottom-pane-mode", "photo-map");
  await expect(page.locator("#photo-map-pane")).toBeVisible();
  await expect.poll(() => page.evaluate(() => Boolean(
    window.DropboxBrowserPhotoMap && window.DropboxBrowserPhotoMap.getMap()
  ))).toBe(true);
  await expect(page.locator("#photo-map-status")).toHaveAttribute("aria-busy", "false");
  expect(photoMapRequests.filter((request) => request.url.includes("/file?")).length).toBe(firstRangeCount);
});
