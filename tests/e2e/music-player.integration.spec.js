const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, expect } = require("@playwright/test");

process.env.PLAYWRIGHT_PORT = "8012";
process.env.DROPBOX_BROWSER_E2E_FIXTURE = path.join(
  __dirname,
  "fixtures",
  "music_player_generated_fixture.py",
);
process.env.DROPBOX_BROWSER_E2E_MUSIC_LIBRARY_POLL_DELAY_MS = "100";

const { startIntegrationServer, stopIntegrationServer } = require("./support/integration_server");

const baseURL = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT}`;

let server = null;

test.describe.configure({ mode: "serial", timeout: 60000 });

test.use({ baseURL });

async function openMusicPlayer(page) {
  await page.goto("/?path=music");
  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await page.locator("#bottom-pane-mode").selectOption("music-player");
  await expect(page.locator("#music-player-pane")).toBeVisible();
  await expect(page.locator("#music-player-pane")).toHaveAttribute("data-player-ready", "library");
}

async function loadCompleteLibrary(page) {
  await page.locator("#music-library-load").click();
  await expect
    .poll(async () => page.locator("#music-player-status").innerText(), { timeout: 15000 })
    .toMatch(/Loaded 4 songs? and 1 folders?\./);
  await expect(page.locator("#music-library-load")).toBeEnabled({ timeout: 5000 });
}

function songRow(page, name) {
  return page
    .locator("#music-library-tree .music-tree-row.music-tree-song")
    .filter({ hasText: name })
    .first();
}

function folderRow(page, name) {
  return page
    .locator("#music-library-tree .music-tree-row.music-tree-folder")
    .filter({ hasText: name })
    .first();
}

async function expandFolder(page, name) {
  const row = folderRow(page, name);
  await expect(row).toBeVisible();
  if ((await row.getAttribute("aria-expanded")) === "false") {
    await row.locator(".music-tree-toggle").click();
  }
  await expect(row).toHaveAttribute("aria-expanded", "true");
}

async function visibleSongNames(page) {
  return (await page.locator("#music-library-tree .music-tree-song .music-tree-name").allTextContents())
    .map((name) => name.trim())
    .filter(Boolean);
}

async function playlistEntryNames(page) {
  const rows = page.locator("#music-playlist-list .music-playlist-entry");
  const count = await rows.count();
  const names = [];
  for (let i = 0; i < count; i += 1) {
    names.push((await rows.nth(i).locator('[role="cell"]').first().innerText()).trim());
  }
  return names;
}

async function addSelectedSongsViaContextMenu(page) {
  const selected = page.locator("#music-library-tree .music-tree-row[aria-selected='true']").first();
  await selected.click({ button: "right" });
  const menu = page.locator("#music-library-context-menu");
  await expect(menu).toBeVisible();
  await menu.locator('[data-action="add-selected"]').click();
  await expect(menu).toBeHidden();
}

async function waitForCurrentPlaylistSong(page, filename) {
  await expect
    .poll(async () => {
      const current = page.locator("#music-playlist-list .music-playlist-entry.current");
      if ((await current.count()) === 0) return "";
      return (await current.locator('[role="cell"]').first().innerText()).trim();
    }, { timeout: 10000 })
    .toBe(filename);
}

async function waitForPlaying(page) {
  await expect
    .poll(async () => {
      return page.evaluate(() => {
        const audio = document.getElementById("music-audio");
        const play = document.getElementById("music-play");
        if (!audio || !play) return null;
        return {
          paused: audio.paused,
          readyState: audio.readyState,
          playState: play.getAttribute("data-state") || "play",
          hasSrc: Boolean(audio.currentSrc || audio.src),
        };
      });
    }, { timeout: 10000 })
    .toMatchObject({
      paused: false,
      playState: "pause",
      hasSrc: true,
    });
}

async function waitForPaused(page) {
  await expect
    .poll(async () => {
      return page.evaluate(() => {
        const audio = document.getElementById("music-audio");
        const play = document.getElementById("music-play");
        if (!audio || !play) return null;
        return {
          paused: audio.paused,
          playState: play.getAttribute("data-state") || "play",
        };
      });
    }, { timeout: 10000 })
    .toMatchObject({
      paused: true,
      playState: "play",
    });
}

async function audioSnapshot(page) {
  return page.evaluate(() => {
    const audio = document.getElementById("music-audio");
    if (!audio) return null;
    return {
      paused: audio.paused,
      currentTime: audio.currentTime,
      duration: audio.duration,
      volume: audio.volume,
      src: audio.currentSrc || audio.src || "",
    };
  });
}

async function waveformCanvasSnapshot(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById("music-waveform-canvas");
    if (!canvas || !canvas.width || !canvas.height) return null;
    const context = canvas.getContext("2d");
    if (!context) return null;
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 0;
    let nonBackgroundPixels = 0;
    for (let index = 0; index < data.length; index += 4) {
      const red = data[index];
      const green = data[index + 1];
      const blue = data[index + 2];
      if (red !== 11 || green !== 18 || blue !== 32) nonBackgroundPixels += 1;
      hash = ((hash * 31) + red + green * 3 + blue * 7) >>> 0;
    }
    return { width: canvas.width, height: canvas.height, hash, nonBackgroundPixels };
  });
}

async function resetAudioPosition(page) {
  await page.evaluate(() => {
    const audio = document.getElementById("music-audio");
    if (!audio) return;
    audio.pause();
    audio.currentTime = 0;
    audio.dispatchEvent(new Event("timeupdate"));
  });
  await page.waitForTimeout(100);
}

async function startWaveformStatusHistory(page) {
  await page.evaluate(() => {
    const status = document.getElementById("music-waveform-status");
    window.__musicWaveformStatusHistory = [];
    if (!status || typeof MutationObserver !== "function") return;
    const observer = new MutationObserver(() => {
      window.__musicWaveformStatusHistory.push(status.textContent || "");
    });
    observer.observe(status, { childList: true, characterData: true, subtree: true });
    window.__musicWaveformStatusObserver = observer;
  });
}

function waveformFetchRequests(requests) {
  return requests.filter((request) => {
    const headers = request.headers();
    return request.resourceType() === "fetch" &&
      new URL(request.url()).pathname === "/file" &&
      !headers.range;
  });
}

async function clearMusicSettings(page) {
  await page.evaluate(() => {
    const keys = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith("dropbox-browser.music-")) keys.push(key);
    }
    keys.forEach((key) => localStorage.removeItem(key));
  });
}

async function selectedLibrarySongNames(page) {
  return (
    await page
      .locator("#music-library-tree .music-tree-song[aria-selected='true'] .music-tree-name")
      .allTextContents()
  )
    .map((name) => name.trim())
    .filter(Boolean);
}

async function selectedPlaylistEntryNames(page) {
  const rows = page.locator("#music-playlist-list .music-playlist-entry.selected");
  const count = await rows.count();
  const names = [];
  for (let i = 0; i < count; i += 1) {
    names.push((await rows.nth(i).locator('[role="cell"]').first().innerText()).trim());
  }
  return names;
}

async function playlistContextAction(page, songName, action) {
  await page.evaluate(({ name, dataAction }) => {
    const rows = Array.from(document.querySelectorAll("#music-playlist-list .music-playlist-entry"));
    const row = rows.find((entry) => {
      const cell = entry.querySelector('[role="cell"]');
      return cell && cell.textContent.trim() === name;
    });
    if (!row) throw new Error("playlist row not found: " + name);
    const rect = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + 12,
      clientY: rect.top + 8,
      button: 2,
    }));
    const button = document.querySelector(`#music-playlist-context-menu [data-action="${dataAction}"]`);
    if (!button) throw new Error("playlist action missing: " + dataAction);
    button.click();
  }, { name: songName, dataAction: action });
}

