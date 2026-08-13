import {clearObject, formatShortDateTime} from './shared.js';
import {formatMediaItemCount, mediaKindPresentation} from './media-kind.js';
import {
  createVirtualRowRecycler,
  shouldVirtualizeRows,
} from '../browse/virtual-list.js';
import {
  DEFAULT_PLAYLIST_NAME,
  parseM3uPlaylistText,
  playlistNameFromFilename,
  playlistAbsolutePathKey
} from './playlist-store.js';

function copySelectedRemotePathMap(selectedRemotePaths) {
  var copied = Object.create(null);
  if (!selectedRemotePaths) return copied;
  Object.keys(selectedRemotePaths).forEach(function (remotePath) {
    if (selectedRemotePaths[remotePath]) copied[remotePath] = true;
  });
  return copied;
}

function playlistRemotePathOrder(playlist) {
  return playlist.map(function (song) {
    return song && song.remote_path ? song.remote_path : '';
  });
}

export function draggedPlaylistBlockRemotePaths(playlist, selectedRemotePaths, anchorRemotePath) {
  var draggedRemotePaths = [];
  if (!anchorRemotePath) return draggedRemotePaths;
  if (selectedRemotePaths && selectedRemotePaths[anchorRemotePath]) {
    playlist.forEach(function (song) {
      if (song && song.remote_path && selectedRemotePaths[song.remote_path]) {
        draggedRemotePaths.push(song.remote_path);
      }
    });
  }
  if (draggedRemotePaths.length === 0) draggedRemotePaths.push(anchorRemotePath);
  return draggedRemotePaths;
}

export function reorderPlaylistBlock(playlist, selectedRemotePaths, anchorRemotePath, targetRemotePath, insertAfter, currentPlaylistIndex) {
  var currentSong = playlist[currentPlaylistIndex] || null;
  var currentRemotePath = currentSong && currentSong.remote_path ? currentSong.remote_path : null;
  var draggedRemotePaths = draggedPlaylistBlockRemotePaths(playlist, selectedRemotePaths, anchorRemotePath);
  var nextSelectedRemotePaths = Object.create(null);
  var draggedRemotePathSet = Object.create(null);
  var draggedSongs = [];
  var remainingSongs = [];
  var targetIndex = -1;
  var insertIndex;
  var nextPlaylist;
  var nextCurrentPlaylistIndex = -1;
  var moved = false;

  draggedRemotePaths.forEach(function (remotePath) {
    draggedRemotePathSet[remotePath] = true;
    nextSelectedRemotePaths[remotePath] = true;
  });
  if (!draggedRemotePaths.length || !targetRemotePath || draggedRemotePathSet[targetRemotePath]) {
    return {
      draggedRemotePaths: draggedRemotePaths,
      moved: false,
      playlist: playlist.slice(),
      currentPlaylistIndex: currentPlaylistIndex,
      selectedRemotePaths: copySelectedRemotePathMap(selectedRemotePaths)
    };
  }

  playlist.forEach(function (song) {
    if (!song || !song.remote_path) return;
    if (draggedRemotePathSet[song.remote_path]) draggedSongs.push(song);
    else remainingSongs.push(song);
  });

  for (var i = 0; i < remainingSongs.length; i += 1) {
    if (remainingSongs[i].remote_path === targetRemotePath) {
      targetIndex = i;
      break;
    }
  }
  if (targetIndex === -1) {
    return {
      draggedRemotePaths: draggedRemotePaths,
      moved: false,
      playlist: playlist.slice(),
      currentPlaylistIndex: currentPlaylistIndex,
      selectedRemotePaths: copySelectedRemotePathMap(selectedRemotePaths)
    };
  }

  insertIndex = targetIndex + (insertAfter ? 1 : 0);
  nextPlaylist = remainingSongs.slice(0, insertIndex).concat(draggedSongs, remainingSongs.slice(insertIndex));
  moved = playlistRemotePathOrder(nextPlaylist).join('\n') !== playlistRemotePathOrder(playlist).join('\n');

  if (!moved) {
    return {
      draggedRemotePaths: draggedRemotePaths,
      moved: false,
      playlist: playlist.slice(),
      currentPlaylistIndex: currentPlaylistIndex,
      selectedRemotePaths: copySelectedRemotePathMap(selectedRemotePaths)
    };
  }

  if (currentRemotePath) {
    nextCurrentPlaylistIndex = -1;
    for (var j = 0; j < nextPlaylist.length; j += 1) {
      if (nextPlaylist[j].remote_path === currentRemotePath) {
        nextCurrentPlaylistIndex = j;
        break;
      }
    }
  }

  return {
    draggedRemotePaths: draggedRemotePaths,
    moved: true,
    playlist: nextPlaylist,
    currentPlaylistIndex: nextCurrentPlaylistIndex,
    selectedRemotePaths: nextSelectedRemotePaths
  };
}

export function playlistAutoScrollDeltaForBounds(clientY, listTop, listBottom) {
  var listHeight = Math.max(0, listBottom - listTop);
  var threshold = Math.max(24, Math.min(48, listHeight / 4));
  var maxStep = 20;
  var ratio;
  if (!(listBottom > listTop) || !Number.isFinite(clientY)) return 0;
  if (clientY < listTop + threshold) {
    ratio = Math.min(1, (listTop + threshold - clientY) / threshold);
    return -Math.max(4, Math.round(maxStep * ratio));
  }
  if (clientY > listBottom - threshold) {
    ratio = Math.min(1, (clientY - (listBottom - threshold)) / threshold);
    return Math.max(4, Math.round(maxStep * ratio));
  }
  return 0;
}

export function nextPlaylistLoadSort(currentSortKey, currentSortDirection, requestedSortKey) {
  var nextSortKey = requestedSortKey === 'last_modified' ? 'last_modified' : 'name';
  if (nextSortKey === currentSortKey) {
    return {
      direction: currentSortDirection === 'desc' ? 'asc' : 'desc',
      key: nextSortKey
    };
  }
  return {
    direction: nextSortKey === 'last_modified' ? 'desc' : 'asc',
    key: nextSortKey
  };
}

export function playlistStateSignature(playlistName, playlist) {
  return JSON.stringify({
    name: String(playlistName || DEFAULT_PLAYLIST_NAME),
    songs: playlistRemotePathOrder(playlist || [])
  });
}

export function preferredPlaylistLoadSelection(activePlaylistNameValue, activePlaylistSavedName, persistedPlaylistNames) {
  var names = Array.isArray(persistedPlaylistNames) ? persistedPlaylistNames : [];
  if (activePlaylistNameValue && names.indexOf(activePlaylistNameValue) !== -1) return activePlaylistNameValue;
  if (activePlaylistSavedName && names.indexOf(activePlaylistSavedName) !== -1) return activePlaylistSavedName;
  return names[0] || null;
}

export function normalizePlaylistLoadSort(savedSort) {
  var value = savedSort && typeof savedSort === 'object' ? savedSort : {};
  var key = value.key === 'name' ? 'name' : 'last_modified';
  var direction;
  if (value.direction === 'asc' || value.direction === 'desc') direction = value.direction;
  else direction = key === 'last_modified' ? 'desc' : 'asc';
  return {
    direction: direction,
    key: key
  };
}

