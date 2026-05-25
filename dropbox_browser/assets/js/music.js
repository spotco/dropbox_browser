import {initLayout} from './music-layout.js';
import {initPlaylist} from './music-playlist.js';
import {initPlayback} from './music-playback.js';
import {initLibrary} from './music-library.js';

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
    els: {
      playerShell: pane.querySelector('.music-player-shell'),
      loadButton: document.getElementById('music-library-load'),
      librarySortButtons: pane.querySelectorAll('[data-library-sort-key]'),
      statusEl: document.getElementById('music-library-status-text'),
      treeEl: document.getElementById('music-library-tree'),
      libraryPane: document.getElementById('music-library-pane'),
      libraryPlaylistResizer: document.getElementById('music-resizer-library-playlist'),
      playlistListEl: document.getElementById('music-playlist-list'),
      playlistPane: document.getElementById('music-playlist-pane'),
      playlistPlaybackResizer: document.getElementById('music-resizer-playlist-playback'),
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
      playlist: [],
      playlistRemotePaths: Object.create(null),
      selectedPlaylistRemotePaths: Object.create(null),
      playlistSelectionAnchor: null,
      playlistContextRemotePath: null,
      currentPlaylistIndex: -1,
      musicPaneWidthSettingKey: 'music-pane-widths',
      musicPaneResizerWidth: 8,
      defaultMusicPanePercents: [35, 38.333333, 26.666667],
      minMusicPaneWidthsPx: [190, 210, 220],
      currentMusicPanePercents: [35, 38.333333, 26.666667],
      shuffleEnabled: false,
      loopPlaylist: false,
      shuffleBag: [],
      scrubberDragging: false,
      defaultVolume: 1,
      metadataRequestId: 0,
      metadataLoadedRemotePath: null,
      metadataChunkSize: 262144,
      currentArtObjectUrl: null,
      metadataTitleLoading: 'Loading title...',
      metadataArtistLoading: 'Loading artist...',
      metadataTitleUnknown: 'Title unavailable',
      metadataArtistUnknown: 'Artist unavailable',
      marqueeRefreshToken: 0,
      defaultShuffleEnabled: false,
      defaultLoopPlaylist: false,
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
      ctx.els.statusEl.textContent = text;
    },
    setLibraryStatus: function (text) {
      ctx.state.pendingLibraryStatusText = text;
      if (!ctx.layoutApi || !ctx.layoutApi.playbackUiMayPaint()) return;
      ctx.setStatus(ctx.state.pendingLibraryStatusText);
      ctx.state.pendingLibraryStatusText = null;
    }
  };

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
  });
  window.addEventListener('blur', function () {
    ctx.libraryApi.hideLibraryContextMenu();
    ctx.playlistApi.hidePlaylistContextMenu();
  });

  window.addEventListener('bottom-pane-mode-changed', function (ev) {
    if (!ev.detail) return;
    if (ev.detail.mode === 'music-player') {
      ctx.layoutApi.applyMusicPanePercents(ctx.layoutApi.readSavedMusicPanePercents(), false);
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

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) {
      ctx.layoutApi.flushDeferredMusicPaneUpdates();
      ctx.layoutApi.resumeLibraryUpdates();
      ctx.playbackApi.repaintPlaybackDisplay();
    }
    else {
      ctx.libraryApi.stopPolling();
      ctx.layoutApi.clearPlaybackUiPaintTimer();
    }
  });
  window.addEventListener('focus', function () {
    ctx.layoutApi.flushDeferredMusicPaneUpdates();
    ctx.playbackApi.repaintPlaybackDisplay();
  });
  window.addEventListener('resize', function () {
    ctx.layoutApi.applyMusicPanePercents(ctx.state.currentMusicPanePercents, false);
    ctx.playbackApi.metadata.scheduleNowPlayingMarqueeRefresh();
  });
  window.addEventListener('beforeunload', function () {
    ctx.layoutApi.clearPlaybackUiPaintTimer();
    ctx.libraryApi.stopPolling();
  });

  ctx.libraryApi.resetLibraryForCurrentFolder();
  ctx.layoutApi.applyMusicPanePercents(ctx.layoutApi.readSavedMusicPanePercents(), false);
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
