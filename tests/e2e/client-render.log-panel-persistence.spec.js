const { test, expect } = require("@playwright/test");

const workerPortOffset = Number(process.env.DROPBOX_BROWSER_E2E_LANE_INDEX || "0") * 100;
process.env.PLAYWRIGHT_PORT = String(8033 + workerPortOffset);
const baseURL = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT}`;
test.use({ baseURL, viewport: { width: 1280, height: 800 } });

const { startServer, stopServer } = require("./support/server");

// Bottom (log) panel size/minimize persistence across reloads, driven only by
// real UI interactions: the minimize button, the restore (un-minimize) button
// and mouse drags on #log-resizer.
const MIN_HEIGHT = 42;
const TOLERANCE = 2;

let server = null;

test.beforeAll(async () => {
  server = await startServer({ clientRender: true });
});

test.afterAll(async () => {
  await stopServer(server);
  server = null;
});

async function waitForPageReady(page) {
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await expect(page.locator("body")).toHaveAttribute("data-bottom-panel-ready", "1", { timeout: 15000 });
}

async function panelHeight(page) {
  return page.locator("#log-panel").evaluate((node) => Math.round(node.getBoundingClientRect().height));
}

// Late startup code (music/video hosts) must not change the restored height,
// so check the value is reached and still holds a moment later.
async function expectStablePanelHeight(page, expected, message) {
  await expect
    .poll(() => panelHeight(page), { message })
    .toBeGreaterThanOrEqual(expected - TOLERANCE);
  await expect.poll(() => panelHeight(page), { message }).toBeLessThanOrEqual(expected + TOLERANCE);
  await page.waitForTimeout(600);
  const settled = await panelHeight(page);
  expect(Math.abs(settled - expected), `${message} (settled at ${settled}px)`).toBeLessThanOrEqual(TOLERANCE);
}

async function reloadAndWait(page) {
  await page.reload();
  await waitForPageReady(page);
}

async function selectPaneMode(page, mode) {
  await page.locator("#bottom-pane-mode").selectOption(mode);
  await expect(page.locator(`.bottom-pane-view[data-pane-mode="${mode}"]`)).toBeVisible();
}

async function dragPanelToHeight(page, targetHeight) {
  const resizer = page.locator("#log-resizer");
  const box = await resizer.boundingBox();
  expect(box).not.toBeNull();
  const startHeight = await panelHeight(page);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - (targetHeight - startHeight), { steps: 10 });
  await page.mouse.up();
  return panelHeight(page);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await waitForPageReady(page);
  await page.evaluate(() => {
    Object.keys(localStorage)
      .filter((key) => key.startsWith("dropbox-browser."))
      .forEach((key) => localStorage.removeItem(key));
  });
  await reloadAndWait(page);
});

for (const mode of ["server-log", "music-player", "video-player"]) {
  test.describe(`bottom panel in ${mode} mode`, () => {
    test.beforeEach(async ({ page }) => {
      await selectPaneMode(page, mode);
      await reloadAndWait(page);
      await expect(page.locator("#bottom-pane-mode")).toHaveValue(mode);
    });

    test("minimize survives a reload", async ({ page }) => {
      const minimize = page.locator("#bottom-pane-minimize");
      await expect(minimize).toBeEnabled();
      await minimize.click();
      await expectStablePanelHeight(page, MIN_HEIGHT, "panel should minimize");

      await reloadAndWait(page);
      await expectStablePanelHeight(page, MIN_HEIGHT, "panel should still be minimized after reload");
      await expect(page.locator("#log-panel")).toHaveAttribute("data-minimized", "true");
    });

    test("a dragged height survives a reload", async ({ page }) => {
      const dragged = await dragPanelToHeight(page, 460);
      expect(Math.abs(dragged - 460)).toBeLessThanOrEqual(TOLERANCE);
      await expectStablePanelHeight(page, dragged, "drag should resize the panel");

      await reloadAndWait(page);
      await expectStablePanelHeight(page, dragged, "dragged height should be restored after reload");
    });

    test("a small dragged height (below the music player minimum) survives a reload", async ({ page }) => {
      const dragged = await dragPanelToHeight(page, 200);
      expect(Math.abs(dragged - 200)).toBeLessThanOrEqual(TOLERANCE);
      await expectStablePanelHeight(page, dragged, "drag should resize the panel");

      await reloadAndWait(page);
      await expectStablePanelHeight(page, dragged, "small dragged height should be restored after reload");
    });

    test("restoring from minimized returns to the last expanded height, also across reloads", async ({ page }) => {
      const dragged = await dragPanelToHeight(page, 430);
      await expectStablePanelHeight(page, dragged, "drag should resize the panel");

      const minimize = page.locator("#bottom-pane-minimize");
      await minimize.click();
      await expectStablePanelHeight(page, MIN_HEIGHT, "panel should minimize");
      await reloadAndWait(page);
      await expectStablePanelHeight(page, MIN_HEIGHT, "panel should still be minimized after reload");

      // The same toolbar button restores the panel once it is minimized.
      await expect(minimize).toBeEnabled();
      await expect(minimize).toHaveAttribute("aria-pressed", "true");
      await minimize.click();
      await expectStablePanelHeight(page, dragged, "restore should return to the last expanded height");
      await expect(page.locator("#log-panel")).toHaveAttribute("data-minimized", "false");

      await reloadAndWait(page);
      await expectStablePanelHeight(page, dragged, "restored height should survive reload");
    });
  });
}

test("a restored height is clamped to a smaller viewport and never saved as the clamped value", async ({ page }) => {
  await selectPaneMode(page, "server-log");
  const dragged = await dragPanelToHeight(page, 600);
  await expectStablePanelHeight(page, dragged, "drag should resize the panel");

  await page.setViewportSize({ width: 1280, height: 560 });
  await reloadAndWait(page);
  // 600px no longer fits as a normal panel (viewport - 80px); it must not be
  // forced into an invalid size and the saved preference must be kept.
  const height = await panelHeight(page);
  expect(height).toBeLessThanOrEqual(560);
  await page.setViewportSize({ width: 1280, height: 800 });
  await reloadAndWait(page);
  await expectStablePanelHeight(page, dragged, "the saved height should come back in a tall viewport");
});