export function normalizePlaylistLoadFilter(filterText) {
  return String(filterText || '').trim();
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

export function recentRestorationDecision(record, persistedPlaylist) {
  var targetKey = playlistAbsolutePathKey(record && record.item);
  if (!persistedPlaylist) return 'fallback';
  return (persistedPlaylist.songs || []).some(function (song) {
    return targetKey && playlistAbsolutePathKey(song) === targetKey;
  }) ? 'play-saved' : 'load-missing';
}

export function playlistMatchesLoadFilter(playlist, filterText) {
  var normalizedFilter = normalizePlaylistLoadFilter(filterText).toLocaleLowerCase();
  var playlistName = playlist && playlist.name ? playlist.name : '';
  if (!normalizedFilter) return true;
  return String(playlistName).toLocaleLowerCase().indexOf(normalizedFilter) !== -1;
}

export var DEFAULT_PLAYLIST_VIRTUAL_THRESHOLD = 100;
export var DEFAULT_PLAYLIST_VIRTUAL_OVERSCAN = 12;
export var DEFAULT_PLAYLIST_VIRTUAL_ROW_HEIGHT = 30;

export function initPlaylist(ctx) {
  var els = ctx.els;
  var state = ctx.state;
  var cfg = ctx.mediaLibraryConfig || {};
  var mediaPresentation = mediaKindPresentation(cfg.mediaKind);
  var playlistDrag = {
    active: false,
    activeHandle: null,
    anchorRemotePath: null,
    draggedRemotePaths: [],
    insertAfter: false,
    pointerId: null,
    autoScrollFrame: null,
    lastClientY: 0,
    startX: 0,
    startY: 0,
    suppressClickUntil: 0,
    targetRemotePath: null
  };
  var playlistVirtual = {
    enabled: false,
    threshold: Number.isFinite(cfg.playlistVirtualThreshold)
      ? Math.max(1, cfg.playlistVirtualThreshold)
      : DEFAULT_PLAYLIST_VIRTUAL_THRESHOLD,
    overscan: Number.isFinite(cfg.playlistVirtualOverscan)
      ? Math.max(0, cfg.playlistVirtualOverscan)
      : DEFAULT_PLAYLIST_VIRTUAL_OVERSCAN,
    rowHeight: Number.isFinite(cfg.playlistVirtualRowHeight)
      ? Math.max(1, cfg.playlistVirtualRowHeight)
      : DEFAULT_PLAYLIST_VIRTUAL_ROW_HEIGHT,
    rowHeightMeasured: false,
    windowKey: '',
    contentEl: null,
    recycler: null,
    renderFrame: null,
    resizeObserver: null
  };

  function activePlaylistName() {
    return state.activePlaylist && state.activePlaylist.name ? state.activePlaylist.name : DEFAULT_PLAYLIST_NAME;
  }

  function activePlaylistSignature() {
    return playlistStateSignature(activePlaylistName(), state.playlist);
  }

  function syncActivePlaylistDirtyState() {
    state.activePlaylistDirty = activePlaylistSignature() !== state.activePlaylistSavedSignature;
    return state.activePlaylistDirty;
  }

  function markActivePlaylistSaved(savedName) {
    state.activePlaylistSavedName = savedName || activePlaylistName();
    state.activePlaylistSavedSignature = activePlaylistSignature();
    state.activePlaylistDirty = false;
  }

  function updateActivePlaylistName() {
    if (!els.activePlaylistNameEl) return;
    els.activePlaylistNameEl.textContent = activePlaylistName();
  }

  function updatePlaylistMediaLabels() {
    if (els.playlistLoadButton) els.playlistLoadButton.textContent = mediaPresentation.playlistLoadLabel;
    if (els.playlistLoadTitleEl) els.playlistLoadTitleEl.textContent = mediaPresentation.playlistLoadLabel;
  }

  function resetPlaylistSelections() {
    clearObject(state.selectedPlaylistRemotePaths);
    state.playlistSelectionAnchor = null;
    state.playlistContextRemotePath = null;
    renderPlaylistSelection();
  }

  function activePlaylistCurrentRemotePath() {
    var currentSong = state.playlist[state.currentPlaylistIndex] || null;
    return currentSong && currentSong.remote_path ? currentSong.remote_path : null;
  }

  function setPlaylistModalVisible(modalEl, visible) {
    if (!modalEl) return;
    modalEl.hidden = !visible;
    modalEl.classList.toggle('hidden', !visible);
  }

  function closeRenameDialog() {
    setPlaylistModalVisible(els.playlistRenameDialog, false);
  }

  function closeOverwriteDialog() {
    setPlaylistModalVisible(els.playlistOverwriteDialog, false);
    state.pendingPlaylistConfirmAction = null;
  }

  function closeLoadDialog() {
    setPlaylistModalVisible(els.playlistLoadDialog, false);
    hidePlaylistLoadContextMenu();
  }

  function closeRecentDialog() {
    setPlaylistModalVisible(els.recentDialog, false);
    state.selectedRecentId = null;
  }

  function closePlaylistDialogs() {
    closeRenameDialog();
    closeOverwriteDialog();
    closeLoadDialog();
    closeRecentDialog();
  }

  function hidePlaylistSaveToast() {
    if (state.playlistSaveToastTimer) {
      window.clearTimeout(state.playlistSaveToastTimer);
      state.playlistSaveToastTimer = null;
    }
    if (!els.playlistSaveToast) return;
    delete els.playlistSaveToast.dataset.variant;
    els.playlistSaveToast.setAttribute('aria-live', 'polite');
    els.playlistSaveToast.hidden = true;
    els.playlistSaveToast.classList.add('hidden');
  }

  function showPlaylistToastMessage(message, options) {
    var durationMs = options && Number.isFinite(options.durationMs) ? options.durationMs : 4500;
    var variant = options && options.variant === 'error' ? 'error' : 'info';
    if (!els.playlistSaveToast || !els.playlistSaveToastText || !message) return;
    els.playlistSaveToastText.textContent = message;
    els.playlistSaveToast.dataset.variant = variant;
    els.playlistSaveToast.setAttribute('aria-live', variant === 'error' ? 'assertive' : 'polite');
    els.playlistSaveToast.hidden = false;
    els.playlistSaveToast.classList.remove('hidden');
    if (state.playlistSaveToastTimer) window.clearTimeout(state.playlistSaveToastTimer);
    state.playlistSaveToastTimer = window.setTimeout(function () {
      hidePlaylistSaveToast();
    }, durationMs);
  }

  function showPlaylistSaveToast(savedPlaylist) {
    var savedName;
    var savedAtText;
    if (!savedPlaylist) return;
    savedName = savedPlaylist.name || activePlaylistName();
    savedAtText = formatShortDateTime(savedPlaylist.last_modified);
    showPlaylistToastMessage('Saved "' + savedName + '" as of ' + savedAtText + '.', {
      variant: 'info'
    });
  }

  function showPlaylistErrorToast(message) {
    showPlaylistToastMessage(message, {
      durationMs: 6500,
      variant: 'error'
    });
  }

  function selectedPersistedPlaylist() {
    if (!state.selectedPersistedPlaylistName) return null;
    return state.playlistStore.findPersistedPlaylistByName(state.selectedPersistedPlaylistName);
  }

  function activePlaylistHasNameConflict() {
    var existing = state.playlistStore.findPersistedPlaylistByName(activePlaylistName());
    return !!(existing && state.activePlaylistSavedName !== activePlaylistName());
  }

  function playlistLoadSortButtonLabel(sortKey) {
    var baseLabel = sortKey === 'last_modified' ? 'Last Modified' : 'Name';
    if (state.playlistLoadSortKey !== sortKey) return baseLabel;
    return baseLabel + (state.playlistLoadSortDirection === 'desc' ? ' ↓' : ' ↑');
  }

  function persistPlaylistLoadSort() {
    Settings.set(state.playlistLoadSortSettingKey, {
      direction: state.playlistLoadSortDirection,
      key: state.playlistLoadSortKey
    });
  }

  function restorePlaylistLoadSort() {
    var restored = normalizePlaylistLoadSort(Settings.get(state.playlistLoadSortSettingKey, {
      direction: state.playlistLoadSortDirection,
      key: state.playlistLoadSortKey
    }));
    state.playlistLoadSortKey = restored.key;
    state.playlistLoadSortDirection = restored.direction;
  }

  function persistPlaylistLoadFilter() {
    Settings.set(state.playlistLoadFilterSettingKey, normalizePlaylistLoadFilter(state.playlistLoadFilterText));
  }

  function restorePlaylistLoadFilter() {
    state.playlistLoadFilterText = normalizePlaylistLoadFilter(
      Settings.get(state.playlistLoadFilterSettingKey, state.playlistLoadFilterText)
    );
    if (els.playlistLoadFilterInput) els.playlistLoadFilterInput.value = state.playlistLoadFilterText;
  }

  function recentSortLabel(sortKey) {
    var baseLabel = sortKey === 'filename' ? 'File Name' : (sortKey === 'playlist_name' ? 'Playlist Name' : 'Date/Time');
    if (state.recentSortKey !== sortKey) return baseLabel;
    return baseLabel + (state.recentSortDirection === 'desc' ? ' ↓' : ' ↑');
  }

  function persistRecentSort() {
    if (typeof Settings === 'undefined' || !Settings || typeof Settings.set !== 'function') return;
    Settings.set(state.recentSortSettingKey, {
      key: state.recentSortKey,
      direction: state.recentSortDirection
    });
  }

  function restoreRecentSort() {
    var saved = {};
    var restoredKey;
    var restoredDirection;
    if (typeof Settings !== 'undefined' && Settings && typeof Settings.get === 'function') {
      saved = Settings.get(state.recentSortSettingKey, {});
    }
    restoredKey = saved && (saved.key === 'filename' || saved.key === 'playlist_name') ? saved.key : 'played_at';
    restoredDirection = saved && (saved.direction === 'asc' || saved.direction === 'desc')
      ? saved.direction
      : (restoredKey === 'played_at' ? 'desc' : 'asc');
    state.recentSortKey = restoredKey;
    state.recentSortDirection = restoredDirection;
  }

  function recentItems() {
    if (!ctx.recentApi || typeof ctx.recentApi.list !== 'function') return [];
    return ctx.recentApi.list(state.recentSortKey, state.recentSortDirection);
  }

  function selectedRecentItem() {
    var selectedId = Number(state.selectedRecentId);
    var items = recentItems();
    for (var i = 0; i < items.length; i += 1) {
      if (Number(items[i].id) === selectedId) return items[i];
    }
    return null;
  }

  function updateRecentSortButtons() {
    if (!els.recentSortButtons) return;
    Array.prototype.forEach.call(els.recentSortButtons, function (button) {
      var key = button.getAttribute('data-recent-sort-key') || 'played_at';
      button.setAttribute('aria-pressed', state.recentSortKey === key ? 'true' : 'false');
      button.textContent = recentSortLabel(key);
    });
  }

  function recentPlayedTime(record) {
    var timestamp = Number(record && record.played_at || 0);
    return timestamp > 0 ? formatShortDateTime(timestamp / 1000) : '--';
  }

  function renderRecentList() {
    var items;
    if (!els.recentListEl) return;
    updateRecentSortButtons();
    items = recentItems();
    els.recentListEl.textContent = '';
    if (!items.length) {
      var empty = document.createElement('div');
      empty.className = 'music-empty-state';
      empty.textContent = 'No recent playback.';
      els.recentListEl.appendChild(empty);
      if (els.recentConfirmButton) els.recentConfirmButton.disabled = true;
      return;
    }
    if (!items.some(function (item) { return Number(item.id) === Number(state.selectedRecentId); })) {
      state.selectedRecentId = items[0].id;
    }
    items.forEach(function (record) {
      var row = document.createElement('div');
      var timeCell = document.createElement('div');
      var fileCell = document.createElement('div');
      var playlistCell = document.createElement('div');
      var fileName = record.item && (record.item.filename || record.item.display_name) || '';
      var filePath = record.item && (record.item.stream_path || record.item.rel_path || record.item.remote_path) || '';
      var isSelected = Number(record.id) === Number(state.selectedRecentId);
      row.className = 'music-playlist-row music-playlist-recent-entry';
      row.setAttribute('role', 'row');
      row.setAttribute('tabindex', '0');
      row.setAttribute('aria-selected', isSelected ? 'true' : 'false');
      row.dataset.recentId = String(record.id);
      if (isSelected) row.classList.add('selected');
      timeCell.className = 'music-playlist-recent-time';
      timeCell.setAttribute('role', 'cell');
      timeCell.textContent = recentPlayedTime(record);
      fileCell.setAttribute('role', 'cell');
      var filePrimary = document.createElement('div');
      filePrimary.className = 'music-playlist-recent-primary';
      filePrimary.textContent = fileName;
      var fileSecondary = document.createElement('div');
      fileSecondary.className = 'music-playlist-recent-secondary';
      fileSecondary.textContent = filePath;
      fileCell.appendChild(filePrimary);
      fileCell.appendChild(fileSecondary);
      playlistCell.setAttribute('role', 'cell');
      playlistCell.className = 'music-playlist-recent-primary';
      playlistCell.textContent = record.playlist_name || '';
      row.appendChild(timeCell);
      row.appendChild(fileCell);
      row.appendChild(playlistCell);
      row.addEventListener('click', function () {
        state.selectedRecentId = record.id;
        renderRecentList();
      });
      row.addEventListener('dblclick', function () {
        state.selectedRecentId = record.id;
        confirmRecentSelection();
      });
      row.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          state.selectedRecentId = record.id;
          confirmRecentSelection();
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          closeRecentDialog();
        }
      });
      els.recentListEl.appendChild(row);
    });
    if (els.recentConfirmButton) els.recentConfirmButton.disabled = !selectedRecentItem();
  }

  function openRecentDialog() {
    closeLoadDialog();
    closeRenameDialog();
    closeOverwriteDialog();
    restoreRecentSort();
    state.selectedRecentId = null;
    renderRecentList();
    setPlaylistModalVisible(els.recentDialog, true);
    if (els.recentListEl && typeof els.recentListEl.focus === 'function') {
      window.setTimeout(function () { els.recentListEl.focus(); }, 0);
    }
  }

  function loadPlaylistForRecent(persistedPlaylist) {
    state.playlistStore.replaceActivePlaylist(persistedPlaylist.clone());
    ctx.syncPlaylistState();
    markActivePlaylistSaved(persistedPlaylist.name);
    resetPlaylistSelections();
    resetShuffleBag();
    state.currentPlaylistIndex = -1;
    updateActivePlaylistName();
    renderPlaylist();
    renderPlaylistLoadList();
  }

  function loadFallbackRecent(record) {
    state.playlistStore.replaceActivePlaylist({
      name: DEFAULT_PLAYLIST_NAME,
      songs: [record.item]
    });
    ctx.syncPlaylistState();
    state.activePlaylistSavedName = null;
    state.activePlaylistSavedSignature = activePlaylistSignature();
    state.activePlaylistDirty = false;
    resetPlaylistSelections();
    resetShuffleBag();
    state.currentPlaylistIndex = -1;
    updateActivePlaylistName();
    renderPlaylist();
    renderPlaylistLoadList();
  }

  function restoreRecentRecord(record) {
    var persistedPlaylist;
    var pathIndex;
    if (!record) return false;
    closeRecentDialog();
    persistedPlaylist = state.playlistStore.findPersistedPlaylistByName(record.playlist_name);
    if (!persistedPlaylist) {
      loadFallbackRecent(record);
      ctx.playbackApi.playPlaylistIndex(0);
      return true;
    }
    loadPlaylistForRecent(persistedPlaylist);
    pathIndex = playlistIndexByAbsolutePath(record.item);
    if (pathIndex === -1) {
      ctx.playbackApi.clearCurrentSong();
      renderPlaylist();
      ctx.setStatus('Loaded playlist "' + persistedPlaylist.name + '", but the recent file is no longer in it.');
      return true;
    }
    ctx.playbackApi.playPlaylistIndex(pathIndex);
    return true;
  }

  function confirmRecentSelection() {
    return restoreRecentRecord(selectedRecentItem());
  }

  function filteredPlaylistLoadItems() {
    return state.playlistStore.listPersistedPlaylists(
      state.playlistLoadSortKey,
      state.playlistLoadSortDirection
    ).filter(function (playlist) {
      return playlistMatchesLoadFilter(playlist, state.playlistLoadFilterText);
    });
  }

  function updatePlaylistLoadSortButtons() {
    if (!els.playlistLoadSortButtons) return;
    Array.prototype.forEach.call(els.playlistLoadSortButtons, function (button) {
      var sortKey = button.getAttribute('data-playlist-sort-key') === 'last_modified' ? 'last_modified' : 'name';
      var pressed = state.playlistLoadSortKey === sortKey;
      button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
      button.textContent = playlistLoadSortButtonLabel(sortKey);
    });
  }

  function renderPlaylistLoadList() {
    var visiblePlaylists;
    var visiblePlaylistNames;
    if (!els.playlistLoadListEl) return;
    updatePlaylistMediaLabels();
    updatePlaylistLoadSortButtons();
    if (els.playlistLoadFilterInput && els.playlistLoadFilterInput.value !== state.playlistLoadFilterText) {
      els.playlistLoadFilterInput.value = state.playlistLoadFilterText;
    }
    els.playlistLoadListEl.textContent = '';
    visiblePlaylists = filteredPlaylistLoadItems();
    visiblePlaylistNames = visiblePlaylists.map(function (playlist) { return playlist.name; });
    if (!selectedPersistedPlaylist()) {
      state.selectedPersistedPlaylistName = preferredPlaylistLoadSelection(
        activePlaylistName(),
        state.activePlaylistSavedName,
        visiblePlaylistNames
      );
    }
    if (!state.persistedPlaylists.length) {
      var empty = document.createElement('div');
      empty.className = 'music-empty-state';
      empty.textContent = 'No saved playlists yet.';
      els.playlistLoadListEl.appendChild(empty);
      if (els.playlistLoadConfirmButton) els.playlistLoadConfirmButton.disabled = true;
      return;
    }
    if (visiblePlaylistNames.indexOf(state.selectedPersistedPlaylistName) === -1) {
      state.selectedPersistedPlaylistName = preferredPlaylistLoadSelection(
        activePlaylistName(),
        state.activePlaylistSavedName,
        visiblePlaylistNames
      );
    }
    if (!visiblePlaylists.length) {
      var noMatches = document.createElement('div');
      noMatches.className = 'music-empty-state';
      noMatches.textContent = 'No playlists match your search.';
      els.playlistLoadListEl.appendChild(noMatches);
      if (els.playlistLoadConfirmButton) els.playlistLoadConfirmButton.disabled = true;
      return;
    }
    visiblePlaylists.forEach(function (playlist) {
      var row = document.createElement('div');
      var nameCell = document.createElement('div');
      var modifiedCell = document.createElement('div');
      var songCountCell = document.createElement('div');
      var songCount = Array.isArray(playlist.songs) ? playlist.songs.length : 0;
      var isSelected = state.selectedPersistedPlaylistName === playlist.name;
      row.className = 'music-playlist-row music-playlist-entry music-playlist-load-entry';
      row.setAttribute('role', 'row');
      row.setAttribute('aria-selected', isSelected ? 'true' : 'false');
      row.dataset.playlistName = playlist.name;
      if (isSelected) row.classList.add('selected');
      nameCell.setAttribute('role', 'cell');
      nameCell.textContent = playlist.name;
      modifiedCell.setAttribute('role', 'cell');
      modifiedCell.textContent = formatShortDateTime(playlist.last_modified);
      songCountCell.className = 'music-playlist-load-song-count';
      songCountCell.setAttribute('role', 'cell');
      songCountCell.textContent = formatMediaItemCount(songCount, mediaPresentation.kind);
      row.appendChild(nameCell);
      row.appendChild(modifiedCell);
      row.appendChild(songCountCell);
      row.addEventListener('click', function () {
        state.selectedPersistedPlaylistName = playlist.name;
        renderPlaylistLoadList();
      });
      row.addEventListener('dblclick', function () {
        state.selectedPersistedPlaylistName = playlist.name;
        renderPlaylistLoadList();
        confirmLoadPlaylist();
      });
      row.addEventListener('contextmenu', function (ev) {
        openPlaylistLoadContextMenu(ev, playlist.name);
      });
      els.playlistLoadListEl.appendChild(row);
    });
    if (els.playlistLoadConfirmButton) els.playlistLoadConfirmButton.disabled = !selectedPersistedPlaylist();
  }

  function openLoadDialog() {
    var visiblePlaylistNames = filteredPlaylistLoadItems().map(function (playlist) { return playlist.name; });
    state.selectedPersistedPlaylistName = preferredPlaylistLoadSelection(
      activePlaylistName(),
      state.activePlaylistSavedName,
      visiblePlaylistNames
    );
    renderPlaylistLoadList();
    setPlaylistModalVisible(els.playlistLoadDialog, true);
    if (els.playlistLoadFilterInput && typeof els.playlistLoadFilterInput.focus === 'function') {
      window.setTimeout(function () {
        els.playlistLoadFilterInput.focus();
      }, 0);
    }
  }

  function openRenameDialog(mode) {
    state.playlistRenameMode = mode === 'save' ? 'save' : 'rename';
    if (els.playlistRenameTitleEl) {
      els.playlistRenameTitleEl.textContent = state.playlistRenameMode === 'save' ? 'Save Playlist' : 'Rename Playlist';
    }
    if (els.playlistRenameConfirmButton) {
      els.playlistRenameConfirmButton.textContent = state.playlistRenameMode === 'save' ? 'Save' : 'OK';
    }
    if (els.playlistRenameInput) {
      els.playlistRenameInput.value = activePlaylistName();
    }
    setPlaylistModalVisible(els.playlistRenameDialog, true);
    if (els.playlistRenameInput && typeof els.playlistRenameInput.focus === 'function') {
      window.setTimeout(function () {
        els.playlistRenameInput.focus();
        if (typeof els.playlistRenameInput.select === 'function') els.playlistRenameInput.select();
      }, 0);
    }
  }

  function openOverwriteDialog(message, confirmAction) {
    state.pendingPlaylistConfirmAction = typeof confirmAction === 'function' ? confirmAction : null;
    if (els.playlistOverwriteMessageEl) els.playlistOverwriteMessageEl.textContent = message;
    setPlaylistModalVisible(els.playlistOverwriteDialog, true);
  }

  function readFileText(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        resolve(typeof reader.result === 'string' ? reader.result : '');
      };
      reader.onerror = function () {
        reject(reader.error || new Error('Could not read file.'));
      };
      reader.readAsText(file);
    });
  }

  function setPlaylistExportBusy(isBusy) {
    if (!els.playlistExportButton) return;
    els.playlistExportButton.disabled = !!isBusy;
  }

  function downloadJsonFile(filename, data) {
    return new Promise(function (resolve) {
      var blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'});
      var objectUrl = URL.createObjectURL(blob);
      var anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      window.setTimeout(function () {
        URL.revokeObjectURL(objectUrl);
        resolve();
      }, 0);
    });
  }

  function persistPlaylistStore() {
    state.playlistStore.persist();
    ctx.syncPlaylistState();
    renderPlaylistLoadList();
  }

  function hidePlaylistLoadContextMenu() {
    if (!els.playlistLoadMenu) return;
    els.playlistLoadMenu.hidden = true;
    els.playlistLoadMenu.classList.add('hidden');
    state.playlistLoadContextName = null;
  }

  function openPlaylistLoadContextMenu(ev, playlistName) {
    ev.preventDefault();
    state.selectedPersistedPlaylistName = playlistName;
    renderPlaylistLoadList();
    state.playlistLoadContextName = playlistName;
    if (!els.playlistLoadMenu) return;
    els.playlistLoadMenu.style.left = ev.clientX + 'px';
    els.playlistLoadMenu.style.top = ev.clientY + 'px';
    els.playlistLoadMenu.hidden = false;
    els.playlistLoadMenu.classList.remove('hidden');
  }

  function deletePersistedPlaylist(name) {
    var targetName = String(name || state.playlistLoadContextName || state.selectedPersistedPlaylistName || '').trim();
    var deleted;
    if (!targetName) return false;
    deleted = state.playlistStore.deletePersistedPlaylistByName(targetName);
    if (!deleted) return false;
    if (state.activePlaylistSavedName === targetName) {
      state.activePlaylistSavedName = null;
      state.activePlaylistSavedSignature = '';
      syncActivePlaylistDirtyState();
    }
    if (state.selectedPersistedPlaylistName === targetName) state.selectedPersistedPlaylistName = null;
    hidePlaylistLoadContextMenu();
    persistPlaylistStore();
    ctx.setStatus('Deleted saved playlist "' + targetName + '".');
    return true;
  }

  function overwriteConfirmationRequired(name) {
    var existing = state.playlistStore.findPersistedPlaylistByName(name);
    return !!(existing && state.activePlaylistSavedName !== name);
  }

  function maybeConfirmDiscardUnsavedPlaylist(confirmMessage, confirmAction) {
    if (!syncActivePlaylistDirtyState()) {
      confirmAction();
      return true;
    }
    openOverwriteDialog(confirmMessage, function () {
      closeOverwriteDialog();
      confirmAction();
    });
    return false;
  }

  function savePlaylist(name, skipOverwriteConfirmation) {
    var targetName = String(name || activePlaylistName()).trim();
    if (!targetName || targetName === DEFAULT_PLAYLIST_NAME) {
      openRenameDialog('save');
      ctx.setStatus('Playlist name is required before saving.');
      return false;
    }
    if (!skipOverwriteConfirmation && overwriteConfirmationRequired(targetName)) {
      closeRenameDialog();
      openOverwriteDialog(
        'A saved playlist named "' + targetName + '" already exists. Overwrite it?',
        function () {
          closeOverwriteDialog();
          savePlaylist(targetName, true);
        }
      );
      return false;
    }
    var savedPlaylist = state.playlistStore.saveActivePlaylist({name: targetName});
    ctx.syncPlaylistState();
    markActivePlaylistSaved(savedPlaylist ? savedPlaylist.name : targetName);
    updateActivePlaylistName();
    renderPlaylistLoadList();
    closeRenameDialog();
    showPlaylistSaveToast(savedPlaylist);
    persistPlaylistStore();
    return true;
  }

  function renamePlaylist(name, skipOverwriteConfirmation) {
    var targetName = String(name || '').trim() || DEFAULT_PLAYLIST_NAME;
    var replaceName = state.activePlaylistSavedName;
    if (!skipOverwriteConfirmation && overwriteConfirmationRequired(targetName)) {
      closeRenameDialog();
      openOverwriteDialog(
        'A saved playlist named "' + targetName + '" already exists. Overwrite it?',
        function () {
          closeOverwriteDialog();
          renamePlaylist(targetName, true);
        }
      );
      return false;
    }
    state.playlistStore.renameActivePlaylist(targetName);
    var savedPlaylist = state.playlistStore.saveActivePlaylist({
      replaceName: replaceName,
      touch: true
    });
    ctx.syncPlaylistState();
    markActivePlaylistSaved(savedPlaylist ? savedPlaylist.name : targetName);
    updateActivePlaylistName();
    renderPlaylistLoadList();
    closeRenameDialog();
    persistPlaylistStore();
    ctx.setStatus('Renamed active playlist to "' + activePlaylistName() + '" and saved it.');
    return true;
  }

  function confirmRenameDialog() {
    var nextName = els.playlistRenameInput ? String(els.playlistRenameInput.value || '').trim() : '';
    if (state.playlistRenameMode === 'save') {
      savePlaylist(nextName);
      return;
    }
    renamePlaylist(nextName);
  }

  function loadPlaylistByName(name) {
    var persistedPlaylist = state.playlistStore.findPersistedPlaylistByName(name);
    var currentRemotePath = activePlaylistCurrentRemotePath();
    var nextCurrentPlaylistIndex = -1;
    if (!persistedPlaylist) return false;
    state.playlistStore.replaceActivePlaylist(persistedPlaylist.clone());
    ctx.syncPlaylistState();
    markActivePlaylistSaved(persistedPlaylist.name);
    resetPlaylistSelections();
    if (currentRemotePath) nextCurrentPlaylistIndex = playlistIndexByRemotePath(currentRemotePath);
    state.currentPlaylistIndex = nextCurrentPlaylistIndex;
    resetShuffleBag();
    updateActivePlaylistName();
    if (nextCurrentPlaylistIndex === -1) ctx.playbackApi.clearCurrentSong();
    renderPlaylist();
    renderPlaylistLoadList();
    closeLoadDialog();
    ctx.setStatus('Loaded playlist "' + persistedPlaylist.name + '".');
    return true;
  }

  function loadNewPlaylist() {
    state.playlistStore.replaceActivePlaylist({
      name: DEFAULT_PLAYLIST_NAME,
      songs: []
    });
    ctx.syncPlaylistState();
    state.activePlaylistSavedName = null;
    state.activePlaylistSavedSignature = activePlaylistSignature();
    state.activePlaylistDirty = false;
    state.currentPlaylistIndex = -1;
    resetPlaylistSelections();
    resetShuffleBag();
    updateActivePlaylistName();
    ctx.playbackApi.clearCurrentSong();
    renderPlaylist();
    renderPlaylistLoadList();
    closeLoadDialog();
    ctx.setStatus('Loaded new playlist "' + DEFAULT_PLAYLIST_NAME + '".');
    return true;
  }

  function confirmLoadPlaylist() {
    var playlist = selectedPersistedPlaylist();
    if (!playlist) return false;
    var loaded = false;
    maybeConfirmDiscardUnsavedPlaylist(
      'Loading "' + playlist.name + '" will discard unsaved changes to "' + activePlaylistName() + '". Continue?',
      function () {
        loaded = loadPlaylistByName(playlist.name);
      }
    );
    return loaded;
  }

  function confirmLoadNewPlaylist() {
    var loaded = false;
    maybeConfirmDiscardUnsavedPlaylist(
      'Loading a new playlist will discard unsaved changes to "' + activePlaylistName() + '". Continue?',
      function () {
        loaded = loadNewPlaylist();
      }
    );
    return loaded;
  }

  function importM3uFile(file) {
    return readFileText(file).then(function (text) {
      var remotePaths = parseM3uPlaylistText(text);
      var playlistName = playlistNameFromFilename(file && file.name);
      state.playlistStore.upsertPersistedPlaylist({
        name: playlistName,
        songs: remotePaths.map(function (remotePath) {
          return {remote_path: remotePath};
        })
      });
      return {
        addedSongs: remotePaths.length,
        playlistName: playlistName,
        type: 'm3u8'
      };
    });
  }

  function importJsonFile(file) {
    return readFileText(file).then(function (text) {
      state.playlistStore.mergePersistedPlaylists(text);
      return {
        playlistCount: state.persistedPlaylists.length,
        type: 'json'
      };
    });
  }

  function importPlaylistFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) {
      ctx.setStatus('No playlist files selected.');
      return Promise.resolve(false);
    }
    return files.reduce(function (chain, file) {
      return chain.then(function (results) {
        var lowerName = String(file && file.name || '').toLowerCase();
        var importPromise = lowerName.endsWith('.m3u8') ? importM3uFile(file) : importJsonFile(file);
        return importPromise.then(function (result) {
          results.push(result);
          return results;
        });
      });
    }, Promise.resolve([])).then(function (results) {
      var summaryParts = [];
      persistPlaylistStore();
      renderPlaylistLoadList();
      results.forEach(function (result) {
        if (result.type === 'm3u8') {
          summaryParts.push('Imported "' + result.playlistName + '" (' + result.addedSongs + ' songs)');
          return;
        }
        summaryParts.push('Merged playlist JSON');
      });
      ctx.setStatus(summaryParts.join('. ') + '.');
      return true;
    }).catch(function (err) {
      ctx.setStatus((err && err.message) || 'Playlist import failed.');
      return false;
    }).finally(function () {
      if (els.playlistImportInput) els.playlistImportInput.value = '';
    });
  }

  function exportPersistedPlaylists() {
    if (!state.persistedPlaylists.length) {
      ctx.setStatus('No saved playlists to export.');
      return false;
    }
    setPlaylistExportBusy(true);
    downloadJsonFile(mediaPresentation.playlistExportFilename, state.playlistStore.exportPersistedPlaylists()).finally(function () {
      setPlaylistExportBusy(false);
    });
    ctx.setStatus('Exported ' + state.persistedPlaylists.length + ' saved playlists.');
    return true;
  }

  function addSongsToPlaylist(songs) {
    var added = state.activePlaylist.addSongs((songs || []).map(function (song) {
      var entry = {
        display_name: song.display_name,
        filename: song.filename || song.display_name,
        rel_path: song.rel_path,
        remote_path: song.remote_path,
        stream_path: song.stream_path,
        extension: song.extension || ctx.playbackApi.metadata.metadataExtension(song)
      };
      if (song.size !== undefined) entry.size = song.size;
      if (song.mtime !== undefined) entry.mtime = song.mtime;
      return entry;
    }));
    ctx.syncPlaylistState();
    if (added) resetShuffleBag();
    syncActivePlaylistDirtyState();
    renderPlaylist();
    ctx.setStatus(added ? 'Added ' + added + ' cached song' + (added === 1 ? '' : 's') + ' to playlist.' : 'No new cached songs to add.');
  }

  function playlistVirtualShouldRender() {
    return !!(
      els.playlistListEl
      && shouldVirtualizeRows(state.playlist.length, {threshold: playlistVirtual.threshold})
    );
  }

  function playlistVirtualViewport() {
    var listEl = els.playlistListEl;
    var viewportHeight = listEl && Number(listEl.clientHeight) > 0
      ? Number(listEl.clientHeight)
      : playlistVirtual.rowHeight;
    var scrollTop = listEl && Number(listEl.scrollTop) > 0 ? Number(listEl.scrollTop) : 0;
    return {
      scrollTop: Math.max(0, scrollTop),
      viewportHeight: Math.max(playlistVirtual.rowHeight, viewportHeight)
    };
  }

  function setPlaylistVirtualDataset(windowState, mountedCount) {
    if (!els.playlistListEl) return;
    els.playlistListEl.dataset.playlistCount = String(state.playlist.length);
    els.playlistListEl.dataset.playlistVirtualized = playlistVirtual.enabled ? '1' : '0';
    if (!playlistVirtual.enabled || !windowState) {
      delete els.playlistListEl.dataset.playlistVisibleRange;
      delete els.playlistListEl.dataset.playlistMountedCount;
      return;
    }
    els.playlistListEl.dataset.playlistVisibleRange = String(windowState.startIndex) + ':' + String(windowState.endIndex);
    els.playlistListEl.dataset.playlistMountedCount = String(mountedCount);
  }

  function playlistVirtualWindowKey(windowState) {
    return [
      state.playlist.length,
      playlistVirtual.rowHeight,
      windowState.startIndex,
      windowState.endIndex,
      windowState.topSpacerHeight,
      windowState.bottomSpacerHeight
    ].join(':');
  }

  function cancelPlaylistVirtualRender() {
    if (playlistVirtual.recycler) {
      playlistVirtual.recycler.cancel();
      return;
    }
    if (playlistVirtual.renderFrame !== null && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(playlistVirtual.renderFrame);
      playlistVirtual.renderFrame = null;
    }
  }

  // Must stay inside initPlaylist so afterRender can call selection/drag helpers.
  function createPlaylistVirtualRecycler(contentEl) {
    playlistVirtual.contentEl = contentEl;
    return createVirtualRowRecycler({
      viewport: els.playlistListEl,
      rowCount: state.playlist.length,
      getItem: function (index) { return state.playlist[index]; },
      rowHeight: playlistVirtual.rowHeight,
      overscan: playlistVirtual.overscan,
      threshold: playlistVirtual.threshold,
      getViewport: playlistVirtualViewport,
      createRow: function () { return createPlaylistRow(null, 0, true); },
      mountRow: function (row) { contentEl.appendChild(row); },
      updateRow: function (row, song, index, _slot, _windowState, recyclerState) {
        var height = recyclerState && recyclerState.rowHeight
          ? recyclerState.rowHeight
          : playlistVirtual.rowHeight;
        updatePlaylistRow(row, song, index, true);
        row.style.top = String(index * height) + 'px';
        row.style.height = recyclerState && recyclerState.rowHeightMeasured
          ? String(height) + 'px'
          : '';
      },
      measureRowHeight: function (row) {
        if (!row || typeof row.getBoundingClientRect !== 'function') return 0;
        return Number(row.getBoundingClientRect().height) || 0;
      },
      renderWindow: function (windowState, mountedCount, _pool, recyclerState) {
        playlistVirtual.rowHeight = recyclerState.rowHeight;
        playlistVirtual.rowHeightMeasured = recyclerState.rowHeightMeasured;
        playlistVirtual.windowKey = playlistVirtualWindowKey(windowState);
        contentEl.style.height = String(windowState.totalHeight) + 'px';
        setPlaylistVirtualDataset(windowState, mountedCount);
      },
      afterRender: function (windowState, mountedCount, _pool, recyclerState) {
        playlistVirtual.rowHeight = recyclerState.rowHeight;
        playlistVirtual.rowHeightMeasured = recyclerState.rowHeightMeasured;
        playlistVirtual.windowKey = playlistVirtualWindowKey(windowState);
        setPlaylistVirtualDataset(windowState, mountedCount);
        paintPlaylistSelection();
        updatePlaylistDragIndicators();
      }
    });
  }

  function renderPlaylistVirtualWindow(force) {
    if (!playlistVirtual.enabled || !playlistVirtual.recycler) return null;
    return playlistVirtual.recycler.render(!!force);
  }

  function schedulePlaylistVirtualRender() {
    if (!playlistVirtual.enabled || !playlistVirtual.recycler) return;
    playlistVirtual.recycler.schedule(false);
  }

  function scrollPlaylistIndexIntoView(index) {
    var viewport;
    var top;
    var bottom;
    var nextScrollTop;
    if (!playlistVirtual.enabled || !els.playlistListEl || index < 0) return;
    viewport = playlistVirtualViewport();
    top = index * playlistVirtual.rowHeight;
    bottom = top + playlistVirtual.rowHeight;
    nextScrollTop = viewport.scrollTop;
    if (top < viewport.scrollTop) nextScrollTop = top;
    else if (bottom > viewport.scrollTop + viewport.viewportHeight) {
      nextScrollTop = bottom - viewport.viewportHeight;
    }
    if (nextScrollTop !== viewport.scrollTop) els.playlistListEl.scrollTop = Math.max(0, nextScrollTop);
    renderPlaylistVirtualWindow(true);
  }

  function focusPlaylistRemotePath(remotePath) {
    var rows;
    var target = null;
    var index;
    if (!els.playlistListEl || !remotePath) return;
    if (!ctx.layoutApi.playbackUiMayPaint()) {
      state.pendingPlaylistFocusRemotePath = remotePath;
      return;
    }
    index = playlistIndexByRemotePath(remotePath);
    if (playlistVirtual.enabled && index !== -1) scrollPlaylistIndexIntoView(index);
    rows = els.playlistListEl.querySelectorAll('.music-playlist-entry');
    Array.prototype.forEach.call(rows, function (row) {
      if (!target && row.dataset.remotePath === remotePath) target = row;
    });
    if (!target) return;
    if (typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({block: 'nearest'});
    }
  }

  function playlistIndexByRemotePath(remotePath) {
    var remotePathKey = playlistAbsolutePathKey({remote_path: remotePath, stream_path: remotePath});
    for (var i = 0; i < state.playlist.length; i += 1) {
      if (state.playlist[i].remote_path === remotePath) return i;
      if (remotePathKey && playlistAbsolutePathKey(state.playlist[i]) === remotePathKey) return i;
    }
    return -1;
  }

  function playlistIndexByAbsolutePath(song) {
    var pathKey = playlistAbsolutePathKey(song);
    if (!pathKey) return -1;
    for (var i = 0; i < state.playlist.length; i += 1) {
      if (playlistAbsolutePathKey(state.playlist[i]) === pathKey) return i;
    }
    return -1;
  }

  function playlistSelectedCount() {
    return Object.keys(state.selectedPlaylistRemotePaths).length;
  }

  function playlistDragSuppressed() {
    return Date.now() < playlistDrag.suppressClickUntil;
  }

  function suppressPlaylistRowInteraction() {
    playlistDrag.suppressClickUntil = Date.now() + 250;
  }

  function resetShuffleBag() {
    state.shuffleBag = [];
    state.shuffleSequence = [];
    state.shuffleCursor = -1;
  }

  function shuffleBagIndex() {
    var available = [];
    state.playlist.forEach(function (_song, index) {
      if (index !== state.currentPlaylistIndex || state.playlist.length === 1) available.push(index);
    });
    state.shuffleBag = state.shuffleBag.filter(function (index) {
      return index >= 0 && index < state.playlist.length && available.indexOf(index) !== -1;
    });
    if (state.shuffleBag.length === 0) {
      state.shuffleBag = available.slice();
    }
    if (state.shuffleBag.length === 0) return -1;
    var bagOffset = Math.floor(Math.random() * state.shuffleBag.length);
    var next = state.shuffleBag[bagOffset];
    state.shuffleBag.splice(bagOffset, 1);
    return next;
  }

  function addSongToPlaylistAndPlay(song) {
    if (!song || !song.remote_path) return;
    addSongsToPlaylist([song]);
    clearObject(state.selectedPlaylistRemotePaths);
    state.selectedPlaylistRemotePaths[song.remote_path] = true;
    state.playlistSelectionAnchor = song.remote_path;
    renderPlaylistSelection();
    focusPlaylistRemotePath(song.remote_path);
    ctx.playbackApi.playPlaylistRemotePath(song.remote_path);
  }

  function selectPlaylistRemotePath(remotePath, ev) {
    var index;
    var start;
    var remotePaths = state.playlist.map(function (song) { return song.remote_path; });
    if (els.playlistListEl && document.activeElement !== els.playlistListEl) els.playlistListEl.focus();
    if (ev.shiftKey && state.playlistSelectionAnchor) {
      index = remotePaths.indexOf(remotePath);
      start = remotePaths.indexOf(state.playlistSelectionAnchor);
      if (index !== -1 && start !== -1) {
        clearObject(state.selectedPlaylistRemotePaths);
        remotePaths.slice(Math.min(start, index), Math.max(start, index) + 1).forEach(function (path) {
          state.selectedPlaylistRemotePaths[path] = true;
        });
      }
    } else if (ev.ctrlKey || ev.metaKey) {
      if (state.selectedPlaylistRemotePaths[remotePath]) delete state.selectedPlaylistRemotePaths[remotePath];
      else state.selectedPlaylistRemotePaths[remotePath] = true;
      state.playlistSelectionAnchor = remotePath;
    } else {
      clearObject(state.selectedPlaylistRemotePaths);
      state.selectedPlaylistRemotePaths[remotePath] = true;
      state.playlistSelectionAnchor = remotePath;
    }
    renderPlaylistSelection();
  }

  function paintPlaylistSelection() {
    if (!els.playlistListEl) return;
    state.playlistSelectionDirty = false;
    Array.prototype.forEach.call(els.playlistListEl.querySelectorAll('.music-playlist-entry'), function (row) {
      var selected = !!state.selectedPlaylistRemotePaths[row.dataset.remotePath];
      row.classList.toggle('selected', selected);
      row.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
    ctx.pane.dataset.playlistSelectionCount = String(playlistSelectedCount());
  }

  function renderPlaylistSelection() {
    state.playlistSelectionDirty = true;
    if (!ctx.layoutApi.playbackUiMayPaint()) return;
    paintPlaylistSelection();
  }

  function playlistRows() {
    if (!els.playlistListEl) return [];
    return Array.prototype.slice.call(els.playlistListEl.querySelectorAll('.music-playlist-entry'));
  }

  function playlistRowFromEventTarget(target) {
    var row;
    if (!target || typeof target.closest !== 'function') return null;
    row = target.closest('.music-playlist-entry');
    return row && row.dataset && row.dataset.remotePath ? row : null;
  }

  function handlePlaylistListClick(ev) {
    var row = playlistRowFromEventTarget(ev.target);
    var handle = ev.target && typeof ev.target.closest === 'function'
      ? ev.target.closest('.music-playlist-drag-handle')
      : null;
    if (!row) return;
    if (handle) {
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    if (playlistDragSuppressed()) {
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    selectPlaylistRemotePath(row.dataset.remotePath, ev);
  }

  function handlePlaylistListDoubleClick(ev) {
    var row = playlistRowFromEventTarget(ev.target);
    if (!row || playlistDragSuppressed()) {
      if (row && playlistDragSuppressed()) {
        ev.preventDefault();
        ev.stopPropagation();
      }
      return;
    }
    ctx.playbackApi.playPlaylistRemotePath(row.dataset.remotePath);
  }

  function handlePlaylistListContextMenu(ev) {
    var row = playlistRowFromEventTarget(ev.target);
    if (!row || playlistDragSuppressed()) {
      if (row && playlistDragSuppressed()) {
        ev.preventDefault();
        ev.stopPropagation();
      }
      return;
    }
    openPlaylistContextMenu(ev, row.dataset.remotePath);
  }

  function handlePlaylistListPointerDown(ev) {
    var handle = ev.target && typeof ev.target.closest === 'function'
      ? ev.target.closest('.music-playlist-drag-handle')
      : null;
    var row = playlistRowFromEventTarget(ev.target);
    if (!handle || !row) return;
    startPlaylistDrag(row.dataset.remotePath, handle, ev);
  }

  function handlePlaylistListScroll() {
    schedulePlaylistVirtualRender();
  }

  function stopPlaylistAutoScroll() {
    if (playlistDrag.autoScrollFrame === null) return;
    window.cancelAnimationFrame(playlistDrag.autoScrollFrame);
    playlistDrag.autoScrollFrame = null;
  }

  function updatePlaylistDragTarget(clientY) {
    var dropTarget = playlistDropTarget(clientY);
    playlistDrag.targetRemotePath = dropTarget ? dropTarget.remotePath : null;
    playlistDrag.insertAfter = dropTarget ? dropTarget.insertAfter : false;
    updatePlaylistDragIndicators();
  }

  function playlistAutoScrollDelta(clientY) {
    var listRect;
    if (!els.playlistListEl) return 0;
    listRect = els.playlistListEl.getBoundingClientRect();
    return playlistAutoScrollDeltaForBounds(clientY, listRect.top, listRect.bottom);
  }

  function queuePlaylistAutoScroll() {
    if (!playlistDrag.active || playlistDrag.autoScrollFrame !== null) return;
    if (!playlistAutoScrollDelta(playlistDrag.lastClientY)) return;
    playlistDrag.autoScrollFrame = window.requestAnimationFrame(runPlaylistAutoScroll);
  }

  function runPlaylistAutoScroll() {
    var delta;
    var maxScrollTop;
    var nextScrollTop;
    playlistDrag.autoScrollFrame = null;
    if (!playlistDrag.active || !els.playlistListEl) return;
    delta = playlistAutoScrollDelta(playlistDrag.lastClientY);
    if (!delta) return;
    maxScrollTop = Math.max(0, els.playlistListEl.scrollHeight - els.playlistListEl.clientHeight);
    nextScrollTop = Math.max(0, Math.min(maxScrollTop, els.playlistListEl.scrollTop + delta));
    if (nextScrollTop === els.playlistListEl.scrollTop) return;
    els.playlistListEl.scrollTop = nextScrollTop;
    updatePlaylistDragTarget(playlistDrag.lastClientY);
    queuePlaylistAutoScroll();
  }

  function clearPlaylistDragIndicators() {
    if (els.playlistListEl) {
      els.playlistListEl.classList.remove('dragging');
      els.playlistListEl.dataset.dropIndicatorVisible = 'false';
      els.playlistListEl.style.removeProperty('--music-playlist-drop-indicator-y');
    }
    playlistRows().forEach(function (row) {
      row.classList.remove('drag-source');
    });
    if (playlistDrag.activeHandle) playlistDrag.activeHandle.classList.remove('dragging');
  }

  function updatePlaylistDragIndicators() {
    var draggedRemotePathSet = Object.create(null);
    var dropRow = null;
    if (!playlistDrag.active || !els.playlistListEl) {
      clearPlaylistDragIndicators();
      return;
    }
    els.playlistListEl.classList.add('dragging');
    playlistDrag.draggedRemotePaths.forEach(function (remotePath) {
      draggedRemotePathSet[remotePath] = true;
    });
    playlistRows().forEach(function (row) {
      var rowRemotePath = row.dataset.remotePath || '';
      var isDragged = !!draggedRemotePathSet[rowRemotePath];
      row.classList.toggle('drag-source', isDragged);
      if (!dropRow && playlistDrag.targetRemotePath === rowRemotePath) dropRow = row;
    });
    if (playlistVirtual.enabled && playlistDrag.targetRemotePath) {
      var targetIndex = playlistIndexByRemotePath(playlistDrag.targetRemotePath);
      if (targetIndex !== -1) {
        els.playlistListEl.dataset.dropIndicatorVisible = 'true';
        els.playlistListEl.style.setProperty(
          '--music-playlist-drop-indicator-y',
          String(
            targetIndex * playlistVirtual.rowHeight
            - playlistVirtualViewport().scrollTop
            + (playlistDrag.insertAfter ? playlistVirtual.rowHeight : 0)
          ) + 'px'
        );
      } else {
        els.playlistListEl.dataset.dropIndicatorVisible = 'false';
        els.playlistListEl.style.removeProperty('--music-playlist-drop-indicator-y');
      }
    } else if (dropRow) {
      els.playlistListEl.dataset.dropIndicatorVisible = 'true';
      els.playlistListEl.style.setProperty(
        '--music-playlist-drop-indicator-y',
        String(dropRow.offsetTop + (playlistDrag.insertAfter ? dropRow.offsetHeight : 0)) + 'px'
      );
    } else {
      els.playlistListEl.dataset.dropIndicatorVisible = 'false';
      els.playlistListEl.style.removeProperty('--music-playlist-drop-indicator-y');
    }
    if (playlistDrag.activeHandle) playlistDrag.activeHandle.classList.add('dragging');
  }

  function playlistDropTarget(clientY) {
    var rows = playlistRows();
    var listRect;
    var listTop;
    var listBottom;
    var virtualIndex;
    var virtualY;
    var virtualRowTop;
    if (!els.playlistListEl || rows.length === 0) return null;
    listRect = els.playlistListEl.getBoundingClientRect();
    listTop = listRect.top;
    listBottom = listRect.bottom;
    if (playlistVirtual.enabled) {
      if (clientY <= listTop) virtualIndex = 0;
      else if (clientY >= listBottom) virtualIndex = state.playlist.length - 1;
      else {
        virtualY = clientY - listTop + playlistVirtualViewport().scrollTop;
        virtualIndex = Math.floor(virtualY / playlistVirtual.rowHeight);
        virtualIndex = Math.max(0, Math.min(state.playlist.length - 1, virtualIndex));
      }
      virtualRowTop = virtualIndex * playlistVirtual.rowHeight;
      if (clientY <= listTop) {
        return {insertAfter: false, remotePath: state.playlist[virtualIndex].remote_path || ''};
      }
      if (clientY >= listBottom) {
        return {insertAfter: true, remotePath: state.playlist[virtualIndex].remote_path || ''};
      }
      return {
        insertAfter: virtualY - virtualRowTop >= playlistVirtual.rowHeight / 2,
        remotePath: state.playlist[virtualIndex].remote_path || ''
      };
    }
    if (clientY <= listTop) {
      return {insertAfter: false, remotePath: rows[0].dataset.remotePath || ''};
    }
    if (clientY >= listBottom) {
      return {insertAfter: true, remotePath: rows[rows.length - 1].dataset.remotePath || ''};
    }
    for (var i = 0; i < rows.length; i += 1) {
      var rect = rows[i].getBoundingClientRect();
      if (clientY < rect.top || clientY > rect.bottom) continue;
      return {
        insertAfter: clientY >= (rect.top + rect.bottom) / 2,
        remotePath: rows[i].dataset.remotePath || ''
      };
    }
    return null;
  }

  function resetPlaylistDragState() {
    playlistDrag.active = false;
    playlistDrag.activeHandle = null;
    playlistDrag.anchorRemotePath = null;
    playlistDrag.autoScrollFrame = null;
    playlistDrag.draggedRemotePaths = [];
    playlistDrag.insertAfter = false;
    playlistDrag.lastClientY = 0;
    playlistDrag.pointerId = null;
    playlistDrag.startX = 0;
    playlistDrag.startY = 0;
    playlistDrag.targetRemotePath = null;
  }

  function applyPlaylistReorder(anchorRemotePath, targetRemotePath, insertAfter) {
    var result = reorderPlaylistBlock(
      state.playlist,
      state.selectedPlaylistRemotePaths,
      anchorRemotePath,
      targetRemotePath,
      insertAfter,
      state.currentPlaylistIndex
    );
    if (!result.moved) return false;
    state.activePlaylist.replaceSongs(result.playlist);
    ctx.syncPlaylistState();
    state.currentPlaylistIndex = result.currentPlaylistIndex;
    syncActivePlaylistDirtyState();
    clearObject(state.selectedPlaylistRemotePaths);
    Object.keys(result.selectedRemotePaths).forEach(function (remotePath) {
      state.selectedPlaylistRemotePaths[remotePath] = true;
    });
    state.playlistSelectionAnchor = anchorRemotePath;
    resetShuffleBag();
    renderPlaylist();
    focusPlaylistRemotePath(anchorRemotePath);
    ctx.setStatus(
      'Moved ' + result.draggedRemotePaths.length + ' playlist song' +
      (result.draggedRemotePaths.length === 1 ? '' : 's') + '.'
    );
    return true;
  }

  function finishPlaylistDrag(cancelled) {
    var shouldSuppressInteraction = playlistDrag.active;
    window.removeEventListener('pointermove', handlePlaylistDragMove);
    window.removeEventListener('pointerup', handlePlaylistDragEnd);
    window.removeEventListener('pointercancel', handlePlaylistDragCancel);
    stopPlaylistAutoScroll();
    clearPlaylistDragIndicators();
    if (!cancelled && playlistDrag.active && playlistDrag.targetRemotePath) {
      applyPlaylistReorder(playlistDrag.anchorRemotePath, playlistDrag.targetRemotePath, playlistDrag.insertAfter);
    }
    if (shouldSuppressInteraction) suppressPlaylistRowInteraction();
    resetPlaylistDragState();
  }

  function handlePlaylistDragMove(ev) {
    if (ev.pointerId !== playlistDrag.pointerId) return;
    if (!playlistDrag.active) {
      if (Math.abs(ev.clientX - playlistDrag.startX) < 4 && Math.abs(ev.clientY - playlistDrag.startY) < 4) return;
      playlistDrag.active = true;
    }
    playlistDrag.lastClientY = ev.clientY;
    updatePlaylistDragTarget(ev.clientY);
    if (playlistAutoScrollDelta(ev.clientY)) queuePlaylistAutoScroll();
    else stopPlaylistAutoScroll();
  }

  function handlePlaylistDragEnd(ev) {
    if (ev.pointerId !== playlistDrag.pointerId) return;
    finishPlaylistDrag(false);
  }

  function handlePlaylistDragCancel(ev) {
    if (ev.pointerId !== playlistDrag.pointerId) return;
    finishPlaylistDrag(true);
  }

  function startPlaylistDrag(remotePath, handleEl, ev) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    hidePlaylistContextMenu();
    if (!state.selectedPlaylistRemotePaths[remotePath]) {
      clearObject(state.selectedPlaylistRemotePaths);
      state.selectedPlaylistRemotePaths[remotePath] = true;
      state.playlistSelectionAnchor = remotePath;
      renderPlaylistSelection();
    }
    if (els.playlistListEl && document.activeElement !== els.playlistListEl) els.playlistListEl.focus();
    playlistDrag.active = false;
    playlistDrag.activeHandle = handleEl;
    playlistDrag.anchorRemotePath = remotePath;
    playlistDrag.draggedRemotePaths = draggedPlaylistBlockRemotePaths(
      state.playlist,
      state.selectedPlaylistRemotePaths,
      remotePath
    );
    playlistDrag.insertAfter = false;
    playlistDrag.lastClientY = ev.clientY;
    playlistDrag.pointerId = ev.pointerId;
    playlistDrag.startX = ev.clientX;
    playlistDrag.startY = ev.clientY;
    playlistDrag.targetRemotePath = null;
    window.addEventListener('pointermove', handlePlaylistDragMove);
    window.addEventListener('pointerup', handlePlaylistDragEnd);
    window.addEventListener('pointercancel', handlePlaylistDragCancel);
  }

  function selectAllPlaylistSongs() {
    clearObject(state.selectedPlaylistRemotePaths);
    state.playlist.forEach(function (song) {
      if (song && song.remote_path) state.selectedPlaylistRemotePaths[song.remote_path] = true;
    });
    if (!state.selectedPlaylistRemotePaths[state.playlistSelectionAnchor]) {
      state.playlistSelectionAnchor = state.playlist[0] ? state.playlist[0].remote_path : null;
    }
    renderPlaylistSelection();
  }

  function handlePlaylistSelectAllShortcut(ev) {
    if (!(ev.ctrlKey || ev.metaKey) || ev.shiftKey || ev.altKey) return;
    if (String(ev.key || '').toLowerCase() !== 'a') return;
    ev.preventDefault();
    performPlaylistSelectAll();
  }

  function playlistSongByRemotePath(remotePath) {
    var index = playlistIndexByRemotePath(remotePath);
    if (index === -1) return null;
    return state.playlist[index] || null;
  }

  function contextPlaylistSong() {
    var remotePath = state.playlistContextRemotePath || Object.keys(state.selectedPlaylistRemotePaths)[0] || null;
    return remotePath ? playlistSongByRemotePath(remotePath) : null;
  }

  function absolutePlaylistPath(song) {
    if (!song) return '';
    return song.stream_path || song.rel_path || song.display_name || '';
  }

  function dropboxHomeUrl(path) {
    var encoded = String(path || '')
      .split('/')
      .map(function (segment) { return encodeURIComponent(segment); })
      .join('/');
    return 'https://www.dropbox.com/home' + (encoded ? '/' + encoded : '');
  }

  function copyText(text) {
    if (!text) return Promise.resolve(false);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }).catch(function () { return false; });
    }
    return new Promise(function (resolve) {
      var input = document.createElement('input');
      input.type = 'text';
      input.value = text;
      input.setAttribute('readonly', 'readonly');
      input.style.position = 'fixed';
      input.style.left = '-9999px';
      document.body.appendChild(input);
      input.select();
      input.setSelectionRange(0, input.value.length);
      try {
        resolve(document.execCommand('copy'));
      } catch (_err) {
        resolve(false);
      } finally {
        document.body.removeChild(input);
      }
    });
  }

  function performPlaylistSelectAll() {
    if (els.playlistListEl && document.activeElement !== els.playlistListEl) els.playlistListEl.focus();
    selectAllPlaylistSongs();
  }

  function hidePlaylistContextMenu() {
    if (!els.playlistMenu) return;
    els.playlistMenu.hidden = true;
    els.playlistMenu.classList.add('hidden');
    state.playlistContextRemotePath = null;
  }

  function openPlaylistContextMenu(ev, remotePath) {
    ev.preventDefault();
    if (!state.selectedPlaylistRemotePaths[remotePath]) {
      clearObject(state.selectedPlaylistRemotePaths);
      state.selectedPlaylistRemotePaths[remotePath] = true;
      state.playlistSelectionAnchor = remotePath;
      renderPlaylistSelection();
    }
    state.playlistContextRemotePath = remotePath;
    if (!els.playlistMenu) return;
    els.playlistMenu.style.left = ev.clientX + 'px';
    els.playlistMenu.style.top = ev.clientY + 'px';
    els.playlistMenu.hidden = false;
    els.playlistMenu.classList.remove('hidden');
  }

  function removeSelectedPlaylistSongs() {
    var currentSong = state.playlist[state.currentPlaylistIndex] || null;
    var currentRemotePath = currentSong ? currentSong.remote_path : null;
    var removedCurrent = !!(currentRemotePath && state.selectedPlaylistRemotePaths[currentRemotePath]);
    var oldCurrentIndex = state.currentPlaylistIndex;

    state.activePlaylist.removeSongsByRemotePaths(state.selectedPlaylistRemotePaths);
    ctx.syncPlaylistState();
    resetShuffleBag();
    syncActivePlaylistDirtyState();
    clearObject(state.selectedPlaylistRemotePaths);
    state.playlistSelectionAnchor = null;

    if (removedCurrent) {
      ctx.playbackApi.clearCurrentSong();
      if (state.playlist.length > 0) ctx.playbackApi.playPlaylistIndex(Math.min(oldCurrentIndex, state.playlist.length - 1));
    } else if (currentRemotePath) {
      state.currentPlaylistIndex = playlistIndexByRemotePath(currentRemotePath);
    }
    renderPlaylist();
  }

  function updatePlaylistRow(row, song, index, virtualized) {
    if (!row || !song) return row;
    row.className = 'music-playlist-row music-playlist-entry';
    row.setAttribute('role', 'row');
    row.setAttribute('aria-selected', state.selectedPlaylistRemotePaths[song.remote_path] ? 'true' : 'false');
    row.dataset.remotePath = song.remote_path;
    row.dataset.streamPath = song.stream_path;
    row.dataset.playlistIndex = String(index);
    row.classList.toggle('selected', !!state.selectedPlaylistRemotePaths[song.remote_path]);
    row.classList.toggle('current', index === state.currentPlaylistIndex);
    row.classList.toggle('music-playlist-virtual-entry', !!virtualized);
    row.querySelector('.music-playlist-index-cell').textContent = String(index + 1);
    row.querySelector('.music-playlist-filename-cell').textContent = song.display_name || '';
    row.querySelector('.music-playlist-path-cell').textContent = absolutePlaylistPath(song);
    return row;
  }

  function createPlaylistRow(song, index, virtualized) {
    var row = document.createElement('div');
    var dragHandle;
    var handleCell;
    var indexCell;
    var nameCell;
    var pathCell;
    var dragHandleIcon;
    row.className = 'music-playlist-row music-playlist-entry';
    row.setAttribute('role', 'row');

    indexCell = document.createElement('div');
    indexCell.className = 'music-playlist-index-cell';
    indexCell.setAttribute('role', 'cell');
    indexCell.textContent = '';
    row.appendChild(indexCell);

    nameCell = document.createElement('div');
    nameCell.className = 'music-playlist-filename-cell';
    nameCell.setAttribute('role', 'cell');
    nameCell.textContent = '';
    row.appendChild(nameCell);

    pathCell = document.createElement('div');
    pathCell.className = 'music-playlist-path-cell';
    pathCell.setAttribute('role', 'cell');
    pathCell.textContent = '';
    row.appendChild(pathCell);

    handleCell = document.createElement('div');
    handleCell.className = 'music-playlist-handle-cell';
    handleCell.setAttribute('role', 'cell');
    dragHandle = document.createElement('button');
    dragHandle.type = 'button';
    dragHandle.className = 'music-playlist-drag-handle';
    dragHandle.setAttribute('aria-label', 'Reorder playlist item');
    dragHandle.title = 'Drag to reorder playlist';
    dragHandleIcon = document.createElement('span');
    dragHandleIcon.className = 'music-playlist-drag-handle-icon';
    dragHandleIcon.setAttribute('aria-hidden', 'true');
    dragHandle.appendChild(dragHandleIcon);
    handleCell.appendChild(dragHandle);
    row.appendChild(handleCell);
    updatePlaylistRow(row, song, index, virtualized);
    return row;
  }

  function destroyPlaylistVirtualRecycler() {
    if (playlistVirtual.recycler) playlistVirtual.recycler.destroy();
    playlistVirtual.recycler = null;
    playlistVirtual.contentEl = null;
  }

  function resetPlaylistVirtualState() {
    cancelPlaylistVirtualRender();
    playlistVirtual.enabled = false;
    playlistVirtual.windowKey = '';
    playlistVirtual.contentEl = null;
    playlistVirtual.rowHeightMeasured = false;
    playlistVirtual.rowHeight = Number.isFinite(cfg.playlistVirtualRowHeight)
      ? Math.max(1, cfg.playlistVirtualRowHeight)
      : DEFAULT_PLAYLIST_VIRTUAL_ROW_HEIGHT;
  }

  function paintPlaylist() {
    var empty;
    var contentEl;
    var useVirtual = playlistVirtualShouldRender();
    if (!els.playlistListEl) return;
    updateActivePlaylistName();
    state.playlistRenderDirty = false;
    state.playlistSelectionDirty = false;
    els.playlistListEl.dataset.playlistCount = String(state.playlist.length);
    if (state.playlist.length === 0) {
      destroyPlaylistVirtualRecycler();
      resetPlaylistVirtualState();
      els.playlistListEl.textContent = '';
      empty = document.createElement('div');
      empty.className = 'music-empty-state';
      empty.textContent = 'Playlist is empty.';
      els.playlistListEl.appendChild(empty);
      setPlaylistVirtualDataset(null, 0);
      ctx.pane.dataset.playlistSelectionCount = String(playlistSelectedCount());
      return;
    }
    if (useVirtual) {
      playlistVirtual.enabled = true;
      if (
        playlistVirtual.recycler &&
        playlistVirtual.contentEl &&
        playlistVirtual.contentEl.parentNode !== els.playlistListEl
      ) {
        destroyPlaylistVirtualRecycler();
      }
      if (!playlistVirtual.recycler) {
        els.playlistListEl.textContent = '';
        contentEl = document.createElement('div');
        contentEl.className = 'music-playlist-virtual-content';
        contentEl.setAttribute('role', 'presentation');
        els.playlistListEl.appendChild(contentEl);
        playlistVirtual.recycler = createPlaylistVirtualRecycler(contentEl);
      }
      playlistVirtual.recycler.setData(state.playlist.length, function (index) {
        return state.playlist[index];
      });
      renderPlaylistVirtualWindow(true);
      return;
    }
    destroyPlaylistVirtualRecycler();
    resetPlaylistVirtualState();
    els.playlistListEl.textContent = '';
    state.playlist.forEach(function (song, index) {
      els.playlistListEl.appendChild(createPlaylistRow(song, index, false));
    });
    setPlaylistVirtualDataset(null, state.playlist.length);
    paintPlaylistSelection();
  }

  function renderPlaylist() {
    state.playlistRenderDirty = true;
    updateActivePlaylistName();
    if (!ctx.layoutApi.playbackUiMayPaint()) return;
    paintPlaylist();
  }

  ctx.playlistApi = {
    addSongToPlaylistAndPlay: addSongToPlaylistAndPlay,
    addSongsToPlaylist: addSongsToPlaylist,
    activePlaylistHasNameConflict: activePlaylistHasNameConflict,
    closePlaylistDialogs: closePlaylistDialogs,
    confirmLoadPlaylist: confirmLoadPlaylist,
    confirmLoadNewPlaylist: confirmLoadNewPlaylist,
    deletePersistedPlaylist: deletePersistedPlaylist,
    exportPersistedPlaylists: exportPersistedPlaylists,
    focusPlaylistRemotePath: focusPlaylistRemotePath,
    hidePlaylistLoadContextMenu: hidePlaylistLoadContextMenu,
    handlePlaylistSelectAllShortcut: handlePlaylistSelectAllShortcut,
    hidePlaylistContextMenu: hidePlaylistContextMenu,
    importPlaylistFiles: importPlaylistFiles,
    loadPlaylistByName: loadPlaylistByName,
    openLoadDialog: openLoadDialog,
    openRecentDialog: openRecentDialog,
    openRenameDialog: openRenameDialog,
    openPlaylistContextMenu: openPlaylistContextMenu,
    paintPlaylist: paintPlaylist,
    paintPlaylistSelection: paintPlaylistSelection,
    performPlaylistSelectAll: performPlaylistSelectAll,
    playlistIndexByRemotePath: playlistIndexByRemotePath,
    playlistIndexByAbsolutePath: playlistIndexByAbsolutePath,
    playlistSelectedCount: playlistSelectedCount,
    playlistStateSignature: activePlaylistSignature,
    renderPlaylistLoadList: renderPlaylistLoadList,
    removeSelectedPlaylistSongs: removeSelectedPlaylistSongs,
    renderPlaylist: renderPlaylist,
    renderPlaylistSelection: renderPlaylistSelection,
    closeRecentDialog: closeRecentDialog,
    confirmRecentSelection: confirmRecentSelection,
    renderRecentList: renderRecentList,
    resetShuffleBag: resetShuffleBag,
    savePlaylist: savePlaylist,
    selectAllPlaylistSongs: selectAllPlaylistSongs,
    selectPlaylistRemotePath: selectPlaylistRemotePath,
    showPlaylistErrorToast: showPlaylistErrorToast,
    syncActivePlaylistDirtyState: syncActivePlaylistDirtyState,
    shuffleBagIndex: shuffleBagIndex
  };

  restorePlaylistLoadSort();
  restorePlaylistLoadFilter();
  restoreRecentSort();
  updatePlaylistMediaLabels();
  state.activePlaylistSavedSignature = activePlaylistSignature();
  syncActivePlaylistDirtyState();
  if (els.activePlaylistNameEl) updateActivePlaylistName();
  if (els.playlistLoadConfirmButton) els.playlistLoadConfirmButton.disabled = true;

  if (els.playlistImportButton) {
    els.playlistImportButton.addEventListener('click', function () {
      if (els.playlistImportInput) els.playlistImportInput.click();
    });
  }
  if (els.playlistExportButton) {
    els.playlistExportButton.addEventListener('click', function () {
      exportPersistedPlaylists();
    });
  }
  if (els.playlistImportInput) {
    els.playlistImportInput.addEventListener('change', function () {
      importPlaylistFiles(els.playlistImportInput.files);
    });
  }
  if (els.playlistRenameButton) {
    els.playlistRenameButton.addEventListener('click', function () {
      openRenameDialog('rename');
    });
  }
  if (els.playlistSaveButton) {
    els.playlistSaveButton.addEventListener('click', function () {
      savePlaylist(activePlaylistName());
    });
  }
  if (els.playlistLoadButton) {
    els.playlistLoadButton.addEventListener('click', function () {
      openLoadDialog();
    });
  }
  if (els.recentButton) {
    els.recentButton.addEventListener('click', function () {
      openRecentDialog();
    });
  }
  if (els.recentCancelButton) {
    els.recentCancelButton.addEventListener('click', closeRecentDialog);
  }
  if (els.recentConfirmButton) {
    els.recentConfirmButton.addEventListener('click', confirmRecentSelection);
  }
  if (els.recentSortButtons) {
    Array.prototype.forEach.call(els.recentSortButtons, function (button) {
      button.addEventListener('click', function () {
        var nextSort = nextRecentSort(
          state.recentSortKey,
          state.recentSortDirection,
          button.getAttribute('data-recent-sort-key')
        );
        state.recentSortKey = nextSort.key;
        state.recentSortDirection = nextSort.direction;
        persistRecentSort();
        renderRecentList();
      });
    });
  }
  if (els.playlistRenameCancelButton) {
    els.playlistRenameCancelButton.addEventListener('click', closeRenameDialog);
  }
  if (els.playlistRenameConfirmButton) {
    els.playlistRenameConfirmButton.addEventListener('click', confirmRenameDialog);
  }
  if (els.playlistRenameInput) {
    els.playlistRenameInput.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        confirmRenameDialog();
      }
      if (ev.key === 'Escape') {
        ev.preventDefault();
        closeRenameDialog();
      }
    });
  }
  if (els.playlistOverwriteCancelButton) {
    els.playlistOverwriteCancelButton.addEventListener('click', closeOverwriteDialog);
  }
  if (els.playlistOverwriteConfirmButton) {
    els.playlistOverwriteConfirmButton.addEventListener('click', function () {
      var confirmAction = state.pendingPlaylistConfirmAction;
      if (typeof confirmAction !== 'function') {
        closeOverwriteDialog();
        return;
      }
      confirmAction();
    });
  }
  if (els.playlistLoadCancelButton) {
    els.playlistLoadCancelButton.addEventListener('click', closeLoadDialog);
  }
  if (els.playlistLoadConfirmButton) {
    els.playlistLoadConfirmButton.addEventListener('click', function () {
      confirmLoadPlaylist();
    });
  }
  if (els.playlistLoadNewButton) {
    els.playlistLoadNewButton.addEventListener('click', function () {
      confirmLoadNewPlaylist();
    });
  }
  if (els.playlistLoadFilterInput) {
    els.playlistLoadFilterInput.addEventListener('input', function () {
      state.playlistLoadFilterText = normalizePlaylistLoadFilter(els.playlistLoadFilterInput.value);
      persistPlaylistLoadFilter();
      renderPlaylistLoadList();
    });
    els.playlistLoadFilterInput.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        confirmLoadPlaylist();
      }
      if (ev.key === 'Escape') {
        ev.preventDefault();
        closeLoadDialog();
      }
    });
  }
  if (els.playlistLoadSortButtons) {
    Array.prototype.forEach.call(els.playlistLoadSortButtons, function (button) {
      button.addEventListener('click', function () {
        var nextSort = nextPlaylistLoadSort(
          state.playlistLoadSortKey,
          state.playlistLoadSortDirection,
          button.getAttribute('data-playlist-sort-key')
        );
        state.playlistLoadSortKey = nextSort.key;
        state.playlistLoadSortDirection = nextSort.direction;
        persistPlaylistLoadSort();
        renderPlaylistLoadList();
      });
    });
  }
  if (els.playlistSaveToastCloseButton) {
    els.playlistSaveToastCloseButton.addEventListener('click', function () {
      hidePlaylistSaveToast();
    });
  }

  if (els.playlistMenu) {
    els.playlistMenu.addEventListener('click', function (ev) {
      var actionEl = ev.target && ev.target.closest ? ev.target.closest('[data-action]') : null;
      var action = actionEl && actionEl.getAttribute('data-action');
      var song = contextPlaylistSong();
      if (action === 'play') ctx.playbackApi.playPlaylistRemotePath(state.playlistContextRemotePath || Object.keys(state.selectedPlaylistRemotePaths)[0]);
      if (action === 'remove') removeSelectedPlaylistSongs();
      if (action === 'select-all') performPlaylistSelectAll();
      if (action === 'copy-filename' && song) copyText(song.filename || song.display_name || '');
      if (action === 'copy-absolute-path' && song) copyText(absolutePlaylistPath(song));
      if (action === 'copy-dropbox-url' && song) copyText(dropboxHomeUrl(absolutePlaylistPath(song)));
      if (!action) return;
      hidePlaylistContextMenu();
    });
  }
  if (els.playlistLoadMenu) {
    els.playlistLoadMenu.addEventListener('click', function (ev) {
      var actionEl = ev.target && ev.target.closest ? ev.target.closest('[data-action]') : null;
      var action = actionEl && actionEl.getAttribute('data-action');
      if (action === 'delete') deletePersistedPlaylist(state.playlistLoadContextName);
      if (!action) return;
      hidePlaylistLoadContextMenu();
    });
  }
  if (els.playlistListEl) {
    els.playlistListEl.addEventListener('click', handlePlaylistListClick);
    els.playlistListEl.addEventListener('dblclick', handlePlaylistListDoubleClick);
    els.playlistListEl.addEventListener('contextmenu', handlePlaylistListContextMenu);
    els.playlistListEl.addEventListener('pointerdown', handlePlaylistListPointerDown);
    els.playlistListEl.addEventListener('scroll', handlePlaylistListScroll, {passive: true});
    els.playlistListEl.addEventListener('keydown', handlePlaylistSelectAllShortcut);
    if (typeof ResizeObserver === 'function') {
      playlistVirtual.resizeObserver = new ResizeObserver(function () {
        if (!playlistVirtual.enabled) return;
        playlistVirtual.windowKey = '';
        schedulePlaylistVirtualRender();
      });
      playlistVirtual.resizeObserver.observe(els.playlistListEl);
    }
  }
}
