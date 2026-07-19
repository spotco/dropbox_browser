import {playlistAbsolutePathKey} from './playlist-store.js';

export var RECENT_HISTORY_VERSION = 1;
export var RECENT_HISTORY_LIMIT = 100;
export var RECENT_STORAGE_KEYS = Object.freeze({
  music: 'music-recent-history',
  video: 'video-recent-history',
  videos: 'video-recent-history'
});

function normalizedKind(kind) {
  return String(kind || '').toLowerCase() === 'video' || String(kind || '').toLowerCase() === 'videos'
    ? 'video'
    : 'music';
}

export function recentStorageKey(kind) {
  return RECENT_STORAGE_KEYS[normalizedKind(kind)];
}

function finiteTimestamp(value, fallback) {
  var number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function cloneItem(item) {
  if (!item || typeof item !== 'object') return null;
  var copied = {
    display_name: String(item.display_name || item.filename || '').trim(),
    extension: String(item.extension || ''),
    filename: String(item.filename || item.display_name || '').trim(),
    rel_path: String(item.rel_path || ''),
    remote_path: String(item.remote_path || ''),
    stream_path: String(item.stream_path || item.rel_path || '').trim()
  };
  if (!copied.remote_path && copied.stream_path) copied.remote_path = copied.stream_path;
  if (!copied.stream_path && copied.remote_path) copied.stream_path = copied.remote_path;
  if (!copied.rel_path) copied.rel_path = copied.stream_path;
  if (!copied.display_name) copied.display_name = copied.filename || copied.stream_path.split('/').pop() || '';
  if (!copied.filename) copied.filename = copied.display_name;
  if (!copied.remote_path || !playlistAbsolutePathKey(copied)) return null;
  return copied;
}

export function cloneRecentItem(item) {
  var copied = cloneItem(item);
  return copied ? Object.assign({}, copied) : null;
}

export function normalizeRecentRecord(record, fallbackSequence) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  var item = cloneItem(record.item || record.song || record);
  var playlistName = String(record.playlist_name || record.playlistName || '').trim();
  var playedAt = finiteTimestamp(record.played_at, finiteTimestamp(record.playedAt, 0));
  if (!item || !playlistName || !playedAt) return null;
  return {
    id: finiteTimestamp(record.id, fallbackSequence || playedAt),
    item: item,
    playlist_name: playlistName,
    played_at: playedAt
  };
}

function cloneRecord(record) {
  return {
    id: record.id,
    item: cloneRecentItem(record.item),
    playlist_name: record.playlist_name,
    played_at: record.played_at
  };
}

export function compareRecentRecords(left, right, sortKey, direction) {
  var key = sortKey === 'filename' || sortKey === 'playlist_name' ? sortKey : 'played_at';
  var multiplier = direction === 'desc' ? -1 : 1;
  var leftValue;
  var rightValue;
  var comparison;
  if (key === 'played_at') {
    comparison = Number(left.played_at || 0) - Number(right.played_at || 0);
    if (comparison) return comparison * multiplier;
  } else if (key === 'filename') {
    leftValue = String(left.item && (left.item.filename || left.item.display_name) || '').toLocaleLowerCase();
    rightValue = String(right.item && (right.item.filename || right.item.display_name) || '').toLocaleLowerCase();
    comparison = leftValue < rightValue ? -1 : (leftValue > rightValue ? 1 : 0);
    if (comparison) return comparison * multiplier;
  } else {
    leftValue = String(left.playlist_name || '').toLocaleLowerCase();
    rightValue = String(right.playlist_name || '').toLocaleLowerCase();
    comparison = leftValue < rightValue ? -1 : (leftValue > rightValue ? 1 : 0);
    if (comparison) return comparison * multiplier;
  }
  // Secondary values make equal visible fields deterministic without making
  // sort toggles unstable when two records share a timestamp.
  leftValue = String(left.item && (left.item.filename || left.item.display_name) || '').toLocaleLowerCase();
  rightValue = String(right.item && (right.item.filename || right.item.display_name) || '').toLocaleLowerCase();
  comparison = leftValue < rightValue ? -1 : (leftValue > rightValue ? 1 : 0);
  if (comparison) return comparison;
  leftValue = String(left.playlist_name || '').toLocaleLowerCase();
  rightValue = String(right.playlist_name || '').toLocaleLowerCase();
  comparison = leftValue < rightValue ? -1 : (leftValue > rightValue ? 1 : 0);
  if (comparison) return comparison;
  leftValue = String(left.item && (left.item.stream_path || left.item.rel_path) || '').toLocaleLowerCase();
  rightValue = String(right.item && (right.item.stream_path || right.item.rel_path) || '').toLocaleLowerCase();
  comparison = leftValue < rightValue ? -1 : (leftValue > rightValue ? 1 : 0);
  if (comparison) return comparison;
  return Number(left.id || 0) - Number(right.id || 0);
}

