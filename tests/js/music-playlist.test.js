const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  let source = await fs.readFile(absolutePath, "utf8");
  if (relativePath.endsWith("playlist.js")) {
    const sharedPath = path.resolve(path.dirname(absolutePath), "shared.js");
    const sharedSource = await fs.readFile(sharedPath, "utf8");
    const sharedUrl = `data:text/javascript;base64,${Buffer.from(sharedSource, "utf8").toString("base64")}`;
    const storePath = path.resolve(path.dirname(absolutePath), "playlist-store.js");
    const storeSource = await fs.readFile(storePath, "utf8");
    const storeUrl = `data:text/javascript;base64,${Buffer.from(storeSource, "utf8").toString("base64")}`;
    const mediaKindPath = path.resolve(path.dirname(absolutePath), "media-kind.js");
    const mediaKindSource = await fs.readFile(mediaKindPath, "utf8");
    const mediaKindUrl = `data:text/javascript;base64,${Buffer.from(mediaKindSource, "utf8").toString("base64")}`;
    const virtualListPath = path.resolve(path.dirname(absolutePath), "../browse/virtual-list.js");
    const virtualListSource = await fs.readFile(virtualListPath, "utf8");
    const virtualListUrl = `data:text/javascript;base64,${Buffer.from(virtualListSource, "utf8").toString("base64")}`;
    source = source.replace("'./shared.js'", `'${sharedUrl}'`);
    source = source.replace("'./playlist-store.js'", `'${storeUrl}'`);
    source = source.replace("'./media-kind.js'", `'${mediaKindUrl}'`);
    source = source.replace("'../browse/virtual-list.js'", `'${virtualListUrl}'`);
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
  const playlistModule = await importModuleFromWorkspace("dropbox_browser/assets/js/media-library/playlist.js");
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
  const playlistModule = await importModuleFromWorkspace("dropbox_browser/assets/js/media-library/playlist.js");
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
  const playlistModule = await importModuleFromWorkspace("dropbox_browser/assets/js/media-library/playlist.js");

  assert.equal(playlistModule.playlistAutoScrollDeltaForBounds(160, 100, 300), 0);
  assert.ok(playlistModule.playlistAutoScrollDeltaForBounds(96, 100, 300) < 0);
  assert.ok(playlistModule.playlistAutoScrollDeltaForBounds(304, 100, 300) > 0);
});

test("nextPlaylistLoadSort toggles the current column and defaults new date sorts to descending", async () => {
  const playlistModule = await importModuleFromWorkspace("dropbox_browser/assets/js/media-library/playlist.js");

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
  const playlistModule = await importModuleFromWorkspace("dropbox_browser/assets/js/media-library/playlist.js");
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
  const playlistModule = await importModuleFromWorkspace("dropbox_browser/assets/js/media-library/playlist.js");

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
  const playlistModule = await importModuleFromWorkspace("dropbox_browser/assets/js/media-library/playlist.js");

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
  const playlistModule = await importModuleFromWorkspace("dropbox_browser/assets/js/media-library/playlist.js");

  assert.equal(playlistModule.normalizePlaylistLoadFilter("  Road  "), "Road");
  assert.equal(playlistModule.playlistMatchesLoadFilter({ name: "Road Trip" }, ""), true);
  assert.equal(playlistModule.playlistMatchesLoadFilter({ name: "Road Trip" }, "road"), true);
  assert.equal(playlistModule.playlistMatchesLoadFilter({ name: "Road Trip" }, "TRIP"), true);
  assert.equal(playlistModule.playlistMatchesLoadFilter({ name: "Road Trip" }, "focus"), false);
});

