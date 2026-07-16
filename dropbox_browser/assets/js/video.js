import {advanceQueueAfterPlaybackEnd} from './video-core.js';
import {initLayout} from './media-library/layout.js';
import {initPlaylist} from './media-library/playlist.js';
import {initLibrary as initMediaLibrary} from './media-library/library.js';
import {PlaylistStore} from './media-library/playlist-store.js';
import {initShared} from './video/shared.js';
import {initCache} from './video/cache.js';
import {initDiagnostics} from './video/diagnostics.js';
import {initMediaLibraryBridge} from './video/media-library-bridge.js';
import {initProbe} from './video/probe.js';
import {initTracks} from './video/tracks.js';
import {initCompatibility} from './video/compatibility.js';
import {initSubtitles} from './video/subtitles.js';
import {initControls} from './video/controls.js';
import {initPlayback} from './video/playback.js';
import {initPane} from './video/pane.js';

(function () {
  var pane = document.getElementById('video-player-pane');
  var body = document.body;
  var pollDelayAttr = body ? (body.dataset.musicLibraryPollDelayMs || body.dataset.videoLibraryPollDelayMs || '') : '';
  var parsedPollDelayMs = Number.parseInt(pollDelayAttr || '', 10);
  var defaultPollDelayMs = Number.isFinite(parsedPollDelayMs) && parsedPollDelayMs > 0
    ? parsedPollDelayMs
    : 4000;
  if (!pane) return;

  function createVideoClientId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return 'video-client-' + window.crypto.randomUUID();
    }
    return 'video-client-'
      + Date.now().toString(36)
      + '-'
      + Math.random().toString(36).slice(2, 10);
  }

  function readVideoSetting(key, fallback) {
    try {
      if (typeof Settings === 'undefined' || !Settings || typeof Settings.get !== 'function') return fallback;
      return Settings.get(key, fallback);
    }
    catch (_error) {
      return fallback;
    }
  }

  function writeVideoSetting(key, value) {
    try {
      if (typeof Settings === 'undefined' || !Settings || typeof Settings.set !== 'function') return;
      Settings.set(key, value);
    }
    catch (_error) {
      // Test contexts may provide partial Settings shims.
    }
  }

  var ctx = {
    pane: pane,
    mediaLibraryConfig: {
      libraryEndpoint: '/video/endpoints/library',
      itemNounSingular: 'video',
      itemNounPlural: 'videos',
      emptyLibraryText: 'Load the current folder to show cached videos.',
      emptyLibraryNoItemsText: 'No supported cached videos found in this folder yet.',
      loadingLibraryText: 'Loading cached video library...',
      libraryTitle: 'Video Library',
      playlistTitlePrefix: 'Active Playlist:'
    },
    els: {
      statusEl: document.getElementById('video-player-status'),
      playbackTitleEl: document.getElementById('video-playback-title'),
      titleEl: document.getElementById('video-current-title'),
      metaEl: document.getElementById('video-current-meta'),
      placeholderEl: document.getElementById('video-playback-placeholder'),
      playbackSurfaceEl: document.getElementById('video-playback-surface'),
      playbackStageEl: document.getElementById('video-playback-stage'),
      loadingOverlayEl: document.getElementById('video-loading-overlay'),
      loadingTitleEl: document.getElementById('video-loading-title'),
      loadingMetaEl: document.getElementById('video-loading-meta'),
      loadingProgressEl: document.getElementById('video-loading-progress-fill'),
      loadingProgressLabelEl: document.getElementById('video-loading-progress-label'),
      subtitleStatusBannerEl: document.getElementById('video-subtitle-status-banner'),
      subtitleStatusTitleEl: document.getElementById('video-subtitle-status-title'),
      subtitleStatusMetaEl: document.getElementById('video-subtitle-status-meta'),
      controlsOverlayEl: document.getElementById('video-controls-overlay'),
      videoEl: document.getElementById('video-player-media'),
      subtitleOverlayEl: document.getElementById('video-subtitle-overlay'),
      playToggleButton: document.getElementById('video-play-toggle'),
      muteToggleButton: document.getElementById('video-mute-toggle'),
      volumeSliderEl: document.getElementById('video-volume-slider'),
      fullscreenButton: document.getElementById('video-fullscreen-toggle'),
      fullWindowButton: document.getElementById('video-full-window-toggle'),
      shuffleButton: document.getElementById('video-shuffle-toggle'),
      loopButton: document.getElementById('video-loop-toggle'),
      previousButton: document.getElementById('video-previous'),
      nextButton: document.getElementById('video-next'),
      back15Button: document.getElementById('video-back-15'),
      forward15Button: document.getElementById('video-forward-15'),
      progressSliderEl: document.getElementById('video-progress-slider'),
      elapsedTimeEl: document.getElementById('video-elapsed-time'),
      totalTimeEl: document.getElementById('video-total-time'),
      trackPanelEl: document.getElementById('video-track-panel'),
      audioTrackSelectEl: document.getElementById('video-audio-track'),
      audioTrackSummaryEl: document.getElementById('video-audio-track-summary'),
      subtitleTrackSelectEl: document.getElementById('video-subtitle-track'),
      subtitleTrackSummaryEl: document.getElementById('video-subtitle-track-summary'),
      subtitleStyleControlsEl: document.getElementById('video-subtitle-style-controls'),
      subtitleShadowEnabledEl: document.getElementById('video-subtitle-shadow-enabled'),
      subtitleStrokeEnabledEl: document.getElementById('video-subtitle-stroke-enabled'),
      subtitleFontSizeInputEl: document.getElementById('video-subtitle-font-size'),
      subtitleOffsetInputEl: document.getElementById('video-subtitle-offset'),
      subtitleStyleResetButtonEl: document.getElementById('video-subtitle-style-reset'),
      subtitleStyleApplyButtonEl: document.getElementById('video-subtitle-style-apply'),
      debugPanelEl: document.getElementById('video-debug-panel'),
      debugActionsEl: document.getElementById('video-debug-actions'),
      clearCacheButtonEl: document.getElementById('video-clear-cache-button'),
      debugMetaEl: document.getElementById('video-debug-meta'),
      debugCurrentTitleEl: document.getElementById('video-debug-current-title'),
      debugCurrentCueEl: document.getElementById('video-debug-current-cue'),
      debugNextTitleEl: document.getElementById('video-debug-next-title'),
      debugNextCueEl: document.getElementById('video-debug-next-cue'),
      // Shared media-library DOM
      playerShell: pane.querySelector('.video-player-shell'),
      loadButton: document.getElementById('video-library-load'),
      librarySortButtons: pane.querySelectorAll('[data-library-sort-key]'),
      treeEl: document.getElementById('video-library-tree'),
      libraryPane: document.getElementById('video-library-pane'),
      libraryPlaylistResizer: document.getElementById('video-resizer-library-playlist'),
      playlistListEl: document.getElementById('video-playlist-list'),
      playlistTableEl: document.getElementById('video-playlist-table'),
      playlistPane: document.getElementById('video-playlist-pane'),
      playlistPlaybackResizer: document.getElementById('video-resizer-playlist-playback'),
      activePlaylistNameEl: document.getElementById('video-active-playlist-name'),
      playlistImportButton: document.getElementById('video-playlist-import'),
      playlistExportButton: document.getElementById('video-playlist-export'),
      playlistRenameButton: document.getElementById('video-playlist-rename'),
      playlistLoadButton: document.getElementById('video-playlist-load'),
      playlistSaveButton: document.getElementById('video-playlist-save'),
      playlistImportInput: document.getElementById('video-playlist-import-input'),
      playlistSaveToast: document.getElementById('video-playlist-save-toast'),
      playlistSaveToastText: document.getElementById('video-playlist-save-toast-text'),
      playlistSaveToastCloseButton: document.getElementById('video-playlist-save-toast-close'),
      playlistRenameDialog: document.getElementById('video-playlist-rename-dialog'),
      playlistRenameTitleEl: document.getElementById('video-playlist-rename-title'),
      playlistRenameInput: document.getElementById('video-playlist-rename-input'),
      playlistRenameCancelButton: document.getElementById('video-playlist-rename-cancel'),
      playlistRenameConfirmButton: document.getElementById('video-playlist-rename-confirm'),
      playlistOverwriteDialog: document.getElementById('video-playlist-overwrite-dialog'),
      playlistOverwriteMessageEl: document.getElementById('video-playlist-overwrite-message'),
      playlistOverwriteCancelButton: document.getElementById('video-playlist-overwrite-cancel'),
      playlistOverwriteConfirmButton: document.getElementById('video-playlist-overwrite-confirm'),
      playlistLoadDialog: document.getElementById('video-playlist-load-dialog'),
      playlistLoadFilterInput: document.getElementById('video-playlist-load-filter-input'),
      playlistLoadListEl: document.getElementById('video-playlist-load-list'),
      playlistLoadNewButton: document.getElementById('video-playlist-load-new'),
      playlistLoadCancelButton: document.getElementById('video-playlist-load-cancel'),
      playlistLoadConfirmButton: document.getElementById('video-playlist-load-confirm'),
      playlistLoadSortButtons: pane.querySelectorAll('[data-playlist-sort-key]'),
      playlistLoadMenu: document.getElementById('video-playlist-load-context-menu'),
      libraryMenu: document.getElementById('video-library-context-menu'),
      playlistMenu: document.getElementById('video-playlist-context-menu'),
      playbackPane: document.getElementById('video-playback-pane'),
    },
    state: {
      paneActive: false,
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
      librarySortSettingKey: 'video-library-sort',
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
      playlistLoadSortSettingKey: 'video-playlist-load-sort',
      playlistLoadFilterText: '',
      playlistLoadFilterSettingKey: 'video-playlist-load-filter',
      selectedPersistedPlaylistName: null,
      playlistLoadContextName: null,
      pendingPlaylistConfirmAction: null,
      playlistSaveToastTimer: null,
      currentPlaylistIndex: -1,
      musicPaneWidthSettingKey: 'video-media-library-pane-widths',
      playlistColumnWidthSettingKey: 'video-playlist-column-widths',
      defaultPlaylistColumnWidths: {filename: 220, path: 340, reorder: 56},
      musicPaneResizerWidth: 8,
      defaultMusicPanePercents: [28, 28, 44],
      minMusicPaneWidthsPx: [160, 180, 280],
      currentMusicPanePercents: [28, 28, 44],
      shuffleEnabled: false,
      loopPlaylist: false,
      shuffleBag: [],
      shuffleSequence: [],
      shuffleCursor: -1,
      libraryRenderDirty: false,
      pendingLibraryStatusText: null,
      playlistRenderDirty: false,
      playlistSelectionDirty: false,
      pendingPlaylistFocusRemotePath: null,
      libraryItems: [],
      selectedLibraryPaths: Object.create(null),
      queue: [],
      selectedQueueIndex: -1,
      activeQueueIndex: -1,
      loopQueue: false,
      loopQueueSettingKey: 'video-loop-queue',
      loadingLibrary: false,
      loadingPlaybackStatus: false,
      playbackStatusLoaded: false,
      compatibilityAvailable: false,
      ffmpegAvailable: false,
      ffprobeAvailable: false,
      videoClientId: createVideoClientId(),
      backpressureThresholds: {
        lowWaterSeconds: 45,
        mediumWaterSeconds: 120,
        highWaterSeconds: 300,
        maxWaterSeconds: 600,
      },
      playbackMode: 'none',
      lastPlaybackPath: '',
      pendingAutoplay: false,
      transportWantsPlay: false,
      compatibilitySessionId: '',
      compatibilitySessionPath: '',
      compatibilityAudioStreamIndex: null,
      compatibilitySessionBurnedInSubtitleStreamIndex: null,
      compatibilitySessionVideoMode: '',
      compatibilitySessionVideoModeReason: '',
      compatibilitySessionAudioMode: '',
      compatibilitySessionAudioModeReason: '',
      compatibilityEncodedMediaEndSeconds: 0,
      compatibilitySegmentDurationSeconds: 0,
      compatibilityPlaylistSegmentCount: 0,
      compatibilityCurrentSegmentIndex: 0,
      compatibilityLoadedSegmentMinIndex: 0,
      compatibilityLoadedSegmentMaxIndex: 0,
      compatibilityLoadedSegmentIndicesByKey: Object.create(null),
      compatibilitySegmentLoadSampleCount: 0,
      compatibilitySegmentLoadAverageMs: 0,
      compatibilitySegmentLoadWindowStartMs: NaN,
      compatibilitySegmentFetchSampleCount: 0,
      compatibilitySegmentFetchAverageMs: 0,
      hlsController: null,
      compatibilityRecoveryAttempts: 0,
      compatibilityRecoveryTimer: 0,
      compatibilityRecoveryScheduled: false,
      compatibilityStartSeconds: 0,
      compatibilityBufferedFragmentCount: 0,
      compatibilitySessionStatusRequestInFlight: false,
      compatibilitySessionStatusTimer: 0,
      compatibilitySessionProgressRequestInFlight: false,
      compatibilitySessionProgressTimer: 0,
      compatibilitySessionProgressPendingImmediate: false,
      compatibilityProgressBurstUntilMs: 0,
      compatibilityPlaybackRevealed: false,
      compatibilityPlaybackRevealPending: false,
      compatibilitySubtitleWaitStageActive: false,
      compatibilitySubtitleStreamIndex: null,
      requestedSeekSeconds: null,
      seekRestartInProgress: false,
      pendingSubtitleStyleApply: false,
      playbackSyncToken: 0,
      probeCache: Object.create(null),
      probeFailures: Object.create(null),
      selectedAudioStreamIndexByPath: Object.create(null),
      selectedSubtitleStreamIndexByPath: Object.create(null),
      subtitleStyleDraft: null,
      subtitleStyleApplied: null,
      audioTrackPreferenceByLayout: Object.create(null),
      subtitleTrackPreferenceByLayout: Object.create(null),
      subtitleFullVttCacheByPath: Object.create(null),
      subtitleWarmInFlightByPath: Object.create(null),
      subtitleWindowCacheByPath: Object.create(null),
      subtitleWindowInFlightByPath: Object.create(null),
      subtitleCoverageByPath: Object.create(null),
      subtitleBackgroundCoverageByPath: Object.create(null),
      subtitleMountedWindowByPath: Object.create(null),
      subtitleObjectUrls: [],
      subtitleMountState: {
        mode: 'none',
        path: '',
        streamIndex: null,
        seekSeconds: 0,
        coverageStartSeconds: null,
        coverageEndSeconds: null,
        playbackSyncToken: null,
        generation: 0,
      },
      subtitlePlaybackRefreshInFlightKey: '',
      subtitlePlaybackSyncState: {
        path: '',
        streamIndex: null,
        mountedSeekSeconds: 0,
        playbackSyncToken: null,
        mountGeneration: 0,
        outsideCoverageObserved: false,
      },
      subtitleDebug: {
        rawVtt: '',
        cues: [],
        fetchStartSeconds: 0,
        streamIndex: '',
        trackLabel: '',
        lastLoggedCueKey: '',
      },
      progressSliderActive: false,
      controlsIdleTimer: 0,
      controlsOverlayVisible: false,
      loadingOverlayVisible: false,
      loadingOverlayMeta: '',
      compatibilityManifestStallTimer: 0,
      playbackTiming: null,
      lastControlsRevealPointerKey: '',
      controlsScrubReveal: false,
      subtitleFailureState: 'idle',
      // Full-window layout mode (CSS viewport takeover; not native fullscreen).
      // See docs/video-player.md "Playback Layout Modes".
      fullWindowActive: false,
      // Session-only preferred expanded mode for double-click from embedded:
      // 'fullscreen' (native Fullscreen API, default) | 'full-window'.
      preferredExpandedMode: 'fullscreen',
      // Pre-entry --log-panel-height (px number) restored on full-window exit.
      savedLogPanelHeight: null,
    },
    setStatus: function (text) {
      if (ctx.els.statusEl) ctx.els.statusEl.textContent = text;
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
      if (typeof ctx.syncQueueFromPlaylist === 'function') ctx.syncQueueFromPlaylist();
    },
    readVideoSetting: readVideoSetting,
    writeVideoSetting: writeVideoSetting,
    playlistApi: null,
    libraryApi: null,
    layoutApi: null,
  };

  ctx.state.playlistStore = new PlaylistStore({
    storage: typeof Settings !== 'undefined' ? Settings : null,
    storageKey: 'video-playlists',
  });
  ctx.syncPlaylistState();
  if (ctx.els.loadButton) {
    ctx.state.loadButtonDefaultText = ctx.els.loadButton.textContent || 'Load Current Folder';
  }
  ctx.state.libraryRoot = ctx.state.currentFolder;

  initShared(ctx);
  initCache(ctx);
  initDiagnostics(ctx);
  initMediaLibraryBridge(ctx);
  initLayout(ctx);
  initPlaylist(ctx);
  initProbe(ctx);
  initTracks(ctx);
  initCompatibility(ctx);
  initSubtitles(ctx);
  initControls(ctx);
  initPlayback(ctx);
  ctx.extendMediaLibraryPlaybackApi();
  initMediaLibrary(ctx);
  initPane(ctx);

  // Compatibility shims for modules still calling renderQueue / loadLibrary.
  ctx.renderQueue = function () {
    if (ctx.playlistApi && typeof ctx.playlistApi.renderPlaylist === 'function') {
      ctx.playlistApi.renderPlaylist();
    }
  };
  ctx.loadLibrary = function (path) {
    if (path != null && path !== '') ctx.state.libraryRoot = path;
    else ctx.state.libraryRoot = ctx.state.currentFolder || ctx.currentFolderPath() || '';
    ctx.state.libraryRequested = true;
    ctx.state.librarySnapshot = null;
    ctx.state.libraryPollSequence = 0;
    if (ctx.libraryApi && typeof ctx.libraryApi.startLibraryPollingUi === 'function') {
      ctx.libraryApi.startLibraryPollingUi();
    }
    if (ctx.libraryApi && typeof ctx.libraryApi.fetchLibrary === 'function') {
      ctx.libraryApi.fetchLibrary(false, 0);
    }
  };
  ctx.renderLibrary = function () {
    if (ctx.libraryApi && typeof ctx.libraryApi.renderLibrary === 'function') {
      ctx.libraryApi.renderLibrary();
    }
  };

  pane.setAttribute('data-video-player-ready', 'subtitles');
  ctx.restoreVideoLoopQueue();
  ctx.restoreVideoShuffle();
  ctx.state.loopPlaylist = !!ctx.state.loopQueue;
  ctx.state.audioTrackPreferenceByLayout = ctx.loadStoredTrackPreferences('dropbox-browser-video-audio-track-preferences');
  ctx.state.subtitleTrackPreferenceByLayout = ctx.loadStoredTrackPreferences('dropbox-browser-video-subtitle-track-preferences');
  ctx.updateCurrentFolder(ctx.currentFolderPath());
  ctx.renderAudioTrackSelector(null, null);
  ctx.renderSubtitleTrackSelector(null, null);
  ctx.syncTrackSummary();
  if (ctx.els.videoEl) {
    ctx.els.videoEl.controls = false;
    ctx.els.videoEl.removeAttribute('controls');
  }
  ctx.resetPlaybackProgress();
  void ctx.playbackApi.syncForActiveItem();
  ctx.renderLibrary();
  ctx.renderQueue();

  document.addEventListener('click', function () {
    if (ctx.libraryApi && ctx.libraryApi.hideLibraryContextMenu) ctx.libraryApi.hideLibraryContextMenu();
    if (ctx.playlistApi && ctx.playlistApi.hidePlaylistContextMenu) ctx.playlistApi.hidePlaylistContextMenu();
    if (ctx.playlistApi && ctx.playlistApi.hidePlaylistLoadContextMenu) ctx.playlistApi.hidePlaylistLoadContextMenu();
  });

  if (ctx.els.shuffleButton) {
    ctx.els.shuffleButton.addEventListener('click', function () {
      ctx.toggleVideoShuffle();
    });
  }

  window.addEventListener('bottom-pane-mode-changed', function (ev) {
    if (!ev.detail) return;
    ctx.paneApi.syncPaneMode(ev.detail.mode);
  });

  window.addEventListener('browse-folder-changed', function (ev) {
    var detail = ev && ev.detail ? ev.detail : {};
    var nextPath = typeof detail.path === 'string' ? detail.path : ctx.currentFolderPath();
    if (nextPath === ctx.state.currentFolder) return;
    ctx.updateCurrentFolder(nextPath);
    // Same as music: folder change clears the tree until the user loads again.
    if (ctx.libraryApi && typeof ctx.libraryApi.resetLibraryForCurrentFolder === 'function') {
      ctx.libraryApi.resetLibraryForCurrentFolder();
    }
  });

  function stopVideoSessionOnUnload() {
    ctx.clearCompatibilityRecoveryTimer();
    var unloadSessionId = String(ctx.state.compatibilitySessionId || '');
    void ctx.compatibilityApi.stopSession(unloadSessionId, {
      unloadSafe: true,
      transitionToken: ctx.state.playbackSyncToken,
    });
  }

  window.addEventListener('pagehide', stopVideoSessionOnUnload);
  window.addEventListener('beforeunload', stopVideoSessionOnUnload);

  pane.addEventListener('video-playback-ended', function () {
    if (ctx.state.activeQueueIndex < 0 && ctx.state.currentPlaylistIndex < 0) return;
    if (typeof ctx.playNextFromPlaylist === 'function' && (ctx.state.playlist || []).length) {
      ctx.playNextFromPlaylist();
      return;
    }
    ctx.state.activeQueueIndex = advanceQueueAfterPlaybackEnd(
      ctx.state.queue.length,
      ctx.state.activeQueueIndex,
      ctx.state.loopQueue
    );
    if (ctx.state.activeQueueIndex >= 0) {
      ctx.state.selectedQueueIndex = ctx.state.activeQueueIndex;
      ctx.state.currentPlaylistIndex = ctx.state.activeQueueIndex;
      ctx.state.pendingAutoplay = true;
      ctx.state.transportWantsPlay = true;
    }
    ctx.renderQueue();
  });

  ctx.paneApi.syncPaneMode(ctx.readVideoSetting('bottom-pane-mode', 'server-log'));
}());