async function readSettingsKey(page, key, fallback = null) {
  return page.evaluate(({ settingKey, defaultValue }) => {
    if (typeof Settings === "undefined" || !Settings.get) return defaultValue;
    return Settings.get(settingKey, defaultValue);
  }, { settingKey: key, defaultValue: fallback });
}

test.beforeAll(async () => {
  // The generated WAV fixture can be expensive to materialize when the full
  // Playwright project set starts together. Match the integration server's
  // 30-second readiness budget instead of the global 10-second hook timeout.
  test.setTimeout(60000);
  server = await startIntegrationServer();
});

test.afterAll(async () => {
  await stopIntegrationServer(server);
  server = null;
});

test("library loads complete tree, sort, playlist CRUD, and playback", async ({ page }) => {
  await openMusicPlayer(page);
  await expect(page.locator("#music-playlist-list")).toContainText("Playlist is empty.");

  await loadCompleteLibrary(page);

  // --- Library tree + expand nested folder ---
  await expect(songRow(page, "TrackA.wav")).toBeVisible();
  await expect(songRow(page, "TrackB.wav")).toBeVisible();
  await expect(songRow(page, "TrackC.wav")).toBeVisible();
  await expect(folderRow(page, "Side")).toBeVisible();
  await expandFolder(page, "Side");
  await expect(songRow(page, "TrackD.wav")).toBeVisible();

  // Collapse folder hides nested songs again
  await folderRow(page, "Side").locator(".music-tree-toggle").click();
  await expect(folderRow(page, "Side")).toHaveAttribute("aria-expanded", "false");
  await expect(songRow(page, "TrackD.wav")).toHaveCount(0);
  await expandFolder(page, "Side");
  await expect(songRow(page, "TrackD.wav")).toBeVisible();

  // Name sort default among root-visible songs: TrackA, TrackB, TrackC (TrackD hidden until expand)
  expect((await visibleSongNames(page)).filter((name) => name !== "TrackD.wav")).toEqual([
    "TrackA.wav",
    "TrackB.wav",
    "TrackC.wav",
  ]);

  // Date sort (default direction for date is desc): A (Mar) > C (Feb) > B (Jan)
  await page.locator('#music-library-pane [data-library-sort-key="date"]').click();
  await expect
    .poll(async () => {
      return (await visibleSongNames(page)).filter((name) => name !== "TrackD.wav");
    }, { timeout: 3000 })
    .toEqual(["TrackA.wav", "TrackC.wav", "TrackB.wav"]);

  // Restore name asc for stable later steps
  await page.locator('#music-library-pane [data-library-sort-key="name"]').click();
  await expect
    .poll(async () => {
      return (await visibleSongNames(page)).filter((name) => name !== "TrackD.wav");
    }, { timeout: 3000 })
    .toEqual(["TrackA.wav", "TrackB.wav", "TrackC.wav"]);

  // --- Multi-select add + dedupe ---
  await songRow(page, "TrackA.wav").click();
  await songRow(page, "TrackB.wav").click({ modifiers: ["ControlOrMeta"] });
  await addSelectedSongsViaContextMenu(page);
  await expect
    .poll(async () => playlistEntryNames(page), { timeout: 5000 })
    .toEqual(["TrackA.wav", "TrackB.wav"]);

  // Dedupe: add TrackA again should not grow playlist
  await songRow(page, "TrackA.wav").click();
  await addSelectedSongsViaContextMenu(page);
  await expect
    .poll(async () => playlistEntryNames(page), { timeout: 3000 })
    .toEqual(["TrackA.wav", "TrackB.wav"]);
  await expect(page.locator("#music-player-status")).toContainText("No new cached songs to add");

  // Add TrackC via dblclick (also starts playback)
  await songRow(page, "TrackC.wav").dblclick();
  await expect
    .poll(async () => playlistEntryNames(page), { timeout: 5000 })
    .toEqual(["TrackA.wav", "TrackB.wav", "TrackC.wav"]);
  await waitForCurrentPlaylistSong(page, "TrackC.wav");
  await waitForPlaying(page);

  // Nested TrackD via context add
  await songRow(page, "TrackD.wav").click();
  await addSelectedSongsViaContextMenu(page);
  await expect
    .poll(async () => playlistEntryNames(page), { timeout: 5000 })
    .toEqual(["TrackA.wav", "TrackB.wav", "TrackC.wav", "TrackD.wav"]);

  // --- Reorder: drag first handle onto last (exact drop index is pointer-sensitive) ---
  const handles = page.locator("#music-playlist-list .music-playlist-drag-handle");
  await expect(handles).toHaveCount(4);
  const orderBeforeDrag = await playlistEntryNames(page);
  await handles.nth(0).dragTo(handles.nth(3));
  await expect
    .poll(async () => playlistEntryNames(page), { timeout: 5000 })
    .not.toEqual(orderBeforeDrag);
  expect((await playlistEntryNames(page)).slice().sort()).toEqual(orderBeforeDrag.slice().sort());

  // --- Remove via context menu (dispatch avoids post-drag click suppression) ---
  await page.waitForTimeout(400);
  await page.evaluate((name) => {
    const rows = Array.from(document.querySelectorAll("#music-playlist-list .music-playlist-entry"));
    const row = rows.find((entry) => {
      const cell = entry.querySelector('[role="cell"]');
      return cell && cell.textContent.trim() === name;
    });
    if (!row) throw new Error("playlist row not found: " + name);
    const rect = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + 12,
      clientY: rect.top + 8,
      button: 2,
    }));
    const removeButton = document.querySelector("#music-playlist-context-menu [data-action=\"remove\"]");
    if (!removeButton) throw new Error("remove action missing");
    removeButton.click();
  }, "TrackD.wav");
  await expect
    .poll(async () => playlistEntryNames(page), { timeout: 5000 })
    .not.toContain("TrackD.wav");
  expect((await playlistEntryNames(page)).length).toBe(3);

  // Play from playlist dblclick
  await page
    .locator("#music-playlist-list .music-playlist-entry")
    .filter({ hasText: "TrackB.wav" })
    .dblclick();
  await waitForCurrentPlaylistSong(page, "TrackB.wav");
  await waitForPlaying(page);

  // --- Playback: pause / play / next / prev ---
  await page.locator("#music-play").click();
  await waitForPaused(page);
  await page.locator("#music-play").click();
  await waitForPlaying(page);

  await page.locator("#music-next").click();
  await waitForCurrentPlaylistSong(page, "TrackC.wav");
  await waitForPlaying(page);

  await page.locator("#music-prev").click();
  await waitForCurrentPlaylistSong(page, "TrackB.wav");

  // Volume smoke
  await page.locator("#music-volume-slider").fill("0.35");
  await expect
    .poll(async () => {
      const snap = await audioSnapshot(page);
      return snap && Math.abs(snap.volume - 0.35) < 0.02;
    }, { timeout: 3000 })
    .toBe(true);

  // Seek smoke (slider step is 1 second)
  await page.locator("#music-progress-slider").fill("1");
  await expect
    .poll(async () => {
      const snap = await audioSnapshot(page);
      return snap && snap.currentTime >= 0.8;
    }, { timeout: 5000 })
    .toBe(true);

  // Loop on: from last track in linear order, next wraps
  await page.locator("#music-loop-toggle").click();
  await expect(page.locator("#music-loop-toggle")).toHaveAttribute("aria-pressed", "true");
  // Playlist order after earlier drag/remove is non-fixed; play last row then next.
  const namesBeforeLoop = await playlistEntryNames(page);
  const lastName = namesBeforeLoop[namesBeforeLoop.length - 1];
  await page
    .locator("#music-playlist-list .music-playlist-entry")
    .filter({ hasText: lastName })
    .dblclick();
  await waitForCurrentPlaylistSong(page, lastName);
  await page.locator("#music-next").click();
  await waitForCurrentPlaylistSong(page, namesBeforeLoop[0]);
});

