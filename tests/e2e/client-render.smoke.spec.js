const { test, expect } = require("@playwright/test");

process.env.PLAYWRIGHT_PORT = "8022";
const clientRenderBaseURL = "http://127.0.0.1:8022";
test.use({ baseURL: clientRenderBaseURL });
// Shared default is 10s; several navigations need more headroom after long suites.
test.describe.configure({timeout: 30000});

const { startServer, stopServer } = require("./support/server");

let server = null;

async function browseColumnMetrics(page) {
  return page.evaluate(() => {
    const table = document.querySelector("table[data-browse-table]");
    const shell = document.querySelector(".browse-table-shell");
    const api = table && table.__browseColumnResizeApi;
    return {
      currentWidths: api && typeof api.getWidths === "function" ? api.getWidths() : {},
      preferredWidths: api && typeof api.getPreferredWidths === "function" ? api.getPreferredWidths() : {},
      shellClientWidth: shell ? shell.clientWidth : 0,
      shellScrollWidth: shell ? shell.scrollWidth : 0,
      storage: JSON.parse(window.localStorage.getItem("dropbox-browser.browse-column-widths-v1") || "null"),
    };
  });
}

async function dragBrowseColumnResizer(page, columnKey, deltaX) {
  const handle = page.locator(`th[data-browse-column-key="${columnKey}"] .browse-column-resizer`);
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  const startX = box.x + (box.width / 2);
  const startY = box.y + (box.height / 2);
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + deltaX, startY, { steps: 10 });
  await page.mouse.up();
}

test.beforeAll(async () => {
  server = await startServer({ clientRender: true });
});

test.afterAll(async () => {
  await stopServer(server);
  server = null;
});

test("client-render mode fetches and renders browse rows from the listing endpoint", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push(String(error));
  });

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
  expect(pageErrors).toEqual([]);
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

