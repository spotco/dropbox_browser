export function createEmptySubtitleMountState() {
  return {
    mode: 'none',
    path: '',
    streamIndex: null,
    seekSeconds: 0,
    coverageStartSeconds: null,
    coverageEndSeconds: null,
    playbackSyncToken: null,
    generation: 0,
  };
}

export function createEmptySubtitlePlaybackSyncState() {
  return {
    path: '',
    streamIndex: null,
    mountedSeekSeconds: 0,
    playbackSyncToken: null,
    mountGeneration: 0,
    outsideCoverageObserved: false,
  };
}

export function ensureSubtitleMountState(current) {
  if (!current || typeof current !== 'object') {
    return createEmptySubtitleMountState();
  }
  if (typeof current.mode !== 'string') current.mode = 'none';
  if (typeof current.path !== 'string') current.path = '';
  if (current.streamIndex === undefined) current.streamIndex = null;
  if (!Number.isFinite(Number(current.seekSeconds))) current.seekSeconds = 0;
  if (current.coverageStartSeconds === undefined) current.coverageStartSeconds = null;
  if (current.coverageEndSeconds === undefined) current.coverageEndSeconds = null;
  if (current.playbackSyncToken === undefined) current.playbackSyncToken = null;
  if (!Number.isFinite(Number(current.generation))) current.generation = 0;
  return current;
}

export function ensureSubtitlePlaybackSyncState(current) {
  if (!current || typeof current !== 'object') {
    return createEmptySubtitlePlaybackSyncState();
  }
  if (typeof current.path !== 'string') current.path = '';
  if (current.streamIndex === undefined) current.streamIndex = null;
  if (!Number.isFinite(Number(current.mountedSeekSeconds))) current.mountedSeekSeconds = 0;
  if (current.playbackSyncToken === undefined) current.playbackSyncToken = null;
  if (!Number.isFinite(Number(current.mountGeneration))) current.mountGeneration = 0;
  current.outsideCoverageObserved = Boolean(current.outsideCoverageObserved);
  return current;
}

export function resetSubtitlePlaybackSyncState(current) {
  var syncState = ensureSubtitlePlaybackSyncState(current);
  syncState.path = '';
  syncState.streamIndex = null;
  syncState.mountedSeekSeconds = 0;
  syncState.playbackSyncToken = null;
  syncState.mountGeneration = 0;
  syncState.outsideCoverageObserved = false;
  return syncState;
}

export function resetSubtitleMountState(current) {
  var mountState = ensureSubtitleMountState(current);
  mountState.mode = 'none';
  mountState.path = '';
  mountState.streamIndex = null;
  mountState.seekSeconds = 0;
  mountState.coverageStartSeconds = null;
  mountState.coverageEndSeconds = null;
  mountState.playbackSyncToken = null;
  mountState.generation = (Number(mountState.generation) || 0) + 1;
  return mountState;
}

export function recordWindowSubtitleMount(current, details) {
  details = details || {};
  var mountState = ensureSubtitleMountState(current);
  mountState.mode = 'window';
  mountState.path = String(details.path || '');
  mountState.streamIndex = details.streamIndex === undefined ? null : details.streamIndex;
  mountState.seekSeconds = Math.max(0, Number(details.seekSeconds) || 0);
  mountState.coverageStartSeconds = details.coverageStartSeconds === undefined || details.coverageStartSeconds === null
    ? null
    : Math.max(0, Number(details.coverageStartSeconds) || 0);
  mountState.coverageEndSeconds = details.coverageEndSeconds === undefined || details.coverageEndSeconds === null
    ? null
    : Math.max(0, Number(details.coverageEndSeconds) || 0);
  mountState.playbackSyncToken = details.playbackSyncToken === undefined ? null : details.playbackSyncToken;
  mountState.generation = (Number(mountState.generation) || 0) + 1;
  return mountState;
}

