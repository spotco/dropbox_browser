import Hls from './vendor/hls.js';

function previewUrl(path, source) {
  var params = new URLSearchParams();
  params.set('path', path || '');
  params.set('source', source || 'remote');
  return '/preview?' + params.toString();
}

function posterUrl(path, source) {
  var params = new URLSearchParams();
  params.set('path', path || '');
  params.set('source', source || 'remote');
  return '/video/endpoints/thumbnail?' + params.toString();
}

function createClientId(win) {
  if (win && win.crypto && typeof win.crypto.randomUUID === 'function') {
    return 'photo-map-preview-' + win.crypto.randomUUID();
  }
  return 'photo-map-preview-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function encodedForm(values) {
  return Object.keys(values).map(function (key) {
    return encodeURIComponent(key) + '=' + encodeURIComponent(String(values[key] == null ? '' : values[key]));
  }).join('&');
}

function createPhotoMapPreviewController(options) {
  var config = options || {};
  var doc = config.document || (typeof document !== 'undefined' ? document : null);
  var win = config.window || (typeof window !== 'undefined' ? window : null);
  var fetchImpl = config.fetchImpl || (win && typeof win.fetch === 'function' ? win.fetch.bind(win) : null);
  if (!doc || !win || typeof fetchImpl !== 'function') return null;

  var overlay = config.overlay || null;
  var standalone = Boolean(config.standalone);
  var els = {};
  var state = {active: false, path: '', source: 'remote', mediaKind: 'video', sessionId: '', hls: null, pushed: false, generation: 0, progressTimer: null, previewContext: null, fallbackAttempted: false};
  var clientId = createClientId(win);
  var lastFocus = null;

  function setStatus(message, isError) {
    if (!els.status) return;
    els.status.textContent = message || '';
    els.status.dataset.state = isError ? 'error' : 'idle';
  }

  function bindElements(root) {
    els.root = root;
    els.poster = root.querySelector('#photo-map-preview-poster');
    els.video = root.querySelector('#photo-map-preview-video');
    els.play = root.querySelector('#photo-map-preview-play');
    els.mute = root.querySelector('#photo-map-preview-mute');
    els.status = root.querySelector('#photo-map-preview-status');
    els.close = root.querySelector('#photo-map-preview-close');
    els.download = root.querySelector('#photo-map-preview-download');
    els.surface = root.querySelector('.photo-map-preview-surface');
  }

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = doc.createElement('div');
    overlay.id = 'photo-map-preview-overlay';
    overlay.className = 'photo-map-preview-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'photo-map-preview-overlay-title');
    overlay.hidden = true;
    overlay.innerHTML = '<div class="photo-map-preview-backdrop" data-photo-map-preview-close="true"></div>' +
      '<section class="photo-map-preview-dialog" role="document">' +
      '<div class="photo-map-preview-page-header"><h2 id="photo-map-preview-overlay-title"></h2>' +
      '<button type="button" id="photo-map-preview-close" class="photo-map-preview-close" aria-label="Close media preview">&times;</button></div>' +
      '<div id="photo-map-preview-status" class="photo-map-preview-status" role="status" aria-live="polite"></div>' +
      '<div class="photo-map-preview-surface" aria-label="Media preview">' +
      '<img id="photo-map-preview-poster" class="photo-map-preview-page-poster" alt="Media preview" loading="eager">' +
      '<video id="photo-map-preview-video" class="photo-map-preview-page-video" controls playsinline preload="metadata" muted></video>' +
      '<button type="button" id="photo-map-preview-play" class="photo-map-preview-play-button" aria-label="Play video">&#9654; <span>Play</span></button>' +
      '<button type="button" id="photo-map-preview-mute" class="photo-map-preview-mute-button" aria-label="Unmute video" title="Unmute video">&#128263;</button>' +
      '</div><a id="photo-map-preview-download" class="photo-map-preview-download" href="#">Download Original</a>' +
      '</section>';
    (doc.body || doc.documentElement).appendChild(overlay);
    return overlay;
  }

  function resetMedia() {
    if (state.progressTimer !== null) {
      if (win && typeof win.clearInterval === 'function') win.clearInterval(state.progressTimer);
      else clearInterval(state.progressTimer);
      state.progressTimer = null;
    }
    if (els.hls) {
      try { els.hls.destroy(); } catch (_error) {}
      els.hls = null;
    }
    if (els.video) {
      els.video.pause();
      els.video.removeAttribute('src');
      try { els.video.load(); } catch (_error) {}
    }
  }

  function reportProgress(playbackState) {
    if (!state.sessionId || !els.video) return;
    var body = encodedForm({
      id: state.sessionId,
      client_id: clientId,
      playback_seconds: Number.isFinite(els.video.currentTime) ? Math.max(0, els.video.currentTime) : 0,
      playback_media_seconds: Number.isFinite(els.video.currentTime) ? Math.max(0, els.video.currentTime) : 0,
      playback_state: playbackState || (els.video.paused ? 'paused' : 'playing'),
    });
    void fetchImpl('/video/endpoints/session/progress', {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8'},
      body: body,
    }).catch(function () {});
  }

  async function stopSession(id, unloadSafe) {
    var sessionId = String(id || '');
    if (!sessionId) return;
    var body = encodedForm({id: sessionId, client_id: clientId});
    try {
      await fetchImpl('/video/endpoints/session/stop', {
        method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8'},
        body: body,
        ...(unloadSafe ? {keepalive: true} : {}),
      });
    } catch (_error) {
      if (unloadSafe && win.navigator && typeof win.navigator.sendBeacon === 'function') {
        try { win.navigator.sendBeacon('/video/endpoints/session/stop', new Blob([body], {type: 'application/x-www-form-urlencoded; charset=UTF-8'})); } catch (_beaconError) {}
      }
    }
  }

  async function start(options) {
    var startOptions = options || {};
    if (!state.active || state.mediaKind !== 'video' || !els.video || !state.path) return;
    var generation = ++state.generation;
    setStatus('Preparing compatible video…');
    els.play.hidden = true;
    els.video.muted = true;
    resetMedia();
    try {
      var response = await fetchImpl('/video/endpoints/session', {
        method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8'},
        body: encodedForm(Object.assign({path: state.path, source: 'remote', client_id: clientId, start_time_seconds: 0},
          startOptions.forceFallback ? {force_video_transcode: 1, force_audio_transcode: 1} : {})),
      });
      if (!response.ok) throw new Error('The compatible video session could not be created.');
      var payload = await response.json();
      if (!state.active || generation !== state.generation) {
        await stopSession(payload && payload.session_id, false);
        return;
      }
      state.sessionId = String(payload.session_id || payload.id || '');
      var playlistUrl = String(payload.playlist_url || '');
      if (!playlistUrl) throw new Error('The video session did not return a playlist.');
      state.progressTimer = (win && typeof win.setInterval === 'function' ? win.setInterval : setInterval)(function () { reportProgress(); }, 2000);
      els.video.addEventListener('playing', function () { reportProgress('playing'); });
      els.video.addEventListener('pause', function () { reportProgress('paused'); });
      els.video.addEventListener('loadeddata', function () { if (state.active && generation === state.generation) { els.poster.hidden = true; setStatus(''); } }, {once: true});
      els.video.addEventListener('canplay', function () { if (state.active && generation === state.generation) els.poster.hidden = true; }, {once: true});
      els.video.addEventListener('ended', function () { if (state.active && generation === state.generation) { setStatus('Playback ended.'); reportProgress('paused'); } });
      if (Hls && typeof Hls.isSupported === 'function' && Hls.isSupported()) {
        els.hls = new Hls({enableWorker: true, lowLatencyMode: false});
        els.hls.on(Hls.Events.MANIFEST_PARSED, function () {
          if (!state.active || generation !== state.generation) return;
          els.poster.hidden = true;
          setStatus('');
          var playPromise = els.video.play();
          if (playPromise && typeof playPromise.catch === 'function') playPromise.catch(function () {});
        });
        els.hls.on(Hls.Events.ERROR, function (_event, data) {
          if (data && data.fatal && state.active && generation === state.generation) {
            if (!state.fallbackAttempted) {
              state.fallbackAttempted = true;
              var failedSession = state.sessionId;
              state.sessionId = '';
              void stopSession(failedSession, false).then(function () { return start({forceFallback: true}); });
            } else {
              setStatus('Compatible playback failed. Use Download Original.', true);
              els.play.hidden = false;
            }
          }
        });
        els.hls.loadSource(playlistUrl);
        els.hls.attachMedia(els.video);
      } else if (els.video.canPlayType('application/vnd.apple.mpegurl')) {
        els.video.src = playlistUrl;
        await els.video.play();
      } else {
        throw new Error('This browser cannot play the compatible preview stream.');
      }
    } catch (error) {
      if (generation !== state.generation || !state.active) return;
      if (!state.fallbackAttempted) {
        state.fallbackAttempted = true;
        var failedSession = state.sessionId;
        state.sessionId = '';
        void stopSession(failedSession, false).then(function () { return start({forceFallback: true}); });
      } else {
        setStatus(error && error.message ? error.message : 'Unable to prepare video playback.', true);
        els.play.hidden = false;
      }
    }
  }

  function updateMute() {
    if (!els.video || !els.mute) return;
    var muted = Boolean(els.video.muted);
    els.mute.textContent = muted ? '\u{1F50A}' : '\u{1F507}';
    els.mute.setAttribute('aria-label', muted ? 'Unmute video' : 'Mute video');
    els.mute.title = muted ? 'Unmute video' : 'Mute video';
  }

  function handleOverlayKeydown(event) {
    if (!state.active) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      void close();
      return;
    }
    if (event.key !== 'Tab' || standalone || !overlay) return;
    var focusable = Array.from(overlay.querySelectorAll('button, a[href], video'))
      .filter(function (element) { return !element.hidden && !element.disabled; });
    if (!focusable.length) return;
    var index = focusable.indexOf(doc.activeElement);
    var next = event.shiftKey
      ? (index <= 0 ? focusable.length - 1 : index - 1)
      : (index < 0 || index === focusable.length - 1 ? 0 : index + 1);
    event.preventDefault();
    focusable[next].focus();
  }

  async function close(options) {
    var shouldRestoreHistory = !options || options.restoreHistory !== false;
    if (!state.active) return;
    state.active = false;
    state.generation += 1;
    var oldSession = state.sessionId;
    state.sessionId = '';
    resetMedia();
    await stopSession(oldSession, false);
    if (els.root && !standalone) els.root.hidden = true;
    if (doc.body) doc.body.classList.remove('photo-map-preview-open');
    if (!standalone && state.previewContext && win.DropboxBrowserPhotoMap &&
        typeof win.DropboxBrowserPhotoMap.restorePreviewContext === 'function') {
      win.DropboxBrowserPhotoMap.restorePreviewContext(state.previewContext);
    }
    state.previewContext = null;
    if (shouldRestoreHistory && state.pushed && win.history && win.history.state && win.history.state.photoMapPreview) win.history.back();
    state.pushed = false;
    if (lastFocus && typeof lastFocus.focus === 'function') {
      try { lastFocus.focus(); } catch (_error) {}
    }
  }

  function open(item) {
    item = item || {};
    var path = String(item.photoMapSourcePath || item.path || '');
    if (!path) return false;
    var source = String(item.source || 'remote');
    if (source !== 'remote') return false;
    var mediaKind = String(item.mediaKind || item.kind || '').toLowerCase();
    if (mediaKind !== 'photo' && mediaKind !== 'video') {
      mediaKind = /\.(?:avi|m2ts|m4v|mkv|mov|mp4|ts|webm|wmv)$/i.test(path) ? 'video' : 'photo';
    }
    if (!standalone) ensureOverlay();
    bindElements(overlay || doc.body);
    state.path = path; state.source = source; state.mediaKind = mediaKind; state.active = true; state.generation += 1; state.fallbackAttempted = false;
    if (!standalone && win.DropboxBrowserPhotoMap &&
        typeof win.DropboxBrowserPhotoMap.capturePreviewContext === 'function') {
      state.previewContext = win.DropboxBrowserPhotoMap.capturePreviewContext();
    }
    lastFocus = doc.activeElement;
    if (els.root) els.root.hidden = false;
    if (doc.body) doc.body.classList.add('photo-map-preview-open');
    var title = String(item.display_name || item.name || path.split('/').pop() || 'Media Preview');
    var titleEl = els.root && els.root.querySelector('#photo-map-preview-overlay-title');
    if (titleEl) titleEl.textContent = title;
    var isVideo = mediaKind === 'video';
    if (els.close) els.close.setAttribute('aria-label', isVideo ? 'Close video preview' : 'Close photo preview');
    if (els.surface) els.surface.setAttribute('aria-label', isVideo ? 'Video preview' : 'Photo preview');
    if (els.poster) {
      var mediaQuery = new URLSearchParams({path: path, source: source}).toString();
      els.poster.src = mediaKind === 'photo'
        ? '/file?' + mediaQuery
        : String(item.photoMapThumbnailUrl || item.posterUrl || posterUrl(path, source));
      els.poster.alt = isVideo ? 'Video poster' : 'Photo preview';
      els.poster.hidden = false;
    }
    if (els.video) { els.video.muted = true; els.video.hidden = mediaKind !== 'video'; }
    if (els.play) els.play.hidden = mediaKind !== 'video';
    if (els.mute) els.mute.hidden = mediaKind !== 'video';
    updateMute();
    if (els.play) { els.play.hidden = mediaKind !== 'video'; if (mediaKind === 'video') els.play.focus(); }
    if (els.download) els.download.href = '/download?' + new URLSearchParams({path: path, source: source}).toString();
    setStatus(mediaKind === 'video' ? 'Click Play to prepare compatible playback.' : '');
    if (!standalone && win.history && typeof win.history.pushState === 'function') {
      var canonical = previewUrl(path, source) + '&kind=' + encodeURIComponent(mediaKind);
      win.history.pushState({photoMapPreview: true, path: path, mediaKind: mediaKind}, '', canonical);
      state.pushed = true;
    }
    return true;
  }

  function destroy() {
    void close({restoreHistory: false});
    if (overlay && !standalone && overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }

  function bind() {
    if (standalone) {
      bindElements(doc.body);
      els.play && els.play.addEventListener('click', start);
      els.mute && els.mute.addEventListener('click', function () { els.video.muted = !els.video.muted; updateMute(); });
      els.video && els.video.addEventListener('volumechange', updateMute);
      var body = doc.body;
      if (body && body.dataset.previewPath) open({path: body.dataset.previewPath, source: body.dataset.previewSource || 'remote', mediaKind: body.dataset.previewKind || 'video', display_name: body.dataset.previewPath.split('/').pop()});
    } else {
      ensureOverlay(); bindElements(overlay);
      els.play.addEventListener('click', start);
      els.mute.addEventListener('click', function () { els.video.muted = !els.video.muted; updateMute(); });
      els.video.addEventListener('volumechange', updateMute);
      els.close.addEventListener('click', function () { void close(); });
      doc.addEventListener('keydown', handleOverlayKeydown);
      overlay.addEventListener('click', function (event) { if (event.target && event.target.dataset && event.target.dataset.photoMapPreviewClose) void close(); });
      doc.addEventListener('click', function (event) {
        var link = event.target && event.target.closest ? event.target.closest('a.photo-map-preview-link') : null;
        var trigger = event.target && event.target.closest ? event.target.closest('[data-photo-map-preview-path]') : null;
        if (!link && !trigger) return;
        event.preventDefault();
        if (trigger) {
          open({
            path: trigger.getAttribute('data-photo-map-preview-path') || '',
            source: trigger.getAttribute('data-photo-map-preview-source') || 'remote',
            mediaKind: trigger.getAttribute('data-photo-map-preview-kind') || 'video',
          });
          return;
        }
        var parsed = new URL(link.href, win.location.origin);
        var mediaPath = parsed.searchParams.get('path') || '';
        var mediaKind = /\.(?:avi|m2ts|m4v|mkv|mov|mp4|ts|webm|wmv)$/i.test(mediaPath) ? 'video' : 'photo';
        open({path: mediaPath, source: parsed.searchParams.get('source') || 'remote', mediaKind: mediaKind, posterUrl: link.querySelector('img') && link.querySelector('img').src});
      });
      win.addEventListener('popstate', function () { if (state.active && (!win.history.state || !win.history.state.photoMapPreview)) void close({restoreHistory: false}); });
      win.addEventListener('beforeunload', function () { if (state.sessionId) void stopSession(state.sessionId, true); });
    }
    return controller;
  }

  var controller = {open: open, close: close, start: start, destroy: destroy, isOpen: function () { return state.active; }, canonicalUrl: previewUrl};
  return {controller: controller, bind: bind};
}

export function initPhotoMapPreviewPage(options) {
  var config = options || {};
  var doc = config.document || (typeof document !== 'undefined' ? document : null);
  if (!doc) return null;
  var standalone = Boolean(doc.body && doc.body.dataset && doc.body.dataset.previewPath);
  var instance = createPhotoMapPreviewController({...config, standalone: standalone});
  return instance ? instance.bind() : null;
}

if (typeof document !== 'undefined') initPhotoMapPreviewPage();

export {createPhotoMapPreviewController, posterUrl, previewUrl};
