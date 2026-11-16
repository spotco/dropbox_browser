const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importSyncModule() {
  const absolutePath = path.resolve(__dirname, "..", "..", "dropbox_browser/assets/js/media-library/playlist-sync.js");
  return import(pathToFileURL(absolutePath).href);
}

async function importStoreModule() {
  const absolutePath = path.resolve(__dirname, "..", "..", "dropbox_browser/assets/js/media-library/playlist-store.js");
  return import(pathToFileURL(absolutePath).href);
}

function songs(count, prefix) {
  const entries = [];
  for (let index = 1; index <= count; index += 1) {
    entries.push(`${prefix || "music"}/song-${index}.mp3`);
  }
  return entries;
}

function playlist(name, songPaths, lastModified) {
  return {
    last_modified: lastModified || 10,
    name,
    songs: songPaths,
  };
}

function exportDocument(playlists, version) {
  const payload = {
    exported_at: 20,
    playlists,
  };
  if (version !== undefined) payload.version = version;
  return payload;
}

test("summary reports added, removed, item counts, and reorder", async () => {
  const sync = await importSyncModule();
  const before = [
    { name: "Favorites", songs: songs(20).map((remotePath) => ({ remote_path: remotePath, stream_path: remotePath })) },
    { name: "Old", songs: songs(2, "old").map((remotePath) => ({ remote_path: remotePath, stream_path: remotePath })) },
  ];
  const afterSongs = songs(20);
  afterSongs.splice(1, 1);
  afterSongs.push("music/song-21.mp3", "music/song-22.mp3", "music/song-23.mp3", "music/song-24.mp3", "music/song-25.mp3");
  const reordered = songs(3, "order");
  const after = [
    { name: "Favorites", songs: afterSongs.map((remotePath) => ({ remote_path: remotePath, stream_path: remotePath })) },
    { name: "New Mix", songs: songs(1, "new").map((remotePath) => ({ remote_path: remotePath, stream_path: remotePath })) },
    { name: "Order", songs: [reordered[2], reordered[0], reordered[1]].map((remotePath) => ({ remote_path: remotePath, stream_path: remotePath })) },
  ];
  const beforeOrder = [{ name: "Order", songs: reordered.map((remotePath) => ({ remote_path: remotePath, stream_path: remotePath })) }];
  const summary = sync.summarizePlaylistChanges(before, after.concat([beforeOrder[0] && { name: "Order", songs: beforeOrder[0].songs }]));
  const reorderOnly = sync.summarizePlaylistChanges(beforeOrder, [{
    name: "Order",
    songs: [reordered[2], reordered[0], reordered[1]].map((remotePath) => ({ remote_path: remotePath, stream_path: remotePath })),
  }]);

  assert.match(summary.text, /Added "New Mix" \(1 items\)/);
  assert.match(summary.text, /Removed "Old" \(2 items\)/);
  assert.match(summary.text, /Changed "Favorites": added 5, removed 1/);
  assert.equal(reorderOnly.text, 'Changed "Order": reordered');
  assert.equal(reorderOnly.hasChanges, true);
});

test("timestamp-only and empty collections are not content changes", async () => {
  const sync = await importSyncModule();
  const songsForList = songs(2).map((remotePath) => ({ remote_path: remotePath, stream_path: remotePath }));
  const summary = sync.summarizePlaylistChanges(
    [{ last_modified: 1, name: "Favorites", songs: songsForList }],
    [{ last_modified: 99, name: "Favorites", songs: songsForList }],
  );
  assert.equal(summary.hasChanges, false);
  assert.equal(summary.text, "No playlist changes.");
  assert.equal(sync.summarizePlaylistChanges([], []).hasChanges, false);
});

test("linked Favorites reloads and a missing or blank link resets", async () => {
  const sync = await importSyncModule();
  const store = await importStoreModule();
  const favorites = playlist("Favorites", songs(25));
  const parsed = sync.parsePlaylistExport(exportDocument([favorites], 1));
  assert.equal(parsed.persistedPlaylists[0].songs.length, 25);
  assert.equal(sync.pullActivePlaylistAction("Favorites", parsed.persistedPlaylists), "reload");
  assert.equal(sync.pullActivePlaylistAction("Missing", parsed.persistedPlaylists), "reset");
  assert.equal(sync.pullActivePlaylistAction("", parsed.persistedPlaylists), "reset");
  assert.equal(sync.pullActivePlaylistAction(null, [{ name: store.DEFAULT_PLAYLIST_NAME, songs: [] }]), "reset");
});

test("invalid imports do not modify the live playlist store", async () => {
  const sync = await importSyncModule();
  const storeModule = await importStoreModule();
  const memory = { value: null };
  const live = new storeModule.PlaylistStore({
    storage: {
      get() { return memory.value; },
      set(_key, value) { memory.value = value; },
    },
  });
  live.importPersistedPlaylists(exportDocument([playlist("Favorites", songs(20))], 1));
  live.persist();
  const before = live.persistedPlaylists.map((playlist) => playlist.name);

  for (const payload of [
    "{",
    exportDocument([{ name: "Broken" }]),
    exportDocument([playlist("Favorites", songs(1)), playlist("Favorites", songs(2))]),
    exportDocument([playlist("Future", songs(1))], 2),
  ]) {
    assert.throws(() => sync.parsePlaylistExport(payload));
    assert.deepEqual(live.persistedPlaylists.map((playlist) => playlist.name), before);
    assert.equal(live.persistedPlaylists[0].songs.length, 20);
  }

  const missingVersion = sync.parsePlaylistExport(exportDocument([playlist("Legacy", songs(3))]));
  assert.equal(missingVersion.persistedPlaylists[0].name, "Legacy");
  assert.equal(missingVersion.persistedPlaylists[0].songs.length, 3);
  assert.deepEqual(live.persistedPlaylists.map((playlist) => playlist.name), before);
});

test("music and video sync paths stay separate", async () => {
  const sync = await importSyncModule();
  assert.equal(sync.resolvePlaylistSyncPath(
    "dropbox_browser_music_playlists.json",
    "?video_playlist_sync_path=dropbox_browser/dev_test_video_playlists.json",
    "music_playlist_sync_path",
  ), "dropbox_browser_music_playlists.json");
  assert.equal(sync.resolvePlaylistSyncPath(
    "dropbox_browser_music_playlists.json",
    "?music_playlist_sync_path=dropbox_browser/dev_test_music_playlists.json&video_playlist_sync_path=dropbox_browser/dev_test_video_playlists.json",
    "music_playlist_sync_path",
  ), "dropbox_browser/dev_test_music_playlists.json");
  assert.equal(sync.resolvePlaylistSyncPath(
    "dropbox_browser_videos_playlists.json",
    "?music_playlist_sync_path=dropbox_browser/dev_test_music_playlists.json",
    "video_playlist_sync_path",
  ), "dropbox_browser_videos_playlists.json");
  assert.equal(sync.resolvePlaylistSyncPath(
    "dropbox_browser_videos_playlists.json",
    "?video_playlist_sync_path=",
    "video_playlist_sync_path",
  ), "");
});
