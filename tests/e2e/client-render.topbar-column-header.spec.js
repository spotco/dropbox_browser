const { test, expect } = require("@playwright/test");

const workerPortOffset = Number(process.env.DROPBOX_BROWSER_E2E_LANE_INDEX || "0") * 100;
process.env.PLAYWRIGHT_PORT = String(8034 + workerPortOffset);
const baseURL = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT}`;
test.use({ baseURL, viewport: { width: 1280, height: 800 } });
test.describe.configure({ timeout: 30000 });

const { startServer, stopServer } = require("./support/server");

// The browse table's column header row lives inside the fixed top bar
// (header.browse-topbar) so it stays visible while <main> scrolls. The bar
// keeps its original 85px height (it used to hold the "SDB: ..." title line).
const TOPBAR_HEIGHT = 85;
const ALIGN_TOLERANCE = 2;
const COLUMN_KEYS = ["name", "type", "status", "size", "date", "view", "sync"];

let server = null;

test.beforeAll(async () => {
  server = await startServer({ fixtureName: "camera-uploads-large.json" });
});

test.afterAll(async () => {
  await stopServer(server);
  server = null;
});

async function openCameraUploads(page) {
  await page.goto("/?path=Camera+Uploads");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await expect(page.locator("#browse-rows tr[data-browse-row-id]").first()).toBeVisible();
}

async function scrollMainTo(page, fraction) {
  const scrollTop = await page.locator("main").evaluate((main, value) => {
    main.scrollTop = Math.round((main.scrollHeight - main.clientHeight) * value);
    return main.scrollTop;
  }, fraction);
  expect(scrollTop).toBeGreaterThan(200);
  // Let the virtual list render rows for the new scroll position.
  await page.waitForTimeout(250);
  return scrollTop;
}

async function headerMetrics(page) {
  return page.evaluate((keys) => {
    const header = document.querySelector("body > header");
    const headerRect = header.getBoundingClientRect();
    const rows = Array.from(document.querySelectorAll("#browse-rows tr[data-browse-row-id]"));
    const row = rows.find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.top >= headerRect.bottom && rect.bottom <= window.innerHeight;
    });
    const cells = row ? Array.from(row.children) : [];
    return {
      headerHeight: headerRect.height,
      headerTop: headerRect.top,
      headerBottom: headerRect.bottom,
      columns: keys.map((key, index) => {
        const th = document.querySelector(`header th[data-browse-column-key="${key}"]`);
        const rect = th ? th.getBoundingClientRect() : null;
        const hit = rect
          ? document.elementFromPoint(rect.left + Math.min(20, rect.width / 2), rect.top + rect.height / 2)
          : null;
        const cell = cells[index];
        return {
          key,
          present: !!th,
          top: rect ? rect.top : null,
          bottom: rect ? rect.bottom : null,
          left: rect ? rect.left : null,
          width: rect ? rect.width : null,
          hitInside: !!(th && hit && th.contains(hit)),
          cellLeft: cell ? cell.getBoundingClientRect().left : null,
          cellWidth: cell ? cell.getBoundingClientRect().width : null,
        };
      }),
    };
  }, COLUMN_KEYS);
}

function expectHeaderRowInsideTopbar(metrics) {
  expect(metrics.headerTop).toBe(0);
  for (const column of metrics.columns) {
    expect(column.present, `${column.key} header cell exists in the top bar`).toBe(true);
    expect(column.top, `${column.key} header top`).toBeGreaterThanOrEqual(metrics.headerTop);
    expect(column.bottom, `${column.key} header bottom`).toBeLessThanOrEqual(metrics.headerBottom + 0.5);
    expect(column.hitInside, `${column.key} header cell is not covered`).toBe(true);
  }
}

function expectHeaderAlignedWithCells(metrics) {
  for (const column of metrics.columns) {
    expect(column.cellLeft, `${column.key} body cell found`).not.toBeNull();
    expect(Math.abs(column.left - column.cellLeft), `${column.key} left edge`).toBeLessThanOrEqual(ALIGN_TOLERANCE);
    expect(Math.abs(column.width - column.cellWidth), `${column.key} width`).toBeLessThanOrEqual(ALIGN_TOLERANCE);
  }
}

test("top bar shows only the breadcrumb title and keeps its original height", async ({ page }) => {
  await openCameraUploads(page);
  const header = page.locator("body > header");
  await expect(header.locator("h1")).toHaveCount(0);
  await expect(header.locator(".site-title-link")).toHaveCount(0);
  await expect(header).not.toContainText("SDB:");
  await expect(header).not.toContainText("dropbox:");

  const breadcrumb = header.locator(".browse-topbar-breadcrumb .meta");
  await expect(breadcrumb).toBeVisible();
  await expect(breadcrumb).toContainText("Camera Uploads");
  await expect(breadcrumb.locator("a[href='/']")).toBeVisible();
  await expect(breadcrumb.locator("a[href='/?path=Camera+Uploads']")).toHaveText("Camera Uploads");
  // The breadcrumb stays on one row next to the compact sync toggles.
  await expect(header.locator("#enable-to-local")).toBeVisible();
  await expect(header.locator("#enable-write-dropbox")).toBeVisible();
  const layout = await page.evaluate(() => {
    const crumb = document.querySelector(".browse-topbar-breadcrumb").getBoundingClientRect();
    const toggles = document.querySelector(".sync-toggles").getBoundingClientRect();
    const columns = document.querySelector(".browse-topbar-columns").getBoundingClientRect();
    return { crumbRight: crumb.right, crumbBottom: crumb.bottom, togglesLeft: toggles.left, togglesBottom: toggles.bottom, columnsTop: columns.top };
  });
  expect(layout.crumbRight).toBeLessThanOrEqual(layout.togglesLeft);
  expect(layout.crumbBottom).toBeLessThanOrEqual(layout.columnsTop);
  expect(layout.togglesBottom).toBeLessThanOrEqual(layout.columnsTop);

  const metrics = await headerMetrics(page);
  expect(metrics.headerHeight).toBe(TOPBAR_HEIGHT);
  expectHeaderRowInsideTopbar(metrics);
  expectHeaderAlignedWithCells(metrics);
  // The body table no longer carries its own header row.
  await expect(page.locator("table[data-browse-table] thead")).toHaveCount(0);
});

test("column header row stays visible and aligned while main scrolls", async ({ page }) => {
  await openCameraUploads(page);
  const before = await headerMetrics(page);
  await scrollMainTo(page, 0.5);
  const middle = await headerMetrics(page);
  expect(middle.headerHeight).toBe(TOPBAR_HEIGHT);
  expectHeaderRowInsideTopbar(middle);
  expectHeaderAlignedWithCells(middle);
  for (let index = 0; index < COLUMN_KEYS.length; index += 1) {
    expect(middle.columns[index].top).toBe(before.columns[index].top);
  }

  await scrollMainTo(page, 1);
  const bottom = await headerMetrics(page);
  expectHeaderRowInsideTopbar(bottom);
  expectHeaderAlignedWithCells(bottom);
});

test("header stays aligned with the log panel minimized and at a narrow width", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("dropbox-browser.log-panel-minimized", "true");
  });
  await page.setViewportSize({ width: 900, height: 700 });
  await openCameraUploads(page);
  await scrollMainTo(page, 0.5);
  const metrics = await headerMetrics(page);
  expect(metrics.headerHeight).toBe(TOPBAR_HEIGHT);
  expectHeaderRowInsideTopbar(metrics);
  expectHeaderAlignedWithCells(metrics);
  const overlap = await page.evaluate(() => {
    const crumb = document.querySelector(".browse-topbar-breadcrumb").getBoundingClientRect();
    const toggles = document.querySelector(".sync-toggles").getBoundingClientRect();
    return { crumbRight: crumb.right, togglesLeft: toggles.left, togglesRight: toggles.right, width: window.innerWidth };
  });
  expect(overlap.crumbRight).toBeLessThanOrEqual(overlap.togglesLeft);
  expect(overlap.togglesRight).toBeLessThanOrEqual(overlap.width);

  // Restoring the bottom panel changes <main>'s height; alignment must hold.
  await page.locator("#bottom-pane-minimize").click();
  await page.waitForTimeout(250);
  const restored = await headerMetrics(page);
  expect(restored.headerHeight).toBe(TOPBAR_HEIGHT);
  expectHeaderAlignedWithCells(restored);
});

test("sorting from the top bar header works while scrolled", async ({ page }) => {
  await openCameraUploads(page);
  await scrollMainTo(page, 0.5);
  await expect(page.locator("body")).toHaveAttribute("data-current-sort-key", "name");
  const sizeLink = page.locator("header th[data-browse-column-key='size'] a[data-browse-sort='size']");
  await expect(sizeLink).toBeVisible();
  await sizeLink.click();
  await expect(page.locator("body")).toHaveAttribute("data-current-sort-key", "size");
  await expect(sizeLink).toHaveText(/Size \^/);
  // Client-side sort: no full page navigation, header still in the top bar.
  await expect(page.locator("body > header th[data-browse-column-key='size']")).toBeVisible();
  const metrics = await headerMetrics(page);
  expectHeaderRowInsideTopbar(metrics);
});

test("resizing a column from the top bar header while scrolled resizes the table column", async ({ page }) => {
  await openCameraUploads(page);
  await scrollMainTo(page, 0.5);
  const before = await headerMetrics(page);
  const handle = page.locator("header th[data-browse-column-key='name'] .browse-column-resizer");
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 80, startY, { steps: 10 });
  await page.mouse.up();

  const after = await headerMetrics(page);
  const nameBefore = before.columns[0];
  const nameAfter = after.columns[0];
  expect(nameAfter.cellWidth - nameBefore.cellWidth).toBeGreaterThan(60);
  expect(nameAfter.width - nameBefore.width).toBeGreaterThan(60);
  expectHeaderAlignedWithCells(after);
  const storage = await page.evaluate(() => JSON.parse(window.localStorage.getItem("dropbox-browser.browse-column-widths-v1") || "null"));
  expect(storage && storage.preferred && storage.preferred.name).toBeGreaterThan(Math.round(nameBefore.cellWidth));
});

const RESIZABLE_KEYS = ["name", "type", "status", "size", "date", "view"];

async function dragHandle(page, key, deltaX) {
  const handle = page.locator(`header th[data-browse-column-key="${key}"] .browse-column-resizer`);
  const box = await handle.boundingBox();
  expect(box, `${key} handle has a box`).not.toBeNull();
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + deltaX, startY, { steps: 15 });
  await page.mouse.up();
  await page.waitForTimeout(150);
}

// Visible geometry of every resize handle's dark marker (its ::before line).
async function handleMarkers(page) {
  return page.evaluate((keys) => {
    const clip = document.querySelector(".browse-head-clip").getBoundingClientRect();
    const bar = document.querySelector(".browse-topbar-columns").getBoundingClientRect();
    const visible = {
      left: Math.max(clip.left, bar.left),
      right: Math.min(clip.right, bar.right),
      top: Math.max(clip.top, bar.top),
      bottom: Math.min(clip.bottom, bar.bottom),
    };
    return keys.map((key) => {
      const th = document.querySelector(`header th[data-browse-column-key="${key}"]`);
      const handle = th && th.querySelector(".browse-column-resizer");
      if (!handle) return { key, present: false };
      const handleRect = handle.getBoundingClientRect();
      const thRect = th.getBoundingClientRect();
      const style = getComputedStyle(handle, "::before");
      const width = parseFloat(style.width) || 0;
      const height = parseFloat(style.height) || 0;
      const right = handleRect.right - (parseFloat(style.right) || 0);
      const top = handleRect.top + (parseFloat(style.top) || 0);
      const marker = { left: right - width, right, top, bottom: top + height, width, height };
      const hit = document.elementFromPoint((marker.left + marker.right) / 2, (marker.top + marker.bottom) / 2);
      return {
        key,
        present: true,
        columnWidth: thRect.width,
        marker,
        handleInsideColumn: handleRect.left >= thRect.left - 0.5 && handleRect.right <= thRect.right + 0.5,
        markerInsideVisible: marker.left >= visible.left - 0.5 && marker.right <= visible.right + 0.5
          && marker.top >= visible.top - 0.5 && marker.bottom <= visible.bottom + 0.5,
        markerInsideColumn: marker.left >= thRect.left - 0.5 && marker.right <= thRect.right + 0.5,
        hitsHandle: hit === handle,
        background: style.backgroundColor,
      };
    });
  }, RESIZABLE_KEYS);
}

function expectAllMarkersVisible(markers, label) {
  for (const item of markers) {
    expect(item.present, `${label}: ${item.key} handle exists`).toBe(true);
    expect(item.marker.width, `${label}: ${item.key} marker width`).toBeGreaterThan(0);
    expect(item.marker.height, `${label}: ${item.key} marker height`).toBeGreaterThan(0);
    expect(item.background, `${label}: ${item.key} marker colour`).not.toBe("rgba(0, 0, 0, 0)");
    expect(item.handleInsideColumn, `${label}: ${item.key} handle inside its column`).toBe(true);
    expect(item.markerInsideColumn, `${label}: ${item.key} marker inside its column`).toBe(true);
    expect(item.markerInsideVisible, `${label}: ${item.key} marker inside the visible header row`).toBe(true);
    expect(item.hitsHandle, `${label}: ${item.key} marker centre hits its handle`).toBe(true);
  }
}

test("resize handles stay visible and grabbable at the minimum and far-right extremes", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await openCameraUploads(page);
  await scrollMainTo(page, 0.5);

  // Collapse Name to its minimum width.
  await dragHandle(page, "name", -2000);
  let metrics = await headerMetrics(page);
  expect(Math.round(metrics.columns[0].cellWidth)).toBe(16);
  expectHeaderAlignedWithCells(metrics);
  expectAllMarkersVisible(await handleMarkers(page), "name at minimum");

  // The collapsed column's handle can still be grabbed and dragged back.
  await dragHandle(page, "name", 150);
  metrics = await headerMetrics(page);
  expect(metrics.columns[0].cellWidth).toBeGreaterThan(140);
  expectHeaderAlignedWithCells(metrics);

  // Push Name all the way right: every later column collapses against the
  // right edge (next to <main>'s scrollbar).
  await dragHandle(page, "name", 4000);
  metrics = await headerMetrics(page);
  for (const column of metrics.columns.slice(1)) {
    expect(Math.round(column.cellWidth), `${column.key} collapsed`).toBe(16);
  }
  expectHeaderAlignedWithCells(metrics);
  expectAllMarkersVisible(await handleMarkers(page), "name at maximum");

  // The right-most handle (View) is still draggable: moving it left shrinks
  // Name (the collapsed columns cannot shrink) and widens Sync.
  const syncBefore = metrics.columns[6].cellWidth;
  await dragHandle(page, "view", -120);
  metrics = await headerMetrics(page);
  expect(metrics.columns[6].cellWidth - syncBefore).toBeGreaterThan(100);
  expectHeaderAlignedWithCells(metrics);

  // And Name can be dragged back from the far right.
  const nameBefore = metrics.columns[0].cellWidth;
  await dragHandle(page, "name", -300);
  metrics = await headerMetrics(page);
  expect(nameBefore - metrics.columns[0].cellWidth).toBeGreaterThan(250);
  expectHeaderAlignedWithCells(metrics);
  expectAllMarkersVisible(await handleMarkers(page), "after dragging back");
});
