const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  const source = await fs.readFile(absolutePath, "utf8");
  return import(`data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`);
}

function song(remotePath, displayName) {
  return {
    display_name: displayName || remotePath.split("/").pop(),
    filename: displayName || remotePath.split("/").pop(),
    rel_path: remotePath,
    remote_path: remotePath,
    stream_path: remotePath,
  };
}

test("PlaylistModel serializes ordered Dropbox paths and round-trips through JSON helpers", async () => {
  const playlistModule = await importModuleFromWorkspace("dropbox_browser/assets/js/music-playlist-store.js");
  const playlist = new playlistModule.PlaylistModel({
    last_modified: 111,
    name: "Road Trip",
    songs: [
      song("/Music/alpha.mp3", "Alpha"),
      song("/Music/bravo.mp3", "Bravo"),
    ],
  });

  assert.deepEqual(playlist.toJSON(), {
    last_modified: 111,
    name: "Road Trip",
    songs: ["Music/alpha.mp3", "Music/bravo.mp3"],
  });

  const restored = playlistModule.PlaylistModel.fromJSON(playlist.toJSON());
  assert.equal(restored.name, "Road Trip");
  assert.equal(restored.last_modified, 111);
  assert.deepEqual(
    restored.songs.map((entry) => entry.remote_path),
    ["Music/alpha.mp3", "Music/bravo.mp3"],
  );
  assert.equal(restored.songs[0].display_name, "alpha.mp3");
});

test("PlaylistModel keeps duplicate Dropbox paths disallowed", async () => {
  const playlistModule = await importModuleFromWorkspace("dropbox_browser/assets/js/music-playlist-store.js");
  const playlist = new playlistModule.PlaylistModel({
    name: "No Duplicates",
    songs: [song("/Music/alpha.mp3")],
  });

  const added = playlist.addSongs([
    song("/Music/alpha.mp3"),
    song("/Music/bravo.mp3"),
  ]);

  assert.equal(added, 1);
  assert.deepEqual(
    playlist.songs.map((entry) => entry.remote_path),
    ["Music/alpha.mp3", "Music/bravo.mp3"],
  );
});

test("PlaylistModel normalizes saved Dropbox remote paths into playable stream paths", async () => {
  const playlistModule = await importModuleFromWorkspace("dropbox_browser/assets/js/music-playlist-store.js");
  const playlist = new playlistModule.PlaylistModel({
    name: "Saved",
    songs: [{ remote_path: "dropbox:Music/Album/Track.mp3" }],
  });

  assert.deepEqual(playlist.songs.map((entry) => ({
    remote_path: entry.remote_path,
    rel_path: entry.rel_path,
    stream_path: entry.stream_path,
  })), [
    {
      remote_path: "dropbox:Music/Album/Track.mp3",
      rel_path: "Music/Album/Track.mp3",
      stream_path: "Music/Album/Track.mp3",
    },
  ]);
});

test("PlaylistStore overwrites persisted playlists by name and updates last_modified on save", async () => {
  const playlistModule = await importModuleFromWorkspace("dropbox_browser/assets/js/music-playlist-store.js");
  const writes = [];
  const storage = {
    get(_key, fallback) {
      return fallback;
    },
    set(key, value) {
      writes.push({ key, value });
    },
  };
  const store = new playlistModule.PlaylistStore({
    clock: () => 1234000,
    storage,
  });

  store.activePlaylist.addSongs([song("/Music/alpha.mp3")]);
  store.saveActivePlaylist({ name: "Focus" });
  store.activePlaylist.replaceSongs([song("/Music/bravo.mp3")]);
  const saved = store.saveActivePlaylist({ name: "Focus" });
  store.persist();

  assert.equal(store.persistedPlaylists.length, 1);
  assert.equal(saved.last_modified, 1234);
  assert.deepEqual(
    saved.songs.map((entry) => entry.remote_path),
    ["Music/bravo.mp3"],
  );
  assert.equal(writes.length, 1);
  assert.equal(writes[0].key, playlistModule.PLAYLIST_STORAGE_KEY);
});

test("PlaylistStore exports, imports, and sorts persisted playlists", async () => {
  const playlistModule = await importModuleFromWorkspace("dropbox_browser/assets/js/music-playlist-store.js");
  const store = new playlistModule.PlaylistStore({
    clock: () => 4000000,
  });

  store.upsertPersistedPlaylist(new playlistModule.PlaylistModel({
    last_modified: 30,
    name: "Gamma",
    songs: [song("/Music/gamma.mp3")],
  }), { touch: false });
  store.upsertPersistedPlaylist(new playlistModule.PlaylistModel({
    last_modified: 10,
    name: "Alpha",
    songs: [song("/Music/alpha.mp3")],
  }), { touch: false });
  store.upsertPersistedPlaylist(new playlistModule.PlaylistModel({
    last_modified: 20,
    name: "Beta",
    songs: [song("/Music/beta.mp3")],
  }), { touch: false });

  const exported = store.exportPersistedPlaylists();
  const imported = new playlistModule.PlaylistStore();
  imported.importPersistedPlaylists(exported);

  assert.deepEqual(
    imported.listPersistedPlaylists("name", "asc").map((playlist) => playlist.name),
    ["Alpha", "Beta", "Gamma"],
  );
  assert.deepEqual(
    imported.listPersistedPlaylists("last_modified", "desc").map((playlist) => playlist.name),
    ["Gamma", "Beta", "Alpha"],
  );
  assert.equal(exported.version, 1);
  assert.equal(exported.exported_at, 4000);
});

