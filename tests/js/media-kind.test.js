const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  return import(pathToFileURL(absolutePath).href);
}

test("media kind presentation supplies music labels and export filename", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/media-library/media-kind.js");
  const presentation = mod.mediaKindPresentation("music");

  assert.equal(presentation.itemNounSingular, "song");
  assert.equal(presentation.itemNounPlural, "songs");
  assert.equal(presentation.playlistItemsLabel, "Songs");
  assert.equal(presentation.playlistLoadLabel, "Load Playlist: Songs");
  assert.equal(presentation.playlistExportFilename, "dropbox_browser_music_playlists.json");
  assert.equal(mod.formatMediaItemCount(1, "music"), "1 song");
  assert.equal(mod.formatMediaItemCount(2, "music"), "2 songs");
});

test("media kind presentation supplies video labels and accepts the singular alias", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/media-library/media-kind.js");
  const presentation = mod.mediaKindPresentation("video");

  assert.equal(presentation.itemNounSingular, "video");
  assert.equal(presentation.itemNounPlural, "videos");
  assert.equal(presentation.playlistItemsLabel, "Videos");
  assert.equal(presentation.playlistLoadLabel, "Load Playlist: Videos");
  assert.equal(presentation.playlistExportFilename, "dropbox_browser_videos_playlists.json");
  assert.equal(mod.formatMediaItemCount(1, "videos"), "1 video");
  assert.equal(mod.formatMediaItemCount(2, "videos"), "2 videos");
});