test("playlist save, load, rename, overwrite, delete survive reload", async ({ page }) => {
  await openMusicPlayer(page);
  await loadCompleteLibrary(page);

  await songRow(page, "TrackA.wav").dblclick();
  await expect
    .poll(async () => playlistEntryNames(page), { timeout: 5000 })
    .toEqual(["TrackA.wav"]);
  await waitForPlaying(page);

  // Rename required before first save of "New Playlist"
  await page.locator("#music-playlist-save").click();
  await expect(page.locator("#music-playlist-rename-dialog")).toBeVisible();
  await page.locator("#music-playlist-rename-input").fill("Road Trip");
  await page.locator("#music-playlist-rename-confirm").click();
  await expect(page.locator("#music-playlist-rename-dialog")).toBeHidden();
  await expect(page.locator("#music-active-playlist-name")).toHaveText("Road Trip");
  await expect(page.locator("#music-playlist-save-toast")).toBeVisible();
  await expect(page.locator("#music-playlist-save-toast-text")).toContainText('Saved "Road Trip"');

  // Add another song → dirty; save again
  await songRow(page, "TrackB.wav").click();
  await addSelectedSongsViaContextMenu(page);
  await expect
    .poll(async () => playlistEntryNames(page), { timeout: 5000 })
    .toEqual(["TrackA.wav", "TrackB.wav"]);
  await page.locator("#music-playlist-save").click();
  await expect(page.locator("#music-playlist-save-toast-text")).toContainText('Saved "Road Trip"');

  // New playlist, rename to same name, overwrite confirm
  await page.locator("#music-playlist-load").click();
  await expect(page.locator("#music-playlist-load-dialog")).toBeVisible();
  await expect(page.locator("#music-playlist-load")).toHaveText("Load Playlist: Songs");
  await expect(page.locator("#music-playlist-load-title")).toHaveText("Load Playlist: Songs");
  await page.locator("#music-playlist-load-new").click();
  // Dirty discard may prompt overwrite-style confirm
  const discardDialog = page.locator("#music-playlist-overwrite-dialog");
  if (await discardDialog.isVisible().catch(() => false)) {
    await page.locator("#music-playlist-overwrite-confirm").click();
  }
  await expect(page.locator("#music-playlist-load-dialog")).toBeHidden();
  await expect(page.locator("#music-active-playlist-name")).toHaveText("New Playlist");
  await expect
    .poll(async () => playlistEntryNames(page), { timeout: 3000 })
    .toEqual([]);

  await songRow(page, "TrackC.wav").dblclick();
  await page.locator("#music-playlist-rename").click();
  await expect(page.locator("#music-playlist-rename-dialog")).toBeVisible();
  await page.locator("#music-playlist-rename-input").fill("Road Trip");
  await page.locator("#music-playlist-rename-confirm").click();
  // Overwrite existing saved name
  await expect(page.locator("#music-playlist-overwrite-dialog")).toBeVisible();
  await page.locator("#music-playlist-overwrite-confirm").click();
  await expect(page.locator("#music-active-playlist-name")).toHaveText("Road Trip");
  await expect
    .poll(async () => playlistEntryNames(page), { timeout: 5000 })
    .toEqual(["TrackC.wav"]);

  // Reload page; load saved playlist from storage
  await page.reload();
  await openMusicPlayer(page);
  await page.locator("#music-playlist-load").click();
  await expect(page.locator("#music-playlist-load-dialog")).toBeVisible();
  const loadRow = page
    .locator("#music-playlist-load-list .music-playlist-load-entry")
    .filter({ hasText: "Road Trip" })
    .first();
  await expect(loadRow).toBeVisible();
  await loadRow.click();
  await page.locator("#music-playlist-load-confirm").click();
  await expect(page.locator("#music-playlist-load-dialog")).toBeHidden();
  await expect(page.locator("#music-active-playlist-name")).toHaveText("Road Trip");
  await expect
    .poll(async () => playlistEntryNames(page), { timeout: 5000 })
    .toEqual(["TrackC.wav"]);

  // Delete via load dialog context menu
  await page.locator("#music-playlist-load").click();
  await expect(page.locator("#music-playlist-load-dialog")).toBeVisible();
  const deleteTarget = page
    .locator("#music-playlist-load-list .music-playlist-load-entry")
    .filter({ hasText: "Road Trip" })
    .first();
  await deleteTarget.click({ button: "right" });
  const loadMenu = page.locator("#music-playlist-load-context-menu");
  await expect(loadMenu).toBeVisible();
  await loadMenu.locator(".music-context-menu-group").filter({ hasText: "Playlist" }).hover();
  await loadMenu.locator('[data-action="delete"]').click();
  await expect
    .poll(async () => {
      return page.locator("#music-playlist-load-list .music-playlist-load-entry").count();
    }, { timeout: 5000 })
    .toBe(0);
  await page.locator("#music-playlist-load-cancel").click();
});

