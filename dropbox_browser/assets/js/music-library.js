import {clearObject, itemCount, plural} from './music-shared.js';

export function initLibrary(ctx) {
  var els = ctx.els;
  var state = ctx.state;

  function updateLoadButtonTimer() {
    var elapsedSeconds = 0;
    if (!state.libraryPollingActive) {
      els.loadButton.textContent = state.loadButtonDefaultText;
      return;
    }
    if (state.lastLibraryPollResponseAt) {
      elapsedSeconds = Math.floor((Date.now() - state.lastLibraryPollResponseAt) / 1000);
    }
    els.loadButton.textContent = state.loadButtonDefaultText + ' (' + elapsedSeconds + ')';
  }

  function startLibraryPollingUi() {
    state.libraryPollingActive = true;
    state.lastLibraryPollResponseAt = Date.now();
    els.loadButton.disabled = true;
    updateLoadButtonTimer();
    if (state.loadTimer !== null) window.clearInterval(state.loadTimer);
    state.loadTimer = window.setInterval(updateLoadButtonTimer, 1000);
  }

  function stopLibraryPollingUi() {
    state.libraryPollingActive = false;
    if (state.loadTimer !== null) {
      window.clearInterval(state.loadTimer);
      state.loadTimer = null;
    }
    els.loadButton.disabled = false;
    els.loadButton.textContent = state.loadButtonDefaultText;
  }

  function libraryUrl(isRefresh, scheduledDelayMs) {
    state.libraryPollSequence += 1;
    return '/music/endpoints/library?path=' + encodeURIComponent(state.libraryRoot) +
      '&poll_seq=' + encodeURIComponent(String(state.libraryPollSequence)) +
      '&poll_delay_ms=' + encodeURIComponent(String(scheduledDelayMs || 0)) +
      '&poll_refresh=' + (isRefresh ? '1' : '0');
  }

  function stopPolling() {
    if (state.pollTimer !== null) {
      window.clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function shouldPollLibrary() {
    return !(state.librarySnapshot && state.librarySnapshot.status && state.librarySnapshot.status.complete);
  }

  function schedulePoll() {
    var scheduledDelayMs;
    stopPolling();
    if (!state.libraryRequested || !ctx.layoutApi.playbackUiMayPaint()) return;
    if (!shouldPollLibrary()) return;
    scheduledDelayMs = state.defaultPollDelayMs;
    state.pollTimer = window.setTimeout(function () {
      fetchLibrary(true, scheduledDelayMs);
    }, scheduledDelayMs);
  }

  function libraryNameSortKey(name) {
    return String(name || '').toLowerCase();
  }

  function compareLibraryNames(left, right) {
    var leftKey = libraryNameSortKey(left && left.display_name);
    var rightKey = libraryNameSortKey(right && right.display_name);
    if (leftKey < rightKey) return -1;
    if (leftKey > rightKey) return 1;
    leftKey = String((left && left.display_name) || '');
    rightKey = String((right && right.display_name) || '');
    if (leftKey < rightKey) return -1;
    if (leftKey > rightKey) return 1;
    return 0;
  }

  function indexByParent(items) {
    var map = Object.create(null);
    items.forEach(function (item) {
      var key = item.parent_id || '';
      if (!map[key]) map[key] = [];
      map[key].push(item);
    });
    Object.keys(map).forEach(function (key) {
      map[key].sort(compareLibraryNames);
    });
    return map;
  }

  function libraryNodesById() {
    var nodes = Object.create(null);
    if (!state.librarySnapshot) return nodes;
    if (state.librarySnapshot.root) nodes[state.librarySnapshot.root.id] = state.librarySnapshot.root;
    (state.librarySnapshot.folders || []).forEach(function (folder) {
      nodes[folder.id] = folder;
    });
    (state.librarySnapshot.songs || []).forEach(function (song) {
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
    Object.keys(state.selectedIds).forEach(function (nodeId) {
      if (!nodeStillExists(snapshot, nodeId)) delete state.selectedIds[nodeId];
    });
    if (state.selectionAnchor && !state.selectedIds[state.selectionAnchor]) state.selectionAnchor = null;
  }

  function makeRow(kind, node, depth, hasChildren) {
    var row = document.createElement('div');
    row.className = 'music-tree-row music-tree-' + kind;
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-selected', state.selectedIds[node.id] ? 'true' : 'false');
    row.dataset.nodeId = node.id;
    row.dataset.nodeKind = kind;
    row.style.setProperty('--music-tree-depth', depth);

    if (kind === 'folder') {
      row.setAttribute('aria-expanded', state.expandedIds[node.id] ? 'true' : 'false');
      var toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'music-tree-toggle';
      toggle.textContent = state.expandedIds[node.id] ? 'v' : '>';
      toggle.disabled = !hasChildren;
      toggle.addEventListener('click', function (ev) {
        ev.stopPropagation();
        state.expandedIds[node.id] = !state.expandedIds[node.id];
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
        ctx.playlistApi.addSongToPlaylistAndPlay(node);
      });
    }
    row.addEventListener('contextmenu', function (ev) {
      openLibraryContextMenu(ev, node.id, kind);
    });
    return row;
  }

  function selectedCount() {
    return Object.keys(state.selectedIds).length;
  }

  function selectNode(nodeId, ev) {
    var index;
    var start;
    var end;

    if (els.treeEl && document.activeElement !== els.treeEl) els.treeEl.focus();

    if (ev.shiftKey && state.selectionAnchor) {
      index = state.visibleNodeIds.indexOf(nodeId);
      start = state.visibleNodeIds.indexOf(state.selectionAnchor);
      if (index !== -1 && start !== -1) {
        clearObject(state.selectedIds);
        state.visibleNodeIds.slice(Math.min(start, index), Math.max(start, index) + 1).forEach(function (id) {
          state.selectedIds[id] = true;
        });
      }
    } else if (ev.ctrlKey || ev.metaKey) {
      if (state.selectedIds[nodeId]) delete state.selectedIds[nodeId];
      else state.selectedIds[nodeId] = true;
      state.selectionAnchor = nodeId;
    } else {
      clearObject(state.selectedIds);
      state.selectedIds[nodeId] = true;
      state.selectionAnchor = nodeId;
    }
    renderSelection();
  }

  function renderSelection() {
    Array.prototype.forEach.call(els.treeEl.querySelectorAll('.music-tree-row'), function (row) {
      row.classList.toggle('selected', !!state.selectedIds[row.dataset.nodeId]);
      row.setAttribute('aria-selected', state.selectedIds[row.dataset.nodeId] ? 'true' : 'false');
    });
    ctx.pane.dataset.librarySelectionCount = String(selectedCount());
  }

  function primarySelectedLibraryNodeId() {
    if (state.selectionAnchor && state.selectedIds[state.selectionAnchor]) return state.selectionAnchor;
    return Object.keys(state.selectedIds)[0] || null;
  }

  function selectAllVisibleLibraryNodes() {
    clearObject(state.selectedIds);
    state.visibleNodeIds.forEach(function (nodeId) {
      state.selectedIds[nodeId] = true;
    });
    if (!state.selectedIds[state.selectionAnchor]) state.selectionAnchor = state.visibleNodeIds[0] || null;
    renderSelection();
  }

  function selectVisibleLibrarySiblingsOfCurrentSelection() {
    var nodes = libraryNodesById();
    var primaryNodeId = primarySelectedLibraryNodeId();
    var primaryNode = primaryNodeId ? nodes[primaryNodeId] : null;
    var parentId;
    if (!primaryNode) {
      selectAllVisibleLibraryNodes();
      return;
    }
    parentId = primaryNode.parent_id || '';
    clearObject(state.selectedIds);
    state.visibleNodeIds.forEach(function (nodeId) {
      var node = nodes[nodeId];
      if (node && (node.parent_id || '') === parentId) state.selectedIds[nodeId] = true;
    });
    state.selectionAnchor = primaryNodeId;
    renderSelection();
  }

  function handleLibrarySelectAllShortcut(ev) {
    if (!(ev.ctrlKey || ev.metaKey) || ev.shiftKey || ev.altKey) return;
    if (String(ev.key || '').toLowerCase() !== 'a') return;
    ev.preventDefault();
    performLibrarySelectAll();
  }

  function performLibrarySelectAll() {
    if (els.treeEl && document.activeElement !== els.treeEl) els.treeEl.focus();
    if (selectedCount() === 0) {
      selectAllVisibleLibraryNodes();
      return;
    }
    selectVisibleLibrarySiblingsOfCurrentSelection();
  }

  function hideLibraryContextMenu() {
    if (!els.libraryMenu) return;
    els.libraryMenu.hidden = true;
    els.libraryMenu.classList.add('hidden');
    state.contextNodeId = null;
  }

  function openLibraryContextMenu(ev, nodeId, kind) {
    ev.preventDefault();
    if (!state.selectedIds[nodeId]) {
      clearObject(state.selectedIds);
      state.selectedIds[nodeId] = true;
      state.selectionAnchor = nodeId;
      renderSelection();
    }
    state.contextNodeId = nodeId;
    if (!els.libraryMenu) return;
    els.libraryMenu.style.left = ev.clientX + 'px';
    els.libraryMenu.style.top = ev.clientY + 'px';
    els.libraryMenu.hidden = false;
    els.libraryMenu.classList.remove('hidden');
  }

  function songsUnderFolder(folderId) {
    if (!state.librarySnapshot) return [];
    var foldersByParent = indexByParent(state.librarySnapshot.folders || []);
    var songsByParent = indexByParent(state.librarySnapshot.songs || []);
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
    Object.keys(state.selectedIds).forEach(function (nodeId) {
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

  function paintLibrary() {
    var snapshot = state.librarySnapshot;
    var scrollTop = els.treeEl.scrollTop;
    state.libraryRenderDirty = false;
    state.visibleNodeIds = [];
    els.treeEl.textContent = '';

    if (!snapshot) {
      var empty = document.createElement('div');
      empty.className = 'music-empty-state';
      empty.textContent = 'Load the current folder to show cached songs.';
      els.treeEl.appendChild(empty);
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
        state.visibleNodeIds.push(folder.id);
        els.treeEl.appendChild(makeRow('folder', folder, depth, hasChildren));
        if (state.expandedIds[folder.id]) appendChildren(folder, depth + 1);
      });
      (songsByParent[parent.id] || []).forEach(function (song) {
        state.visibleNodeIds.push(song.id);
        els.treeEl.appendChild(makeRow('song', song, depth, false));
      });
    }

    state.expandedIds[snapshot.root.id] = true;
    state.visibleNodeIds.push(snapshot.root.id);
    els.treeEl.appendChild(makeRow('folder', snapshot.root, 0, true));
    appendChildren(snapshot.root, 1);

    if (state.visibleNodeIds.length === 1 && (!snapshot.songs || snapshot.songs.length === 0)) {
      var noSongs = document.createElement('div');
      noSongs.className = 'music-empty-state';
      noSongs.textContent = 'No supported cached songs found in this folder yet.';
      els.treeEl.appendChild(noSongs);
    }

    renderSelection();
    els.treeEl.scrollTop = scrollTop;
  }

  function renderLibrary() {
    state.libraryRenderDirty = true;
    if (!ctx.layoutApi.playbackUiMayPaint()) return;
    paintLibrary();
  }

  function applyLibrarySnapshot(data) {
    var previousSnapshot = state.librarySnapshot;
    state.librarySnapshot = data;
    if (data.root && data.root.id && state.expandedIds[data.root.id] === undefined) {
      state.expandedIds[data.root.id] = true;
    }
    ctx.setLibraryStatus(libraryPollingMessage(data, previousSnapshot));
    renderLibrary();
  }

  function escStatus(status) {
    if (!status) return 'Library status unavailable.';
    var message = status.message || '';
    var count = status.missing_folder_count || status.missing_listing_count || 0;
    if (status.cache_status === 'complete') return 'Complete cached library.';
    if (status.cache_status === 'unavailable') return message || 'No cached folder metadata is available for this folder yet.';
    if (count) return (message || 'Library may update as cached metadata arrives.') + ' Missing cached folders: ' + count + '.';
    return message || 'Library may update as cached metadata arrives.';
  }

  function libraryPollingMessage(data, previousSnapshot) {
    var status = data.status || {};
    var songCount = itemCount(data, 'songs');
    var folderCount = itemCount(data, 'folders');
    var previousSongCount = itemCount(previousSnapshot, 'songs');
    var previousFolderCount = itemCount(previousSnapshot, 'folders');
    var addedSongs = Math.max(0, songCount - previousSongCount);
    var addedFolders = Math.max(0, folderCount - previousFolderCount);
    var pendingFolders = status.pending_folder_count || 0;
    var missingFolders = status.missing_folder_count || status.missing_listing_count || 0;
    var seq = state.libraryPollSequence ? 'Poll #' + state.libraryPollSequence + ': ' : '';
    if (status.complete) {
      return 'Loaded ' + plural(songCount, 'song', 'songs') + ' and ' + plural(folderCount, 'folder', 'folders') + '.';
    }
    return seq +
      '+' + plural(addedSongs, 'song', 'songs') + ', +' + plural(addedFolders, 'folder', 'folders') +
      ' loaded this response. Totals: ' + plural(songCount, 'song', 'songs') + ', ' +
      plural(folderCount, 'folder', 'folders') + '. Remaining: ' +
      plural(pendingFolders, 'pending folder', 'pending folders') + ', ' +
      plural(missingFolders, 'missing cache record', 'missing cache records') + '. ' +
      escStatus(status);
  }

  function fetchLibrary(isRefresh, scheduledDelayMs) {
    var requestFailed = false;
    if (state.loading) return;
    state.loading = true;
    els.loadButton.disabled = true;
    if (!isRefresh) ctx.setLibraryStatus('Loading cached song library...');
    fetch(libraryUrl(isRefresh, scheduledDelayMs))
      .then(function (response) {
        if (!response.ok) throw new Error('Library request failed with HTTP ' + response.status);
        return response.json();
      })
      .then(function (data) {
        state.lastLibraryPollResponseAt = Date.now();
        updateLoadButtonTimer();
        applyLibrarySnapshot(data);
      })
      .catch(function (err) {
        requestFailed = true;
        stopLibraryPollingUi();
        ctx.setLibraryStatus(err.message || 'Could not load cached song library.');
      })
      .then(function () {
        state.loading = false;
        if (requestFailed) return;
        if (shouldPollLibrary()) {
          els.loadButton.disabled = state.libraryPollingActive;
          schedulePoll();
        } else {
          stopLibraryPollingUi();
        }
      });
  }

  function resetLibraryForCurrentFolder() {
    state.libraryRoot = state.currentFolder;
    state.libraryRequested = false;
    state.librarySnapshot = null;
    state.libraryPollSequence = 0;
    state.selectionAnchor = null;
    clearObject(state.expandedIds);
    clearObject(state.selectedIds);
    ctx.setLibraryStatus('Library not loaded.');
    stopPolling();
    stopLibraryPollingUi();
    renderLibrary();
  }

  ctx.libraryApi = {
    applyLibrarySnapshot: applyLibrarySnapshot,
    compareLibraryNames: compareLibraryNames,
    fetchLibrary: fetchLibrary,
    handleLibrarySelectAllShortcut: handleLibrarySelectAllShortcut,
    hideLibraryContextMenu: hideLibraryContextMenu,
    libraryNameSortKey: libraryNameSortKey,
    libraryNodesById: libraryNodesById,
    libraryPollingMessage: libraryPollingMessage,
    makeRow: makeRow,
    nodeStillExists: nodeStillExists,
    openLibraryContextMenu: openLibraryContextMenu,
    paintLibrary: paintLibrary,
    performLibrarySelectAll: performLibrarySelectAll,
    primarySelectedLibraryNodeId: primarySelectedLibraryNodeId,
    pruneSelectedIds: pruneSelectedIds,
    renderLibrary: renderLibrary,
    renderSelection: renderSelection,
    resetLibraryForCurrentFolder: resetLibraryForCurrentFolder,
    schedulePoll: schedulePoll,
    selectedSongsForPlaylist: selectedSongsForPlaylist,
    selectAllVisibleLibraryNodes: selectAllVisibleLibraryNodes,
    selectVisibleLibrarySiblingsOfCurrentSelection: selectVisibleLibrarySiblingsOfCurrentSelection,
    shouldPollLibrary: shouldPollLibrary,
    songsUnderFolder: songsUnderFolder,
    startLibraryPollingUi: startLibraryPollingUi,
    stopLibraryPollingUi: stopLibraryPollingUi,
    stopPolling: stopPolling,
    updateLoadButtonTimer: updateLoadButtonTimer
  };

  els.loadButton.addEventListener('click', function () {
    state.libraryRoot = state.currentFolder;
    state.libraryRequested = true;
    state.librarySnapshot = null;
    state.libraryPollSequence = 0;
    startLibraryPollingUi();
    fetchLibrary(false, 0);
  });

  if (els.libraryMenu) {
    els.libraryMenu.addEventListener('click', function (ev) {
      var action = ev.target && ev.target.getAttribute('data-action');
      if (action === 'add-selected') ctx.playlistApi.addSongsToPlaylist(selectedSongsForPlaylist());
      if (action === 'select-all') performLibrarySelectAll();
      hideLibraryContextMenu();
    });
  }
  if (els.treeEl) els.treeEl.addEventListener('keydown', handleLibrarySelectAllShortcut);
}
