
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

function isGroupedPhoto(item) {
  return !!(item && item.photoMapGrouped);
}

function groupedPhotoCount(item) {
  var count = Number(item && item.photoMapGroupCount);
  return Number.isFinite(count) && count > 1 ? Math.floor(count) : 0;
}

function groupedPhotoTier(item) {
  var count = groupedPhotoCount(item);
  if (count >= 50) return 'large';
  if (count >= 10) return 'medium';
  return 'small';
}

function representedMediaCount(marker) {
  var count = Number(marker && marker.options && marker.options.photoMapRepresentedMediaCount);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;
}

function clusterRepresentedMediaCount(cluster) {
  if (!cluster || typeof cluster.getAllChildMarkers !== 'function') {
    return cluster && typeof cluster.getChildCount === 'function' ? cluster.getChildCount() : 0;
  }
  return cluster.getAllChildMarkers().reduce(function (total, marker) {
    return total + representedMediaCount(marker);
  }, 0);
}

function clusterIconClassName(count) {
  var tier = count < 10 ? 'small' : (count < 100 ? 'medium' : 'large');
  return 'marker-cluster marker-cluster-' + tier;
}

function clusterIcon(L, cluster) {
  var count = clusterRepresentedMediaCount(cluster);
  return L.divIcon({
    html: '<div><span>' + count + '</span></div>',
    className: clusterIconClassName(count),
    iconSize: [40, 40],
  });
}

function markerAccessibleLabel(item) {
  if (isGroupedPhoto(item)) {
    return 'Grouped media pin containing ' + groupedPhotoCount(item) + ' media items';
  }
  return markerLabel(item);
}

function markerIconHtml(item, state) {
  var label = escapeHtml(markerLabel(item));
  var url = item && item.photoMapThumbnailUrl;
  var video = mediaKind(item) === 'video';
  var thumbnail = url
    ? '<span class="photo-map-marker-poster"><img class="photo-map-marker-thumbnail-image" src="' + escapeHtml(url) +
      '" alt="Thumbnail for ' + label + '">' +
      (video ? '<span class="photo-map-video-play" aria-hidden="true">&#9654;</span>' : '') + '</span>'
    : '<span class="photo-map-marker-thumbnail-loading" role="status" aria-label="Loading thumbnail">' +
      '<span aria-hidden="true">&hellip;</span></span>';
  var stateName = state || (url ? 'ready' : 'loading');
  return '<span class="photo-map-marker-visual photo-map-marker-state-' + escapeHtml(stateName) +
    '"><span class="photo-map-marker-thumbnail">' + thumbnail +
    '</span><span class="photo-map-marker-stem" aria-hidden="true"></span><span class="photo-map-marker-pin" aria-hidden="true"></span></span>';
}

function groupThumbnailMember(item) {
  if (!isGroupedPhoto(item)) return null;
  var wanted = String(item.photoMapGroupThumbnailPath || '');
  if (!wanted) return null;
  var members = Array.isArray(item.photoMapGroupMembers) ? item.photoMapGroupMembers : [];
  return members.find(function (member) { return groupMemberPath(member) === wanted; }) || null;
}

function groupThumbnailPresentationChanged(previousItem, nextItem) {
  return String((previousItem && previousItem.photoMapGroupThumbnailPath) || '') !==
      String((nextItem && nextItem.photoMapGroupThumbnailPath) || '') ||
    String((previousItem && previousItem.photoMapThumbnailUrl) || '') !==
      String((nextItem && nextItem.photoMapThumbnailUrl) || '') ||
    String((previousItem && previousItem.photoMapThumbnailState) || '') !==
      String((nextItem && nextItem.photoMapThumbnailState) || '');
}

function withGroupThumbnailPresentation(item) {
  var member = groupThumbnailMember(item);
  if (!member) return item;
  return Object.assign({}, item, {
    photoMapThumbnailUrl: member.photoMapThumbnailUrl || '',
    photoMapThumbnailState: member.photoMapThumbnailState || '',
  });
}

