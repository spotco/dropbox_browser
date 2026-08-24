const { test, expect } = require("@playwright/test");

const workerPortOffset = Number(process.env.DROPBOX_BROWSER_E2E_LANE_INDEX || "0") * 100;
process.env.PLAYWRIGHT_PORT = String(8023 + workerPortOffset);
const baseURL = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT}`;
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

test("bottom panel height and selected pane survive reload", async ({ page }) => {
  await page.goto("/?path=Camera%20Uploads");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");

  await page.evaluate(() => {
    Settings.set("log-height", 280);
    Settings.set("bottom-pane-mode", "file-search");
  });
  await page.reload();
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await expect(page.locator("#bottom-pane-mode")).toHaveValue("file-search");
  await expect
    .poll(async () => page.locator("#log-panel").evaluate((node) => Math.round(node.getBoundingClientRect().height)))
    .toBe(280);
});

test("bottom panel full-window state survives reload without restoring video full-window", async ({ page }) => {
  await page.goto("/?path=Camera%20Uploads");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await page.evaluate(() => {
    Settings.set("log-height", 280);
    Settings.set("bottom-pane-mode", "video-player");
    localStorage.removeItem("dropbox-browser.bottom-panel-full-window");
  });
  await page.reload();
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await page.locator("#bottom-pane-full-window-toggle").click();
  await expect(page.locator("body")).toHaveClass(/bottom-panel-full-window-mode/);
  await expect.poll(async () => page.evaluate(() => localStorage.getItem("dropbox-browser.bottom-panel-full-window"))).toBe("true");
  await expect(page.locator("#video-player-pane")).not.toHaveClass(/video-full-window/);

  await page.reload();
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await expect(page.locator("#bottom-pane-mode")).toHaveValue("video-player");
  await expect(page.locator("body")).toHaveClass(/bottom-panel-full-window-mode/);
  await expect(page.locator("#video-player-pane")).not.toHaveClass(/video-full-window/);
  await expect.poll(async () => page.evaluate(() => localStorage.getItem("dropbox-browser.bottom-panel-full-window"))).toBe("true");
  await expect
    .poll(async () => page.locator("#log-panel").evaluate((node) => Math.round(node.getBoundingClientRect().height)))
    .toBe(420);
});

test("double-clicking an empty video playback surface does not enter full-window", async ({ page }) => {
  await page.goto("/?path=Camera%20Uploads");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await page.evaluate(() => {
    Settings.set("log-height", 280);
    Settings.set("bottom-pane-mode", "video-player");
    localStorage.removeItem("dropbox-browser.bottom-panel-full-window");
  });
  await page.reload();
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  const surface = page.locator("#video-playback-surface");
  await expect(surface).toBeVisible();
  await surface.dblclick({position: {x: 40, y: 40}});
  await expect(page.locator("body")).not.toHaveClass(/bottom-panel-full-window-mode/);
  await expect(page.locator("#video-player-pane")).not.toHaveClass(/video-full-window/);
  await expect.poll(async () => page.evaluate(() => localStorage.getItem("dropbox-browser.bottom-panel-full-window"))).toBe(null);
});

test("an oversized saved bottom panel restores as full-window", async ({ page }) => {
  await page.goto("/?path=Camera%20Uploads");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await page.evaluate(() => {
    Settings.set("log-height", 380);
    Settings.set("bottom-pane-mode", "server-log");
    localStorage.removeItem("dropbox-browser.bottom-panel-full-window");
  });

  await page.reload();
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await expect(page.locator("body")).toHaveClass(/bottom-panel-full-window-mode/);
  await expect.poll(async () => page.evaluate(() => localStorage.getItem("dropbox-browser.bottom-panel-full-window"))).toBe(null);
  await expect.poll(async () => page.evaluate(() => Settings.get("log-height", null))).toBe(380);
  await expect
    .poll(async () => page.locator("#log-panel").evaluate((node) => Math.round(node.getBoundingClientRect().height)))
    .toBe(420);
});
