/**
 * Shared helpers for video e2e after Phase 5 shared media-library UI.
 */
const { expect } = require("@playwright/test");

async function loadVideoLibrary(page) {
  const loadButton = page.locator("#video-library-load");
  await expect(loadButton).toBeVisible({ timeout: 10000 });
  const songCount = await page.locator("#video-library-tree .music-tree-song").count();
  if (songCount > 0) return;
  await loadButton.click();
  await expect
    .poll(async () => {
      return page.locator("#video-library-tree .music-tree-song").count();
    }, { timeout: 45000 })
    .toBeGreaterThan(0);
}

async function libraryRow(page, filename) {
  await loadVideoLibrary(page);
  return page
    .locator("#video-library-tree .music-tree-song")
    .filter({ has: page.locator(".music-tree-name", { hasText: filename }) })
    .first();
}

async function expectActivePlaylistTitle(page, filename) {
  const activeRow = page.locator("#video-playlist-list .music-playlist-entry.current").first();
  await expect(activeRow).toBeVisible({ timeout: 15000 });
  await expect(activeRow.locator('[role="cell"]').first()).toHaveText(filename);
}

/** @deprecated Use expectActivePlaylistTitle */
const expectActiveQueueTitle = expectActivePlaylistTitle;

async function playLibraryFile(page, filename, options = {}) {
  const waitForPlayback = options.waitForPlayback !== false;
  const row = await libraryRow(page, filename);
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.dblclick();
  await expectActivePlaylistTitle(page, filename);
  if (typeof options.afterPlay === "function") {
    await options.afterPlay();
  }
  return row;
}

async function queueLibraryFile(page, filename) {
  const row = await libraryRow(page, filename);
  await expect(row).toBeVisible();
  await row.click({ modifiers: ["Control"] });
  // Context menu "Add selected" — music-style shared library
  await row.click({ button: "right" });
  const menu = page.locator("#video-library-context-menu");
  await expect(menu).toBeVisible({ timeout: 5000 });
  await menu.locator('[data-action="add-selected"]').click();
  await expect(menu).toBeHidden({ timeout: 5000 });
}

async function playlistEntryCount(page) {
  return page.locator("#video-playlist-list .music-playlist-entry").count();
}

async function expectPlaylistCount(page, count) {
  await expect
    .poll(async () => playlistEntryCount(page), { timeout: 10000 })
    .toBe(count);
}

module.exports = {
  loadVideoLibrary,
  libraryRow,
  playLibraryFile,
  queueLibraryFile,
  expectActivePlaylistTitle,
  expectActiveQueueTitle,
  playlistEntryCount,
  expectPlaylistCount,
};
