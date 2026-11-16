import {
  PLAYLIST_EXPORT_VERSION,
  PlaylistStore,
  playlistAbsolutePathKey,
} from './playlist-store.js';

export var PULL_HEADING = 'Replace Local Saved Playlists from Dropbox';
export var PUSH_HEADING = 'Replace Dropbox Saved Playlists from Local';
export var PULL_NOTICE = 'This replaces the saved playlists in this browser. If this active playlist is linked to a saved playlist, it reloads from Dropbox and discards unsaved changes. Otherwise it resets to New Playlist.';
export var PUSH_NOTICE = 'This replaces the Dropbox playlist file with this browser\'s saved playlists. Unsaved edits to the active playlist are not included.';
export var NO_PLAYLIST_CHANGES = 'No playlist changes.';
export var REMOTE_MISSING_MESSAGE = 'Dropbox playlist file was not found.';
export var REMOTE_READ_ERROR_MESSAGE = 'Could not read the Dropbox playlist file.';
export var LOCAL_WRITE_ERROR_MESSAGE = 'Could not write the local playlist file.';
export var UPLOAD_UNVERIFIED_MESSAGE = 'Dropbox upload failed. The remote file was not verified.';

export function resolvePlaylistSyncPath(configuredPath, search, queryName) {
  var params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  if (params.has(queryName)) return String(params.get(queryName) || '').trim();
  return String(configuredPath || '').trim();
}

export function stringifyPlaylistExport(data) {
  return JSON.stringify(data, null, 2);
}

export function assertSupportedPlaylistExportVersion(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
  if (!Object.prototype.hasOwnProperty.call(payload, 'version')) return;
  if (payload.version !== PLAYLIST_EXPORT_VERSION) {
    throw new Error('Unsupported playlist export version.');
  }
}

export function duplicatePlaylistNameError(playlists) {
  var seen = Object.create(null);
  var index;
  var name;
  for (index = 0; index < (playlists || []).length; index += 1) {
    name = playlists[index] && playlists[index].name;
    if (!name) continue;
    if (seen[name]) return 'Playlist import has more than one playlist named "' + name + '".';
    seen[name] = true;
  }
  return '';
}

export function parsePlaylistExport(data, songFactory) {
  var payload = typeof data === 'string' ? JSON.parse(data) : data;
  var store;
  var duplicateError;
  assertSupportedPlaylistExportVersion(payload);
  store = new PlaylistStore({
    songFactory: songFactory,
    storage: null
  });
  store.importPersistedPlaylists(payload);
  duplicateError = duplicatePlaylistNameError(store.persistedPlaylists);
  if (duplicateError) throw new Error(duplicateError);
  return store;
}

export function pullActivePlaylistAction(savedName, playlists) {
  var name = typeof savedName === 'string' ? savedName.trim() : '';
  var index;
  if (!name) return 'reset';
  for (index = 0; index < (playlists || []).length; index += 1) {
    if (playlists[index] && playlists[index].name === name) return 'reload';
  }
  return 'reset';
}

function playlistNameMap(playlists) {
  var map = Object.create(null);
  (playlists || []).forEach(function (playlist) {
    if (!playlist || !playlist.name || map[playlist.name]) return;
    map[playlist.name] = playlist;
  });
  return map;
}

function itemKeys(playlist) {
  var keys = [];
  (playlist && playlist.songs || []).forEach(function (song) {
    var key = playlistAbsolutePathKey(song);
    if (key) keys.push(key);
  });
  return keys;
}

function keySet(keys) {
  var set = Object.create(null);
  keys.forEach(function (key) {
    set[key] = true;
  });
  return set;
}

function sharedOrderChanged(beforeKeys, afterKeys) {
  var beforeSet = keySet(beforeKeys);
  var afterSet = keySet(afterKeys);
  var beforeShared = beforeKeys.filter(function (key) { return afterSet[key]; });
  var afterShared = afterKeys.filter(function (key) { return beforeSet[key]; });
  var index;
  if (beforeShared.length !== afterShared.length) return false;
  for (index = 0; index < beforeShared.length; index += 1) {
    if (beforeShared[index] !== afterShared[index]) return true;
  }
  return false;
}

function itemCount(playlist) {
  return (playlist && playlist.songs && playlist.songs.length) || 0;
}

function sortedNames(names) {
  return names.slice().sort(function (left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

export function summarizePlaylistChanges(beforePlaylists, afterPlaylists) {
  var beforeMap = playlistNameMap(beforePlaylists);
  var afterMap = playlistNameMap(afterPlaylists);
  var lines = [];
  sortedNames(Object.keys(afterMap)).forEach(function (name) {
    if (!beforeMap[name]) lines.push('Added "' + name + '" (' + itemCount(afterMap[name]) + ' items)');
  });
  sortedNames(Object.keys(beforeMap)).forEach(function (name) {
    if (!afterMap[name]) lines.push('Removed "' + name + '" (' + itemCount(beforeMap[name]) + ' items)');
  });
  sortedNames(Object.keys(beforeMap)).forEach(function (name) {
    var beforeKeys;
    var afterKeys;
    var beforeSet;
    var afterSet;
    var added = 0;
    var removed = 0;
    var parts;
    if (!afterMap[name]) return;
    beforeKeys = itemKeys(beforeMap[name]);
    afterKeys = itemKeys(afterMap[name]);
    beforeSet = keySet(beforeKeys);
    afterSet = keySet(afterKeys);
    afterKeys.forEach(function (key) {
      if (!beforeSet[key]) added += 1;
    });
    beforeKeys.forEach(function (key) {
      if (!afterSet[key]) removed += 1;
    });
    if (added === 0 && removed === 0 && !sharedOrderChanged(beforeKeys, afterKeys)) return;
    parts = [];
    if (added !== 0 || removed !== 0) parts.push('added ' + added + ', removed ' + removed);
    if (sharedOrderChanged(beforeKeys, afterKeys)) parts.push('reordered');
    lines.push('Changed "' + name + '": ' + parts.join(', '));
  });
  if (!lines.length) lines.push(NO_PLAYLIST_CHANGES);
  return {
    hasChanges: lines[0] !== NO_PLAYLIST_CHANGES,
    text: lines.join('\n')
  };
}

export function syncConfirmationText(notice, summaryText) {
  return String(notice || '') + '\n\n' + String(summaryText || '');
}
