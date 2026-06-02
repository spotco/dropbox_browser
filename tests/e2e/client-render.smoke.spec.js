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

test("client-render folder navigation uses history without a full page reload", async ({ page }) => {
  let listingRequestCount = 0;
  page.on("request", (request) => {
    if (request.url().includes("/browse/endpoints/listing")) listingRequestCount += 1;
  });

  await page.goto("/");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await expect.poll(() => listingRequestCount).toBe(1);

  await page.locator('#browse-rows a[href="/?path=folder"]').click();
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
