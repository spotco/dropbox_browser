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
      });
    });
  }
  var markerEntries = new Map();
  var activePopupPath = null;

  function itemPath(item) {
    return String((item && (item.photoMapSourcePath || item.path)) || '');
  }

  function itemCoordinatesChanged(marker, item) {
    if (!marker || typeof marker.getLatLng !== 'function') return false;
    var current = marker.getLatLng();
    return !current || current.lat !== item.latitude || current.lng !== item.longitude;
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
    var marker = L.marker([item.latitude, item.longitude], {title: markerLabel(item)});
    var entry = {item: item, marker: marker};
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

  function captureSpiderfiedState() {
    var cluster = markerLayer._spiderfied;
    if (!cluster || typeof cluster.getAllChildMarkers !== 'function') return null;
    var paths = cluster.getAllChildMarkers().map(function (marker) {
      for (var entry of markerEntries.values()) {
        if (entry.marker === marker) return itemPath(entry.item);
      }
      return '';
    }).filter(Boolean);
    return paths.length ? {paths: paths} : null;
  }

  function restoreSpiderfiedState(state) {
    if (!state || !state.paths.length) return false;
    var cluster = null;
    for (var i = 0; i < state.paths.length; i += 1) {
      var entry = markerEntries.get(state.paths[i]);
      if (!entry) continue;
      var visibleParent = typeof markerLayer.getVisibleParent === 'function'
        ? markerLayer.getVisibleParent(entry.marker)
        : null;
      if (visibleParent && typeof visibleParent.spiderfy === 'function') {
        cluster = visibleParent;
        break;
      }
      var parent = entry.marker.__parent;
      if (parent && typeof parent.spiderfy === 'function') {
        cluster = parent;
        break;
      }
    }
    var bounds = typeof map.getBounds === 'function' ? map.getBounds() : null;
    if (!cluster || (bounds && typeof bounds.contains === 'function' &&
        typeof cluster.getLatLng === 'function' && !bounds.contains(cluster.getLatLng()))) return false;
    cluster.spiderfy();
    debug.log('cluster-restored', {paths: state.paths});
    return true;
  }

  function setMarkerItems(items) {
    var previousEntries = markerEntries;
    var spiderfiedState = captureSpiderfiedState();
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
      var entry = previous || createMarker(path, markerItem);
      if (previous) {
        entry.item = markerItem;
        if (entry.marker.options) entry.marker.options.title = markerLabel(markerItem);
        var coordinatesChangedForEntry = itemCoordinatesChanged(entry.marker, markerItem);
        if (coordinatesChangedForEntry) {
          coordinatesChanged = true;
        }
        if (coordinatesChangedForEntry && typeof entry.marker.setLatLng === 'function') {
          entry.marker.setLatLng([markerItem.latitude, markerItem.longitude]);
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

    var canReconcile = typeof markerLayer.addLayer === 'function' &&
      typeof markerLayer.removeLayer === 'function';
    if (canReconcile) {
      removedEntries.forEach(function (entry) { markerLayer.removeLayer(entry.marker); });
      addedEntries.forEach(function (entry) { markerLayer.addLayer(entry.marker); });
    } else {
      // Compatibility fallback for minimal Leaflet doubles; real
      // MarkerClusterGroup supports incremental addLayer/removeLayer.
      var markers = Array.from(nextEntries.values()).map(function (entry) { return entry.marker; });
      if (typeof markerLayer.clearLayers === 'function') markerLayer.clearLayers();
      if (typeof markerLayer.addLayers === 'function') markerLayer.addLayers(markers);
      else markers.forEach(function (marker) { markerLayer.addLayer(marker); });
    }
    if (typeof markerLayer.refreshClusters === 'function' && changedEntries.length) {
      markerLayer.refreshClusters(changedEntries.map(function (entry) { return entry.marker; }));
    }
    if (activePopupPath && !nextEntries.has(activePopupPath) && typeof map.closePopup === 'function') {
      map.closePopup();
    }
    if (spiderfiedState && (addedEntries.length || removedEntries.length || coordinatesChanged)) {
      restoreSpiderfiedState(spiderfiedState);
    }
    debug.log('markers-reconciled', {
      count: nextEntries.size,
      added: addedEntries.length,
      removed: removedEntries.length,
      updated: changedEntries.length,
      paths: Array.from(nextEntries.keys()),
    });
    return nextEntries.size;
  }
  function setMarkerThumbnail(path, thumbnail) {
    var entry = markerEntries.get(String(path || ''));
    var url = typeof thumbnail === 'string' ? thumbnail : (thumbnail && thumbnail.url);
    if (!entry || !url) return false;
    entry.item = Object.assign({}, entry.item, {photoMapThumbnailUrl: url});
    updatePopupContent(entry);
    debug.log('popup-thumbnail-updated', {path: String(path || ''), url: url});
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
