const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  let source = await fs.readFile(absolutePath, "utf8");
  if (relativePath.endsWith("music-playlist.js")) {
    const sharedPath = path.resolve(path.dirname(absolutePath), "music-shared.js");
    const sharedSource = await fs.readFile(sharedPath, "utf8");
    const sharedUrl = `data:text/javascript;base64,${Buffer.from(sharedSource, "utf8").toString("base64")}`;
    const storePath = path.resolve(path.dirname(absolutePath), "music-playlist-store.js");
    const storeSource = await fs.readFile(storePath, "utf8");
    const storeUrl = `data:text/javascript;base64,${Buffer.from(storeSource, "utf8").toString("base64")}`;
    source = source.replace("'./music-shared.js'", `'${sharedUrl}'`);
    source = source.replace("'./music-playlist-store.js'", `'${storeUrl}'`);
  }
  return import(`data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`);
}

function song(remotePath) {
  return {
    remote_path: remotePath,
    display_name: remotePath.split("/").pop(),
    stream_path: remotePath,
  };
}

test("draggedPlaylistBlockRemotePaths keeps multi-selection order from the playlist", async () => {
  const playlistModule = await importModuleFromWorkspace("dropbox_browser/assets/js/music-playlist.js");
  const playlist = [
    song("music/alpha.mp3"),
    song("music/bravo.mp3"),
    song("music/charlie.mp3"),
    song("music/delta.mp3"),
  ];
  const selectedRemotePaths = {
    "music/alpha.mp3": true,
    "music/charlie.mp3": true,
    "music/delta.mp3": true,
  };

  assert.deepEqual(
    playlistModule.draggedPlaylistBlockRemotePaths(playlist, selectedRemotePaths, "music/delta.mp3"),
    ["music/alpha.mp3", "music/charlie.mp3", "music/delta.mp3"],
  );
});

test("reorderPlaylistBlock moves the selected songs as one sequential block and keeps the current song", async () => {
  const playlistModule = await importModuleFromWorkspace("dropbox_browser/assets/js/music-playlist.js");
  const playlist = [
    song("music/alpha.mp3"),
    song("music/bravo.mp3"),
    song("music/charlie.mp3"),
    song("music/delta.mp3"),
    song("music/echo.mp3"),
  ];
  const selectedRemotePaths = {
    "music/bravo.mp3": true,
    "music/delta.mp3": true,
  };

  const result = playlistModule.reorderPlaylistBlock(
    playlist,
    selectedRemotePaths,
    "music/delta.mp3",
    "music/echo.mp3",
    true,
    2,
  );

  assert.equal(result.moved, true);
  assert.deepEqual(
    result.playlist.map((entry) => entry.remote_path),
    [
      "music/alpha.mp3",
      "music/charlie.mp3",
      "music/echo.mp3",
      "music/bravo.mp3",
      "music/delta.mp3",
    ],
  );
  assert.equal(result.currentPlaylistIndex, 1);
  assert.deepEqual(
    Object.keys(result.selectedRemotePaths).sort(),
    ["music/bravo.mp3", "music/delta.mp3"],
  );
});

test("playlistAutoScrollDeltaForBounds only requests scrolling near list edges", async () => {
  const playlistModule = await importModuleFromWorkspace("dropbox_browser/assets/js/music-playlist.js");

  assert.equal(playlistModule.playlistAutoScrollDeltaForBounds(160, 100, 300), 0);
  assert.ok(playlistModule.playlistAutoScrollDeltaForBounds(96, 100, 300) < 0);
  assert.ok(playlistModule.playlistAutoScrollDeltaForBounds(304, 100, 300) > 0);
});

test("nextPlaylistLoadSort toggles the current column and defaults new date sorts to descending", async () => {
  const playlistModule = await importModuleFromWorkspace("dropbox_browser/assets/js/music-playlist.js");

  assert.deepEqual(
    playlistModule.nextPlaylistLoadSort("name", "asc", "name"),
    { key: "name", direction: "desc" },
  );
  assert.deepEqual(
    playlistModule.nextPlaylistLoadSort("name", "desc", "last_modified"),
    { key: "last_modified", direction: "desc" },
  );
  assert.deepEqual(
    playlistModule.nextPlaylistLoadSort("last_modified", "desc", "last_modified"),
    { key: "last_modified", direction: "asc" },
  );
});

