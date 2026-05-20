(function () {
  var pane = document.getElementById('music-player-pane');
  if (!pane) return;

  var loadButton = document.getElementById('music-library-load');
  var statusEl = document.getElementById('music-library-status');
  var treeEl = document.getElementById('music-library-tree');
  var controls = pane.querySelector('.music-player-controls');
  var currentFolder = document.body.dataset.currentFolderPath || '';
  var pollDelayMs = 4000;
  var pollTimer = null;
  var libraryRequested = false;
  var loading = false;
  var libraryRoot = currentFolder;
  var librarySnapshot = null;
  var expandedIds = Object.create(null);
  var selectedIds = Object.create(null);
  var visibleNodeIds = [];
  var selectionAnchor = null;

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
      badge.textContent = 'not cached';
      row.appendChild(badge);
    }

    row.addEventListener('click', function (ev) {
      selectNode(node.id, ev);
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

  window.addEventListener('bottom-pane-mode-changed', function (ev) {
    if (!ev.detail) return;
    if (ev.detail.mode === 'music-player') schedulePoll();
    else stopPolling();
  });

  window.addEventListener('beforeunload', stopPolling);
  resetLibraryForCurrentFolder();
}());
