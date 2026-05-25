import {setTextOrFallback} from './music-shared.js';
import {resolveCoverArtFromMetadata, supportedArtMime} from './music-coverart.js';

export function createMetadataController(ctx) {
  var els = ctx.els;
  var state = ctx.state;
  var metadataDebugLoggingEnabled = false;

  function metadataLog(eventName, details) {
    if (!metadataDebugLoggingEnabled) return;
    var payload = details || {};
    try {
      console.log('[music-metadata]', eventName, payload);
    } catch (_err) {}
  }

  function setMarqueeState(el) {
    var shouldScroll;
    if (!el) return;
    shouldScroll = el.scrollWidth > el.clientWidth + 1;
    el.classList.toggle('music-marquee-active', shouldScroll);
  }

  function refreshNowPlayingMarqueeStates() {
    setMarqueeState(els.currentFilenameEl);
    setMarqueeState(els.songTitleEl);
    setMarqueeState(els.songArtistEl);
  }

  function scheduleNowPlayingMarqueeRefresh() {
    state.marqueeRefreshToken += 1;
    var token = state.marqueeRefreshToken;
    window.requestAnimationFrame(function () {
      if (token !== state.marqueeRefreshToken) return;
      refreshNowPlayingMarqueeStates();
    });
  }

  function setCoverArtPlaceholderState(stateName) {
    if (els.artPlaceholderEl) els.artPlaceholderEl.setAttribute('data-art-state', stateName);
    if (els.coverArtEl) {
      els.coverArtEl.hidden = true;
      els.coverArtEl.classList.add('hidden');
      els.coverArtEl.removeAttribute('src');
    }
  }

  function revokeCurrentArtObjectUrl() {
    if (!state.currentArtObjectUrl) return;
    URL.revokeObjectURL(state.currentArtObjectUrl);
    state.currentArtObjectUrl = null;
  }

  function setCoverArtImage(art) {
    var blob;
    revokeCurrentArtObjectUrl();
    if (!els.coverArtEl || !art || !art.bytes || !art.bytes.length) {
      metadataLog('coverart-missing', {
        hasElement: !!els.coverArtEl,
        hasArt: !!art,
        byteLength: art && art.bytes ? art.bytes.length : 0,
      });
      setCoverArtPlaceholderState('empty');
      return false;
    }
    if (!supportedArtMime(art.mime || '')) {
      metadataLog('coverart-unsupported', {
        mime: art.mime || '',
        byteLength: art.bytes.length,
      });
      setCoverArtPlaceholderState('unsupported');
      return false;
    }
    blob = new Blob([art.bytes], {type: art.mime});
    state.currentArtObjectUrl = URL.createObjectURL(blob);
    els.coverArtEl.src = state.currentArtObjectUrl;
    els.coverArtEl.hidden = false;
    els.coverArtEl.classList.remove('hidden');
    if (els.artPlaceholderEl) els.artPlaceholderEl.setAttribute('data-art-state', 'ready');
    metadataLog('coverart-applied', {
      mime: art.mime,
      byteLength: art.bytes.length,
      objectUrl: state.currentArtObjectUrl,
    });
    return true;
  }

  function showMetadataPlaceholders() {
    setTextOrFallback(els.songTitleEl, state.metadataTitleLoading, state.metadataTitleLoading);
    setTextOrFallback(els.songArtistEl, state.metadataArtistLoading, state.metadataArtistLoading);
    revokeCurrentArtObjectUrl();
    setCoverArtPlaceholderState('loading');
    scheduleNowPlayingMarqueeRefresh();
  }

  function showUnknownMetadata() {
    setTextOrFallback(els.songTitleEl, state.metadataTitleUnknown, state.metadataTitleUnknown);
    setTextOrFallback(els.songArtistEl, state.metadataArtistUnknown, state.metadataArtistUnknown);
    revokeCurrentArtObjectUrl();
    setCoverArtPlaceholderState('empty');
    scheduleNowPlayingMarqueeRefresh();
  }

  function applyMetadataResult(metadata) {
    setTextOrFallback(els.songTitleEl, metadata && metadata.title, state.metadataTitleUnknown);
    setTextOrFallback(els.songArtistEl, metadata && metadata.artist, state.metadataArtistUnknown);
    if (!setCoverArtImage(metadata && metadata.art ? metadata.art : null)) {
      setCoverArtPlaceholderState(metadata && metadata.art ? 'unsupported' : 'empty');
    }
    scheduleNowPlayingMarqueeRefresh();
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

  function parseId3Metadata(bytes) {
    var result = {title: '', artist: ''};
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
      offset = frameDataEnd;
    }
    return result;
  }

  function parseWavInfoMetadata(bytes) {
    var result = {title: '', artist: ''};
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

  function parseMp4Metadata(bytes) {
    var result = {title: '', artist: ''};
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
        offset = atomEnd;
      }
    }
    return result;
  }

  async function fetchRangeBytes(url, start, end) {
    metadataLog('range-fetch-start', {
      url: url,
      start: start,
      end: end,
    });
    var response = await fetch(url, {
      headers: {
        Range: 'bytes=' + start + '-' + end
      }
    });
    if (!response.ok && response.status !== 206) throw new Error('Metadata request failed with HTTP ' + response.status);
    var bytes = new Uint8Array(await response.arrayBuffer());
    metadataLog('range-fetch-done', {
      url: url,
      start: start,
      end: end,
      status: response.status,
      byteLength: bytes.length,
      contentRange: response.headers.get('Content-Range'),
    });
    return bytes;
  }

  async function fetchHeadContentLength(url) {
    var response = await fetch(url, {method: 'HEAD'});
    var value;
    if (!response.ok) return null;
    value = Number(response.headers.get('Content-Length'));
    metadataLog('head-content-length', {
      url: url,
      status: response.status,
      contentLength: Number.isFinite(value) && value > 0 ? value : null,
    });
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  async function fetchMetadataBytes(url, extension) {
    var firstChunk = await fetchRangeBytes(url, 0, state.metadataChunkSize - 1);
    var ext = String(extension || '').toLowerCase();
    if (ext !== '.m4a' || firstChunk.length < state.metadataChunkSize) return [firstChunk];
    var contentLength = await fetchHeadContentLength(url);
    var start;
    if (!Number.isFinite(contentLength) || contentLength <= firstChunk.length) return [firstChunk];
    start = Math.max(0, contentLength - state.metadataChunkSize);
    if (start === 0) return [firstChunk];
    return [firstChunk, await fetchRangeBytes(url, start, contentLength - 1)];
  }

  function parseMetadataBuffers(buffers, extension) {
    var ext = String(extension || '').toLowerCase();
    var parsed = {title: '', artist: ''};
    buffers.forEach(function (bytes) {
      var next = {title: '', artist: ''};
      if (ext === '.mp3') next = parseId3Metadata(bytes);
      else if (ext === '.wav') next = parseWavInfoMetadata(bytes);
      else if (ext === '.m4a' || ext === '.aac' || ext === '.mp4') next = parseMp4Metadata(bytes);
      if (!parsed.title && next.title) parsed.title = next.title;
      if (!parsed.artist && next.artist) parsed.artist = next.artist;
    });
    return parsed;
  }

  function streamUrl(song) {
    return '/file?path=' + encodeURIComponent(song.stream_path) + '&source=remote';
  }

  function artworkFetchAllowed() {
    return !document.hidden && state.windowFocused;
  }

  function songMayHaveEmbeddedArt(song) {
    var extension = metadataExtension(song);
    return extension === '.mp3' || extension === '.m4a' || extension === '.aac' || extension === '.mp4';
  }

  function maybeResolveCoverArt(song, requestId, extension, buffers) {
    if (!song || !song.remote_path) return Promise.resolve(null);
    if (!artworkFetchAllowed()) {
      if (songMayHaveEmbeddedArt(song)) state.pendingArtworkRemotePath = song.remote_path;
      metadataLog('coverart-deferred', {
        remotePath: song.remote_path,
        extension: extension,
        documentHidden: document.hidden,
        windowFocused: state.windowFocused,
      });
      return Promise.resolve(null);
    }
    state.pendingArtworkRemotePath = null;
    metadataLog('coverart-resolve-start', {
      remotePath: song.remote_path,
      extension: extension,
      bufferLengths: buffers.map(function (bytes) { return bytes.length; }),
      requestId: requestId,
    });
    return resolveCoverArtFromMetadata({
      extension: extension,
      buffers: buffers,
      probeSize: state.metadataChunkSize,
      fetchRangeBytes: function (start, end) {
        return fetchRangeBytes(streamUrl(song), start, end);
      },
      fetchHeadContentLength: fetchHeadContentLength
    }).catch(function () {
      metadataLog('coverart-resolve-error', {
        remotePath: song.remote_path,
        extension: extension,
      });
      return null;
    }).then(function (art) {
      if (requestId !== state.metadataRequestId) return null;
      metadataLog('coverart-resolve-done', {
        remotePath: song.remote_path,
        extension: extension,
        found: !!art,
        mime: art && art.mime ? art.mime : '',
        byteLength: art && art.bytes ? art.bytes.length : 0,
      });
      return art;
    });
  }

  function startMetadataLoad(song) {
    var requestId = state.metadataRequestId + 1;
    var url = streamUrl(song);
    var extension = metadataExtension(song);
    state.metadataRequestId = requestId;
    metadataLog('metadata-load-start', {
      remotePath: song && song.remote_path ? song.remote_path : '',
      streamPath: song && song.stream_path ? song.stream_path : '',
      extension: extension,
      requestId: requestId,
      artworkAllowed: artworkFetchAllowed(),
      documentHidden: document.hidden,
      windowFocused: state.windowFocused,
    });
    showMetadataPlaceholders();
    fetchMetadataBytes(url, extension)
      .then(function (buffers) {
        metadataLog('metadata-buffers-ready', {
          remotePath: song.remote_path,
          extension: extension,
          requestId: requestId,
          bufferLengths: buffers.map(function (bytes) { return bytes.length; }),
        });
        return Promise.all([
          Promise.resolve(parseMetadataBuffers(buffers, extension)),
          maybeResolveCoverArt(song, requestId, extension, buffers)
        ]);
      })
      .then(function (results) {
        var metadata = results[0];
        metadata.art = results[1];
        if (requestId !== state.metadataRequestId) return;
        metadataLog('metadata-load-apply', {
          remotePath: song.remote_path,
          extension: extension,
          requestId: requestId,
          title: metadata.title || '',
          artist: metadata.artist || '',
          hasArt: !!metadata.art,
          artMime: metadata.art && metadata.art.mime ? metadata.art.mime : '',
          artByteLength: metadata.art && metadata.art.bytes ? metadata.art.bytes.length : 0,
        });
        applyMetadataResult(metadata);
      })
      .catch(function (err) {
        if (requestId !== state.metadataRequestId) return;
        metadataLog('metadata-load-error', {
          remotePath: song && song.remote_path ? song.remote_path : '',
          extension: extension,
          requestId: requestId,
          message: err && err.message ? err.message : String(err || ''),
        });
        showUnknownMetadata();
      });
  }

  function maybeStartCurrentSongMetadataLoad() {
    var song = ctx.playbackApi.currentSong();
    if (!song || !song.remote_path) return;
    if (state.metadataLoadedRemotePath === song.remote_path) return;
    state.metadataLoadedRemotePath = song.remote_path;
    startMetadataLoad(song);
  }

  function resumeDeferredArtworkLoad() {
    var song = ctx.playbackApi.currentSong();
    metadataLog('coverart-resume-check', {
      hasSong: !!song,
      remotePath: song && song.remote_path ? song.remote_path : '',
      pendingRemotePath: state.pendingArtworkRemotePath,
      artworkAllowed: artworkFetchAllowed(),
      documentHidden: document.hidden,
      windowFocused: state.windowFocused,
    });
    if (!artworkFetchAllowed() || !song || !song.remote_path) return;
    if (state.pendingArtworkRemotePath !== song.remote_path) return;
    metadataLog('coverart-resume-start', {
      remotePath: song.remote_path,
    });
    state.metadataLoadedRemotePath = null;
    startMetadataLoad(song);
  }

  function setCurrentFilename(song) {
    if (!els.currentFilenameEl) return;
    els.currentFilenameEl.textContent = song ? (song.display_name || 'Unknown song') : 'No song selected';
    scheduleNowPlayingMarqueeRefresh();
  }

  function resetNowPlayingForSong(song) {
    state.scrubberDragging = false;
    ctx.playbackApi.resetProgressDisplay();
    setCurrentFilename(song || null);
    if (song) showMetadataPlaceholders();
    else showUnknownMetadata();
  }

  function clearMetadataRequest() {
    state.metadataRequestId += 1;
    state.metadataLoadedRemotePath = null;
  }

  return {
    applyMetadataResult: applyMetadataResult,
    clearMetadataRequest: clearMetadataRequest,
    maybeStartCurrentSongMetadataLoad: maybeStartCurrentSongMetadataLoad,
    metadataExtension: metadataExtension,
    refreshNowPlayingMarqueeStates: refreshNowPlayingMarqueeStates,
    resetNowPlayingForSong: resetNowPlayingForSong,
    revokeCurrentArtObjectUrl: revokeCurrentArtObjectUrl,
    resumeDeferredArtworkLoad: resumeDeferredArtworkLoad,
    scheduleNowPlayingMarqueeRefresh: scheduleNowPlayingMarqueeRefresh,
    setCoverArtImage: setCoverArtImage,
    setCoverArtPlaceholderState: setCoverArtPlaceholderState,
    setCurrentFilename: setCurrentFilename,
    setMarqueeState: setMarqueeState,
    showMetadataPlaceholders: showMetadataPlaceholders,
    showUnknownMetadata: showUnknownMetadata,
    startMetadataLoad: startMetadataLoad,
    supportedArtMime: supportedArtMime
  };
}
