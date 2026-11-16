const path = require("node:path");
const { test, expect } = require("@playwright/test");

const workerPortOffset = Number(process.env.DROPBOX_BROWSER_E2E_LANE_INDEX || "0") * 100;
process.env.PLAYWRIGHT_PORT = String(8016 + workerPortOffset);
process.env.DROPBOX_BROWSER_E2E_FIXTURE = path.join(__dirname, "fixtures", "basic-library.json");

const { startIntegrationServer, stopIntegrationServer } = require("./support/integration_server");

const baseURL = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT}`;
const VIDEO_SYNC_PATH = "folder/dev_test_video_playlists.json";

let server = null;

test.describe.configure({ mode: "serial", timeout: 120000 });
test.use({ baseURL });

function songPaths(count) {
  const paths = [];
  for (let index = 1; index <= count; index += 1) {
    paths.push(`folder/song-${index}.mp3`);
  }
  return paths;
}

function playlistExport(playlists) {
  return {
    exported_at: 11,
    playlists: playlists.map((playlist) => ({
      last_modified: 11,
      name: playlist.name,
      songs: playlist.songs,
    })),
    version: 1,
  };
}

async function seedSavedPlaylists(page, key, payload) {
  await page.addInitScript(({ storageKey, document }) => {
    const fullKey = `dropbox-browser.${storageKey}`;
    if (localStorage.getItem(fullKey) === null) {
      localStorage.setItem(fullKey, JSON.stringify(document));
    }
  }, { storageKey: key, document: payload });
}

async function openMusic(page, search) {
  await page.goto(`/${search || ""}`);
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await page.locator("#bottom-pane-mode").selectOption("music-player");
  await expect(page.locator("#music-player-pane")).toBeVisible();
}

async function openVideo(page) {
  await page.locator("#bottom-pane-mode").selectOption("video-player");
  await expect(page.locator("#video-player-pane")).toBeVisible();
}

async function writeRemotePlaylist(page, relPath, payload) {
  const body = JSON.stringify(payload, null, 2);
  const write = await page.request.post(`/local-file?path=${encodeURIComponent(relPath)}&enable_write_dropbox=1`, {
    data: body,
    headers: { "Content-Type": "application/octet-stream" },
  });
  expect(write.ok()).toBeTruthy();
  const sync = await page.request.post("/sync", {
    form: {
      direction: "local_to_dropbox",
      enable_write_dropbox: "1",
      kind: "file",
      path: relPath,
    },
  });
  expect(sync.ok()).toBeTruthy();
  const started = await sync.json();
  let finished = null;
  await expect.poll(async () => {
    const status = await page.request.get(`/sync-status?id=${encodeURIComponent(started.id)}`);
    finished = await status.json();
    return finished.status;
  }).toBe("complete");
  expect(finished.errors || [], JSON.stringify(finished)).toEqual([]);
  const readback = await page.request.get(`/file?path=${encodeURIComponent(relPath)}&source=remote`);
  expect(readback.status(), await readback.text()).toBe(200);
  return body;
}

async function readRemoteText(page, relPath) {
  const response = await page.request.get(`/file?path=${encodeURIComponent(relPath)}&source=remote`);
  expect(response.ok()).toBeTruthy();
  return response.text();
}

async function expectSyncSummary(page, prefix, pattern) {
  // Title and notice text are already in the page HTML. Wait until the dialog
  // is actually shown, then until the remote read fills the summary. A busy
  // distributed run can spend well over 20s behind other local requests.
  const dialog = page.locator(`#${prefix}-playlist-sync-dialog`);
  const summary = page.locator(`#${prefix}-playlist-sync-summary`);
  const status = page.locator(`#${prefix}-player-status-text`);
  await expect(dialog).toBeVisible({ timeout: 60000 });
  try {
    await expect(summary).toHaveValue(pattern, { timeout: 5000 });
  } catch (error) {
    const statusText = await status.innerText().catch(() => "");
    throw new Error(`${error.message}\nplayer status: ${statusText}`);
  }
}

async function loadSavedPlaylist(page, prefix, name) {
  await page.locator(`#${prefix}-playlist-load`).click();
  await expect(page.locator(`#${prefix}-playlist-load-title`)).toBeVisible();
  await page.locator(`#${prefix}-playlist-load-list .music-playlist-load-entry`).filter({ hasText: name }).click();
  await page.locator(`#${prefix}-playlist-load-confirm`).click();
  await expect(page.locator(`#${prefix}-playlist-load-dialog`)).toBeHidden();
}

test.beforeAll(async () => {
  test.setTimeout(60000);
  server = await startIntegrationServer();
});

test.afterAll(async () => {
  await stopIntegrationServer(server);
  server = null;
});