test("playlistStateSignature changes when the playlist name or order changes", async () => {
  const playlistModule = await importModuleFromWorkspace("dropbox_browser/assets/js/music-playlist.js");
  const alphaBravo = [song("music/alpha.mp3"), song("music/bravo.mp3")];
  const bravoAlpha = [song("music/bravo.mp3"), song("music/alpha.mp3")];

  assert.equal(
    playlistModule.playlistStateSignature("Road Trip", alphaBravo),
    playlistModule.playlistStateSignature("Road Trip", alphaBravo),
  );
  assert.notEqual(
    playlistModule.playlistStateSignature("Road Trip", alphaBravo),
    playlistModule.playlistStateSignature("Road Trip", bravoAlpha),
  );
  assert.notEqual(
    playlistModule.playlistStateSignature("Road Trip", alphaBravo),
    playlistModule.playlistStateSignature("Night Drive", alphaBravo),
  );
});

test("preferredPlaylistLoadSelection favors the active name, then the saved name, then the first playlist", async () => {
  const playlistModule = await importModuleFromWorkspace("dropbox_browser/assets/js/music-playlist.js");

  assert.equal(
    playlistModule.preferredPlaylistLoadSelection("Road Trip", "Focus", ["Focus", "Road Trip", "Sleep"]),
    "Road Trip",
  );
  assert.equal(
    playlistModule.preferredPlaylistLoadSelection("Unsaved", "Focus", ["Focus", "Sleep"]),
    "Focus",
  );
  assert.equal(
    playlistModule.preferredPlaylistLoadSelection("Unsaved", "Missing", ["Alpha", "Beta"]),
    "Alpha",
  );
  assert.equal(
    playlistModule.preferredPlaylistLoadSelection("Unsaved", "Missing", []),
    null,
  );
});

test("normalizePlaylistLoadSort defaults the load dialog to newest first and accepts saved overrides", async () => {
  const playlistModule = await importModuleFromWorkspace("dropbox_browser/assets/js/music-playlist.js");

  assert.deepEqual(
    playlistModule.normalizePlaylistLoadSort(null),
    { key: "last_modified", direction: "desc" },
  );
  assert.deepEqual(
    playlistModule.normalizePlaylistLoadSort({ key: "name" }),
    { key: "name", direction: "asc" },
  );
  assert.deepEqual(
    playlistModule.normalizePlaylistLoadSort({ key: "last_modified", direction: "asc" }),
    { key: "last_modified", direction: "asc" },
  );
});

test("playlistMatchesLoadFilter matches playlist names case-insensitively and empty filters match all", async () => {
  const playlistModule = await importModuleFromWorkspace("dropbox_browser/assets/js/music-playlist.js");

  assert.equal(playlistModule.normalizePlaylistLoadFilter("  Road  "), "Road");
  assert.equal(playlistModule.playlistMatchesLoadFilter({ name: "Road Trip" }, ""), true);
  assert.equal(playlistModule.playlistMatchesLoadFilter({ name: "Road Trip" }, "road"), true);
  assert.equal(playlistModule.playlistMatchesLoadFilter({ name: "Road Trip" }, "TRIP"), true);
  assert.equal(playlistModule.playlistMatchesLoadFilter({ name: "Road Trip" }, "focus"), false);
});

test("reorderPlaylistBlock is a no-op when the drop target keeps the block in place", async () => {
  const playlistModule = await importModuleFromWorkspace("dropbox_browser/assets/js/music-playlist.js");
  const playlist = [
    song("music/alpha.mp3"),
    song("music/bravo.mp3"),
    song("music/charlie.mp3"),
  ];
  const selectedRemotePaths = {
    "music/bravo.mp3": true,
  };

  const result = playlistModule.reorderPlaylistBlock(
    playlist,
    selectedRemotePaths,
    "music/bravo.mp3",
    "music/bravo.mp3",
    false,
    1,
  );

  assert.equal(result.moved, false);
  assert.deepEqual(
    result.playlist.map((entry) => entry.remote_path),
    ["music/alpha.mp3", "music/bravo.mp3", "music/charlie.mp3"],
  );
  assert.equal(result.currentPlaylistIndex, 1);
});
