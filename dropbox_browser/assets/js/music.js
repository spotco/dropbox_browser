import {initLayout} from './media-library/layout.js';
import {initPlaylist} from './media-library/playlist.js';
import {initLibrary} from './media-library/library.js';
import {PlaylistStore} from './media-library/playlist-store.js';
import {initPlayback} from './music/playback.js';

(function () {
  var pane = document.getElementById('music-player-pane');
  var body = document.body;
  var pollDelayAttr = body ? body.dataset.musicLibraryPollDelayMs : '';
  var parsedPollDelayMs = Number.parseInt(pollDelayAttr || '', 10);
  var defaultPollDelayMs = Number.isFinite(parsedPollDelayMs) && parsedPollDelayMs > 0
    ? parsedPollDelayMs
    : 4000;
  if (!pane) return;

  var ctx = {
    pane: pane,
    mediaLibraryConfig: {
      mediaKind: 'music',
      libraryEndpoint: '/music/endpoints/library',
      emptyLibraryText: 'Load the current folder to show cached songs.',
      emptyLibraryNoItemsText: 'No supported cached songs found in this folder yet.',
      loadingLibraryText: 'Loading cached song library...',
      libraryTitle: 'Song Library',
      playlistTitlePrefix: 'Active Playlist:'
    },
    els: {
      playerShell: pane.querySelector('.music-player-shell'),
      loadButton: document.getElementById('music-library-load'),
      librarySortButtons: pane.querySelectorAll('[data-library-sort-key]'),
      statusEl: document.getElementById('music-player-status-text'),
      statusBarEl: document.getElementById('music-player-status'),
      treeEl: document.getElementById('music-library-tree'),
      libraryPane: document.getElementById('music-library-pane'),
      libraryPlaylistResizer: document.getElementById('music-resizer-library-playlist'),
      playlistListEl: document.getElementById('music-playlist-list'),
      playlistTableEl: document.getElementById('music-playlist-table'),
      playlistPane: document.getElementById('music-playlist-pane'),
      playlistPlaybackResizer: document.getElementById('music-resizer-playlist-playback'),
      activePlaylistNameEl: document.getElementById('music-active-playlist-name'),
      playlistImportButton: document.getElementById('music-playlist-import'),
      playlistExportButton: document.getElementById('music-playlist-export'),
      playlistRenameButton: document.getElementById('music-playlist-rename'),
      playlistLoadButton: document.getElementById('music-playlist-load'),
      playlistSaveButton: document.getElementById('music-playlist-save'),
      playlistImportInput: document.getElementById('music-playlist-import-input'),
      playlistSaveToast: document.getElementById('music-playlist-save-toast'),
      playlistSaveToastText: document.getElementById('music-playlist-save-toast-text'),
      playlistSaveToastCloseButton: document.getElementById('music-playlist-save-toast-close'),
      playlistRenameDialog: document.getElementById('music-playlist-rename-dialog'),
      playlistRenameTitleEl: document.getElementById('music-playlist-rename-title'),
      playlistRenameInput: document.getElementById('music-playlist-rename-input'),
      playlistRenameCancelButton: document.getElementById('music-playlist-rename-cancel'),
      playlistRenameConfirmButton: document.getElementById('music-playlist-rename-confirm'),
      playlistOverwriteDialog: document.getElementById('music-playlist-overwrite-dialog'),
      playlistOverwriteMessageEl: document.getElementById('music-playlist-overwrite-message'),
      playlistOverwriteCancelButton: document.getElementById('music-playlist-overwrite-cancel'),
      playlistOverwriteConfirmButton: document.getElementById('music-playlist-overwrite-confirm'),
      playlistLoadDialog: document.getElementById('music-playlist-load-dialog'),
      playlistLoadTitleEl: document.getElementById('music-playlist-load-title'),
      playlistLoadFilterInput: document.getElementById('music-playlist-load-filter-input'),
      playlistLoadListEl: document.getElementById('music-playlist-load-list'),
      playlistLoadNewButton: document.getElementById('music-playlist-load-new'),
      playlistLoadCancelButton: document.getElementById('music-playlist-load-cancel'),
      playlistLoadConfirmButton: document.getElementById('music-playlist-load-confirm'),
      playlistLoadSortButtons: pane.querySelectorAll('[data-playlist-sort-key]'),
      playlistLoadMenu: document.getElementById('music-playlist-load-context-menu'),
      libraryMenu: document.getElementById('music-library-context-menu'),
      playlistMenu: document.getElementById('music-playlist-context-menu'),
      playbackPane: document.getElementById('music-playback-pane'),
      audio: document.getElementById('music-audio'),
      currentFilenameEl: document.getElementById('music-current-filename'),
      songTitleEl: document.getElementById('music-song-title'),
      songArtistEl: document.getElementById('music-song-artist'),
      coverArtEl: document.getElementById('music-cover-art'),
      artPlaceholderEl: document.getElementById('music-art-placeholder'),
      progressSlider: document.getElementById('music-progress-slider'),
      elapsedTimeEl: document.getElementById('music-elapsed-time'),
      totalTimeEl: document.getElementById('music-total-time'),
      volumeSlider: document.getElementById('music-volume-slider'),
      playButton: document.getElementById('music-play'),
      pauseButton: document.getElementById('music-pause'),
      nextButton: document.getElementById('music-next'),
      prevButton: document.getElementById('music-prev'),
      shuffleButton: document.getElementById('music-shuffle-toggle'),
      loopButton: document.getElementById('music-loop-toggle'),
      controls: pane.querySelector('.music-player-controls')
    },
    state: {
      currentFolder: document.body.dataset.currentFolderPath || '',
      loadButtonDefaultText: '',
      defaultPollDelayMs: defaultPollDelayMs,
      pollTimer: null,
      loadTimer: null,
      libraryPollingActive: false,
      lastLibraryPollResponseAt: 0,
      libraryPollSequence: 0,
      libraryRequested: false,
      loading: false,
      libraryRoot: '',
      librarySnapshot: null,
      expandedIds: Object.create(null),
      selectedIds: Object.create(null),
      visibleNodeIds: [],
      selectionAnchor: null,
      librarySortKey: 'name',
      librarySortDirection: 'asc',
      librarySortSettingKey: 'music-library-sort',
      contextNodeId: null,
      playlistStore: null,
      activePlaylist: null,
      persistedPlaylists: [],
      playlist: [],
      playlistRemotePaths: Object.create(null),
      selectedPlaylistRemotePaths: Object.create(null),
      playlistSelectionAnchor: null,
      playlistContextRemotePath: null,
      activePlaylistSavedName: null,
      activePlaylistSavedSignature: '',
      activePlaylistDirty: false,
      playlistRenameMode: 'rename',
      playlistLoadSortKey: 'last_modified',
      playlistLoadSortDirection: 'desc',
      playlistLoadSortSettingKey: 'music-playlist-load-sort',
      playlistLoadFilterText: '',
      playlistLoadFilterSettingKey: 'music-playlist-load-filter',
      selectedPersistedPlaylistName: null,
      playlistLoadContextName: null,
      pendingPlaylistConfirmAction: null,
      playlistSaveToastTimer: null,
      currentPlaylistIndex: -1,
      musicPaneWidthSettingKey: 'music-pane-widths',
      playlistColumnWidthSettingKey: 'music-playlist-column-widths',
      defaultPlaylistColumnWidths: {filename: 220, path: 340, reorder: 56},
      musicPaneResizerWidth: 8,
      defaultMusicPanePercents: [35, 38.333333, 26.666667],
      minMusicPaneWidthsPx: [190, 210, 220],
      currentMusicPanePercents: [35, 38.333333, 26.666667],
      shuffleEnabled: false,
      loopPlaylist: false,
      shuffleBag: [],
      shuffleSequence: [],
      shuffleCursor: -1,
      scrubberDragging: false,
      defaultVolume: 1,
      metadataRequestId: 0,
      metadataLoadedRemotePath: null,
      metadataChunkSize: 262144,
      currentArtObjectUrl: null,
      pendingArtworkRemotePath: null,
      windowFocused: document.hasFocus ? document.hasFocus() : true,
      metadataTitleLoading: 'Loading title...',
      metadataArtistLoading: 'Loading artist...',
      metadataTitleUnknown: 'Title unavailable',
      metadataArtistUnknown: 'Artist unavailable',
      marqueeRefreshToken: 0,
      defaultShuffleEnabled: false,
      defaultLoopPlaylist: false,
      playbackLoadRetryLimit: 3,
      playbackLoadRetryDelayMs: 750,
      playbackLoadRetryCount: 0,
      playbackRetryTimer: null,
      playbackRetryRemotePath: null,
      playbackUiThrottleMs: 1000,
      playbackUiPaintTimer: null,
      playbackUiLastPaintMs: 0,
      playbackDurationDirty: false,
      playbackCurrentTimeDirty: false,
      libraryRenderDirty: false,
      pendingLibraryStatusText: null,
      playlistRenderDirty: false,
      playlistSelectionDirty: false,
      pendingPlaylistFocusRemotePath: null
    },
    playlistApi: null,
    playbackApi: null,
    libraryApi: null,
    layoutApi: null,
    setStatus: function (text) {
      if (!ctx.els.statusEl) return;
      ctx.els.statusEl.textContent = text;
    },
    setPlayerStatusBarVisible: function (visible) {
      if (!ctx.els.statusBarEl) return;
      ctx.els.statusBarEl.hidden = !visible;
      ctx.els.statusBarEl.classList.toggle('hidden', !visible);
      ctx.els.statusBarEl.classList.toggle('is-visible', visible);
    },
    setLibraryStatus: function (text) {
      ctx.state.pendingLibraryStatusText = text;
      if (!ctx.layoutApi || !ctx.layoutApi.playbackUiMayPaint()) return;
      ctx.setStatus(ctx.state.pendingLibraryStatusText);
      ctx.state.pendingLibraryStatusText = null;
    },
    syncPlaylistState: function () {
      ctx.state.activePlaylist = ctx.state.playlistStore.activePlaylist;
      ctx.state.persistedPlaylists = ctx.state.playlistStore.persistedPlaylists;
      ctx.state.playlist = ctx.state.activePlaylist.songs;
      ctx.state.playlistRemotePaths = ctx.state.activePlaylist.absolutePathSet;
    }
  };

  ctx.state.playlistStore = new PlaylistStore({storage: Settings});
  ctx.syncPlaylistState();
  ctx.state.loadButtonDefaultText = ctx.els.loadButton.textContent || 'Load Current Folder';
  ctx.state.libraryRoot = ctx.state.currentFolder;
  pane.setAttribute('data-player-ready', 'library');
  if (ctx.els.controls) ctx.els.controls.setAttribute('data-controls-ready', 'markup');

  initLayout(ctx);
  initPlaylist(ctx);
  initPlayback(ctx);
  initLibrary(ctx);

  document.addEventListener('click', function () {
    ctx.libraryApi.hideLibraryContextMenu();
    ctx.playlistApi.hidePlaylistContextMenu();
    ctx.playlistApi.hidePlaylistLoadContextMenu();
  });
  window.addEventListener('blur', function () {
    ctx.libraryApi.hideLibraryContextMenu();
    ctx.playlistApi.hidePlaylistContextMenu();
    ctx.playlistApi.hidePlaylistLoadContextMenu();
  });

  function syncPlayerStatusBarForPaneMode(mode) {
    var musicPlayerActive = mode === 'music-player';
    ctx.setPlayerStatusBarVisible(musicPlayerActive);
    if (musicPlayerActive && ctx.state.pendingLibraryStatusText !== null) {
      ctx.setStatus(ctx.state.pendingLibraryStatusText);
      ctx.state.pendingLibraryStatusText = null;
    }
  }

  window.addEventListener('bottom-pane-mode-changed', function (ev) {
    if (!ev.detail) return;
    syncPlayerStatusBarForPaneMode(ev.detail.mode);
    if (ev.detail.mode === 'music-player') {
      ctx.layoutApi.applyMusicPanePercents(ctx.layoutApi.readSavedMusicPanePercents(), false);
      ctx.layoutApi.refreshPlaylistColumnWidths(false);
      ctx.layoutApi.flushDeferredMusicPaneUpdates();
      ctx.layoutApi.resumeLibraryUpdates();
      ctx.playbackApi.repaintPlaybackDisplay();
    }
    else {
      ctx.libraryApi.stopPolling();
      ctx.layoutApi.clearPlaybackUiPaintTimer();
    }
    ctx.playbackApi.metadata.scheduleNowPlayingMarqueeRefresh();
  });

  syncPlayerStatusBarForPaneMode(Settings.get('bottom-pane-mode', 'server-log'));

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) {
      ctx.layoutApi.flushDeferredMusicPaneUpdates();
      ctx.layoutApi.resumeLibraryUpdates();
      ctx.playbackApi.repaintPlaybackDisplay();
      ctx.state.windowFocused = document.hasFocus ? document.hasFocus() : true;
      ctx.playbackApi.metadata.resumeDeferredArtworkLoad();
    }
    else {
      ctx.state.windowFocused = false;
      ctx.libraryApi.stopPolling();
      ctx.layoutApi.clearPlaybackUiPaintTimer();
    }
  });
  window.addEventListener('focus', function () {
    ctx.state.windowFocused = true;
    ctx.layoutApi.flushDeferredMusicPaneUpdates();
    ctx.playbackApi.repaintPlaybackDisplay();
    ctx.playbackApi.metadata.resumeDeferredArtworkLoad();
  });
  window.addEventListener('blur', function () {
    ctx.state.windowFocused = false;
  });
  window.addEventListener('resize', function () {
    ctx.layoutApi.applyMusicPanePercents(ctx.state.currentMusicPanePercents, false);
    ctx.playbackApi.metadata.scheduleNowPlayingMarqueeRefresh();
  });
  window.addEventListener('beforeunload', function () {
    ctx.layoutApi.clearPlaybackUiPaintTimer();
    ctx.libraryApi.stopPolling();
  });

  window.addEventListener('browse-folder-changed', function (ev) {
    var detail = ev && ev.detail ? ev.detail : {};
    var nextPath = typeof detail.path === 'string' ? detail.path : '';
    if (nextPath === ctx.state.currentFolder) return;
    ctx.state.currentFolder = nextPath;
    ctx.libraryApi.resetLibraryForCurrentFolder();
  });

  if (ctx.els.coverArtEl) {
    ctx.els.coverArtEl.addEventListener('click', function () {
      if (!ctx.state.currentArtObjectUrl) return;
      window.open(ctx.state.currentArtObjectUrl, '_blank', 'noopener');
    });
  }

  ctx.libraryApi.resetLibraryForCurrentFolder();
  ctx.layoutApi.applyMusicPanePercents(ctx.layoutApi.readSavedMusicPanePercents(), false);
  ctx.layoutApi.refreshPlaylistColumnWidths(false);
  ctx.playbackApi.resetProgressDisplay();
  ctx.playbackApi.metadata.showUnknownMetadata();
  ctx.playbackApi.restoreVolume();
  ctx.playbackApi.restoreShuffleEnabled();
  ctx.playbackApi.restoreLoopPlaylist();
  ctx.playbackApi.setPlayPauseVisualState(false);
  ctx.playbackApi.updateModeButtons();
  ctx.playlistApi.renderPlaylist();
  ctx.playbackApi.metadata.scheduleNowPlayingMarqueeRefresh();
}());
