import {buildPhotoMapFileUrl} from './parsers.js';

export const PHOTO_MAP_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const PHOTO_MAP_TILE_ATTRIBUTION = '&copy; OpenStreetMap contributors';
export const PHOTO_MAP_INITIAL_VIEW = [20, 0];
export const PHOTO_MAP_INITIAL_ZOOM = 2;
export const PHOTO_MAP_MIN_ZOOM = 1;
export const PHOTO_MAP_MAX_ZOOM = 19;
export const PHOTO_MAP_CLUSTER_RADIUS = 50;
export const PHOTO_MAP_FIT_MAX_ZOOM = 15;
export const PHOTO_MAP_DEBUG_DEFAULT = true;

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, function (character) {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[character];
  });
}

function markerLabel(item) {
  return String((item && (item.display_name || item.name || item.path)) || 'Photo Map media');
}

function markerIconHtml(item, state) {
  if (mediaKind(item) === 'video') return '';
  var label = escapeHtml(markerLabel(item));
  var url = item && item.photoMapThumbnailUrl;
  var thumbnail = url
    ? '<img class="photo-map-marker-thumbnail-image" src="' + escapeHtml(url) +
      '" alt="Thumbnail for ' + label + '">'
    : '<span class="photo-map-marker-thumbnail-loading" role="status" aria-label="Loading thumbnail">' +
      '<span aria-hidden="true">&hellip;</span></span>';
  var stateName = state || (url ? 'ready' : 'loading');
  return '<span class="photo-map-marker-visual photo-map-marker-state-' + escapeHtml(stateName) +
    '"><span class="photo-map-marker-thumbnail">' + thumbnail +
    '</span><span class="photo-map-marker-stem" aria-hidden="true"></span><span class="photo-map-marker-pin" aria-hidden="true"></span></span>';
}

function markerIcon(L, item, state) {
  if (typeof L.divIcon !== 'function' || mediaKind(item) === 'video') return null;
  return L.divIcon({
    className: 'photo-map-marker-icon',
    html: markerIconHtml(item, state),
    iconSize: [88, 110],
    iconAnchor: [44, 108],
    popupAnchor: [0, -106],
  });
}

function detailValue(value) {
  return value === null || value === undefined || value === '' ? 'Unavailable' : String(value);
}

function listingDateLabel(item) {
  var timestamp = item && Number.isFinite(item.listingDateMs)
    ? item.listingDateMs
    : (item && Number.isFinite(item.photoMapListingDateMs) ? item.photoMapListingDateMs : null);
  if (!Number.isFinite(timestamp)) return 'Unavailable';
  var date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? 'Unavailable' : date.toISOString();
}

function mediaKind(item) {
  return String((item && (item.mediaKind || item.photoMapMediaKind)) || 'photo');
}

function previewLink(item, content, label) {
  return '<a class="photo-map-preview-link" href="' +
    escapeHtml(buildPhotoMapFileUrl(item && (item.photoMapSourcePath || item.path))) +
    '" target="_blank" rel="noopener noreferrer" aria-label="' + escapeHtml(label) +
    '">' + content + '</a>';
}

function createPhotoMapDebugLogger(config) {
  var enabled = config.debug === undefined ? PHOTO_MAP_DEBUG_DEFAULT : Boolean(config.debug);
  var consoleImpl = config.console || (typeof console !== 'undefined' ? console : null);
  function log(event, details) {
    if (!enabled || !consoleImpl) return;
    var method = typeof consoleImpl.debug === 'function' ? consoleImpl.debug : consoleImpl.log;
    if (typeof method !== 'function') return;
    method.call(consoleImpl, '[Photo Map]', event, details || {});
  }
  return {
    log: log,
    setEnabled: function (value) { enabled = Boolean(value); },
    isEnabled: function () { return enabled; },
  };
}

function clusterDetails(event) {
  var cluster = event && (event.layer || event.cluster);
  var childCount = null;
  if (cluster && typeof cluster.getChildCount === 'function') childCount = cluster.getChildCount();
  return {
    childCount: childCount,
    hasLayer: !!cluster,
  };
}

