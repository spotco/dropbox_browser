/**
 * Shared music/video e2e checks for context-menu placement near the window
 * edges and for dragging the media-library pane dividers to their extremes.
 * `prefix` is "music" or "video" (element ids are `${prefix}-...`).
 */
const { expect } = require("@playwright/test");

// Every top-level row and every submenu row of `menuSelector` must be fully
// inside the viewport (and inside the bottom panel when the menu fits it),
// and elementFromPoint at its centre must hit that row (nothing clips or
// covers it).
async function menuGeometry(page, menuSelector, submenuOnly) {
  return page.evaluate(({ selector, onlySubmenu }) => {
    const menu = document.querySelector(selector);
    const toBox = (rect) => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height });
    const visibleSubmenus = Array.from(menu.querySelectorAll(".music-context-submenu"))
      .filter((submenu) => getComputedStyle(submenu).display !== "none");
    const container = onlySubmenu ? visibleSubmenus[0] : menu;
    const buttons = onlySubmenu
      ? Array.from(container.querySelectorAll(":scope > button"))
      : Array.from(menu.querySelectorAll(":scope > button, :scope > .music-context-menu-group > button"));
    const items = buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return {
        label: button.textContent.trim(),
        box: toBox(rect),
        hitsItem: !!(hit && (hit === button || button.contains(hit))),
      };
    });
    const panel = document.getElementById("log-panel");
    return {
      box: toBox(container.getBoundingClientRect()),
      viewport: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
      panel: panel ? toBox(panel.getBoundingClientRect()) : null,
      items,
    };
  }, { selector: menuSelector, onlySubmenu: !!submenuOnly });
}

function expectGeometryFullyVisible(geometry, label) {
  const { box, viewport, panel, items } = geometry;
  expect(items.length, `${label}: menu items`).toBeGreaterThan(0);
  expect(box.left, `${label}: left edge inside the viewport`).toBeGreaterThanOrEqual(0);
  expect(box.top, `${label}: top edge inside the viewport`).toBeGreaterThanOrEqual(0);
  expect(box.right, `${label}: right edge inside the viewport`).toBeLessThanOrEqual(viewport.width);
  expect(box.bottom, `${label}: bottom edge inside the viewport`).toBeLessThanOrEqual(viewport.height);
  if (panel && box.height <= panel.height) {
    expect(box.bottom, `${label}: bottom edge inside the visible panel`).toBeLessThanOrEqual(panel.bottom + 0.5);
  }
  for (const item of items) {
    expect(item.box.bottom, `${label}: "${item.label}" bottom inside the viewport`).toBeLessThanOrEqual(viewport.height);
    expect(item.box.right, `${label}: "${item.label}" right inside the viewport`).toBeLessThanOrEqual(viewport.width);
    expect(item.hitsItem, `${label}: elementFromPoint hits "${item.label}"`).toBe(true);
  }
}

async function expectContextMenuAndSubmenuVisible(page, menuSelector, submenuParentLabel, label) {
  const menu = page.locator(menuSelector);
  await expect(menu).toBeVisible();
  expectGeometryFullyVisible(await menuGeometry(page, menuSelector, false), `${label} menu`);
  const parent = menu.locator(".music-context-menu-group > .music-context-menu-parent", { hasText: submenuParentLabel }).first();
  await parent.hover();
  const submenu = parent.locator("xpath=following-sibling::*[contains(@class,'music-context-submenu')]");
  await expect(submenu).toBeVisible();
  expectGeometryFullyVisible(await menuGeometry(page, menuSelector, true), `${label} "${submenuParentLabel}" submenu`);
}

async function closeContextMenu(page, menuSelector) {
  await page.keyboard.press("Escape");
  if (await page.locator(menuSelector).isVisible()) {
    await page.mouse.click(5, 5);
  }
  await expect(page.locator(menuSelector)).toBeHidden();
}