test("playlist buttons use short labels and keep the dialog titles", async ({ page }) => {
  await seedSavedPlaylists(page, "music-playlists", playlistExport([{ name: "Favorites", songs: songPaths(1) }]));
  await openMusic(page, "?path=folder&music_playlist_sync_path=folder/dev_test_music_labels.json");
  await expect(page.locator("#music-playlist-load")).toHaveText("Playlists");
  await expect(page.locator("#music-playlist-rename")).toHaveText("Rename");
  await expect(page.locator("#music-playlist-sync-pull")).toHaveText("Sync Pull");
  await expect(page.locator("#music-playlist-sync-push")).toHaveText("Sync Push");
  await page.locator("#music-playlist-load").click();
  await expect(page.locator("#music-playlist-load-title")).toHaveText("Load Playlist: Songs");
  await page.locator("#music-playlist-load-cancel").click();
  await page.locator("#music-playlist-rename").click();
  await expect(page.locator("#music-playlist-rename-title")).toHaveText("Rename Playlist");
  await page.locator("#music-playlist-rename-cancel").click();
});

test("pull replaces a linked playlist and discards a local removal", async ({ page }) => {
  const local = playlistExport([{ name: "Favorites", songs: songPaths(20) }]);
  const remote = playlistExport([{ name: "Favorites", songs: songPaths(25) }]);
  const syncPath = "folder/dev_test_music_pull.json";
  await seedSavedPlaylists(page, "music-playlists", local);
  await openMusic(page, `?path=folder&music_playlist_sync_path=${encodeURIComponent(syncPath)}`);
  await writeRemotePlaylist(page, syncPath, remote);
  await loadSavedPlaylist(page, "music", "Favorites");
  await expect(page.locator("#music-active-playlist-name")).toHaveText("Favorites");
  await expect(page.locator("#music-playlist-list .music-playlist-entry")).toHaveCount(20);
  await page.evaluate(() => {
    const row = document.querySelector("#music-playlist-list .music-playlist-entry");
    const rect = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      button: 2,
      cancelable: true,
      clientX: rect.left + 12,
      clientY: rect.top + 8,
    }));
    document.querySelector("#music-playlist-context-menu [data-action='remove']").click();
  });
  await expect(page.locator("#music-playlist-list .music-playlist-entry")).toHaveCount(19);

  await page.locator("#music-playlist-sync-pull").click();
  await expect(page.locator("#music-playlist-sync-title")).toHaveText("Replace Local Saved Playlists from Dropbox");
  await expect(page.locator("#music-playlist-sync-notice")).toHaveText(/discards unsaved changes/);
  await expectSyncSummary(page, "music", /Changed "Favorites": added 5, removed 0/);
  await page.locator("#music-playlist-sync-confirm").click();
  await expect(page.locator("#music-playlist-sync-dialog")).toBeHidden();
  await expect(page.locator("#music-active-playlist-name")).toHaveText("Favorites");
  await expect(page.locator("#music-playlist-list .music-playlist-entry")).toHaveCount(25);

  await page.reload();
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await page.locator("#bottom-pane-mode").selectOption("music-player");
  await page.locator("#music-playlist-load").click();
  await expect(page.locator("#music-playlist-load-list")).toContainText("25");
  await expect(page.locator("#music-active-playlist-name")).toHaveText("New Playlist");
});

test("pull resets the active playlist when the linked name is gone", async ({ page }) => {
  const local = playlistExport([{ name: "Favorites", songs: songPaths(2) }]);
  const remote = playlistExport([{ name: "Road", songs: songPaths(1) }]);
  const syncPath = "folder/dev_test_music_reset.json";
  await seedSavedPlaylists(page, "music-playlists", local);
  await openMusic(page, `?path=folder&music_playlist_sync_path=${encodeURIComponent(syncPath)}`);
  await writeRemotePlaylist(page, syncPath, remote);
  await loadSavedPlaylist(page, "music", "Favorites");
  await page.locator("#music-playlist-sync-pull").click();
  await expectSyncSummary(page, "music", /Removed "Favorites"/);
  await page.locator("#music-playlist-sync-confirm").click();
  await expect(page.locator("#music-active-playlist-name")).toHaveText("New Playlist");
  await expect(page.locator("#music-playlist-list .music-playlist-entry")).toHaveCount(0);
});

test("cancel and a no-change summary leave both sides alone", async ({ page }) => {
  const same = playlistExport([{ name: "Favorites", songs: songPaths(2) }]);
  await seedSavedPlaylists(page, "music-playlists", same);
  const syncPath = "folder/dev_test_music_cancel.json";
  await openMusic(page, `?path=folder&music_playlist_sync_path=${encodeURIComponent(syncPath)}`);
  await writeRemotePlaylist(page, syncPath, same);
  await loadSavedPlaylist(page, "music", "Favorites");
  await page.locator("#music-playlist-sync-pull").click();
  await expectSyncSummary(page, "music", /No playlist changes/);
  await expect(page.locator("#music-playlist-sync-confirm")).toBeDisabled();
  await page.locator("#music-playlist-sync-cancel").click();
  await expect(page.locator("#music-playlist-list .music-playlist-entry")).toHaveCount(2);

  const changed = playlistExport([{ name: "Favorites", songs: songPaths(3) }]);
  await writeRemotePlaylist(page, syncPath, changed);
  await page.locator("#music-playlist-sync-pull").click();
  await expect(page.locator("#music-playlist-sync-confirm")).toBeEnabled();
  await page.locator("#music-playlist-sync-cancel").click();
  await expect(page.locator("#music-playlist-list .music-playlist-entry")).toHaveCount(2);
  const remoteText = await readRemoteText(page, syncPath);
  expect(remoteText).toContain("song-3.mp3");
});