function markerPopup(item) {
  var label = escapeHtml(markerLabel(item));
  var captureDate = item && (item.captureDate || item.capture_date);
  var latitude = item && Number.isFinite(item.latitude) ? item.latitude : 'Unavailable';
  var longitude = item && Number.isFinite(item.longitude) ? item.longitude : 'Unavailable';
  var thumbnailUrl = item && item.photoMapThumbnailUrl;
  var filename = markerLabel(item);
  var mediaPreview;
  if (thumbnailUrl) {
    mediaPreview = previewLink(item,
      '<img class="photo-map-preview-thumbnail" src="' + escapeHtml(thumbnailUrl) +
        '" alt="Thumbnail for ' + label + '">',
      'Open full preview for ' + filename,
    );
  } else if (mediaKind(item) === 'video') {
    mediaPreview = '<div class="photo-map-preview-video" role="img" aria-label="Video thumbnail unavailable">' +
      '<span class="photo-map-preview-video-icon" aria-hidden="true">&#9654;</span>' +
      '<span>Video thumbnail unavailable</span></div>' +
      previewLink(item, 'Open video preview', 'Open full preview for ' + filename);
  } else {
    mediaPreview = previewLink(item, '<span class="photo-map-preview-loading">Thumbnail loading&hellip;</span>',
      'Open full preview for ' + filename);
  }
  return '<article class="photo-map-preview" aria-label="Photo Map preview for ' + label + '">' +
    '<strong class="photo-map-preview-filename">' + label + '</strong>' +
    '<div class="photo-map-preview-media">' + mediaPreview + '</div>' +
    '<dl class="photo-map-preview-details">' +
      '<dt>Latitude</dt><dd>' + escapeHtml(detailValue(latitude)) + '</dd>' +
      '<dt>Longitude</dt><dd>' + escapeHtml(detailValue(longitude)) + '</dd>' +
      '<dt>Capture date</dt><dd>' + escapeHtml(detailValue(captureDate)) + '</dd>' +
      '<dt>Listing date</dt><dd>' + escapeHtml(listingDateLabel(item)) + '</dd>' +
    '</dl>' +
  '</article>';
}

