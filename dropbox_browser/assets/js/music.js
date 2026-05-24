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
  var songTitleEl = document.getElementById('music-song-title');
  var songArtistEl = document.getElementById('music-song-artist');
  var coverArtEl = document.getElementById('music-cover-art');
  var artPlaceholderEl = document.getElementById('music-art-placeholder');
  var progressSlider = document.getElementById('music-progress-slider');
  var elapsedTimeEl = document.getElementById('music-elapsed-time');
  var totalTimeEl = document.getElementById('music-total-time');
  var volumeSlider = document.getElementById('music-volume-slider');
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
  var scrubberDragging = false;
  var defaultVolume = 1;
  var metadataRequestId = 0;
  var metadataChunkSize = 262144;
  var currentArtObjectUrl = null;
  var metadataTitleLoading = 'Loading title...';
  var metadataArtistLoading = 'Loading artist...';
  var metadataTitleUnknown = 'Title unavailable';
  var metadataArtistUnknown = 'Artist unavailable';
  var marqueeRefreshToken = 0;
  var defaultShuffleEnabled = false;
  var defaultLoopPlaylist = false;

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

  function setTextOrFallback(el, text, fallback) {
    if (!el) return;
    el.textContent = text || fallback;
  }

  function setMarqueeState(el) {
    var shouldScroll;
    if (!el) return;
    shouldScroll = el.scrollWidth > el.clientWidth + 1;
    el.classList.toggle('music-marquee-active', shouldScroll);
  }

  function refreshNowPlayingMarqueeStates() {
    setMarqueeState(currentFilenameEl);
    setMarqueeState(songTitleEl);
    setMarqueeState(songArtistEl);
  }

  function scheduleNowPlayingMarqueeRefresh() {
    marqueeRefreshToken += 1;
    var token = marqueeRefreshToken;
    window.requestAnimationFrame(function () {
      if (token !== marqueeRefreshToken) return;
      refreshNowPlayingMarqueeStates();
    });
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
        stream_path: song.stream_path,
        extension: song.extension || metadataExtension(song)
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

  function setButtonLabel(button, text) {
    var label;
    if (!button) return;
    label = button.querySelector('.music-button-label');
    if (label) label.textContent = text;
    else button.textContent = text;
  }

  function setButtonIcon(button, iconUrl) {
    var icon;
    if (!button) return;
    icon = button.querySelector('.music-button-icon');
    if (icon) icon.src = iconUrl;
  }

  function setPlayPauseVisualState(isPlaying) {
    if (playButton) {
      playButton.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
      playButton.title = isPlaying ? 'Pause' : 'Play';
      setButtonLabel(playButton, isPlaying ? 'Pause' : 'Play');
      setButtonIcon(
        playButton,
        isPlaying
          ? '/assets/icons/material-icon-theme/music-pause.svg'
          : '/assets/icons/material-icon-theme/music-play.svg'
      );
      playButton.setAttribute('data-state', isPlaying ? 'pause' : 'play');
    }
    if (pauseButton) {
      pauseButton.hidden = true;
      pauseButton.classList.add('hidden');
    }
  }

  function setCoverArtPlaceholderState(state) {
    if (artPlaceholderEl) artPlaceholderEl.setAttribute('data-art-state', state);
    if (coverArtEl) {
      coverArtEl.hidden = true;
      coverArtEl.classList.add('hidden');
      coverArtEl.removeAttribute('src');
    }
  }

  function revokeCurrentArtObjectUrl() {
    if (!currentArtObjectUrl) return;
    URL.revokeObjectURL(currentArtObjectUrl);
    currentArtObjectUrl = null;
  }

  function supportedArtMime(mime) {
    return mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/gif' || mime === 'image/webp';
  }

  function setCoverArtImage(art) {
    var blob;
    revokeCurrentArtObjectUrl();
    if (!coverArtEl || !art || !art.bytes || !art.bytes.length) {
      setCoverArtPlaceholderState('empty');
      return false;
    }
    if (!supportedArtMime(art.mime || '')) {
      setCoverArtPlaceholderState('unsupported');
      return false;
    }
    blob = new Blob([art.bytes], {type: art.mime});
    currentArtObjectUrl = URL.createObjectURL(blob);
    coverArtEl.src = currentArtObjectUrl;
    coverArtEl.hidden = false;
    coverArtEl.classList.remove('hidden');
    if (artPlaceholderEl) artPlaceholderEl.setAttribute('data-art-state', 'ready');
    return true;
  }

  function showMetadataPlaceholders() {
    setTextOrFallback(songTitleEl, metadataTitleLoading, metadataTitleLoading);
    setTextOrFallback(songArtistEl, metadataArtistLoading, metadataArtistLoading);
    revokeCurrentArtObjectUrl();
    setCoverArtPlaceholderState('loading');
    scheduleNowPlayingMarqueeRefresh();
  }

  function showUnknownMetadata() {
    setTextOrFallback(songTitleEl, metadataTitleUnknown, metadataTitleUnknown);
    setTextOrFallback(songArtistEl, metadataArtistUnknown, metadataArtistUnknown);
    revokeCurrentArtObjectUrl();
    setCoverArtPlaceholderState('empty');
    scheduleNowPlayingMarqueeRefresh();
  }

  function applyMetadataResult(metadata) {
    setTextOrFallback(songTitleEl, metadata && metadata.title, metadataTitleUnknown);
    setTextOrFallback(songArtistEl, metadata && metadata.artist, metadataArtistUnknown);
    if (!setCoverArtImage(metadata && metadata.art ? metadata.art : null)) {
      setCoverArtPlaceholderState(metadata && metadata.art ? 'unsupported' : 'empty');
    }
    scheduleNowPlayingMarqueeRefresh();
  }

  function formatPlaybackTime(seconds) {
    var totalSeconds;
    var hours;
    var minutes;
    var secs;
    if (!Number.isFinite(seconds) || seconds < 0) return '00:00:00';
    totalSeconds = Math.floor(seconds);
    hours = Math.floor(totalSeconds / 3600);
    minutes = Math.floor((totalSeconds % 3600) / 60);
    secs = totalSeconds % 60;
    return String(hours).padStart(2, '0') + ':' +
      String(minutes).padStart(2, '0') + ':' +
      String(secs).padStart(2, '0');
  }

  function setTimeLabel(el, seconds) {
    if (el) el.textContent = formatPlaybackTime(seconds);
  }

  function finiteDuration() {
    if (!audio) return null;
    if (!Number.isFinite(audio.duration) || audio.duration < 0) return null;
    return audio.duration;
  }

  function finiteCurrentTime() {
    if (!audio) return 0;
    if (!Number.isFinite(audio.currentTime) || audio.currentTime < 0) return 0;
    return audio.currentTime;
  }

  function resetProgressDisplay() {
    if (progressSlider) {
      progressSlider.min = '0';
      progressSlider.max = '0';
      progressSlider.value = '0';
    }
    setTimeLabel(elapsedTimeEl, 0);
    setTimeLabel(totalTimeEl, 0);
  }

  function syncDurationDisplay() {
    var duration = finiteDuration();
    if (progressSlider) {
      progressSlider.min = '0';
      progressSlider.max = duration === null ? '0' : String(duration);
      if (!scrubberDragging) {
        progressSlider.value = String(Math.min(finiteCurrentTime(), duration === null ? 0 : duration));
      }
    }
    setTimeLabel(totalTimeEl, duration === null ? 0 : duration);
  }

  function syncCurrentTimeDisplay() {
    var duration = finiteDuration();
    var currentTime = finiteCurrentTime();
    if (progressSlider && !scrubberDragging) {
      progressSlider.value = String(Math.min(currentTime, duration === null ? currentTime : duration));
    }
    setTimeLabel(elapsedTimeEl, currentTime);
  }

  function applySeekFromSlider() {
    var duration;
    var targetTime;
    if (!audio || !progressSlider) return;
    duration = finiteDuration();
    if (duration === null) return;
    targetTime = Number(progressSlider.value);
    if (!Number.isFinite(targetTime)) targetTime = 0;
    targetTime = Math.max(0, Math.min(targetTime, duration));
    audio.currentTime = targetTime;
    syncCurrentTimeDisplay();
  }

  function metadataExtension(song) {
    var name;
    var dotIndex;
    if (!song) return '';
    if (song.extension) return String(song.extension).toLowerCase();
    name = song.display_name || song.rel_path || song.remote_path || '';
    dotIndex = name.lastIndexOf('.');
    return dotIndex === -1 ? '' : name.slice(dotIndex).toLowerCase();
  }

  function decodeLatin1(bytes) {
    var chars = [];
    bytes.forEach(function (value) {
      chars.push(String.fromCharCode(value));
    });
    return chars.join('').replace(/\u0000+$/g, '');
  }

  function decodeUtf16(bytes, littleEndian) {
    var chars = [];
    for (var index = 0; index + 1 < bytes.length; index += 2) {
      var codePoint = littleEndian
        ? bytes[index] | (bytes[index + 1] << 8)
        : (bytes[index] << 8) | bytes[index + 1];
      if (codePoint === 0) continue;
      chars.push(String.fromCharCode(codePoint));
    }
    return chars.join('');
  }

  function decodeId3Text(bytes) {
    var encoding;
    var payload;
    if (!bytes || bytes.length === 0) return '';
    encoding = bytes[0];
    payload = bytes.slice(1);
    if (encoding === 0) return decodeLatin1(payload).trim();
    if (encoding === 3) return new TextDecoder('utf-8').decode(payload).replace(/\u0000+$/g, '').trim();
    if (encoding === 1 || encoding === 2) {
      if (payload.length >= 2) {
        if (payload[0] === 0xFF && payload[1] === 0xFE) return decodeUtf16(payload.slice(2), true).trim();
        if (payload[0] === 0xFE && payload[1] === 0xFF) return decodeUtf16(payload.slice(2), false).trim();
      }
      return decodeUtf16(payload, encoding === 1).trim();
    }
    return '';
  }

  function synchsafeToInt(bytes, offset) {
    return ((bytes[offset] & 0x7F) << 21) |
      ((bytes[offset + 1] & 0x7F) << 14) |
      ((bytes[offset + 2] & 0x7F) << 7) |
      (bytes[offset + 3] & 0x7F);
  }

  function parseApic(bytes) {
    var encoding;
    var index = 1;
    var mimeEnd;
    var descriptionEnd;
    var artBytes;
    if (!bytes || bytes.length < 4) return null;
    encoding = bytes[0];
    mimeEnd = bytes.indexOf(0, index);
    if (mimeEnd === -1) return null;
    index = mimeEnd + 1;
    index += 1;
    if (encoding === 0 || encoding === 3) {
      descriptionEnd = bytes.indexOf(0, index);
      if (descriptionEnd === -1) descriptionEnd = index;
      index = descriptionEnd + 1;
    } else {
      while (index + 1 < bytes.length) {
        if (bytes[index] === 0 && bytes[index + 1] === 0) {
          index += 2;
          break;
        }
        index += 2;
      }
    }
    artBytes = bytes.slice(index);
    if (!artBytes.length) return null;
    return {
      mime: decodeLatin1(bytes.slice(1, mimeEnd)).trim(),
      bytes: artBytes
    };
  }

  function parseId3Metadata(bytes) {
    var result = {title: '', artist: '', art: null};
    var version;
    var tagSize;
    var offset;
    if (bytes.length < 10 || decodeLatin1(bytes.slice(0, 3)) !== 'ID3') return result;
    version = bytes[3];
    tagSize = synchsafeToInt(bytes, 6);
    offset = 10;
    while (offset + 10 <= bytes.length && offset < 10 + tagSize) {
      var frameId = decodeLatin1(bytes.slice(offset, offset + 4));
      var frameSize = version === 4
        ? synchsafeToInt(bytes, offset + 4)
        : ((bytes[offset + 4] << 24) | (bytes[offset + 5] << 16) | (bytes[offset + 6] << 8) | bytes[offset + 7]);
      var frameDataStart = offset + 10;
      var frameDataEnd = frameDataStart + frameSize;
      if (!frameId.replace(/\u0000/g, '').trim() || frameSize <= 0 || frameDataEnd > bytes.length) break;
      if (frameId === 'TIT2') result.title = decodeId3Text(bytes.slice(frameDataStart, frameDataEnd));
      if (frameId === 'TPE1') result.artist = decodeId3Text(bytes.slice(frameDataStart, frameDataEnd));
      if (frameId === 'APIC' && !result.art) result.art = parseApic(bytes.slice(frameDataStart, frameDataEnd));
      offset = frameDataEnd;
    }
    return result;
  }

  function parseWavInfoMetadata(bytes) {
    var result = {title: '', artist: '', art: null};
    var offset = 12;
    if (bytes.length < 12 || decodeLatin1(bytes.slice(0, 4)) !== 'RIFF' || decodeLatin1(bytes.slice(8, 12)) !== 'WAVE') return result;
    while (offset + 8 <= bytes.length) {
      var chunkId = decodeLatin1(bytes.slice(offset, offset + 4));
      var chunkSize = bytes[offset + 4] | (bytes[offset + 5] << 8) | (bytes[offset + 6] << 16) | (bytes[offset + 7] << 24);
      var chunkStart = offset + 8;
      var chunkEnd = chunkStart + chunkSize;
      if (chunkEnd > bytes.length) break;
      if (chunkId === 'LIST' && decodeLatin1(bytes.slice(chunkStart, chunkStart + 4)) === 'INFO') {
        var infoOffset = chunkStart + 4;
        while (infoOffset + 8 <= chunkEnd) {
          var infoId = decodeLatin1(bytes.slice(infoOffset, infoOffset + 4));
          var infoSize = bytes[infoOffset + 4] | (bytes[infoOffset + 5] << 8) | (bytes[infoOffset + 6] << 16) | (bytes[infoOffset + 7] << 24);
          var infoStart = infoOffset + 8;
          var infoEnd = infoStart + infoSize;
          if (infoEnd > chunkEnd) break;
          var text = decodeLatin1(bytes.slice(infoStart, infoEnd)).replace(/\u0000+$/g, '').trim();
          if (infoId === 'INAM') result.title = text;
          if (infoId === 'IART') result.artist = text;
          infoOffset = infoEnd + (infoSize % 2);
        }
      }
      offset = chunkEnd + (chunkSize % 2);
    }
    return result;
  }

  function readAtomSize(bytes, offset) {
    return ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
  }

  function parseMp4TextData(bytes, offset, end) {
    var innerOffset = offset;
    while (innerOffset + 8 <= end) {
      var atomSize = readAtomSize(bytes, innerOffset);
      var atomType = decodeLatin1(bytes.slice(innerOffset + 4, innerOffset + 8));
      var atomEnd = innerOffset + atomSize;
      if (atomSize < 8 || atomEnd > end) break;
      if (atomType === 'data' && atomSize >= 16) {
        return new TextDecoder('utf-8').decode(bytes.slice(innerOffset + 16, atomEnd)).replace(/\u0000+$/g, '').trim();
      }
      innerOffset = atomEnd;
    }
    return '';
  }

  function parseMp4CoverData(bytes, offset, end) {
    var innerOffset = offset;
    while (innerOffset + 8 <= end) {
      var atomSize = readAtomSize(bytes, innerOffset);
      var atomType = decodeLatin1(bytes.slice(innerOffset + 4, innerOffset + 8));
      var atomEnd = innerOffset + atomSize;
      if (atomSize < 8 || atomEnd > end) break;
      if (atomType === 'data' && atomSize >= 16) {
        var dataType = bytes[innerOffset + 11];
        return {
          mime: dataType === 13 ? 'image/jpeg' : dataType === 14 ? 'image/png' : '',
          bytes: bytes.slice(innerOffset + 16, atomEnd)
        };
      }
      innerOffset = atomEnd;
    }
    return null;
  }

  function parseMp4Metadata(bytes) {
    var result = {title: '', artist: '', art: null};
    var stack = [{offset: 0, end: bytes.length}];
    while (stack.length) {
      var frame = stack.pop();
      var offset = frame.offset;
      while (offset + 8 <= frame.end) {
        var atomSize = readAtomSize(bytes, offset);
        var atomType = decodeLatin1(bytes.slice(offset + 4, offset + 8));
        var atomEnd = offset + atomSize;
        if (atomSize === 1 || atomSize < 8 || atomEnd > frame.end) break;
        if (atomType === 'meta') stack.push({offset: offset + 12, end: atomEnd});
        else if (atomType === 'moov' || atomType === 'udta' || atomType === 'ilst') stack.push({offset: offset + 8, end: atomEnd});
        else if (atomType === '\u00a9nam') result.title = result.title || parseMp4TextData(bytes, offset + 8, atomEnd);
        else if (atomType === '\u00a9ART' || atomType === 'aART') result.artist = result.artist || parseMp4TextData(bytes, offset + 8, atomEnd);
        else if (atomType === 'covr' && !result.art) result.art = parseMp4CoverData(bytes, offset + 8, atomEnd);
        offset = atomEnd;
      }
    }
    return result;
  }

  async function fetchRangeBytes(url, start, end) {
    var response = await fetch(url, {
      headers: {
        Range: 'bytes=' + start + '-' + end
      }
    });
    if (!response.ok && response.status !== 206) throw new Error('Metadata request failed with HTTP ' + response.status);
    return new Uint8Array(await response.arrayBuffer());
  }

  async function fetchHeadContentLength(url) {
    var response = await fetch(url, {method: 'HEAD'});
    var value;
    if (!response.ok) return null;
    value = Number(response.headers.get('Content-Length'));
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  async function fetchMetadataBytes(url, extension) {
    var firstChunk = await fetchRangeBytes(url, 0, metadataChunkSize - 1);
    var ext = String(extension || '').toLowerCase();
    if (ext !== '.m4a' || firstChunk.length < metadataChunkSize) return [firstChunk];
    var contentLength = await fetchHeadContentLength(url);
    var start;
    if (!Number.isFinite(contentLength) || contentLength <= firstChunk.length) return [firstChunk];
    start = Math.max(0, contentLength - metadataChunkSize);
    if (start === 0) return [firstChunk];
    return [firstChunk, await fetchRangeBytes(url, start, contentLength - 1)];
  }

  function parseMetadataBuffers(buffers, extension) {
    var ext = String(extension || '').toLowerCase();
    var parsed = {title: '', artist: '', art: null};
    buffers.forEach(function (bytes) {
      var next = {title: '', artist: '', art: null};
      if (ext === '.mp3') next = parseId3Metadata(bytes);
      else if (ext === '.wav') next = parseWavInfoMetadata(bytes);
      else if (ext === '.m4a' || ext === '.aac' || ext === '.mp4') next = parseMp4Metadata(bytes);
      if (!parsed.title && next.title) parsed.title = next.title;
      if (!parsed.artist && next.artist) parsed.artist = next.artist;
      if (!parsed.art && next.art) parsed.art = next.art;
    });
    return parsed;
  }

  function startMetadataLoad(song) {
    var requestId = metadataRequestId + 1;
    var url = streamUrl(song);
    var extension = metadataExtension(song);
    metadataRequestId = requestId;
    showMetadataPlaceholders();
    fetchMetadataBytes(url, extension)
      .then(function (buffers) {
        return parseMetadataBuffers(buffers, extension);
      })
      .then(function (metadata) {
        if (requestId !== metadataRequestId) return;
        applyMetadataResult(metadata);
      })
      .catch(function () {
        if (requestId !== metadataRequestId) return;
        showUnknownMetadata();
      });
  }

  function clampVolume(value) {
    if (!Number.isFinite(value)) return defaultVolume;
    return Math.max(0, Math.min(value, 1));
  }

  function setVolumeUi(volume) {
    if (volumeSlider) volumeSlider.value = String(volume);
  }

  function restoreVolume() {
    var storedVolume = Settings.get('music-volume', defaultVolume);
    var volume = clampVolume(Number(storedVolume));
    if (audio) audio.volume = volume;
    setVolumeUi(volume);
    return volume;
  }

  function persistVolume(volume) {
    Settings.set('music-volume', volume);
  }

  function applyVolumeFromSlider() {
    var volume;
    if (!volumeSlider) return;
    volume = clampVolume(Number(volumeSlider.value));
    if (audio) audio.volume = volume;
    setVolumeUi(volume);
    persistVolume(volume);
  }

  function restoreShuffleEnabled() {
    shuffleEnabled = !!Settings.get('music-shuffle-enabled', defaultShuffleEnabled);
    if (!shuffleEnabled) resetShuffleBag();
  }

  function persistShuffleEnabled() {
    Settings.set('music-shuffle-enabled', shuffleEnabled);
  }

  function restoreLoopPlaylist() {
    loopPlaylist = !!Settings.get('music-loop-playlist', defaultLoopPlaylist);
  }

  function persistLoopPlaylist() {
    Settings.set('music-loop-playlist', loopPlaylist);
  }

  function setCurrentFilename(song) {
    if (!currentFilenameEl) return;
    currentFilenameEl.textContent = song ? (song.display_name || 'Unknown song') : 'No song selected';
    scheduleNowPlayingMarqueeRefresh();
  }

  function resetNowPlayingForSong(song) {
    scrubberDragging = false;
    resetProgressDisplay();
    setCurrentFilename(song || null);
    if (song) showMetadataPlaceholders();
    else showUnknownMetadata();
  }

  function clearCurrentSong() {
    metadataRequestId += 1;
    revokeCurrentArtObjectUrl();
    currentPlaylistIndex = -1;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    resetNowPlayingForSong(null);
    setPlayPauseVisualState(false);
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
    resetNowPlayingForSong(song);
    setPlaybackStatus('');
    setPlayPauseVisualState(true);
    startMetadataLoad(song);
    restoreVolume();
    if (audio) {
      audio.src = streamUrl(song);
      var playPromise = audio.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(function (err) {
          setPlayPauseVisualState(false);
          setPlaybackStatus((err && err.message) || 'Browser blocked playback until user interaction.');
        });
      }
    }
    renderPlaylist();
  }

  function playCurrentOrFirst() {
    if (currentSong()) {
      if (audio) {
        setPlayPauseVisualState(true);
        var playPromise = audio.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch(function (err) {
            setPlayPauseVisualState(false);
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
    else setPlayPauseVisualState(false);
  }

  function togglePlayPause() {
    if (audio && !audio.paused && !audio.ended) {
      pausePlayback();
      return;
    }
    playCurrentOrFirst();
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
      clearCurrentSong();
      if (playlist.length > 0) playPlaylistIndex(Math.min(oldCurrentIndex, playlist.length - 1));
    } else if (currentRemotePath) {
      currentPlaylistIndex = playlistIndexByRemotePath(currentRemotePath);
    }
    renderPlaylist();
  }

  function updateModeButtons() {
    if (shuffleButton) {
      shuffleButton.setAttribute('aria-pressed', shuffleEnabled ? 'true' : 'false');
      setButtonLabel(shuffleButton, shuffleEnabled ? 'Shuffle' : 'Order');
    }
    if (loopButton) {
      loopButton.setAttribute('aria-pressed', loopPlaylist ? 'true' : 'false');
      setButtonLabel(loopButton, loopPlaylist ? 'Loop On' : 'Loop');
    }
  }

  function toggleShuffle() {
    shuffleEnabled = !shuffleEnabled;
    resetShuffleBag();
    persistShuffleEnabled();
    updateModeButtons();
  }

  function toggleLoopPlaylist() {
    loopPlaylist = !loopPlaylist;
    persistLoopPlaylist();
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

  if (playButton) playButton.addEventListener('click', togglePlayPause);
  if (pauseButton) pauseButton.addEventListener('click', pausePlayback);
  if (nextButton) nextButton.addEventListener('click', playNextSong);
  if (prevButton) prevButton.addEventListener('click', playPreviousSong);
  if (shuffleButton) shuffleButton.addEventListener('click', toggleShuffle);
  if (loopButton) loopButton.addEventListener('click', toggleLoopPlaylist);
  if (volumeSlider) {
    volumeSlider.addEventListener('input', applyVolumeFromSlider);
    volumeSlider.addEventListener('change', applyVolumeFromSlider);
  }
  if (progressSlider) {
    progressSlider.min = '0';
    progressSlider.addEventListener('pointerdown', function () {
      scrubberDragging = true;
    });
    progressSlider.addEventListener('pointerup', function () {
      scrubberDragging = false;
      applySeekFromSlider();
    });
    progressSlider.addEventListener('input', function () {
      scrubberDragging = true;
      setTimeLabel(elapsedTimeEl, Number(progressSlider.value));
    });
    progressSlider.addEventListener('change', function () {
      scrubberDragging = false;
      applySeekFromSlider();
    });
  }
  if (audio) {
    audio.addEventListener('loadedmetadata', function () {
      syncDurationDisplay();
      syncCurrentTimeDisplay();
    });
    audio.addEventListener('durationchange', function () {
      syncDurationDisplay();
      syncCurrentTimeDisplay();
    });
    audio.addEventListener('timeupdate', function () {
      syncCurrentTimeDisplay();
    });
    audio.addEventListener('seeking', function () {
      scrubberDragging = true;
      syncCurrentTimeDisplay();
    });
    audio.addEventListener('seeked', function () {
      scrubberDragging = false;
      syncCurrentTimeDisplay();
    });
    audio.addEventListener('play', function () {
      setPlayPauseVisualState(true);
      syncDurationDisplay();
      syncCurrentTimeDisplay();
    });
    audio.addEventListener('pause', function () {
      setPlayPauseVisualState(false);
      syncCurrentTimeDisplay();
    });
    audio.addEventListener('ended', playNextSong);
    audio.addEventListener('ended', function () {
      scrubberDragging = false;
      syncCurrentTimeDisplay();
      if (!currentSong()) setPlayPauseVisualState(false);
    });
    audio.addEventListener('emptied', function () {
      revokeCurrentArtObjectUrl();
    });
    audio.addEventListener('error', function () {
      scrubberDragging = false;
      syncCurrentTimeDisplay();
      setPlayPauseVisualState(false);
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
    scheduleNowPlayingMarqueeRefresh();
  });

  window.addEventListener('resize', scheduleNowPlayingMarqueeRefresh);
  window.addEventListener('beforeunload', stopPolling);
  resetLibraryForCurrentFolder();
  resetProgressDisplay();
  showUnknownMetadata();
  restoreVolume();
  restoreShuffleEnabled();
  restoreLoopPlaylist();
  setPlayPauseVisualState(false);
  updateModeButtons();
  renderPlaylist();
  scheduleNowPlayingMarqueeRefresh();
}());