test("client-render persists sort per folder without sort or direction URL parameters", async ({ page }) => {
  const listingUrls = [];
  page.on("request", (request) => {
    if (request.url().includes("/browse/endpoints/listing")) listingUrls.push(request.url());
  });

  await page.goto("/");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await expect.poll(() => listingUrls.length).toBe(1);

  await page.getByRole("link", { name: "Date" }).click();

  await expect(page.locator("body")).toHaveAttribute("data-current-sort-key", "date");
  await expect(page.locator("body")).toHaveAttribute("data-current-sort-direction", "asc");
  await expect(page).not.toHaveURL(/(?:\?|&)(?:sort|dir)=/);
  await expect.poll(() => listingUrls.length).toBe(1);

  await page.getByRole("link", { name: "folder" }).click();
  await expect(page).toHaveURL(/\?path=folder/);
  await expect(page).not.toHaveURL(/(?:\?|&)(?:sort|dir)=/);
  await expect(page.locator("body")).toHaveAttribute("data-current-sort-key", "name");
  await expect(page.locator("body")).toHaveAttribute("data-current-sort-direction", "asc");
  await expect.poll(() => listingUrls.length).toBe(2);

  await page.locator("header .meta a[href='/']").click();
  await expect(page).toHaveURL(/\/\?$/);
  await expect(page).not.toHaveURL(/(?:\?|&)(?:sort|dir)=/);
  await expect(page.locator("body")).toHaveAttribute("data-current-sort-key", "date");
  await expect(page.locator("body")).toHaveAttribute("data-current-sort-direction", "asc");
  await expect.poll(() => listingUrls.length).toBe(3);
  expect(listingUrls[2]).toContain("sort=date");
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

test("client-render ignores legacy sort and direction URL parameters", async ({ page }) => {
  await page.goto("/?sort=date&dir=desc");
  // After long suites the first paint can land before the browse client marks
  // ready; give it the same headroom as other client-render navigations.
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready", {timeout: 15000});
  await expect(page.locator("body")).toHaveAttribute("data-current-sort-key", "name");
  await expect(page.locator("body")).toHaveAttribute("data-current-sort-direction", "asc");
  await expect(page).not.toHaveURL(/(?:\?|&)(?:sort|dir)=/);
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
  await expect.poll(async () => await page.url()).toMatch(/\?path=folder/);
  await expect.poll(async () => await page.url()).not.toMatch(/(?:\?|&)q=/);
  await expect(page.locator("#browse-filter-query")).toHaveValue("");
  await expect(page.locator("#browse-filter-kind")).toHaveValue("all");
  await expect(page.locator("#browse-rows .entry-name")).toHaveCount(1);
  await expect(page.locator("#browse-rows .entry-name").first()).toHaveText("nested.txt");

  await page.locator("#browse-filter-toggle").click();
  await page.locator("#browse-filter-query").fill("nested");
  await expect.poll(async () => (await page.url()).includes("path=folder") && (await page.url()).includes("q=nested")).toBe(true);

  await page.goBack();
  await expect.poll(async () => await page.url()).toMatch(/\?path=folder$/);
  await expect.poll(async () => await page.locator("#browse-filter-query").inputValue()).toBe("nested");
  await expect(page.locator("#browse-filter-kind")).toHaveValue("all");
  await expect(page.locator("#browse-rows .entry-name")).toHaveCount(1);
  await expect(page.locator("#browse-rows .entry-name").first()).toHaveText("nested.txt");

  await page.goBack();
  await expect.poll(async () => await page.url()).not.toMatch(/path=folder/);
  await expect.poll(async () => await page.url()).toMatch(/q=folder/);
  await expect.poll(async () => await page.locator("#browse-filter-query").inputValue()).toBe("folder");
  await expect(page.locator("#browse-filter-kind")).toHaveValue("all");
  await expect(page.locator("#browse-rows .entry-name")).toHaveCount(1);
  await expect(page.locator("#browse-rows .entry-name").first()).toHaveText("folder");

  await page.goForward();
  await expect.poll(async () => await page.url()).toMatch(/\?path=folder$/);
  await expect.poll(async () => await page.locator("#browse-filter-query").inputValue()).toBe("nested");
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

test("client-render shrinks saved browse columns to the viewport without overwriting the user's preferred widths", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 820 });
  await page.goto("/");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");

  const savedWideColumns = {
    name: 560,
    type: 90,
    status: 130,
    size: 120,
    date: 220,
    view: 80,
    sync: 160,
  };
  await page.evaluate((preferred) => {
    window.localStorage.setItem(
      "dropbox-browser.browse-column-widths-v1",
      JSON.stringify({ preferred }),
    );
  }, savedWideColumns);
  await page.reload();
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");

  const widenedMetrics = await browseColumnMetrics(page);
  expect(widenedMetrics.storage).toEqual({ preferred: widenedMetrics.preferredWidths });
  expect(widenedMetrics.preferredWidths).toEqual(savedWideColumns);
  expect(widenedMetrics.currentWidths.name).toBeGreaterThan(500);

  await page.setViewportSize({ width: 820, height: 820 });
  await expect.poll(async () => {
    const metrics = await browseColumnMetrics(page);
    return {
      preferredName: metrics.preferredWidths.name,
      currentName: metrics.currentWidths.name,
      shellClientWidth: metrics.shellClientWidth,
      shellScrollWidth: metrics.shellScrollWidth,
    };
  }).toEqual({
    preferredName: widenedMetrics.preferredWidths.name,
    currentName: expect.any(Number),
    shellClientWidth: expect.any(Number),
    shellScrollWidth: expect.any(Number),
  });

  await expect.poll(async () => {
    const metrics = await browseColumnMetrics(page);
    return metrics.currentWidths.name < widenedMetrics.currentWidths.name
      && metrics.shellScrollWidth <= metrics.shellClientWidth + 1;
  }).toBe(true);
  const settledSmallMetrics = await browseColumnMetrics(page);
  expect(settledSmallMetrics.currentWidths.name).toBeLessThan(widenedMetrics.currentWidths.name);
  expect(settledSmallMetrics.preferredWidths).toEqual(widenedMetrics.preferredWidths);
  expect(settledSmallMetrics.storage).toEqual({ preferred: widenedMetrics.preferredWidths });
  expect(settledSmallMetrics.shellScrollWidth).toBeLessThanOrEqual(settledSmallMetrics.shellClientWidth + 1);

  await page.reload();
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  const reloadedSmallMetrics = await browseColumnMetrics(page);
  expect(reloadedSmallMetrics.preferredWidths).toEqual(widenedMetrics.preferredWidths);
  expect(reloadedSmallMetrics.currentWidths.name).toBeLessThan(widenedMetrics.currentWidths.name);
  expect(reloadedSmallMetrics.shellScrollWidth).toBeLessThanOrEqual(reloadedSmallMetrics.shellClientWidth + 1);

  await page.setViewportSize({ width: 1400, height: 820 });
  await expect.poll(async () => {
    const metrics = await browseColumnMetrics(page);
    return metrics.currentWidths.name;
  }).toBeGreaterThan(reloadedSmallMetrics.currentWidths.name + 20);

  await page.locator("#browse-column-reset").click();
  const resetMetrics = await browseColumnMetrics(page);
  expect(resetMetrics.preferredWidths).toEqual({});
  expect(resetMetrics.storage).toEqual({ preferred: {} });
  expect(resetMetrics.currentWidths.name).toBeLessThan(widenedMetrics.currentWidths.name);
});

test("client-render column dragging cascades through successive columns until that direction is exhausted", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 820 });
  await page.goto("/");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");

  const seededColumns = {
    name: 260,
    type: 120,
    status: 140,
    size: 120,
    date: 220,
    view: 80,
    sync: 160,
  };
  await page.evaluate((preferred) => {
    window.localStorage.setItem(
      "dropbox-browser.browse-column-widths-v1",
      JSON.stringify({ preferred }),
    );
  }, seededColumns);
  await page.reload();
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");

  const beforeDrag = await browseColumnMetrics(page);
  await dragBrowseColumnResizer(page, "name", 220);
  const afterCascade = await browseColumnMetrics(page);

  expect(afterCascade.currentWidths.name).toBeGreaterThan(beforeDrag.currentWidths.name);
  expect(afterCascade.currentWidths.type).toBeLessThan(beforeDrag.currentWidths.type);
  expect(afterCascade.currentWidths.status).toBeLessThan(beforeDrag.currentWidths.status);
  expect(afterCascade.currentWidths.size).toBeLessThan(beforeDrag.currentWidths.size);
  expect(afterCascade.currentWidths.type).toBe(72);
  expect(afterCascade.currentWidths.status).toBe(96);
  expect(afterCascade.currentWidths.size).toBeGreaterThanOrEqual(88);

  await dragBrowseColumnResizer(page, "name", 2000);
  const fullyExhausted = await browseColumnMetrics(page);

  expect(fullyExhausted.currentWidths.type).toBe(72);
  expect(fullyExhausted.currentWidths.status).toBe(96);
  expect(fullyExhausted.currentWidths.size).toBe(88);
  expect(fullyExhausted.currentWidths.date).toBe(144);
  expect(fullyExhausted.currentWidths.view).toBe(60);
  expect(fullyExhausted.currentWidths.sync).toBe(100);

  await dragBrowseColumnResizer(page, "name", 400);
  const beyondExhausted = await browseColumnMetrics(page);
  expect(beyondExhausted.currentWidths).toEqual(fullyExhausted.currentWidths);
  expect(beyondExhausted.preferredWidths).toEqual(fullyExhausted.preferredWidths);
});
