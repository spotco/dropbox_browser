/**
 * Bridge shared media-library playlist/library modules to video playback.
 * Keeps state.queue + activeQueueIndex in sync for existing video modules.
 */
import {
  resolveNextPlaylistIndex,
  resolvePreviousPlaylistIndex,
  ensureShuffleState,
  rebuildShuffleSequence,
} from '../music/shuffle-helpers.js';
import {setPlaylistPlaybackStatus} from '../media-library/shared.js';

export function initMediaLibraryBridge(ctx) {
  async function loadPlaybackStatus() {
    if (ctx.state.loadingPlaybackStatus) return;
    ctx.state.loadingPlaybackStatus = true;
    try {
      var response = await fetch('/video/endpoints/status');
      if (!response.ok) throw new Error('Failed to load video playback status.');
      var payload = await response.json();
      var thresholds = payload && payload.backpressure_thresholds ? payload.backpressure_thresholds : null;
      ctx.state.playbackStatusLoaded = true;
      ctx.state.ffmpegAvailable = Boolean(payload.ffmpeg_available);
      ctx.state.ffprobeAvailable = Boolean(payload.ffprobe_available);
      ctx.state.compatibilityAvailable = Boolean(payload.compatibility_available);
      ctx.state.backpressureThresholds = {
        lowWaterSeconds: Number(thresholds && thresholds.low_water_seconds) || 45,
        mediumWaterSeconds: Number(thresholds && thresholds.medium_water_seconds) || 120,
        highWaterSeconds: Number(thresholds && thresholds.high_water_seconds) || 300,
        maxWaterSeconds: Number(thresholds && thresholds.max_water_seconds) || 600,
      };
      if (ctx.state.paneActive && typeof ctx.syncPlaybackForActiveItem === 'function') {
        void ctx.syncPlaybackForActiveItem();
      }
    } catch (_error) {
      ctx.state.playbackStatusLoaded = true;
      ctx.state.ffmpegAvailable = false;
      ctx.state.ffprobeAvailable = false;
      ctx.state.compatibilityAvailable = false;
      if (ctx.state.paneActive && typeof ctx.syncPlaybackForActiveItem === 'function') {
        void ctx.syncPlaybackForActiveItem();
      }
    } finally {
      ctx.state.loadingPlaybackStatus = false;
    }
  }

  ctx.loadPlaybackStatus = loadPlaybackStatus;

  function playlistSongToQueueItem(song) {
    if (!song) return null;
    var streamPath = song.stream_path || song.rel_path || '';
    var path = streamPath.replace(/^\/+/, '');
    return {
      display_name: song.display_name || song.filename || path.split('/').pop() || '',
      filename: song.filename || song.display_name || '',
      type: 'file',
      path: path,
      stream_path: path,
      remote_path: song.remote_path || path,
      extension: song.extension || '',
      preview_url: path
        ? ('/file?path=' + encodeURIComponent(path) + '&source=remote')
        : '',
      compatibility_expected: true,
    };
  }

  function syncQueueFromPlaylist() {
    var songs = Array.isArray(ctx.state.playlist) ? ctx.state.playlist : [];
    ctx.state.queue = songs.map(playlistSongToQueueItem).filter(Boolean);
    var index = Number(ctx.state.currentPlaylistIndex);
    // Preserve intentional "nothing playing" (-1). Only clamp invalid positive indexes.
    if (!Number.isInteger(index) || index < -1) {
      ctx.state.currentPlaylistIndex = -1;
      ctx.state.activeQueueIndex = -1;
    } else if (index >= ctx.state.queue.length) {
      ctx.state.currentPlaylistIndex = ctx.state.queue.length ? ctx.state.queue.length - 1 : -1;
      ctx.state.activeQueueIndex = ctx.state.currentPlaylistIndex;
    } else {
      ctx.state.activeQueueIndex = index;
    }
    if (ctx.state.selectedQueueIndex < -1 || ctx.state.selectedQueueIndex >= ctx.state.queue.length) {
      ctx.state.selectedQueueIndex = ctx.state.activeQueueIndex;
    }
  }

  function clearCurrentSong() {
    ctx.state.currentPlaylistIndex = -1;
    ctx.state.activeQueueIndex = -1;
    ctx.state.selectedQueueIndex = -1;
    ctx.state.pendingAutoplay = false;
    ctx.state.transportWantsPlay = false;
    syncQueueFromPlaylist();
    if (ctx.playlistApi && typeof ctx.playlistApi.renderPlaylist === 'function') {
      ctx.playlistApi.renderPlaylist();
    }
    if (ctx.playbackApi && typeof ctx.playbackApi.syncForActiveItem === 'function') {
      void ctx.playbackApi.syncForActiveItem();
    }
  }

  function playPlaylistIndex(index) {
    if (!Number.isInteger(index) || index < 0 || index >= (ctx.state.playlist || []).length) {
      clearCurrentSong();
      return;
    }
    if (ctx.recentApi && typeof ctx.recentApi.recordPlaybackStart === 'function') {
      ctx.recentApi.recordPlaybackStart(
        ctx.state.playlist[index],
        ctx.state.activePlaylist && ctx.state.activePlaylist.name ? ctx.state.activePlaylist.name : 'New Playlist'
      );
    }
    ctx.state.currentPlaylistIndex = index;
    ctx.state.activeQueueIndex = index;
    ctx.state.selectedQueueIndex = index;
    ctx.state.pendingAutoplay = true;
    ctx.state.transportWantsPlay = true;
    syncQueueFromPlaylist();
    if (ctx.playlistApi && typeof ctx.playlistApi.renderPlaylist === 'function') {
      ctx.playlistApi.renderPlaylist();
    }
    setPlaylistPlaybackStatus(ctx, ctx.state.playlist[index]);
    if (ctx.playbackApi && typeof ctx.playbackApi.syncForActiveItem === 'function') {
      void ctx.playbackApi.syncForActiveItem();
    }
  }

  function playPlaylistRemotePath(remotePath) {
    var index = -1;
    if (ctx.playlistApi && typeof ctx.playlistApi.playlistIndexByRemotePath === 'function') {
      index = ctx.playlistApi.playlistIndexByRemotePath(remotePath);
    } else {
      for (var i = 0; i < (ctx.state.playlist || []).length; i += 1) {
        if (ctx.state.playlist[i] && ctx.state.playlist[i].remote_path === remotePath) {
          index = i;
          break;
        }
      }
    }
    if (index >= 0) playPlaylistIndex(index);
  }

  function paintPlaybackDisplay() {
    // Video transport paints itself; layout only needs a no-op hook.
  }

  function metadataExtension(song) {
    if (song && song.extension) return song.extension;
    var name = (song && (song.filename || song.display_name || song.stream_path)) || '';
    var match = /\.[^.]+$/.exec(String(name));
    return match ? match[0].toLowerCase() : '';
  }

  function extendPlaybackApi() {
    var existing = ctx.playbackApi || {};
    ctx.playbackApi = Object.assign({}, existing, {
      clearCurrentSong: clearCurrentSong,
      playPlaylistIndex: playPlaylistIndex,
      playPlaylistRemotePath: playPlaylistRemotePath,
      paintPlaybackDisplay: paintPlaybackDisplay,
      metadata: {
        metadataExtension: metadataExtension,
      },
    });
  }

  function shuffleNavigationInput() {
    return {
      playlistLength: (ctx.state.playlist || []).length,
      currentPlaylistIndex: ctx.state.currentPlaylistIndex,
      shuffleEnabled: !!ctx.state.shuffleEnabled,
      loopPlaylist: !!(ctx.state.loopPlaylist || ctx.state.loopQueue),
      shuffleSequence: ctx.state.shuffleSequence || [],
      shuffleCursor: Number.isInteger(ctx.state.shuffleCursor) ? ctx.state.shuffleCursor : -1,
    };
  }

  function applyShuffleResult(result) {
    ctx.state.shuffleSequence = result.shuffleSequence;
    ctx.state.shuffleCursor = result.shuffleCursor;
    return result.index;
  }

  function nextPlaylistIndex() {
    return applyShuffleResult(resolveNextPlaylistIndex(shuffleNavigationInput()));
  }

  function previousPlaylistIndex() {
    return applyShuffleResult(resolvePreviousPlaylistIndex(shuffleNavigationInput()));
  }

  function playNextFromPlaylist() {
    var index = nextPlaylistIndex();
    if (index === -1) {
      clearCurrentSong();
      return;
    }
    playPlaylistIndex(index);
  }

  function playPreviousFromPlaylist() {
    var index = previousPlaylistIndex();
    if (index !== -1) playPlaylistIndex(index);
  }

  function toggleShuffle() {
    ctx.state.shuffleEnabled = !ctx.state.shuffleEnabled;
    if (ctx.playlistApi && typeof ctx.playlistApi.resetShuffleBag === 'function') {
      ctx.playlistApi.resetShuffleBag();
    }
    if (ctx.state.shuffleEnabled) {
      var rebuilt = rebuildShuffleSequence(
        (ctx.state.playlist || []).length,
        ctx.state.currentPlaylistIndex
      );
      ctx.state.shuffleSequence = rebuilt.shuffleSequence;
      ctx.state.shuffleCursor = rebuilt.shuffleCursor;
    } else {
      ctx.state.shuffleSequence = [];
      ctx.state.shuffleCursor = -1;
    }
    try {
      if (ctx.writeVideoSetting) ctx.writeVideoSetting('video-shuffle-enabled', ctx.state.shuffleEnabled);
    } catch (_error) {
      // ignore
    }
    if (ctx.els.shuffleButton) {
      ctx.els.shuffleButton.setAttribute('aria-pressed', ctx.state.shuffleEnabled ? 'true' : 'false');
    }
  }

  function restoreShuffleEnabled() {
    var stored = false;
    try {
      stored = !!(ctx.readVideoSetting && ctx.readVideoSetting('video-shuffle-enabled', false));
    } catch (_error) {
      stored = false;
    }
    ctx.state.shuffleEnabled = stored;
    if (ctx.els.shuffleButton) {
      ctx.els.shuffleButton.setAttribute('aria-pressed', ctx.state.shuffleEnabled ? 'true' : 'false');
    }
  }

  // Hook sync after playlist mutations by wrapping syncPlaylistState if present later.
  ctx.syncQueueFromPlaylist = syncQueueFromPlaylist;
  ctx.playNextFromPlaylist = playNextFromPlaylist;
  ctx.playPreviousFromPlaylist = playPreviousFromPlaylist;
  ctx.toggleVideoShuffle = toggleShuffle;
  ctx.restoreVideoShuffle = restoreShuffleEnabled;
  ctx.extendMediaLibraryPlaybackApi = extendPlaybackApi;
  ctx.ensureVideoShuffleState = function () {
    var ensured = ensureShuffleState(shuffleNavigationInput());
    ctx.state.shuffleSequence = ensured.shuffleSequence;
    ctx.state.shuffleCursor = ensured.shuffleCursor;
  };

  // Provide layout-compatible playbackApi stubs early; extended after video playback init.
  ctx.playbackApi = ctx.playbackApi || {};
  extendPlaybackApi();
}
