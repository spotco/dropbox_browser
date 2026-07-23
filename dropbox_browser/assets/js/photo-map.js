import {
  PHOTO_MAP_DATE_PRESETS,
  buildPhotoMapListingEndpoint,
  selectPhotoMapCandidates,
} from './photo-map/listing.js';
import {readPhotoMapItemMetadata} from './photo-map/parsers.js';
import {
  mergePhotoMapCacheCandidates,
  photoMapCacheRecordForResult,
  readPhotoMapCache,
  writePhotoMapCache,
} from './photo-map/cache.js';
import {
  PHOTO_MAP_CACHE_BATCH_LIMIT,
  PHOTO_MAP_METADATA_CONCURRENCY,
} from './photo-map/config.js';
import {runPhotoMapMetadataQueue} from './photo-map/queue.js';
import {
  runPhotoMapThumbnailQueue,
  selectPhotoMapThumbnailItems,
} from './photo-map/thumbnails.js';
import {ensurePhotoMapLeaflet} from './photo-map/leaflet.js';
import {createPhotoMap} from './photo-map/map.js';
import {createPhotoMapDiagnostics} from './photo-map/diagnostics.js';
import {
  photoMapStatusForSummary,
  summarizePhotoMapResults,
} from './photo-map/states.js';

export function initPhotoMap(options) {
  var config = options || {};
  var doc = config.document || (typeof document !== 'undefined' ? document : null);
  var win = config.window || (typeof window !== 'undefined' ? window : null);
  var fetchImpl = config.fetchImpl || (win && typeof win.fetch === 'function' ? win.fetch.bind(win) : null);
  if (!doc || !win || typeof fetchImpl !== 'function') return null;

  var pane = doc.getElementById('photo-map-pane');
  var body = doc.body;
  if (!pane || !body) return null;

  var dateRangeEl = doc.getElementById('photo-map-date-range');
  var customRangeEl = doc.getElementById('photo-map-custom-range');
  var dateFromEl = doc.getElementById('photo-map-date-from');
  var dateToEl = doc.getElementById('photo-map-date-to');
  var refreshEl = doc.getElementById('photo-map-refresh');
  var statusEl = doc.getElementById('photo-map-status');
  var active = false;
  var runId = 0;
  var candidates = [];
  var metadataResults = new Map();
  var abortController = null;
  var thumbnailQueue = null;
  var thumbnailController = null;
  var mapController = null;
  var mapResizeObserver = null;
  var diagnostics = createPhotoMapDiagnostics(win);
  var mapUserInteracted = false;
  var mapFittedToResults = false;
  var fittingMap = false;
  var mapInteractionHandler = null;

  function newAbortController() {
    if (typeof AbortController === 'function') return new AbortController();
    return {signal: undefined, abort: function () {}};
  }

  function cancelGeneration() {
    runId += 1;
    if (abortController) abortController.abort();
    if (thumbnailController) thumbnailController.abort();
    abortController = null;
    thumbnailController = null;
    metadataResults.clear();
    thumbnailQueue = null;
  }

  function generationIsCurrent(generation) {
    return active && generation.id === runId && abortController === generation.controller &&
      !(generation.signal && generation.signal.aborted);
  }

  function invalidateMapSize() {
    if (mapController) mapController.invalidateSize();
  }

  function clearMapMarkers() {
    if (mapController && typeof mapController.setMarkerItems === 'function') {
      mapController.setMarkerItems([]);
    }
  }

  function mapResultsSummary() {
    return summarizePhotoMapResults(candidates, metadataResults);
  }

  function renderMapResults(phase) {
    var summary = mapResultsSummary();
    if (mapController && typeof mapController.setMarkerItems === 'function') {
      mapController.setMarkerItems(summary.locatedItems);
      if (summary.locatedItems.length > 0 && !mapFittedToResults && !mapUserInteracted &&
          typeof mapController.fitToItems === 'function') {
        fittingMap = true;
        mapFittedToResults = mapController.fitToItems(summary.locatedItems);
        fittingMap = false;
      }
    }
    var status = photoMapStatusForSummary(summary, phase);
    setStatus(status.message, status.state);
    return summary;
  }

  function markMapUserInteracted() {
    if (!fittingMap) mapUserInteracted = true;
  }

  function attachMapInteractionGuards() {
    var map = mapController && mapController.map;
    if (!map || typeof map.on !== 'function') return;
    mapInteractionHandler = markMapUserInteracted;
    map.on('dragstart', mapInteractionHandler);
    map.on('zoomstart', mapInteractionHandler);
  }

  function detachMapInteractionGuards() {
    var map = mapController && mapController.map;
    if (map && mapInteractionHandler && typeof map.off === 'function') {
      map.off('dragstart', mapInteractionHandler);
      map.off('zoomstart', mapInteractionHandler);
    }
    mapInteractionHandler = null;
  }

  function destroyMap() {
    if (mapResizeObserver) mapResizeObserver.disconnect();
    mapResizeObserver = null;
    detachMapInteractionGuards();
    if (mapController) mapController.destroy();
    mapController = null;
    mapUserInteracted = false;
    mapFittedToResults = false;
  }

  function initializeMap() {
    if (mapController || !active) return Promise.resolve(mapController);
    var expectedRunId = runId;
    return ensurePhotoMapLeaflet(doc, win).then(function (leaflet) {
      if (!active || expectedRunId !== runId) return null;
      mapController = createPhotoMap(leaflet, doc.getElementById('photo-map-map'));
      attachMapInteractionGuards();
      if (typeof win.ResizeObserver === 'function') {
        mapResizeObserver = new win.ResizeObserver(function () { invalidateMapSize(); });
        mapResizeObserver.observe(pane);
      }
      invalidateMapSize();
      if (candidates.length > 0 || metadataResults.size > 0) renderMapResults('progressive');
      return mapController;
    }).catch(function (error) {
      if (active && expectedRunId === runId) {
        setStatus(error && error.message ? error.message : 'Could not initialize Photo Map.', 'partial-errors');
      }
      return null;
    });
  }

  function currentFolderPath() {
    return body.dataset.currentFolderPath || '';
  }

  function currentRange() {
    var preset = dateRangeEl && PHOTO_MAP_DATE_PRESETS[dateRangeEl.value]
      ? dateRangeEl.value
      : 'all';
    return {
      preset: preset,
      from: dateFromEl ? dateFromEl.value : '',
      to: dateToEl ? dateToEl.value : '',
    };
  }

  function updateCustomRangeVisibility() {
    var visible = currentRange().preset === 'custom';
    if (customRangeEl) {
      customRangeEl.hidden = !visible;
      customRangeEl.classList.toggle('hidden', !visible);
    }
  }

  function setStatus(message, state) {
    if (!statusEl) return;
    statusEl.textContent = message;
    if (state) statusEl.dataset.state = state;
    statusEl.setAttribute('aria-busy', state === 'loading' || state === 'progressive' ? 'true' : 'false');
  }

  function readCurrentListing(signal) {
    var browseClient = win.DropboxBrowseClient;
    var expectedPath = currentFolderPath();
    if (browseClient && typeof browseClient.getCurrentListing === 'function') {
      var snapshot = browseClient.getCurrentListing();
      if (snapshot && snapshot.path === expectedPath && !snapshot.loading && Array.isArray(snapshot.rows)) {
        return Promise.resolve(snapshot);
      }
    }
    return fetchImpl(buildPhotoMapListingEndpoint(expectedPath), {signal: signal})
      .then(function (response) {
        if (!response.ok) throw new Error('Could not load the current folder listing.');
        return response.json();
      })
      .then(function (payload) {
        var page = payload && payload.page ? payload.page : {};
        return {
          path: typeof page.path === 'string' ? page.path : expectedPath,
          rows: Array.isArray(payload && payload.rows) ? payload.rows : [],
          loading: false,
          error: null,
        };
      });
  }

  function paintCandidates(snapshot) {
    candidates = selectPhotoMapCandidates(
      snapshot.rows,
      snapshot.path,
      currentRange(),
      Date.now(),
    );
    if (candidates.length === 0) renderMapResults('complete');
    return candidates.slice();
  }

  async function loadCandidates() {
    cancelGeneration();
    var generation = {id: runId, controller: newAbortController()};
    abortController = generation.controller;
    generation.signal = generation.controller.signal;
    diagnostics.beginGeneration(generation.id);
    candidates = [];
    metadataResults.clear();
    mapFittedToResults = false;
    clearMapMarkers();
    setStatus('Loading Photo Map media...', 'loading');
    try {
      var snapshot = await readCurrentListing(generation.signal);
      if (!generationIsCurrent(generation)) return [];
      paintCandidates(snapshot);

      var cachedEntries = [];
      try {
        diagnostics.increment('cacheReads');
        cachedEntries = await readPhotoMapCache(fetchImpl, snapshot.path, generation.signal);
        if (!generationIsCurrent(generation)) return [];
        diagnostics.increment('cacheEntries', cachedEntries.length);
      } catch (cacheError) {
        if (!generationIsCurrent(generation)) return [];
        diagnostics.increment('cacheReadErrors');
      }
      if (!generationIsCurrent(generation)) return [];
      var merged = mergePhotoMapCacheCandidates(candidates, cachedEntries);
      diagnostics.increment('cacheHits', merged.cached.length);
      diagnostics.increment('cacheMisses', merged.pending.length);
      diagnostics.logSummary('Photo Map cache summary', {
        candidates: candidates.length,
        cached: merged.cached.length,
        pending: merged.pending.length,
      });
      merged.cached.forEach(function (entry) { metadataResults.set(entry.item.path, entry.result); });
      renderMapResults(merged.cached.length > 0 ? 'cached' : 'progressive');

      var discovered = [];
      diagnostics.increment('metadataQueued', merged.pending.length);
      var queueReport = await runPhotoMapMetadataQueue(
        merged.pending,
        function (item, signal) {
          return readPhotoMapItemMetadata(item, {fetchImpl: fetchImpl, signal: signal});
        },
        {
          concurrency: PHOTO_MAP_METADATA_CONCURRENCY,
          signal: generation.signal,
          isCurrent: function () { return generationIsCurrent(generation); },
          onResult: function (item, result) {
            if (!generationIsCurrent(generation)) return;
            diagnostics.increment('metadataCompleted');
            if (result && result.status === 'located') diagnostics.increment('metadataLocated');
            else if (result && result.status === 'no-location') diagnostics.increment('metadataNoLocation');
            else diagnostics.increment('metadataErrors');
            metadataResults.set(item.path, result);
            discovered.push(photoMapCacheRecordForResult(item, result));
            renderMapResults('progressive');
          },
        },
      );
      if (!generationIsCurrent(generation)) return [];
      diagnostics.logSummary('Photo Map metadata queue summary', {
        queued: merged.pending.length,
        completed: queueReport.results.length,
        aborted: queueReport.aborted,
      });
      if (queueReport.aborted) {
        diagnostics.increment('metadataAborted');
        return [];
      }
      if (discovered.length > 0) {
        for (var batchStart = 0; batchStart < discovered.length; batchStart += PHOTO_MAP_CACHE_BATCH_LIMIT) {
          if (!generationIsCurrent(generation)) return [];
          var batch = discovered.slice(batchStart, batchStart + PHOTO_MAP_CACHE_BATCH_LIMIT);
          diagnostics.increment('cacheWriteBatches');
          diagnostics.increment('cacheWriteEntries', batch.length);
          try {
            await writePhotoMapCache(
              fetchImpl,
              snapshot.path,
              batch,
              generation.signal,
            );
          } catch (cacheError) {
            if (!generationIsCurrent(generation)) return [];
            diagnostics.increment('cacheWriteErrors');
            throw cacheError;
          }
        }
      }
      if (!generationIsCurrent(generation)) return [];
      renderMapResults('complete');
      diagnostics.logSummary('Photo Map generation complete', {
        candidates: candidates.length,
        metadataResults: metadataResults.size,
      });
      return candidates.slice();
    } catch (error) {
      if (!generationIsCurrent(generation)) return [];
      candidates = [];
      metadataResults.clear();
      clearMapMarkers();
      diagnostics.logSummary('Photo Map generation failed', {
        error: error && error.message ? error.message : 'unknown-error',
      });
      setStatus(error && error.message ? error.message : 'Could not load Photo Map candidates.', 'partial-errors');
      return [];
    }
  }

  function activate() {
    active = true;
    updateCustomRangeVisibility();
    var loading = loadCandidates();
    initializeMap();
    return loading;
  }

  function deactivate() {
    active = false;
    destroyMap();
    cancelGeneration();
    candidates = [];
  }

  function applyDateRange() {
    updateCustomRangeVisibility();
    if (active) loadCandidates();
  }

  function refresh() {
    if (active) loadCandidates();
  }

  function requestThumbnails(items, options) {
    var config = options || {};
    if (!active) return Promise.resolve({results: [], aborted: true, queued: false});
    if (thumbnailController) thumbnailController.abort();
    thumbnailController = newAbortController();
    var generationId = runId;
    var requestItems = selectPhotoMapThumbnailItems(items, Object.assign({}, config, {
      metadataResults: metadataResults,
    }));
    diagnostics.increment('thumbnailQueued', requestItems.length);
    thumbnailQueue = runPhotoMapThumbnailQueue(requestItems, {
      imageFactory: config.imageFactory || function () { return new win.Image(); },
      loader: config.loader,
      signal: thumbnailController.signal,
      isCurrent: function () {
        return active && generationId === runId && !(thumbnailController.signal && thumbnailController.signal.aborted);
      },
      onResult: function (item, result) {
        if (!diagnostics.isGeneration(generationId)) return;
        if (result && result.status === 'loaded') diagnostics.increment('thumbnailCompleted');
        else if (result && result.reason === 'aborted') diagnostics.increment('thumbnailAborted');
        else diagnostics.increment('thumbnailErrors');
        if (typeof config.onResult === 'function') config.onResult(item, result);
      },
    });
    thumbnailQueue.then(function (report) {
      if (!diagnostics.isGeneration(generationId)) return;
      diagnostics.logSummary('Photo Map thumbnail queue summary', {
        queued: requestItems.length,
        completed: report.results.length,
        aborted: report.aborted,
      });
    });
    return thumbnailQueue;
  }

  function initialPaneMode() {
    if (!win.Settings || typeof win.Settings.get !== 'function') return 'server-log';
    return win.Settings.get('bottom-pane-mode', 'server-log');
  }

  if (dateRangeEl) dateRangeEl.addEventListener('change', applyDateRange);
  if (dateFromEl) dateFromEl.addEventListener('change', applyDateRange);
  if (dateToEl) dateToEl.addEventListener('change', applyDateRange);
  if (refreshEl) refreshEl.addEventListener('click', refresh);
  win.addEventListener('resize', invalidateMapSize);
  doc.addEventListener('bottom-panel-full-window-changed', invalidateMapSize);
  win.addEventListener('bottom-pane-mode-changed', function (event) {
    var mode = event && event.detail ? event.detail.mode : '';
    if (mode === 'photo-map') activate();
    else deactivate();
  });
  win.addEventListener('browse-folder-changed', function () {
    if (active) loadCandidates();
  });

  updateCustomRangeVisibility();
  if (typeof win.DropboxBrowserPhotoMap === 'undefined') win.DropboxBrowserPhotoMap = {};
  win.DropboxBrowserPhotoMap.getCandidates = function () { return candidates.slice(); };
  win.DropboxBrowserPhotoMap.getMetadataResults = function () {
    return Array.from(metadataResults.values());
  };
  win.DropboxBrowserPhotoMap.readMetadata = function (item, options) {
    return readPhotoMapItemMetadata(item, Object.assign({fetchImpl: fetchImpl}, options || {}));
  };
  win.DropboxBrowserPhotoMap.readCache = function (folderPath, signal) {
    return readPhotoMapCache(fetchImpl, folderPath, signal);
  };
  win.DropboxBrowserPhotoMap.writeCache = function (folderPath, entries, signal) {
    return writePhotoMapCache(fetchImpl, folderPath, entries, signal);
  };
  win.DropboxBrowserPhotoMap.cacheRecordForResult = photoMapCacheRecordForResult;
  win.DropboxBrowserPhotoMap.selectThumbnailItems = selectPhotoMapThumbnailItems;
  win.DropboxBrowserPhotoMap.requestThumbnails = requestThumbnails;
  win.DropboxBrowserPhotoMap.getDiagnostics = function () { return diagnostics.snapshot(); };
  win.DropboxBrowserPhotoMap.getMap = function () { return mapController ? mapController.map : null; };
  win.DropboxBrowserPhotoMap.invalidateSize = invalidateMapSize;
  win.DropboxBrowserPhotoMap.destroyMap = destroyMap;
  win.DropboxBrowserPhotoMap.activate = activate;
  win.DropboxBrowserPhotoMap.deactivate = deactivate;
  if (initialPaneMode() === 'photo-map') activate();
  return {activate: activate, deactivate: deactivate, getCandidates: function () { return candidates.slice(); }};
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  initPhotoMap({document: document, window: window});
}