test("push writes the confirmed export and a missing file is not an empty pull", async ({ page }) => {
  const local = playlistExport([{ name: "Favorites", songs: songPaths(4) }]);
  await seedSavedPlaylists(page, "music-playlists", local);
  await openMusic(page, `?path=folder&music_playlist_sync_path=${encodeURIComponent("folder/dev_test_missing.json")}`);
  await page.locator("#music-playlist-sync-pull").click();
  await expect(page.locator("#music-player-status-text")).toContainText("not found");
  await expect(page.locator("#music-playlist-sync-dialog")).toBeHidden();

  const syncPath = "folder/dev_test_music_push.json";
  await page.goto(`/?path=folder&music_playlist_sync_path=${encodeURIComponent(syncPath)}`);
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await page.locator("#bottom-pane-mode").selectOption("music-player");
  await page.locator("#music-playlist-sync-push").click();
  await expect(page.locator("#music-playlist-sync-title")).toHaveText("Replace Dropbox Saved Playlists from Local");
  await expectSyncSummary(page, "music", /Added "Favorites" \(4 items\)/);
  await page.locator("#music-playlist-sync-confirm").click();
  await expect(page.locator("#music-player-status-text")).toContainText("Replaced the Dropbox playlist file");
  const remoteText = await readRemoteText(page, syncPath);
  expect(remoteText).toContain("song-4.mp3");
  expect(remoteText).not.toContain("dropbox_browser_music_playlists.json");
});

test("invalid remote JSON does not change saved playlists", async ({ page }) => {
  const local = playlistExport([{ name: "Favorites", songs: songPaths(2) }]);
  await seedSavedPlaylists(page, "music-playlists", local);
  const syncPath = "folder/dev_test_music_invalid.json";
  await openMusic(page, `?path=folder&music_playlist_sync_path=${encodeURIComponent(syncPath)}`);
  const write = await page.request.post(`/local-file?path=${encodeURIComponent(syncPath)}&enable_write_dropbox=1`, {
    data: "{",
    headers: { "Content-Type": "application/octet-stream" },
  });
  expect(write.ok()).toBeTruthy();
  const sync = await page.request.post("/sync", {
    form: {
      direction: "local_to_dropbox",
      enable_write_dropbox: "1",
      kind: "file",
      path: syncPath,
    },
  });
  const started = await sync.json();
  await expect.poll(async () => (await (await page.request.get(`/sync-status?id=${started.id}`)).json()).status).toBe("complete");
  await loadSavedPlaylist(page, "music", "Favorites");
  await page.locator("#music-playlist-sync-pull").click();
  await expect(page.locator("#music-playlist-sync-dialog")).toBeHidden();
  await expect(page.locator("#music-playlist-list .music-playlist-entry")).toHaveCount(2);
});

test("blank sync path disables the buttons and video uses its own file", async ({ page }) => {
  const musicLocal = playlistExport([{ name: "Favorites", songs: songPaths(2) }]);
  const videoLocal = playlistExport([{ name: "Clips", songs: ["folder/clip-1.mkv"] }]);
  await seedSavedPlaylists(page, "music-playlists", musicLocal);
  await seedSavedPlaylists(page, "video-playlists", videoLocal);
  await openMusic(page, "?path=folder&music_playlist_sync_path=");
  await expect(page.locator("#music-playlist-sync-pull")).toBeDisabled();
  await expect(page.locator("#music-playlist-sync-push")).toBeDisabled();

  await page.goto(`/?path=folder&video_playlist_sync_path=${encodeURIComponent(VIDEO_SYNC_PATH)}`);
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await openVideo(page);
  await expect(page.locator("#video-playlist-load")).toHaveText("Playlists");
  await expect(page.locator("#video-playlist-load-title")).toHaveText("Load Playlist: Videos");
  const musicBefore = await page.evaluate(() => localStorage.getItem("dropbox-browser.music-playlists"));
  await loadSavedPlaylist(page, "video", "Clips");
  await page.locator("#video-playlist-sync-push").click();
  await expectSyncSummary(page, "video", /Added "Clips"/);
  await page.locator("#video-playlist-sync-confirm").click();
  await expect(page.locator("#video-player-status")).toContainText("Replaced the Dropbox playlist file");
  const remoteText = await readRemoteText(page, VIDEO_SYNC_PATH);
  expect(remoteText).toContain("clip-1.mkv");
  expect(await page.evaluate(() => localStorage.getItem("dropbox-browser.music-playlists"))).toBe(musicBefore);
  expect(remoteText).not.toContain("Favorites");
});