test("playlistNameFromFilename strips playlist file extensions and falls back cleanly", async () => {
  const playlistModule = await importModuleFromWorkspace("dropbox_browser/assets/js/music-playlist-store.js");

  assert.equal(playlistModule.playlistNameFromFilename("Road Trip.m3u8"), "Road Trip");
  assert.equal(playlistModule.playlistNameFromFilename("saved-playlists.json"), "saved-playlists");
  assert.equal(playlistModule.playlistNameFromFilename(""), playlistModule.DEFAULT_PLAYLIST_NAME);
});

test("parseM3uPlaylistText ignores blank lines and comment lines", async () => {
  const playlistModule = await importModuleFromWorkspace("dropbox_browser/assets/js/music-playlist-store.js");

  assert.deepEqual(
    playlistModule.parseM3uPlaylistText([
      "#EXTM3U",
      "",
      "  /Music/alpha.mp3  ",
      "#EXTINF:123,Alpha",
      "/Music/bravo.mp3",
      "   ",
    ].join("\n")),
    ["/Music/alpha.mp3", "/Music/bravo.mp3"],
  );
});

test('PlaylistModel preserves imported phone-playlist paths like "/music/...mp3" as playable stream paths', async () => {
  const playlistModule = await importModuleFromWorkspace("dropbox_browser/assets/js/music-playlist-store.js");
  const imported = new playlistModule.PlaylistModel({
    name: "2024distantworlds",
    songs: [
      { remote_path: "/music/01-opening-bombing-mission.mp3" },
      { remote_path: "/music/02-aerith.mp3" },
    ],
  });

  assert.deepEqual(
    imported.songs.map((entry) => ({
      remote_path: entry.remote_path,
      stream_path: entry.stream_path,
      rel_path: entry.rel_path,
    })),
    [
      {
        remote_path: "music/01-opening-bombing-mission.mp3",
        stream_path: "music/01-opening-bombing-mission.mp3",
        rel_path: "music/01-opening-bombing-mission.mp3",
      },
      {
        remote_path: "music/02-aerith.mp3",
        stream_path: "music/02-aerith.mp3",
        rel_path: "music/02-aerith.mp3",
      },
    ],
  );
});

test("PlaylistModel.fromJSON restores Dropbox-prefixed songs with playable stream paths", async () => {
  const playlistModule = await importModuleFromWorkspace("dropbox_browser/assets/js/music-playlist-store.js");
  const restored = playlistModule.PlaylistModel.fromJSON({
    last_modified: 5,
    name: "Road Trip",
    songs: ["dropbox:Music/Loose.MP3", "/Music/Album/Track.m4a"],
  });

  assert.deepEqual(
    restored.songs.map((entry) => ({
      remote_path: entry.remote_path,
      stream_path: entry.stream_path,
    })),
    [
      { remote_path: "dropbox:Music/Loose.MP3", stream_path: "Music/Loose.MP3" },
      { remote_path: "Music/Album/Track.m4a", stream_path: "Music/Album/Track.m4a" },
    ],
  );
});

test("PlaylistStore mergePersistedPlaylists validates and overwrites by imported name", async () => {
  const playlistModule = await importModuleFromWorkspace("dropbox_browser/assets/js/music-playlist-store.js");
  const store = new playlistModule.PlaylistStore();

  store.upsertPersistedPlaylist(new playlistModule.PlaylistModel({
    last_modified: 10,
    name: "Alpha",
    songs: [song("/Music/original-alpha.mp3")],
  }), { touch: false });
  store.upsertPersistedPlaylist(new playlistModule.PlaylistModel({
    last_modified: 20,
    name: "Bravo",
    songs: [song("/Music/bravo.mp3")],
  }), { touch: false });

  store.mergePersistedPlaylists({
    playlists: [
      {
        last_modified: 50,
        name: "Alpha",
        songs: ["/Music/replaced-alpha.mp3"],
      },
      {
        last_modified: 60,
        name: "Charlie",
        songs: ["/Music/charlie.mp3"],
      },
    ],
    version: 1,
  });

  assert.deepEqual(
    store.listPersistedPlaylists("name", "asc").map((playlist) => ({
      name: playlist.name,
      songs: playlist.songs.map((entry) => entry.remote_path),
    })),
    [
      { name: "Alpha", songs: ["Music/replaced-alpha.mp3"] },
      { name: "Bravo", songs: ["Music/bravo.mp3"] },
      { name: "Charlie", songs: ["Music/charlie.mp3"] },
    ],
  );
});