// Right-click the last visible row of `rowSelector` (real mouse), check the
// menu; then open it again at the very bottom-right corner of the window on
// that row (synthetic event) to exercise both flips.
async function checkRowContextMenuNearEdges(page, { rowSelector, menuSelector, submenuParentLabel, label }) {
  const rows = page.locator(rowSelector);
  await expect(rows.first()).toBeVisible();
  const lastRow = rows.last();
  await lastRow.scrollIntoViewIfNeeded();
  const rowBox = await lastRow.boundingBox();
  const viewport = page.viewportSize();
  expect(rowBox.y + rowBox.height, `${label}: last row sits near the bottom of the window`).toBeGreaterThan(viewport.height - 180);
  await page.mouse.click(rowBox.x + Math.min(40, rowBox.width / 2), rowBox.y + rowBox.height / 2, { button: "right" });
  await expectContextMenuAndSubmenuVisible(page, menuSelector, submenuParentLabel, `${label} (row click)`);
  await closeContextMenu(page, menuSelector);

  await lastRow.evaluate((row) => {
    row.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: document.documentElement.clientWidth - 2,
      clientY: document.documentElement.clientHeight - 2,
    }));
  });
  await expectContextMenuAndSubmenuVisible(page, menuSelector, submenuParentLabel, `${label} (bottom-right corner)`);
  await closeContextMenu(page, menuSelector);
}

