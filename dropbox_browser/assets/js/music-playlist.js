import {clearObject} from './music-shared.js';

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

export function initPlaylist(ctx) {
  var els = ctx.els;
  var state = ctx.state;
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

  function addSongsToPlaylist(songs) {
    var added = 0;
    songs.forEach(function (song) {
      if (!song.remote_path || state.playlistRemotePaths[song.remote_path]) return;
      state.playlistRemotePaths[song.remote_path] = true;
      state.playlist.push({
        display_name: song.display_name,
        filename: song.filename || song.display_name,
        rel_path: song.rel_path,
        remote_path: song.remote_path,
        stream_path: song.stream_path,
        extension: song.extension || ctx.playbackApi.metadata.metadataExtension(song)
      });
      added += 1;
    });
    if (added) resetShuffleBag();
    renderPlaylist();
    ctx.setStatus(added ? 'Added ' + added + ' cached song' + (added === 1 ? '' : 's') + ' to playlist.' : 'No new cached songs to add.');
  }

  function focusPlaylistRemotePath(remotePath) {
    var rows;
    var target = null;
    if (!els.playlistListEl || !remotePath) return;
    if (!ctx.layoutApi.playbackUiMayPaint()) {
      state.pendingPlaylistFocusRemotePath = remotePath;
      return;
    }
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
    for (var i = 0; i < state.playlist.length; i += 1) {
      if (state.playlist[i].remote_path === remotePath) return i;
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
    if (dropRow) {
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
    if (!els.playlistListEl || rows.length === 0) return null;
    listRect = els.playlistListEl.getBoundingClientRect();
    listTop = listRect.top;
    listBottom = listRect.bottom;
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
    state.playlist = result.playlist;
    state.currentPlaylistIndex = result.currentPlaylistIndex;
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

    state.playlist = state.playlist.filter(function (song) {
      if (!state.selectedPlaylistRemotePaths[song.remote_path]) return true;
      delete state.playlistRemotePaths[song.remote_path];
      return false;
    });
    resetShuffleBag();
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

  function paintPlaylist() {
    if (!els.playlistListEl) return;
    state.playlistRenderDirty = false;
    state.playlistSelectionDirty = false;
    els.playlistListEl.textContent = '';
    if (state.playlist.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'music-empty-state';
      empty.textContent = 'Playlist is empty.';
      els.playlistListEl.appendChild(empty);
      ctx.pane.dataset.playlistSelectionCount = String(playlistSelectedCount());
      return;
    }
    state.playlist.forEach(function (song, index) {
      var row = document.createElement('div');
      var dragHandle;
      var handleCell;
      row.className = 'music-playlist-row music-playlist-entry';
      row.setAttribute('role', 'row');
      row.setAttribute('aria-selected', state.selectedPlaylistRemotePaths[song.remote_path] ? 'true' : 'false');
      row.dataset.remotePath = song.remote_path;
      row.dataset.streamPath = song.stream_path;
      if (state.selectedPlaylistRemotePaths[song.remote_path]) row.classList.add('selected');
      if (index === state.currentPlaylistIndex) row.classList.add('current');

      var nameCell = document.createElement('div');
      nameCell.setAttribute('role', 'cell');
      nameCell.textContent = song.display_name || '';
      row.appendChild(nameCell);

      var pathCell = document.createElement('div');
      pathCell.setAttribute('role', 'cell');
      pathCell.textContent = absolutePlaylistPath(song);
      row.appendChild(pathCell);
      handleCell = document.createElement('div');
      handleCell.className = 'music-playlist-handle-cell';
      handleCell.setAttribute('role', 'cell');
      dragHandle = document.createElement('button');
      dragHandle.type = 'button';
      dragHandle.className = 'music-playlist-drag-handle';
      dragHandle.setAttribute('aria-label', 'Reorder playlist item');
      dragHandle.title = 'Drag to reorder playlist';
      var dragHandleIcon = document.createElement('span');
      dragHandleIcon.className = 'music-playlist-drag-handle-icon';
      dragHandleIcon.setAttribute('aria-hidden', 'true');
      dragHandle.appendChild(dragHandleIcon);
      dragHandle.addEventListener('pointerdown', function (ev) {
        startPlaylistDrag(song.remote_path, dragHandle, ev);
      });
      dragHandle.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
      });
      handleCell.appendChild(dragHandle);
      row.appendChild(handleCell);
      row.addEventListener('click', function (ev) {
        if (playlistDragSuppressed()) {
          ev.preventDefault();
          ev.stopPropagation();
          return;
        }
        selectPlaylistRemotePath(song.remote_path, ev);
      });
      row.addEventListener('dblclick', function (ev) {
        if (playlistDragSuppressed()) {
          ev.preventDefault();
          ev.stopPropagation();
          return;
        }
        ctx.playbackApi.playPlaylistRemotePath(song.remote_path);
      });
      row.addEventListener('contextmenu', function (ev) {
        if (playlistDragSuppressed()) {
          ev.preventDefault();
          ev.stopPropagation();
          return;
        }
        openPlaylistContextMenu(ev, song.remote_path);
      });
      els.playlistListEl.appendChild(row);
    });
    paintPlaylistSelection();
  }

  function renderPlaylist() {
    state.playlistRenderDirty = true;
    if (!ctx.layoutApi.playbackUiMayPaint()) return;
    paintPlaylist();
  }

  ctx.playlistApi = {
    addSongToPlaylistAndPlay: addSongToPlaylistAndPlay,
    addSongsToPlaylist: addSongsToPlaylist,
    focusPlaylistRemotePath: focusPlaylistRemotePath,
    handlePlaylistSelectAllShortcut: handlePlaylistSelectAllShortcut,
    hidePlaylistContextMenu: hidePlaylistContextMenu,
    openPlaylistContextMenu: openPlaylistContextMenu,
    paintPlaylist: paintPlaylist,
    paintPlaylistSelection: paintPlaylistSelection,
    performPlaylistSelectAll: performPlaylistSelectAll,
    playlistIndexByRemotePath: playlistIndexByRemotePath,
    playlistSelectedCount: playlistSelectedCount,
    removeSelectedPlaylistSongs: removeSelectedPlaylistSongs,
    renderPlaylist: renderPlaylist,
    renderPlaylistSelection: renderPlaylistSelection,
    resetShuffleBag: resetShuffleBag,
    selectAllPlaylistSongs: selectAllPlaylistSongs,
    selectPlaylistRemotePath: selectPlaylistRemotePath,
    shuffleBagIndex: shuffleBagIndex
  };

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
  if (els.playlistListEl) els.playlistListEl.addEventListener('keydown', handlePlaylistSelectAllShortcut);
}
