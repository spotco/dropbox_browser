const { test, expect } = require("@playwright/test");

process.env.PLAYWRIGHT_PORT = "8025";
const clientRenderBaseURL = "http://127.0.0.1:8025";
test.use({ baseURL: clientRenderBaseURL });

const { startServer, stopServer } = require("./support/server");

let server = null;

test.beforeAll(async () => {
  server = await startServer({
    clientRender: true,
    fixtureName: "camera-uploads-large.json",
  });
});

test.afterAll(async () => {
  await stopServer(server);
  server = null;
});

async function openSearch(page) {
  await page.goto("/?path=Camera%20Uploads");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await page.locator("#bottom-pane-mode").selectOption("file-search");
  await expect(page.locator("#file-search-pane")).toBeVisible();
}

test("file search returns nested cached results in batches and virtualizes them", async ({ page }) => {
  await openSearch(page);
  await page.locator("#file-search-query").fill("2024-03");
  await page.locator("#file-search-submit").click();

  await expect
    .poll(async () => await page.locator("#file-search-result-count").textContent(), { timeout: 15000 })
    .toContain("40 results");
  await expect(page.locator("#file-search-results .file-search-virtual-spacer")).toHaveCount(1);
  await expect(page.locator("#file-search-results .file-search-result").first()).toBeVisible();
  await expect
    .poll(async () => await page.locator("#file-search-status").textContent(), { timeout: 15000 })
    .toBe("Search complete.");

  const resultIds = await page.locator("#file-search-results .file-search-result").evaluateAll((rows) => rows.map((row) => row.dataset.fileSearchResultId));
  expect(new Set(resultIds).size).toBe(resultIds.length);
});

test("file search result navigation preserves encoded containing folder and reveal path", async ({ page }) => {
  await openSearch(page);
  await page.locator("#file-search-query").fill("0001");
  await page.locator("#file-search-submit").click();
  const result = page.locator("#file-search-results .file-search-result-name").first();
  await expect(result).toBeVisible({ timeout: 15000 });
  const href = await result.getAttribute("href");
  expect(href).toMatch(/path=Camera%20Uploads/);
  expect(href).toMatch(/reveal=Camera%20Uploads%2F2024-03-01%200001\.jpg/);
  await result.click({force: true});

  await expect(page).toHaveURL(/path=Camera(?:%20|\+)Uploads/);
  await expect(page.locator("#browse-rows")).toContainText("2024-03-01 0001.jpg");
});

test("stopping an active file search stops polling and keeps the current batch", async ({ page }) => {
  await openSearch(page);
  await page.locator("#file-search-query").fill("2024-03");
  await page.locator("#file-search-submit").click();
  await expect(page.locator("#file-search-submit")).toHaveText("Stop Search");
  await expect(page.locator("#file-search-results .file-search-result").first()).toBeVisible({timeout: 15000});
  await page.locator("#file-search-submit").click();
  await expect(page.locator("#file-search-submit")).toHaveText("Search");
  await expect(page.locator("#file-search-results .file-search-result").first()).toBeVisible();
});