test("playlist m3u import and json export", async ({ page }) => {
  await openMusicPlayer(page);
  await loadCompleteLibrary(page);

  // Seed one saved playlist so export has content after m3u import as well
  await songRow(page, "TrackA.wav").dblclick();
  await page.locator("#music-playlist-save").click();
  await page.locator("#music-playlist-rename-input").fill("Seed Export");
  await page.locator("#music-playlist-rename-confirm").click();
  await expect(page.locator("#music-active-playlist-name")).toHaveText("Seed Export");

  const m3uPath = path.join(os.tmpdir(), `music-player-e2e-${Date.now()}.m3u8`);
  fs.writeFileSync(
    m3uPath,
    [
      "#EXTM3U",
      "music/TrackB.wav",
      "music/TrackC.wav",
      "",
    ].join("\n"),
    "utf8",
  );

  await page.locator("#music-playlist-import-input").setInputFiles(m3uPath);
  await expect
    .poll(async () => page.locator("#music-player-status").innerText(), { timeout: 5000 })
    .toMatch(/Imported/i);

  await page.locator("#music-playlist-load").click();
  await expect(page.locator("#music-playlist-load-dialog")).toBeVisible();
  const imported = page
    .locator("#music-playlist-load-list .music-playlist-load-entry")
    .filter({ hasText: "music-player-e2e" });
  // Name derived from filename without extension
  await expect(
    page.locator("#music-playlist-load-list .music-playlist-load-entry").filter({
      hasText: path.basename(m3uPath, path.extname(m3uPath)),
    }),
  ).toBeVisible({ timeout: 5000 });
  await expect(
    page.locator("#music-playlist-load-list .music-playlist-load-entry").filter({
      hasText: path.basename(m3uPath, path.extname(m3uPath)),
    }).locator(".music-playlist-load-song-count"),
  ).toHaveText("2 songs");

  // Load imported playlist
  await page
    .locator("#music-playlist-load-list .music-playlist-load-entry")
    .filter({ hasText: path.basename(m3uPath, path.extname(m3uPath)) })
    .click();
  await page.locator("#music-playlist-load-confirm").click();
  await expect
    .poll(async () => playlistEntryNames(page), { timeout: 5000 })
    .toEqual(["TrackB.wav", "TrackC.wav"]);

  const downloadPromise = page.waitForEvent("download", { timeout: 10000 });
  await page.locator("#music-playlist-export").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("dropbox_browser_music_playlists.json");
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();
  const exported = JSON.parse(fs.readFileSync(downloadPath, "utf8"));
  expect(exported.version).toBe(1);
  expect(Array.isArray(exported.playlists)).toBe(true);
  expect(exported.playlists.length).toBeGreaterThanOrEqual(2);
  const names = exported.playlists.map((playlist) => playlist.name);
  expect(names).toContain("Seed Export");
  expect(names).toContain(path.basename(m3uPath, path.extname(m3uPath)));

  try {
    fs.unlinkSync(m3uPath);
  } catch (_error) {
    // temp cleanup best-effort
  }
});

