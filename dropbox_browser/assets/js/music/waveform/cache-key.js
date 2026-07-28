const CACHE_KEY_VERSION = 1;

function identityValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  return String(value);
}

export function waveformIdentityForSong(song) {
  var remotePath;
  var modified;
  if (!song || typeof song !== 'object') return null;
  remotePath = String(song.remote_path || song.stream_path || song.rel_path || '').trim();
  if (!remotePath) return null;
  modified = song.mtime;
  if (modified === undefined) modified = song.mod_time;
  if (modified === undefined) modified = song.modified_time;
  return {
    path: remotePath,
    size: identityValue(song.size),
    modified: identityValue(modified),
  };
}

export function waveformCacheKey(songOrIdentity) {
  var identity = songOrIdentity && typeof songOrIdentity.path === 'string'
    ? songOrIdentity
    : waveformIdentityForSong(songOrIdentity);
  if (!identity || !identity.path) return null;
  return 'music-waveform-v' + CACHE_KEY_VERSION + ':' + JSON.stringify([
    identity.path,
    identityValue(identity.size),
    identityValue(identity.modified),
  ]);
}

export function sameWaveformIdentity(left, right) {
  if (!left || !right) return left === right;
  return left.path === right.path &&
    identityValue(left.size) === identityValue(right.size) &&
    identityValue(left.modified) === identityValue(right.modified);
}
