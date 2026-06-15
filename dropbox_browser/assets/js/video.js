import Hls from './vendor/hls.js';
import {
  advanceQueueAfterPlaybackEnd,
  clearQueue,
  enqueueAndPlay,
  enqueueSelected,
  moveQueueIndex,
  playbackDurationSeconds,
  playQueueIndex,
  removeQueueIndex,
} from './video-core.js';

(function () {
  var pane = document.getElementById('video-player-pane');
  if (!pane) return;

  var body = document.body;
  var ctx = {
    pane: pane,
    els: {
      pathEl: document.getElementById('video-library-path'),
      statusEl: document.getElementById('video-player-status'),
      titleEl: document.getElementById('video-current-title'),
      metaEl: document.getElementById('video-current-meta'),
      placeholderEl: document.getElementById('video-playback-placeholder'),
      videoEl: document.getElementById('video-player-media'),
      playToggleButton: document.getElementById('video-play-toggle'),
      muteToggleButton: document.getElementById('video-mute-toggle'),
      volumeSliderEl: document.getElementById('video-volume-slider'),
      fullscreenButton: document.getElementById('video-fullscreen-toggle'),
      pipButton: document.getElementById('video-pip-toggle'),
      progressSliderEl: document.getElementById('video-progress-slider'),
      elapsedTimeEl: document.getElementById('video-elapsed-time'),
      totalTimeEl: document.getElementById('video-total-time'),
      audioTrackSelectEl: document.getElementById('video-audio-track'),
      subtitleTrackSelectEl: document.getElementById('video-subtitle-track'),
      libraryListEl: document.getElementById('video-library-list'),
      queueListEl: document.getElementById('video-queue-list'),
      libraryUpButton: document.getElementById('video-library-up'),
      libraryAddSelectedButton: document.getElementById('video-library-add-selected'),
      queuePlayButton: document.getElementById('video-queue-play'),
      queueRemoveButton: document.getElementById('video-queue-remove'),
      queueUpButton: document.getElementById('video-queue-up'),
      queueDownButton: document.getElementById('video-queue-down'),
      queueClearButton: document.getElementById('video-queue-clear'),
    },
    state: {
      paneActive: false,
      currentFolder: '',
      libraryItems: [],
      selectedLibraryPaths: Object.create(null),
      queue: [],
      selectedQueueIndex: -1,
      activeQueueIndex: -1,
      loadingLibrary: false,
      loadingPlaybackStatus: false,
      playbackStatusLoaded: false,
      compatibilityAvailable: false,
      ffmpegAvailable: false,
      ffprobeAvailable: false,
      playbackMode: 'none',
      lastPlaybackPath: '',
      pendingAutoplay: false,
      compatibilitySessionId: '',
      hlsController: null,
      compatibilityNetworkRecoveries: 0,
      compatibilityMediaRecoveries: 0,
      compatibilityStartSeconds: 0,
      requestedSeekSeconds: null,
      seekRestartInProgress: false,
      playbackSyncToken: 0,
      probeCache: Object.create(null),
      probeFailures: Object.create(null),
      selectedAudioStreamIndexByPath: Object.create(null),
      selectedSubtitleStreamIndexByPath: Object.create(null),
      subtitleObjectUrl: '',
      progressSliderActive: false,
    }
  };

  function currentFolderPath() {
    return body && typeof body.dataset.currentFolderPath === 'string'
      ? body.dataset.currentFolderPath
      : '';
  }

  function setStatus(text) {
    if (ctx.els.statusEl) ctx.els.statusEl.textContent = text;
  }

  function reportVideoDiagnostic(fields) {
    try {
      if (!window.ClientLogger) return;
      var active = activeQueueItem();
      var details = Object.assign({}, fields || {}, {
        playback_mode: ctx.state.playbackMode || '',
        session_id: ctx.state.compatibilitySessionId || '',
        path: active && active.path ? active.path : '',
        current_time: ctx.els.videoEl ? ctx.els.videoEl.currentTime || 0 : '',
        global_current_time: currentGlobalPlaybackSeconds(),
        source_start_seconds: ctx.state.compatibilityStartSeconds || 0,
        ready_state: ctx.els.videoEl ? ctx.els.videoEl.readyState : '',
        network_state: ctx.els.videoEl ? ctx.els.videoEl.networkState : '',
      });
      var level = details.level || 'debug';
      var message = details.message || 'video diagnostic';
      window.ClientLogger.log('video', level, message, details);
    }
    catch (_error) {
      return;
    }
  }

  function currentGlobalPlaybackSeconds() {
    var mediaTime = ctx.els.videoEl ? Number(ctx.els.videoEl.currentTime) : 0;
    return ctx.state.compatibilityStartSeconds + (Number.isFinite(mediaTime) && mediaTime >= 0 ? mediaTime : 0);
  }

  function mediaRangesSummary(ranges) {
    var result = [];
    if (!ranges) return result;
    for (var index = 0; index < ranges.length; index += 1) {
      try {
        result.push({
          start: ranges.start(index),
          end: ranges.end(index),
        });
      }
      catch (_error) {
        return result;
      }
    }
    return result;
  }

  function setPlaybackSummary(title, meta) {
    if (ctx.els.titleEl) ctx.els.titleEl.textContent = title;
    if (ctx.els.metaEl) ctx.els.metaEl.textContent = meta;
  }

  function updateCurrentFolder(path) {
    ctx.state.currentFolder = path || '';
    if (ctx.els.pathEl) ctx.els.pathEl.textContent = ctx.state.currentFolder || '/';
  }

  function parentFolderPath(path) {
    if (!path) return '';
    var parts = path.split('/').filter(Boolean);
    parts.pop();
    return parts.join('/');
  }

  function selectedLibraryItems() {
    return ctx.state.libraryItems.filter(function (item) {
      return item.type === 'file' && ctx.state.selectedLibraryPaths[item.path];
    });
  }

  function activeQueueItem() {
    if (ctx.state.activeQueueIndex < 0 || ctx.state.activeQueueIndex >= ctx.state.queue.length) return null;
    return ctx.state.queue[ctx.state.activeQueueIndex];
  }

  function activeItemPath() {
    var active = activeQueueItem();
    return active && active.path ? active.path : '';
  }

  function hideVideoElement() {
    if (!ctx.els.videoEl) return;
    ctx.els.videoEl.hidden = true;
    ctx.els.videoEl.classList.add('hidden');
  }

  function showVideoElement() {
    if (!ctx.els.videoEl) return;
    ctx.els.videoEl.hidden = false;
    ctx.els.videoEl.classList.remove('hidden');
  }

  function showPlaceholderElement() {
    if (!ctx.els.placeholderEl) return;
    ctx.els.placeholderEl.hidden = false;
    ctx.els.placeholderEl.classList.remove('hidden');
  }

  function hidePlaceholderElement() {
    if (!ctx.els.placeholderEl) return;
    ctx.els.placeholderEl.hidden = true;
    ctx.els.placeholderEl.classList.add('hidden');
  }

  function destroyHlsController() {
    if (ctx.state.hlsController && typeof ctx.state.hlsController.destroy === 'function') {
      ctx.state.hlsController.destroy();
    }
    ctx.state.hlsController = null;
  }

  function resetCompatibilityRecoveryState() {
    ctx.state.compatibilityNetworkRecoveries = 0;
    ctx.state.compatibilityMediaRecoveries = 0;
  }

  function formatPlaybackTime(totalSeconds) {
    if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '00:00:00';
    var seconds = Math.floor(totalSeconds);
    var hours = Math.floor(seconds / 3600);
    var minutes = Math.floor((seconds % 3600) / 60);
    var remainder = seconds % 60;
    return String(hours).padStart(2, '0')
      + ':'
      + String(minutes).padStart(2, '0')
      + ':'
      + String(remainder).padStart(2, '0');
  }

  function resetPlaybackProgress() {
    if (ctx.els.playToggleButton) {
      ctx.els.playToggleButton.textContent = 'Play';
      ctx.els.playToggleButton.disabled = true;
    }
    if (ctx.els.muteToggleButton) {
      ctx.els.muteToggleButton.textContent = 'Mute';
      ctx.els.muteToggleButton.disabled = true;
    }
    if (ctx.els.volumeSliderEl) {
      ctx.els.volumeSliderEl.disabled = true;
    }
    if (ctx.els.fullscreenButton) {
      ctx.els.fullscreenButton.disabled = true;
    }
    if (ctx.els.pipButton) {
      ctx.els.pipButton.textContent = 'PiP';
      ctx.els.pipButton.disabled = true;
    }
    if (ctx.els.progressSliderEl) {
      ctx.els.progressSliderEl.min = '0';
      ctx.els.progressSliderEl.max = '0';
      ctx.els.progressSliderEl.value = '0';
      ctx.els.progressSliderEl.disabled = true;
    }
    if (ctx.els.elapsedTimeEl) ctx.els.elapsedTimeEl.textContent = '00:00:00';
    if (ctx.els.totalTimeEl) ctx.els.totalTimeEl.textContent = '00:00:00';
    ctx.state.progressSliderActive = false;
  }

  function videoControlsAvailable() {
    if (!ctx.els.videoEl) return false;
    var active = activeQueueItem();
    return Boolean(active && ctx.state.playbackMode === 'compatibility' && !ctx.els.videoEl.hidden);
  }

  function syncTransportControls() {
    if (!ctx.els.videoEl) return;
    var canControl = videoControlsAvailable();
    if (ctx.els.playToggleButton) {
      ctx.els.playToggleButton.disabled = !canControl;
      ctx.els.playToggleButton.textContent = ctx.els.videoEl.paused ? 'Play' : 'Pause';
    }
    if (ctx.els.muteToggleButton) {
      ctx.els.muteToggleButton.disabled = !canControl;
      ctx.els.muteToggleButton.textContent = ctx.els.videoEl.muted || ctx.els.videoEl.volume === 0 ? 'Unmute' : 'Mute';
    }
    if (ctx.els.volumeSliderEl) {
      ctx.els.volumeSliderEl.disabled = !canControl;
      ctx.els.volumeSliderEl.value = String(ctx.els.videoEl.muted ? 0 : ctx.els.videoEl.volume);
    }
    if (ctx.els.fullscreenButton) {
      ctx.els.fullscreenButton.disabled = !canControl || typeof ctx.els.videoEl.requestFullscreen !== 'function';
    }
    if (ctx.els.pipButton) {
      var pipSupported = Boolean(
        document.pictureInPictureEnabled && typeof ctx.els.videoEl.requestPictureInPicture === 'function'
      );
      ctx.els.pipButton.disabled = !canControl || !pipSupported;
      ctx.els.pipButton.textContent = document.pictureInPictureElement === ctx.els.videoEl ? 'Exit PiP' : 'PiP';
    }
  }

  function syncPlaybackProgress() {
    if (!ctx.els.videoEl || !ctx.els.progressSliderEl) return;
    var active = activeQueueItem();
    var probePayload = active ? ctx.state.probeCache[active.path || ''] || null : null;
    var duration = playbackDurationSeconds(
      Number(ctx.els.videoEl.duration),
      probePayload,
      ctx.state.playbackMode
    );
    var currentTime = currentGlobalPlaybackSeconds();
    if (ctx.state.seekRestartInProgress && Number.isFinite(Number(ctx.state.requestedSeekSeconds))) {
      currentTime = Number(ctx.state.requestedSeekSeconds);
    }
    if (!Number.isFinite(duration) || duration <= 0) {
      resetPlaybackProgress();
      return;
    }
    syncTransportControls();
    ctx.els.progressSliderEl.max = String(duration);
    ctx.els.progressSliderEl.disabled = false;
    if (!ctx.state.progressSliderActive) {
      var value = Number.isFinite(currentTime) && currentTime >= 0 ? currentTime : 0;
      ctx.els.progressSliderEl.value = String(Math.min(duration, value));
    }
    if (ctx.els.elapsedTimeEl) {
      var elapsedValue = ctx.state.progressSliderActive
        ? Number(ctx.els.progressSliderEl.value)
        : currentTime;
      ctx.els.elapsedTimeEl.textContent = formatPlaybackTime(elapsedValue);
    }
    if (ctx.els.totalTimeEl) ctx.els.totalTimeEl.textContent = formatPlaybackTime(duration);
  }

  function failCompatibilityPlayback(item, meta, status) {
    clearVideoSource();
    showPlaybackPlaceholder(activeItemTitle(item), meta || 'Compatibility playback failed for this file.');
    setStatus(status || 'Compatibility playback failed.');
    resetPlaybackProgress();
  }

  function clearVideoSource() {
    if (!ctx.els.videoEl) return;
    destroyHlsController();
    resetCompatibilityRecoveryState();
    ctx.els.videoEl.controls = false;
    ctx.els.videoEl.removeAttribute('controls');
    if (ctx.els.videoEl.getAttribute('src')) {
      ctx.els.videoEl.pause();
      ctx.els.videoEl.removeAttribute('src');
      ctx.els.videoEl.load();
    }
    ctx.state.lastPlaybackPath = '';
    ctx.state.compatibilityStartSeconds = 0;
    ctx.state.requestedSeekSeconds = null;
    ctx.state.seekRestartInProgress = false;
    resetPlaybackProgress();
  }

  function clearSubtitleTrack() {
    if (ctx.els.videoEl) {
      Array.from(ctx.els.videoEl.querySelectorAll('track[data-video-subtitle-track="1"]')).forEach(function (node) {
        node.remove();
      });
    }
    if (ctx.state.subtitleObjectUrl) {
      URL.revokeObjectURL(ctx.state.subtitleObjectUrl);
      ctx.state.subtitleObjectUrl = '';
    }
  }

  async function stopCompatibilitySession() {
    var sessionId = ctx.state.compatibilitySessionId;
    ctx.state.compatibilitySessionId = '';
    destroyHlsController();
    if (!sessionId) return;
    try {
      await fetch('/video/endpoints/session/stop', {
        method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8'},
        body: 'id=' + encodeURIComponent(sessionId),
      });
    }
    catch (_error) {
      return;
    }
  }

  function showPlaybackPlaceholder(title, meta) {
    hideVideoElement();
    showPlaceholderElement();
    setPlaybackSummary(title, meta);
  }

  function showPlaybackVideo(title, meta) {
    hidePlaceholderElement();
    showVideoElement();
    setPlaybackSummary(title, meta);
  }

  function activeItemTitle(item) {
    return item && (item.display_name || item.filename || item.path)
      ? (item.display_name || item.filename || item.path)
      : 'Selected video';
  }

  function compatibilityNeededStatus() {
    if (ctx.state.playbackStatusLoaded && !ctx.state.compatibilityAvailable) {
      return 'Video playback requires ffmpeg and ffprobe.';
    }
    return 'Compatibility playback session is being prepared.';
  }

  function compatibilityNeededMeta(item) {
    if (ctx.state.playbackStatusLoaded && !ctx.state.compatibilityAvailable) {
      return 'Install or configure ffmpeg and ffprobe to enable video playback.';
    }
    return 'Preparing an HLS compatibility session for this queue item.';
  }

  function requestVideoPlay() {
    if (!ctx.els.videoEl || typeof ctx.els.videoEl.play !== 'function') {
      ctx.state.pendingAutoplay = false;
      return;
    }
    ctx.state.pendingAutoplay = false;
    var playPromise = ctx.els.videoEl.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(function () {
        setStatus('Playback is ready. Press play if the browser blocked autoplay.');
        syncTransportControls();
      });
    }
    syncTransportControls();
  }

  function toggleVideoPlayPause() {
    if (!ctx.els.videoEl || ctx.els.videoEl.hidden) return;
    if (ctx.els.videoEl.paused) {
      requestVideoPlay();
      return;
    }
    ctx.els.videoEl.pause();
    syncTransportControls();
  }

  function toggleVideoMute() {
    if (!ctx.els.videoEl || !videoControlsAvailable()) return;
    if (ctx.els.videoEl.muted || ctx.els.videoEl.volume === 0) {
      if (ctx.els.videoEl.volume === 0) ctx.els.videoEl.volume = 1;
      ctx.els.videoEl.muted = false;
    }
    else {
      ctx.els.videoEl.muted = true;
    }
    syncTransportControls();
  }

  function setVideoVolumeFromSlider() {
    if (!ctx.els.videoEl || !ctx.els.volumeSliderEl) return;
    var nextVolume = Number(ctx.els.volumeSliderEl.value);
    if (!Number.isFinite(nextVolume)) return;
    nextVolume = Math.max(0, Math.min(1, nextVolume));
    ctx.els.videoEl.volume = nextVolume;
    ctx.els.videoEl.muted = nextVolume === 0;
    syncTransportControls();
  }

  async function toggleVideoFullscreen() {
    if (!ctx.els.videoEl || !videoControlsAvailable()) return;
    try {
      if (document.fullscreenElement === ctx.els.videoEl && typeof document.exitFullscreen === 'function') {
        await document.exitFullscreen();
        return;
      }
      if (typeof ctx.els.videoEl.requestFullscreen === 'function') {
        await ctx.els.videoEl.requestFullscreen();
      }
    }
    catch (_error) {
      setStatus('Fullscreen is unavailable in this browser context.');
    }
    finally {
      syncTransportControls();
    }
  }

  async function togglePictureInPicture() {
    if (!ctx.els.videoEl || !videoControlsAvailable()) return;
    if (!document.pictureInPictureEnabled || typeof ctx.els.videoEl.requestPictureInPicture !== 'function') {
      syncTransportControls();
      return;
    }
    try {
      if (document.pictureInPictureElement === ctx.els.videoEl) {
        await document.exitPictureInPicture();
        return;
      }
      await ctx.els.videoEl.requestPictureInPicture();
    }
    catch (_error) {
      setStatus('Picture-in-picture is unavailable for this video.');
    }
    finally {
      syncTransportControls();
    }
  }

  function attachCompatibilityVideo(playlistUrl, title, meta, startSeconds) {
    if (!ctx.els.videoEl) return;
    clearVideoSource();
    ctx.state.compatibilityStartSeconds = Math.max(0, Number(startSeconds) || 0);
    ctx.els.videoEl.controls = false;
    ctx.els.videoEl.removeAttribute('controls');
    resetCompatibilityRecoveryState();
    if (Hls && typeof Hls.isSupported === 'function' && Hls.isSupported()) {
      ctx.state.hlsController = new Hls({
        autoStartLoad: false,
        enableWorker: true,
        liveDurationInfinity: true,
        lowLatencyMode: false,
        maxLiveSyncPlaybackRate: 1,
      });
      ctx.state.hlsController.on(Hls.Events.MANIFEST_LOADING, function (_eventName, data) {
        reportVideoDiagnostic({
          level: 'debug',
          message: 'HLS manifest loading',
          hls_url: data && data.url ? data.url : '',
        });
      });
      ctx.state.hlsController.on(Hls.Events.MANIFEST_LOADED, function (_eventName, data) {
        reportVideoDiagnostic({
          level: 'debug',
          message: 'HLS manifest loaded',
          hls_level_count: data && Array.isArray(data.levels) ? data.levels.length : '',
        });
      });
      ctx.state.hlsController.on(Hls.Events.MANIFEST_PARSED, function () {
        if (ctx.state.playbackMode !== 'compatibility') return;
        reportVideoDiagnostic({
          level: 'debug',
          message: 'HLS manifest parsed',
          hls_start_position: 0,
          hls_live_sync_mode: 'file-start',
          source_start_seconds: ctx.state.compatibilityStartSeconds,
        });
        if (ctx.state.hlsController && typeof ctx.state.hlsController.startLoad === 'function') {
          ctx.state.hlsController.startLoad(0);
        }
        setStatus('Compatibility playback session is ready.');
        if (ctx.state.compatibilityStartSeconds > 0) {
          setStatus('Compatibility playback session is ready at ' + formatPlaybackTime(ctx.state.compatibilityStartSeconds) + '.');
        }
        if (ctx.state.pendingAutoplay) requestVideoPlay();
      });
      ctx.state.hlsController.on(Hls.Events.FRAG_LOADING, function (_eventName, data) {
        reportVideoDiagnostic({
          level: 'debug',
          message: 'HLS fragment loading',
          frag_sn: data && data.frag ? data.frag.sn : '',
          frag_url: data && data.frag ? data.frag.url : '',
        });
      });
      ctx.state.hlsController.on(Hls.Events.FRAG_LOADED, function (_eventName, data) {
        reportVideoDiagnostic({
          level: 'debug',
          message: 'HLS fragment loaded',
          frag_sn: data && data.frag ? data.frag.sn : '',
          frag_url: data && data.frag ? data.frag.url : '',
          loaded_bytes: data && data.stats ? data.stats.loaded : '',
          loading_ms: data && data.stats && data.stats.loading
            ? Math.round(data.stats.loading.end - data.stats.loading.start)
            : '',
        });
      });
      ctx.state.hlsController.on(Hls.Events.FRAG_BUFFERED, function (_eventName, data) {
        reportVideoDiagnostic({
          level: 'debug',
          message: 'HLS fragment buffered',
          frag_sn: data && data.frag ? data.frag.sn : '',
          frag_url: data && data.frag ? data.frag.url : '',
        });
      });
      ctx.state.hlsController.on(Hls.Events.ERROR, function (_eventName, data) {
        reportVideoDiagnostic({
          level: data && data.fatal ? 'error' : 'warn',
          message: data && data.fatal ? 'Fatal HLS error' : 'Recoverable HLS error',
          hls_type: data && data.type || '',
          hls_details: data && data.details || '',
          hls_fatal: data && data.fatal ? '1' : '0',
          hls_reason: data && (data.reason || data.error && data.error.message) || '',
          hls_url: data && data.frag && data.frag.url ? data.frag.url : (data && data.context && data.context.url ? data.context.url : ''),
        });
        if (!data || !data.fatal) return;
        var active = activeQueueItem();
        if (!active) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && ctx.state.compatibilityNetworkRecoveries < 2) {
          ctx.state.compatibilityNetworkRecoveries += 1;
          setStatus('Compatibility playback hit a network error; retrying the stream.');
          ctx.state.hlsController.startLoad();
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && ctx.state.compatibilityMediaRecoveries < 2) {
          ctx.state.compatibilityMediaRecoveries += 1;
          setStatus('Compatibility playback hit a media error; attempting recovery.');
          ctx.state.hlsController.recoverMediaError();
          return;
        }
        failCompatibilityPlayback(active, 'Compatibility playback failed for this file.', 'Compatibility playback failed.');
      });
      ctx.state.hlsController.attachMedia(ctx.els.videoEl);
      ctx.state.hlsController.loadSource(playlistUrl);
      setStatus('Compatibility playback session is loading.');
    }
    else if (ctx.els.videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      setStatus('Compatibility playback session is loading.');
      ctx.els.videoEl.src = playlistUrl;
      ctx.els.videoEl.load();
      ctx.els.videoEl.addEventListener('loadedmetadata', function onLoadedMetadata() {
        ctx.els.videoEl.removeEventListener('loadedmetadata', onLoadedMetadata);
        if (ctx.state.playbackMode !== 'compatibility') return;
        setStatus('Compatibility playback session is ready.');
        if (ctx.state.compatibilityStartSeconds > 0) {
          setStatus('Compatibility playback session is ready at ' + formatPlaybackTime(ctx.state.compatibilityStartSeconds) + '.');
        }
        if (ctx.state.pendingAutoplay) requestVideoPlay();
      });
    }
    else {
      throw new Error('HLS playback is not supported in this browser.');
    }
    ctx.state.playbackMode = 'compatibility';
    showPlaybackVideo(title, meta);
    syncPlaybackProgress();
    syncTransportControls();
  }

  function audioTrackLabel(stream) {
    var parts = [];
    if (stream.language) parts.push(String(stream.language).toUpperCase());
    if (stream.title) parts.push(stream.title);
    if (stream.codec_name) parts.push(String(stream.codec_name).toUpperCase());
    parts.push('Stream ' + String(stream.index));
    return parts.join(' • ');
  }

  function subtitleTrackLabel(stream) {
    var parts = [];
    if (stream.language) parts.push(String(stream.language).toUpperCase());
    if (stream.title) parts.push(stream.title);
    if (stream.codec_name) parts.push(String(stream.codec_name).toUpperCase());
    parts.push('Stream ' + String(stream.index));
    return parts.join(' • ');
  }

  function setAudioTrackPlaceholder(text) {
    var select = ctx.els.audioTrackSelectEl;
    if (!select) return;
    select.innerHTML = '';
    var option = document.createElement('option');
    option.value = '';
    option.textContent = text;
    select.appendChild(option);
    select.disabled = true;
  }

  function setSubtitleTrackPlaceholder(text) {
    var select = ctx.els.subtitleTrackSelectEl;
    if (!select) return;
    select.innerHTML = '';
    var option = document.createElement('option');
    option.value = '';
    option.textContent = text;
    select.appendChild(option);
    select.disabled = true;
  }

  function selectedAudioStreamIndex(item, probePayload) {
    if (!item || !probePayload) return null;
    var path = item.path || '';
    var audioStreams = Array.isArray(probePayload.audio_streams) ? probePayload.audio_streams : [];
    if (!audioStreams.length) return null;
    var saved = ctx.state.selectedAudioStreamIndexByPath[path];
    if (typeof saved === 'number' && audioStreams.some(function (stream) { return stream.index === saved; })) {
      return saved;
    }
    var probeDefault = probePayload.default_audio_stream_index;
    if (typeof probeDefault === 'number' && audioStreams.some(function (stream) { return stream.index === probeDefault; })) {
      ctx.state.selectedAudioStreamIndexByPath[path] = probeDefault;
      return probeDefault;
    }
    var fallback = audioStreams[0].index;
    ctx.state.selectedAudioStreamIndexByPath[path] = fallback;
    return fallback;
  }

  function renderAudioTrackSelector(item, probePayload) {
    var select = ctx.els.audioTrackSelectEl;
    if (!select) return;
    if (!item) {
      setAudioTrackPlaceholder('No video selected');
      return;
    }
    if (!probePayload) {
      var failed = Boolean(ctx.state.probeFailures[item.path || '']);
      setAudioTrackPlaceholder(failed ? 'Audio tracks unavailable' : 'Loading audio tracks...');
      return;
    }
    var audioStreams = Array.isArray(probePayload.audio_streams) ? probePayload.audio_streams : [];
    if (!audioStreams.length) {
      setAudioTrackPlaceholder('No audio tracks found');
      return;
    }
    var selected = selectedAudioStreamIndex(item, probePayload);
    select.innerHTML = '';
    audioStreams.forEach(function (stream) {
      var option = document.createElement('option');
      option.value = String(stream.index);
      option.textContent = audioTrackLabel(stream);
      if (selected === stream.index) option.selected = true;
      select.appendChild(option);
    });
    select.disabled = false;
  }

  function selectedSubtitleStreamIndex(item, probePayload) {
    if (!item || !probePayload) return '';
    var path = item.path || '';
    var subtitleStreams = Array.isArray(probePayload.subtitle_streams) ? probePayload.subtitle_streams : [];
    if (!subtitleStreams.length) return '';
    var saved = ctx.state.selectedSubtitleStreamIndexByPath[path];
    if (saved === '') return '';
    if (typeof saved === 'number' && subtitleStreams.some(function (stream) { return stream.index === saved; })) {
      return saved;
    }
    if (probePayload.subtitle_off_default) {
      ctx.state.selectedSubtitleStreamIndexByPath[path] = '';
      return '';
    }
    var probeDefault = probePayload.default_subtitle_stream_index;
    if (typeof probeDefault === 'number' && subtitleStreams.some(function (stream) { return stream.index === probeDefault; })) {
      ctx.state.selectedSubtitleStreamIndexByPath[path] = probeDefault;
      return probeDefault;
    }
    ctx.state.selectedSubtitleStreamIndexByPath[path] = '';
    return '';
  }

  function renderSubtitleTrackSelector(item, probePayload) {
    var select = ctx.els.subtitleTrackSelectEl;
    if (!select) return;
    if (!item) {
      setSubtitleTrackPlaceholder('No video selected');
      return;
    }
    if (!probePayload) {
      var failed = Boolean(ctx.state.probeFailures[item.path || '']);
      setSubtitleTrackPlaceholder(failed ? 'Subtitle tracks unavailable' : 'Loading subtitle tracks...');
      return;
    }
    var subtitleStreams = Array.isArray(probePayload.subtitle_streams) ? probePayload.subtitle_streams : [];
    if (!subtitleStreams.length) {
      setSubtitleTrackPlaceholder('No subtitle tracks found');
      return;
    }
    var selected = selectedSubtitleStreamIndex(item, probePayload);
    select.innerHTML = '';
    var offOption = document.createElement('option');
    offOption.value = '';
    offOption.textContent = 'Subtitles Off';
    if (selected === '') offOption.selected = true;
    select.appendChild(offOption);
    subtitleStreams.forEach(function (stream) {
      var option = document.createElement('option');
      option.value = String(stream.index);
      option.textContent = subtitleTrackLabel(stream);
      if (selected === stream.index) option.selected = true;
      select.appendChild(option);
    });
    select.disabled = false;
  }

  async function loadProbeMetadata(item) {
    if (!item || !item.path) return null;
    var path = item.path;
    if (ctx.state.probeCache[path]) return ctx.state.probeCache[path];
    if (ctx.state.probeFailures[path]) return null;
    try {
      var response = await fetch('/video/endpoints/probe?path=' + encodeURIComponent(path) + '&source=remote');
      if (!response.ok) throw new Error('Failed to probe video metadata.');
      var payload = await response.json();
      ctx.state.probeCache[path] = payload;
      delete ctx.state.probeFailures[path];
      syncPlaybackProgress();
      return payload;
    }
    catch (_error) {
      ctx.state.probeFailures[path] = true;
      return null;
    }
  }

  async function ensureAudioTracksForItem(item) {
    if (!item) {
      renderAudioTrackSelector(null, null);
      return null;
    }
    renderAudioTrackSelector(item, ctx.state.probeCache[item.path || ''] || null);
    var payload = await loadProbeMetadata(item);
    if (item.path !== activeItemPath()) return payload;
    renderAudioTrackSelector(item, payload);
    return payload;
  }

  async function ensureSubtitleTracksForItem(item) {
    if (!item) {
      renderSubtitleTrackSelector(null, null);
      return null;
    }
    renderSubtitleTrackSelector(item, ctx.state.probeCache[item.path || ''] || null);
    var payload = await loadProbeMetadata(item);
    if (item.path !== activeItemPath()) return payload;
    renderSubtitleTrackSelector(item, payload);
    return payload;
  }

  function subtitleTrackUrl(item, subtitleStreamIndex) {
    return '/video/endpoints/subtitles?path='
      + encodeURIComponent(item.path || '')
      + '&source=remote&track='
      + encodeURIComponent(String(subtitleStreamIndex))
      + '&start_time_seconds='
      + encodeURIComponent(String(Math.max(0, ctx.state.compatibilityStartSeconds || 0)));
  }

  async function syncSubtitleTrackForItem(item, probePayload) {
    clearSubtitleTrack();
    if (!item || !ctx.els.videoEl) return;
    var payload = probePayload || await ensureSubtitleTracksForItem(item);
    if (!payload || item.path !== activeItemPath()) return;
    var subtitleStreamIndex = selectedSubtitleStreamIndex(item, payload);
    if (subtitleStreamIndex === '') return;
    var subtitleStreams = Array.isArray(payload.subtitle_streams) ? payload.subtitle_streams : [];
    var subtitleStream = subtitleStreams.find(function (stream) { return stream.index === subtitleStreamIndex; }) || null;
    var url = subtitleTrackUrl(item, subtitleStreamIndex);
    try {
      var response = await fetch(url);
      if (!response.ok) throw new Error('Subtitle extraction failed.');
      var subtitleText = await response.text();
      if (item.path !== activeItemPath()) return;
      ctx.state.subtitleObjectUrl = URL.createObjectURL(new Blob([subtitleText], {type: 'text/vtt'}));
      var track = document.createElement('track');
      track.kind = 'subtitles';
      track.label = subtitleStream ? subtitleTrackLabel(subtitleStream) : 'Subtitles';
      track.srclang = subtitleStream && subtitleStream.language ? String(subtitleStream.language) : 'und';
      track.src = ctx.state.subtitleObjectUrl;
      track.default = true;
      track.setAttribute('data-video-subtitle-track', '1');
      ctx.els.videoEl.appendChild(track);
      setStatus('Subtitle track is ready.');
    }
    catch (_error) {
      clearSubtitleTrack();
      setStatus('Subtitle extraction failed.');
      setPlaybackSummary(activeItemTitle(item), 'Selected subtitle track could not be converted to WebVTT.');
    }
  }

  async function createCompatibilitySession(item, audioStreamIndex, startSeconds) {
    var body = 'path=' + encodeURIComponent(item.path || '')
      + '&source=remote'
      + '&start_time_seconds=' + encodeURIComponent(String(Math.max(0, Number(startSeconds) || 0)));
    if (typeof audioStreamIndex === 'number') {
      body += '&audio_stream_index=' + encodeURIComponent(String(audioStreamIndex));
    }
    var response = await fetch('/video/endpoints/session', {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8'},
      body: body,
    });
    if (!response.ok) {
      var errorText = '';
      try {
        errorText = await response.text();
      }
      catch (_error) {
        errorText = '';
      }
      throw new Error(errorText || 'Failed to start compatibility playback.');
    }
    return response.json();
  }

  async function restartCompatibilityAt(targetSeconds, reason) {
    var active = activeQueueItem();
    if (!active || !ctx.state.compatibilityAvailable) return;
    var syncToken = ++ctx.state.playbackSyncToken;
    var probePayload = ctx.state.probeCache[active.path || ''] || await ensureAudioTracksForItem(active);
    if (syncToken !== ctx.state.playbackSyncToken) return;
    var duration = playbackDurationSeconds(
      ctx.els.videoEl ? Number(ctx.els.videoEl.duration) : NaN,
      probePayload,
      'compatibility'
    );
    var clampedTarget = Math.max(0, Number(targetSeconds) || 0);
    if (Number.isFinite(duration) && duration > 0) {
      clampedTarget = Math.min(duration, clampedTarget);
    }
    var wasPlaying = ctx.els.videoEl ? !ctx.els.videoEl.paused : false;
    ctx.state.requestedSeekSeconds = clampedTarget;
    ctx.state.seekRestartInProgress = true;
    ctx.state.pendingAutoplay = wasPlaying || reason === 'scrub';
    if (ctx.els.videoEl && typeof ctx.els.videoEl.pause === 'function') {
      ctx.els.videoEl.pause();
    }
    if (ctx.els.progressSliderEl) ctx.els.progressSliderEl.value = String(clampedTarget);
    if (ctx.els.elapsedTimeEl) ctx.els.elapsedTimeEl.textContent = formatPlaybackTime(clampedTarget);
    setPlaybackSummary(activeItemTitle(active), 'Loading compatibility playback at ' + formatPlaybackTime(clampedTarget) + '.');
    setStatus('Loading compatibility playback at ' + formatPlaybackTime(clampedTarget) + '.');
    reportVideoDiagnostic({
      level: 'info',
      message: 'Compatibility seek restart requested',
      seek_reason: reason || '',
      requested_time: clampedTarget,
      source_start_seconds: ctx.state.compatibilityStartSeconds,
      actual_global_time_before: currentGlobalPlaybackSeconds(),
      media_current_time_before: ctx.els.videoEl ? ctx.els.videoEl.currentTime || 0 : '',
      media_buffered: ctx.els.videoEl ? mediaRangesSummary(ctx.els.videoEl.buffered) : [],
      media_seekable: ctx.els.videoEl ? mediaRangesSummary(ctx.els.videoEl.seekable) : [],
      duration: duration || '',
    });
    renderSubtitleTrackSelector(active, probePayload);
    if (!probePayload) {
      ctx.state.pendingAutoplay = false;
      ctx.state.seekRestartInProgress = false;
      setStatus('Could not inspect video tracks.');
      return;
    }
    var audioStreamIndex = selectedAudioStreamIndex(active, probePayload);
    try {
      var session = await createCompatibilitySession(active, audioStreamIndex, clampedTarget);
      if (syncToken !== ctx.state.playbackSyncToken) {
        await stopCompatibilitySession();
        return;
      }
      ctx.state.compatibilitySessionId = session.session_id || '';
      ctx.state.seekRestartInProgress = false;
      ctx.state.requestedSeekSeconds = null;
      attachCompatibilityVideo(
        session.playlist_url,
        activeItemTitle(active),
        'Playing through a local HLS compatibility session from ' + formatPlaybackTime(Number(session.start_time_seconds) || 0) + '.',
        Number(session.start_time_seconds) || clampedTarget
      );
      reportVideoDiagnostic({
        level: 'info',
        message: 'Compatibility seek restart ready',
        seek_reason: reason || '',
        requested_time: clampedTarget,
        source_start_seconds: Number(session.start_time_seconds) || clampedTarget,
        session_id: session.session_id || '',
      });
      void syncSubtitleTrackForItem(active, probePayload);
    }
    catch (_error) {
      if (syncToken !== ctx.state.playbackSyncToken) return;
      ctx.state.compatibilitySessionId = '';
      ctx.state.seekRestartInProgress = false;
      ctx.state.requestedSeekSeconds = null;
      ctx.state.playbackMode = 'compatibility-error';
      setStatus('Could not start compatibility playback at ' + formatPlaybackTime(clampedTarget) + '.');
      reportVideoDiagnostic({
        level: 'error',
        message: 'Compatibility seek restart failed',
        seek_reason: reason || '',
        requested_time: clampedTarget,
      });
    }
  }

  async function syncPlaybackForActiveItem() {
    var active = activeQueueItem();
    var syncToken = ++ctx.state.playbackSyncToken;
    if (!active) {
      ctx.state.playbackMode = 'none';
      ctx.state.pendingAutoplay = false;
      renderAudioTrackSelector(null, null);
      renderSubtitleTrackSelector(null, null);
      clearSubtitleTrack();
      await stopCompatibilitySession();
      clearVideoSource();
      showPlaybackPlaceholder(
        'No video selected',
        'Queue a video to start compatibility playback.'
      );
      return;
    }

    if (!ctx.state.playbackStatusLoaded) {
      if (!ctx.state.loadingPlaybackStatus) void loadPlaybackStatus();
      ctx.state.playbackMode = 'loading';
      clearVideoSource();
      renderAudioTrackSelector(active, null);
      renderSubtitleTrackSelector(active, null);
      showPlaybackPlaceholder(activeItemTitle(active), 'Loading video playback capabilities.');
      setStatus('Loading video playback capabilities.');
      return;
    }

    clearVideoSource();
    showPlaybackPlaceholder(activeItemTitle(active), '');

    if (!ctx.state.compatibilityAvailable) {
      ctx.state.pendingAutoplay = false;
      ctx.state.playbackMode = 'compatibility-unavailable';
      renderAudioTrackSelector(active, null);
      renderSubtitleTrackSelector(active, null);
      clearSubtitleTrack();
      await stopCompatibilitySession();
      if (syncToken !== ctx.state.playbackSyncToken) return;
      showPlaybackPlaceholder(activeItemTitle(active), compatibilityNeededMeta(active));
      setStatus(compatibilityNeededStatus());
      return;
    }

    setPlaybackSummary(activeItemTitle(active), compatibilityNeededMeta(active));
    setStatus(compatibilityNeededStatus());
    var probePayload = await ensureAudioTracksForItem(active);
    renderSubtitleTrackSelector(active, probePayload);
    if (syncToken !== ctx.state.playbackSyncToken) return;
    if (!probePayload) {
      ctx.state.pendingAutoplay = false;
      ctx.state.playbackMode = 'compatibility-error';
      showPlaybackPlaceholder(activeItemTitle(active), 'Could not inspect video tracks for compatibility playback.');
      setStatus('Could not inspect video tracks.');
      resetPlaybackProgress();
      return;
    }
    var audioStreamIndex = selectedAudioStreamIndex(active, probePayload);
    try {
      var session = await createCompatibilitySession(active, audioStreamIndex, 0);
      if (syncToken !== ctx.state.playbackSyncToken) {
        await stopCompatibilitySession();
        return;
      }
      ctx.state.compatibilitySessionId = session.session_id || '';
      attachCompatibilityVideo(
        session.playlist_url,
        activeItemTitle(active),
        'Playing through a local HLS compatibility session.',
        Number(session.start_time_seconds) || 0
      );
      void syncSubtitleTrackForItem(active, probePayload);
    }
    catch (_error) {
      if (syncToken !== ctx.state.playbackSyncToken) return;
      ctx.state.compatibilitySessionId = '';
      ctx.state.playbackMode = 'compatibility-error';
      showPlaybackPlaceholder(
        activeItemTitle(active),
        'Compatibility playback could not be started for this file.'
      );
      setStatus('Could not start compatibility playback.');
      resetPlaybackProgress();
    }
  }

  function renderLibrary() {
    var root = ctx.els.libraryListEl;
    if (!root) return;
    if (ctx.state.loadingLibrary) {
      root.innerHTML = '<div class="video-empty-state">Loading current folder video library...</div>';
      return;
    }
    if (!ctx.state.libraryItems.length) {
      root.innerHTML = '<div class="video-empty-state">No folders or supported video files found in this folder.</div>';
      return;
    }
    root.innerHTML = '';
    ctx.state.libraryItems.forEach(function (item) {
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'video-library-row';
      row.setAttribute('data-video-path', item.path || '');
      row.setAttribute('data-video-type', item.type || '');
      if (item.type === 'file' && ctx.state.selectedLibraryPaths[item.path]) {
        row.classList.add('is-selected');
      }
      var icon = item.type === 'folder' ? '▸' : '▶';
      var detail = item.type === 'folder'
        ? 'Open folder'
        : [item.extension || '', item.compatibility_expected ? 'Compatibility likely' : 'Native likely']
          .filter(Boolean)
          .join(' • ');
      row.innerHTML =
        '<span class="video-row-icon" aria-hidden="true">' + icon + '</span>' +
        '<span class="video-row-main">' +
        '<span class="video-row-title">' + escapeHtml(item.display_name || '') + '</span>' +
        '<span class="video-row-detail">' + escapeHtml(detail) + '</span>' +
        '</span>' +
        '<span class="video-row-action">' + (item.type === 'folder' ? 'Open' : 'Queue') + '</span>';
      row.addEventListener('click', function () {
        if (item.type === 'folder') {
          loadLibrary(item.path || '');
          return;
        }
        toggleLibrarySelection(item.path || '');
      });
      row.addEventListener('dblclick', function () {
        if (item.type !== 'file') return;
        var result = enqueueAndPlay(ctx.state.queue, ctx.state.activeQueueIndex, item);
        ctx.state.queue = result.queue;
        ctx.state.activeQueueIndex = result.activeIndex;
        ctx.state.selectedQueueIndex = result.activeIndex;
        ctx.state.pendingAutoplay = true;
        renderQueue();
      });
      root.appendChild(row);
    });
    updateLibraryButtons();
  }

  function renderQueue() {
    var root = ctx.els.queueListEl;
    if (!root) return;
    if (!ctx.state.queue.length) {
      root.innerHTML = '<div class="video-empty-state">Queue is empty.</div>';
      updateQueueButtons();
      void syncPlaybackForActiveItem();
      return;
    }
    root.innerHTML = '';
    ctx.state.queue.forEach(function (item, index) {
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'video-queue-row';
      if (index === ctx.state.selectedQueueIndex) row.classList.add('is-selected');
      if (index === ctx.state.activeQueueIndex) row.classList.add('is-active');
      row.setAttribute('data-video-queue-index', String(index));
      row.innerHTML =
        '<span class="video-row-main">' +
        '<span class="video-row-title">' + escapeHtml(item.display_name || '') + '</span>' +
        '<span class="video-row-detail">' + escapeHtml(item.path || '') + '</span>' +
        '</span>' +
        '<span class="video-row-action">' + (index === ctx.state.activeQueueIndex ? 'Now Playing' : 'Queued') + '</span>';
      row.addEventListener('click', function () {
        ctx.state.selectedQueueIndex = index;
        renderQueue();
      });
      row.addEventListener('dblclick', function () {
        ctx.state.activeQueueIndex = playQueueIndex(ctx.state.queue.length, index);
        ctx.state.selectedQueueIndex = ctx.state.activeQueueIndex;
        ctx.state.pendingAutoplay = true;
        renderQueue();
      });
      root.appendChild(row);
    });
    updateQueueButtons();
    void syncPlaybackForActiveItem();
  }

  function updateLibraryButtons() {
    if (!ctx.els.libraryAddSelectedButton || !ctx.els.libraryUpButton) return;
    ctx.els.libraryAddSelectedButton.disabled = selectedLibraryItems().length === 0;
    ctx.els.libraryUpButton.disabled = !ctx.state.currentFolder;
  }

  function updateQueueButtons() {
    var hasQueue = ctx.state.queue.length > 0;
    var hasSelection = ctx.state.selectedQueueIndex >= 0 && ctx.state.selectedQueueIndex < ctx.state.queue.length;
    if (ctx.els.queuePlayButton) ctx.els.queuePlayButton.disabled = !hasSelection;
    if (ctx.els.queueRemoveButton) ctx.els.queueRemoveButton.disabled = !hasSelection;
    if (ctx.els.queueUpButton) ctx.els.queueUpButton.disabled = !hasSelection || ctx.state.selectedQueueIndex <= 0;
    if (ctx.els.queueDownButton) ctx.els.queueDownButton.disabled = !hasSelection || ctx.state.selectedQueueIndex < 0 || ctx.state.selectedQueueIndex >= ctx.state.queue.length - 1;
    if (ctx.els.queueClearButton) ctx.els.queueClearButton.disabled = !hasQueue;
  }

  function toggleLibrarySelection(path) {
    if (!path) return;
    if (ctx.state.selectedLibraryPaths[path]) delete ctx.state.selectedLibraryPaths[path];
    else ctx.state.selectedLibraryPaths[path] = true;
    renderLibrary();
  }

  function addSelectedVideos() {
    var items = selectedLibraryItems();
    if (!items.length) return;
    var result = enqueueSelected(ctx.state.queue, ctx.state.activeQueueIndex, items);
    ctx.state.queue = result.queue;
    ctx.state.activeQueueIndex = result.activeIndex;
    ctx.state.selectedQueueIndex = ctx.state.queue.length - 1;
    setStatus('Added ' + items.length + ' video' + (items.length === 1 ? '' : 's') + ' to the queue.');
    renderQueue();
  }

  function removeSelectedQueueItem() {
    var result = removeQueueIndex(ctx.state.queue, ctx.state.activeQueueIndex, ctx.state.selectedQueueIndex);
    ctx.state.queue = result.queue;
    ctx.state.activeQueueIndex = result.activeIndex;
    ctx.state.selectedQueueIndex = result.activeIndex;
    ctx.state.pendingAutoplay = false;
    renderQueue();
  }

  function moveSelectedQueueItem(delta) {
    var fromIndex = ctx.state.selectedQueueIndex;
    var toIndex = fromIndex + delta;
    var result = moveQueueIndex(ctx.state.queue, ctx.state.activeQueueIndex, fromIndex, toIndex);
    ctx.state.queue = result.queue;
    ctx.state.activeQueueIndex = result.activeIndex;
    if (result.moved) ctx.state.selectedQueueIndex = toIndex;
    renderQueue();
  }

  function clearEntireQueue() {
    var result = clearQueue();
    ctx.state.queue = result.queue;
    ctx.state.activeQueueIndex = result.activeIndex;
    ctx.state.selectedQueueIndex = -1;
    ctx.state.pendingAutoplay = false;
    renderQueue();
  }

  function playSelectedQueueItem() {
    ctx.state.activeQueueIndex = playQueueIndex(ctx.state.queue.length, ctx.state.selectedQueueIndex);
    if (ctx.state.activeQueueIndex >= 0) {
      ctx.state.selectedQueueIndex = ctx.state.activeQueueIndex;
      ctx.state.pendingAutoplay = true;
      renderQueue();
    }
  }

  async function handleAudioTrackChange() {
    var active = activeQueueItem();
    var select = ctx.els.audioTrackSelectEl;
    if (!active || !select || select.disabled) return;
    var nextValue = select.value;
    if (!nextValue) return;
    ctx.state.selectedAudioStreamIndexByPath[active.path || ''] = Number(nextValue);
    ctx.state.pendingAutoplay = true;
    setStatus('Restarting compatibility playback for the selected audio track.');
    await restartCompatibilityAt(currentGlobalPlaybackSeconds(), 'audio-track-change');
  }

  async function handleSubtitleTrackChange() {
    var active = activeQueueItem();
    var select = ctx.els.subtitleTrackSelectEl;
    if (!active || !select || select.disabled) return;
    var nextValue = select.value;
    ctx.state.selectedSubtitleStreamIndexByPath[active.path || ''] = nextValue ? Number(nextValue) : '';
    clearSubtitleTrack();
    if (!nextValue) {
      setStatus('Subtitles turned off.');
      return;
    }
    setStatus('Loading subtitle track.');
    await syncSubtitleTrackForItem(active, ctx.state.probeCache[active.path || ''] || null);
  }

  async function loadPlaybackStatus() {
    if (ctx.state.loadingPlaybackStatus) return;
    ctx.state.loadingPlaybackStatus = true;
    try {
      var response = await fetch('/video/endpoints/status');
      if (!response.ok) throw new Error('Failed to load video playback status.');
      var payload = await response.json();
      ctx.state.playbackStatusLoaded = true;
      ctx.state.ffmpegAvailable = Boolean(payload.ffmpeg_available);
      ctx.state.ffprobeAvailable = Boolean(payload.ffprobe_available);
      ctx.state.compatibilityAvailable = Boolean(payload.compatibility_available);
      if (ctx.state.paneActive) void syncPlaybackForActiveItem();
    }
    catch (_error) {
      ctx.state.playbackStatusLoaded = true;
      ctx.state.ffmpegAvailable = false;
      ctx.state.ffprobeAvailable = false;
      ctx.state.compatibilityAvailable = false;
      if (ctx.state.paneActive) void syncPlaybackForActiveItem();
    }
    finally {
      ctx.state.loadingPlaybackStatus = false;
    }
  }

  async function loadLibrary(path) {
    updateCurrentFolder(path || '');
    ctx.state.loadingLibrary = true;
    ctx.state.selectedLibraryPaths = Object.create(null);
    renderLibrary();
    try {
      var response = await fetch('/video/endpoints/library?path=' + encodeURIComponent(ctx.state.currentFolder));
      if (!response.ok) throw new Error('Failed to load video library.');
      var payload = await response.json();
      ctx.state.libraryItems = Array.isArray(payload.items) ? payload.items : [];
      setStatus('Current folder video library is ready to load.');
    }
    catch (_error) {
      ctx.state.libraryItems = [];
      setStatus('Could not load current folder videos.');
    }
    finally {
      ctx.state.loadingLibrary = false;
      renderLibrary();
    }
  }

  function syncPaneMode(mode) {
    var active = mode === 'video-player';
    ctx.state.paneActive = active;
    pane.setAttribute('data-video-pane-active', active ? '1' : '0');
    if (!active) {
      void stopCompatibilitySession();
      clearVideoSource();
      renderAudioTrackSelector(null, null);
      renderSubtitleTrackSelector(null, null);
      clearSubtitleTrack();
      return;
    }
    updateCurrentFolder(currentFolderPath());
    setStatus('Current folder video library is ready to load.');
    void syncPlaybackForActiveItem();
    void loadPlaybackStatus();
    void loadLibrary(ctx.state.currentFolder);
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  pane.setAttribute('data-video-player-ready', 'subtitles');
  updateCurrentFolder(currentFolderPath());
  renderAudioTrackSelector(null, null);
  renderSubtitleTrackSelector(null, null);
  if (ctx.els.videoEl) {
    ctx.els.videoEl.controls = false;
    ctx.els.videoEl.removeAttribute('controls');
  }
  resetPlaybackProgress();
  void syncPlaybackForActiveItem();
  renderLibrary();
  renderQueue();

  if (ctx.els.libraryUpButton) {
    ctx.els.libraryUpButton.addEventListener('click', function () {
      void loadLibrary(parentFolderPath(ctx.state.currentFolder));
    });
  }
  if (ctx.els.libraryAddSelectedButton) {
    ctx.els.libraryAddSelectedButton.addEventListener('click', addSelectedVideos);
  }
  if (ctx.els.queuePlayButton) {
    ctx.els.queuePlayButton.addEventListener('click', playSelectedQueueItem);
  }
  if (ctx.els.queueRemoveButton) {
    ctx.els.queueRemoveButton.addEventListener('click', removeSelectedQueueItem);
  }
  if (ctx.els.queueUpButton) {
    ctx.els.queueUpButton.addEventListener('click', function () {
      moveSelectedQueueItem(-1);
    });
  }
  if (ctx.els.queueDownButton) {
    ctx.els.queueDownButton.addEventListener('click', function () {
      moveSelectedQueueItem(1);
    });
  }
  if (ctx.els.queueClearButton) {
    ctx.els.queueClearButton.addEventListener('click', clearEntireQueue);
  }
  if (ctx.els.audioTrackSelectEl) {
    ctx.els.audioTrackSelectEl.addEventListener('change', function () {
      void handleAudioTrackChange();
    });
  }
  if (ctx.els.subtitleTrackSelectEl) {
    ctx.els.subtitleTrackSelectEl.addEventListener('change', function () {
      void handleSubtitleTrackChange();
    });
  }
  if (ctx.els.playToggleButton) {
    ctx.els.playToggleButton.addEventListener('click', toggleVideoPlayPause);
  }
  if (ctx.els.muteToggleButton) {
    ctx.els.muteToggleButton.addEventListener('click', toggleVideoMute);
  }
  if (ctx.els.volumeSliderEl) {
    ctx.els.volumeSliderEl.addEventListener('input', setVideoVolumeFromSlider);
    ctx.els.volumeSliderEl.addEventListener('change', setVideoVolumeFromSlider);
  }
  if (ctx.els.fullscreenButton) {
    ctx.els.fullscreenButton.addEventListener('click', function () {
      void toggleVideoFullscreen();
    });
  }
  if (ctx.els.pipButton) {
    ctx.els.pipButton.addEventListener('click', function () {
      void togglePictureInPicture();
    });
  }
  if (ctx.els.progressSliderEl) {
    ctx.els.progressSliderEl.addEventListener('input', function () {
      ctx.state.progressSliderActive = true;
      syncPlaybackProgress();
    });
    ctx.els.progressSliderEl.addEventListener('change', function () {
      if (!ctx.els.videoEl || ctx.els.progressSliderEl.disabled) {
        ctx.state.progressSliderActive = false;
        return;
      }
      var nextTime = Number(ctx.els.progressSliderEl.value);
      if (Number.isFinite(nextTime) && nextTime >= 0) {
        ctx.state.progressSliderActive = false;
        void restartCompatibilityAt(nextTime, 'scrub');
        return;
      }
      ctx.state.progressSliderActive = false;
      syncPlaybackProgress();
    });
  }
  if (ctx.els.videoEl) {
    ctx.els.videoEl.addEventListener('loadedmetadata', syncPlaybackProgress);
    ctx.els.videoEl.addEventListener('durationchange', syncPlaybackProgress);
    ctx.els.videoEl.addEventListener('timeupdate', syncPlaybackProgress);
    ctx.els.videoEl.addEventListener('play', syncTransportControls);
    ctx.els.videoEl.addEventListener('pause', syncTransportControls);
    ctx.els.videoEl.addEventListener('volumechange', syncTransportControls);
    document.addEventListener('fullscreenchange', syncTransportControls);
    ctx.els.videoEl.addEventListener('enterpictureinpicture', syncTransportControls);
    ctx.els.videoEl.addEventListener('leavepictureinpicture', syncTransportControls);
    ctx.els.videoEl.addEventListener('waiting', function () {
      if (ctx.state.playbackMode !== 'compatibility') return;
      reportVideoDiagnostic({level: 'debug', message: 'Video element waiting'});
    });
    ctx.els.videoEl.addEventListener('stalled', function () {
      if (ctx.state.playbackMode !== 'compatibility') return;
      reportVideoDiagnostic({level: 'warn', message: 'Video element stalled'});
    });
    ctx.els.videoEl.addEventListener('seeking', function () {
      if (ctx.state.playbackMode === 'compatibility') {
        reportVideoDiagnostic({
          level: 'debug',
          message: 'Video element seeking',
          requested_time: ctx.state.requestedSeekSeconds,
          actual_global_time: currentGlobalPlaybackSeconds(),
          source_start_seconds: ctx.state.compatibilityStartSeconds,
          media_seekable: mediaRangesSummary(ctx.els.videoEl.seekable),
          media_buffered: mediaRangesSummary(ctx.els.videoEl.buffered),
        });
      }
      syncPlaybackProgress();
    });
    ctx.els.videoEl.addEventListener('seeked', function () {
      if (ctx.state.playbackMode === 'compatibility') {
        var requestedTime = ctx.state.requestedSeekSeconds;
        var actualTime = currentGlobalPlaybackSeconds();
        reportVideoDiagnostic({
          level: 'debug',
          message: 'Video element seeked',
          requested_time: requestedTime,
          actual_global_time: actualTime,
          seek_delta: Number.isFinite(Number(requestedTime)) ? actualTime - Number(requestedTime) : '',
          source_start_seconds: ctx.state.compatibilityStartSeconds,
          media_seekable: mediaRangesSummary(ctx.els.videoEl.seekable),
          media_buffered: mediaRangesSummary(ctx.els.videoEl.buffered),
        });
      }
      ctx.state.progressSliderActive = false;
      syncPlaybackProgress();
    });
    ctx.els.videoEl.addEventListener('emptied', resetPlaybackProgress);
    ctx.els.videoEl.addEventListener('playing', function () {
      resetCompatibilityRecoveryState();
      syncTransportControls();
      syncPlaybackProgress();
      if (ctx.state.playbackMode === 'compatibility') {
        reportVideoDiagnostic({
          level: 'info',
          message: 'Compatibility playback playing',
        });
        setStatus('Playing remote video through HLS compatibility playback.');
        return;
      }
    });
    ctx.els.videoEl.addEventListener('ended', function () {
      syncTransportControls();
      var event = new CustomEvent('video-playback-ended');
      pane.dispatchEvent(event);
    });
    ctx.els.videoEl.addEventListener('error', function () {
      var active = activeQueueItem();
      if (!active) return;
      if (ctx.state.playbackMode === 'compatibility') {
        reportVideoDiagnostic({
          level: 'error',
          message: 'Video element error during compatibility playback',
          media_error_code: ctx.els.videoEl.error ? ctx.els.videoEl.error.code : '',
          media_error_message: ctx.els.videoEl.error ? ctx.els.videoEl.error.message : '',
        });
        if (ctx.state.hlsController) return;
        failCompatibilityPlayback(active, 'Compatibility playback failed for this file.', 'Compatibility playback failed.');
        return;
      }
      clearVideoSource();
      showPlaybackPlaceholder(activeItemTitle(active), 'Video playback failed.');
      setStatus('Video playback failed.');
    });
  }

  window.addEventListener('bottom-pane-mode-changed', function (ev) {
    if (!ev.detail) return;
    syncPaneMode(ev.detail.mode);
  });

  window.addEventListener('browse-folder-changed', function (ev) {
    var detail = ev && ev.detail ? ev.detail : {};
    var nextPath = typeof detail.path === 'string' ? detail.path : currentFolderPath();
    updateCurrentFolder(nextPath);
    if (ctx.state.paneActive) void loadLibrary(nextPath);
  });

  window.addEventListener('beforeunload', function () {
    void stopCompatibilitySession();
  });

  pane.addEventListener('video-playback-ended', function () {
    ctx.state.activeQueueIndex = advanceQueueAfterPlaybackEnd(ctx.state.queue.length, ctx.state.activeQueueIndex);
    if (ctx.state.activeQueueIndex >= 0) {
      ctx.state.selectedQueueIndex = ctx.state.activeQueueIndex;
      ctx.state.pendingAutoplay = true;
    }
    renderQueue();
  });

  syncPaneMode(Settings.get('bottom-pane-mode', 'server-log'));
}());