test("library selection, playlist context play, and shuffle next is non-sequential", async ({ page }) => {
  await openMusicPlayer(page);
  await clearMusicSettings(page);
  await page.reload();
  await openMusicPlayer(page);
  await loadCompleteLibrary(page);
  await expandFolder(page, "Side");

  // Shift-range select TrackA..TrackC among root songs
  await songRow(page, "TrackA.wav").click();
  await songRow(page, "TrackC.wav").click({ modifiers: ["Shift"] });
  await expect
    .poll(async () => selectedLibrarySongNames(page), { timeout: 3000 })
    .toEqual(["TrackA.wav", "TrackB.wav", "TrackC.wav"]);

  // With a selection already active, Ctrl/Cmd+A expands to same-parent siblings
  // (root songs + Side folder), not nested Side children like TrackD.
  await page.locator("#music-library-tree").focus();
  await page.keyboard.press("ControlOrMeta+A");
  await expect
    .poll(async () => selectedLibrarySongNames(page), { timeout: 3000 })
    .toEqual(["TrackA.wav", "TrackB.wav", "TrackC.wav"]);
  await expect(folderRow(page, "Side")).toHaveAttribute("aria-selected", "true");

  // Build a 4-song playlist for shuffle/context-play coverage
  await songRow(page, "TrackA.wav").click();
  await songRow(page, "TrackB.wav").click({ modifiers: ["ControlOrMeta"] });
  await songRow(page, "TrackC.wav").click({ modifiers: ["ControlOrMeta"] });
  await songRow(page, "TrackD.wav").click({ modifiers: ["ControlOrMeta"] });
  await addSelectedSongsViaContextMenu(page);
  await expect
    .poll(async () => playlistEntryNames(page), { timeout: 5000 })
    .toEqual(["TrackA.wav", "TrackB.wav", "TrackC.wav", "TrackD.wav"]);

  // Playlist Ctrl/Cmd+A select-all
  await page.locator("#music-playlist-list").focus();
  await page.keyboard.press("ControlOrMeta+A");
  await expect
    .poll(async () => selectedPlaylistEntryNames(page), { timeout: 3000 })
    .toEqual(["TrackA.wav", "TrackB.wav", "TrackC.wav", "TrackD.wav"]);

  // Context menu Play (not dblclick)
  await playlistContextAction(page, "TrackC.wav", "play");
  await waitForCurrentPlaylistSong(page, "TrackC.wav");
  await waitForPlaying(page);

  // Deterministic shuffle: Math.random = 0.5 yields next index 3 from current 0 after rebuild;
  // from current TrackC (index 2), pin 2 and next is not index 3 sequential TrackD if sequence is non-linear.
  // Safer: play TrackA (index 0), enable shuffle with random 0.5 → next must not be TrackB.
  await page.evaluate(() => {
    Math.random = () => 0.5;
  });
  await playlistContextAction(page, "TrackA.wav", "play");
  await waitForCurrentPlaylistSong(page, "TrackA.wav");
  if ((await page.locator("#music-shuffle-toggle").getAttribute("aria-pressed")) !== "true") {
    await page.locator("#music-shuffle-toggle").click();
  }
  await expect(page.locator("#music-shuffle-toggle")).toHaveAttribute("aria-pressed", "true");
  await page.locator("#music-next").click();
  await expect
    .poll(async () => {
      const current = page.locator("#music-playlist-list .music-playlist-entry.current");
      if ((await current.count()) === 0) return "";
      return (await current.locator('[role="cell"]').first().innerText()).trim();
    }, { timeout: 5000 })
    .not.toBe("TrackB.wav");
  const shuffledNext = await page
    .locator("#music-playlist-list .music-playlist-entry.current [role='cell']")
    .first()
    .innerText();
  expect(["TrackA.wav", "TrackB.wav", "TrackC.wav", "TrackD.wav"]).toContain(shuffledNext.trim());
});

