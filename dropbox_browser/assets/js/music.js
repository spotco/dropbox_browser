(function () {
  var pane = document.getElementById('music-player-pane');
  if (!pane) return;

  var loadButton = document.getElementById('music-library-load');
  var statusEl = document.getElementById('music-library-status');
  var treeEl = document.getElementById('music-library-tree');
  var playlistListEl = document.getElementById('music-playlist-list');
  var libraryMenu = document.getElementById('music-library-context-menu');
  var playlistMenu = document.getElementById('music-playlist-context-menu');
  var audio = document.getElementById('music-audio');
  var currentFilenameEl = document.getElementById('music-current-filename');
  var playButton = document.getElementById('music-play');
  var pauseButton = document.getElementById('music-pause');
  var nextButton = document.getElementById('music-next');
  var prevButton = document.getElementById('music-prev');
  var shuffleButton = document.getElementById('music-shuffle-toggle');
  var loopButton = document.getElementById('music-loop-toggle');
  var controls = pane.querySelector('.music-player-controls');
  var currentFolder = document.body.dataset.currentFolderPath || '';
  var defaultPollDelayMs = 4000;
  var pollDelayMs = defaultPollDelayMs;
  var pollTimer = null;
  var libraryRequested = false;
  var loading = false;
  var libraryRoot = currentFolder;
  var librarySnapshot = null;
  var expandedIds = Object.create(null);
  var selectedIds = Object.create(null);
  var visibleNodeIds = [];
  var selectionAnchor = null;
  var contextNodeId = null;
  var playlist = [];
  var playlistRemotePaths = Object.create(null);
  var selectedPlaylistRemotePaths = Object.create(null);
  var playlistSelectionAnchor = null;
  var playlistContextRemotePath = null;
  var currentPlaylistIndex = -1;
  var shuffleEnabled = false;
  var loopPlaylist = false;
  var shuffleBag = [];
  var lastLibraryFingerprint = '';

  pane.setAttribute('data-player-ready', 'library');
  if (controls) controls.setAttribute('data-controls-ready', 'markup');

  function isVisible() {
    return !pane.hidden && !pane.classList.contains('hidden');
  }

  function clearObject(obj) {
    Object.keys(obj).forEach(function (key) {
      delete obj[key];
    });
  }

  function selectedCount() {
    return Object.keys(selectedIds).length;
  }

  function escStatus(status) {
    if (!status) return 'Library status unavailable.';
    var message = status.message || '';
    var count = status.missing_listing_count || 0;
    if (status.cache_status === 'complete') return 'Complete cached library.';
    if (status.cache_status === 'unavailable') return message || 'No cached listing is available for this folder yet.';
    if (count) return (message || 'Library may update as cached metadata arrives.') + ' Missing cached folders: ' + count + '.';
    return message || 'Library may update as cached metadata arrives.';
  }

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function libraryUrl() {
    return '/music/endpoints/library?path=' + encodeURIComponent(libraryRoot);
  }

  function stopPolling() {
    if (pollTimer !== null) {
      window.clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function schedulePoll() {
    stopPolling();
    if (!libraryRequested || !isVisible()) return;
    pollTimer = window.setTimeout(function () {
      fetchLibrary(true);
    }, pollDelayMs);
  }

  function libraryFingerprint(data) {
    var fingerprintData;
    var status;
    if (!data) return JSON.stringify(null);
    fingerprintData = {
      root: data.root || null,
      folders: data.folders || [],
      songs: data.songs || [],
      status: null
    };
    status = data.status || null;
    if (status) {
      fingerprintData.status = {
        cache_status: status.cache_status || '',
        complete: !!status.complete,
        message: status.message || '',
        missing_listing_count: status.missing_listing_count || 0
      };
    }
    return JSON.stringify(fingerprintData);
  }

  function indexByParent(items) {
    var map = Object.create(null);
    items.forEach(function (item) {
      var key = item.parent_id || '';
      if (!map[key]) map[key] = [];
      map[key].push(item);
    });
    Object.keys(map).forEach(function (key) {
      map[key].sort(function (a, b) {
        return (a.display_name || '').localeCompare(b.display_name || '', undefined, {sensitivity: 'base'});
      });
    });
    return map;
  }

  function libraryNodesById() {
    var nodes = Object.create(null);
    if (!librarySnapshot) return nodes;
    if (librarySnapshot.root) nodes[librarySnapshot.root.id] = librarySnapshot.root;
    (librarySnapshot.folders || []).forEach(function (folder) {
      nodes[folder.id] = folder;
    });
    (librarySnapshot.songs || []).forEach(function (song) {
      nodes[song.id] = song;
    });
    return nodes;
  }

  function nodeStillExists(snapshot, nodeId) {
    if (!snapshot) return false;
    if (snapshot.root && snapshot.root.id === nodeId) return true;
    return snapshot.folders.some(function (folder) { return folder.id === nodeId; }) ||
      snapshot.songs.some(function (song) { return song.id === nodeId; });
  }

  function pruneSelectedIds(snapshot) {
    Object.keys(selectedIds).forEach(function (nodeId) {
      if (!nodeStillExists(snapshot, nodeId)) delete selectedIds[nodeId];
    });
    if (selectionAnchor && !selectedIds[selectionAnchor]) selectionAnchor = null;
  }

  function makeRow(kind, node, depth, hasChildren) {
    var row = document.createElement('div');
    row.className = 'music-tree-row music-tree-' + kind;
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-selected', selectedIds[node.id] ? 'true' : 'false');
    row.dataset.nodeId = node.id;
    row.dataset.nodeKind = kind;
    row.style.setProperty('--music-tree-depth', depth);

    if (kind === 'folder') {
      row.setAttribute('aria-expanded', expandedIds[node.id] ? 'true' : 'false');
      var toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'music-tree-toggle';
      toggle.textContent = expandedIds[node.id] ? 'v' : '>';
      toggle.disabled = !hasChildren;
      toggle.addEventListener('click', function (ev) {
        ev.stopPropagation();
        expandedIds[node.id] = !expandedIds[node.id];
        renderLibrary();
      });
      row.appendChild(toggle);
    } else {
      var spacer = document.createElement('span');
      spacer.className = 'music-tree-spacer';
      row.appendChild(spacer);
    }

    var name = document.createElement('span');
    name.className = 'music-tree-name';
    name.textContent = node.display_name || node.rel_path || '';
    row.appendChild(name);

    if (kind === 'folder' && node.listing_cached === false) {
      var badge = document.createElement('span');
      badge.className = 'music-tree-badge';
      badge.textContent = node.metadata_cached ? 'files cached' : 'not cached';
      row.appendChild(badge);
    }

    row.addEventListener('click', function (ev) {
      selectNode(node.id, ev);
    });
    if (kind === 'song') {
      row.addEventListener('dblclick', function () {
        addSongToPlaylistAndPlay(node);
      });
    }
    row.addEventListener('contextmenu', function (ev) {
      openLibraryContextMenu(ev, node.id, kind);
    });
    return row;
  }

  function selectNode(nodeId, ev) {
    var index;
    var start;
    var end;

    if (ev.shiftKey && selectionAnchor) {
      index = visibleNodeIds.indexOf(nodeId);
      start = visibleNodeIds.indexOf(selectionAnchor);
      if (index !== -1 && start !== -1) {
        clearObject(selectedIds);
        visibleNodeIds.slice(Math.min(start, index), Math.max(start, index) + 1).forEach(function (id) {
          selectedIds[id] = true;
        });
      }
    } else if (ev.ctrlKey || ev.metaKey) {
      if (selectedIds[nodeId]) delete selectedIds[nodeId];
      else selectedIds[nodeId] = true;
      selectionAnchor = nodeId;
    } else {
      clearObject(selectedIds);
      selectedIds[nodeId] = true;
      selectionAnchor = nodeId;
    }
    renderSelection();
  }

  function renderSelection() {
    Array.prototype.forEach.call(treeEl.querySelectorAll('.music-tree-row'), function (row) {
      row.classList.toggle('selected', !!selectedIds[row.dataset.nodeId]);
      row.setAttribute('aria-selected', selectedIds[row.dataset.nodeId] ? 'true' : 'false');
    });
    pane.dataset.librarySelectionCount = String(selectedCount());
  }

  function hideLibraryContextMenu() {
    if (!libraryMenu) return;
    libraryMenu.hidden = true;
    libraryMenu.classList.add('hidden');
    contextNodeId = null;
  }

  function hidePlaylistContextMenu() {
    if (!playlistMenu) return;
    playlistMenu.hidden = true;
    playlistMenu.classList.add('hidden');
    playlistContextRemotePath = null;
  }

  function openLibraryContextMenu(ev, nodeId, kind) {
    ev.preventDefault();
    if (!selectedIds[nodeId]) {
      clearObject(selectedIds);
      selectedIds[nodeId] = true;
      selectionAnchor = nodeId;
      renderSelection();
    }
    contextNodeId = nodeId;
    if (!libraryMenu) return;
    libraryMenu.style.left = ev.clientX + 'px';
    libraryMenu.style.top = ev.clientY + 'px';
    libraryMenu.hidden = false;
    libraryMenu.classList.remove('hidden');
  }

  function songsUnderFolder(folderId) {
    if (!librarySnapshot) return [];
    var foldersByParent = indexByParent(librarySnapshot.folders || []);
    var songsByParent = indexByParent(librarySnapshot.songs || []);
    var songs = [];

    function collect(parentId) {
      (songsByParent[parentId] || []).forEach(function (song) {
        songs.push(song);
      });
      (foldersByParent[parentId] || []).forEach(function (folder) {
        collect(folder.id);
      });
    }

    collect(folderId);
    return songs;
  }

  function selectedSongsForPlaylist() {
    var nodes = libraryNodesById();
    var songsByRemotePath = Object.create(null);
    Object.keys(selectedIds).forEach(function (nodeId) {
      var node = nodes[nodeId];
      if (!node) return;
      if (nodeId.indexOf('song:') === 0) {
        songsByRemotePath[node.remote_path] = node;
      } else {
        songsUnderFolder(nodeId).forEach(function (song) {
          songsByRemotePath[song.remote_path] = song;
        });
      }
    });
    return Object.keys(songsByRemotePath).map(function (remotePath) {
      return songsByRemotePath[remotePath];
    });
  }

  function addSongsToPlaylist(songs) {
    var added = 0;
    songs.forEach(function (song) {
      if (!song.remote_path || playlistRemotePaths[song.remote_path]) return;
      playlistRemotePaths[song.remote_path] = true;
      playlist.push({
        display_name: song.display_name,
        rel_path: song.rel_path,
        remote_path: song.remote_path,
        stream_path: song.stream_path
      });
      added += 1;
    });
    if (added) resetShuffleBag();
    renderPlaylist();
    setStatus(added ? 'Added ' + added + ' cached song' + (added === 1 ? '' : 's') + ' to playlist.' : 'No new cached songs to add.');
  }

  function focusPlaylistRemotePath(remotePath) {
    var rows;
    var target = null;
    if (!playlistListEl || !remotePath) return;
    rows = playlistListEl.querySelectorAll('.music-playlist-entry');
    Array.prototype.forEach.call(rows, function (row) {
      if (!target && row.dataset.remotePath === remotePath) target = row;
    });
    if (!target) return;
    if (typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({block: 'nearest'});
    }
  }

  function playlistIndexByRemotePath(remotePath) {
    for (var i = 0; i < playlist.length; i += 1) {
      if (playlist[i].remote_path === remotePath) return i;
    }
    return -1;
  }

  function playlistSelectedCount() {
    return Object.keys(selectedPlaylistRemotePaths).length;
  }

  function streamUrl(song) {
    return '/file?path=' + encodeURIComponent(song.stream_path) + '&source=remote';
  }

  function resetShuffleBag() {
    shuffleBag = [];
  }

  function shuffleBagIndex() {
    var available = [];
    playlist.forEach(function (_song, index) {
      if (index !== currentPlaylistIndex || playlist.length === 1) available.push(index);
    });
    shuffleBag = shuffleBag.filter(function (index) {
      return index >= 0 && index < playlist.length && available.indexOf(index) !== -1;
    });
    if (shuffleBag.length === 0) {
      shuffleBag = available.slice();
    }
    if (shuffleBag.length === 0) return -1;
    var bagOffset = Math.floor(Math.random() * shuffleBag.length);
    var next = shuffleBag[bagOffset];
    shuffleBag.splice(bagOffset, 1);
    return next;
  }

  function currentSong() {
    return playlist[currentPlaylistIndex] || null;
  }

  function setPlaybackStatus(message) {
    pane.dataset.playbackStatus = message || '';
    if (message) setStatus(message);
  }

  function clearCurrentSong() {
    currentPlaylistIndex = -1;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    if (currentFilenameEl) currentFilenameEl.textContent = 'No song selected';
    setPlaybackStatus('');
  }

  function playPlaylistIndex(index) {
    var song = playlist[index];
    if (!song) {
      clearCurrentSong();
      renderPlaylist();
      return;
    }
    currentPlaylistIndex = index;
    shuffleBag = shuffleBag.filter(function (bagIndex) { return bagIndex !== index; });
    if (currentFilenameEl) currentFilenameEl.textContent = song.display_name || 'Unknown song';
    setPlaybackStatus('');
    if (audio) {
      audio.src = streamUrl(song);
      var playPromise = audio.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(function (err) {
          setPlaybackStatus((err && err.message) || 'Browser blocked playback until user interaction.');
        });
      }
    }
    renderPlaylist();
  }

  function playCurrentOrFirst() {
    if (currentSong()) {
      if (audio) {
        var playPromise = audio.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch(function (err) {
            setPlaybackStatus((err && err.message) || 'Browser blocked playback until user interaction.');
          });
        }
      }
      return;
    }
    if (playlist.length > 0) playPlaylistIndex(0);
  }

  function pausePlayback() {
    if (audio) audio.pause();
  }

  function nextPlaylistIndex() {
    if (playlist.length === 0) return -1;
    if (shuffleEnabled) return shuffleBagIndex();
    if (currentPlaylistIndex < 0) return 0;
    if (currentPlaylistIndex + 1 < playlist.length) return currentPlaylistIndex + 1;
    if (loopPlaylist) return 0;
    return -1;
  }

  function previousPlaylistIndex() {
    if (playlist.length === 0) return -1;
    if (currentPlaylistIndex <= 0) return loopPlaylist ? playlist.length - 1 : 0;
    return currentPlaylistIndex - 1;
  }

  function playNextSong() {
    var index = nextPlaylistIndex();
    if (index === -1) {
      clearCurrentSong();
      return;
    }
    playPlaylistIndex(index);
  }

  function playPreviousSong() {
    var index = previousPlaylistIndex();
    if (index !== -1) playPlaylistIndex(index);
  }

  function playPlaylistRemotePath(remotePath) {
    var index = playlistIndexByRemotePath(remotePath);
    if (index !== -1) playPlaylistIndex(index);
  }

  function addSongToPlaylistAndPlay(song) {
    if (!song || !song.remote_path) return;
    addSongsToPlaylist([song]);
    clearObject(selectedPlaylistRemotePaths);
    selectedPlaylistRemotePaths[song.remote_path] = true;
    playlistSelectionAnchor = song.remote_path;
    renderPlaylistSelection();
    focusPlaylistRemotePath(song.remote_path);
    playPlaylistRemotePath(song.remote_path);
  }

  function selectPlaylistRemotePath(remotePath, ev) {
    var index;
    var start;
    var remotePaths = playlist.map(function (song) { return song.remote_path; });
    if (ev.shiftKey && playlistSelectionAnchor) {
      index = remotePaths.indexOf(remotePath);
      start = remotePaths.indexOf(playlistSelectionAnchor);
      if (index !== -1 && start !== -1) {
        clearObject(selectedPlaylistRemotePaths);
        remotePaths.slice(Math.min(start, index), Math.max(start, index) + 1).forEach(function (path) {
          selectedPlaylistRemotePaths[path] = true;
        });
      }
    } else if (ev.ctrlKey || ev.metaKey) {
      if (selectedPlaylistRemotePaths[remotePath]) delete selectedPlaylistRemotePaths[remotePath];
      else selectedPlaylistRemotePaths[remotePath] = true;
      playlistSelectionAnchor = remotePath;
    } else {
      clearObject(selectedPlaylistRemotePaths);
      selectedPlaylistRemotePaths[remotePath] = true;
      playlistSelectionAnchor = remotePath;
    }
    renderPlaylistSelection();
  }

  function renderPlaylistSelection() {
    if (!playlistListEl) return;
    Array.prototype.forEach.call(playlistListEl.querySelectorAll('.music-playlist-entry'), function (row) {
      var selected = !!selectedPlaylistRemotePaths[row.dataset.remotePath];
      row.classList.toggle('selected', selected);
      row.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
    pane.dataset.playlistSelectionCount = String(playlistSelectedCount());
  }

  function openPlaylistContextMenu(ev, remotePath) {
    ev.preventDefault();
    if (!selectedPlaylistRemotePaths[remotePath]) {
      clearObject(selectedPlaylistRemotePaths);
      selectedPlaylistRemotePaths[remotePath] = true;
      playlistSelectionAnchor = remotePath;
      renderPlaylistSelection();
    }
    playlistContextRemotePath = remotePath;
    if (!playlistMenu) return;
    playlistMenu.style.left = ev.clientX + 'px';
    playlistMenu.style.top = ev.clientY + 'px';
    playlistMenu.hidden = false;
    playlistMenu.classList.remove('hidden');
  }

  function removeSelectedPlaylistSongs() {
    var currentSong = playlist[currentPlaylistIndex] || null;
    var currentRemotePath = currentSong ? currentSong.remote_path : null;
    var removedCurrent = !!(currentRemotePath && selectedPlaylistRemotePaths[currentRemotePath]);
    var oldCurrentIndex = currentPlaylistIndex;

    playlist = playlist.filter(function (song) {
      if (!selectedPlaylistRemotePaths[song.remote_path]) return true;
      delete playlistRemotePaths[song.remote_path];
      return false;
    });
    resetShuffleBag();
    clearObject(selectedPlaylistRemotePaths);
    playlistSelectionAnchor = null;

    if (removedCurrent) {
      if (playlist.length > 0) playPlaylistIndex(Math.min(oldCurrentIndex, playlist.length - 1));
      else clearCurrentSong();
    } else if (currentRemotePath) {
      currentPlaylistIndex = playlistIndexByRemotePath(currentRemotePath);
    }
    renderPlaylist();
  }

  function updateModeButtons() {
    if (shuffleButton) {
      shuffleButton.setAttribute('aria-pressed', shuffleEnabled ? 'true' : 'false');
      shuffleButton.textContent = shuffleEnabled ? 'Shuffle' : 'Order';
    }
    if (loopButton) {
      loopButton.setAttribute('aria-pressed', loopPlaylist ? 'true' : 'false');
      loopButton.textContent = loopPlaylist ? 'Loop On' : 'Loop';
    }
  }

  function toggleShuffle() {
    shuffleEnabled = !shuffleEnabled;
    resetShuffleBag();
    updateModeButtons();
  }

  function toggleLoopPlaylist() {
    loopPlaylist = !loopPlaylist;
    updateModeButtons();
  }

  function renderPlaylist() {
    if (!playlistListEl) return;
    playlistListEl.textContent = '';
    if (playlist.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'music-empty-state';
      empty.textContent = 'Playlist is empty.';
      playlistListEl.appendChild(empty);
      return;
    }
    playlist.forEach(function (song, index) {
      var row = document.createElement('div');
      row.className = 'music-playlist-row music-playlist-entry';
      row.setAttribute('role', 'row');
      row.setAttribute('aria-selected', selectedPlaylistRemotePaths[song.remote_path] ? 'true' : 'false');
      row.dataset.remotePath = song.remote_path;
      row.dataset.streamPath = song.stream_path;
      if (selectedPlaylistRemotePaths[song.remote_path]) row.classList.add('selected');
      if (index === currentPlaylistIndex) row.classList.add('current');

      var nameCell = document.createElement('div');
      nameCell.setAttribute('role', 'cell');
      nameCell.textContent = song.display_name || '';
      row.appendChild(nameCell);

      var pathCell = document.createElement('div');
      pathCell.setAttribute('role', 'cell');
      pathCell.textContent = song.rel_path || '';
      row.appendChild(pathCell);
      row.addEventListener('click', function (ev) {
        selectPlaylistRemotePath(song.remote_path, ev);
      });
      row.addEventListener('dblclick', function () {
        playPlaylistRemotePath(song.remote_path);
      });
      row.addEventListener('contextmenu', function (ev) {
        openPlaylistContextMenu(ev, song.remote_path);
      });
      playlistListEl.appendChild(row);
    });
    renderPlaylistSelection();
  }

  function renderLibrary() {
    var snapshot = librarySnapshot;
    var scrollTop = treeEl.scrollTop;
    visibleNodeIds = [];
    treeEl.textContent = '';

    if (!snapshot) {
      var empty = document.createElement('div');
      empty.className = 'music-empty-state';
      empty.textContent = 'Load the current folder library to show cached songs.';
      treeEl.appendChild(empty);
      return;
    }

    pruneSelectedIds(snapshot);

    var foldersByParent = indexByParent(snapshot.folders || []);
    var songsByParent = indexByParent(snapshot.songs || []);

    function appendChildren(parent, depth) {
      (foldersByParent[parent.id] || []).forEach(function (folder) {
        var childFolders = foldersByParent[folder.id] || [];
        var childSongs = songsByParent[folder.id] || [];
        var hasChildren = childFolders.length > 0 || childSongs.length > 0;
        visibleNodeIds.push(folder.id);
        treeEl.appendChild(makeRow('folder', folder, depth, hasChildren));
        if (expandedIds[folder.id]) appendChildren(folder, depth + 1);
      });
      (songsByParent[parent.id] || []).forEach(function (song) {
        visibleNodeIds.push(song.id);
        treeEl.appendChild(makeRow('song', song, depth, false));
      });
    }

    expandedIds[snapshot.root.id] = true;
    visibleNodeIds.push(snapshot.root.id);
    treeEl.appendChild(makeRow('folder', snapshot.root, 0, true));
    appendChildren(snapshot.root, 1);

    if (visibleNodeIds.length === 1 && (!snapshot.songs || snapshot.songs.length === 0)) {
      var noSongs = document.createElement('div');
      noSongs.className = 'music-empty-state';
      noSongs.textContent = 'No supported cached songs found in this folder yet.';
      treeEl.appendChild(noSongs);
    }

    renderSelection();
    treeEl.scrollTop = scrollTop;
  }

  function applyLibrarySnapshot(data) {
    var fingerprint = libraryFingerprint(data);
    if (fingerprint && fingerprint === lastLibraryFingerprint) {
      pollDelayMs *= 2;
    } else {
      pollDelayMs = defaultPollDelayMs;
      lastLibraryFingerprint = fingerprint;
    }
    librarySnapshot = data;
    if (data.root && data.root.id && expandedIds[data.root.id] === undefined) {
      expandedIds[data.root.id] = true;
    }
    setStatus(escStatus(data.status));
    renderLibrary();
  }

  function fetchLibrary(isRefresh) {
    if (loading) return;
    loading = true;
    loadButton.disabled = true;
    if (!isRefresh) setStatus('Loading cached song library...');
    fetch(libraryUrl())
      .then(function (response) {
        if (!response.ok) throw new Error('Library request failed with HTTP ' + response.status);
        return response.json();
      })
      .then(function (data) {
        applyLibrarySnapshot(data);
      })
      .catch(function (err) {
        setStatus(err.message || 'Could not load cached song library.');
      })
      .then(function () {
        loading = false;
        loadButton.disabled = false;
        schedulePoll();
      });
  }

  function resetLibraryForCurrentFolder() {
    libraryRoot = currentFolder;
    libraryRequested = false;
    librarySnapshot = null;
    lastLibraryFingerprint = '';
    pollDelayMs = defaultPollDelayMs;
    selectionAnchor = null;
    clearObject(expandedIds);
    clearObject(selectedIds);
    setStatus('Library not loaded.');
    stopPolling();
    renderLibrary();
  }

  loadButton.addEventListener('click', function () {
    libraryRoot = currentFolder;
    libraryRequested = true;
    fetchLibrary(false);
  });

  if (libraryMenu) {
    libraryMenu.addEventListener('click', function (ev) {
      var action = ev.target && ev.target.getAttribute('data-action');
      if (action === 'add-selected') addSongsToPlaylist(selectedSongsForPlaylist());
      hideLibraryContextMenu();
    });
  }

  if (playlistMenu) {
    playlistMenu.addEventListener('click', function (ev) {
      var action = ev.target && ev.target.getAttribute('data-action');
      if (action === 'play') playPlaylistRemotePath(playlistContextRemotePath || Object.keys(selectedPlaylistRemotePaths)[0]);
      if (action === 'remove') removeSelectedPlaylistSongs();
      hidePlaylistContextMenu();
    });
  }

  if (playButton) playButton.addEventListener('click', playCurrentOrFirst);
  if (pauseButton) pauseButton.addEventListener('click', pausePlayback);
  if (nextButton) nextButton.addEventListener('click', playNextSong);
  if (prevButton) prevButton.addEventListener('click', playPreviousSong);
  if (shuffleButton) shuffleButton.addEventListener('click', toggleShuffle);
  if (loopButton) loopButton.addEventListener('click', toggleLoopPlaylist);
  if (audio) {
    audio.addEventListener('ended', playNextSong);
    audio.addEventListener('error', function () {
      setPlaybackStatus('Could not play this audio file.');
    });
  }

  document.addEventListener('click', function () {
    hideLibraryContextMenu();
    hidePlaylistContextMenu();
  });
  window.addEventListener('blur', function () {
    hideLibraryContextMenu();
    hidePlaylistContextMenu();
  });

  window.addEventListener('bottom-pane-mode-changed', function (ev) {
    if (!ev.detail) return;
    if (ev.detail.mode === 'music-player') schedulePoll();
    else stopPolling();
  });

  window.addEventListener('beforeunload', stopPolling);
  resetLibraryForCurrentFolder();
  updateModeButtons();
  renderPlaylist();
}());
