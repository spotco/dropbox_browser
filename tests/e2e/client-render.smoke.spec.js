const { test, expect } = require("@playwright/test");

process.env.PLAYWRIGHT_PORT = "8012";
const clientRenderBaseURL = "http://127.0.0.1:8012";
test.use({ baseURL: clientRenderBaseURL });

const { startServer, stopServer } = require("./support/server");

let server = null;

test.beforeAll(async () => {
  server = await startServer({ clientRender: true });
});

test.afterAll(async () => {
  await stopServer(server);
  server = null;
});

test("client-render mode fetches and renders browse rows from the listing endpoint", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle(/SDB: Dropbox/);
  await expect(page.locator("body")).toHaveAttribute("data-client-render", "1");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await expect(page.locator("body")).toHaveAttribute("data-browse-endpoint", "/browse/endpoints/listing");
  await expect(page.locator("#browse-rows .empty")).toHaveCount(0);
  await expect.poll(async () => await page.locator("#browse-rows tr").count()).toBeGreaterThan(0);
  await expect(page.locator("#browse-rows .entry-name").first()).toBeVisible();
  await expect(page.locator('#browse-rows a[href^="/file?"]').first()).toBeVisible();
  await expect(page.locator('#browse-rows a[href^="/download?"]').first()).toBeVisible();
});

test("client-render filter bar toggles from the top action row and persists", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");

  await expect(page.locator("#browse-filter-toggle")).toHaveText("Show Filters");
  await expect(page.locator("#browse-filter-bar")).toBeHidden();

  await page.locator("#browse-filter-toggle").click();
  await expect(page.locator("#browse-filter-toggle")).toHaveText("Hide Filters");
  await expect(page.locator("#browse-filter-bar")).toBeVisible();

  await page.reload();
  await expect(page.locator("#browse-filter-toggle")).toHaveText("Hide Filters");
  await expect(page.locator("#browse-filter-bar")).toBeVisible();

  await page.locator("#browse-filter-toggle").click();
  await expect(page.locator("#browse-filter-toggle")).toHaveText("Show Filters");
  await expect(page.locator("#browse-filter-bar")).toBeHidden();

  await page.reload();
  await expect(page.locator("#browse-filter-toggle")).toHaveText("Show Filters");
  await expect(page.locator("#browse-filter-bar")).toBeHidden();
});

test("client-render sort updates URL and rows without refetching the listing endpoint", async ({ page }) => {
  let listingRequestCount = 0;
  page.on("request", (request) => {
    if (request.url().includes("/browse/endpoints/listing")) listingRequestCount += 1;
  });

  await page.goto("/");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await expect.poll(() => listingRequestCount).toBe(1);

  await page.getByRole("link", { name: "Date" }).click();

  await expect(page.locator("body")).toHaveAttribute("data-current-sort-key", "date");
  await expect(page.locator("body")).toHaveAttribute("data-current-sort-direction", "asc");
  await expect(page).toHaveURL(/\/\?sort=date$/);
  await page.waitForTimeout(250);
  await expect.poll(() => listingRequestCount).toBe(1);
});

test("client-render deep link loads the requested folder", async ({ page }) => {
  await page.goto("/?path=folder");

  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await expect(page.locator("body")).toHaveAttribute("data-current-folder-path", "folder");
  await expect(page).toHaveURL(/\?path=folder/);
  await expect(page.getByText("nested.txt")).toBeVisible();
});

test("client-render refresh reloads listing in place without a full page reload", async ({ page }) => {
  const listingUrls = [];
  let refreshPostCount = 0;
  page.on("request", (request) => {
    if (request.url().includes("/browse/endpoints/listing")) {
      listingUrls.push(request.url());
    }
    if (request.method() === "POST" && request.url().includes("/refresh-cache")) {
      refreshPostCount += 1;
    }
  });

  await page.goto("/");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await expect.poll(() => listingUrls.length).toBe(1);

  await page.evaluate(() => {
    window.__clientRenderRefreshMarker = "stay";
  });

  await page.getByRole("link", { name: /refresh/i }).click();
  await expect(page.locator("#refresh-blocker")).toBeVisible();
  await expect.poll(() => refreshPostCount).toBe(1);
  await expect.poll(() => listingUrls.length).toBe(2);
  await expect(listingUrls[1]).toContain("refresh=1");
  await expect(page.locator("#refresh-blocker")).toBeHidden();
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await expect(page).not.toHaveURL(/(?:\?|&)refresh=1/);
  expect(await page.evaluate(() => window.__clientRenderRefreshMarker)).toBe("stay");
});

