const path = require("path");
const { test, expect } = require("@playwright/test");

process.env.PLAYWRIGHT_PORT = "8011";
process.env.DROPBOX_BROWSER_E2E_FIXTURE = path.join(__dirname, "fixtures", "music-library-deep.json");

const { baseURL, startIntegrationServer, stopIntegrationServer } = require("./support/integration_server");

let server = null;

function parseLibraryStatusCounts(text) {
  const finalMatch = /Loaded (\d+) songs? and (\d+) folders?\./.exec(text);
  if (finalMatch) {
    return {
      songCount: Number(finalMatch[1]),
      folderCount: Number(finalMatch[2]),
      complete: true,
      text,
    };
  }
  const partialMatch = /Totals: (\d+) songs?, (\d+) folders?\./.exec(text);
  if (partialMatch) {
    return {
      songCount: Number(partialMatch[1]),
      folderCount: Number(partialMatch[2]),
      complete: false,
      text,
    };
  }
  return null;
}

async function fetchJson(request, relativePath) {
  const response = await request.get(`${baseURL}${relativePath}`);
  await expect(response).toBeOK();
  return response.json();
}

async function releaseGate(request, name) {
  const response = await request.post(`${baseURL}/__integration/release-gate`, {
    form: { name },
  });
  await expect(response).toBeOK();
}

async function releaseGateAndWaitForCheckpoint({ request, page, gateName, checkpoint, libraryRequestCountRef }) {
  const requestsBeforeRelease = libraryRequestCountRef();
  await releaseGate(request, gateName);
  await expect.poll(() => libraryRequestCountRef(), { timeout: 3000 }).toBeGreaterThan(requestsBeforeRelease);
  await waitForLibraryCounts(page, checkpoint);
}

async function waitForLibraryCounts(page, checkpoint) {
  await expect
    .poll(async () => {
      const text = await page.locator("#music-library-status").innerText();
      const counts = parseLibraryStatusCounts(text);
      if (!counts) return null;
      return {
        folderCount: counts.folderCount,
        songCount: counts.songCount,
        complete: counts.complete,
        text: counts.text,
      };
    }, { timeout: 5000 })
    .toEqual({
      folderCount: checkpoint.folder_count,
      songCount: checkpoint.song_count,
      complete: checkpoint.pending_folders.length === 0,
      text: expect.any(String),
    });
}

async function currentLibraryCounts(page) {
  const text = await page.locator("#music-library-status").innerText();
  return parseLibraryStatusCounts(text);
}

async function expandFolder(page, name) {
  const row = page
    .locator("#music-library-tree .music-tree-row[data-node-kind='folder']")
    .filter({ has: page.locator(".music-tree-name", { hasText: name }) })
    .first();
  await expect(row).toBeVisible();
  if ((await row.getAttribute("aria-expanded")) === "false") {
    await row.locator(".music-tree-toggle").click();
  }
}

test.use({ baseURL });

test.beforeAll(async () => {
  server = await startIntegrationServer();
});

test.afterAll(async () => {
  await stopIntegrationServer(server);
  server = null;
});