export function createPhotoMap(L, element, options) {
  var config = options || {};
  var debug = createPhotoMapDebugLogger(config);
  var map = L.map(element, {
    minZoom: PHOTO_MAP_MIN_ZOOM,
    maxZoom: PHOTO_MAP_MAX_ZOOM,
    closePopupOnClick: false,
    worldCopyJump: true,
  });
  map.setView(PHOTO_MAP_INITIAL_VIEW, PHOTO_MAP_INITIAL_ZOOM);
  var tiles = L.tileLayer(PHOTO_MAP_TILE_URL, {
    attribution: PHOTO_MAP_TILE_ATTRIBUTION,
    minZoom: PHOTO_MAP_MIN_ZOOM,
    maxZoom: PHOTO_MAP_MAX_ZOOM,
  });
  tiles.addTo(map);
  var markerLayer = L.markerClusterGroup({maxClusterRadius: PHOTO_MAP_CLUSTER_RADIUS});
  markerLayer.addTo(map);
  debug.log('map-created', {
    minZoom: PHOTO_MAP_MIN_ZOOM,
    maxZoom: PHOTO_MAP_MAX_ZOOM,
    clusterRadius: PHOTO_MAP_CLUSTER_RADIUS,
  });
  if (typeof markerLayer.on === 'function') {
    ['clusterclick', 'clustermouseover', 'clustermouseout', 'spiderfied', 'unspiderfied',
      'animationstart', 'animationend'].forEach(function (eventName) {
      markerLayer.on(eventName, function (event) {
        if (eventName === 'unspiderfied') {
          setTimeout(function () {
            flushDeferredMarkerLayer();
            notifyVisibleMarkers();
          }, 0);
        } else if (eventName === 'spiderfied') {
          notifyVisibleMarkers();
        }
        debug.log('cluster-' + eventName, clusterDetails(event));
      });
    });
  }
  if (typeof map.on === 'function') {
    ['popupopen', 'popupclose', 'zoomstart', 'zoomend', 'moveend'].forEach(function (eventName) {
      map.on(eventName, function (event) {
        debug.log('map-' + eventName, {
          hasLayer: !!(event && event.layer),
          hasPopup: !!(event && event.popup),
        });
        if (eventName === 'moveend' || eventName === 'zoomend') notifyVisibleMarkers();
      });
    });
  }
  var markerEntries = new Map();
  var layerEntries = new Map();
  var layerSyncDeferred = false;
  var activePopupPath = null;

  function visibleMarkerItems() {
    var bounds = typeof map.getBounds === 'function' ? map.getBounds() : null;
    var canCheckParent = typeof markerLayer.getVisibleParent === 'function';
    return Array.from(markerEntries.values()).filter(function (entry) {
      var latLng = typeof entry.marker.getLatLng === 'function'
        ? entry.marker.getLatLng()
        : {lat: entry.latitude, lng: entry.longitude};
      if (bounds && typeof bounds.contains === 'function' && !bounds.contains(latLng)) return false;
      if (canCheckParent && markerLayer.getVisibleParent(entry.marker) !== entry.marker) return false;
      return true;
    }).map(function (entry) { return entry.item; });
  }

  function notifyVisibleMarkers() {
    if (typeof config.onVisibleMarkers === 'function') {
      config.onVisibleMarkers(visibleMarkerItems());
    }
  }

  function itemPath(item) {
    return String((item && (item.photoMapSourcePath || item.path)) || '');
  }

  function itemCoordinatesChanged(entry, item) {
    return entry.latitude !== item.latitude || entry.longitude !== item.longitude;
  }

  function updatePopupContent(entry) {
    var popup = markerPopup(entry.item);
    if (typeof entry.marker.setPopupContent === 'function') {
      entry.marker.setPopupContent(popup);
    } else if (typeof entry.marker.bindPopup === 'function') {
      // This fallback is only for older/test doubles. Leaflet's normal path
      // updates the existing popup without replacing the marker binding.
      entry.marker.bindPopup(popup);
    }
  }

  function createMarker(path, item) {
    var icon = markerIcon(L, item, item.photoMapThumbnailState);
    var markerOptions = {title: markerLabel(item)};
    if (icon) markerOptions.icon = icon;
    var marker = L.marker([item.latitude, item.longitude], markerOptions);
    var entry = {
      item: item,
      marker: marker,
      // MarkerClusterGroup temporarily changes marker.getLatLng() while a
      // cluster is spiderfied. Keep the source coordinates separately so
      // progressive metadata renders do not mistake spider legs for moves.
      latitude: item.latitude,
      longitude: item.longitude,
      layerLatitude: item.latitude,
      layerLongitude: item.longitude,
    };
    var popupWasOpenForClick = false;
    if (typeof marker.on === 'function') {
      // Leaflet's built-in popup handler is registered by bindPopup below.
      // Record the state before that handler runs so clicking the same pin
      // does not turn an open popup into an accidental toggle-close.
      marker.on('click', function () {
        popupWasOpenForClick = activePopupPath === path;
      });
    }
    if (typeof marker.bindPopup === 'function') {
      marker.bindPopup(markerPopup(item));
      debug.log('popup-bound', {path: path, hasThumbnail: !!item.photoMapThumbnailUrl});
    }
    if (typeof marker.on === 'function') {
      marker.on('click', function () {
        if (popupWasOpenForClick && typeof marker.isPopupOpen === 'function' &&
            !marker.isPopupOpen() && typeof marker.openPopup === 'function') {
          marker.openPopup();
        }
        popupWasOpenForClick = false;
      });
    }
    if (typeof marker.on === 'function' && typeof config.onMarkerSelect === 'function') {
      marker.on('click', function () {
        var current = markerEntries.get(path) || entry;
        debug.log('marker-click', {path: path, hasThumbnail: !!current.item.photoMapThumbnailUrl});
        config.onMarkerSelect(current.item, marker);
      });
    }
    if (typeof marker.on === 'function') {
      marker.on('popupopen', function () {
        activePopupPath = path;
        debug.log('marker-popupopen', {path: path});
      });
      marker.on('popupclose', function () {
        if (activePopupPath === path) activePopupPath = null;
        debug.log('marker-popupclose', {path: path});
      });
    }
    return entry;
  }

  function syncMarkerLayer() {
    if (markerLayer._spiderfied) {
      layerSyncDeferred = true;
      return false;
    }
    var removedEntries = [];
    layerEntries.forEach(function (entry, path) {
      if (!markerEntries.has(path)) removedEntries.push(entry);
    });
    var addedEntries = [];
    markerEntries.forEach(function (entry, path) {
      var previous = layerEntries.get(path);
      if (!previous) {
        addedEntries.push(entry);
      } else if (entry.layerLatitude !== entry.latitude || entry.layerLongitude !== entry.longitude) {
        if (typeof entry.marker.setLatLng === 'function') {
          entry.marker.setLatLng([entry.latitude, entry.longitude]);
        }
        entry.layerLatitude = entry.latitude;
        entry.layerLongitude = entry.longitude;
      }
    });
    var canReconcile = typeof markerLayer.addLayer === 'function' &&
      typeof markerLayer.removeLayer === 'function';
    if (canReconcile) {
      removedEntries.forEach(function (entry) { markerLayer.removeLayer(entry.marker); });
      addedEntries.forEach(function (entry) { markerLayer.addLayer(entry.marker); });
    } else {
      // Compatibility fallback for minimal Leaflet doubles; real
      // MarkerClusterGroup supports incremental addLayer/removeLayer.
      var markers = Array.from(markerEntries.values()).map(function (entry) { return entry.marker; });
      if (typeof markerLayer.clearLayers === 'function') markerLayer.clearLayers();
      if (typeof markerLayer.addLayers === 'function') markerLayer.addLayers(markers);
      else markers.forEach(function (marker) { markerLayer.addLayer(marker); });
      markerEntries.forEach(function (entry) {
        entry.layerLatitude = entry.latitude;
        entry.layerLongitude = entry.longitude;
      });
    }
    layerEntries = new Map(markerEntries);
    layerSyncDeferred = false;
    debug.log('marker-layer-synced', {
      added: addedEntries.length,
      removed: removedEntries.length,
    });
    return true;
  }

  function flushDeferredMarkerLayer() {
    if (layerSyncDeferred && !markerLayer._spiderfied) syncMarkerLayer();
  }

  function setMarkerItems(items) {
    var previousEntries = markerEntries;
    var nextEntries = new Map();
    var addedEntries = [];
    var changedEntries = [];
    var coordinatesChanged = false;
    var nextItems = Array.isArray(items) ? items : [];

    nextItems.forEach(function (item) {
      var path = itemPath(item);
      var previous = previousEntries.get(path);
      var markerItem = previous && previous.item.photoMapThumbnailUrl && !item.photoMapThumbnailUrl
        ? Object.assign({}, item, {photoMapThumbnailUrl: previous.item.photoMapThumbnailUrl})
        : item;
      if (previous && previous.item.photoMapThumbnailState && !item.photoMapThumbnailState) {
        markerItem = Object.assign({}, markerItem, {photoMapThumbnailState: previous.item.photoMapThumbnailState});
      }
      var entry = previous || createMarker(path, markerItem);
      if (previous) {
        entry.item = markerItem;
        if (entry.marker.options) entry.marker.options.title = markerLabel(markerItem);
        var coordinatesChangedForEntry = itemCoordinatesChanged(entry, markerItem);
        if (coordinatesChangedForEntry) {
          coordinatesChanged = true;
          entry.latitude = markerItem.latitude;
          entry.longitude = markerItem.longitude;
        }
        updatePopupContent(entry);
        changedEntries.push(entry);
      } else {
        addedEntries.push(entry);
      }
      nextEntries.set(path, entry);
    });

    var removedEntries = [];
    previousEntries.forEach(function (entry, path) {
      if (!nextEntries.has(path)) removedEntries.push(entry);
    });
    markerEntries = nextEntries;

    var layerChanges = addedEntries.length || removedEntries.length || coordinatesChanged;
    if (layerChanges) {
      if (markerLayer._spiderfied) {
        // MarkerClusterGroup.addLayer/removeLayer always unspiderfies the
        // active cluster. Hold membership/coordinate changes until the
        // cluster naturally closes, so progressive metadata never collapses
        // an otherwise visible expansion.
        layerSyncDeferred = true;
        debug.log('marker-layer-sync-deferred', {
          added: addedEntries.length,
          removed: removedEntries.length,
          coordinatesChanged: coordinatesChanged,
        });
      } else {
        syncMarkerLayer();
      }
    } else if (layerSyncDeferred && !markerLayer._spiderfied) {
      syncMarkerLayer();
    }
    if (typeof markerLayer.refreshClusters === 'function' && changedEntries.length) {
      markerLayer.refreshClusters(changedEntries.filter(function (entry) {
        return layerEntries.has(itemPath(entry.item));
      }).map(function (entry) { return entry.marker; }));
    }
    if (activePopupPath && !nextEntries.has(activePopupPath) && typeof map.closePopup === 'function') {
      map.closePopup();
    }
    debug.log('markers-reconciled', {
      count: nextEntries.size,
      added: addedEntries.length,
      removed: removedEntries.length,
      updated: changedEntries.length,
      paths: Array.from(nextEntries.keys()),
    });
    notifyVisibleMarkers();
    return nextEntries.size;
  }
  function setMarkerThumbnail(path, thumbnail) {
    var entry = markerEntries.get(String(path || ''));
    var url = typeof thumbnail === 'string' ? thumbnail : (thumbnail && thumbnail.url);
    if (!entry || !url) return false;
    entry.item = Object.assign({}, entry.item, {photoMapThumbnailUrl: url, photoMapThumbnailState: 'ready'});
    if (typeof entry.marker.setIcon === 'function') {
      var readyIcon = markerIcon(L, entry.item, 'ready');
      if (readyIcon) entry.marker.setIcon(readyIcon);
    }
    updatePopupContent(entry);
    debug.log('popup-thumbnail-updated', {path: String(path || ''), url: url});
    return true;
  }
  function setMarkerThumbnailState(path, state) {
    var entry = markerEntries.get(String(path || ''));
    if (!entry || mediaKind(entry.item) === 'video') return false;
    var nextState = String(state || 'loading');
    entry.item = Object.assign({}, entry.item, {photoMapThumbnailState: nextState});
    if (typeof entry.marker.setIcon === 'function') {
      var nextIcon = markerIcon(L, entry.item, nextState);
      if (nextIcon) entry.marker.setIcon(nextIcon);
    }
    return true;
  }
  function fitToItems(items) {
    var points = (Array.isArray(items) ? items : []).map(function (item) {
      return [item.latitude, item.longitude];
    });
    if (!points.length || typeof map.fitBounds !== 'function') return false;
    var bounds = typeof L.latLngBounds === 'function' ? L.latLngBounds(points) : points;
    map.fitBounds(bounds, {padding: [24, 24], maxZoom: PHOTO_MAP_FIT_MAX_ZOOM});
    return true;
  }
  return {
    map: map,
    markerLayer: markerLayer,
    invalidateSize: function () { map.invalidateSize({debounceMoveend: true}); },
    setMarkerItems: setMarkerItems,
    setMarkerThumbnail: setMarkerThumbnail,
    setMarkerThumbnailState: setMarkerThumbnailState,
    getVisibleMarkerItems: visibleMarkerItems,
    setDebugEnabled: debug.setEnabled,
    isDebugEnabled: debug.isEnabled,
    fitToItems: fitToItems,
    destroy: function () {
      debug.log('map-destroyed', {markerCount: markerEntries.size});
      markerEntries.clear();
      map.remove();
    },
  };
}