export function sortRecentRecords(records, sortKey, direction) {
  return (Array.isArray(records) ? records : []).map(cloneRecord).sort(function (left, right) {
    return compareRecentRecords(left, right, sortKey, direction);
  });
}

export function normalizeRecentSort(savedSort) {
  var value = savedSort && typeof savedSort === 'object' ? savedSort : {};
  var key = value.key === 'filename' || value.key === 'playlist_name' ? value.key : 'played_at';
  var direction = value.direction === 'asc' || value.direction === 'desc'
    ? value.direction
    : (key === 'played_at' ? 'desc' : 'asc');
  return {key: key, direction: direction};
}

export function nextRecentSort(currentSortKey, currentSortDirection, requestedSortKey) {
  var key = requestedSortKey === 'filename' || requestedSortKey === 'playlist_name'
    ? requestedSortKey
    : 'played_at';
  if (key === currentSortKey) {
    return {key: key, direction: currentSortDirection === 'desc' ? 'asc' : 'desc'};
  }
  return {key: key, direction: key === 'played_at' ? 'desc' : 'asc'};
}

export class RecentStore {
  constructor(options) {
    var settings = options || {};
    this.mediaKind = normalizedKind(settings.mediaKind);
    this.storage = settings.storage || null;
    this.storageKey = settings.storageKey || recentStorageKey(this.mediaKind);
    this.clock = typeof settings.clock === 'function' ? settings.clock : function () { return Date.now(); };
    this.limit = Math.max(1, Number(settings.limit) || RECENT_HISTORY_LIMIT);
    this.records = [];
    this.nextId = 1;
    this.load();
  }

  load() {
    var stored;
    var rawRecords;
    if (!this.storage || typeof this.storage.get !== 'function') return this.records;
    try {
      stored = this.storage.get(this.storageKey, null);
      rawRecords = Array.isArray(stored) ? stored : stored && stored.records;
      if (!Array.isArray(rawRecords)) return this.records;
      this.records = rawRecords.map(function (record, index) {
        return normalizeRecentRecord(record, index + 1);
      }).filter(Boolean).slice(-this.limit);
      this.records.forEach(function (record) {
        this.nextId = Math.max(this.nextId, Number(record.id || 0) + 1);
      }, this);
    } catch (_error) {
      this.records = [];
      this.nextId = 1;
    }
    return this.records;
  }

  persist() {
    if (!this.storage || typeof this.storage.set !== 'function') return;
    try {
      this.storage.set(this.storageKey, {
        version: RECENT_HISTORY_VERSION,
        records: this.records.map(cloneRecord)
      });
    } catch (_error) {
      // localStorage failures must never prevent playback.
    }
  }

  recordPlaybackStart(item, playlistName, playedAt) {
    var copiedItem = cloneItem(item);
    var name = String(playlistName || '').trim();
    var timestamp = finiteTimestamp(playedAt, finiteTimestamp(this.clock(), Date.now()));
    var pathKey;
    var previous;
    var record;
    if (!copiedItem || !name) return null;
    pathKey = playlistAbsolutePathKey(copiedItem);
    previous = this.records[this.records.length - 1];
    if (previous && previous.playlist_name === name && playlistAbsolutePathKey(previous.item) === pathKey) {
      previous.item = copiedItem;
      previous.played_at = timestamp;
      this.persist();
      return cloneRecord(previous);
    }
    record = {
      id: this.nextId++,
      item: copiedItem,
      playlist_name: name,
      played_at: timestamp
    };
    this.records.push(record);
    if (this.records.length > this.limit) this.records.splice(0, this.records.length - this.limit);
    this.persist();
    return cloneRecord(record);
  }

  list(sortKey, direction) {
    return sortRecentRecords(this.records, sortKey || 'played_at', direction || 'desc');
  }

  clear() {
    this.records = [];
    this.persist();
  }
}

export function recentRestorationDecision(record, persistedPlaylist, playlistPathKey) {
  if (!persistedPlaylist) return 'fallback';
  var songs = Array.isArray(persistedPlaylist.songs) ? persistedPlaylist.songs : [];
  var targetKey = typeof playlistPathKey === 'function'
    ? playlistPathKey(record && record.item)
    : playlistAbsolutePathKey(record && record.item);
  return songs.some(function (song) {
    return targetKey && playlistPathKey ? playlistPathKey(song) === targetKey : playlistAbsolutePathKey(song) === targetKey;
  }) ? 'play-saved' : 'load-missing';
}
