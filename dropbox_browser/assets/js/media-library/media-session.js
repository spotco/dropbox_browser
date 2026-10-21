/**
 * Shared Media Session owner for the music and video panes.
 *
 * One document has one `navigator.mediaSession`, so this module is its only
 * writer. Music and video each bind a kind ("music" or "video") with their
 * transport callbacks; ES module identity gives both hosts the same owner.
 *
 * - The kind that most recently claimed (or published a "playing" snapshot)
 *   owns the session. Another kind's paused or position-only updates are
 *   remembered but never written until that kind claims again.
 * - Pausing does not release the session; only releaseMediaSession() by the
 *   owner clears it.
 * - Every browser call is guarded: a missing API makes every call a no-op and
 *   an unsupported action handler cannot block the others.
 *
 * This module must not import from music/ or video/.
 */

export var MEDIA_SESSION_SEEK_STEP_SECONDS = 15;
export var MEDIA_SESSION_POSITION_THROTTLE_MS = 1000;

var TRANSPORT_ACTIONS = ['play', 'pause', 'previoustrack', 'nexttrack'];
var SEEK_ACTIONS = ['seekbackward', 'seekforward', 'seekto'];
var PLAYBACK_STATES = {playing: true, paused: true, none: true};

var bindings = Object.create(null);
var snapshots = Object.create(null);
var owner = null;
var written = freshWrittenState();
var now = function () {
  return Date.now();
};

function freshWrittenState() {
  return {
    metadataKey: null,
    playbackState: null,
    seekHandlersInstalled: null,
    positionWrittenAtMs: null
  };
}

