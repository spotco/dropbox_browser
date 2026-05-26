export var DEFAULT_PLAYLIST_NAME = 'New Playlist';
export var PLAYLIST_STORAGE_KEY = 'music-playlists';
export var PLAYLIST_EXPORT_VERSION = 1;

function normalizeM3uLine(line) {
  return String(line || '').trim();
}

function epochSecondsFromMs(ms) {
  var numeric = Number(ms);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.floor(numeric / 1000);
}

function normalizePlaylistPath(value) {
  return String(value || '').trim().replace(/\\/g, '/');
}

function splitPlaylistRemotePath(remotePath) {
  var normalized = normalizePlaylistPath(remotePath);
  var colonIndex = normalized.indexOf(':');
  if (colonIndex <= 0) {
    return {
      remote_path: normalized.replace(/^\/+/, ''),
      stream_path: normalized.replace(/^\/+/, '')
    };
  }
  var prefix = normalized.slice(0, colonIndex);
  var suffix = normalized.slice(colonIndex + 1).replace(/^\/+/, '');
  return {
    remote_path: prefix + ':' + suffix,
    stream_path: suffix
  };
}

function cloneSong(song) {
  if (!song || !song.remote_path) return null;
  var pathInfo = splitPlaylistRemotePath(song.remote_path);
  var streamPath = normalizePlaylistPath(song.stream_path || '') || pathInfo.stream_path;
  var relPath = normalizePlaylistPath(song.rel_path || '') || streamPath;
  return {
    display_name: song.display_name || song.filename || basename(pathInfo.stream_path || pathInfo.remote_path),
    extension: song.extension || '',
    filename: song.filename || song.display_name || basename(pathInfo.stream_path || pathInfo.remote_path),
    rel_path: relPath,
    remote_path: pathInfo.remote_path,
    stream_path: streamPath
  };
}

function basename(remotePath) {
  var value = String(remotePath || '');
  if (!value) return '';
  value = value.replace(/\\/g, '/');
  var segments = value.split('/');
  return segments[segments.length - 1] || '';
}

export function playlistNameFromFilename(filename) {
  var baseName = basename(filename);
  if (!baseName) return DEFAULT_PLAYLIST_NAME;
  return normalizePlaylistName(baseName.replace(/\.(m3u8|json)$/i, ''));
}

export function parseM3uPlaylistText(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(normalizeM3uLine)
    .filter(function (line) {
      return !!line && line.charAt(0) !== '#';
    });
}

function defaultSongFromRemotePath(remotePath) {
  var pathInfo = splitPlaylistRemotePath(remotePath);
  var filename = basename(pathInfo.stream_path || pathInfo.remote_path);
  return {
    display_name: filename,
    extension: '',
    filename: filename,
    rel_path: pathInfo.stream_path,
    remote_path: pathInfo.remote_path,
    stream_path: pathInfo.stream_path
  };
}

function normalizePlaylistName(name) {
  var value = String(name || '').trim();
  return value || DEFAULT_PLAYLIST_NAME;
}

