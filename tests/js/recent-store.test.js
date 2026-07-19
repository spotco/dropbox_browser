const path = require("node:path");
const {pathToFileURL} = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importRecentStore() {
  const absolutePath = path.resolve(__dirname, "..", "..", "dropbox_browser/assets/js/media-library/recent-store.js");
  return import(pathToFileURL(absolutePath).href + `?t=${Date.now()}`);
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

function memoryStorage(initial = {}) {
  const values = {...initial};
  return {
    values,
    get(key, fallback) {
      return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback;
    },
    set(key, value) {
      values[key] = value;
    },
  };
}

test("RecentStore records clone-safe items, collapses only the matching consecutive play, and separates kinds", async () => {
  const recent = await importRecentStore();
  const storage = memoryStorage();
  let now = 1000;
  const music = new recent.RecentStore({mediaKind: "music", storage, clock: () => now});
  const video = new recent.RecentStore({mediaKind: "video", storage, clock: () => now});
  const alpha = song("music/Alpha.mp3", "Alpha");

  music.recordPlaybackStart(alpha, "Road Trip");
  alpha.display_name = "mutated";
  now = 2000;
  music.recordPlaybackStart(song("music/alpha.mp3", "Alpha"), "Road Trip");
  assert.equal(music.records.length, 1);
  assert.equal(music.records[0].played_at, 2000);
  assert.equal(music.records[0].item.display_name, "Alpha");

  now = 3000;
  music.recordPlaybackStart(song("music/bravo.mp3"), "Road Trip");
  now = 4000;
  music.recordPlaybackStart(song("music/alpha.mp3"), "Road Trip");
  now = 5000;
  music.recordPlaybackStart(song("music/alpha.mp3"), "Focus");
  assert.equal(music.records.length, 4);

  video.recordPlaybackStart(song("music/alpha.mp3"), "Road Trip");
  assert.equal(music.records.length, 4);
  assert.equal(video.records.length, 1);
  assert.notEqual(music.storageKey, video.storageKey);
});

test("RecentStore evicts oldest records at the bounded limit and recovers malformed storage", async () => {
  const recent = await importRecentStore();
  const storage = memoryStorage({"music-recent-history": {version: 1, records: [null, "bad", {played_at: 1}]}});
  const store = new recent.RecentStore({mediaKind: "music", storage, limit: 3, clock: () => 100});
  assert.deepEqual(store.records, []);
  store.recordPlaybackStart(song("music/a.mp3"), "A", 1);
  store.recordPlaybackStart(song("music/b.mp3"), "A", 2);
  store.recordPlaybackStart(song("music/c.mp3"), "A", 3);
  store.recordPlaybackStart(song("music/d.mp3"), "A", 4);
  assert.deepEqual(store.records.map((record) => record.item.remote_path), ["music/b.mp3", "music/c.mp3", "music/d.mp3"]);
  assert.equal(storage.values["music-recent-history"].version, 1);
});

test("Recent sorting defaults newest first, toggles directions, and keeps ties deterministic", async () => {
  const recent = await importRecentStore();
  const records = [
    {id: 2, played_at: 10, playlist_name: "Zulu", item: song("music/b.mp3", "Bravo")},
    {id: 1, played_at: 10, playlist_name: "Alpha", item: song("music/a.mp3", "Alpha")},
  ];
  assert.deepEqual(recent.normalizeRecentSort(null), {key: "played_at", direction: "desc"});
  assert.deepEqual(recent.nextRecentSort("played_at", "desc", "played_at"), {key: "played_at", direction: "asc"});
  assert.deepEqual(recent.nextRecentSort("played_at", "desc", "filename"), {key: "filename", direction: "asc"});
  assert.deepEqual(recent.sortRecentRecords(records, "played_at", "desc").map((record) => record.id), [1, 2]);
  assert.deepEqual(recent.sortRecentRecords(records, "filename", "desc").map((record) => record.id), [2, 1]);
  assert.deepEqual(recent.sortRecentRecords(records, "playlist_name", "asc").map((record) => record.id), [1, 2]);
});

test("recentRestorationDecision distinguishes saved, fallback, and missing-item restores", async () => {
  const recent = await importRecentStore();
  const record = {item: song("music/alpha.mp3"), playlist_name: "Saved", played_at: 1};
  assert.equal(recent.recentRestorationDecision(record, null), "fallback");
  assert.equal(recent.recentRestorationDecision(record, {songs: [{remote_path: "dropbox:music/alpha.mp3"}] }), "play-saved");
  assert.equal(recent.recentRestorationDecision(record, {songs: [song("music/bravo.mp3")] }), "load-missing");
});
