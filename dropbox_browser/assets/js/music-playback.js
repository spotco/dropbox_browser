import {formatPlaybackTime} from './music-shared.js';
import {createMetadataController} from './music-metadata.js';

export function initPlayback(ctx) {
  var els = ctx.els;
  var state = ctx.state;
  var metadata = createMetadataController(ctx);

  function currentSong() {
    return state.playlist[state.currentPlaylistIndex] || null;
  }

  function setPlaybackStatus(message) {
    ctx.pane.dataset.playbackStatus = message || '';
    if (message) ctx.setStatus(message);
  }

  function setButtonLabel(button, text) {
    var label;
    if (!button) return;
    label = button.querySelector('.music-button-label');
    if (label) label.textContent = text;
    else button.textContent = text;
  }

  function setButtonIcon(button, iconUrl) {
    var icon;
    if (!button) return;
    icon = button.querySelector('.music-button-icon');
    if (icon) icon.src = iconUrl;
  }

  function setPlayPauseVisualState(isPlaying) {
    if (els.playButton) {
      els.playButton.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
      els.playButton.title = isPlaying ? 'Pause' : 'Play';
      setButtonLabel(els.playButton, isPlaying ? 'Pause' : 'Play');
      setButtonIcon(
        els.playButton,
        isPlaying
          ? '/assets/icons/material-icon-theme/music-pause.svg'
          : '/assets/icons/material-icon-theme/music-play.svg'
      );
      els.playButton.setAttribute('data-state', isPlaying ? 'pause' : 'play');
    }
    if (els.pauseButton) {
      els.pauseButton.hidden = true;
      els.pauseButton.classList.add('hidden');
    }
  }

  function setTimeLabel(el, seconds) {
    if (el) el.textContent = formatPlaybackTime(seconds);
  }

  function finiteDuration() {
    if (!els.audio) return null;
    if (!Number.isFinite(els.audio.duration) || els.audio.duration < 0) return null;
    return els.audio.duration;
  }

  function finiteCurrentTime() {
    if (!els.audio) return 0;
    if (!Number.isFinite(els.audio.currentTime) || els.audio.currentTime < 0) return 0;
    return els.audio.currentTime;
  }

  function resetProgressDisplay() {
    if (els.progressSlider) {
      els.progressSlider.min = '0';
      els.progressSlider.max = '0';
      els.progressSlider.value = '0';
    }
    setTimeLabel(els.elapsedTimeEl, 0);
    setTimeLabel(els.totalTimeEl, 0);
  }

  function paintDurationDisplay() {
    var duration = finiteDuration();
    if (els.progressSlider) {
      els.progressSlider.min = '0';
      els.progressSlider.max = duration === null ? '0' : String(duration);
      if (!state.scrubberDragging) {
        els.progressSlider.value = String(Math.min(finiteCurrentTime(), duration === null ? 0 : duration));
      }
    }
    setTimeLabel(els.totalTimeEl, duration === null ? 0 : duration);
  }

  function paintCurrentTimeDisplay() {
    var duration = finiteDuration();
    var currentTime = finiteCurrentTime();
    if (els.progressSlider && !state.scrubberDragging) {
      els.progressSlider.value = String(Math.min(currentTime, duration === null ? currentTime : duration));
    }
    setTimeLabel(els.elapsedTimeEl, currentTime);
  }

  function paintPlaybackDisplay() {
    var shouldPaintDuration = state.playbackDurationDirty;
    var shouldPaintCurrentTime = state.playbackCurrentTimeDirty;
    state.playbackDurationDirty = false;
    state.playbackCurrentTimeDirty = false;
    if (shouldPaintDuration) paintDurationDisplay();
    if (shouldPaintCurrentTime) paintCurrentTimeDisplay();
    state.playbackUiLastPaintMs = Date.now();
  }

  function syncDurationDisplay() {
    state.playbackDurationDirty = true;
    ctx.layoutApi.schedulePlaybackDisplayPaint();
  }

  function syncCurrentTimeDisplay() {
    state.playbackCurrentTimeDirty = true;
    ctx.layoutApi.schedulePlaybackDisplayPaint();
  }

  function repaintPlaybackDisplay() {
    state.playbackDurationDirty = true;
    state.playbackCurrentTimeDirty = true;
    if (!ctx.layoutApi.playbackUiMayPaint()) return;
    ctx.layoutApi.clearPlaybackUiPaintTimer();
    paintPlaybackDisplay();
  }

  function applySeekFromSlider() {
    var duration;
    var targetTime;
    if (!els.audio || !els.progressSlider) return;
    duration = finiteDuration();
    if (duration === null) return;
    targetTime = Number(els.progressSlider.value);
    if (!Number.isFinite(targetTime)) targetTime = 0;
    targetTime = Math.max(0, Math.min(targetTime, duration));
    els.audio.currentTime = targetTime;
    syncCurrentTimeDisplay();
  }

  function clampVolume(value) {
    if (!Number.isFinite(value)) return state.defaultVolume;
    return Math.max(0, Math.min(value, 1));
  }

  function setVolumeUi(volume) {
    if (els.volumeSlider) els.volumeSlider.value = String(volume);
  }

  function restoreVolume() {
    var storedVolume = Settings.get('music-volume', state.defaultVolume);
    var volume = clampVolume(Number(storedVolume));
    if (els.audio) els.audio.volume = volume;
    setVolumeUi(volume);
    return volume;
  }

  function persistVolume(volume) {
    Settings.set('music-volume', volume);
  }

  function applyVolumeFromSlider() {
    var volume;
    if (!els.volumeSlider) return;
    volume = clampVolume(Number(els.volumeSlider.value));
    if (els.audio) els.audio.volume = volume;
    setVolumeUi(volume);
    persistVolume(volume);
  }

  function restoreShuffleEnabled() {
    state.shuffleEnabled = !!Settings.get('music-shuffle-enabled', state.defaultShuffleEnabled);
    if (!state.shuffleEnabled) ctx.playlistApi.resetShuffleBag();
  }

  function persistShuffleEnabled() {
    Settings.set('music-shuffle-enabled', state.shuffleEnabled);
  }

  function restoreLoopPlaylist() {
    state.loopPlaylist = !!Settings.get('music-loop-playlist', state.defaultLoopPlaylist);
  }

  function persistLoopPlaylist() {
    Settings.set('music-loop-playlist', state.loopPlaylist);
  }

  function clearCurrentSong() {
    metadata.clearMetadataRequest();
    metadata.revokeCurrentArtObjectUrl();
    state.currentPlaylistIndex = -1;
    if (els.audio) {
      els.audio.pause();
      els.audio.removeAttribute('src');
      els.audio.load();
    }
    metadata.resetNowPlayingForSong(null);
    setPlayPauseVisualState(false);
    setPlaybackStatus('');
  }

  function streamUrl(song) {
    return '/file?path=' + encodeURIComponent(song.stream_path) + '&source=remote';
  }

  function playPlaylistIndex(index) {
    var song = state.playlist[index];
    if (!song) {
      clearCurrentSong();
      ctx.playlistApi.renderPlaylist();
      return;
    }
    state.currentPlaylistIndex = index;
    state.shuffleBag = state.shuffleBag.filter(function (bagIndex) { return bagIndex !== index; });
    metadata.resetNowPlayingForSong(song);
    setPlaybackStatus('');
    setPlayPauseVisualState(true);
    state.metadataLoadedRemotePath = null;
    restoreVolume();
    if (els.audio) {
      els.audio.src = streamUrl(song);
      var playPromise = els.audio.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(function (err) {
          setPlayPauseVisualState(false);
          setPlaybackStatus((err && err.message) || 'Browser blocked playback until user interaction.');
        });
      }
    }
    ctx.playlistApi.renderPlaylist();
  }

  function playCurrentOrFirst() {
    if (currentSong()) {
      if (els.audio) {
        setPlayPauseVisualState(true);
        var playPromise = els.audio.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch(function (err) {
            setPlayPauseVisualState(false);
            setPlaybackStatus((err && err.message) || 'Browser blocked playback until user interaction.');
          });
        }
      }
      return;
    }
    if (state.playlist.length > 0) playPlaylistIndex(0);
  }

  function pausePlayback() {
    if (els.audio) els.audio.pause();
    else setPlayPauseVisualState(false);
  }

  function togglePlayPause() {
    if (els.audio && !els.audio.paused && !els.audio.ended) {
      pausePlayback();
      return;
    }
    playCurrentOrFirst();
  }

  function nextPlaylistIndex() {
    if (state.playlist.length === 0) return -1;
    if (state.shuffleEnabled) return ctx.playlistApi.shuffleBagIndex();
    if (state.currentPlaylistIndex < 0) return 0;
    if (state.currentPlaylistIndex + 1 < state.playlist.length) return state.currentPlaylistIndex + 1;
    if (state.loopPlaylist) return 0;
    return -1;
  }

  function previousPlaylistIndex() {
    if (state.playlist.length === 0) return -1;
    if (state.currentPlaylistIndex <= 0) return state.loopPlaylist ? state.playlist.length - 1 : 0;
    return state.currentPlaylistIndex - 1;
  }

  function playNextSong() {
    var index = nextPlaylistIndex();
    if (index === -1) {
      clearCurrentSong();
      return;
    }
    playPlaylistIndex(index);
  }

  function playPreviousSong() {
    var index = previousPlaylistIndex();
    if (index !== -1) playPlaylistIndex(index);
  }

  function playPlaylistRemotePath(remotePath) {
    var index = ctx.playlistApi.playlistIndexByRemotePath(remotePath);
    if (index !== -1) playPlaylistIndex(index);
  }

  function updateModeButtons() {
    if (els.shuffleButton) {
      els.shuffleButton.setAttribute('aria-pressed', state.shuffleEnabled ? 'true' : 'false');
      setButtonLabel(els.shuffleButton, state.shuffleEnabled ? 'Shuffle' : 'Order');
    }
    if (els.loopButton) {
      els.loopButton.setAttribute('aria-pressed', state.loopPlaylist ? 'true' : 'false');
      setButtonLabel(els.loopButton, state.loopPlaylist ? 'Loop On' : 'Loop');
    }
  }

  function toggleShuffle() {
    state.shuffleEnabled = !state.shuffleEnabled;
    ctx.playlistApi.resetShuffleBag();
    persistShuffleEnabled();
    updateModeButtons();
  }

  function toggleLoopPlaylist() {
    state.loopPlaylist = !state.loopPlaylist;
    persistLoopPlaylist();
    updateModeButtons();
  }

  ctx.playbackApi = {
    applySeekFromSlider: applySeekFromSlider,
    applyVolumeFromSlider: applyVolumeFromSlider,
    clearCurrentSong: clearCurrentSong,
    currentSong: currentSong,
    metadata: metadata,
    nextPlaylistIndex: nextPlaylistIndex,
    paintPlaybackDisplay: paintPlaybackDisplay,
    pausePlayback: pausePlayback,
    playCurrentOrFirst: playCurrentOrFirst,
    playNextSong: playNextSong,
    playPlaylistIndex: playPlaylistIndex,
    playPlaylistRemotePath: playPlaylistRemotePath,
    playPreviousSong: playPreviousSong,
    repaintPlaybackDisplay: repaintPlaybackDisplay,
    resetProgressDisplay: resetProgressDisplay,
    restoreLoopPlaylist: restoreLoopPlaylist,
    restoreShuffleEnabled: restoreShuffleEnabled,
    restoreVolume: restoreVolume,
    setButtonIcon: setButtonIcon,
    setButtonLabel: setButtonLabel,
    setPlayPauseVisualState: setPlayPauseVisualState,
    setPlaybackStatus: setPlaybackStatus,
    streamUrl: streamUrl,
    syncCurrentTimeDisplay: syncCurrentTimeDisplay,
    syncDurationDisplay: syncDurationDisplay,
    toggleLoopPlaylist: toggleLoopPlaylist,
    togglePlayPause: togglePlayPause,
    toggleShuffle: toggleShuffle,
    updateModeButtons: updateModeButtons
  };

  if (els.playButton) els.playButton.addEventListener('click', togglePlayPause);
  if (els.pauseButton) els.pauseButton.addEventListener('click', pausePlayback);
  if (els.nextButton) els.nextButton.addEventListener('click', playNextSong);
  if (els.prevButton) els.prevButton.addEventListener('click', playPreviousSong);
  if (els.shuffleButton) els.shuffleButton.addEventListener('click', toggleShuffle);
  if (els.loopButton) els.loopButton.addEventListener('click', toggleLoopPlaylist);
  if (els.volumeSlider) {
    els.volumeSlider.addEventListener('input', applyVolumeFromSlider);
    els.volumeSlider.addEventListener('change', applyVolumeFromSlider);
  }
  if (els.progressSlider) {
    els.progressSlider.min = '0';
    els.progressSlider.addEventListener('pointerdown', function () {
      state.scrubberDragging = true;
    });
    els.progressSlider.addEventListener('pointerup', function () {
      state.scrubberDragging = false;
      applySeekFromSlider();
    });
    els.progressSlider.addEventListener('input', function () {
      state.scrubberDragging = true;
      setTimeLabel(els.elapsedTimeEl, Number(els.progressSlider.value));
    });
    els.progressSlider.addEventListener('change', function () {
      state.scrubberDragging = false;
      applySeekFromSlider();
    });
  }
  if (els.audio) {
    els.audio.addEventListener('loadedmetadata', function () {
      syncDurationDisplay();
      syncCurrentTimeDisplay();
    });
    els.audio.addEventListener('durationchange', function () {
      syncDurationDisplay();
      syncCurrentTimeDisplay();
    });
    els.audio.addEventListener('timeupdate', function () {
      syncCurrentTimeDisplay();
    });
    els.audio.addEventListener('seeking', function () {
      state.scrubberDragging = true;
      syncCurrentTimeDisplay();
    });
    els.audio.addEventListener('seeked', function () {
      state.scrubberDragging = false;
      syncCurrentTimeDisplay();
    });
    els.audio.addEventListener('play', function () {
      setPlayPauseVisualState(true);
      syncDurationDisplay();
      syncCurrentTimeDisplay();
    });
    els.audio.addEventListener('playing', function () {
      metadata.maybeStartCurrentSongMetadataLoad();
    });
    els.audio.addEventListener('pause', function () {
      setPlayPauseVisualState(false);
      syncCurrentTimeDisplay();
    });
    els.audio.addEventListener('ended', playNextSong);
    els.audio.addEventListener('ended', function () {
      state.scrubberDragging = false;
      syncCurrentTimeDisplay();
      if (!currentSong()) setPlayPauseVisualState(false);
    });
    els.audio.addEventListener('emptied', function () {
      metadata.revokeCurrentArtObjectUrl();
    });
    els.audio.addEventListener('error', function () {
      state.scrubberDragging = false;
      syncCurrentTimeDisplay();
      setPlayPauseVisualState(false);
      setPlaybackStatus('Could not play this audio file.');
    });
  }
}