function comparePlaylistValues(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export class PlaylistModel {
  constructor(options) {
    var settings = options || {};
    this.name = normalizePlaylistName(settings.name);
    this.last_modified = Number(settings.last_modified || 0);
    this.songs = [];
    this.remotePathSet = Object.create(null);
    this.replaceSongs(settings.songs || []);
  }

  rename(name) {
    this.name = normalizePlaylistName(name);
    return this.name;
  }

  touch(clockValueMs) {
    this.last_modified = epochSecondsFromMs(clockValueMs);
    return this.last_modified;
  }

  hasRemotePath(remotePath) {
    return !!(remotePath && this.remotePathSet[remotePath]);
  }

  addSongs(songs) {
    var added = 0;
    (songs || []).forEach(function (song) {
      var copiedSong = cloneSong(song);
      if (!copiedSong || this.remotePathSet[copiedSong.remote_path]) return;
      this.remotePathSet[copiedSong.remote_path] = true;
      this.songs.push(copiedSong);
      added += 1;
    }, this);
    return added;
  }

  removeSongsByRemotePaths(selectedRemotePaths) {
    var nextSongs = [];
    var removed = 0;
    this.songs.forEach(function (song) {
      if (!song || !song.remote_path) return;
      if (selectedRemotePaths && selectedRemotePaths[song.remote_path]) {
        removed += 1;
        return;
      }
      nextSongs.push(song);
    });
    this.replaceSongs(nextSongs);
    return removed;
  }

  replaceSongs(songs) {
    this.songs = [];
    this.remotePathSet = Object.create(null);
    this.addSongs(songs || []);
    return this.songs;
  }

  clone() {
    return new PlaylistModel({
      name: this.name,
      last_modified: this.last_modified,
      songs: this.songs
    });
  }

  toJSON() {
    return {
      name: this.name,
      last_modified: this.last_modified,
      songs: this.songs.map(function (song) {
        return song.remote_path;
      })
    };
  }

  static fromJSON(data, options) {
    var settings = options || {};
    var songFactory = typeof settings.songFactory === 'function'
      ? settings.songFactory
      : defaultSongFromRemotePath;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Playlist import must be an object.');
    }
    if (!Array.isArray(data.songs)) {
      throw new Error('Playlist songs must be an array.');
    }
    return new PlaylistModel({
      name: data.name,
      last_modified: Number(data.last_modified || 0),
      songs: data.songs.map(function (remotePath) {
        if (typeof remotePath !== 'string' || !remotePath.trim()) {
          throw new Error('Playlist songs must contain Dropbox absolute paths.');
        }
        return songFactory(remotePath);
      })
    });
  }
}

export class PlaylistStore {
  constructor(options) {
    var settings = options || {};
    this.storage = settings.storage || null;
    this.storageKey = settings.storageKey || PLAYLIST_STORAGE_KEY;
    this.clock = typeof settings.clock === 'function' ? settings.clock : function () { return Date.now(); };
    this.songFactory = typeof settings.songFactory === 'function'
      ? settings.songFactory
      : defaultSongFromRemotePath;
    this.persistedPlaylists = [];
    this.activePlaylist = new PlaylistModel({name: DEFAULT_PLAYLIST_NAME});
    this.loadPersistedPlaylists();
  }

  createPlaylist(options) {
    return new PlaylistModel(options);
  }

  createPlaylistFromSerialized(data) {
    return PlaylistModel.fromJSON(data, {
      songFactory: this.songFactory
    });
  }

  replaceActivePlaylist(playlist) {
    this.activePlaylist = playlist instanceof PlaylistModel ? playlist : this.createPlaylist(playlist);
    return this.activePlaylist;
  }

  renameActivePlaylist(name) {
    return this.activePlaylist.rename(name);
  }

  listPersistedPlaylists(sortKey, sortDirection) {
    var key = sortKey === 'last_modified' ? 'last_modified' : 'name';
    var direction = sortDirection === 'desc' ? -1 : 1;
    return this.persistedPlaylists.slice().sort(function (left, right) {
      var leftValue;
      var rightValue;
      var comparison;
      if (key === 'last_modified') {
        leftValue = Number(left.last_modified || 0);
        rightValue = Number(right.last_modified || 0);
        comparison = comparePlaylistValues(leftValue, rightValue);
        if (comparison !== 0) return comparison * direction;
        return comparePlaylistValues(String(left.name || '').toLowerCase(), String(right.name || '').toLowerCase());
      }
      leftValue = String(left.name || '').toLowerCase();
      rightValue = String(right.name || '').toLowerCase();
      comparison = comparePlaylistValues(leftValue, rightValue);
      if (comparison !== 0) return comparison * direction;
      return comparePlaylistValues(Number(left.last_modified || 0), Number(right.last_modified || 0));
    });
  }

