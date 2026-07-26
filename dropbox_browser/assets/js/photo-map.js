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
  PHOTO_MAP_DEFAULT_FROM_DATE,
  PHOTO_MAP_GROUPING_DISTANCE_DEFAULT_METERS,
  PHOTO_MAP_METADATA_CONCURRENCY,
} from './photo-map/config.js';
import {runPhotoMapMetadataQueue} from './photo-map/queue.js';
import {
  createPhotoMapThumbnailScheduler,
  selectPhotoMapThumbnailItems,
} from './photo-map/thumbnails.js';
import {ensurePhotoMapLeaflet} from './photo-map/leaflet.js';
import {createPhotoMap} from './photo-map/map.js';
import {createPhotoMapDiagnostics} from './photo-map/diagnostics.js';
import {groupPhotoMapItems} from './photo-map/grouping.js';
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
  var groupingDistanceEl = doc.getElementById('photo-map-grouping-distance');
  var refreshEl = doc.getElementById('photo-map-refresh');
  var statusEl = doc.getElementById('photo-map-status');
  var active = false;
  var runId = 0;
  var candidates = [];
  var metadataResults = new Map();
  var thumbnailResults = new Map();
  var abortController = null;
  var thumbnailScheduler = null;
  var mapController = null;
  var mapResizeObserver = null;
  var activeCacheWriter = null;
  var cacheWriteTail = Promise.resolve();
  var debugEnabled = config.photoMapDebug === undefined ? true : Boolean(config.photoMapDebug);
  var diagnostics = createPhotoMapDiagnostics(win);
  var mapUserInteracted = false;
  var mapFittedToResults = false;
  var fittingMap = false;
  var mapInteractionHandler = null;
  var thumbnailGenerationId = 0;
  var selectedThumbnailPath = '';
  var selectedGroupedMemberPath = '';
  var activeGroupedPopup = null;
  var groupedDemandPaths = new Set();
  var dateInputDefaultsInitialized = false;

  function newAbortController() {
    if (typeof AbortController === 'function') return new AbortController();
    return {signal: undefined, abort: function () {}};
  }

  function scheduleCacheWrite(folderPath, entries) {
    var operation = cacheWriteTail.then(function () {
      diagnostics.increment('cacheWriteBatches');
      diagnostics.increment('cacheWriteEntries', entries.length);
      return writePhotoMapCache(fetchImpl, folderPath, entries);
    });
    cacheWriteTail = operation.catch(function () {});
    return operation;
  }

  function createCacheWriter(folderPath, generation) {
    var pending = [];
    var flushTimer = null;
    var writeChain = Promise.resolve();
    var firstError = null;
    var accepting = true;

    function clearFlushTimer() {
      if (flushTimer === null) return;
      if (win && typeof win.clearTimeout === 'function') win.clearTimeout(flushTimer);
      else clearTimeout(flushTimer);
      flushTimer = null;
    }

    function appendBatch() {
      if (!pending.length) return;
      var batch = pending.splice(0, PHOTO_MAP_CACHE_BATCH_LIMIT);
      writeChain = writeChain.then(function () {
        return scheduleCacheWrite(folderPath, batch);
      }).catch(function (error) {
        if (!firstError) firstError = error;
        diagnostics.increment('cacheWriteErrors');
      });
    }

    function scheduleFlush() {
      if (flushTimer !== null || !pending.length) return;
      var setTimer = win && typeof win.setTimeout === 'function' ? win.setTimeout : setTimeout;
      flushTimer = setTimer(function () {
        flushTimer = null;
        appendBatch();
      }, 0);
    }

    function flushNow() {
      clearFlushTimer();
      appendBatch();
      return writeChain;
    }

    function enqueue(item, result) {
      if (!accepting || !generationIsCurrent(generation)) return false;
      pending.push(photoMapCacheRecordForResult(item, result));
      if (pending.length >= PHOTO_MAP_CACHE_BATCH_LIMIT) flushNow();
      else scheduleFlush();
      return true;
    }

    async function finish() {
      accepting = false;
      await flushNow();
      if (firstError) throw firstError;
    }

    function cancel() {
      accepting = false;
      // Records accepted before cancellation remain valid persistence work.
      // Late queue callbacks are rejected by both `accepting` and the
      // generation check above.
      flushNow();
    }

    return {enqueue: enqueue, finish: finish, cancel: cancel};
  }

  function cancelGeneration() {
    if (activeCacheWriter) activeCacheWriter.cancel();
    activeCacheWriter = null;
    runId += 1;
    if (abortController) abortController.abort();
    abortController = null;
    metadataResults.clear();
    thumbnailResults.clear();
    activeGroupedPopup = null;
    selectedGroupedMemberPath = '';
    if (thumbnailScheduler) {
      var groupedInFlight = new Set(
        thumbnailScheduler.getActivePaths().concat(thumbnailScheduler.getPendingPaths()),
      );
      groupedInFlight.forEach(function (path) {
        if (groupedDemandPaths.has(path)) diagnostics.increment('groupedThumbnailCancelled');
      });
      thumbnailScheduler.reset({clearCache: true});
    }
    groupedDemandPaths.clear();
  }

  function generationIsCurrent(generation) {
    return active && generation.id === runId && abortController === generation.controller &&
      !(generation.signal && generation.signal.aborted);
  }

  function ensureThumbnailScheduler() {
    if (thumbnailScheduler) return thumbnailScheduler;
    thumbnailScheduler = createPhotoMapThumbnailScheduler({
      imageFactory: function () { return new win.Image(); },
      isCurrent: function () {
        return active && thumbnailGenerationId === runId;
      },
      onState: function (item, state) {
        if (!mapController) return;
        var path = item.path || item.photoMapSourcePath;
        var grouped = typeof mapController.setGroupedMemberThumbnailState === 'function' &&
          mapController.setGroupedMemberThumbnailState(path, state);
        if (!grouped && typeof mapController.setMarkerThumbnailState === 'function') {
          mapController.setMarkerThumbnailState(path, state);
        }
      },
      onResult: function (item, result) {
        if (result && result.status === 'loaded') {
          diagnostics.increment('thumbnailCompleted');
          if (isActiveGroupedMemberPath(item)) diagnostics.increment('groupedThumbnailCompleted');
          applyThumbnailResult(item, result);
        } else if (result && result.reason === 'thumbnail-load-failure') {
          diagnostics.increment('thumbnailErrors');
          if (isActiveGroupedMemberPath(item)) diagnostics.increment('groupedThumbnailErrors');
        }
      },
    });
    return thumbnailScheduler;
  }

  function itemSourcePath(item) {
    return String((item && (item.photoMapSourcePath || item.path)) || '');
  }

  function isActiveGroupedMemberPath(item) {
    if (!activeGroupedPopup || !item) return false;
    var path = itemSourcePath(item);
    return (activeGroupedPopup.group.photoMapGroupMembers || []).some(function (member) {
      return itemSourcePath(member) === path;
    });
  }

  function groupedPopupIsVisible() {
    if (!activeGroupedPopup || !mapController || typeof mapController.getVisibleMarkerItems !== 'function') return false;
    var visibleItems = mapController.getVisibleMarkerItems();
    return visibleItems.some(function (item) {
      return itemSourcePath(item) === itemSourcePath(activeGroupedPopup.group);
    });
  }

  function groupedPopupItems(group, visibleMembers) {
    var members = Array.isArray(group && group.photoMapGroupMembers) ? group.photoMapGroupMembers : [];
    var paths = new Set((Array.isArray(visibleMembers) ? visibleMembers : []).map(itemSourcePath));
    return members.filter(function (member) { return paths.has(itemSourcePath(member)); });
  }

  function groupedPinThumbnailItems(items) {
    return (Array.isArray(items) ? items : []).map(function (group) {
      var wanted = itemSourcePath({path: group && group.photoMapGroupThumbnailPath});
      var members = Array.isArray(group && group.photoMapGroupMembers) ? group.photoMapGroupMembers : [];
      return members.find(function (member) { return itemSourcePath(member) === wanted; }) || null;
    }).filter(Boolean);
  }

  function prioritizeGroupedPopupThumbnails(items) {
    return (Array.isArray(items) ? items : []).map(function (item, index) {
      var selected = itemSourcePath(item) === selectedGroupedMemberPath;
      // Group-grid cells are what the user is actively reading. Give them a
      // dedicated priority band ahead of ordinary map pins, with the selected
      // cell first, while continuing to use the one shared browser scheduler.
      return Object.assign({}, item, {
        photoMapThumbnailPriority: selected ? -2000000 : -1000000 + index,
      });
    });
  }

  function refreshThumbnailDemand(visibleMarkerItemsOverride) {
    if (!active) return;
    var scheduler = ensureThumbnailScheduler();
    var visibleMarkerItems = Array.isArray(visibleMarkerItemsOverride)
      ? visibleMarkerItemsOverride
      : (mapController && typeof mapController.getVisibleMarkerItems === 'function'
        ? mapController.getVisibleMarkerItems() : []);
    if (!Array.isArray(visibleMarkerItems)) visibleMarkerItems = [];
    var visibleIndividualItems = visibleMarkerItems.filter(function (item) { return !item.photoMapGrouped; });
    var visibleGroupThumbnailItems = groupedPinThumbnailItems(visibleMarkerItems.filter(function (item) {
      return item.photoMapGrouped;
    }));
    var visiblePinThumbnailItems = visibleIndividualItems.concat(visibleGroupThumbnailItems);
    var visibleItems = selectPhotoMapThumbnailItems(visiblePinThumbnailItems, {
      metadataResults: metadataResults,
      visiblePaths: visiblePinThumbnailItems.map(itemSourcePath),
      selectedPath: selectedThumbnailPath,
    });
    var groupedItems = [];
    if (activeGroupedPopup && groupedPopupIsVisible()) {
      groupedItems = selectPhotoMapThumbnailItems(
        prioritizeGroupedPopupThumbnails(
          groupedPopupItems(activeGroupedPopup.group, activeGroupedPopup.visibleMembers),
        ),
        {
          metadataResults: metadataResults,
          visiblePaths: activeGroupedPopup.visibleMembers.map(itemSourcePath),
          selectedPath: selectedGroupedMemberPath,
        },
      );
      visibleItems = visibleItems.concat(groupedItems);
    }
    var inFlightBeforeUpdate = new Set(
      scheduler.getActivePaths().concat(scheduler.getPendingPaths()),
    );
    var nextGroupedPaths = new Set(groupedItems.map(itemSourcePath));
    inFlightBeforeUpdate.forEach(function (path) {
      if (groupedDemandPaths.has(path) && !nextGroupedPaths.has(path)) {
        diagnostics.increment('groupedThumbnailCancelled');
      }
    });
    groupedDemandPaths = nextGroupedPaths;
    diagnostics.increment('thumbnailQueued', visibleItems.length);
    diagnostics.increment('groupedThumbnailQueued', groupedItems.length);
    scheduler.update(visibleItems, {
      selectedPath: selectedGroupedMemberPath || selectedThumbnailPath,
    });
  }

  function syncVisiblePinThumbnails(items) {
    if (!active) return;
    // Group members get their own demand-driven popup queue in the grouped
    // preview step. Do not eagerly request hundreds of hidden members merely
    // because their aggregate pin is visible.
    // The current map visibility is authoritative for an open grouped popup;
    // refreshThumbnailDemand re-evaluates it before combining the two queues.
    refreshThumbnailDemand(items);
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
      var locatedItems = summary.locatedItems.map(function (item) {
        var thumbnail = thumbnailResults.get(item.path);
        return thumbnail && thumbnail.url
          ? Object.assign({}, item, {photoMapThumbnailUrl: thumbnail.url})
          : item;
      });
      var markerItems = groupPhotoMapItems(locatedItems, currentGroupingDistance());
      var groupedItems = markerItems.filter(function (item) { return item.photoMapGrouped; });
      diagnostics.setGroupedState({
        groupCount: groupedItems.length,
        groupedMemberCount: groupedItems.reduce(function (total, item) {
          return total + Number(item.photoMapGroupCount || 0);
        }, 0),
        groupingDistanceMeters: currentGroupingDistance(),
      });
      mapController.setMarkerItems(markerItems);
      if (activeGroupedPopup) {
        var activePath = itemSourcePath(activeGroupedPopup.group);
        var currentGroup = markerItems.find(function (item) {
          return item.photoMapGrouped && itemSourcePath(item) === activePath;
        });
        if (!currentGroup) {
          activeGroupedPopup = null;
          selectedGroupedMemberPath = '';
        } else {
          var currentMembers = new Set((currentGroup.photoMapGroupMembers || []).map(itemSourcePath));
          activeGroupedPopup.group = currentGroup;
          activeGroupedPopup.visibleMembers = activeGroupedPopup.visibleMembers.filter(function (member) {
            return currentMembers.has(itemSourcePath(member));
          });
        }
        refreshThumbnailDemand();
      }
      if (markerItems.length > 0 && !mapFittedToResults && !mapUserInteracted &&
          typeof mapController.fitToItems === 'function') {
        fittingMap = true;
        mapFittedToResults = mapController.fitToItems(markerItems);
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
      mapController = createPhotoMap(leaflet, doc.getElementById('photo-map-map'), {
        onMarkerSelect: handleMarkerSelection,
        onVisibleMarkers: syncVisiblePinThumbnails,
        onGroupedPopupOpen: openGroupedPopup,
        onGroupedPopupScroll: updateGroupedPopupViewport,
        onGroupedPopupClose: closeGroupedPopup,
        onGroupedMemberSelect: selectGroupedMember,
        debug: debugEnabled,
        console: config.console || win.console,
      });
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

  function currentGroupingDistance() {
    var value = groupingDistanceEl
      ? Number(groupingDistanceEl.value)
      : PHOTO_MAP_GROUPING_DISTANCE_DEFAULT_METERS;
    return Number.isFinite(value) && value >= 0
      ? value
      : PHOTO_MAP_GROUPING_DISTANCE_DEFAULT_METERS;
  }

  function updateCustomRangeVisibility() {
    var preset = currentRange().preset;
    var visible = !!(PHOTO_MAP_DATE_PRESETS[preset] && PHOTO_MAP_DATE_PRESETS[preset].usesFromTo);
    if (!dateInputDefaultsInitialized) {
      var today = new Date();
      var todayValue = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') +
        '-' + String(today.getDate()).padStart(2, '0');
      if (dateFromEl && !dateFromEl.value) dateFromEl.value = PHOTO_MAP_DEFAULT_FROM_DATE;
      if (dateToEl && !dateToEl.value) dateToEl.value = todayValue;
      if (dateFromEl) dateFromEl.max = todayValue;
      if (dateToEl) dateToEl.max = todayValue;
      dateInputDefaultsInitialized = true;
    }
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
    thumbnailGenerationId = generation.id;
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
        // A previous generation may have accepted records just before a
        // refresh or folder change. Let those persistence writes settle
        // before reading the cache for the new generation.
        await cacheWriteTail;
        if (!generationIsCurrent(generation)) return [];
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

      var cacheWriter = createCacheWriter(snapshot.path, generation);
      activeCacheWriter = cacheWriter;
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
            else if (result && result.status === 'unsupported') diagnostics.increment('metadataUnsupported');
            else diagnostics.increment('metadataErrors');
            metadataResults.set(item.path, result);
            cacheWriter.enqueue(item, result);
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
      await cacheWriter.finish();
      if (activeCacheWriter === cacheWriter) activeCacheWriter = null;
      if (!generationIsCurrent(generation)) return [];
      renderMapResults('complete');
      diagnostics.logSummary('Photo Map generation complete', {
        candidates: candidates.length,
        metadataResults: metadataResults.size,
      });
      return candidates.slice();
    } catch (error) {
      if (!generationIsCurrent(generation)) return [];
      if (activeCacheWriter) activeCacheWriter.cancel();
      activeCacheWriter = null;
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

  function applyGroupingDistance() {
    if (active) renderMapResults('progressive');
  }

  function refresh() {
    if (active) loadCandidates();
  }

  function setDebugEnabled(value) {
    debugEnabled = Boolean(value);
    if (mapController && typeof mapController.setDebugEnabled === 'function') {
      mapController.setDebugEnabled(debugEnabled);
    }
    return debugEnabled;
  }

  function applyThumbnailResult(item, result) {
    if (!item || !result || result.status !== 'loaded' || !result.url) return;
    var path = String(item.path || item.photoMapSourcePath || '');
    thumbnailResults.set(path, result);
    if (mapController) {
      var grouped = typeof mapController.setGroupedMemberThumbnail === 'function' &&
        mapController.setGroupedMemberThumbnail(path, result);
      if (!grouped && typeof mapController.setMarkerThumbnail === 'function') {
        mapController.setMarkerThumbnail(path, result);
      }
    }
  }

  function openGroupedPopup(group, visibleMembers) {
    if (!active || !group || !group.photoMapGrouped) return;
    activeGroupedPopup = {
      group: group,
      visibleMembers: Array.isArray(visibleMembers) && visibleMembers.length
        ? visibleMembers.slice() : (group.photoMapGroupMembers || []).slice(0, 16),
    };
    selectedGroupedMemberPath = '';
    refreshThumbnailDemand();
  }

  function updateGroupedPopupViewport(group, visibleMembers) {
    if (!activeGroupedPopup || itemSourcePath(activeGroupedPopup.group) !== itemSourcePath(group)) return;
    activeGroupedPopup.visibleMembers = Array.isArray(visibleMembers) ? visibleMembers.slice() : [];
    refreshThumbnailDemand();
  }

  function closeGroupedPopup(group) {
    if (!activeGroupedPopup || !group || itemSourcePath(activeGroupedPopup.group) !== itemSourcePath(group)) return;
    activeGroupedPopup = null;
    selectedGroupedMemberPath = '';
    refreshThumbnailDemand();
  }

  function selectGroupedMember(group, member) {
    if (!activeGroupedPopup || itemSourcePath(activeGroupedPopup.group) !== itemSourcePath(group)) {
      openGroupedPopup(group, [member].filter(Boolean));
    }
    selectedGroupedMemberPath = member ? itemSourcePath(member) : '';
    refreshThumbnailDemand();
  }

  function handleMarkerSelection(item) {
    if (!active || !item) return;
    if (item.photoMapGrouped) {
      openGroupedPopup(item);
      return;
    }
    var path = String(item.path || item.photoMapSourcePath || '');
    selectedThumbnailPath = path;
    var cachedThumbnail = thumbnailResults.get(path);
    if (cachedThumbnail) {
      if (mapController && typeof mapController.setMarkerThumbnail === 'function') {
        mapController.setMarkerThumbnail(path, cachedThumbnail);
      }
      return;
    }
    requestThumbnails([item], {selectedPath: path});
  }

  function capturePreviewContext() {
    var map = mapController && mapController.map;
    var center = map && typeof map.getCenter === 'function' ? map.getCenter() : null;
    var popupGrid = doc.querySelector('.photo-map-group-grid');
    return {
      center: center && Number.isFinite(Number(center.lat)) && Number.isFinite(Number(center.lng))
        ? {lat: Number(center.lat), lng: Number(center.lng)} : null,
      zoom: map && typeof map.getZoom === 'function' ? map.getZoom() : null,
      popupPath: mapController && typeof mapController.getActivePopupPath === 'function'
        ? mapController.getActivePopupPath() : null,
      selectedThumbnailPath: selectedThumbnailPath,
      selectedGroupedMemberPath: selectedGroupedMemberPath,
      groupScrollTop: popupGrid ? popupGrid.scrollTop : null,
    };
  }

  function restorePreviewContext(context) {
    if (!context) return;
    var map = mapController && mapController.map;
    if (map && context.center && typeof map.setView === 'function') {
      var restoreZoom = Number.isFinite(Number(context.zoom)) ? Number(context.zoom) : map.getZoom();
      map.setView([context.center.lat, context.center.lng], restoreZoom, {animate: false});
    }
    selectedThumbnailPath = String(context.selectedThumbnailPath || '');
    selectedGroupedMemberPath = String(context.selectedGroupedMemberPath || '');
    if (context.popupPath && mapController && typeof mapController.openPopupForPath === 'function') {
      mapController.openPopupForPath(context.popupPath);
      var restorePopupState = function () {
        if (context.selectedGroupedMemberPath && activeGroupedPopup &&
            Array.isArray(activeGroupedPopup.group.photoMapGroupMembers)) {
          var selectedMember = activeGroupedPopup.group.photoMapGroupMembers.find(function (member) {
            return itemSourcePath(member) === context.selectedGroupedMemberPath;
          });
          if (selectedMember) selectGroupedMember(activeGroupedPopup.group, selectedMember);
        }
        var popupGrid = doc.querySelector('.photo-map-group-grid');
        if (popupGrid && Number.isFinite(Number(context.groupScrollTop))) {
          popupGrid.scrollTop = Number(context.groupScrollTop);
        }
      };
      if (typeof win.requestAnimationFrame === 'function') win.requestAnimationFrame(restorePopupState);
      else win.setTimeout(restorePopupState, 0);
    }
  }

  function requestThumbnails(items, options) {
    var config = options || {};
    if (!active) return Promise.resolve({results: [], aborted: true, queued: false});
    var scheduler = ensureThumbnailScheduler();
    var requestItems = selectPhotoMapThumbnailItems(items, Object.assign({}, config, {
      metadataResults: metadataResults,
    }));
    diagnostics.increment('thumbnailQueued', requestItems.length);
    scheduler.promote(requestItems[0] || (Array.isArray(items) ? items[0] : null));
    if (typeof config.onResult === 'function') {
      // Preserve the old extension point for callers that used the explicit
      // click queue. Results from the persistent scheduler still flow through
      // the shared host callback above.
      requestItems.forEach(function (item) {
        if (thumbnailResults.has(item.path)) config.onResult(item, thumbnailResults.get(item.path));
      });
    }
    return Promise.resolve({results: [], aborted: false, queued: requestItems.length > 0});
  }

  function initialPaneMode() {
    if (!win.Settings || typeof win.Settings.get !== 'function') return 'server-log';
    return win.Settings.get('bottom-pane-mode', 'server-log');
  }

  if (dateRangeEl) dateRangeEl.addEventListener('change', applyDateRange);
  if (dateFromEl) dateFromEl.addEventListener('change', applyDateRange);
  if (dateToEl) dateToEl.addEventListener('change', applyDateRange);
  if (groupingDistanceEl) groupingDistanceEl.addEventListener('change', applyGroupingDistance);
  if (refreshEl) refreshEl.addEventListener('click', refresh);
  win.addEventListener('resize', invalidateMapSize);
  win.addEventListener('beforeunload', deactivate);
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
  win.DropboxBrowserPhotoMap.getGroupingDistance = currentGroupingDistance;
  win.DropboxBrowserPhotoMap.setGroupingDistance = function (value) {
    if (!groupingDistanceEl) return currentGroupingDistance();
    groupingDistanceEl.value = String(value);
    applyGroupingDistance();
    return currentGroupingDistance();
  };
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
  win.DropboxBrowserPhotoMap.setDebugEnabled = setDebugEnabled;
  win.DropboxBrowserPhotoMap.isDebugEnabled = function () { return debugEnabled; };
  win.DropboxBrowserPhotoMap.getMap = function () { return mapController ? mapController.map : null; };
  win.DropboxBrowserPhotoMap.capturePreviewContext = capturePreviewContext;
  win.DropboxBrowserPhotoMap.restorePreviewContext = restorePreviewContext;
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
