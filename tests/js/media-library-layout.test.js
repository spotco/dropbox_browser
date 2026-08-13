const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const {pathToFileURL} = require("node:url");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  return import(pathToFileURL(absolutePath).href + `?t=${Date.now()}`);
}

function createMemorySettings() {
  const store = Object.create(null);
  return {
    store,
    get(key, fallback) {
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : fallback;
    },
    set(key, value) {
      store[key] = value;
    },
  };
}

function createStyleBag() {
  const props = Object.create(null);
  return {
    setProperty(name, value) {
      props[name] = String(value);
    },
    removeProperty(name) {
      delete props[name];
    },
    getPropertyValue(name) {
      return props[name] || "";
    },
  };
}

function createClassList() {
  const classes = new Set();
  return {
    add(name) {
      classes.add(name);
    },
    remove(name) {
      classes.delete(name);
    },
    contains(name) {
      return classes.has(name);
    },
    toggle(name, force) {
      if (force === true) classes.add(name);
      else if (force === false) classes.delete(name);
      else if (classes.has(name)) classes.delete(name);
      else classes.add(name);
    },
  };
}

function createLayoutDom(options) {
  const listWidth = options.listWidth == null ? 500 : options.listWidth;
  const shellWidth = options.shellWidth == null ? Math.max(listWidth * 3, 900) : options.shellWidth;
  const shellHeight = options.shellHeight == null ? 800 : options.shellHeight;
  const playlistListEl = {
    clientWidth: listWidth,
    getBoundingClientRect() {
      return {width: listWidth};
    },
  };
  const playlistTableEl = {
    style: createStyleBag(),
    getBoundingClientRect() {
      return {width: listWidth};
    },
  };
  const libraryPlaylistResizer = {
    style: createStyleBag(),
    classList: createClassList(),
    addEventListener() {},
  };
  const playlistPlaybackResizer = {
    style: createStyleBag(),
    classList: createClassList(),
    addEventListener() {},
  };
  const playerShell = {
    style: createStyleBag(),
    getBoundingClientRect() {
      return {width: shellWidth, height: shellHeight};
    },
  };
  return {
    playerShell,
    libraryPlaylistResizer,
    playlistPlaybackResizer,
    playlistListEl,
    playlistTableEl,
    libraryPane: {getBoundingClientRect() { return {width: 300}; }},
    playlistPane: {getBoundingClientRect() { return {width: listWidth}; }},
    playbackPane: {getBoundingClientRect() { return {width: 300}; }},
  };
}

function installLayoutGlobals(settings, options = {}) {
  global.Settings = settings;
  global.window = {
    getComputedStyle() {
      return {display: "block"};
    },
    matchMedia() {
      return {matches: options.narrow === true};
    },
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame(cb) {
      return setTimeout(cb, 0);
    },
    ResizeObserver: null,
  };
  global.document = {
    body: {classList: createClassList()},
    querySelectorAll() {
      return [];
    },
    addEventListener() {},
    hidden: false,
    hasFocus() {
      return true;
    },
  };
}

function buildLayoutCtx(settings, stateOverrides, elsOverrides) {
  const els = Object.assign(createLayoutDom({listWidth: 500}), elsOverrides || {});
  const state = Object.assign({
    defaultPlaylistColumnWidths: {index: 52, filename: 220, path: 340, reorder: 56},
    playlistColumnWidthSettingKey: "music-playlist-column-widths",
    musicPaneWidthSettingKey: "music-pane-widths",
    musicPaneResizerWidth: 8,
    defaultMusicPanePercents: [35, 38.333333, 26.666667],
    minMusicPaneWidthsPx: [190, 210, 220],
    currentMusicPanePercents: [35, 38.333333, 26.666667],
    playbackUiPaintTimer: null,
    playbackUiThrottleMs: 1000,
    playbackUiLastPaintMs: 0,
    pendingLibraryStatusText: null,
    libraryRenderDirty: false,
    playlistRenderDirty: false,
    playlistSelectionDirty: false,
    pendingPlaylistFocusRemotePath: null,
    libraryRequested: false,
    loading: false,
  }, stateOverrides || {});
  return {
    pane: {
      hidden: false,
      classList: createClassList(),
    },
    els,
    state,
    setStatus() {},
    playbackApi: {paintPlaybackDisplay() {}},
    libraryApi: {paintLibrary() {}, fetchLibrary() {}},
    playlistApi: {
      paintPlaylist() {},
      paintPlaylistSelection() {},
      focusPlaylistRemotePath() {},
    },
  };
}