test("waveform visualization survives multiple playlist next and previous songs", async ({ page }) => {
  await openMusicPlayer(page);
  await clearMusicSettings(page);
  await page.reload();
  await openMusicPlayer(page);
  await loadCompleteLibrary(page);

  const requests = [];
  page.on("request", (request) => requests.push(request));

  await songRow(page, "TrackA.wav").dblclick();
  await waitForCurrentPlaylistSong(page, "TrackA.wav");
  await waitForPlaying(page);
  await songRow(page, "TrackB.wav").click();
  await addSelectedSongsViaContextMenu(page);
  await expect.poll(async () => playlistEntryNames(page), { timeout: 3000 })
    .toEqual(["TrackA.wav", "TrackB.wav"]);

  const panel = page.locator("#music-waveform-panel");
  await expect.poll(() => panel.evaluate((element) => element.open)).toBe(false);
  const requestsBeforeVisualization = waveformFetchRequests(requests).length;
  expect(requestsBeforeVisualization).toBe(0);

  await startWaveformStatusHistory(page);
  await panel.locator("summary").click();
  await expect.poll(async () => page.locator("#music-waveform-status").innerText(), { timeout: 10000 })
    .toMatch(/Audio visualization ready at \d+ samples\./);
  await expect.poll(() => waveformCanvasSnapshot(page), { timeout: 5000 })
    .toMatchObject({ width: expect.any(Number), height: expect.any(Number) });
  const firstSongCanvas = await waveformCanvasSnapshot(page);
  expect(firstSongCanvas.nonBackgroundPixels).toBeGreaterThan(20);
  const statusHistory = await page.evaluate(() => window.__musicWaveformStatusHistory || []);
  expect(statusHistory.some((text) => /Pulling audio data for visualization\./.test(text))).toBe(true);
  expect(statusHistory.some((text) => /sample round \d+\/\d+: \d+ of \d+ samples completed\./.test(text))).toBe(true);
  expect(waveformFetchRequests(requests)).toHaveLength(1);
  await resetAudioPosition(page);
  const firstSongAtStart = await waveformCanvasSnapshot(page);

  await page.locator("#music-next").click();
  await waitForCurrentPlaylistSong(page, "TrackB.wav");
  await waitForPlaying(page);
  await expect.poll(() => waveformFetchRequests(requests).length, { timeout: 10000 }).toBe(2);
  await expect.poll(async () => page.locator("#music-waveform-status").innerText(), { timeout: 10000 })
    .toMatch(/Audio visualization ready at \d+ samples\./);
  await resetAudioPosition(page);
  const secondSongCanvas = await waveformCanvasSnapshot(page);
  expect(secondSongCanvas.nonBackgroundPixels).toBeGreaterThan(20);
  expect(secondSongCanvas.hash).not.toBe(firstSongAtStart.hash);
  expect(waveformFetchRequests(requests)).toHaveLength(2);

  await page.locator("#music-prev").click();
  await waitForCurrentPlaylistSong(page, "TrackA.wav");
  await waitForPlaying(page);
  await expect.poll(async () => page.locator("#music-waveform-status").innerText(), { timeout: 10000 })
    .toMatch(/Audio visualization loaded from cache at \d+ samples\./);
  await resetAudioPosition(page);
  const firstSongAfterPrevious = await waveformCanvasSnapshot(page);
  expect(firstSongAfterPrevious.nonBackgroundPixels).toBeGreaterThan(20);
  expect(firstSongAfterPrevious.hash).toBe(firstSongAtStart.hash);
  expect(waveformFetchRequests(requests)).toHaveLength(2);

  await page.locator("#music-play").click();
  await waitForPlaying(page);
  await page.locator("#music-waveform-reload").click();
  await expect.poll(() => waveformFetchRequests(requests).length, { timeout: 10000 }).toBe(3);
  await expect.poll(async () => page.locator("#music-waveform-status").innerText(), { timeout: 10000 })
    .toMatch(/Audio visualization ready at \d+ samples\./);
  const finalStatusHistory = await page.evaluate(() => window.__musicWaveformStatusHistory || []);
  expect(finalStatusHistory.some((text) => /Waiting for audio data to load for visualization\./.test(text))).toBe(true);
  await expect(page.locator("#music-waveform-reload")).toBeVisible();
});