test("client-render folder navigation uses history without a full page reload", async ({ page }) => {
  let listingRequestCount = 0;
  page.on("request", (request) => {
    if (request.url().includes("/browse/endpoints/listing")) listingRequestCount += 1;
  });

  await page.goto("/");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await expect.poll(() => listingRequestCount).toBe(1);

  await page.getByRole("link", { name: "folder" }).click();
  await expect(page).toHaveURL(/\?path=folder/);
  await expect(page.locator("body")).toHaveAttribute("data-current-folder-path", "folder");
  await expect(page.getByText("nested.txt")).toBeVisible();
  await expect.poll(() => listingRequestCount).toBe(2);

  await page.goBack();
  await expect(page).toHaveURL(/\/(?:\?.*)?$/);
  await expect(page.locator("body")).toHaveAttribute("data-current-folder-path", "");
  await expect(page.getByText("remote-only.txt")).toBeVisible();
  await expect.poll(() => listingRequestCount).toBe(3);

  await page.goForward();
  await expect(page).toHaveURL(/\?path=folder/);
  await expect(page.locator("body")).toHaveAttribute("data-current-folder-path", "folder");
  await expect(page.getByText("nested.txt")).toBeVisible();
  await expect.poll(() => listingRequestCount).toBe(4);
});

test("client-render history restores sort state from the URL", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");

  await page.getByRole("link", { name: "Date" }).click();
  await expect(page).toHaveURL(/sort=date/);
  await expect(page.locator("body")).toHaveAttribute("data-current-sort-key", "date");

  await page.goBack();
  await expect(page).not.toHaveURL(/sort=date/);
  await expect(page.locator("body")).toHaveAttribute("data-current-sort-key", "name");

  await page.goForward();
  await expect(page).toHaveURL(/sort=date/);
  await expect(page.locator("body")).toHaveAttribute("data-current-sort-key", "date");
});

