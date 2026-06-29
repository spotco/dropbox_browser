const { test, expect } = require("@playwright/test");

process.env.PLAYWRIGHT_PORT = "8021";
const virtualBaseURL = "http://127.0.0.1:8021";
test.use({ baseURL: virtualBaseURL, viewport: { width: 1280, height: 420 } });

const { startServer, stopServer } = require("./support/server");

async function scrollBrowseToBottom(page) {
  await page.evaluate(() => {
    const main = document.querySelector("main");
    if (main && main.scrollHeight > main.clientHeight) {
      main.scrollTop = main.scrollHeight;
      return;
    }
    window.scrollTo(0, document.body.scrollHeight);
  });
}

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

  await scrollBrowseToBottom(page);

  await expect.poll(async () => await page.locator("body").getAttribute("data-browse-visible-range")).not.toBe(initialRange);
  await expect(page.locator('tr[data-browse-row-id] .entry-name', { hasText: "2024-03-01 0040.jpg" })).toBeVisible();
});

test("client-render shows a scrollbar drag preview for the active filtered order", async ({ page }) => {
  await page.goto("/?path=Camera%20Uploads");

  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await page.getByRole("button", { name: "Show Filters" }).click();
  await page.locator("#browse-filter-query").fill("003");

  await expect(page.locator("body")).toHaveAttribute("data-browse-filter-active", "1");
  await expect(page.locator("body")).toHaveAttribute("data-browse-filtered-row-count", "11");
  await expect(page.locator("body")).toHaveAttribute("data-browse-virtualized", "1");

  await page.locator("body").dispatchEvent("pointerdown", {
    bubbles: true,
    button: 0,
    clientX: 1278,
    clientY: 180,
    pointerType: "mouse",
  });
  await scrollBrowseToBottom(page);

  await expect(page.locator("body")).toHaveAttribute("data-browse-scroll-preview", "visible");
  await expect.poll(async () => await page.locator("#browse-scroll-preview-index").textContent()).toBe("11 / 11");
  await expect(page.locator("#browse-scroll-preview-name")).toHaveText("2024-03-01 0039.jpg");

  await page.locator("body").dispatchEvent("pointerup", {
    bubbles: true,
    button: 0,
    clientX: 1278,
    clientY: 180,
    pointerType: "mouse",
  });
  await expect(page.locator("body")).toHaveAttribute("data-browse-scroll-preview", "hidden");
});