function groupedMarkerIconHtml(item, state) {
  var count = groupedPhotoCount(item);
  var label = escapeHtml(markerAccessibleLabel(item));
  var thumbnailPath = String(item && item.photoMapGroupThumbnailPath || '');
  var url = item && item.photoMapThumbnailUrl;
  var thumbnailMember = groupThumbnailMember(item);
  var thumbnailIsVideo = mediaKind(thumbnailMember) === 'video';
  var stateName = state || (url ? 'ready' : 'loading');
  var cardContents = thumbnailPath
    ? (url
      ? '<span class="photo-map-group-marker-poster"><img class="photo-map-group-marker-thumbnail" src="' + escapeHtml(url) +
        '" alt="Thumbnail for newest media in group: ' + label + '">' +
        (thumbnailIsVideo ? '<span class="photo-map-video-play" aria-hidden="true">&#9654;</span>' : '') + '</span>'
      : '<span class="photo-map-group-marker-thumbnail-loading" role="status" aria-label="Loading newest group thumbnail">' +
        '<span aria-hidden="true">&hellip;</span></span>')
    : '<span class="photo-map-group-marker-symbol" aria-hidden="true">&#9638;</span>';
  return '<span class="photo-map-group-marker photo-map-group-marker-tier-' + groupedPhotoTier(item) +
    ' photo-map-group-marker-state-' + escapeHtml(stateName) + '" role="img" aria-label="' + label + '">' +
    '<span class="photo-map-group-marker-card' + (thumbnailPath ? ' photo-map-group-marker-card-thumbnail' : '') + '">' +
      cardContents + '</span>' +
    '<span class="photo-map-group-marker-badge" aria-hidden="true">' + count + '</span>' +
    '<span class="photo-map-group-marker-stem" aria-hidden="true"></span>' +
    '<span class="photo-map-group-marker-pin" aria-hidden="true"></span>' +
    '</span>';
}

function markerIcon(L, item, state) {
  if (typeof L.divIcon !== 'function') return null;
  if (isGroupedPhoto(item)) {
    var tier = groupedPhotoTier(item);
    var dimensions = tier === 'large' ? {size: 104, height: 116} :
      (tier === 'medium' ? {size: 94, height: 106} : {size: 84, height: 96});
    return L.divIcon({
      className: 'photo-map-group-icon photo-map-group-icon-tier-' + tier,
      html: groupedMarkerIconHtml(item),
      iconSize: [dimensions.size, dimensions.height],
      iconAnchor: [dimensions.size / 2, dimensions.height - 2],
      popupAnchor: [0, -(dimensions.height - 8)],
    });
  }
  return L.divIcon({
    className: 'photo-map-marker-icon',
    html: markerIconHtml(item, state),
    iconSize: [88, 110],
    iconAnchor: [44, 108],
    popupAnchor: [0, -106],
  });
}

function groupMemberPath(item) {
  return String((item && (item.photoMapSourcePath || item.path)) || '');
}

function groupedMemberLoadingMarkup(item) {
  var state = String((item && item.photoMapThumbnailState) || 'loading');
  if (state === 'error') {
    return '<span class="photo-map-group-grid-error" role="img" aria-label="Thumbnail unavailable">!</span>';
  }
  return '<span class="photo-map-group-grid-loading" role="status" aria-label="Loading thumbnail">' +
    '<span aria-hidden="true">&hellip;</span></span>';
}

function groupedMemberMediaMarkup(item) {
  var label = escapeHtml(markerLabel(item));
  if (mediaKind(item) === 'video') {
    var videoUrl = item && item.photoMapThumbnailUrl;
    if (!videoUrl) return '<span class="photo-map-group-grid-media">' + groupedMemberLoadingMarkup(item) + '</span>';
    var videoPoster = videoUrl
      ? '<span class="photo-map-media-poster"><img class="photo-map-group-grid-thumbnail" src="' + escapeHtml(videoUrl) +
        '" alt="Thumbnail for ' + label + '"><span class="photo-map-video-play" aria-hidden="true">&#9654;</span></span>'
      : '<span class="photo-map-group-grid-video-placeholder" role="img" aria-label="Loading video thumbnail"><span aria-hidden="true">&#9654;</span></span>';
    return '<span class="photo-map-group-grid-media">' + videoPoster + '</span>';
  }
  var url = item && item.photoMapThumbnailUrl;
  var media = url
    ? '<img class="photo-map-group-grid-thumbnail" src="' + escapeHtml(url) +
      '" alt="Thumbnail for ' + label + '">' : groupedMemberLoadingMarkup(item);
  return '<span class="photo-map-group-grid-media">' + media + '</span>';
}