  findPersistedPlaylistByName(name) {
    var normalizedName = normalizePlaylistName(name);
    for (var i = 0; i < this.persistedPlaylists.length; i += 1) {
      if (this.persistedPlaylists[i].name === normalizedName) return this.persistedPlaylists[i];
    }
    return null;
  }

  deletePersistedPlaylistByName(name) {
    var normalizedName = normalizePlaylistName(name);
    for (var i = 0; i < this.persistedPlaylists.length; i += 1) {
      if (this.persistedPlaylists[i].name !== normalizedName) continue;
      return this.persistedPlaylists.splice(i, 1)[0] || null;
    }
    return null;
  }

  upsertPersistedPlaylist(playlist, options) {
    var settings = options || {};
    var nextPlaylist = playlist instanceof PlaylistModel ? playlist.clone() : this.createPlaylist(playlist);
    var replaceName = typeof settings.replaceName === 'string' && settings.replaceName.trim()
      ? normalizePlaylistName(settings.replaceName)
      : '';
    var existing = this.findPersistedPlaylistByName(nextPlaylist.name);
    if (settings.touch !== false) nextPlaylist.touch(this.clock());
    if (replaceName && replaceName !== nextPlaylist.name) {
      this.deletePersistedPlaylistByName(replaceName);
      existing = this.findPersistedPlaylistByName(nextPlaylist.name);
    }
    if (existing) {
      existing.last_modified = nextPlaylist.last_modified;
      existing.replaceSongs(nextPlaylist.songs);
    }
    else {
      this.persistedPlaylists.push(nextPlaylist);
    }
    return this.findPersistedPlaylistByName(nextPlaylist.name);
  }

  saveActivePlaylist(options) {
    var settings = options || {};
    var name = settings.name;
    if (typeof name === 'string' && name.trim()) this.activePlaylist.rename(name);
    return this.upsertPersistedPlaylist(this.activePlaylist, settings);
  }

  exportPersistedPlaylists() {
    return {
      exported_at: epochSecondsFromMs(this.clock()),
      playlists: this.persistedPlaylists.map(function (playlist) {
        return playlist.toJSON();
      }),
      version: PLAYLIST_EXPORT_VERSION
    };
  }

  importPersistedPlaylists(data) {
    var payload = typeof data === 'string' ? JSON.parse(data) : data;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Playlist import must be an object.');
    }
    if (!Array.isArray(payload.playlists)) {
      throw new Error('Playlist import must include a playlists array.');
    }
    this.persistedPlaylists = payload.playlists.map(function (playlistData) {
      return this.createPlaylistFromSerialized(playlistData);
    }, this);
    return this.persistedPlaylists;
  }

  mergePersistedPlaylists(data) {
    var payload = typeof data === 'string' ? JSON.parse(data) : data;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Playlist import must be an object.');
    }
    if (!Array.isArray(payload.playlists)) {
      throw new Error('Playlist import must include a playlists array.');
    }
    payload.playlists.forEach(function (playlistData) {
      this.upsertPersistedPlaylist(this.createPlaylistFromSerialized(playlistData), {touch: false});
    }, this);
    return this.persistedPlaylists;
  }

  loadPersistedPlaylists() {
    var storedValue;
    if (!this.storage || typeof this.storage.get !== 'function') return this.persistedPlaylists;
    storedValue = this.storage.get(this.storageKey, null);
    if (!storedValue || typeof storedValue !== 'object' || Array.isArray(storedValue)) return this.persistedPlaylists;
    try {
      this.importPersistedPlaylists(storedValue);
    } catch (_err) {
      this.persistedPlaylists = [];
    }
    return this.persistedPlaylists;
  }

  persist() {
    if (!this.storage || typeof this.storage.set !== 'function') return;
    this.storage.set(this.storageKey, this.exportPersistedPlaylists());
  }
}
