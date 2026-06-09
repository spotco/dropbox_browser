const { test, expect } = require("@playwright/test");

process.env.PLAYWRIGHT_PORT = "8016";
const baseURL = "http://127.0.0.1:8016";
test.use({ baseURL, viewport: { width: 700, height: 420 } });

const { startServer, stopServer } = require("./support/server");

let server = null;

test.beforeAll(async () => {
  server = await startServer({ clientRender: true, fixtureName: "camera-uploads-large.json" });
});

test.afterAll(async () => {
  await stopServer(server);
  server = null;
});

test("client-render keeps horizontal browse scrollbar visible and synced when table overflows", async ({ page }) => {
  await page.goto("/?path=Camera%20Uploads");

  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  const bar = page.locator("[data-browse-horizontal-scrollbar]");
  const shell = page.locator(".browse-table-shell");
  await expect(bar).toBeVisible();

  const barBox = await bar.boundingBox();
  const logBox = await page.locator("#log-panel").boundingBox();
  expect(barBox).not.toBeNull();
  expect(logBox).not.toBeNull();
  expect(Math.round(barBox.y + barBox.height)).toBeLessThanOrEqual(Math.round(logBox.y) + 1);

  await bar.evaluate((node) => {
    node.scrollLeft = 320;
    node.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(async () => shell.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);

  await shell.evaluate((node) => {
    node.scrollLeft = 0;
    node.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(async () => bar.evaluate((node) => node.scrollLeft)).toBe(0);

  await page.evaluate(() => {
    const main = document.querySelector("main");
    if (main) main.scrollTop = main.scrollHeight;
  });
  await expect(bar).toBeVisible();
  await expect(shell).toHaveCSS("overflow-x", "hidden");
});
