const { test, expect } = require("@playwright/test");

const workerPortOffset = Number(process.env.DROPBOX_BROWSER_E2E_LANE_INDEX || "0") * 100;
process.env.PLAYWRIGHT_PORT = String(8036 + workerPortOffset);
const baseURL = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT}`;

const { startServer, stopServer } = require("./support/server");

// Phone emulation (Chromium). Real iOS Safari/Brave gestures (pinch at
// minimum zoom, pull-to-refresh) cannot be automated here; these tests pin
// the page-side preconditions that keep a pinch from turning into a
// pull-to-refresh reload: zoom stays allowed, the document never scrolls
// and the root does not chain vertical overscroll.
test.use({
  baseURL,
  viewport: { width: 390, height: 664 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 3,
});

let server = null;

test.beforeAll(async () => {
  server = await startServer({ clientRender: true, fixtureName: "browse-scroll-restore.json" });
});

test.afterAll(async () => {
  await stopServer(server);
  server = null;
});

async function openRoot(page) {
  await page.goto(`/?path=${encodeURIComponent("Scroll Root")}`);
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
}

test("mobile viewport keeps pinch zoom enabled", async ({ page }) => {
  await openRoot(page);
  const content = await page.locator('meta[name="viewport"]').getAttribute("content");
  expect(content).toContain("width=device-width");
  expect(content).not.toMatch(/user-scalable\s*=\s*(no|0)/i);
  expect(content).not.toMatch(/maximum-scale/i);
});

test("mobile root never chains vertical overscroll and the document itself does not scroll", async ({ page }) => {
  await openRoot(page);
  const styles = await page.evaluate(() => {
    const pick = (element) => {
      const style = getComputedStyle(element);
      return { y: style.overscrollBehaviorY, x: style.overscrollBehaviorX, overflowY: style.overflowY };
    };
    const root = document.scrollingElement || document.documentElement;
    return {
      html: pick(document.documentElement),
      body: pick(document.body),
      main: pick(document.querySelector("main")),
      bodyHeight: document.body.getBoundingClientRect().height,
      innerHeight: window.innerHeight,
      rootScrollable: root.scrollHeight - root.clientHeight,
      mainScrollable: document.querySelector("main").scrollHeight - document.querySelector("main").clientHeight,
    };
  });
  expect(styles.html.y).toBe("none");
  expect(styles.body.y).toBe("none");
  // Horizontal history swipes keep working.
  expect(styles.html.x).toBe("auto");
  expect(styles.main.y).toBe("contain");
  expect(styles.main.overflowY).toBe("auto");
  expect(styles.body.overflowY).toBe("hidden");
  // The body fits the (dynamic) viewport, so the document cannot be pulled.
  expect(styles.bodyHeight).toBeLessThanOrEqual(styles.innerHeight + 0.5);
  expect(styles.rootScrollable).toBeLessThanOrEqual(0);
  expect(styles.mainScrollable).toBeGreaterThan(0);
});

test("mobile media scrollers contain their overscroll too", async ({ page }) => {
  await openRoot(page);
  await page.locator("#bottom-pane-mode").selectOption("music-player");
  await expect(page.locator("#music-player-pane")).toBeVisible();
  const values = await page.evaluate(() => ["#music-library-tree", "#music-playlist-list", "#music-playback-pane"]
    .map((selector) => [selector, getComputedStyle(document.querySelector(selector)).overscrollBehaviorY]));
  for (const [selector, value] of values) {
    expect(value, selector).toBe("contain");
  }
});

test("mobile pinch at minimum zoom followed by a downward drag does not reload the page", async ({ page }) => {
  await openRoot(page);
  await page.evaluate(() => { window.__pinchMarker = "kept"; });
  let navigations = 0;
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations += 1; });
  let loads = 0;
  page.on("load", () => { loads += 1; });

  const cdp = await page.context().newCDPSession(page);
  // Pinch out (zoom out) at the top of the page while already at minimum scale.
  await cdp.send("Input.synthesizePinchGesture", { x: 195, y: 60, scaleFactor: 0.5, relativeSpeed: 800 });
  // Two-finger drag downward from the top edge, as when a pinch drifts down.
  const touchPoints = (y) => [{ x: 150, y, id: 1 }, { x: 240, y, id: 2 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: touchPoints(20) });
  for (let y = 40; y <= 400; y += 40) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: touchPoints(y) });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(800);

  expect(navigations).toBe(0);
  expect(loads).toBe(0);
  expect(await page.evaluate(() => window.__pinchMarker)).toBe("kept");
  expect(await page.evaluate(() => (document.scrollingElement || document.documentElement).scrollTop)).toBe(0);
});