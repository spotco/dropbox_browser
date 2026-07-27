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
import {createPhotoMapThumbnailStore} from './photo-map/thumbnail-store.js';
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
  var thumbnailStore = createPhotoMapThumbnailStore();
  var abortController = null;
  var thumbnailScheduler = null;
  var mapController = null;
  var mapResizeObserver = null;
  var activeCacheWriter = null;
  var cacheWriteTail = Promise.resolve();
  var clientLogger = win.ClientLogger || null;
  var clientPhotoMapLogging = Boolean(clientLogger && typeof clientLogger.enabledFor === 'function' &&
    clientLogger.enabledFor('photo-map'));
  var debugEnabled = config.photoMapDebug === undefined ? clientPhotoMapLogging : Boolean(config.photoMapDebug);
  var diagnostics = createPhotoMapDiagnostics(win);
  var mapUserInteracted = false;
  var mapFittedToResults = false;
  var fittingMap = false;
  var mapInteractionHandler = null;
  var thumbnailGenerationId = 0;
  var selectedThumbnailPath = '';
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
    thumbnailStore.clear();
    activeGroupedPopup = null;
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
      onState: function (item, state, details) {
        var path = itemSourcePath(item);
        var previous = thumbnailStore.get(path);
        var stored = thumbnailStore.setState(item, state, {
          reason: details && details.reason || 'scheduler-state-update',
          generation: runId,
        });
        if (!stored || (previous && previous.state === stored.state && previous.url === stored.url)) return;
        diagnostics.logEvent('thumbnail-state', {
          path: path,
          mediaKind: item && (item.mediaKind || item.photoMapMediaKind) || 'photo',
          state: state,
          reason: details && details.reason || '',
          grouped: isActiveGroupedMemberPath(item),
          selectedPath: selectedGroupedPath() || selectedThumbnailPath,
        });
        if (!mapController) return;
        var path = item.path || item.photoMapSourcePath;
        var grouped = typeof mapController.setGroupedMemberThumbnailState === 'function' &&
          mapController.setGroupedMemberThumbnailState(path, state);
        if (!grouped && typeof mapController.setMarkerThumbnailState === 'function') {
          mapController.setMarkerThumbnailState(path, state);
        }
      },
      onResult: function (item, result) {
        diagnostics.logEvent('thumbnail-result', {
          path: itemSourcePath(item),
          mediaKind: item && (item.mediaKind || item.photoMapMediaKind) || 'photo',
          status: result && result.status || 'unknown',
          reason: result && result.reason || '',
          grouped: isActiveGroupedMemberPath(item),
        });
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

  function activeGroupedPopupPath() {
    return activeGroupedPopup ? String(activeGroupedPopup.groupPath || '') : '';
  }

  function activeGroupedPopupGroup() {
    if (!activeGroupedPopup || !mapController || typeof mapController.getMarkerItem !== 'function') return null;
    return mapController.getMarkerItem(activeGroupedPopupPath());
  }

  function activeGroupedPopupMembers() {
    var group = activeGroupedPopupGroup();
    return group && Array.isArray(group.photoMapGroupMembers) ? group.photoMapGroupMembers : [];
  }

  function selectedGroupedPath() {
    return activeGroupedPopup ? String(activeGroupedPopup.selectedMemberPath || '') : '';
  }

  function setSelectedGroupedPath(path) {
    if (activeGroupedPopup) activeGroupedPopup.selectedMemberPath = String(path || '');
  }

  function isActiveGroupedMemberPath(item) {
    if (!activeGroupedPopup || !item) return false;
    var path = itemSourcePath(item);
    return activeGroupedPopupMembers().some(function (member) {
      return itemSourcePath(member) === path;
    });
  }

  function groupedPopupIsVisible() {
    if (!activeGroupedPopup || !mapController || typeof mapController.getVisibleMarkerItems !== 'function') return false;
    var visibleItems = mapController.getVisibleMarkerItems();
    return visibleItems.some(function (item) {
      return itemSourcePath(item) === activeGroupedPopupPath();
    });
  }

  function groupedPopupIsDemandSource() {
    if (!activeGroupedPopup || !mapController) return false;
    // A mounted Leaflet popup is authoritative while its marker is being
    // restored. Map bounds/cluster visibility can lag behind the popup DOM for
    // one or more move frames; dropping the group demand in that interval is
    // what previously left the selected grid rendered with an empty scheduler.
    if (typeof mapController.getActivePopupPath === 'function' &&
        activeGroupedPopupPath() === mapController.getActivePopupPath()) {
      return true;
    }
    return groupedPopupIsVisible();
  }

  function groupedPopupItems(group, visibleMembers) {
    var members = Array.isArray(group && group.photoMapGroupMembers) ? group.photoMapGroupMembers : [];
    var paths = new Set((Array.isArray(visibleMembers) ? visibleMembers : []).map(function (member) {
      return typeof member === 'string' ? member : itemSourcePath(member);
    }));
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
      var selected = itemSourcePath(item) === selectedGroupedPath();
      // Group-grid cells are what the user is actively reading. Give them a
      // dedicated priority band ahead of ordinary map pins, with the selected
      // cell first, while continuing to use the one shared browser scheduler.
      return Object.assign({}, item, {
        photoMapThumbnailPriority: selected ? -2000000 : -1000000 + index,
      });
    });
  }

  function refreshThumbnailDemand(visibleMarkerItemsOverride, reason) {
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
    if (activeGroupedPopup && groupedPopupIsDemandSource()) {
      groupedItems = selectPhotoMapThumbnailItems(
        prioritizeGroupedPopupThumbnails(
          groupedPopupItems(activeGroupedPopupGroup(), activeGroupedPopup.visibleMemberPaths),
        ),
        {
          metadataResults: metadataResults,
          visiblePaths: activeGroupedPopup.visibleMemberPaths,
          selectedPath: selectedGroupedPath(),
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
      selectedPath: selectedGroupedPath() || selectedThumbnailPath,
      reason: reason || 'viewport-refresh',
    });
  }

  function syncVisiblePinThumbnails(items) {
    if (!active) return;
    // Group members get their own demand-driven popup queue in the grouped
    // preview step. Do not eagerly request hundreds of hidden members merely
    // because their aggregate pin is visible.
    // The current map visibility is authoritative for an open grouped popup;
    // refreshThumbnailDemand re-evaluates it before combining the two queues.
    refreshThumbnailDemand(items, 'map-visibility-refresh');
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
        var thumbnail = thumbnailStore.getResult(item.path);
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
        var activePath = activeGroupedPopupPath();
        var currentGroup = markerItems.find(function (item) {
          return item.photoMapGrouped && itemSourcePath(item) === activePath;
        });
        if (!currentGroup) {
          activeGroupedPopup = null;
          groupedDemandPaths.clear();
        } else {
          var currentMembers = new Set((currentGroup.photoMapGroupMembers || []).map(itemSourcePath));
          activeGroupedPopup.memberPaths = activeGroupedPopup.memberPaths.filter(function (path) {
            return currentMembers.has(path);
          });
          activeGroupedPopup.visibleMemberPaths = activeGroupedPopup.visibleMemberPaths.filter(function (path) {
            return currentMembers.has(path);
          });
          if (!currentMembers.has(selectedGroupedPath())) setSelectedGroupedPath('');
        }
        refreshThumbnailDemand(undefined, 'data-generation-changed');
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
        document: doc,
        window: win,
        getThumbnailForPath: function (path) {
          var result = thumbnailStore.getResult(path);
          var state = thumbnailStore.get(path);
          if (!result && !state) return null;
          return {url: result && result.url || '', state: state && state.state || 'idle'};
        },
        onMarkerSelect: handleMarkerSelection,
        onVisibleMarkers: syncVisiblePinThumbnails,
        onGroupedPopupOpen: openGroupedPopup,
        onGroupedPopupScroll: updateGroupedPopupViewport,
        onGroupedPopupClose: closeGroupedPopup,
        onGroupedMemberSelect: selectGroupedMember,
        debug: debugEnabled,
        clientLogger: clientLogger,
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
    var storedResult = thumbnailStore.setResult(item, result);
    if (!storedResult) return;
    diagnostics.logEvent('thumbnail-applied', {
      path: path,
      url: result.url,
      grouped: isActiveGroupedMemberPath(item),
    });
    if (mapController) {
      var grouped = typeof mapController.setGroupedMemberThumbnail === 'function' &&
        mapController.setGroupedMemberThumbnail(path, storedResult);
      if (!grouped && typeof mapController.setMarkerThumbnail === 'function') {
        mapController.setMarkerThumbnail(path, storedResult);
      }
    }
  }

  function openGroupedPopup(group, visibleMembers) {
    if (!active || !group || !group.photoMapGrouped) return;
    var groupPath = itemSourcePath(group);
    var memberPaths = (Array.isArray(group.photoMapGroupMembers) ? group.photoMapGroupMembers : [])
      .map(itemSourcePath);
    var visibleMemberPaths = Array.isArray(visibleMembers) && visibleMembers.length
      ? visibleMembers.map(itemSourcePath) : memberPaths.slice(0, 16);
    activeGroupedPopup = {
      groupPath: groupPath,
      memberPaths: memberPaths,
      visibleMemberPaths: visibleMemberPaths,
      selectedMemberPath: '',
      scrollTop: null,
      popupLayoutVersion: 0,
    };
    diagnostics.logEvent('group-popup-open', {
      path: groupPath,
      memberCount: memberPaths.length,
      visibleMemberCount: visibleMemberPaths.length,
      selectedMemberPath: selectedGroupedPath(),
    });
    refreshThumbnailDemand(undefined, 'group-popup-open');
  }

  function updateGroupedPopupViewport(group, visibleMembers) {
    if (!activeGroupedPopup || activeGroupedPopupPath() !== itemSourcePath(group)) return;
    activeGroupedPopup.visibleMemberPaths = Array.isArray(visibleMembers)
      ? visibleMembers.map(itemSourcePath) : [];
    activeGroupedPopup.scrollTop = mapController && typeof mapController.getDebugState === 'function'
      ? mapController.getDebugState().gridScrollTop : activeGroupedPopup.scrollTop;
    diagnostics.logEvent('group-popup-viewport', {
      path: itemSourcePath(group),
      visibleMemberCount: activeGroupedPopup.visibleMemberPaths.length,
      selectedMemberPath: selectedGroupedPath(),
    });
    refreshThumbnailDemand(undefined, 'group-popup-scroll');
  }

  function closeGroupedPopup(group) {
    if (!activeGroupedPopup || !group || activeGroupedPopupPath() !== itemSourcePath(group)) return;
    diagnostics.logEvent('group-popup-close', {
      path: itemSourcePath(group),
      selectedMemberPath: selectedGroupedPath(),
      visibleMemberCount: activeGroupedPopup.visibleMemberPaths.length,
    });
    activeGroupedPopup = null;
    refreshThumbnailDemand(undefined, 'popup-closed');
  }

  function selectGroupedMember(group, member) {
    if (!activeGroupedPopup || activeGroupedPopupPath() !== itemSourcePath(group)) {
      openGroupedPopup(group, [member].filter(Boolean));
    }
    var previousPath = selectedGroupedPath();
    setSelectedGroupedPath(member ? itemSourcePath(member) : '');
    diagnostics.logEvent('group-member-select', {
      groupPath: itemSourcePath(group),
      previousMemberPath: previousPath,
      selectedMemberPath: selectedGroupedPath(),
      mediaKind: member && (member.mediaKind || member.photoMapMediaKind) || '',
    });
    refreshThumbnailDemand(undefined, 'group-member-selection');
  }

  function handleMarkerSelection(item) {
    if (!active || !item) return;
    diagnostics.logEvent('marker-select', {
      path: itemSourcePath(item),
      grouped: !!item.photoMapGrouped,
      mediaKind: item.mediaKind || item.photoMapMediaKind || '',
      selectedThumbnailPath: selectedThumbnailPath,
      selectedGroupedMemberPath: selectedGroupedPath(),
    });
    if (item.photoMapGrouped) {
      openGroupedPopup(item);
      return;
    }
    var path = String(item.path || item.photoMapSourcePath || '');
    selectedThumbnailPath = path;
    var cachedThumbnail = thumbnailStore.getResult(path);
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
    var context = {
      center: center && Number.isFinite(Number(center.lat)) && Number.isFinite(Number(center.lng))
        ? {lat: Number(center.lat), lng: Number(center.lng)} : null,
      zoom: map && typeof map.getZoom === 'function' ? map.getZoom() : null,
      popupPath: mapController && typeof mapController.getActivePopupPath === 'function'
        ? mapController.getActivePopupPath() : null,
      selectedThumbnailPath: selectedThumbnailPath,
      selectedGroupedMemberPath: selectedGroupedPath(),
      groupScrollTop: popupGrid ? popupGrid.scrollTop : null,
    };
    diagnostics.logEvent('preview-context-capture', context);
    return context;
  }

  function restorePreviewContext(context) {
    if (!context) return;
    diagnostics.logEvent('preview-context-restore-start', {
      popupPath: context.popupPath,
      contextSelectedMemberPath: context.selectedGroupedMemberPath,
      currentSelectedMemberPath: selectedGroupedPath(),
      selectedThumbnailPath: context.selectedThumbnailPath,
    });
    var map = mapController && mapController.map;
    var currentCenter = map && typeof map.getCenter === 'function' ? map.getCenter() : null;
    var restoreZoom = map && typeof map.getZoom === 'function' ? map.getZoom() : null;
    var centerMatches = !!(currentCenter && context.center &&
      Math.abs(Number(currentCenter.lat) - Number(context.center.lat)) < 1e-7 &&
      Math.abs(Number(currentCenter.lng) - Number(context.center.lng)) < 1e-7);
    var zoomMatches = context.zoom == null || restoreZoom == null ||
      Number(context.zoom) === Number(restoreZoom);
    if (map && context.center && typeof map.setView === 'function' && (!centerMatches || !zoomMatches)) {
      var targetZoom = Number.isFinite(Number(context.zoom)) ? Number(context.zoom) : restoreZoom;
      map.setView([context.center.lat, context.center.lng], targetZoom, {animate: false});
    }
    var contextGroupedMemberPath = String(context.selectedGroupedMemberPath || '');
    // Closing the overlay is asynchronous. A user can select another group
    // member while that close is waiting, before this restore function runs.
    // Preserve that newer selection instead of replacing it with the stale
    // preview context (including an intentional return to the group grid).
    var groupedMemberPathBeforeRestore = selectedGroupedPath();
    var hasNewerGroupedSelection = !!activeGroupedPopup &&
      groupedMemberPathBeforeRestore !== contextGroupedMemberPath;
    diagnostics.logEvent('preview-context-restore-selection-check', {
      popupPath: context.popupPath,
      contextSelectedMemberPath: contextGroupedMemberPath,
      currentSelectedMemberPath: groupedMemberPathBeforeRestore,
      preservedNewerSelection: hasNewerGroupedSelection,
    });
    selectedThumbnailPath = String(context.selectedThumbnailPath || '');
    if (!hasNewerGroupedSelection) setSelectedGroupedPath(contextGroupedMemberPath);
    if (context.popupPath && mapController && typeof mapController.openPopupForPath === 'function') {
      var popupIsMounted = false;
      if (typeof mapController.getActivePopupPath === 'function' &&
          mapController.getActivePopupPath() === context.popupPath &&
          typeof mapController.getDebugState === 'function') {
        popupIsMounted = !!mapController.getDebugState().popupMounted;
      }
      var restoreGroupedMember = function (path) {
        if (!path) return false;
        // The map owns the mounted popup DOM and its selected-cell state.
        // Restoring only this host's selected path leaves the popup's grid in
        // its initial state after a full-screen preview is dismissed.
        if (typeof mapController.showGroupedMemberForPath === 'function' &&
            mapController.showGroupedMemberForPath(context.popupPath, path)) return true;
        var currentGroup = activeGroupedPopupGroup();
        if (!currentGroup || !Array.isArray(currentGroup.photoMapGroupMembers)) return false;
        var selectedMember = currentGroup.photoMapGroupMembers.find(function (member) {
          return itemSourcePath(member) === path;
        });
        if (!selectedMember) return false;
        selectGroupedMember(currentGroup, selectedMember);
        return true;
      };
      var restorePopupState = function () {
        var restorePath = hasNewerGroupedSelection
          ? groupedMemberPathBeforeRestore : contextGroupedMemberPath;
        if (restorePath && activeGroupedPopup) setSelectedGroupedPath(restorePath);
        // The popup can be clicked before this animation-frame callback runs.
        // In that case the user's newer selection has already updated the
        // host path and must win over the stale preview context.
        if (restorePath && activeGroupedPopup && activeGroupedPopup.memberPaths.indexOf(restorePath) !== -1) {
          restoreGroupedMember(restorePath);
        }
        var popupGrid = doc.querySelector('.photo-map-group-grid');
        if (popupGrid && Number.isFinite(Number(context.groupScrollTop))) {
          popupGrid.scrollTop = Number(context.groupScrollTop);
        }
        if (typeof mapController.fitOpenPopupIntoView === 'function') {
          mapController.fitOpenPopupIntoView(context.popupPath);
        }
        diagnostics.logEvent('preview-context-restore-applied', {
          popupPath: context.popupPath,
          selectedMemberPath: selectedGroupedPath(),
          preservedNewerSelection: hasNewerGroupedSelection,
        });
      };
      if (!popupIsMounted) mapController.openPopupForPath(context.popupPath);
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
        if (thumbnailStore.hasReady(item.path)) config.onResult(item, thumbnailStore.getResult(item.path));
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
  win.DropboxBrowserPhotoMap.getDebugState = function () {
    return {
      active: active,
      selectedThumbnailPath: selectedThumbnailPath,
      selectedGroupedMemberPath: selectedGroupedPath(),
      activeGroupedPopupPath: activeGroupedPopupPath(),
      groupedDemandPaths: Array.from(groupedDemandPaths),
      thumbnailResultPaths: thumbnailStore.readyPaths(),
      thumbnailStore: thumbnailStore.snapshot(),
      thumbnailScheduler: thumbnailScheduler && typeof thumbnailScheduler.getDebugState === 'function'
        ? thumbnailScheduler.getDebugState() : null,
      diagnostics: diagnostics.snapshot(),
      map: mapController && typeof mapController.getDebugState === 'function'
        ? mapController.getDebugState() : null,
    };
  };
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
