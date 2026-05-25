import {clearObject} from './music-shared.js';

export function initPlaylist(ctx) {
  var els = ctx.els;
  var state = ctx.state;

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
      row.addEventListener('click', function (ev) {
        selectPlaylistRemotePath(song.remote_path, ev);
      });
      row.addEventListener('dblclick', function () {
        ctx.playbackApi.playPlaylistRemotePath(song.remote_path);
      });
      row.addEventListener('contextmenu', function (ev) {
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