export function recordFullSubtitleMount(current, details) {
  details = details || {};
  var mountState = ensureSubtitleMountState(current);
  mountState.mode = 'full';
  mountState.path = String(details.path || '');
  mountState.streamIndex = details.streamIndex === undefined ? null : details.streamIndex;
  mountState.seekSeconds = Math.max(0, Number(details.seekSeconds) || 0);
  mountState.coverageStartSeconds = null;
  mountState.coverageEndSeconds = null;
  mountState.playbackSyncToken = details.playbackSyncToken === undefined ? null : details.playbackSyncToken;
  mountState.generation = (Number(mountState.generation) || 0) + 1;
  return mountState;
}

export function mountedSubtitleSeekSeconds(current) {
  var mountState = ensureSubtitleMountState(current);
  return Math.max(0, Number(mountState.seekSeconds) || 0);
}

export function subtitleMountCoversTarget(current, details) {
  details = details || {};
  var mountState = ensureSubtitleMountState(current);
  if (mountState.mode === 'none') return false;
  var path = String(details.path || '');
  if (path !== mountState.path) return false;
  if (details.streamIndex === null || details.streamIndex === undefined) return false;
  if (mountState.streamIndex === null || mountState.streamIndex === undefined) return false;
  if (details.streamIndex !== mountState.streamIndex) return false;
  var mountedSeek = Math.max(0, Number(mountState.seekSeconds) || 0);
  var requestedSeek = Math.max(0, Number(details.seekSeconds) || 0);
  if (Math.abs(mountedSeek - requestedSeek) > 0.05) return false;
  if (mountState.mode === 'full') return true;
  if (mountState.mode !== 'window') return false;
  if (!Number.isFinite(Number(mountState.coverageStartSeconds)) || !Number.isFinite(Number(mountState.coverageEndSeconds))) {
    return false;
  }
  var overlapSeconds = Math.max(0, Number(details.overlapSeconds) || 0);
  var coverageTargetSeconds = details.coverageTargetSeconds === undefined
    ? details.seekSeconds
    : details.coverageTargetSeconds;
  var requestedCoverageTarget = Math.max(0, Number(coverageTargetSeconds) || 0);
  return requestedCoverageTarget >= (Number(mountState.coverageStartSeconds) || 0)
    && requestedCoverageTarget <= (Number(mountState.coverageEndSeconds) || 0) + overlapSeconds;
}

export function shouldRefreshSubtitlesForPlaybackTime(currentMountState, currentSyncState, details) {
  details = details || {};
  var mountState = ensureSubtitleMountState(currentMountState);
  if (mountState.mode === 'none') return false;
  if (details.streamIndex === null || details.streamIndex === undefined) return false;
  var mountedSeek = mountedSubtitleSeekSeconds(mountState);
  var covered = subtitleMountCoversTarget(mountState, {
    path: details.path,
    streamIndex: details.streamIndex,
    seekSeconds: mountedSeek,
    coverageTargetSeconds: details.targetSeconds,
    overlapSeconds: details.overlapSeconds,
  });
  var syncState = ensureSubtitlePlaybackSyncState(currentSyncState);
  var mountGeneration = Number(mountState.generation) || 0;
  var playbackSyncToken = details.playbackSyncToken;
  var sameMountIdentity = syncState.path === String(details.path || '')
    && syncState.streamIndex === details.streamIndex
    && Math.abs((Number(syncState.mountedSeekSeconds) || 0) - mountedSeek) <= 0.05
    && syncState.playbackSyncToken === playbackSyncToken
    && (Number(syncState.mountGeneration) || 0) === mountGeneration;
  if (!sameMountIdentity) {
    syncState.path = String(details.path || '');
    syncState.streamIndex = details.streamIndex;
    syncState.mountedSeekSeconds = mountedSeek;
    syncState.playbackSyncToken = playbackSyncToken;
    syncState.mountGeneration = mountGeneration;
    syncState.outsideCoverageObserved = false;
  }
  if (covered) {
    syncState.outsideCoverageObserved = false;
    return false;
  }
  if (syncState.outsideCoverageObserved) return false;
  syncState.outsideCoverageObserved = true;
  return true;
}