function mediaSession() {
  try {
    if (typeof navigator === 'undefined' || !navigator) return null;
    return navigator.mediaSession || null;
  } catch (_error) {
    return null;
  }
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function setActionHandler(session, action, handler) {
  if (!session || typeof session.setActionHandler !== 'function') return false;
  try {
    session.setActionHandler(action, handler);
    return true;
  } catch (_error) {
    return false;
  }
}

function callAction(kind, name, args) {
  var actions = bindings[kind];
  var fn = actions && actions[name];
  if (owner !== kind || typeof fn !== 'function') return;
  try {
    fn.apply(null, args || []);
  } catch (error) {
    if (typeof console !== 'undefined' && console && typeof console.error === 'function') {
      console.error('media session action failed', kind, name, error);
    }
  }
}

function seekStepSeconds(kind) {
  var snapshot = snapshots[kind] || {};
  var step = snapshot.seekStepSeconds;
  return isFiniteNumber(step) && step > 0 ? step : MEDIA_SESSION_SEEK_STEP_SECONDS;
}

function seekOffsetSeconds(kind, details) {
  var offset = details ? details.seekOffset : undefined;
  return isFiniteNumber(offset) && offset > 0 ? offset : seekStepSeconds(kind);
}

function installTransportHandlers(session, kind) {
  setActionHandler(session, 'play', function () {
    callAction(kind, 'play');
  });
  setActionHandler(session, 'pause', function () {
    callAction(kind, 'pause');
  });
  setActionHandler(session, 'previoustrack', function () {
    callAction(kind, 'previous');
  });
  setActionHandler(session, 'nexttrack', function () {
    callAction(kind, 'next');
  });
}

function syncSeekHandlers(session, kind, force) {
  var snapshot = snapshots[kind] || {};
  var canSeek = Boolean(snapshot.canSeek);
  if (!force && written.seekHandlersInstalled === canSeek) return;
  written.seekHandlersInstalled = canSeek;
  if (!canSeek) {
    SEEK_ACTIONS.forEach(function (action) {
      setActionHandler(session, action, null);
    });
    return;
  }
  // details.fastSeek is ignored: neither player has a fast-seek path that is
  // safe to prefer over its normal seek.
  setActionHandler(session, 'seekbackward', function (details) {
    callAction(kind, 'seekBy', [-seekOffsetSeconds(kind, details)]);
  });
  setActionHandler(session, 'seekforward', function (details) {
    callAction(kind, 'seekBy', [seekOffsetSeconds(kind, details)]);
  });
  setActionHandler(session, 'seekto', function (details) {
    if (!details || !isFiniteNumber(details.seekTime)) return;
    callAction(kind, 'seekTo', [details.seekTime]);
  });
}

function clearAllHandlers(session) {
  TRANSPORT_ACTIONS.concat(SEEK_ACTIONS).forEach(function (action) {
    setActionHandler(session, action, null);
  });
}

function metadataKey(snapshot) {
  return JSON.stringify([
    snapshot.title || '',
    snapshot.artist || '',
    snapshot.album || '',
    snapshot.artworkUrl || '',
    snapshot.artworkUrl ? snapshot.artworkType || '' : ''
  ]);
}

function buildMetadata(snapshot) {
  var init = {
    title: snapshot.title || '',
    artist: snapshot.artist || '',
    album: snapshot.album || ''
  };
  if (snapshot.artworkUrl) {
    var artwork = {src: snapshot.artworkUrl};
    if (snapshot.artworkType) artwork.type = snapshot.artworkType;
    init.artwork = [artwork];
  } else {
    init.artwork = [];
  }
  if (typeof MediaMetadata === 'function') {
    try {
      return new MediaMetadata(init);
    } catch (_error) {
      return init;
    }
  }
  return init;
}

function writeMetadata(session, snapshot, force) {
  var key = metadataKey(snapshot);
  if (!force && key === written.metadataKey) return false;
  written.metadataKey = key;
  try {
    session.metadata = buildMetadata(snapshot);
  } catch (_error) {}
  return true;
}

function writePlaybackState(session, snapshot, force) {
  var playbackState = snapshot.playbackState;
  if (!PLAYBACK_STATES[playbackState]) return false;
  if (!force && playbackState === written.playbackState) return false;
  written.playbackState = playbackState;
  try {
    session.playbackState = playbackState;
  } catch (_error) {}
  return true;
}

function writePosition(session, snapshot, flush) {
  var duration = snapshot.duration;
  var position = snapshot.position;
  var rate = snapshot.playbackRate;
  var at = now();
  if (!isFiniteNumber(duration) || duration < 0 || !isFiniteNumber(position)) return false;
  if (typeof session.setPositionState !== 'function') return false;
  if (!flush && written.positionWrittenAtMs !== null && at - written.positionWrittenAtMs < MEDIA_SESSION_POSITION_THROTTLE_MS) {
    return false;
  }
  written.positionWrittenAtMs = at;
  try {
    session.setPositionState({
      duration: duration,
      playbackRate: isFiniteNumber(rate) && rate > 0 ? rate : 1,
      position: Math.max(0, Math.min(position, duration))
    });
  } catch (_error) {
    // A stale duration during a track change can throw; the next update fixes it.
  }
  return true;
}

function publishOwner(session, kind, flush, force) {
  var snapshot = snapshots[kind];
  if (!snapshot) return;
  var metadataChanged = writeMetadata(session, snapshot, force);
  var stateChanged = writePlaybackState(session, snapshot, force);
  syncSeekHandlers(session, kind, force);
  writePosition(session, snapshot, Boolean(flush || force || metadataChanged || stateChanged));
}

function mergeSnapshot(kind, snapshot) {
  var merged = Object.assign({}, snapshots[kind] || {}, snapshot || {});
  snapshots[kind] = merged;
  return merged;
}

/** Register the transport callbacks for a kind ("music" or "video"). */
export function bindMediaSession(kind, actions) {
  if (!kind) return;
  bindings[kind] = Object.assign({}, actions || {});
}

/** Make `kind` the owner, install its handlers and publish its last snapshot. */
export function claimMediaSession(kind) {
  var session = mediaSession();
  if (!session || !kind) return false;
  if (owner !== kind) {
    if (owner !== null) {
      // Clear the previous owner's card before the next owner publishes.
      try {
        session.metadata = null;
      } catch (_error) {}
    }
    owner = kind;
    written = freshWrittenState();
    installTransportHandlers(session, kind);
    publishOwner(session, kind, true, true);
    return true;
  }
  publishOwner(session, kind, true, false);
  return true;
}

/**
 * Refresh metadata, playback state and position for `kind`.
 * A snapshot with playbackState "playing" claims the session. Anything else
 * (paused or position-only) is written only when `kind` already owns it.
 * options.flush bypasses the ~1s position throttle (seek, track change).
 */
export function updateMediaSession(kind, snapshot, options) {
  var session = mediaSession();
  if (!session || !kind) return;
  mergeSnapshot(kind, snapshot);
  if (snapshot && snapshot.playbackState === 'playing') {
    claimMediaSession(kind);
    return;
  }
  if (owner !== kind) return;
  publishOwner(session, kind, Boolean(options && options.flush), false);
}

/** Clear the session, but only when `kind` owns it. */
export function releaseMediaSession(kind) {
  var session = mediaSession();
  if (!session || !kind || owner !== kind) return false;
  try {
    session.metadata = null;
  } catch (_error) {}
  try {
    session.playbackState = 'none';
  } catch (_error) {}
  clearAllHandlers(session);
  if (typeof session.setPositionState === 'function') {
    try {
      session.setPositionState();
    } catch (_error) {}
  }
  owner = null;
  written = freshWrittenState();
  delete snapshots[kind];
  return true;
}

export function mediaSessionOwner() {
  return owner;
}

/** Test hook: forget owner, bindings and snapshots; optionally replace the clock. */
export function resetMediaSessionForTests(clock) {
  owner = null;
  written = freshWrittenState();
  bindings = Object.create(null);
  snapshots = Object.create(null);
  now = typeof clock === 'function' ? clock : function () {
    return Date.now();
  };
}