test("music and video playlist column widths persist under separate Settings keys", async () => {
  const settings = createMemorySettings();
  installLayoutGlobals(settings);
  const {initLayout} = await importModuleFromWorkspace("dropbox_browser/assets/js/media-library/layout.js");

  const musicCtx = buildLayoutCtx(settings, {
    playlistColumnWidthSettingKey: "music-playlist-column-widths",
    musicPaneWidthSettingKey: "music-pane-widths",
  });
  initLayout(musicCtx);
  musicCtx.layoutApi.applyPlaylistColumnWidths({index: 52, filename: 200, path: 300, reorder: 56}, true);
  const musicSaved = Object.assign({}, settings.store["music-playlist-column-widths"]);

  const videoCtx = buildLayoutCtx(settings, {
    playlistColumnWidthSettingKey: "video-playlist-column-widths",
    musicPaneWidthSettingKey: "video-media-library-pane-widths",
    defaultMusicPanePercents: [28, 28, 44],
    minMusicPaneWidthsPx: [160, 180, 280],
    currentMusicPanePercents: [28, 28, 44],
  });
  initLayout(videoCtx);
  videoCtx.layoutApi.applyPlaylistColumnWidths({index: 52, filename: 120, path: 400, reorder: 56}, true);
  const videoSaved = Object.assign({}, settings.store["video-playlist-column-widths"]);

  assert.ok(musicSaved.index);
  assert.ok(musicSaved.filename);
  assert.ok(videoSaved.index);
  assert.ok(videoSaved.filename);
  assert.notDeepEqual(musicSaved, videoSaved);
  // Video writes must not clobber the music key.
  assert.deepEqual(settings.store["music-playlist-column-widths"], musicSaved);
  assert.deepEqual(settings.store["video-playlist-column-widths"], videoSaved);

  // Reloading each host must read only its own key.
  const musicReload = buildLayoutCtx(settings, {
    playlistColumnWidthSettingKey: "music-playlist-column-widths",
    musicPaneWidthSettingKey: "music-pane-widths",
  });
  initLayout(musicReload);
  musicReload.layoutApi.refreshPlaylistColumnWidths(false);
  assert.match(
    musicReload.els.playlistTableEl.style.getPropertyValue("--music-playlist-grid-columns"),
    new RegExp(String(musicSaved.filename) + "px"),
  );

  const videoReload = buildLayoutCtx(settings, {
    playlistColumnWidthSettingKey: "video-playlist-column-widths",
    musicPaneWidthSettingKey: "video-media-library-pane-widths",
    defaultMusicPanePercents: [28, 28, 44],
    minMusicPaneWidthsPx: [160, 180, 280],
    currentMusicPanePercents: [28, 28, 44],
  });
  initLayout(videoReload);
  videoReload.layoutApi.refreshPlaylistColumnWidths(false);
  assert.match(
    videoReload.els.playlistTableEl.style.getPropertyValue("--music-playlist-grid-columns"),
    new RegExp(String(videoSaved.filename) + "px"),
  );
});

