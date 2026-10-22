const { test, expect } = require("@playwright/test");

const workerPortOffset = Number(process.env.DROPBOX_BROWSER_E2E_LANE_INDEX || "0") * 100;
process.env.PLAYWRIGHT_PORT = String(8031 + workerPortOffset);
const scrollRestoreBaseURL = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT}`;
test.use({ baseURL: scrollRestoreBaseURL, viewport: { width: 1280, height: 720 } });

const { startServer, stopServer } = require("./support/server");

const ROOT_PATH = "Scroll Root";
const BIG_CHILD_PATH = "Scroll Root/Big Child";
// main.scrollTop is integer-rounded and the virtual row height is re-measured
// after each snapshot, so allow a few pixels of drift.
const SCROLL_TOLERANCE_PX = 4;

let server = null;

test.beforeAll(async () => {
  server = await startServer({ clientRender: true, fixtureName: "browse-scroll-restore.json" });
});

test.afterAll(async () => {
  await stopServer(server);
  server = null;
});

// The browse page scrolls the <main> element (body.has-log-panel sets
// body { height: 100vh; overflow: hidden } and main { overflow-y: auto }),
// not the window. Fall back to the window if that layout ever changes.
async function readBrowseScrollTop(page) {
  return page.evaluate(() => {
    const main = document.querySelector("main");
    if (main && main.scrollHeight > main.clientHeight) return main.scrollTop;
    return window.scrollY;
  });
}

async function setBrowseScrollTop(page, value) {
  return page.evaluate((nextValue) => {
    const main = document.querySelector("main");
    if (main && main.scrollHeight > main.clientHeight) {
      main.scrollTop = nextValue;
      return main.scrollTop;
    }
    window.scrollTo(0, nextValue);
    return window.scrollY;
  }, value);
}

async function waitForFolderReady(page, folderPath, rowCount) {
  const body = page.locator("body");
  await expect(body).toHaveAttribute("data-current-folder-path", folderPath);
  await expect(body).toHaveAttribute("data-browse-client", "ready");
  if (rowCount !== undefined) {
    await expect(body).toHaveAttribute("data-browse-row-count", String(rowCount));
  }
}

async function expectScrollTopNear(page, expected) {
  await expect
    .poll(async () => Math.abs((await readBrowseScrollTop(page)) - expected), {
      message: `browse scrollTop drift from the saved ${expected}px (drift == ${expected} means it reset to the top)`,
      timeout: 3000,
    })
    .toBeLessThanOrEqual(SCROLL_TOLERANCE_PX);
}

// Pick a folder row near the vertical middle of the scroll viewport so the
// click target is unambiguous and fully visible.
async function pickVisibleFolderRowPath(page) {
  return page.evaluate(() => {
    const main = document.querySelector("main");
    const viewport = main.getBoundingClientRect();
    const middle = viewport.top + viewport.height / 2;
    let best = null;
    document.querySelectorAll('tr[data-row-kind="folder"][data-row-path]').forEach((row) => {
      if (row.hidden) return;
      const rect = row.getBoundingClientRect();
      if (rect.top < viewport.top || rect.bottom > viewport.bottom) return;
      const distance = Math.abs((rect.top + rect.bottom) / 2 - middle);
      if (!best || distance < best.distance) best = { path: row.getAttribute("data-row-path"), distance };
    });
    return best ? best.path : null;
  });
}

test("client-render restores scroll on Back, Forward and re-entering a visited folder; a never-visited folder starts at the top", async ({ page }) => {
  await page.goto(`/?path=${encodeURIComponent(ROOT_PATH)}`);
  await waitForFolderReady(page, ROOT_PATH, 41);
  await expect(page.locator("body")).toHaveAttribute("data-browse-virtualized", "1");

  const maxScroll = await page.evaluate(() => {
    const main = document.querySelector("main");
    return main.scrollHeight - main.clientHeight;
  });
  expect(maxScroll).toBeGreaterThan(1000);

  const savedScrollTop = await setBrowseScrollTop(page, 900);
  expect(savedScrollTop).toBeGreaterThan(800);
  // Let the virtual recycler re-render the window for the new scroll offset.
  await expect
    .poll(async () => await page.locator("body").getAttribute("data-browse-visible-range"))
    .not.toMatch(/^0:/);

  const targetPath = await pickVisibleFolderRowPath(page);
  expect(targetPath).toMatch(/^Scroll Root\/Folder \d\d$/);
  const targetRowSelector = `tr[data-row-path="${targetPath}"]`;
  const targetName = targetPath.split("/").pop();

  await page.locator(`${targetRowSelector} a.name`).click();
  await waitForFolderReady(page, targetPath, 1);
  await expect(page).toHaveURL(new RegExp(`path=${encodeURIComponent(targetPath).replace(/%20/g, "(%20|\\+)")}`));
  // Forward navigation into a new folder starts at the top.
  expect(await readBrowseScrollTop(page)).toBe(0);

  await page.goBack();
  await waitForFolderReady(page, ROOT_PATH, 41);

  await expectScrollTopNear(page, savedScrollTop);
  await expect(page.locator(`${targetRowSelector} .entry-name`, { hasText: targetName })).toBeInViewport();

  // Forward and re-enter phases (merged from their standalone tests,
  // e2e-dedup-faster; same restore invariant, different triggers).
  // The Big Child has enough rows of its own to scroll.
  await setBrowseScrollTop(page, 0);
  await page.locator(`tr[data-row-path="${BIG_CHILD_PATH}"] a.name`).click();
  await waitForFolderReady(page, BIG_CHILD_PATH, 40);
  expect(await readBrowseScrollTop(page)).toBe(0);
  const childScrollTop = await setBrowseScrollTop(page, 700);
  expect(childScrollTop).toBeGreaterThan(600);

  await page.goBack();
  await waitForFolderReady(page, ROOT_PATH, 41);
  await expectScrollTopNear(page, 0);

  await page.goForward();
  await waitForFolderReady(page, BIG_CHILD_PATH, 40);
  await expectScrollTopNear(page, childScrollTop);

  // Re-entering the visited child by link restores its scroll too.
  await clickBreadcrumb(page, ROOT_PATH);
  await waitForFolderReady(page, ROOT_PATH, 41);
  await page.locator(`tr[data-row-path="${BIG_CHILD_PATH}"] a.name`).click();
  await waitForFolderReady(page, BIG_CHILD_PATH, 40);
  await expectScrollTopNear(page, childScrollTop);

  // A never-visited folder starts at the top (the root offset, saved
  // just before the click, must not leak into it).
  await clickBreadcrumb(page, ROOT_PATH);
  await waitForFolderReady(page, ROOT_PATH, 41);
  const rootScrollTop = await setBrowseScrollTop(page, 900);
  expect(rootScrollTop).toBeGreaterThan(800);
  await expect
    .poll(async () => await page.locator("body").getAttribute("data-browse-visible-range"))
    .not.toMatch(/^0:/);
  const freshPath = await page.evaluate((visited) => {
    const main = document.querySelector("main");
    const viewport = main.getBoundingClientRect();
    const middle = viewport.top + viewport.height / 2;
    let best = null;
    document.querySelectorAll('tr[data-row-kind="folder"][data-row-path]').forEach((row) => {
      if (row.hidden) return;
      const path = row.getAttribute("data-row-path");
      if (visited.includes(path)) return;
      const rect = row.getBoundingClientRect();
      if (rect.top < viewport.top || rect.bottom > viewport.bottom) return;
      const distance = Math.abs((rect.top + rect.bottom) / 2 - middle);
      if (!best || distance < best.distance) best = { path, distance };
    });
    return best ? best.path : null;
  }, [targetPath, BIG_CHILD_PATH]);
  expect(freshPath).toMatch(/^Scroll Root\/Folder \d\d$/);
  // The virtual list keeps a zero-size spare copy of one row in the
  // same tbody (verified by DOM dump on spzeni1), so scope the click
  // to the visible copy instead of the strict first match.
  const freshLink = page.locator(`tr[data-row-path="${freshPath}"] a.name:visible`);
  await freshLink.click();
  await waitForFolderReady(page, freshPath, 1);
  expect(await readBrowseScrollTop(page)).toBe(0);
});

test("client-render keeps the folder scroll position across a page reload and a breadcrumb return", async ({ page }) => {
  await page.goto(`/?path=${encodeURIComponent(ROOT_PATH)}`);
  await waitForFolderReady(page, ROOT_PATH, 41);

  const savedScrollTop = await setBrowseScrollTop(page, 800);
  expect(savedScrollTop).toBeGreaterThan(700);

  await page.reload();
  await waitForFolderReady(page, ROOT_PATH, 41);
  await expectScrollTopNear(page, savedScrollTop);

  // Breadcrumb phase (merged from its standalone test,
  // e2e-dedup-faster): a breadcrumb click is a pushed history entry,
  // not Back, and restores the parent folder's saved scroll.
  const targetPath = await pickVisibleFolderRowPath(page);
  expect(targetPath).toMatch(/^Scroll Root\/Folder \d\d$/);
  await page.locator(`tr[data-row-path="${targetPath}"] a.name`).click();
  await waitForFolderReady(page, targetPath, 1);
  expect(await readBrowseScrollTop(page)).toBe(0);
  const historyLength = await page.evaluate(() => window.history.length);

  await clickBreadcrumb(page, ROOT_PATH);
  await waitForFolderReady(page, ROOT_PATH, 41);
  expect(await page.evaluate(() => window.history.length)).toBe(historyLength + 1);
  await expectScrollTopNear(page, savedScrollTop);
  await expect(page.locator(`tr[data-row-path="${targetPath}"] .entry-name`)).toBeInViewport();
});
test("client-render an in-place refresh during a pending folder navigation keeps the history entry and Back restores the scroll", async ({ page }) => {
  // The refresh-cache link and the listing-warning Refresh button refresh the
  // current folder in place when their job finishes. If that lands while a
  // click into a child folder is still loading, it must not supersede the
  // navigation: otherwise the child entry is never pushed, the URL keeps the
  // parent path and Back skips the parent (its saved scroll offset is lost).
  await page.goto(`/?path=${encodeURIComponent(ROOT_PATH)}`);
  await waitForFolderReady(page, ROOT_PATH, 41);
  const savedScrollTop = await setBrowseScrollTop(page, 900);
  expect(savedScrollTop).toBeGreaterThan(800);
  await expect
    .poll(async () => await page.locator("body").getAttribute("data-browse-visible-range"))
    .not.toMatch(/^0:/);
  const targetPath = await pickVisibleFolderRowPath(page);
  expect(targetPath).toMatch(/^Scroll Root\/Folder \d\d$/);

  let releaseChild = null;
  const childHeld = new Promise((resolve) => { releaseChild = resolve; });
  let childRequested = false;
  await page.route("**/browse/endpoints/listing**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("path") === targetPath && !childRequested) {
      childRequested = true;
      await childHeld;
    }
    await route.continue();
  });

  await page.locator(`tr[data-row-path="${targetPath}"] a.name`).click();
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "loading");
  await expect.poll(() => childRequested).toBe(true);
  const refreshResult = page.evaluate(() => window.DropboxBrowseClient.refreshCurrentFolderInPlace({ refresh: false }));
  releaseChild();
  await refreshResult;
  await waitForFolderReady(page, targetPath, 1);
  await expect(page).toHaveURL(new RegExp(`path=${encodeURIComponent(targetPath).replace(/%20/g, "(%20|\\+)")}`));
  await page.unroute("**/browse/endpoints/listing**");

  await page.goBack();
  await waitForFolderReady(page, ROOT_PATH, 41);
  await expectScrollTopNear(page, savedScrollTop);
});
test("client-render restores the folder scroll position on Back and reload when the listing is slow", async ({ page }) => {
  // Large real folders (e.g. music) can take seconds to list; the restore
  // must wait for the destination rows instead of applying to the loading row.
  await page.goto(`/?path=${encodeURIComponent(ROOT_PATH)}`);
  await waitForFolderReady(page, ROOT_PATH, 41);
  const savedScrollTop = await setBrowseScrollTop(page, 900);
  expect(savedScrollTop).toBeGreaterThan(800);
  await expect
    .poll(async () => await page.locator("body").getAttribute("data-browse-visible-range"))
    .not.toMatch(/^0:/);
  const targetPath = await pickVisibleFolderRowPath(page);
  expect(targetPath).toMatch(/^Scroll Root\/Folder \d\d$/);

  await page.route("**/browse/endpoints/listing**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.continue();
  });
  await page.locator(`tr[data-row-path="${targetPath}"] a.name`).click();
  await waitForFolderReady(page, targetPath, 1);

  await page.goBack();
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "loading");
  await waitForFolderReady(page, ROOT_PATH, 41);
  await expectScrollTopNear(page, savedScrollTop);

  await page.reload();
  await waitForFolderReady(page, ROOT_PATH, 41);
  await expectScrollTopNear(page, savedScrollTop);
  await page.unroute("**/browse/endpoints/listing**");
});
// Forward navigation (breadcrumb, folder row, any folder link) into a folder
// visited before in this tab restores that folder's last scroll offset; a
// folder never visited starts at the top, and a reveal target still wins.
async function clickBreadcrumb(page, label) {
  await page.locator("header .meta a", { hasText: new RegExp(`^${label}$`) }).first().click();
}

async function scrollRootAndPickFolder(page) {
  await page.goto(`/?path=${encodeURIComponent(ROOT_PATH)}`);
  await waitForFolderReady(page, ROOT_PATH, 41);
  const savedScrollTop = await setBrowseScrollTop(page, 900);
  expect(savedScrollTop).toBeGreaterThan(800);
  await expect
    .poll(async () => await page.locator("body").getAttribute("data-browse-visible-range"))
    .not.toMatch(/^0:/);
  const targetPath = await pickVisibleFolderRowPath(page);
  expect(targetPath).toMatch(/^Scroll Root\/Folder \d\d$/);
  return { savedScrollTop, targetPath };
}

test("client-render a reveal target wins over the folder's saved scroll position", async ({ page }) => {
  const { savedScrollTop, targetPath } = await scrollRootAndPickFolder(page);
  await page.locator(`tr[data-row-path="${targetPath}"] a.name`).click();
  await waitForFolderReady(page, targetPath, 1);

  const revealPath = "Scroll Root/Folder 01";
  await page.evaluate((reveal) => {
    const link = document.createElement("a");
    link.id = "scroll-restore-reveal-link";
    link.href = `/?path=${encodeURIComponent("Scroll Root")}&reveal=${encodeURIComponent(reveal)}`;
    link.textContent = "reveal";
    document.querySelector("main").prepend(link);
  }, revealPath);
  await page.locator("#scroll-restore-reveal-link").click();
  await waitForFolderReady(page, ROOT_PATH, 41);
  await expect(page.locator(`tr[data-row-path="${revealPath}"] .entry-name`)).toBeInViewport();
  expect(Math.abs((await readBrowseScrollTop(page)) - savedScrollTop)).toBeGreaterThan(200);
});