test("client-render leaves preview and download links on normal navigation", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");

  const previewHref = await page.locator('#browse-rows a[href^="/file?"]').first().getAttribute("href");
  expect(previewHref).toMatch(/^\/file\?/);

  await page.locator('#browse-rows a[href^="/file?"]').first().click();
  await expect(page).toHaveURL(new RegExp(previewHref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("client-render filters rows locally without refetching the listing endpoint", async ({ page }) => {
  let listingRequestCount = 0;
  page.on("request", (request) => {
    if (request.url().includes("/browse/endpoints/listing")) listingRequestCount += 1;
  });

  await page.goto("/");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await page.locator("#browse-filter-toggle").click();
  await expect(page.locator("#browse-filter-bar")).toBeVisible();
  await expect(page.locator("#browse-filter-count")).toContainText("Showing 3 of 3 items");
  await expect.poll(() => listingRequestCount).toBe(1);

  await page.locator("#browse-filter-query").fill("remote");
  await expect(page.locator("#browse-rows .entry-name")).toHaveCount(1);
  await expect(page.locator("#browse-rows .entry-name").first()).toHaveText("remote-only.txt");
  await expect(page.locator("#browse-filter-count")).toContainText("Showing 1 of 3 items");
  await expect.poll(async () => (await page.url()).includes("q=remote")).toBe(true);
  await expect.poll(() => listingRequestCount).toBe(1);

  await page.locator("#browse-filter-kind").selectOption("folder");
  await expect(page.locator("#browse-rows .empty")).toContainText("No rows match the current filters.");
  await expect(page).toHaveURL(/kind=folder/);

  await page.reload();
  await expect(page.locator("#browse-filter-query")).toHaveValue("remote");
  await expect(page.locator("#browse-filter-kind")).toHaveValue("folder");
  await expect(page.locator("#browse-rows .empty")).toContainText("No rows match the current filters.");

  await page.locator("#browse-filter-reset").click();
  await expect(page.locator("#browse-rows .entry-name")).toHaveCount(3);
  await expect(page.locator("#browse-filter-count")).toContainText("Showing 3 of 3 items");
  await expect(page.locator("body")).toHaveAttribute("data-browse-filter-active", "0");
  await expect(page).not.toHaveURL(/(?:\?|&)q=/);
});

test("client-render active filter deep links auto-show the filter bar and stay applied", async ({ page }) => {
  await page.goto("/?q=folder");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await expect(page.locator("#browse-filter-bar")).toBeVisible();
  await expect(page.locator("#browse-filter-query")).toHaveValue("folder");
  await expect(page.locator("#browse-rows .entry-name")).toHaveCount(1);
  await expect(page.locator("#browse-rows .entry-name").first()).toHaveText("folder");

  await page.getByRole("link", { name: "folder" }).click();
  await expect(page).toHaveURL(/\?path=folder/);
  await expect(page.locator("#browse-filter-bar")).toBeHidden();
  await expect(page.locator("#browse-rows .entry-name")).toHaveCount(1);
  await expect(page.locator("#browse-rows .entry-name").first()).toHaveText("nested.txt");
});

test("client-render hiding the filter bar clears active filters and restores all rows", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");

  await page.locator("#browse-filter-toggle").click();
  await page.locator("#browse-filter-query").fill("remote");
  await expect(page.locator("#browse-rows .entry-name")).toHaveCount(1);
  await expect.poll(async () => (await page.url()).includes("q=remote")).toBe(true);

  await page.locator("#browse-filter-toggle").click();
  await expect(page.locator("#browse-filter-bar")).toBeHidden();
  await expect(page.locator("#browse-rows .entry-name")).toHaveCount(3);
  await expect(page.locator("body")).toHaveAttribute("data-browse-filter-active", "0");
  await expect(page).not.toHaveURL(/(?:\?|&)q=/);
});

test("client-render restores each folder's persisted filter state on navigation and popstate", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await page.locator("#browse-filter-toggle").click();

  await page.locator("#browse-filter-query").fill("folder");
  await expect.poll(async () => (await page.url()).includes("q=folder")).toBe(true);

  await page.getByRole("link", { name: "folder" }).click();
  await expect(page).toHaveURL(/\?path=folder/);
  await expect(page).not.toHaveURL(/(?:\?|&)q=/);
  await expect(page.locator("#browse-filter-query")).toHaveValue("");
  await expect(page.locator("#browse-filter-kind")).toHaveValue("all");
  await expect(page.locator("#browse-rows .entry-name")).toHaveCount(1);
  await expect(page.locator("#browse-rows .entry-name").first()).toHaveText("nested.txt");

  await page.locator("#browse-filter-toggle").click();
  await page.locator("#browse-filter-query").fill("nested");
  await expect.poll(async () => (await page.url()).includes("path=folder") && (await page.url()).includes("q=nested")).toBe(true);

  await page.goBack();
  await expect(page).toHaveURL(/\?path=folder$/);
  await expect(page.locator("#browse-filter-query")).toHaveValue("nested");
  await expect(page.locator("#browse-filter-kind")).toHaveValue("all");
  await expect(page.locator("#browse-rows .entry-name")).toHaveCount(1);
  await expect(page.locator("#browse-rows .entry-name").first()).toHaveText("nested.txt");

  await page.goBack();
  await expect(page).not.toHaveURL(/path=folder/);
  await expect(page).toHaveURL(/q=folder/);
  await expect(page.locator("#browse-filter-query")).toHaveValue("folder");
  await expect(page.locator("#browse-filter-kind")).toHaveValue("all");
  await expect(page.locator("#browse-rows .entry-name")).toHaveCount(1);
  await expect(page.locator("#browse-rows .entry-name").first()).toHaveText("folder");

  await page.goForward();
  await expect(page).toHaveURL(/\?path=folder$/);
  await expect(page.locator("#browse-filter-query")).toHaveValue("nested");
  await expect(page.locator("#browse-filter-kind")).toHaveValue("all");
  await expect(page.locator("#browse-rows .entry-name")).toHaveCount(1);
  await expect(page.locator("#browse-rows .entry-name").first()).toHaveText("nested.txt");
});

test("client-render text filter only matches names from the current folder, not parent path segments", async ({ page }) => {
  await page.goto("/?path=folder&q=folder");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await expect(page.locator("#browse-filter-bar")).toBeVisible();
  await expect(page.locator("#browse-filter-query")).toHaveValue("folder");
  await expect(page.locator("#browse-rows .entry-name")).toHaveCount(0);
  await expect(page.locator("#browse-rows .empty")).toContainText("No rows match the current filters.");
});

test("client-render music library load follows the current folder and resets on page change", async ({ page }) => {
  const libraryRequests = [];
  page.on("request", (request) => {
    if (request.url().includes("/music/endpoints/library?")) libraryRequests.push(request.url());
  });

  await page.goto("/");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");

  await page.selectOption("#bottom-pane-mode", "music-player");
  await expect(page.locator("#music-player-pane")).toBeVisible();
  await expect(page.locator("#music-player-status")).toContainText("Library not loaded.");

  await page.getByRole("link", { name: "folder" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-current-folder-path", "folder");

  await page.getByRole("button", { name: "Load Current Folder" }).click();
  await expect.poll(() => libraryRequests.some((url) => url.includes("/music/endpoints/library?path=folder"))).toBe(true);

  await page.goBack();
  await expect(page.locator("body")).toHaveAttribute("data-current-folder-path", "");
  await expect(page.locator("#music-player-status")).toContainText("Library not loaded.");
  await expect(page.getByRole("button", { name: "Load Current Folder" })).toBeEnabled();
});