test("narrow pane sizes persist independently from wide pane widths", async () => {
  const settings = createMemorySettings();
  settings.set("music-pane-widths", [20, 30, 50]);
  settings.set("music-narrow-pane-widths", [30, 70]);
  settings.set("music-narrow-pane-heights", [65, 35]);
  installLayoutGlobals(settings, {narrow: true});
  const {initLayout} = await importModuleFromWorkspace("dropbox_browser/assets/js/media-library/layout.js");
  const state = {
    musicPaneWidthSettingKey: "music-pane-widths",
    narrowMusicPaneWidthSettingKey: "music-narrow-pane-widths",
    narrowMusicPaneHeightSettingKey: "music-narrow-pane-heights",
    defaultNarrowMusicPaneWidthPercents: [50, 50],
    defaultNarrowMusicPaneHeightPercents: [50, 50],
    minNarrowMusicPaneWidthsPx: [140, 140],
    minNarrowMusicPaneHeightsPx: [220, 220],
    currentNarrowMusicPaneWidthPercents: [50, 50],
    currentNarrowMusicPaneHeightPercents: [50, 50],
  };
  const ctx = buildLayoutCtx(settings, state, {
    playerShell: Object.assign(createLayoutDom({listWidth: 300, shellWidth: 900, shellHeight: 800}).playerShell, {
      style: createStyleBag(),
    }),
  });
  initLayout(ctx);
  ctx.layoutApi.restoreMusicPanePercents();
  assert.deepEqual(ctx.layoutApi.readSavedNarrowMusicPaneWidthPercents(), [30, 70]);
  assert.deepEqual(ctx.layoutApi.readSavedNarrowMusicPaneHeightPercents(), [65, 35]);
  assert.match(ctx.els.playerShell.style.gridTemplateColumns, /px 8px .*px/);
  assert.match(ctx.els.playerShell.style.gridTemplateRows, /px 8px .*px/);

  ctx.layoutApi.applyNarrowMusicPaneSizes([40, 60], [55, 45], true);
  assert.deepEqual(settings.store["music-pane-widths"], [20, 30, 50]);
  assert.deepEqual(settings.store["music-narrow-pane-widths"].map(Math.round), [40, 60]);
  assert.deepEqual(settings.store["music-narrow-pane-heights"].map(Math.round), [55, 45]);
});

test("refreshPlaylistColumnWidths refits fixed px columns after the list width changes", async () => {
  const settings = createMemorySettings();
  installLayoutGlobals(settings);
  const {initLayout} = await importModuleFromWorkspace("dropbox_browser/assets/js/media-library/layout.js");

  const ctx = buildLayoutCtx(settings, {
    playlistColumnWidthSettingKey: "video-playlist-column-widths",
  });
  ctx.els.playlistListEl.clientWidth = 200;
  initLayout(ctx);
  ctx.layoutApi.applyPlaylistColumnWidths({index: 52, filename: 220, path: 340, reorder: 56}, false);
  const narrow = ctx.els.playlistTableEl.style.getPropertyValue("--music-playlist-grid-columns");

  ctx.els.playlistListEl.clientWidth = 600;
  ctx.layoutApi.refreshPlaylistColumnWidths(false);
  const wide = ctx.els.playlistTableEl.style.getPropertyValue("--music-playlist-grid-columns");

  assert.notEqual(narrow, wide);
  assert.match(wide, /px /);
  const parts = wide.split(/\s+/).map((part) => Number.parseFloat(part));
  assert.equal(parts.length, 4);
  assert.ok(parts[0] + parts[1] + parts[2] + parts[3] > 300);
});

