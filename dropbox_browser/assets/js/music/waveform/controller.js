import {
  evictWaveformCacheEntries,
  findWaveformCacheRecord,
  mergeWaveformCacheRecord,
  validateWaveformCacheRecord,
  waveformCacheEntriesFromSettingsValue,
  waveformCacheSettingsValue,
  WAVEFORM_CACHE_ENTRY_LIMIT_MAX,
  WAVEFORM_CACHE_SCHEMA_VERSION,
  WAVEFORM_CACHE_SETTINGS_KEY,
} from './cache.js';
import {sameWaveformIdentity, waveformCacheKey, waveformIdentityForSong} from './cache-key.js';
import {unpackWaveformPeaks} from './peaks.js';
import {chooseWaveformResolution, WAVEFORM_MAX_RESOLUTION} from './resolution.js';
import {pointerPositionToPlaybackTime} from './scrub.js';

function defaultWorkerFactory() {
  return new Worker('/assets/js/music/waveform/worker.js', {type: 'module'});
}

function defaultAudioContextFactory() {
  var scope = typeof window !== 'undefined' ? window : globalThis;
  var Constructor = scope && (scope.AudioContext || scope.webkitAudioContext);
  return Constructor ? new Constructor() : null;
}

function waveformClock() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function waveformLog(message, details) {
  var scope = typeof window !== 'undefined' ? window : globalThis;
  var logger = scope && scope.ClientLogger;
  if (!logger || typeof logger.debug !== 'function') return;
  logger.debug('music-waveform', message, details || {});
}

function identityLogDetails(identity) {
  if (!identity) return {identity: null};
  return {
    remotePath: identity.path || '',
    remoteSize: identity.size || '',
    remoteModified: identity.modified || '',
  };
}

function peakLogDetails(values) {
  var length = values && Number.isInteger(values.length) ? values.length : 0;
  if (!length) return {peakCount: 0};
  return {
    peakCount: length,
    firstPeak: Number(values[0]) || 0,
    middlePeak: Number(values[Math.floor(length / 2)]) || 0,
    lastPeak: Number(values[length - 1]) || 0,
  };
}

// Browser-native decodeAudioData is asynchronous, but portable Web Audio APIs
// do not expose CPU-slice control for the decoder.  Only post-decode sample
// scanning and peak reduction can be budgeted in our worker.
function decodeAudioData(context, bytes) {
  return new Promise(function (resolve, reject) {
    var settled = false;
    function finish(callback, value) {
      if (settled) return;
      settled = true;
      callback(value);
    }
    var result;
    try {
      result = context.decodeAudioData(
        bytes,
        function (decoded) { finish(resolve, decoded); },
        function (error) { finish(reject, error || new Error('Audio decode failed')); },
      );
    } catch (error) {
      finish(reject, error);
      return;
    }
    if (result && typeof result.then === 'function') {
      result.then(
        function (decoded) { finish(resolve, decoded); },
        function (error) { finish(reject, error || new Error('Audio decode failed')); },
      );
    }
  });
}

function copyDecodedChannels(decoded) {
  var channels = [];
  var transferables = [];
  var channelCount = decoded && Number.isInteger(decoded.numberOfChannels)
    ? decoded.numberOfChannels
    : 0;
  for (var index = 0; index < channelCount; index += 1) {
    var source = decoded.getChannelData(index);
    var copy = source && typeof source.slice === 'function'
      ? source.slice()
      : new Float32Array(source || []);
    channels.push(copy);
    transferables.push(copy.buffer);
  }
  return {channels: channels, transferables: transferables};
}