test("reorderPlaylistBlock is a no-op when the drop target keeps the block in place", async () => {
  const playlistModule = await importModuleFromWorkspace("dropbox_browser/assets/js/media-library/playlist.js");
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

function createPlaylistDomNode(tagName) {
  const node = {
    tagName: String(tagName || "div").toUpperCase(),
    children: [],
    parentNode: null,
    title: "",
    type: "",
    dataset: Object.create(null),
    attributes: Object.create(null),
    style: {
      _values: Object.create(null),
      setProperty(name, value) {
        this._values[name] = String(value);
      },
      removeProperty(name) {
        delete this._values[name];
      },
      getPropertyValue(name) {
        return this._values[name] || "";
      },
    },
    clientHeight: 0,
    scrollTop: 0,
    _className: "",
    _textContent: "",
    classList: {
      _set: new Set(),
      add(name) {
        this._set.add(name);
        node._className = Array.from(this._set).join(" ");
      },
      remove(name) {
        this._set.delete(name);
        node._className = Array.from(this._set).join(" ");
      },
      toggle(name, force) {
        if (force === true) this.add(name);
        else if (force === false) this.remove(name);
        else if (this._set.has(name)) this.remove(name);
        else this.add(name);
      },
      contains(name) {
        return this._set.has(name);
      },
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
    },
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    addEventListener() {},
    getBoundingClientRect() {
      const explicitHeight = Number.parseFloat(this.style._values.height || "");
      const height = explicitHeight > 0 ? explicitHeight : (this.clientHeight > 0 ? this.clientHeight : 30);
      const top = Number.parseFloat(this.style._values.top || "") || 0;
      return {top, bottom: top + height, height, left: 0, right: 600, width: 600};
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
    querySelectorAll(selector) {
      const matches = [];
      const wantedClass = selector.startsWith(".") ? selector.slice(1) : null;
      const walk = (current) => {
        current.children.forEach((child) => {
          if (wantedClass && child.classList.contains(wantedClass)) matches.push(child);
          walk(child);
        });
      };
      walk(this);
      return matches;
    },
  };
  Object.defineProperty(node, "className", {
    get() {
      return this._className;
    },
    set(value) {
      this._className = String(value || "");
      this.classList._set = new Set(this._className.split(/\s+/).filter(Boolean));
    },
  });
  Object.defineProperty(node, "textContent", {
    get() {
      if (this.children.length) {
        return this.children.map((child) => child.textContent).join("");
      }
      return this._textContent;
    },
    set(value) {
      this._textContent = String(value == null ? "" : value);
      if (this._textContent === "") this.children = [];
    },
  });
  return node;
}

function playlistIndexLabels(listEl) {
  return listEl.querySelectorAll(".music-playlist-entry").map((row) => {
    const indexCell = row.children.find((child) => child.classList.contains("music-playlist-index-cell"));
    return indexCell ? indexCell.textContent : null;
  });
}

function playlistFilenameLabels(listEl) {
  return listEl.querySelectorAll(".music-playlist-entry").map((row) => {
    const nameCell = row.children.find((child) => child.classList.contains("music-playlist-filename-cell"));
    return nameCell ? nameCell.textContent : null;
  });
}

test("paintPlaylist renders 1-based index cells and refreshes after reorder/remove", async () => {
  const playlistModule = await importModuleFromWorkspace("dropbox_browser/assets/js/media-library/playlist.js");
  const playlistListEl = createPlaylistDomNode("div");
  const activePlaylistNameEl = createPlaylistDomNode("span");
  const settingsStore = Object.create(null);
  global.Settings = {
    get(key, fallback) {
      return Object.prototype.hasOwnProperty.call(settingsStore, key) ? settingsStore[key] : fallback;
    },
    set(key, value) {
      settingsStore[key] = value;
    },
  };
  global.document = {
    activeElement: null,
    createElement(tagName) {
      return createPlaylistDomNode(tagName);
    },
  };
  global.window = global.window || {};

  const state = {
    playlist: [
      song("music/alpha.mp3"),
      song("music/bravo.mp3"),
      song("music/charlie.mp3"),
    ],
    activePlaylist: {name: "Test Playlist"},
    selectedPlaylistRemotePaths: Object.create(null),
    playlistSelectionAnchor: null,
    playlistContextRemotePath: null,
    activePlaylistSavedName: null,
    activePlaylistSavedSignature: "",
    activePlaylistDirty: false,
    playlistRenameMode: "rename",
    playlistLoadSortKey: "last_modified",
    playlistLoadSortDirection: "desc",
    playlistLoadSortSettingKey: "music-playlist-load-sort",
    playlistLoadFilterText: "",
    playlistLoadFilterSettingKey: "music-playlist-load-filter",
    selectedPersistedPlaylistName: null,
    playlistLoadContextName: null,
    recentSortKey: "played_at",
    recentSortDirection: "desc",
    recentSortSettingKey: "music-recent-sort",
    selectedRecentId: null,
    pendingPlaylistConfirmAction: null,
    playlistSaveToastTimer: null,
    currentPlaylistIndex: 0,
    playlistRenderDirty: false,
    playlistSelectionDirty: false,
    pendingPlaylistFocusRemotePath: null,
    shuffleBag: [],
    shuffleSequence: [],
    shuffleCursor: -1,
  };
  const ctx = {
    els: {
      playlistListEl,
      activePlaylistNameEl,
      playlistLoadConfirmButton: null,
    },
    state,
    pane: {dataset: Object.create(null)},
    mediaLibraryConfig: {mediaKind: "music"},
    layoutApi: {
      playbackUiMayPaint() {
        return true;
      },
    },
    playbackApi: {
      playPlaylistRemotePath() {},
      playPlaylistIndex() {},
      clearCurrentSong() {},
    },
    setStatus() {},
  };

  playlistModule.initPlaylist(ctx);
  ctx.playlistApi.paintPlaylist();
  assert.deepEqual(playlistIndexLabels(playlistListEl), ["1", "2", "3"]);
  assert.deepEqual(playlistFilenameLabels(playlistListEl), ["alpha.mp3", "bravo.mp3", "charlie.mp3"]);

  // Reorder moves bravo to the end; indices must renumber to current order.
  state.playlist = [
    song("music/alpha.mp3"),
    song("music/charlie.mp3"),
    song("music/bravo.mp3"),
  ];
  ctx.playlistApi.paintPlaylist();
  assert.deepEqual(playlistIndexLabels(playlistListEl), ["1", "2", "3"]);
  assert.deepEqual(playlistFilenameLabels(playlistListEl), ["alpha.mp3", "charlie.mp3", "bravo.mp3"]);

  // Remove middle entry; remaining indices stay contiguous from 1.
  state.playlist = [
    song("music/alpha.mp3"),
    song("music/bravo.mp3"),
  ];
  ctx.playlistApi.paintPlaylist();
  assert.deepEqual(playlistIndexLabels(playlistListEl), ["1", "2"]);
  assert.deepEqual(playlistFilenameLabels(playlistListEl), ["alpha.mp3", "bravo.mp3"]);

  // Add inserts at the end with the next index.
  state.playlist.push(song("music/delta.mp3"));
  ctx.playlistApi.paintPlaylist();
  assert.deepEqual(playlistIndexLabels(playlistListEl), ["1", "2", "3"]);
  assert.deepEqual(playlistFilenameLabels(playlistListEl), ["alpha.mp3", "bravo.mp3", "delta.mp3"]);
});

test("paintPlaylist virtualizes large active playlists and focuses late rows", async () => {
  const playlistModule = await importModuleFromWorkspace("dropbox_browser/assets/js/media-library/playlist.js");
  const playlistListEl = createPlaylistDomNode("div");
  const activePlaylistNameEl = createPlaylistDomNode("span");
  const settingsStore = Object.create(null);
  const playlist = Array.from({length: 250}, (_, index) => song(`music/track-${index}.mp3`));
  global.Settings = {
    get(key, fallback) {
      return Object.prototype.hasOwnProperty.call(settingsStore, key) ? settingsStore[key] : fallback;
    },
    set(key, value) {
      settingsStore[key] = value;
    },
  };
  playlistListEl.clientHeight = 90;
  global.document = {
    activeElement: null,
    createElement(tagName) {
      return createPlaylistDomNode(tagName);
    },
  };
  global.window = {
    requestAnimationFrame(callback) {
      callback();
      return 1;
    },
    cancelAnimationFrame() {},
  };

  const state = {
    playlist,
    activePlaylist: {
      name: "Large Playlist",
      replaceSongs() {},
      removeSongsByRemotePaths() {},
      addSongs() { return 0; },
    },
    selectedPlaylistRemotePaths: Object.create(null),
    playlistSelectionAnchor: null,
    playlistContextRemotePath: null,
    activePlaylistSavedName: null,
    activePlaylistSavedSignature: "",
    activePlaylistDirty: false,
    playlistRenameMode: "rename",
    playlistLoadSortKey: "last_modified",
    playlistLoadSortDirection: "desc",
    playlistLoadSortSettingKey: "music-playlist-load-sort",
    playlistLoadFilterText: "",
    playlistLoadFilterSettingKey: "music-playlist-load-filter",
    selectedPersistedPlaylistName: null,
    playlistLoadContextName: null,
    recentSortKey: "played_at",
    recentSortDirection: "desc",
    recentSortSettingKey: "music-recent-sort",
    selectedRecentId: null,
    pendingPlaylistConfirmAction: null,
    playlistSaveToastTimer: null,
    currentPlaylistIndex: 0,
    playlistRenderDirty: false,
    playlistSelectionDirty: false,
    pendingPlaylistFocusRemotePath: null,
    shuffleBag: [],
    shuffleSequence: [],
    shuffleCursor: -1,
  };
  const ctx = {
    els: {
      playlistListEl,
      activePlaylistNameEl,
      playlistLoadConfirmButton: null,
    },
    state,
    pane: {dataset: Object.create(null)},
    mediaLibraryConfig: {mediaKind: "music"},
    layoutApi: {
      playbackUiMayPaint() {
        return true;
      },
    },
    playbackApi: {
      playPlaylistRemotePath() {},
      playPlaylistIndex() {},
      clearCurrentSong() {},
    },
    setStatus() {},
  };

  playlistModule.initPlaylist(ctx);
  ctx.playlistApi.paintPlaylist();
  assert.equal(playlistListEl.dataset.playlistVirtualized, "1");
  assert.equal(playlistListEl.dataset.playlistCount, "250");
  assert.equal(playlistListEl.dataset.playlistMountedCount, "27");
  assert.deepEqual(
    playlistListEl.querySelectorAll(".music-playlist-entry").map((row) => row.dataset.playlistIndex),
    Array.from({length: 27}, (_, index) => String(index)),
  );

  playlistListEl.scrollTop = 2000;
  ctx.playlistApi.paintPlaylist();
  assert.equal(playlistListEl.dataset.playlistVisibleRange, "54:81");
  assert.equal(playlistListEl.querySelectorAll(".music-playlist-entry").length, 27);

  state.currentPlaylistIndex = 249;
  ctx.playlistApi.focusPlaylistRemotePath("music/track-249.mp3");
  const focusedRow = playlistListEl
    .querySelectorAll(".music-playlist-entry")
    .find((row) => row.dataset.remotePath === "music/track-249.mp3");
  assert.ok(focusedRow);
  assert.equal(focusedRow.classList.contains("current"), true);
  assert.equal(playlistListEl.dataset.playlistVisibleRange, "235:250");
});