function groupedMemberGridItem(item) {
  var path = escapeHtml(groupMemberPath(item));
  var label = escapeHtml(markerLabel(item));
  var failedVideoPoster = mediaKind(item) === 'video' && !item.photoMapThumbnailUrl;
  var actionLabel = failedVideoPoster ? 'Open video preview for ' + label : 'Show details for ' + label;
  var previewAttrs = failedVideoPoster
    ? ' data-photo-map-preview-path="' + path + '" data-photo-map-preview-source="remote" data-photo-map-preview-kind="video"'
    : '';
  return '<button type="button" class="photo-map-group-grid-item" data-photo-map-group-member-path="' + path +
    '" aria-label="' + escapeHtml(actionLabel) + '"' + previewAttrs + '>' +
    groupedMemberGridContents(item) +
    '</button>';
}

function groupedMemberGridContents(item) {
  var label = escapeHtml(markerLabel(item));
  return groupedMemberMediaMarkup(item) +
    '<span class="photo-map-group-grid-name">' + label + '</span>';
}

function groupedMemberDetails(item) {
  if (!item) {
    return '<p class="photo-map-group-selection-empty">Select a thumbnail to view its details.</p>';
  }
  var label = escapeHtml(markerLabel(item));
  var captureDate = item.captureDate || item.capture_date;
  var latitude = item && Number.isFinite(item.latitude) ? item.latitude : 'Unavailable';
  var longitude = item && Number.isFinite(item.longitude) ? item.longitude : 'Unavailable';
  var filename = markerLabel(item);
  var thumbnailUrl = item && item.photoMapThumbnailUrl;
  var mediaPreview;
  if (mediaKind(item) === 'video') {
    mediaPreview = thumbnailUrl
      ? previewLink(item, '<span class="photo-map-media-poster photo-map-preview-poster"><img class="photo-map-preview-thumbnail" src="' +
        escapeHtml(thumbnailUrl) + '" alt="Thumbnail for ' + label + '"><span class="photo-map-video-play" aria-hidden="true">&#9654;</span></span>',
        'Open full preview for ' + filename)
      : previewLink(item, previewThumbnailFallback(item),
        'Open full preview for ' + filename);
  } else if (thumbnailUrl) {
    mediaPreview = previewLink(item, '<img class="photo-map-preview-thumbnail" src="' + escapeHtml(thumbnailUrl) +
      '" alt="Thumbnail for ' + label + '">', 'Open full preview for ' + filename);
  } else {
    mediaPreview = previewLink(item, '<span class="photo-map-preview-loading">Thumbnail loading&hellip;</span>',
      'Open full preview for ' + filename);
  }
  return '<div class="photo-map-group-selection-details">' +
    '<strong class="photo-map-preview-filename">' + label + '</strong>' +
    '<div class="photo-map-preview-media">' + mediaPreview + '</div>' +
    '<dl class="photo-map-preview-details">' +
      '<dt>Latitude</dt><dd>' + escapeHtml(detailValue(latitude)) + '</dd>' +
      '<dt>Longitude</dt><dd>' + escapeHtml(detailValue(longitude)) + '</dd>' +
      '<dt>Capture date</dt><dd>' + escapeHtml(detailValue(captureDate)) + '</dd>' +
      '<dt>Listing date</dt><dd>' + escapeHtml(listingDateLabel(item)) + '</dd>' +
    '</dl>' +
    '<button type="button" class="photo-map-group-selection-back" data-photo-map-group-back="true">Close preview</button>' +
    '</div>';
}