test("overwrite and discard cancel keep prior playlist state", async ({ page }) => {
  await openMusicPlayer(page);
  await clearMusicSettings(page);
  await page.reload();
  await openMusicPlayer(page);
  await loadCompleteLibrary(page);

  await songRow(page, "TrackA.wav").dblclick();
  await page.locator("#music-playlist-save").click();
  await page.locator("#music-playlist-rename-input").fill("Keep Me");
  await page.locator("#music-playlist-rename-confirm").click();
  await expect(page.locator("#music-active-playlist-name")).toHaveText("Keep Me");
  await expect
    .poll(async () => playlistEntryNames(page), { timeout: 3000 })
    .toEqual(["TrackA.wav"]);

  // Dirty: add TrackB, attempt New Playlist, cancel discard
  await songRow(page, "TrackB.wav").click();
  await addSelectedSongsViaContextMenu(page);
  await expect
    .poll(async () => playlistEntryNames(page), { timeout: 3000 })
    .toEqual(["TrackA.wav", "TrackB.wav"]);
  await page.locator("#music-playlist-load").click();
  await expect(page.locator("#music-playlist-load-dialog")).toBeVisible();
  await page.locator("#music-playlist-load-new").click();
  await expect(page.locator("#music-playlist-overwrite-dialog")).toBeVisible();
  await page.locator("#music-playlist-overwrite-cancel").click();
  await expect(page.locator("#music-playlist-overwrite-dialog")).toBeHidden();
  // Cancel leaves load dialog open or closes without applying new — either way active playlist stays dirty.
  await expect(page.locator("#music-active-playlist-name")).toHaveText("Keep Me");
  await expect
    .poll(async () => playlistEntryNames(page), { timeout: 3000 })
    .toEqual(["TrackA.wav", "TrackB.wav"]);
  if (await page.locator("#music-playlist-load-dialog").isVisible()) {
    await page.locator("#music-playlist-load-cancel").click();
  }

  // Save dirty state, then start new clean playlist and attempt overwrite-by-name cancel
  await page.locator("#music-playlist-save").click();
  await page.locator("#music-playlist-load").click();
  await page.locator("#music-playlist-load-new").click();
  await expect(page.locator("#music-active-playlist-name")).toHaveText("New Playlist");
  await songRow(page, "TrackC.wav").dblclick();
  await page.locator("#music-playlist-rename").click();
  await page.locator("#music-playlist-rename-input").fill("Keep Me");
  await page.locator("#music-playlist-rename-confirm").click();
  await expect(page.locator("#music-playlist-overwrite-dialog")).toBeVisible();
  await page.locator("#music-playlist-overwrite-cancel").click();
  await expect(page.locator("#music-playlist-overwrite-dialog")).toBeHidden();
  // Overwrite cancel must not rename/save over the stored playlist.
  await expect(page.locator("#music-active-playlist-name")).toHaveText("New Playlist");
  await expect
    .poll(async () => playlistEntryNames(page), { timeout: 3000 })
    .toEqual(["TrackC.wav"]);

  // Load saved "Keep Me" and prove stored content was not replaced by TrackC-only overwrite.
  await page.locator("#music-playlist-load").click();
  await expect(page.locator("#music-playlist-load-dialog")).toBeVisible();
  const loadRow = page
    .locator("#music-playlist-load-list .music-playlist-load-entry")
    .filter({ hasText: "Keep Me" })
    .first();
  await loadRow.click();
  await page.locator("#music-playlist-load-confirm").click();
  if (await page.locator("#music-playlist-overwrite-dialog").isVisible().catch(() => false)) {
    await page.locator("#music-playlist-overwrite-confirm").click();
  }
  await expect(page.locator("#music-active-playlist-name")).toHaveText("Keep Me");
  await expect
    .poll(async () => playlistEntryNames(page), { timeout: 5000 })
    .toEqual(["TrackA.wav", "TrackB.wav"]);
});

