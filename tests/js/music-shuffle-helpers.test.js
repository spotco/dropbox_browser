const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  const source = await fs.readFile(absolutePath, "utf8");
  return import(`data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`);
}

test("isValidShuffleSequence accepts a permutation and rejects duplicates or wrong length", async () => {
  const helpers = await importModuleFromWorkspace("dropbox_browser/assets/js/music-shuffle-helpers.js");

  assert.equal(helpers.isValidShuffleSequence([0, 1, 2], 3), true);
  assert.equal(helpers.isValidShuffleSequence([2, 0, 1], 3), true);
  assert.equal(helpers.isValidShuffleSequence([0, 1], 3), false);
  assert.equal(helpers.isValidShuffleSequence([0, 0, 1], 3), false);
  assert.equal(helpers.isValidShuffleSequence([0, 1, 3], 3), false);
  assert.equal(helpers.isValidShuffleSequence(null, 0), false);
  assert.equal(helpers.isValidShuffleSequence([], 0), true);
});

test("buildShuffledIndices is deterministic when random is fixed", async () => {
  const helpers = await importModuleFromWorkspace("dropbox_browser/assets/js/music-shuffle-helpers.js");

  assert.deepEqual(helpers.buildShuffledIndices(4, () => 0), [1, 2, 3, 0]);
  assert.deepEqual(helpers.buildShuffledIndices(1, () => 0), [0]);
  assert.deepEqual(helpers.buildShuffledIndices(0, () => 0), []);
});

test("rebuildShuffleSequence pins the current index at the front of the sequence", async () => {
  const helpers = await importModuleFromWorkspace("dropbox_browser/assets/js/music-shuffle-helpers.js");
  const rebuilt = helpers.rebuildShuffleSequence(4, 2, () => 0);

  assert.equal(rebuilt.shuffleSequence[0], 2);
  assert.equal(rebuilt.shuffleCursor, 0);
  assert.deepEqual(rebuilt.shuffleSequence.slice().sort((a, b) => a - b), [0, 1, 2, 3]);
});

test("resolveNextPlaylistIndex walks linear order and loops when enabled", async () => {
  const helpers = await importModuleFromWorkspace("dropbox_browser/assets/js/music-shuffle-helpers.js");

  assert.equal(
    helpers.resolveNextPlaylistIndex({
      playlistLength: 3,
      currentPlaylistIndex: 0,
      shuffleEnabled: false,
      loopPlaylist: false,
      shuffleSequence: [],
      shuffleCursor: -1,
    }).index,
    1,
  );
  assert.equal(
    helpers.resolveNextPlaylistIndex({
      playlistLength: 3,
      currentPlaylistIndex: 2,
      shuffleEnabled: false,
      loopPlaylist: false,
      shuffleSequence: [],
      shuffleCursor: -1,
    }).index,
    -1,
  );
  assert.equal(
    helpers.resolveNextPlaylistIndex({
      playlistLength: 3,
      currentPlaylistIndex: 2,
      shuffleEnabled: false,
      loopPlaylist: true,
      shuffleSequence: [],
      shuffleCursor: -1,
    }).index,
    0,
  );
});

test("resolvePreviousPlaylistIndex walks linear order and loops when enabled", async () => {
  const helpers = await importModuleFromWorkspace("dropbox_browser/assets/js/music-shuffle-helpers.js");

  assert.equal(
    helpers.resolvePreviousPlaylistIndex({
      playlistLength: 3,
      currentPlaylistIndex: 2,
      shuffleEnabled: false,
      loopPlaylist: false,
      shuffleSequence: [],
      shuffleCursor: -1,
    }).index,
    1,
  );
  assert.equal(
    helpers.resolvePreviousPlaylistIndex({
      playlistLength: 3,
      currentPlaylistIndex: 0,
      shuffleEnabled: false,
      loopPlaylist: false,
      shuffleSequence: [],
      shuffleCursor: -1,
    }).index,
    0,
  );
  assert.equal(
    helpers.resolvePreviousPlaylistIndex({
      playlistLength: 3,
      currentPlaylistIndex: 0,
      shuffleEnabled: false,
      loopPlaylist: true,
      shuffleSequence: [],
      shuffleCursor: -1,
    }).index,
    2,
  );
});

test("resolveNextPlaylistIndex follows shuffle sequence and loops shuffle order", async () => {
  const helpers = await importModuleFromWorkspace("dropbox_browser/assets/js/music-shuffle-helpers.js");
  const sequence = [2, 0, 3, 1];

  const first = helpers.resolveNextPlaylistIndex({
    playlistLength: 4,
    currentPlaylistIndex: 2,
    shuffleEnabled: true,
    loopPlaylist: false,
    shuffleSequence: sequence,
    shuffleCursor: 0,
  });
  assert.equal(first.index, 0);
  assert.equal(first.shuffleCursor, 1);

  const end = helpers.resolveNextPlaylistIndex({
    playlistLength: 4,
    currentPlaylistIndex: 1,
    shuffleEnabled: true,
    loopPlaylist: false,
    shuffleSequence: sequence,
    shuffleCursor: 3,
  });
  assert.equal(end.index, -1);

  const looped = helpers.resolveNextPlaylistIndex({
    playlistLength: 4,
    currentPlaylistIndex: 1,
    shuffleEnabled: true,
    loopPlaylist: true,
    shuffleSequence: sequence,
    shuffleCursor: 3,
  });
  assert.equal(looped.index, 2);
  assert.equal(looped.shuffleCursor, 0);
});

test("resolvePreviousPlaylistIndex follows shuffle sequence and loops to the last shuffle entry", async () => {
  const helpers = await importModuleFromWorkspace("dropbox_browser/assets/js/music-shuffle-helpers.js");
  const sequence = [2, 0, 3, 1];

  const previous = helpers.resolvePreviousPlaylistIndex({
    playlistLength: 4,
    currentPlaylistIndex: 0,
    shuffleEnabled: true,
    loopPlaylist: false,
    shuffleSequence: sequence,
    shuffleCursor: 1,
  });
  assert.equal(previous.index, 2);
  assert.equal(previous.shuffleCursor, 0);

  const looped = helpers.resolvePreviousPlaylistIndex({
    playlistLength: 4,
    currentPlaylistIndex: 2,
    shuffleEnabled: true,
    loopPlaylist: true,
    shuffleSequence: sequence,
    shuffleCursor: 0,
  });
  assert.equal(looped.index, 1);
  assert.equal(looped.shuffleCursor, 3);
});