test("playlist column widths include index default and upgrade old saves without wiping others", async () => {
  const settings = createMemorySettings();
  // Prior version saved three columns only.
  settings.set("music-playlist-column-widths", {filename: 180, path: 300, reorder: 56});
  installLayoutGlobals(settings);
  const {initLayout} = await importModuleFromWorkspace("dropbox_browser/assets/js/media-library/layout.js");

  const ctx = buildLayoutCtx(settings, {
    playlistColumnWidthSettingKey: "music-playlist-column-widths",
    defaultPlaylistColumnWidths: {index: 52, filename: 220, path: 340, reorder: 56},
  });
  ctx.els.playlistListEl.clientWidth = 1000;
  initLayout(ctx);

  const grid = ctx.els.playlistTableEl.style.getPropertyValue("--music-playlist-grid-columns");
  const parts = grid.split(/\s+/).map((part) => Number.parseFloat(part));
  assert.equal(parts.length, 4);
  // Index uses the default (or scaled from it); filename/path still come from the old save.
  assert.ok(parts[0] >= 48);
  assert.ok(parts[1] >= 120);
  assert.ok(parts[2] >= 150);
  assert.ok(parts[3] >= 56);

  // No prior saved data: defaults still produce a four-column grid with index first.
  // listWidth 648 => available column total 616 (648 - 16 gap - 16 padding), matching
  // 60+200+300+56 so fitColumnWidthsToTotal does not scale the requested sizes.
  const emptySettings = createMemorySettings();
  installLayoutGlobals(emptySettings);
  const freshCtx = buildLayoutCtx(emptySettings, {
    playlistColumnWidthSettingKey: "music-playlist-column-widths",
    defaultPlaylistColumnWidths: {index: 52, filename: 220, path: 340, reorder: 56},
  });
  freshCtx.els.playlistListEl.clientWidth = 648;
  initLayout(freshCtx);
  const freshGrid = freshCtx.els.playlistTableEl.style.getPropertyValue("--music-playlist-grid-columns");
  assert.match(freshGrid, /^\d+(\.\d+)?px \d+(\.\d+)?px \d+(\.\d+)?px \d+(\.\d+)?px$/);
  const applied = freshCtx.layoutApi.applyPlaylistColumnWidths(
    {index: 60, filename: 200, path: 300, reorder: 56},
    true,
  );
  assert.equal(applied.index, 60);
  assert.equal(applied.filename, 200);
  assert.equal(applied.path, 300);
  assert.equal(applied.reorder, 56);
  assert.deepEqual(
    Object.keys(emptySettings.store["music-playlist-column-widths"]).sort(),
    ["filename", "index", "path", "reorder"],
  );
  assert.equal(emptySettings.store["music-playlist-column-widths"].index, 60);
});

test("music and video hosts default playlist widths include index", async () => {
  const musicPath = path.resolve(__dirname, "..", "..", "dropbox_browser/assets/js/music.js");
  const videoPath = path.resolve(__dirname, "..", "..", "dropbox_browser/assets/js/video.js");
  const musicHtml = path.resolve(__dirname, "..", "..", "dropbox_browser/assets/templates/music_player.html");
  const videoHtml = path.resolve(__dirname, "..", "..", "dropbox_browser/assets/templates/video_player.html");
  const cssPath = path.resolve(__dirname, "..", "..", "dropbox_browser/assets/css/media-library.css");

  const [musicJs, videoJs, musicTemplate, videoTemplate, css] = await Promise.all([
    fs.readFile(musicPath, "utf8"),
    fs.readFile(videoPath, "utf8"),
    fs.readFile(musicHtml, "utf8"),
    fs.readFile(videoHtml, "utf8"),
    fs.readFile(cssPath, "utf8"),
  ]);

  assert.match(
    musicJs,
    /defaultPlaylistColumnWidths:\s*\{index:\s*52,\s*filename:\s*220,\s*path:\s*340,\s*reorder:\s*56\}/,
  );
  assert.match(
    videoJs,
    /defaultPlaylistColumnWidths:\s*\{index:\s*52,\s*filename:\s*220,\s*path:\s*340,\s*reorder:\s*56\}/,
  );
  assert.match(musicTemplate, /data-music-playlist-column-resizer="index"/);
  assert.match(videoTemplate, /data-music-playlist-column-resizer="index"/);
  assert.match(musicTemplate, /<span>Index<\/span>/);
  assert.match(videoTemplate, /<span>Index<\/span>/);
  assert.match(css, /--music-playlist-grid-columns:\s*52px /);
  assert.match(css, /\.music-playlist-entry\.current\s+\.music-playlist-filename-cell::before/);
  assert.doesNotMatch(css, /\.music-playlist-entry\.current\s*>\s*div:first-child::before/);
});