function previewThumbnailFallback(item) {
  if (String((item && item.photoMapThumbnailState) || '') === 'error') {
    return '<span class="photo-map-preview-loading">Thumbnail unavailable</span>';
  }
  return '<span class="photo-map-preview-loading photo-map-preview-thumbnail-placeholder" role="status" aria-label="Loading thumbnail">' +
    '<span aria-hidden="true">Loading thumbnail&hellip;</span></span>';
}

function groupedPopupMarkup(item) {
  var members = Array.isArray(item && item.photoMapGroupMembers) ? item.photoMapGroupMembers : [];
  var label = escapeHtml(markerLabel(item));
  return '<article class="photo-map-preview photo-map-grouped-preview" aria-label="' +
    escapeHtml(markerAccessibleLabel(item)) + '">' +
    '<strong class="photo-map-preview-filename">' + label + '</strong>' +
    '<p class="photo-map-grouped-preview-message"><span class="photo-map-grouped-preview-count">' +
      groupedPhotoCount(item) + ' media items</span> in this location.</p>' +
    '<div class="photo-map-group-grid" data-photo-map-group-grid="true" role="list" aria-label="Photos in this group">' +
      members.map(groupedMemberGridItem).join('') +
    '</div>' +
    '<section class="photo-map-group-selection" data-photo-map-group-selection="true" aria-live="polite">' +
      groupedMemberDetails(null) +
    '</section>' +
    '</article>';
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
  var path = item && (item.photoMapSourcePath || item.path);
  var params = new URLSearchParams();
  params.set('path', path || '');
  params.set('source', 'remote');
  params.set('kind', mediaKind(item));
  var href = '/preview?' + params.toString();
  return '<a class="photo-map-preview-link" href="' +
    escapeHtml(href) +
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
  if (isGroupedPhoto(item)) {
    return groupedPopupMarkup(item);
  }
  var mediaPreview;
  if (thumbnailUrl && mediaKind(item) === 'video') {
    mediaPreview = previewLink(item,
      '<span class="photo-map-media-poster photo-map-preview-poster"><img class="photo-map-preview-thumbnail" src="' +
        escapeHtml(thumbnailUrl) + '" alt="Thumbnail for ' + label + '"><span class="photo-map-video-play" aria-hidden="true">&#9654;</span></span>',
      'Open full preview for ' + filename);
  } else if (thumbnailUrl) {
    mediaPreview = previewLink(item,
      '<img class="photo-map-preview-thumbnail" src="' + escapeHtml(thumbnailUrl) +
        '" alt="Thumbnail for ' + label + '">',
      'Open full preview for ' + filename,
    );
  } else if (mediaKind(item) === 'video') {
    mediaPreview = previewLink(item, previewThumbnailFallback(item),
      'Open full preview for ' + filename);
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
  var markerLayer = L.markerClusterGroup({
    maxClusterRadius: PHOTO_MAP_CLUSTER_RADIUS,
    // At the highest map zoom a cluster cannot zoom any farther. Keep the
    // grouped photo pin itself clickable instead of leaving a count bubble
    // whose max-zoom click appears to do nothing (spiderfying is disabled).
    disableClusteringAtZoom: PHOTO_MAP_MAX_ZOOM,
    spiderfyOnMaxZoom: false,
    // Leaflet normally counts rendered markers. Grouped markers each stand
    // for many media items, so the badge must instead sum what their child
    // markers represent.
    iconCreateFunction: function (cluster) { return clusterIcon(L, cluster); },
  });
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
    // Progressive metadata reconciliation visits every marker.  A grouped
    // popup's grid is a native scroll target, so replacing equivalent markup
    // after each unrelated result destroys an in-progress scrollbar drag.
    // Keep the established DOM and listeners when this marker's popup has not
    // actually changed; direct thumbnail-cell updates keep popupMarkup current.
    if (popup === entry.popupMarkup) return false;
    var groupedPopupWasOpen = isGroupedPhoto(entry && entry.item) && !!entry.groupPopupElement;
    var groupedPopupScrollTop = null;
    var groupedPopupSelectedPath = '';
    var existingGroupedPopupElement = groupedPopupWasOpen ? entry.groupPopupElement : null;
    if (groupedPopupWasOpen) {
      if (entry.groupGrid) {
        var currentScrollTop = Number(entry.groupGrid.scrollTop);
        if (Number.isFinite(currentScrollTop)) groupedPopupScrollTop = currentScrollTop;
      }
      groupedPopupSelectedPath = String(entry.groupSelectedPath || '');
      // Keep the outer Leaflet popup and its scroll container alive. Updating
      // it through setPopupContent would replace the grid element and reset
      // its scroll position while progressive metadata/thumbnail updates are
      // arriving.
      detachGroupedPopupListeners(entry);
    }
    if (groupedPopupWasOpen && existingGroupedPopupElement &&
        typeof existingGroupedPopupElement.querySelector === 'function') {
      var contentElement = existingGroupedPopupElement.querySelector('.leaflet-popup-content');
      if (contentElement) {
        contentElement.innerHTML = popup;
        entry.popupMarkup = popup;
        entry.groupPopupElement = existingGroupedPopupElement;
        attachGroupedPopupListeners(entry);
        if (groupedPopupScrollTop !== null && entry.groupGrid) {
          entry.groupGrid.scrollTop = groupedPopupScrollTop;
        }
        if (groupedPopupSelectedPath) showGroupedMember(entry, groupedPopupSelectedPath);
        return;
      }
      entry.groupPopupElement = null;
    }
    if (typeof entry.marker.setPopupContent === 'function') {
      entry.marker.setPopupContent(popup);
    } else if (typeof entry.marker.bindPopup === 'function') {
      // This fallback is only for older/test doubles. Leaflet's normal path
      // updates the existing popup without replacing the marker binding.
      entry.marker.bindPopup(popup);
    }
    entry.popupMarkup = popup;
    if (groupedPopupWasOpen) {
      attachGroupedPopupListeners(entry);
      if (groupedPopupScrollTop !== null && entry.groupGrid) {
        entry.groupGrid.scrollTop = groupedPopupScrollTop;
      }
      if (groupedPopupSelectedPath) showGroupedMember(entry, groupedPopupSelectedPath);
    }
  }

  function popupElementFor(marker, event) {
    var popup = event && event.popup;
    if (!popup && marker && typeof marker.getPopup === 'function') popup = marker.getPopup();
    if (popup && typeof popup.getElement === 'function') return popup.getElement();
    return null;
  }

  function groupGridFor(entry) {
    var root = entry && entry.groupPopupElement;
    if (!root || typeof root.querySelector !== 'function') return null;
    return root.querySelector('[data-photo-map-group-grid]') || root.querySelector('.photo-map-group-grid');
  }

  function groupSelectionFor(entry) {
    var root = entry && entry.groupPopupElement;
    if (!root || typeof root.querySelector !== 'function') return null;
    return root.querySelector('[data-photo-map-group-selection]');
  }

  function groupMemberFor(entry, path) {
    var members = entry && Array.isArray(entry.item.photoMapGroupMembers)
      ? entry.item.photoMapGroupMembers : [];
    var wanted = String(path || '');
    return members.find(function (member) { return groupMemberPath(member) === wanted; }) || null;
  }

  function groupCellFor(entry, path) {
    var grid = groupGridFor(entry);
    if (!grid || typeof grid.querySelectorAll !== 'function') return null;
    var wanted = String(path || '');
    var cells = grid.querySelectorAll('[data-photo-map-group-member-path]');
    for (var index = 0; index < cells.length; index += 1) {
      if (cells[index].getAttribute('data-photo-map-group-member-path') === wanted) return cells[index];
    }
    return null;
  }

  function renderGroupCell(cell, member) {
    if (!cell) return false;
    // The cell itself is the member button.  Updating it with the complete
    // item wrapper would create nested buttons and break click semantics.
    cell.innerHTML = groupedMemberGridContents(member);
    return true;
  }

  function showGroupedMember(entry, path) {
    var wanted = String(path || '');
    var member = wanted ? groupMemberFor(entry, wanted) : null;
    entry.groupSelectedPath = member ? wanted : '';
    var selection = groupSelectionFor(entry);
    if (selection) selection.innerHTML = groupedMemberDetails(member);
    var grid = groupGridFor(entry);
    if (grid && typeof grid.querySelectorAll === 'function') {
      var cells = grid.querySelectorAll('[data-photo-map-group-member-path]');
      for (var index = 0; index < cells.length; index += 1) {
        var selected = cells[index].getAttribute('data-photo-map-group-member-path') === wanted;
        if (typeof cells[index].setAttribute === 'function') {
          cells[index].setAttribute('aria-pressed', selected ? 'true' : 'false');
        }
      }
    }
    if (typeof config.onGroupedMemberSelect === 'function') {
      config.onGroupedMemberSelect(entry.item, member);
    }
    return !!member;
  }

  function visibleGroupedMembers(entry) {
    var members = entry && Array.isArray(entry.item.photoMapGroupMembers)
      ? entry.item.photoMapGroupMembers : [];
    var grid = groupGridFor(entry);
    if (!grid || typeof grid.querySelectorAll !== 'function') return members.slice(0, 16);
    var viewport = Number(grid.clientHeight);
    if (!Number.isFinite(viewport) || viewport <= 0) return members.slice(0, 16);
    var top = Math.max(0, Number(grid.scrollTop) - viewport);
    var bottom = Number(grid.scrollTop) + viewport * 2;
    var cells = grid.querySelectorAll('[data-photo-map-group-member-path]');
    var paths = new Set();
    for (var index = 0; index < cells.length; index += 1) {
      var cell = cells[index];
      var cellTop = Number(cell.offsetTop) || 0;
      var cellBottom = cellTop + (Number(cell.offsetHeight) || 1);
      if (cellBottom >= top && cellTop <= bottom) {
        paths.add(cell.getAttribute('data-photo-map-group-member-path'));
      }
    }
    var selected = entry.groupSelectedPath;
    return members.filter(function (member) {
      return paths.has(groupMemberPath(member)) || groupMemberPath(member) === selected;
    });
  }

  function notifyGroupedPopupViewport(entry) {
    if (typeof config.onGroupedPopupScroll === 'function') {
      config.onGroupedPopupScroll(entry.item, visibleGroupedMembers(entry));
    }
  }

  function detachGroupedPopupListeners(entry) {
    if (!entry) return;
    if (entry.groupGridClick && typeof entry.groupGrid.removeEventListener === 'function') {
      entry.groupGrid.removeEventListener('click', entry.groupGridClick);
    }
    if (entry.groupGridScroll && typeof entry.groupGrid.removeEventListener === 'function') {
      entry.groupGrid.removeEventListener('scroll', entry.groupGridScroll);
    }
    if (entry.groupPopupClick && entry.groupPopupElement &&
        typeof entry.groupPopupElement.removeEventListener === 'function') {
      entry.groupPopupElement.removeEventListener('click', entry.groupPopupClick);
    }
    entry.groupGrid = null;
    entry.groupGridClick = null;
    entry.groupGridScroll = null;
    entry.groupPopupClick = null;
  }

  function attachGroupedPopupListeners(entry, event, options) {
    if (!isGroupedPhoto(entry.item)) return;
    var notifyOpen = !options || options.notifyOpen !== false;
    detachGroupedPopupListeners(entry);
    entry.groupPopupElement = popupElementFor(entry.marker, event);
    var grid = groupGridFor(entry);
    entry.groupGrid = grid;
    var root = entry.groupPopupElement;
    if (root && typeof root.addEventListener === 'function') {
      entry.groupPopupClick = function (clickEvent) {
        var target = clickEvent && clickEvent.target;
        while (target && target !== root && typeof target.getAttribute === 'function' &&
            !target.getAttribute('data-photo-map-group-back')) target = target.parentNode;
        if (target && target !== root && target.getAttribute('data-photo-map-group-back')) {
          showGroupedMember(entry, '');
        }
      };
      root.addEventListener('click', entry.groupPopupClick);
    }
    if (grid && typeof grid.addEventListener === 'function') {
      entry.groupGridClick = function (clickEvent) {
        var target = clickEvent && clickEvent.target;
        while (target && target !== grid && typeof target.getAttribute === 'function' &&
            !target.getAttribute('data-photo-map-group-member-path') &&
            !target.getAttribute('data-photo-map-group-back')) target = target.parentNode;
        if (!target || target === grid) return;
        if (target.getAttribute('data-photo-map-group-back')) showGroupedMember(entry, '');
        else showGroupedMember(entry, target.getAttribute('data-photo-map-group-member-path'));
      };
      entry.groupGridScroll = function () { notifyGroupedPopupViewport(entry); };
      grid.addEventListener('click', entry.groupGridClick);
      grid.addEventListener('scroll', entry.groupGridScroll);
    }
    if (notifyOpen && typeof config.onGroupedPopupOpen === 'function') {
      config.onGroupedPopupOpen(entry.item, visibleGroupedMembers(entry));
    }
  }

  function updateGroupedMember(entry, path, patch) {
    if (!entry || !isGroupedPhoto(entry.item)) return false;
    var wanted = String(path || '');
    var found = false;
    var members = (entry.item.photoMapGroupMembers || []).map(function (member) {
      if (groupMemberPath(member) !== wanted) return member;
      found = true;
      return Object.assign({}, member, patch || {});
    });
    if (!found) return false;
    var previousItem = entry.item;
    entry.item = withGroupThumbnailPresentation(Object.assign({}, entry.item, {photoMapGroupMembers: members}));
    var member = groupMemberFor(entry, wanted);
    var cell = groupCellFor(entry, wanted);
    if (cell) renderGroupCell(cell, member);
    var selected = entry.groupSelectedPath === wanted;
    if (selected) {
      var selection = groupSelectionFor(entry);
      if (selection) selection.innerHTML = groupedMemberDetails(member);
    }
    if (groupThumbnailPresentationChanged(previousItem, entry.item) &&
        typeof entry.marker.setIcon === 'function') {
      var groupIcon = markerIcon(L, entry.item, entry.item.photoMapThumbnailState);
      if (groupIcon) entry.marker.setIcon(groupIcon);
    }
    if (cell) {
      // This is intentionally a cell-only DOM update so loading a thumbnail
      // never replaces the scroll container that the user may be dragging.
      entry.popupMarkup = markerPopup(entry.item);
    } else if (!entry.groupPopupElement) {
      updatePopupContent(entry);
    }
    return true;
  }

  function createMarker(path, item) {
    var icon = markerIcon(L, item, item.photoMapThumbnailState);
    var markerOptions = {
      title: markerAccessibleLabel(item),
      alt: markerAccessibleLabel(item),
      photoMapRepresentedMediaCount: isGroupedPhoto(item) ? groupedPhotoCount(item) : 1,
    };
    if (icon) markerOptions.icon = icon;
    var marker = L.marker([item.latitude, item.longitude], markerOptions);
    var popupMarkup = markerPopup(item);
    var entry = {
      item: item,
      marker: marker,
      popupMarkup: popupMarkup,
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
      marker.bindPopup(popupMarkup);
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
      marker.on('popupopen', function (event) {
        activePopupPath = path;
        attachGroupedPopupListeners(entry, event);
        debug.log('marker-popupopen', {path: path});
      });
      marker.on('popupclose', function () {
        if (activePopupPath === path) activePopupPath = null;
        if (isGroupedPhoto(entry.item)) {
          detachGroupedPopupListeners(entry);
          entry.groupPopupElement = null;
          if (typeof config.onGroupedPopupClose === 'function') config.onGroupedPopupClose(entry.item);
        }
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
        var previousItem = entry.item;
        entry.item = markerItem;
        if (entry.marker.options) {
          entry.marker.options.title = markerAccessibleLabel(markerItem);
          entry.marker.options.alt = markerAccessibleLabel(markerItem);
          entry.marker.options.photoMapRepresentedMediaCount = isGroupedPhoto(markerItem)
            ? groupedPhotoCount(markerItem) : 1;
        }
        var groupedPresentationChanged = isGroupedPhoto(markerItem) &&
          (!isGroupedPhoto(previousItem) || groupedPhotoCount(previousItem) !== groupedPhotoCount(markerItem) ||
            groupThumbnailPresentationChanged(previousItem, markerItem));
        if (groupedPresentationChanged && typeof entry.marker.setIcon === 'function') {
          var groupedIcon = markerIcon(L, markerItem, markerItem.photoMapThumbnailState);
          if (groupedIcon) entry.marker.setIcon(groupedIcon);
        }
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
    if (!entry || !url || isGroupedPhoto(entry.item)) return false;
    entry.item = Object.assign({}, entry.item, {photoMapThumbnailUrl: url, photoMapThumbnailState: 'ready'});
    if (typeof entry.marker.setIcon === 'function') {
      var readyIcon = markerIcon(L, entry.item, 'ready');
      if (readyIcon) entry.marker.setIcon(readyIcon);
    }
    updatePopupContent(entry);
    debug.log('popup-thumbnail-updated', {path: String(path || ''), url: url});
    return true;
  }
  function setGroupedMemberThumbnail(path, thumbnail) {
    var url = typeof thumbnail === 'string' ? thumbnail : (thumbnail && thumbnail.url);
    if (!url) return false;
    var updated = false;
    markerEntries.forEach(function (entry) {
      if (updateGroupedMember(entry, path, {photoMapThumbnailUrl: url, photoMapThumbnailState: 'ready'})) {
        updated = true;
      }
    });
    return updated;
  }
  function setMarkerThumbnailState(path, state) {
    var entry = markerEntries.get(String(path || ''));
    if (!entry || isGroupedPhoto(entry.item)) return false;
    var nextState = String(state || 'loading');
    entry.item = Object.assign({}, entry.item, {photoMapThumbnailState: nextState});
    if (typeof entry.marker.setIcon === 'function') {
      var nextIcon = markerIcon(L, entry.item, nextState);
      if (nextIcon) entry.marker.setIcon(nextIcon);
    }
    updatePopupContent(entry);
    return true;
  }
  function setGroupedMemberThumbnailState(path, state) {
    var nextState = String(state || 'loading');
    var updated = false;
    markerEntries.forEach(function (entry) {
      if (updateGroupedMember(entry, path, {photoMapThumbnailState: nextState})) updated = true;
    });
    return updated;
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
    getActivePopupPath: function () { return activePopupPath; },
    refreshPopupListenersForPath: function (path) {
      var entry = markerEntries.get(String(path || ''));
      if (!entry || !isGroupedPhoto(entry.item)) return false;
      // Preview overlays can temporarily take the browser history through a
      // different URL without closing Leaflet's popup. In that case Leaflet
      // does not emit another popupopen event, so explicitly rebind the
      // delegated group handlers to the currently mounted popup DOM.
      var root = popupElementFor(entry.marker);
      if (!root) return false;
      attachGroupedPopupListeners(entry, null, {notifyOpen: false});
      return !!entry.groupGrid;
    },
    openPopupForPath: function (path) {
      var entry = markerEntries.get(String(path || ''));
      if (!entry || !entry.marker || typeof entry.marker.openPopup !== 'function') return false;
      entry.marker.openPopup();
      return true;
    },
    invalidateSize: function () { map.invalidateSize({debounceMoveend: true}); },
    setMarkerItems: setMarkerItems,
    setMarkerThumbnail: setMarkerThumbnail,
    setGroupedMemberThumbnail: setGroupedMemberThumbnail,
    setMarkerThumbnailState: setMarkerThumbnailState,
    setGroupedMemberThumbnailState: setGroupedMemberThumbnailState,
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
