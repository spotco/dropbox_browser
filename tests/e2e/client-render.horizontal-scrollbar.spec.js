const { test, expect } = require("@playwright/test");

process.env.PLAYWRIGHT_PORT = "8023";
const baseURL = "http://127.0.0.1:8023";
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

  const resizer = page.locator("#log-resizer");
  const resizerBox = await resizer.boundingBox();
  expect(resizerBox).not.toBeNull();
  await page.mouse.move(resizerBox.x + (resizerBox.width / 2), resizerBox.y + (resizerBox.height / 2));
  await page.mouse.down();
  await page.mouse.move(resizerBox.x + (resizerBox.width / 2), 120, { steps: 12 });
  await page.mouse.up();

  await expect.poll(async () => {
    const nextBarBox = await bar.boundingBox();
    const nextLogBox = await page.locator("#log-panel").boundingBox();
    if (!nextBarBox || !nextLogBox) return null;
    return Math.round(nextLogBox.y - (nextBarBox.y + nextBarBox.height));
  }).toBeGreaterThanOrEqual(-1);
  await expect.poll(async () => {
    const nextBarBox = await bar.boundingBox();
    const nextLogBox = await page.locator("#log-panel").boundingBox();
    if (!nextBarBox || !nextLogBox) return null;
    return Math.round(nextLogBox.y - (nextBarBox.y + nextBarBox.height));
  }).toBeLessThanOrEqual(1);
});

test("bottom panel drag does not snap to full page, while the topbar button still enters it", async ({ page }) => {
  await page.goto("/?path=Camera%20Uploads");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");

  const resizer = page.locator("#log-resizer");
  const resizerBox = await resizer.boundingBox();
  expect(resizerBox).not.toBeNull();
  await page.mouse.move(resizerBox.x + (resizerBox.width / 2), resizerBox.y + (resizerBox.height / 2));
  await page.mouse.down();
  await page.mouse.move(resizerBox.x + (resizerBox.width / 2), 0, { steps: 12 });
  await page.mouse.up();

  await expect(page.locator("body")).not.toHaveClass(/bottom-panel-full-window-mode/);
  await expect(page.locator("header")).toBeVisible();
  await expect(page.locator("main")).toBeVisible();
  await expect
    .poll(async () => page.locator("#log-panel").evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return rect.height > 0 && rect.height < window.innerHeight;
    }))
    .toBe(true);

  const fullWindow = page.locator("#bottom-pane-full-window-toggle");
  await expect(fullWindow).toBeEnabled();
  await fullWindow.click();
  await expect(page.locator("body")).toHaveClass(/bottom-panel-full-window-mode/);
  await expect(fullWindow).toBeDisabled();
  await expect(page.locator("header")).toBeHidden();
  await expect(page.locator("main")).toBeHidden();

  const minimize = page.locator("#bottom-pane-minimize");
  await expect(minimize).toBeVisible();
  await minimize.click();
  await expect(page.locator("body")).not.toHaveClass(/bottom-panel-full-window-mode/);
  await expect(page.locator("header")).toBeVisible();
  await expect(page.locator("main")).toBeVisible();
  await expect
    .poll(async () => page.locator("#log-panel").evaluate((node) => Math.round(node.getBoundingClientRect().height)))
    .toBe(42);

  // A minimized panel must re-enable minimize as soon as dragging raises it
  // above the minimum height.
  await expect(minimize).toBeDisabled();
  const minimizedResizerBox = await resizer.boundingBox();
  expect(minimizedResizerBox).not.toBeNull();
  await page.mouse.move(
    minimizedResizerBox.x + (minimizedResizerBox.width / 2),
    minimizedResizerBox.y + (minimizedResizerBox.height / 2)
  );
  await page.mouse.down();
  await page.mouse.move(
    minimizedResizerBox.x + (minimizedResizerBox.width / 2),
    Math.max(0, minimizedResizerBox.y - 80),
    {steps: 8}
  );
  await page.mouse.up();
  await expect(minimize).toBeEnabled();
  await expect
    .poll(async () => page.locator("#log-panel").evaluate((node) => Math.round(node.getBoundingClientRect().height)))
    .toBeGreaterThan(42);
  await minimize.click();
  await expect
    .poll(async () => page.locator("#log-panel").evaluate((node) => Math.round(node.getBoundingClientRect().height)))
    .toBe(42);
});