test("music host restores pane split then refreshes active playlist columns", async () => {
  const musicPath = path.resolve(__dirname, "..", "..", "dropbox_browser/assets/js/music.js");
  const musicJs = await fs.readFile(musicPath, "utf8");

  // Good behaviour: after becoming the active bottom pane, music re-fits columns.
  const modeHandler = musicJs.match(
    /if \(ev\.detail\.mode === 'music-player'\) \{([\s\S]*?)\n\s*\}/,
  );
  assert.ok(modeHandler, "expected music-player mode handler");
  assert.match(modeHandler[1], /restoreMusicPanePercents\s*\(/);
  assert.match(modeHandler[1], /refreshPlaylistColumnWidths\s*\(\s*false\s*\)/);

  // Good behaviour: same pair runs at end of music init.
  const initTail = musicJs.slice(musicJs.lastIndexOf("ctx.libraryApi.resetLibraryForCurrentFolder"));
  assert.match(initTail, /restoreMusicPanePercents\s*\(/);
  assert.match(initTail, /refreshPlaylistColumnWidths\s*\(\s*false\s*\)/);
});

test("video host restores pane split then refreshes active playlist columns", async () => {
  const videoPath = path.resolve(__dirname, "..", "..", "dropbox_browser/assets/js/video.js");
  const videoJs = await fs.readFile(videoPath, "utf8");

  // Separate persistence from music.
  assert.match(videoJs, /playlistColumnWidthSettingKey:\s*'video-playlist-column-widths'/);
  assert.match(
    await fs.readFile(
      path.resolve(__dirname, "..", "..", "dropbox_browser/assets/js/music.js"),
      "utf8",
    ),
    /playlistColumnWidthSettingKey:\s*'music-playlist-column-widths'/,
  );

  // Bad behaviour without the fix: restoreVideoPaneLayout only restores the
  // outer pane split and returns, so playlist columns stay at the pre-restore
  // (or minimum) pixel fit until the first column drag remeasures.
  const restoreFn = videoJs.match(
    /function restoreVideoPaneLayout\(\) \{([\s\S]*?)\n  \}/,
  );
  assert.ok(restoreFn, "expected restoreVideoPaneLayout");
  assert.match(restoreFn[1], /restoreMusicPanePercents\s*\(/);
  assert.match(
    restoreFn[1],
    /refreshPlaylistColumnWidths\s*\(\s*false\s*\)/,
    "video restoreVideoPaneLayout must refresh playlist columns after pane restore (music parity)",
  );
});

test("bottom panel bootstrapping gate waits for music and video layout ready signals", async () => {
  const bottomPanePath = path.resolve(__dirname, "..", "..", "dropbox_browser/assets/js/bottom-pane.js");
  const appCssPath = path.resolve(__dirname, "..", "..", "dropbox_browser/assets/app.css");
  const pagePath = path.resolve(__dirname, "..", "..", "dropbox_browser/assets/templates/page.html");
  const musicPath = path.resolve(__dirname, "..", "..", "dropbox_browser/assets/js/music.js");
  const videoPath = path.resolve(__dirname, "..", "..", "dropbox_browser/assets/js/video.js");

  const [bottomPaneJs, appCss, pageHtml, musicJs, videoJs] = await Promise.all([
    fs.readFile(bottomPanePath, "utf8"),
    fs.readFile(appCssPath, "utf8"),
    fs.readFile(pagePath, "utf8"),
    fs.readFile(musicPath, "utf8"),
    fs.readFile(videoPath, "utf8"),
  ]);

  assert.match(pageHtml, /bottom-panel-bootstrapping/);
  assert.match(pageHtml, /data-bottom-panel-ready="0"/);
  assert.match(pageHtml, /id="music-player-status-text"/);
  assert.match(appCss, /body\.bottom-panel-bootstrapping\s+#log-panel/);
  assert.match(appCss, /pointer-events:\s*none/);
  assert.match(bottomPaneJs, /markBottomPanelMediaLayoutReady/);
  assert.match(bottomPaneJs, /data-bottom-panel-ready/);
  assert.match(bottomPaneJs, /getElementById\('music-player-status-text'\)/);
  assert.match(bottomPaneJs, /Loading\('/);
  assert.match(bottomPaneJs, /Loaded \('/);
  assert.match(bottomPaneJs, /LOAD_STATUS_TICK_MS\s*=\s*100/);
  assert.match(bottomPaneJs, /loadStatusFinalized/);
  assert.match(musicJs, /markBottomPanelMediaLayoutReady\(\s*['"]music['"]\s*\)/);
  assert.match(videoJs, /markBottomPanelMediaLayoutReady\(\s*['"]video['"]\s*\)/);
  // Must not invent a new toolbar status node for the bootstrap timer.
  assert.doesNotMatch(bottomPaneJs, /createElement\(/);
});