test("music player library grows from staged background cache work", async ({ page, request }) => {
  test.setTimeout(15000);

  const integrationMeta = await fetchJson(request, "/__integration/checkpoints");
  const integrationBootStatus = await fetchJson(request, "/__integration/status");
  const pollDelayMs = Number(integrationBootStatus.music_library_poll_delay_ms || 150);
  // First Load uses poll_delay_ms=0; allow poll-interval-scale slack for Playwright + parallel e2e workers.
  const maxInitialLoadMs = Math.max(750, pollDelayMs * 4 + 300);
  const checkpoints = integrationMeta.music_library_checkpoints;
  const gateNames = integrationMeta.integration_gates.map((gate) => gate.name);
  expect(checkpoints).toEqual({
    initial_partial: {
      folder_count: 7,
      song_count: 13,
      pending_folders: [
        "Blue Sky Sessions",
        "Live at River Hall/Encore",
        "Midnight FM/Instrumentals",
      ],
    },
    after_blue_listing: {
      folder_count: 9,
      song_count: 14,
      pending_folders: [
        "Blue Sky Sessions/Disc 1",
        "Blue Sky Sessions/Disc 2",
        "Live at River Hall/Encore",
        "Midnight FM/Instrumentals",
      ],
    },
    after_first_growth: {
      folder_count: 9,
      song_count: 20,
      pending_folders: [
        "Blue Sky Sessions/Disc 2",
        "Midnight FM/Instrumentals",
      ],
    },
    final_complete: {
      folder_count: 9,
      song_count: 26,
      pending_folders: [],
    },
  });
  expect(gateNames).toEqual([
    "release-blue-listing",
    "release-first-growth",
    "release-final-growth",
  ]);

  let libraryRequestCount = 0;
  page.on("request", (req) => {
    if (req.url().includes("/music/endpoints/library?")) libraryRequestCount += 1;
  });

  await page.goto("/?path=music");
  await expect(page).toHaveTitle(/SDB: music \(dropbox:music\)/);

  await expect(page.locator('tr[data-folder-path="music/Blue Sky Sessions"] .col-size')).toContainText("calculating");

  await page.selectOption("#bottom-pane-mode", "music-player");
  await expect(page.locator("#music-player-pane")).toBeVisible();

  const loadStartMs = Date.now();
  await page.getByRole("button", { name: "Load Current Folder" }).click();
  await waitForLibraryCounts(page, checkpoints.initial_partial);
  const initialElapsedMs = Date.now() - loadStartMs;
  expect(initialElapsedMs).toBeLessThan(maxInitialLoadMs);

  const traceAfterInitial = await fetchJson(request, "/__integration/trace");
  const firstLibraryPoll = traceAfterInitial.events.find((event) => event.event === "music_library_poll");
  expect(firstLibraryPoll).toBeTruthy();
  expect(String(firstLibraryPoll.client_poll_delay_ms)).toBe("0");
  expect(firstLibraryPoll.elapsed_ms).toBeLessThan(150);

  const initialStatusText = await page.locator("#music-library-status").innerText();
  expect(initialStatusText).toContain("Remaining:");
  await expect(
    page
      .locator("#music-library-tree .music-tree-row[data-node-kind='folder']")
      .filter({ has: page.locator(".music-tree-name", { hasText: "Blue Sky Sessions" }) })
      .locator(".music-tree-badge")
  ).toHaveText("not cached");
  await expect(page.locator('tr[data-folder-path="music/Blue Sky Sessions"] .col-size')).toContainText("calculating");

  await releaseGateAndWaitForCheckpoint({
    request,
    page,
    gateName: "release-blue-listing",
    checkpoint: checkpoints.after_blue_listing,
    libraryRequestCountRef: () => libraryRequestCount,
  });
  await expandFolder(page, "Blue Sky Sessions");
  await expect(page.getByText("00 - Overture.mp3", { exact: true })).toBeVisible();

  await releaseGateAndWaitForCheckpoint({
    request,
    page,
    gateName: "release-first-growth",
    checkpoint: checkpoints.after_first_growth,
    libraryRequestCountRef: () => libraryRequestCount,
  });
  await expect
    .poll(async () => await page.locator('tr[data-folder-path="music/Live at River Hall"] .col-size').innerText(), { timeout: 3000 })
    .not.toContain("calculating");
  await expandFolder(page, "Live at River Hall");
  await expandFolder(page, "Encore");
  await expect(page.getByText("01 - Night Walk.aac", { exact: true })).toBeVisible();

  await releaseGateAndWaitForCheckpoint({
    request,
    page,
    gateName: "release-final-growth",
    checkpoint: checkpoints.final_complete,
    libraryRequestCountRef: () => libraryRequestCount,
  });

  const finalCounts = await currentLibraryCounts(page);
  expect(finalCounts).not.toBeNull();
  expect(finalCounts.complete).toBe(true);
  await expect(page.locator("#music-library-status")).toContainText("Loaded 26 songs and 9 folders.");
  await expect(page.getByRole("button", { name: "Load Current Folder" })).toBeEnabled();

  await expandFolder(page, "Disc 2");
  await expandFolder(page, "Midnight FM");
  await expandFolder(page, "Instrumentals");
  await expect(page.getByText("04 - Skylane Reprise.wav", { exact: true })).toBeVisible();
  await expect(page.getByText("02 - Tower Lights.wav", { exact: true })).toBeVisible();

  const completedPollCount = libraryRequestCount;
  await page.waitForTimeout(500);
  expect(libraryRequestCount).toBe(completedPollCount);

  const finalLibraryPayload = await fetchJson(request, "/music/endpoints/library?path=music");
  expect(finalLibraryPayload.status.cache_status).toBe("complete");
  expect(finalLibraryPayload.status.complete).toBe(true);
  expect(finalLibraryPayload.status.pending).toBe(false);
  expect(finalLibraryPayload.folders).toHaveLength(checkpoints.final_complete.folder_count);
  expect(finalLibraryPayload.songs).toHaveLength(checkpoints.final_complete.song_count);
  expect(finalLibraryPayload.songs.some((song) => song.rel_path === "Blue Sky Sessions/Disc 2/04 - Skylane Reprise.wav")).toBe(true);
  expect(finalLibraryPayload.songs.some((song) => song.rel_path === "Midnight FM/Instrumentals/02 - Tower Lights.wav")).toBe(true);

  const integrationStatus = await fetchJson(request, "/__integration/status");
  expect(integrationStatus.using_fake_rclone).toBe(true);
  expect(integrationStatus.rclone_adapter).toBe("in-process-simulated");
  expect(integrationStatus.call_count).toBeGreaterThan(0);

  const tracePayload = await fetchJson(request, "/__integration/trace");
  const musicPollEvents = tracePayload.events.filter((event) => event.event === "music_library_poll");
  expect(musicPollEvents.length).toBeGreaterThan(0);
  expect(musicPollEvents.some((event) => event.complete === true && event.song_count === 26 && event.folder_count === 9)).toBe(true);
  const subtreeCompletePaths = new Set(
    tracePayload.events
      .filter((event) => event.event === "subtree_complete")
      .map((event) => event.remote_path)
  );
  expect(subtreeCompletePaths.has("dropbox:music/Blue Sky Sessions/Disc 1")).toBe(true);
  expect(subtreeCompletePaths.has("dropbox:music/Blue Sky Sessions/Disc 2")).toBe(true);
  expect(subtreeCompletePaths.has("dropbox:music/Live at River Hall/Encore")).toBe(true);
  expect(subtreeCompletePaths.has("dropbox:music/Midnight FM/Instrumentals")).toBe(true);

  const callPayload = await fetchJson(request, "/__integration/calls");
  expect(callPayload.calls.length).toBeGreaterThan(0);
  expect(callPayload.calls.some((call) => call.target === "dropbox:music/Blue Sky Sessions")).toBe(true);
  expect(callPayload.calls.some((call) => call.target === "dropbox:music/Blue Sky Sessions/Disc 2")).toBe(true);
  expect(callPayload.calls.some((call) => call.target === "dropbox:music/Midnight FM/Instrumentals")).toBe(true);
  expect(callPayload.calls.every((call) => Array.isArray(call.args) && !call.args.some((arg) => String(arg).toLowerCase().includes("rclone.exe")))).toBe(true);
});