async function paneLayout(page, prefix) {
  return page.evaluate((p) => {
    const box = (selector) => {
      const element = document.querySelector(selector);
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    const resizerHit = (selector) => {
      const element = document.querySelector(selector);
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return !!(hit && (hit === element || element.contains(hit)));
    };
    return {
      library: box(`#${p}-library-pane`),
      playlist: box(`#${p}-playlist-pane`),
      playback: box(`#${p}-playback-pane`),
      libraryPlaylistResizer: box(`#${p}-resizer-library-playlist`),
      playlistPlaybackResizer: box(`#${p}-resizer-playlist-playback`),
      libraryPlaylistResizerHit: resizerHit(`#${p}-resizer-library-playlist`),
      playlistPlaybackResizerHit: resizerHit(`#${p}-resizer-playlist-playback`),
    };
  }, prefix);
}

async function dragResizer(page, selector, dx, dy) {
  const handle = await page.locator(selector).boundingBox();
  expect(handle, `${selector} has a box`).not.toBeNull();
  const x = handle.x + handle.width / 2;
  const y = handle.y + handle.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
}

const TINY_PX = 2.5;

// Wide (three columns) layout: each divider collapses either neighbour to
// ~1px, stays grabbable, drags back, and the collapsed size survives reload.
async function checkWidePaneDividerExtremes(page, { prefix, reopen, widthsSettingKey }) {
  const libraryResizer = `#${prefix}-resizer-library-playlist`;
  const playbackResizer = `#${prefix}-resizer-playlist-playback`;
  const start = await paneLayout(page, prefix);

  await dragResizer(page, libraryResizer, -4000, 0);
  let layout = await paneLayout(page, prefix);
  expect(layout.library.width, "library collapses to ~1px").toBeLessThanOrEqual(TINY_PX);
  expect(layout.libraryPlaylistResizer.width).toBeGreaterThanOrEqual(6);
  expect(layout.libraryPlaylistResizer.left).toBeGreaterThanOrEqual(layout.library.right - 0.5);
  expect(layout.libraryPlaylistResizerHit, "collapsed library divider is still grabbable").toBe(true);

  await dragResizer(page, libraryResizer, 260, 0);
  layout = await paneLayout(page, prefix);
  expect(layout.library.width, "library drags back open").toBeGreaterThan(200);

  await dragResizer(page, libraryResizer, 4000, 0);
  layout = await paneLayout(page, prefix);
  expect(layout.playlist.width, "playlist collapses to ~1px when the library is dragged over it").toBeLessThanOrEqual(TINY_PX);
  expect(layout.libraryPlaylistResizerHit).toBe(true);
  expect(layout.playlistPlaybackResizerHit, "neighbouring divider stays grabbable").toBe(true);

  await dragResizer(page, libraryResizer, -300, 0);
  layout = await paneLayout(page, prefix);
  expect(layout.playlist.width).toBeGreaterThan(200);

  await dragResizer(page, playbackResizer, 4000, 0);
  layout = await paneLayout(page, prefix);
  expect(layout.playback.width, "playback controls collapse to ~1px").toBeLessThanOrEqual(TINY_PX);
  expect(layout.playlistPlaybackResizer.right).toBeLessThanOrEqual(layout.playback.left + 0.5);
  expect(layout.playlistPlaybackResizerHit, "collapsed playback divider is still grabbable").toBe(true);
  await expect(page.locator(`#${prefix}-playback-pane`)).toHaveClass(/music-subpane-tiny/);

  const saved = await page.evaluate((key) => Settings.get(key, null), widthsSettingKey);
  expect(saved).toHaveLength(3);
  await page.reload();
  await reopen(page);
  await expect.poll(async () => (await paneLayout(page, prefix)).playback.width).toBeLessThanOrEqual(TINY_PX);
  expect(await page.evaluate((key) => Settings.get(key, null), widthsSettingKey)).toEqual(saved);

  await dragResizer(page, playbackResizer, -300, 0);
  layout = await paneLayout(page, prefix);
  expect(layout.playback.width, "playback drags back open after reload").toBeGreaterThan(200);
  await expect(page.locator(`#${prefix}-playback-pane`)).not.toHaveClass(/music-subpane-tiny/);
  expect(start.library.width).toBeGreaterThan(0);
}

// Narrow (stacked) layout: the horizontal divider hides the playback row or
// the top row, and the vertical divider hides the library or the playlist.
async function checkNarrowPaneDividerExtremes(page, { prefix }) {
  const verticalResizer = `#${prefix}-resizer-library-playlist`;
  const horizontalResizer = `#${prefix}-resizer-playlist-playback`;

  await dragResizer(page, horizontalResizer, 0, 4000);
  let layout = await paneLayout(page, prefix);
  expect(layout.playback.height, "playback row collapses to ~1px").toBeLessThanOrEqual(TINY_PX);
  expect(layout.playlistPlaybackResizerHit, "playback divider stays reachable").toBe(true);

  await dragResizer(page, horizontalResizer, 0, -4000);
  layout = await paneLayout(page, prefix);
  expect(layout.library.height, "top row collapses to ~1px").toBeLessThanOrEqual(TINY_PX);
  expect(layout.playlist.height).toBeLessThanOrEqual(TINY_PX);
  expect(layout.playlistPlaybackResizerHit, "playback divider stays reachable").toBe(true);

  await dragResizer(page, horizontalResizer, 0, 200);
  layout = await paneLayout(page, prefix);
  expect(layout.library.height).toBeGreaterThan(150);

  await dragResizer(page, verticalResizer, -4000, 0);
  layout = await paneLayout(page, prefix);
  expect(layout.library.width, "library column collapses to ~1px").toBeLessThanOrEqual(TINY_PX);
  expect(layout.libraryPlaylistResizerHit).toBe(true);

  await dragResizer(page, verticalResizer, 4000, 0);
  layout = await paneLayout(page, prefix);
  expect(layout.playlist.width, "playlist column collapses to ~1px").toBeLessThanOrEqual(TINY_PX);
  expect(layout.libraryPlaylistResizerHit).toBe(true);

  await dragResizer(page, verticalResizer, -150, 0);
  layout = await paneLayout(page, prefix);
  expect(layout.playlist.width).toBeGreaterThan(100);
}

// ---- Active-playlist column floors (16px, same as the file browser) ----

const PLAYLIST_COLUMN_KEYS = ["index", "filename", "path", "reorder"];
const PLAYLIST_COLUMN_FLOOR_PX = 16;

async function playlistColumnState(page, prefix) {
  return page.evaluate((p) => {
    const table = document.getElementById(`${p}-playlist-table`);
    const value = getComputedStyle(table).getPropertyValue("--music-playlist-grid-columns").trim();
    const headings = Array.from(table.querySelectorAll(".music-playlist-heading .music-playlist-column-heading"))
      .map((heading) => heading.getBoundingClientRect().width);
    const handles = {};
    table.querySelectorAll(".music-playlist-column-resizer").forEach((handle) => {
      const rect = handle.getBoundingClientRect();
      const column = handle.closest(".music-playlist-column-heading").getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      handles[handle.getAttribute("data-music-playlist-column-resizer")] = {
        width: rect.width,
        height: rect.height,
        insideColumn: rect.left >= column.left - 0.5 && rect.right <= column.right + 0.5,
        hit: hit === handle,
        cx,
        cy,
      };
    });
    return {
      widths: value.split(/\s+/).map((part) => Number.parseFloat(part)),
      headings,
      handles,
    };
  }, prefix);
}

async function dragPlaylistColumn(page, prefix, key, dx) {
  const state = await playlistColumnState(page, prefix);
  const handle = state.handles[key];
  await page.mouse.move(handle.cx, handle.cy);
  await page.mouse.down();
  await page.mouse.move(handle.cx + dx, handle.cy, { steps: 8 });
  await page.mouse.up();
  return playlistColumnState(page, prefix);
}

function expectHandlesUsable(state, label) {
  for (const key of ["index", "filename", "path"]) {
    const handle = state.handles[key];
    expect(handle.width, `${label} ${key} handle width`).toBeCloseTo(14, 0);
    expect(handle.insideColumn, `${label} ${key} handle stays inside its column`).toBe(true);
    expect(handle.hit, `${label} ${key} handle is the topmost element at its centre`).toBe(true);
  }
}

// Drag every playlist divider until it stops: each column stops at 16px with
// its 14px handle fully inside and clickable, and the narrow widths survive a
// reload (separate settings keys for music and video).
async function checkPlaylistColumnFloors(page, { prefix, reopen, settingKey }) {
  const table = page.locator(`#${prefix}-playlist-table`);
  await expect(table).toBeVisible();
  await expect.poll(async () => (await playlistColumnState(page, prefix)).widths.length).toBe(4);

  let state = await dragPlaylistColumn(page, prefix, "index", -2000);
  expect(state.widths[0], "index stops at the 16px floor").toBeCloseTo(PLAYLIST_COLUMN_FLOOR_PX, 0);
  state = await dragPlaylistColumn(page, prefix, "filename", -2000);
  expect(state.widths[1], "filename stops at the 16px floor").toBeCloseTo(PLAYLIST_COLUMN_FLOOR_PX, 0);
  state = await dragPlaylistColumn(page, prefix, "path", 4000);
  expect(state.widths[3], "reorder stops at the 16px floor").toBeCloseTo(PLAYLIST_COLUMN_FLOOR_PX, 0);
  expect(state.widths[2]).toBeGreaterThan(PLAYLIST_COLUMN_FLOOR_PX);
  // The rendered header cells match the floors (no stylesheet minmax floor).
  expect(state.headings[0]).toBeCloseTo(PLAYLIST_COLUMN_FLOOR_PX, 0);
  expect(state.headings[1]).toBeCloseTo(PLAYLIST_COLUMN_FLOOR_PX, 0);
  expect(state.headings[3]).toBeCloseTo(PLAYLIST_COLUMN_FLOOR_PX, 0);
  expectHandlesUsable(state, prefix);

  // A 16px column's handle can still be grabbed and dragged back out (the
  // neighbour gives up the width), then pushed back down to the floor.
  state = await dragPlaylistColumn(page, prefix, "index", 40);
  expect(state.widths[0]).toBeGreaterThan(PLAYLIST_COLUMN_FLOOR_PX + 30);
  state = await dragPlaylistColumn(page, prefix, "index", -2000);
  expect(state.widths[0]).toBeCloseTo(PLAYLIST_COLUMN_FLOOR_PX, 0);
  state = await dragPlaylistColumn(page, prefix, "filename", -2000);
  expect(state.widths[1]).toBeCloseTo(PLAYLIST_COLUMN_FLOOR_PX, 0);

  const saved = await page.evaluate((key) => Settings.get(key, null), settingKey);
  expect(saved).toMatchObject({ index: 16, filename: 16, reorder: 16 });
  const savedWidths = PLAYLIST_COLUMN_KEYS.map((key) => saved[key]);

  await reopen(page);
  await expect.poll(async () => (await playlistColumnState(page, prefix)).widths).toEqual(savedWidths);
  expectHandlesUsable(await playlistColumnState(page, prefix), `${prefix} after reload`);
}

module.exports = {
  checkRowContextMenuNearEdges,
  checkWidePaneDividerExtremes,
  checkNarrowPaneDividerExtremes,
  checkPlaylistColumnFloors,
  paneLayout,
};