export function initWaveformController(ctx, options) {
  var els = ctx.els;
  var workerFactory = options && options.workerFactory ? options.workerFactory : defaultWorkerFactory;
  var settings = options && Object.prototype.hasOwnProperty.call(options, 'settings')
    ? options.settings
    : (typeof Settings !== 'undefined' ? Settings : null);
  var cacheSettingsKey = options && options.cacheSettingsKey
    ? options.cacheSettingsKey
    : WAVEFORM_CACHE_SETTINGS_KEY;
  var audioContextFactory = options && options.audioContextFactory
    ? options.audioContextFactory
    : defaultAudioContextFactory;
  var maximumResolution = options && options.maxResolution
    ? options.maxResolution
    : WAVEFORM_MAX_RESOLUTION;
  var state = {
    activeIdentity: null,
    abortController: null,
    audioContext: null,
    cacheRecord: null,
    destroyed: false,
    generation: 0,
    panelOpen: !!(els.waveformDetails && els.waveformDetails.open),
    pointerScrubbing: false,
    requestToken: 0,
    sourceBytes: null,
    sourceDuration: null,
    sourceIdentity: null,
    sourceState: 'idle',
    latestPeakPayload: null,
    latestPeakPreview: false,
    latestPeakResolution: null,
    latestPeakValues: new Float32Array(0),
    peakSummaries: Object.create(null),
    playheadFrameId: null,
    renderFrameId: null,
    resizeObserver: null,
    scrubPointerId: null,
    worker: null,
    workerGeneration: null,
    processingStartedAt: null,
    lastPeakAt: null,
    lastRenderedPeakKey: null,
  };

  function setStatus(text) {
    if (els.waveformStatusEl) els.waveformStatusEl.textContent = text || '';
    if (els.waveformLiveStatusEl) els.waveformLiveStatusEl.textContent = text || '';
  }

  function waveformCacheEntryLimit() {
    var configured = ctx.state && ctx.state.waveformCacheEntryLimit;
    if (!Number.isFinite(Number(configured))) configured = 20;
    return Math.max(0, Math.min(WAVEFORM_CACHE_ENTRY_LIMIT_MAX, Math.floor(Number(configured))));
  }

  function readStoredCacheEntries() {
    var stored;
    var entries;
    if (!settings || typeof settings.get !== 'function' || waveformCacheEntryLimit() <= 0) return [];
    try {
      stored = settings.get(cacheSettingsKey, null);
      entries = waveformCacheEntriesFromSettingsValue(stored);
      return entries.filter(function (entry) {
        return Boolean(validateWaveformCacheRecord(entry, null));
      });
    } catch (error) {
      return [];
    }
  }

  function writeStoredCacheEntries(entries) {
    var validEntries;
    var boundedEntries;
    if (!settings || typeof settings.set !== 'function' || waveformCacheEntryLimit() <= 0) return;
    validEntries = (Array.isArray(entries) ? entries : []).filter(function (entry) {
      return Boolean(validateWaveformCacheRecord(entry, null));
    });
    boundedEntries = evictWaveformCacheEntries(validEntries, waveformCacheEntryLimit());
    try {
      settings.set(cacheSettingsKey, waveformCacheSettingsValue(boundedEntries));
    } catch (error) {
      // Settings/localStorage quota and serialization failures are cache misses.
    }
  }

  function applyCacheRecord(record, identity) {
    var peaks;
    try {
      peaks = unpackWaveformPeaks(record.peaks);
    } catch (error) {
      return false;
    }
    state.cacheRecord = record;
    state.sourceIdentity = identity;
    state.sourceDuration = Number(record.duration);
    state.sourceState = 'ready';
    state.sourceBytes = null;
    state.latestPeakPayload = record.peaks;
    state.latestPeakPreview = false;
    state.latestPeakResolution = record.resolution;
    state.latestPeakValues = peaks;
    state.peakSummaries = Object.create(null);
    state.peakSummaries[String(record.resolution)] = record.peaks;
    setStatus('Audio visualization loaded from cache at ' + record.resolution + ' samples.');
    waveformLog('cache-hit', Object.assign(identityLogDetails(identity), {
      resolution: record.resolution,
      duration: record.duration,
      payloadLength: record.peaks.length,
    }));
    scheduleRender();
    return true;
  }

  function loadStoredCache(identity) {
    var key;
    var record;
    var entries;
    var touched;
    if (waveformCacheEntryLimit() <= 0) return null;
    key = waveformCacheKey(identity);
    entries = readStoredCacheEntries();
    record = findWaveformCacheRecord(entries, key);
    if (!record) return null;
    touched = Object.assign({}, record, {lastUsed: Date.now()});
    writeStoredCacheEntries(mergeWaveformCacheRecord(entries, touched, waveformCacheEntryLimit()));
    return touched;
  }

  function saveCompletedCache(identity) {
    var duration;
    var key;
    var record;
    var entries;
    if (waveformCacheEntryLimit() <= 0) return;
    key = waveformCacheKey(identity);
    duration = Number(state.sourceDuration || audioDuration());
    if (!key || !Number.isFinite(duration) || duration <= 0 ||
        !Number.isInteger(state.latestPeakResolution) || !state.latestPeakPayload) return;
    record = {
      version: WAVEFORM_CACHE_SCHEMA_VERSION,
      key: key,
      lastUsed: Date.now(),
      duration: duration,
      resolution: state.latestPeakResolution,
      peaks: state.latestPeakPayload,
    };
    if (!validateWaveformCacheRecord(record, key)) return;
    entries = readStoredCacheEntries();
    writeStoredCacheEntries(mergeWaveformCacheRecord(entries, record, waveformCacheEntryLimit()));
    state.cacheRecord = record;
  }

  function cancel(reason) {
    waveformLog('cancel', Object.assign(identityLogDetails(state.activeIdentity), {
      reason: reason || 'cancelled',
      generationBefore: state.generation,
      requestTokenBefore: state.requestToken,
      sourceState: state.sourceState,
      hasFetch: !!state.abortController,
      hasWorker: !!state.worker,
      workerGeneration: state.workerGeneration,
    }));
    state.generation += 1;
    state.requestToken += 1;
    if (state.abortController) {
      state.abortController.abort(reason || 'cancelled');
      state.abortController = null;
    }
    if (state.worker) {
      if (typeof state.worker.postMessage === 'function') {
        state.worker.postMessage({type: 'cancel', generation: state.workerGeneration});
      }
      state.worker.terminate();
      state.worker = null;
      state.workerGeneration = null;
    }
    if (state.audioContext && typeof state.audioContext.close === 'function') {
      void state.audioContext.close();
      state.audioContext = null;
    }
    state.pointerScrubbing = false;
    state.sourceBytes = null;
    state.sourceDuration = null;
    state.sourceIdentity = null;
    state.sourceState = 'idle';
    state.cacheRecord = null;
    state.latestPeakPayload = null;
    state.latestPeakPreview = false;
    state.latestPeakResolution = null;
    state.latestPeakValues = new Float32Array(0);
    state.peakSummaries = Object.create(null);
    state.processingStartedAt = null;
    state.lastPeakAt = null;
    state.lastRenderedPeakKey = null;
    if (state.panelOpen) scheduleRender();
  }

  function releaseWorker() {
    if (!state.worker) return;
    waveformLog('worker-release', {
      workerGeneration: state.workerGeneration,
      sourceState: state.sourceState,
    });
    state.worker.onmessage = null;
    state.worker.onerror = null;
    state.worker.terminate();
    state.worker = null;
    state.workerGeneration = null;
  }

  function currentCanvasWidth() {
    var canvas = els.waveformCanvas;
    var rect;
    if (!canvas) return 256;
    if (typeof canvas.getBoundingClientRect === 'function') {
      rect = canvas.getBoundingClientRect();
      if (rect && rect.width > 0) return rect.width;
    }
    return Number(canvas.clientWidth) > 0 ? Number(canvas.clientWidth) : 256;
  }

  function currentCanvasRect() {
    var canvas = els.waveformCanvas;
    var rect;
    if (!canvas) return null;
    if (typeof canvas.getBoundingClientRect === 'function') {
      rect = canvas.getBoundingClientRect();
      if (rect && Number(rect.width) > 0 && Number(rect.height) > 0) return rect;
    }
    return {
      left: 0,
      top: 0,
      width: Number(canvas.clientWidth) > 0 ? Number(canvas.clientWidth) : 256,
      height: Number(canvas.clientHeight) > 0 ? Number(canvas.clientHeight) : 92,
    };
  }

  function audioDuration() {
    var duration = els.audio && Number(els.audio.duration);
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  }

  function audioCurrentTime() {
    var currentTime = els.audio && Number(els.audio.currentTime);
    return Number.isFinite(currentTime) && currentTime >= 0 ? currentTime : 0;
  }

  function requestFrame(callback) {
    if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
    return setTimeout(callback, 16);
  }

  function cancelFrame(frameId) {
    if (frameId === null || frameId === undefined) return;
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameId);
    else clearTimeout(frameId);
  }

  function drawWaveformShape(context, peaks, width, height) {
    var center = height / 2;
    var amplitudeScale = Math.max(1, height * 0.42);
    var peakCount = peaks.length;
    var x;
    var peak;
    var amplitude;
    if (!peakCount) return;
    context.beginPath();
    for (x = 0; x <= width; x += 1) {
      peak = Number(peaks[Math.min(peakCount - 1, Math.floor(x / width * peakCount))]) || 0;
      amplitude = Math.max(1, Math.min(amplitudeScale, peak * amplitudeScale));
      if (x === 0) context.moveTo(x, center - amplitude);
      else context.lineTo(x, center - amplitude);
    }
    for (x = width; x >= 0; x -= 1) {
      peak = Number(peaks[Math.min(peakCount - 1, Math.floor(x / width * peakCount))]) || 0;
      amplitude = Math.max(1, Math.min(amplitudeScale, peak * amplitudeScale));
      context.lineTo(x, center + amplitude);
    }
    context.closePath();
    context.fill();
  }

  function renderCanvas() {
    var canvas = els.waveformCanvas;
    var rect;
    var context;
    var width;
    var height;
    var dpr;
    var duration;
    var playheadFraction;
    var playheadX;
    var renderKey;
    if (!state.panelOpen || state.destroyed || !canvas || typeof canvas.getContext !== 'function') return;
    rect = currentCanvasRect();
    if (!rect) return;
    width = Math.max(1, Number(rect.width));
    height = Math.max(1, Number(rect.height));
    dpr = typeof window !== 'undefined' && Number(window.devicePixelRatio) > 0
      ? Number(window.devicePixelRatio)
      : 1;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#0b1220';
    context.fillRect(0, 0, width, height);
    if (state.latestPeakValues.length) {
      context.fillStyle = '#4f789c';
      drawWaveformShape(context, state.latestPeakValues, width, height);
      duration = audioDuration();
      if (duration !== null) {
        playheadFraction = Math.max(0, Math.min(1, audioCurrentTime() / duration));
        context.save();
        context.beginPath();
        context.rect(0, 0, width * playheadFraction, height);
        context.clip();
        context.fillStyle = '#b6dcf7';
        drawWaveformShape(context, state.latestPeakValues, width, height);
        context.restore();
      }
    }
    duration = audioDuration();
    if (duration !== null) {
      playheadFraction = Math.max(0, Math.min(1, audioCurrentTime() / duration));
      playheadX = Math.round(playheadFraction * width) + 0.5;
      context.beginPath();
      context.moveTo(playheadX, 0);
      context.lineTo(playheadX, height);
      context.strokeStyle = '#f8fbff';
      context.lineWidth = 1;
      context.stroke();
      canvas.setAttribute('aria-label', 'Combined audio waveform. Current position ' +
        audioCurrentTime().toFixed(1) + ' of ' + duration.toFixed(1) + ' seconds.');
    }
    renderKey = String(state.latestPeakResolution || 0) + ':' +
      String(state.latestPeakPreview === true) + ':' + String(state.latestPeakPayload || '');
    if (state.lastRenderedPeakKey !== renderKey && state.latestPeakResolution) {
      state.lastRenderedPeakKey = renderKey;
      waveformLog('canvas-render', Object.assign(peakLogDetails(state.latestPeakValues), {
        resolution: state.latestPeakResolution,
        preview: state.latestPeakPreview === true,
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
        devicePixelRatio: dpr,
      }));
    }
  }

  function scheduleRender() {
    if (!state.panelOpen || state.destroyed || state.renderFrameId !== null) return;
    state.renderFrameId = requestFrame(function () {
      state.renderFrameId = null;
      renderCanvas();
    });
  }

  function stopPlayheadLoop() {
    cancelFrame(state.playheadFrameId);
    state.playheadFrameId = null;
  }

  function startPlayheadLoop() {
    if (state.playheadFrameId !== null || !state.panelOpen || !audioIsPlaying()) return;
    function tick() {
      state.playheadFrameId = null;
      if (!state.panelOpen || state.destroyed || !audioIsPlaying()) {
        scheduleRender();
        return;
      }
      renderCanvas();
      state.playheadFrameId = requestFrame(tick);
    }
    tick();
  }

  function connectResizeObserver() {
    if (!els.waveformCanvas || state.resizeObserver) return;
    if (typeof ResizeObserver === 'function') {
      state.resizeObserver = new ResizeObserver(scheduleRender);
      state.resizeObserver.observe(els.waveformCanvas);
    }
  }

  function disconnectResizeObserver() {
    if (!state.resizeObserver) return;
    state.resizeObserver.disconnect();
    state.resizeObserver = null;
  }

  function seekFromPointer(event) {
    var duration = audioDuration();
    var rect = currentCanvasRect();
    var targetTime;
    if (!els.audio || duration === null || !event || !rect) return false;
    targetTime = pointerPositionToPlaybackTime(event.clientX, rect, duration);
    if (targetTime === null) return false;
    els.audio.currentTime = targetTime;
    if (ctx.playbackApi && typeof ctx.playbackApi.syncCurrentTimeDisplay === 'function') {
      ctx.playbackApi.syncCurrentTimeDisplay();
    }
    scheduleRender();
    return true;
  }

  function handlePointerDown(event) {
    if (!state.panelOpen || !seekFromPointer(event)) return;
    state.pointerScrubbing = true;
    state.scrubPointerId = event.pointerId;
    if (els.waveformCanvas && typeof els.waveformCanvas.setPointerCapture === 'function') {
      els.waveformCanvas.setPointerCapture(event.pointerId);
    }
    if (event.preventDefault) event.preventDefault();
  }

  function handlePointerMove(event) {
    if (!state.pointerScrubbing || event.pointerId !== state.scrubPointerId) return;
    seekFromPointer(event);
    if (event.preventDefault) event.preventDefault();
  }

  function handlePointerEnd(event) {
    if (!state.pointerScrubbing || event.pointerId !== state.scrubPointerId) return;
    seekFromPointer(event);
    state.pointerScrubbing = false;
    state.scrubPointerId = null;
    if (els.waveformCanvas && typeof els.waveformCanvas.releasePointerCapture === 'function') {
      els.waveformCanvas.releasePointerCapture(event.pointerId);
    }
    if (event.preventDefault) event.preventDefault();
  }

  function targetResolution() {
    var dpr = typeof window !== 'undefined' && Number(window.devicePixelRatio)
      ? Number(window.devicePixelRatio)
      : 1;
    return chooseWaveformResolution(currentCanvasWidth(), dpr, maximumResolution);
  }

  function handleWorkerFailure(token, identity) {
    if (!isCurrentRequest(token, identity)) return;
    waveformLog('worker-error', Object.assign(identityLogDetails(identity), {
      generation: state.workerGeneration,
    }));
    releaseWorker();
    state.sourceState = 'error';
    setStatus('Could not build the audio visualization. Playback is unaffected.');
  }

  function handleWorkerMessage(event, token, identity) {
    var message = event && event.data ? event.data : {};
    if (!isCurrentRequest(token, identity) || message.generation !== state.workerGeneration) return;
    if (message.type === 'peaks' && Number.isInteger(message.resolution) && typeof message.peaks === 'string') {
      var peakReceivedAt = waveformClock();
      var previousPeakAt = state.lastPeakAt;
      state.peakSummaries[String(message.resolution)] = message.peaks;
      state.latestPeakPayload = message.peaks;
      state.latestPeakPreview = message.preview === true;
      state.latestPeakResolution = message.resolution;
      try {
        state.latestPeakValues = unpackWaveformPeaks(message.peaks);
      } catch (error) {
        state.latestPeakValues = new Float32Array(0);
      }
      state.sourceState = 'processing';
      state.lastPeakAt = peakReceivedAt;
      waveformLog('worker-stage', Object.assign(identityLogDetails(identity), peakLogDetails(state.latestPeakValues), {
        generation: message.generation,
        resolution: message.resolution,
        preview: message.preview === true,
        sampleRound: message.sampleRound,
        sampleRounds: message.sampleRounds,
        completedSamples: message.completedSamples,
        totalSamples: message.totalSamples,
        payloadLength: message.peaks.length,
        elapsedMs: state.processingStartedAt === null ? null : Math.round(peakReceivedAt - state.processingStartedAt),
        sincePreviousMs: previousPeakAt === null ? null : Math.round(peakReceivedAt - previousPeakAt),
      }));
      if (Number.isInteger(message.sampleRound) && Number.isInteger(message.sampleRounds) &&
          Number.isInteger(message.completedSamples) && Number.isInteger(message.totalSamples)) {
        setStatus('Audio visualization sample round ' + message.sampleRound + '/' + message.sampleRounds + ': ' +
          message.completedSamples + ' of ' + message.totalSamples + ' samples completed.');
      } else {
        setStatus(message.preview === true
          ? 'Audio visualization preview ready; refining at ' + message.resolution + ' columns.'
          : 'Audio visualization refining at ' + message.resolution + ' columns.');
      }
      scheduleRender();
      return;
    }
    if (message.type === 'complete') {
      waveformLog('worker-complete', Object.assign(identityLogDetails(identity), {
        generation: message.generation,
        elapsedMs: state.processingStartedAt === null ? null : Math.round(waveformClock() - state.processingStartedAt),
        resolution: state.latestPeakResolution,
        preview: state.latestPeakPreview === true,
      }));
      state.sourceState = 'ready';
      saveCompletedCache(identity);
      setStatus(state.latestPeakResolution
        ? 'Audio visualization ready at ' + state.latestPeakResolution + ' samples.'
        : 'Audio visualization ready.');
      scheduleRender();
      releaseWorker();
    }
  }

  function createWorker(token, identity) {
    if (state.destroyed || state.worker) return state.worker;
    state.worker = workerFactory();
    state.workerGeneration = state.generation;
    waveformLog('worker-create', Object.assign(identityLogDetails(identity), {
      generation: state.workerGeneration,
    }));
    state.worker.onmessage = function (event) {
      handleWorkerMessage(event, token, identity);
    };
    state.worker.onerror = function () {
      handleWorkerFailure(token, identity);
    };
    return state.worker;
  }

  function setActiveSong(song) {
    var identity = waveformIdentityForSong(song);
    if (!sameWaveformIdentity(state.activeIdentity, identity)) {
      waveformLog('song-change', Object.assign(identityLogDetails(state.activeIdentity), {
        next: identityLogDetails(identity),
      }));
      cancel('song-changed');
      if (state.panelOpen && identity) {
        state.sourceState = 'waiting';
        setStatus('Waiting for audio data to load for visualization.');
      }
    }
    state.activeIdentity = identity;
    return identity;
  }

  function lookupCache(entries, song) {
    var key = waveformCacheKey(song || state.activeIdentity);
    state.cacheRecord = findWaveformCacheRecord(entries, key, {
      maxResolution: WAVEFORM_MAX_RESOLUTION,
    });
    return state.cacheRecord;
  }

  function currentSong() {
    return ctx.playbackApi && typeof ctx.playbackApi.currentSong === 'function'
      ? ctx.playbackApi.currentSong()
      : null;
  }

  function audioIsPlaying() {
    return !!(els.audio && !els.audio.paused && !els.audio.ended);
  }

  function isCurrentRequest(token, identity) {
    return !state.destroyed && state.panelOpen &&
      state.requestToken === token && state.generation >= 0 &&
      sameWaveformIdentity(state.activeIdentity, identity);
  }

  function waitForPlayback() {
    state.sourceState = 'waiting';
    setStatus('Start playback to build the audio visualization.');
  }

  function clearStoredCache(identity) {
    var key;
    var entries;
    var remaining;
    if (!identity || waveformCacheEntryLimit() <= 0) return false;
    key = waveformCacheKey(identity);
    if (!key) return false;
    entries = readStoredCacheEntries();
    remaining = entries.filter(function (entry) { return entry.key !== key; });
    if (remaining.length === entries.length) return false;
    writeStoredCacheEntries(remaining);
    return true;
  }

  function clearAndReload() {
    var song;
    var identity;
    var cleared;
    if (state.destroyed) return false;
    song = currentSong();
    identity = waveformIdentityForSong(song) || state.activeIdentity;
    cleared = clearStoredCache(identity);
    waveformLog('cache-clear-reload', Object.assign(identityLogDetails(identity), {
      cleared: cleared,
      panelOpen: state.panelOpen,
      audioPlaying: audioIsPlaying(),
    }));
    cancel('manual-reload');
    if (!state.panelOpen) {
      setStatus('Open Audio Visualization after playback starts.');
      return false;
    }
    if (!song || !audioIsPlaying()) {
      waitForPlayback();
      return false;
    }
    state.activeIdentity = identity;
    state.sourceState = 'waiting';
    setStatus('Waiting for audio data to load for visualization.');
    return startForCurrentSong();
  }

  async function decodeAndReduce(bytes, token, identity) {
    var context;
    var decoded;
    var copied;
    var worker;
    var payload;
    var decodeStartedAt = waveformClock();
    try {
      context = audioContextFactory();
      if (!context || typeof context.decodeAudioData !== 'function') {
        throw new Error('AudioContext.decodeAudioData is unavailable');
      }
      state.audioContext = context;
      state.sourceState = 'decoding';
      state.sourceBytes = null;
      waveformLog('decode-start', Object.assign(identityLogDetails(identity), {
        byteLength: bytes && bytes.byteLength ? bytes.byteLength : 0,
      }));
      decoded = await decodeAudioData(context, bytes);
      if (!isCurrentRequest(token, identity)) {
        waveformLog('decode-stale-result', Object.assign(identityLogDetails(identity), {
          elapsedMs: Math.round(waveformClock() - decodeStartedAt),
        }));
        return false;
      }
      state.sourceDuration = Number(decoded && decoded.duration);
      if (!Number.isFinite(state.sourceDuration) || state.sourceDuration <= 0) {
        state.sourceDuration = audioDuration();
      }
      copied = copyDecodedChannels(decoded);
      if (!copied.channels.length) throw new Error('Decoded audio has no channels');
      waveformLog('decode-done', Object.assign(identityLogDetails(identity), {
        elapsedMs: Math.round(waveformClock() - decodeStartedAt),
        duration: state.sourceDuration,
        channels: copied.channels.length,
        sampleCounts: copied.channels.map(function (channel) { return channel.length; }),
      }));
      if (typeof context.close === 'function') {
        void context.close();
      }
      state.audioContext = null;
      worker = createWorker(token, identity);
      state.peakSummaries = Object.create(null);
      state.latestPeakPayload = null;
      state.latestPeakPreview = false;
      state.latestPeakResolution = null;
      state.processingStartedAt = waveformClock();
      state.lastPeakAt = null;
      state.lastRenderedPeakKey = null;
      state.sourceState = 'processing';
      payload = {
        type: 'start',
        generation: state.workerGeneration,
        channels: copied.channels,
        targetResolution: targetResolution(),
        maxResolution: maximumResolution,
      };
      if (typeof worker.postMessage !== 'function') throw new Error('Waveform worker is unavailable');
      waveformLog('worker-start', Object.assign(identityLogDetails(identity), {
        generation: state.workerGeneration,
        targetResolution: payload.targetResolution,
        maxResolution: payload.maxResolution,
        channels: copied.channels.length,
      }));
      worker.postMessage(payload, copied.transferables);
      return true;
    } catch (error) {
      if (!isCurrentRequest(token, identity)) return false;
      if (state.audioContext && typeof state.audioContext.close === 'function') {
        void state.audioContext.close();
      }
      state.audioContext = null;
      releaseWorker();
      state.sourceBytes = null;
      state.sourceState = 'error';
      waveformLog('decode-error', Object.assign(identityLogDetails(identity), {
        elapsedMs: Math.round(waveformClock() - decodeStartedAt),
        message: error && error.message ? error.message : String(error || ''),
      }));
      setStatus('Could not decode the audio for visualization. Playback is unaffected.');
      return false;
    }
  }

  async function startForCurrentSong() {
    var song;
    var identity;
    var streamUrl;
    var token;
    var response;
    var bytes;
    if (state.destroyed || !state.panelOpen) return false;
    song = currentSong();
    if (!song || !audioIsPlaying()) {
      waveformLog('start-deferred', {
        panelOpen: state.panelOpen,
        hasSong: !!song,
        audioPlaying: audioIsPlaying(),
      });
      waitForPlayback();
      return false;
    }
    identity = setActiveSong(song);
    if (!identity) {
      waveformLog('start-deferred-invalid-song');
      waitForPlayback();
      return false;
    }
    if (state.sourceIdentity && sameWaveformIdentity(state.sourceIdentity, identity)) {
      if (state.sourceState === 'fetching' || state.sourceState === 'decoding' ||
          state.sourceState === 'processing' || state.sourceState === 'ready') return true;
      if (state.sourceState === 'loaded' && state.sourceBytes) {
        token = state.requestToken;
        return decodeAndReduce(state.sourceBytes, token, identity);
      }
    }
    if (state.sourceState !== 'ready') {
      var cachedRecord = loadStoredCache(identity);
      if (cachedRecord && applyCacheRecord(cachedRecord, identity)) return true;
      waveformLog('cache-miss', identityLogDetails(identity));
    }
    if (state.sourceState === 'fetching') return true;
    if (!ctx.playbackApi || typeof ctx.playbackApi.streamUrl !== 'function') {
      state.sourceState = 'error';
      setStatus('Audio visualization is unavailable for this song.');
      return false;
    }
    if (typeof fetch !== 'function' || typeof AbortController !== 'function') {
      state.sourceState = 'error';
      setStatus('Audio visualization is not supported by this browser.');
      return false;
    }
    state.sourceIdentity = identity;
    state.sourceState = 'fetching';
    state.sourceBytes = null;
    setStatus('Pulling audio data for visualization.');
    token = state.requestToken;
    state.abortController = new AbortController();
    streamUrl = ctx.playbackApi.streamUrl(song);
    var fetchStartedAt = waveformClock();
    waveformLog('fetch-start', Object.assign(identityLogDetails(identity), {
      generation: state.generation,
      requestToken: token,
    }));
    try {
      response = await fetch(streamUrl, {signal: state.abortController.signal});
      if (!isCurrentRequest(token, identity)) {
        waveformLog('fetch-stale-response', Object.assign(identityLogDetails(identity), {
          elapsedMs: Math.round(waveformClock() - fetchStartedAt),
        }));
        return false;
      }
      if (!response || !response.ok) throw new Error('Waveform source request failed');
      bytes = await response.arrayBuffer();
      if (!isCurrentRequest(token, identity)) {
        waveformLog('fetch-stale-bytes', Object.assign(identityLogDetails(identity), {
          elapsedMs: Math.round(waveformClock() - fetchStartedAt),
          byteLength: bytes && bytes.byteLength ? bytes.byteLength : 0,
        }));
        return false;
      }
      state.sourceBytes = bytes;
      state.sourceState = 'loaded';
      state.abortController = null;
      waveformLog('fetch-done', Object.assign(identityLogDetails(identity), {
        elapsedMs: Math.round(waveformClock() - fetchStartedAt),
        byteLength: bytes.byteLength,
        status: response.status,
      }));
      setStatus('Audio source loaded; decoding for visualization.');
      return decodeAndReduce(bytes, token, identity);
    } catch (error) {
      if (!isCurrentRequest(token, identity)) {
        waveformLog('fetch-stale-error', Object.assign(identityLogDetails(identity), {
          elapsedMs: Math.round(waveformClock() - fetchStartedAt),
          name: error && error.name ? error.name : '',
        }));
        return false;
      }
      state.abortController = null;
      state.sourceState = error && error.name === 'AbortError' ? 'idle' : 'error';
      waveformLog('fetch-error', Object.assign(identityLogDetails(identity), {
        elapsedMs: Math.round(waveformClock() - fetchStartedAt),
        name: error && error.name ? error.name : '',
        message: error && error.message ? error.message : String(error || ''),
      }));
      if (state.sourceState === 'error') setStatus('Could not prepare the audio visualization.');
      return false;
    }
  }

  function handleDetailsToggle() {
    if (state.destroyed || !els.waveformDetails) return;
    state.panelOpen = !!els.waveformDetails.open;
    if (!state.panelOpen) {
      stopPlayheadLoop();
      disconnectResizeObserver();
      cancelFrame(state.renderFrameId);
      state.renderFrameId = null;
      cancel('panel-closed');
      setStatus('Open Audio Visualization after playback starts.');
      return;
    }
    connectResizeObserver();
    scheduleRender();
    setStatus('Waiting for playback to start before loading audio data.');
    startPlayheadLoop();
    void startForCurrentSong();
  }

  function handleAudioEmptied() {
    setActiveSong(null);
  }

  function handleAudioPlaying() {
    startPlayheadLoop();
    scheduleRender();
    void startForCurrentSong();
  }

  function deactivate() {
    state.panelOpen = false;
    stopPlayheadLoop();
    disconnectResizeObserver();
    cancelFrame(state.renderFrameId);
    state.renderFrameId = null;
    cancel('inactive');
  }

  function activate() {
    if (state.destroyed) return;
    state.panelOpen = !!(els.waveformDetails && els.waveformDetails.open);
    if (state.panelOpen) {
      connectResizeObserver();
      scheduleRender();
      startPlayheadLoop();
      setStatus('Waiting for playback to start before loading audio data.');
      void startForCurrentSong();
    }
  }

  function destroy() {
    if (state.destroyed) return;
    state.destroyed = true;
    stopPlayheadLoop();
    disconnectResizeObserver();
    cancelFrame(state.renderFrameId);
    state.renderFrameId = null;
    cancel('destroyed');
    if (els.waveformDetails) els.waveformDetails.removeEventListener('toggle', handleDetailsToggle);
    if (els.waveformReloadButton) els.waveformReloadButton.removeEventListener('click', clearAndReload);
    if (els.audio) els.audio.removeEventListener('emptied', handleAudioEmptied);
    if (els.audio) els.audio.removeEventListener('playing', handleAudioPlaying);
    if (els.audio) els.audio.removeEventListener('timeupdate', scheduleRender);
    if (els.audio) els.audio.removeEventListener('durationchange', scheduleRender);
    if (els.audio) els.audio.removeEventListener('play', startPlayheadLoop);
    if (els.audio) els.audio.removeEventListener('pause', stopPlayheadLoop);
    if (els.waveformCanvas && typeof els.waveformCanvas.removeEventListener === 'function') {
      els.waveformCanvas.removeEventListener('pointerdown', handlePointerDown);
      els.waveformCanvas.removeEventListener('pointermove', handlePointerMove);
      els.waveformCanvas.removeEventListener('pointerup', handlePointerEnd);
      els.waveformCanvas.removeEventListener('pointercancel', handlePointerEnd);
    }
  }

  if (els.waveformDetails) els.waveformDetails.addEventListener('toggle', handleDetailsToggle);
  if (els.waveformReloadButton) els.waveformReloadButton.addEventListener('click', clearAndReload);
  if (els.audio) els.audio.addEventListener('emptied', handleAudioEmptied);
  if (els.audio) els.audio.addEventListener('playing', handleAudioPlaying);
  if (els.audio) els.audio.addEventListener('timeupdate', scheduleRender);
  if (els.audio) els.audio.addEventListener('durationchange', scheduleRender);
  if (els.audio) els.audio.addEventListener('play', startPlayheadLoop);
  if (els.audio) els.audio.addEventListener('pause', stopPlayheadLoop);
  if (els.waveformCanvas && typeof els.waveformCanvas.addEventListener === 'function') {
    els.waveformCanvas.addEventListener('pointerdown', handlePointerDown);
    els.waveformCanvas.addEventListener('pointermove', handlePointerMove);
    els.waveformCanvas.addEventListener('pointerup', handlePointerEnd);
    els.waveformCanvas.addEventListener('pointercancel', handlePointerEnd);
  }

  return {
    cancel: cancel,
    clearAndReload: clearAndReload,
    activate: activate,
    createWorker: createWorker,
    deactivate: deactivate,
    destroy: destroy,
    generation: function () { return state.generation; },
    isOpen: function () { return state.panelOpen; },
    lookupCache: lookupCache,
    renderNow: renderCanvas,
    startForCurrentSong: startForCurrentSong,
    setActiveSong: setActiveSong,
    state: state,
  };
}
