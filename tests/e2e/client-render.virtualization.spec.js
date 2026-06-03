const { test, expect } = require("@playwright/test");

process.env.PLAYWRIGHT_PORT = "8013";
const virtualBaseURL = "http://127.0.0.1:8013";
test.use({ baseURL: virtualBaseURL, viewport: { width: 1280, height: 420 } });

const { startServer, stopServer } = require("./support/server");

let server = null;

test.beforeAll(async () => {
  server = await startServer({ clientRender: true, fixtureName: "camera-uploads-large.json" });
});

test.afterAll(async () => {
  await stopServer(server);
  server = null;
});

test("client-render virtualizes large browse listings and updates the visible window on scroll", async ({ page }) => {
  await page.goto("/?path=Camera%20Uploads");

  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await expect(page.locator("body")).toHaveAttribute("data-browse-virtualized", "1");
  await expect(page.locator("body")).toHaveAttribute("data-browse-row-count", "40");

  const initialRange = await page.locator("body").getAttribute("data-browse-visible-range");
  expect(initialRange).toMatch(/^\d+:\d+$/);

  const initialRenderCount = Number(await page.locator("body").getAttribute("data-browse-render-count"));
  expect(initialRenderCount).toBeLessThan(40);
  await expect(page.getByText("2024-03-01 0001.jpg")).toBeVisible();

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

  await expect.poll(async () => await page.locator("body").getAttribute("data-browse-visible-range")).not.toBe(initialRange);
  await expect(page.getByText("2024-03-01 0040.jpg")).toBeVisible();
});