test("json import and music settings survive reload", async ({ page }) => {
  await openMusicPlayer(page);
  await clearMusicSettings(page);
  await page.reload();
  await openMusicPlayer(page);
  await loadCompleteLibrary(page);

  // JSON import (export covered by earlier test)
  const jsonPath = path.join(os.tmpdir(), `music-player-e2e-${Date.now()}.json`);
  fs.writeFileSync(
    jsonPath,
    JSON.stringify({
      version: 1,
      exported_at: 100,
      playlists: [
        {
          name: "Alpha List",
          last_modified: 10,
          songs: ["music/TrackA.wav"],
        },
        {
          name: "Zeta List",
          last_modified: 99,
          songs: ["music/TrackA.wav", "music/TrackD.wav"],
        },
      ],
    }),
    "utf8",
  );
  await page.locator("#music-playlist-import-input").setInputFiles(jsonPath);
  await expect
    .poll(async () => page.locator("#music-player-status").innerText(), { timeout: 5000 })
    .toMatch(/Merged playlist JSON|Imported/i);

  // Load-dialog sort UI: name asc vs last_modified desc
  await page.locator("#music-playlist-load").click();
  await expect(page.locator("#music-playlist-load-dialog")).toBeVisible();
  await page.locator("#music-playlist-load-filter-input").fill("");
  await page.locator('#music-playlist-load-dialog [data-playlist-sort-key="name"]').click();
  await expect(page.locator('#music-playlist-load-dialog [data-playlist-sort-key="name"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect
    .poll(async () => {
      return page.locator("#music-playlist-load-list .music-playlist-load-entry").allTextContents();
    }, { timeout: 3000 })
    .toEqual(expect.arrayContaining([
      expect.stringContaining("Alpha List"),
      expect.stringContaining("Zeta List"),
    ]));
  // Name ascending: Alpha before Zeta in list order
  await expect
    .poll(async () => {
      const texts = await page.locator("#music-playlist-load-list .music-playlist-load-entry").allTextContents();
      const alpha = texts.findIndex((text) => text.includes("Alpha List"));
      const zeta = texts.findIndex((text) => text.includes("Zeta List"));
      return alpha >= 0 && zeta >= 0 ? alpha < zeta : false;
    }, { timeout: 3000 })
    .toBe(true);

  await page.locator('#music-playlist-load-dialog [data-playlist-sort-key="last_modified"]').click();
  await expect(page.locator('#music-playlist-load-dialog [data-playlist-sort-key="last_modified"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // last_modified default direction is desc: Zeta (99) before Alpha (10)
  await expect
    .poll(async () => {
      const texts = await page.locator("#music-playlist-load-list .music-playlist-load-entry").allTextContents();
      const alpha = texts.findIndex((text) => text.includes("Alpha List"));
      const zeta = texts.findIndex((text) => text.includes("Zeta List"));
      return alpha >= 0 && zeta >= 0 ? zeta < alpha : false;
    }, { timeout: 3000 })
    .toBe(true);

  await page
    .locator("#music-playlist-load-list .music-playlist-load-entry")
    .filter({ hasText: "Zeta List" })
    .click();
  await page.locator("#music-playlist-load-confirm").click();
  await expect
    .poll(async () => playlistEntryNames(page), { timeout: 5000 })
    .toEqual(["TrackA.wav", "TrackD.wav"]);

  // Change library sort + widths/panes; toggle volume/shuffle/loop via UI so host persist runs
  await page.locator('#music-library-pane [data-library-sort-key="date"]').click();
  await expect(page.locator('#music-library-pane [data-library-sort-key="date"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.evaluate(() => {
    Settings.set("music-playlist-column-widths", { filename: 180, path: 300, reorder: 56 });
    Settings.set("music-pane-widths", [30, 45, 25]);
    Settings.set("music-playlist-load-filter", "Zeta");
  });
  await page.locator("#music-volume-slider").fill("0.4");
  await page.locator("#music-shuffle-toggle").click();
  await page.locator("#music-loop-toggle").click();
  await expect(page.locator("#music-shuffle-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#music-loop-toggle")).toHaveAttribute("aria-pressed", "true");

  await expect
    .poll(async () => readSettingsKey(page, "music-library-sort"), { timeout: 3000 })
    .toMatchObject({ key: "date", direction: "desc" });
  await expect
    .poll(async () => readSettingsKey(page, "music-volume"), { timeout: 3000 })
    .toBeCloseTo(0.4, 2);
  await expect
    .poll(async () => readSettingsKey(page, "music-shuffle-enabled"), { timeout: 3000 })
    .toBe(true);
  await expect
    .poll(async () => readSettingsKey(page, "music-loop-playlist"), { timeout: 3000 })
    .toBe(true);

  await page.reload();
  await openMusicPlayer(page);

  // Sort / widths / playback mode settings restored
  await expect(page.locator('#music-library-pane [data-library-sort-key="date"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator("#music-shuffle-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#music-loop-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(async () => {
      const snap = await audioSnapshot(page);
      return snap && Math.abs(snap.volume - 0.4) < 0.02;
    }, { timeout: 3000 })
    .toBe(true);
  await expect
    .poll(async () => readSettingsKey(page, "music-library-sort"), { timeout: 3000 })
    .toMatchObject({ key: "date", direction: "desc" });
  await expect
    .poll(async () => readSettingsKey(page, "music-playlist-column-widths"), { timeout: 3000 })
    .toMatchObject({ filename: 180, path: 300, reorder: 56 });
  await expect
    .poll(async () => readSettingsKey(page, "music-pane-widths"), { timeout: 3000 })
    .toEqual([30, 45, 25]);
  await expect
    .poll(async () => readSettingsKey(page, "music-volume"), { timeout: 3000 })
    .toBeCloseTo(0.4, 2);
  await expect
    .poll(async () => readSettingsKey(page, "music-shuffle-enabled"), { timeout: 3000 })
    .toBe(true);
  await expect
    .poll(async () => readSettingsKey(page, "music-loop-playlist"), { timeout: 3000 })
    .toBe(true);

  // Column widths applied to CSS custom property on playlist table
  await expect
    .poll(async () => {
      return page.evaluate(() => {
        const table = document.getElementById("music-playlist-table");
        return table ? getComputedStyle(table).getPropertyValue("--music-playlist-grid-columns").trim() : "";
      });
    }, { timeout: 5000 })
    .toMatch(/180px|minmax\(180px/);

  // Load-dialog filter restored; sort UI still reflects last clicked last_modified
  await page.locator("#music-playlist-load").click();
  await expect(page.locator("#music-playlist-load-filter-input")).toHaveValue("Zeta");
  await expect(
    page.locator("#music-playlist-load-list .music-playlist-load-entry").filter({ hasText: "Zeta List" }),
  ).toBeVisible();
  await page.locator("#music-playlist-load-cancel").click();

  try {
    fs.unlinkSync(jsonPath);
  } catch (_error) {
    // best-effort cleanup
  }
});
