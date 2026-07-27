
export const PHOTO_MAP_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const PHOTO_MAP_TILE_ATTRIBUTION = '&copy; OpenStreetMap contributors';
export const PHOTO_MAP_INITIAL_VIEW = [20, 0];
export const PHOTO_MAP_INITIAL_ZOOM = 2;
export const PHOTO_MAP_MIN_ZOOM = 1;
export const PHOTO_MAP_MAX_ZOOM = 19;
export const PHOTO_MAP_CLUSTER_RADIUS = 50;
export const PHOTO_MAP_FIT_MAX_ZOOM = 15;
export const PHOTO_MAP_DEBUG_DEFAULT = false;
export const PHOTO_MAP_DEBUG_EVENT_LIMIT = 120;

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
    '" data-photo-map-thumbnail-state="' + escapeHtml(String(item.photoMapThumbnailState || 'loading')) +
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
  var events = [];
  function log(event, details) {
    if (!enabled || !consoleImpl) return;
    events.push({
      timestamp: Date.now(),
      event: String(event || ''),
      details: Object.assign({}, details || {}),
    });
    if (events.length > PHOTO_MAP_DEBUG_EVENT_LIMIT) events.shift();
    var method = typeof consoleImpl.debug === 'function' ? consoleImpl.debug : consoleImpl.log;
    if (typeof method !== 'function') return;
    method.call(consoleImpl, '[Photo Map]', event, details || {});
  }
  return {
    log: log,
    setEnabled: function (value) { enabled = Boolean(value); },
    isEnabled: function () { return enabled; },
    events: function () { return events.slice(); },
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

function popupContentElement(documentImpl, item) {
  if (!documentImpl || typeof documentImpl.createElement !== 'function') return null;
  var content = documentImpl.createElement('div');
  content.innerHTML = markerPopup(item);
  return content.firstElementChild || content.firstChild || content;
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
  var popupDiagnostics = {
    rootMounts: 0,
    listenerAttaches: 0,
    listenerDetaches: 0,
    viewportFitRequests: 0,
    viewportFitPasses: 0,
    viewportFitPans: 0,
    viewportFitNoops: 0,
    viewportFitCoalesced: 0,
  };
  var popupFitFrame = null;
  var popupFitEntry = null;
  var popupFitVersion = 0;
  function thumbnailForPath(path) {
    var wanted = String(path || '');
    if (!wanted) return null;
    return typeof config.getThumbnailForPath === 'function'
      ? config.getThumbnailForPath(wanted) || null : null;
  }

  function presentMember(member) {
    if (!member) return member;
    var thumbnail = thumbnailForPath(groupMemberPath(member));
    if (!thumbnail) return member;
    return Object.assign({}, member, {
      photoMapThumbnailUrl: thumbnail.url || '',
      photoMapThumbnailState: thumbnail.state || 'ready',
    });
  }

  function presentItem(item) {
    if (!item) return item;
    if (isGroupedPhoto(item)) {
      var members = (Array.isArray(item.photoMapGroupMembers) ? item.photoMapGroupMembers : [])
        .map(presentMember);
      var presented = Object.assign({}, item, {photoMapGroupMembers: members});
      return withGroupThumbnailPresentation(presented);
    }
    var thumbnail = thumbnailForPath(itemPath(item));
    return thumbnail ? Object.assign({}, item, {
      photoMapThumbnailUrl: thumbnail.url || '',
      photoMapThumbnailState: thumbnail.state || 'ready',
    }) : item;
  }

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
    if (isGroupedPhoto(entry && entry.item) && entry.groupPopupElement) {
      syncPopupContentRoot(entry);
    }
    var popup = markerPopup(presentItem(entry.item));
    // Progressive metadata reconciliation visits every marker.  A grouped
    // popup's grid is a native scroll target, so replacing equivalent markup
    // after each unrelated result destroys an in-progress scrollbar drag.
    // Keep the established DOM and listeners when this marker's popup has not
    // actually changed; direct thumbnail-cell updates keep popupMarkup current.
    if (popup === entry.popupMarkup) return false;
    var groupedPopupWasOpen = isGroupedPhoto(entry && entry.item) && !!entry.groupPopupElement;
    var groupedPopupScrollTop = null;
    var groupedPopupSelectedPath = '';
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
    if (entry.popupContent && typeof entry.marker.setPopupContent === 'function') {
      entry.popupContent.innerHTML = popup;
      entry.marker.setPopupContent(entry.popupContent);
      entry.popupMarkup = popup;
      if (groupedPopupWasOpen) attachGroupedPopupListeners(entry);
      if (groupedPopupWasOpen && groupedPopupScrollTop !== null && entry.groupGrid) {
        entry.groupGrid.scrollTop = groupedPopupScrollTop;
      }
      if (groupedPopupWasOpen && groupedPopupSelectedPath) showGroupedMember(entry, groupedPopupSelectedPath);
      return true;
    }
    if (entry.popupContent && typeof entry.marker.setPopupContent === 'function') {
      entry.marker.setPopupContent(popup);
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

  function updatePopupWithoutAutoPan(popup, update) {
    if (!popup || typeof update !== 'function') return false;
    var options = popup.options;
    if (!options || options.autoPan === false) {
      update();
      return true;
    }
    var autoPan = options.autoPan;
    options.autoPan = false;
    try {
      update();
    } finally {
      options.autoPan = autoPan;
    }
    return true;
  }

  function popupElementFor(marker, event) {
    var popup = event && event.popup;
    if (!popup && marker && typeof marker.getPopup === 'function') popup = marker.getPopup();
    if (popup && typeof popup.getElement === 'function') return popup.getElement();
    return null;
  }

  // Leaflet auto-pans when a popup opens, but grouped-member selection changes
  // the mounted popup DOM without reopening it. Recalculate the same Popup
  // instance's layout, then pan the map using the resulting DOM bounds.
  function updateOpenPopupViewport(entry) {
    if (!entry || !entry.groupPopupElement) return false;
    syncPopupContentRoot(entry);
    popupDiagnostics.viewportFitRequests += 1;
    var popup = entry.groupPopup;
    if (!popup && entry.marker && typeof entry.marker.getPopup === 'function') {
      popup = entry.marker.getPopup();
    }
    if (!popup || typeof popup.update !== 'function') return false;
    entry.groupLayoutVersion = Number(entry.groupLayoutVersion || 0) + 1;
    popupFitEntry = entry;
    popupFitVersion = entry.groupLayoutVersion;
    if (popupFitFrame !== null) {
      popupDiagnostics.viewportFitCoalesced += 1;
      return true;
    }
    var windowImpl = config.window || (typeof window !== 'undefined' ? window : null);
    var refresh = function () {
      popupFitFrame = null;
      var fitEntry = popupFitEntry;
      var fitVersion = popupFitVersion;
      popupFitEntry = null;
      if (!fitEntry || !fitEntry.groupPopupElement || fitEntry.groupLayoutVersion !== fitVersion) return;
      var fitPopup = fitEntry.groupPopup;
      if (!fitPopup && fitEntry.marker && typeof fitEntry.marker.getPopup === 'function') {
        fitPopup = fitEntry.marker.getPopup();
      }
      if (!fitPopup) return;
      var currentEntry = fitEntry;
      var preservedScrollTop = currentEntry.groupGrid && Number.isFinite(Number(currentEntry.groupGrid.scrollTop))
        ? Number(currentEntry.groupGrid.scrollTop) : null;
      popupDiagnostics.viewportFitPasses += 1;
      updatePopupWithoutAutoPan(fitPopup, function () { fitPopup.update(); });
      if (preservedScrollTop !== null) {
        var refreshedGrid = groupGridFor(currentEntry);
        if (refreshedGrid) refreshedGrid.scrollTop = preservedScrollTop;
      }
      debug.log('group-popup-viewport-layout', {
        path: itemPath(currentEntry.item),
        selectedMemberPath: currentEntry.groupSelectedPath || '',
        method: 'public-element-update',
      });
      if (typeof map.getContainer !== 'function' ||
          typeof currentEntry.groupPopupElement.getBoundingClientRect !== 'function') return;
      var mapContainer = map.getContainer();
      if (!mapContainer || typeof mapContainer.getBoundingClientRect !== 'function' ||
          typeof map.panBy !== 'function') return;
      var panIntoView = function (attempt) {
        var mapRect = mapContainer.getBoundingClientRect();
        var popupRect = currentEntry.groupPopupElement.getBoundingClientRect();
        var mapWidth = mapRect.right - mapRect.left;
        var mapHeight = mapRect.bottom - mapRect.top;
        // A popup taller/wider than its containing map cannot be fully placed
        // inside it. Leave its position alone rather than causing a disruptive
        // pan that still cannot satisfy the bounds.
        if (popupRect.width > mapWidth || popupRect.height > mapHeight) return;
        var padding = 8;
        var offsetX = 0;
        var offsetY = 0;
        if (popupRect.left < mapRect.left + padding) offsetX = popupRect.left - mapRect.left - padding;
        else if (popupRect.right > mapRect.right - padding) offsetX = popupRect.right - mapRect.right + padding;
        if (popupRect.top < mapRect.top + padding) offsetY = popupRect.top - mapRect.top - padding;
        else if (popupRect.bottom > mapRect.bottom - padding) offsetY = popupRect.bottom - mapRect.bottom + padding;
        debug.log('group-popup-viewport-pan', {
          path: itemPath(currentEntry.item),
          selectedMemberPath: currentEntry.groupSelectedPath || '',
          attempt: attempt,
          offsetX: offsetX,
          offsetY: offsetY,
        });
        if (!offsetX && !offsetY) {
          popupDiagnostics.viewportFitNoops += 1;
          return;
        }
        popupDiagnostics.viewportFitPans += 1;
        map.panBy([offsetX, offsetY], {animate: false});
        // Leaflet completes a non-animated pan synchronously, but its popup
        // transform is reconciled on the following frame. Recheck once so the
        // final visual popup bounds, rather than its pre-transform bounds,
        // determine the fit.
        if (attempt === 0 && windowImpl && typeof windowImpl.requestAnimationFrame === 'function') {
          windowImpl.requestAnimationFrame(function () { panIntoView(1); });
        }
      };
      panIntoView(0);
    };
    if (windowImpl && typeof windowImpl.requestAnimationFrame === 'function') {
      popupFitFrame = windowImpl.requestAnimationFrame(refresh);
    } else {
      refresh();
    }
    return true;
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
    var member = members.find(function (candidate) { return groupMemberPath(candidate) === wanted; }) || null;
    return presentMember(member);
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
  if (typeof cell.setAttribute === 'function') {
    cell.setAttribute('data-photo-map-thumbnail-state', String(member.photoMapThumbnailState || 'loading'));
  }
  return true;
}

  function renderGroupedMemberSelection(entry, path) {
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
    return !!member;
  }

  function syncPopupContentRoot(entry) {
    if (!entry || !entry.groupPopupElement || typeof entry.groupPopupElement.querySelector !== 'function') return false;
    var contentNode = entry.groupPopupElement.querySelector('.leaflet-popup-content');
    var currentRoot = contentNode && (contentNode.firstElementChild || contentNode.firstChild);
    if (!currentRoot || currentRoot === entry.popupContent) return false;
    entry.popupContent = currentRoot;
    var popup = entry.groupPopup;
    if (!popup && entry.marker && typeof entry.marker.getPopup === 'function') popup = entry.marker.getPopup();
    if (popup && typeof popup.setContent === 'function') {
      updatePopupWithoutAutoPan(popup, function () { popup.setContent(currentRoot); });
    }
    attachGroupedPopupListeners(entry, null, {notifyOpen: false});
    if (entry.groupSelectedPath) renderGroupedMemberSelection(entry, entry.groupSelectedPath);
    return true;
  }

  function showGroupedMember(entry, path) {
    syncPopupContentRoot(entry);
    var wanted = String(path || '');
    var member = wanted ? groupMemberFor(entry, wanted) : null;
    renderGroupedMemberSelection(entry, wanted);
    if (typeof config.onGroupedMemberSelect === 'function') {
      config.onGroupedMemberSelect(entry.item, member);
    }
    updateOpenPopupViewport(entry);
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
    var detached = false;
    if (entry.groupGridClick && typeof entry.groupGrid.removeEventListener === 'function') {
      entry.groupGrid.removeEventListener('click', entry.groupGridClick);
      detached = true;
    }
    if (entry.groupGridScroll && typeof entry.groupGrid.removeEventListener === 'function') {
      entry.groupGrid.removeEventListener('scroll', entry.groupGridScroll);
      detached = true;
    }
    if (entry.groupPopupClick && entry.groupPopupElement &&
        typeof entry.groupPopupElement.removeEventListener === 'function') {
      entry.groupPopupElement.removeEventListener('click', entry.groupPopupClick);
      detached = true;
    }
    if (detached) popupDiagnostics.listenerDetaches += 1;
    entry.groupGrid = null;
    entry.groupPopup = null;
    entry.groupGridClick = null;
    entry.groupGridScroll = null;
    entry.groupPopupClick = null;
  }

  function handleGroupedPopupClick(entry, root, clickEvent) {
    var target = clickEvent && clickEvent.target;
    while (target && target !== root && typeof target.getAttribute === 'function' &&
        !target.getAttribute('data-photo-map-group-member-path') &&
        !target.getAttribute('data-photo-map-group-back')) target = target.parentNode;
    if (!target || target === root) return false;
    if (target.getAttribute('data-photo-map-group-back')) showGroupedMember(entry, '');
    else showGroupedMember(entry, target.getAttribute('data-photo-map-group-member-path'));
    return true;
  }

  function attachGroupedPopupListeners(entry, event, options) {
    if (!isGroupedPhoto(entry.item)) return;
    var notifyOpen = !options || options.notifyOpen !== false;
    var popup = event && event.popup;
    if (!popup && entry.marker && typeof entry.marker.getPopup === 'function') popup = entry.marker.getPopup();
    var root = popupElementFor(entry.marker, {popup: popup});
    var grid = root && typeof root.querySelector === 'function'
      ? (root.querySelector('[data-photo-map-group-grid]') || root.querySelector('.photo-map-group-grid')) : null;
    if (root && root === entry.groupPopupElement && grid === entry.groupGrid &&
        entry.groupPopupClick && entry.groupGridScroll) {
      entry.groupPopup = popup;
      if (notifyOpen && typeof config.onGroupedPopupOpen === 'function') {
        config.onGroupedPopupOpen(entry.item, visibleGroupedMembers(entry));
      }
      return;
    }
    detachGroupedPopupListeners(entry);
    entry.groupPopup = popup;
    entry.groupPopupElement = root;
    if (entry.groupPopupElement && entry.groupPopupElement !== entry.groupPopupElementBeforeAttach) {
      popupDiagnostics.rootMounts += 1;
    }
    entry.groupPopupElementBeforeAttach = entry.groupPopupElement;
    entry.groupGrid = grid;
    if (root && typeof root.addEventListener === 'function') {
      entry.groupPopupClick = function (clickEvent) {
        handleGroupedPopupClick(entry, root, clickEvent);
      };
      root.addEventListener('click', entry.groupPopupClick);
    }
    if (grid && typeof grid.addEventListener === 'function') {
      entry.groupGridScroll = function () { notifyGroupedPopupViewport(entry); };
      grid.addEventListener('scroll', entry.groupGridScroll);
    }
    if (entry.groupPopupClick || entry.groupGridScroll) popupDiagnostics.listenerAttaches += 1;
    if (notifyOpen && typeof config.onGroupedPopupOpen === 'function') {
      config.onGroupedPopupOpen(entry.item, visibleGroupedMembers(entry));
    }
  }

  function updateGroupedMember(entry, path, patch) {
    if (!entry || !isGroupedPhoto(entry.item)) return false;
    var wanted = String(path || '');
    var member = groupMemberFor(entry, wanted);
    if (!member) return false;
    if (typeof config.getThumbnailForPath !== 'function') return false;
    var previousMember = member;
    var previousPresentedItem = presentItem(entry.item);
    var nextMember = groupMemberFor(entry, wanted);
    var memberChanged = previousMember.photoMapThumbnailUrl !== nextMember.photoMapThumbnailUrl ||
      previousMember.photoMapThumbnailState !== nextMember.photoMapThumbnailState;
    var nextPresentedItem = presentItem(entry.item);
    var cell = groupCellFor(entry, wanted);
    var requestedState = patch && patch.photoMapThumbnailState;
    var renderedState = cell && typeof cell.getAttribute === 'function'
      ? cell.getAttribute('data-photo-map-thumbnail-state') : null;
    var cellStateChanged = requestedState !== undefined && renderedState !== String(requestedState);
    if (!memberChanged && !cellStateChanged &&
        !groupThumbnailPresentationChanged(previousPresentedItem, nextPresentedItem) &&
        !(patch && patch.photoMapThumbnailUrl)) return false;
    if (cell) renderGroupCell(cell, member);
    var selected = entry.groupSelectedPath === wanted;
    if (selected) {
      var selection = groupSelectionFor(entry);
      if (selection) selection.innerHTML = groupedMemberDetails(member);
      updateOpenPopupViewport(entry);
    }
    var presentedItem = nextPresentedItem;
    var isGroupThumbnailPatch = String(entry.item.photoMapGroupThumbnailPath || '') === wanted &&
      !!(patch && (patch.photoMapThumbnailUrl || patch.photoMapThumbnailState));
    if ((groupThumbnailPresentationChanged(previousPresentedItem, presentedItem) || isGroupThumbnailPatch) &&
        typeof entry.marker.setIcon === 'function') {
      var groupIcon = markerIcon(L, presentedItem, presentedItem.photoMapThumbnailState);
      if (groupIcon) entry.marker.setIcon(groupIcon);
    }
    if (cell) {
      // This is intentionally a cell-only DOM update so loading a thumbnail
      // never replaces the scroll container that the user may be dragging.
      entry.popupMarkup = markerPopup(presentedItem);
    } else if (!entry.groupPopupElement) {
      updatePopupContent(entry);
    }
    return true;
  }

  function createMarker(path, item) {
    var icon = markerIcon(L, presentItem(item), item.photoMapThumbnailState);
    var markerOptions = {
      title: markerAccessibleLabel(item),
      alt: markerAccessibleLabel(item),
      photoMapRepresentedMediaCount: isGroupedPhoto(item) ? groupedPhotoCount(item) : 1,
    };
    if (icon) markerOptions.icon = icon;
    var marker = L.marker([item.latitude, item.longitude], markerOptions);
    var popupContent = popupContentElement(config.document, presentItem(item));
    var popupMarkup = markerPopup(presentItem(item));
    var entry = {
      item: item,
      marker: marker,
      popupContent: popupContent,
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
    if (popupContent && typeof marker.bindPopup === 'function') {
      marker.bindPopup(popupContent);
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
        debug.log('marker-click', {
          path: path,
          grouped: isGroupedPhoto(current.item),
          groupMemberCount: Array.isArray(current.item.photoMapGroupMembers)
            ? current.item.photoMapGroupMembers.length : 0,
          hasThumbnail: !!current.item.photoMapThumbnailUrl,
        });
        config.onMarkerSelect(current.item, marker);
      });
    }
    if (typeof marker.on === 'function') {
      marker.on('popupopen', function (event) {
        activePopupPath = path;
        attachGroupedPopupListeners(entry, event);
        debug.log('marker-popupopen', {
          path: path,
          grouped: isGroupedPhoto(entry.item),
          groupMemberCount: Array.isArray(entry.item.photoMapGroupMembers)
            ? entry.item.photoMapGroupMembers.length : 0,
          selectedMemberPath: entry.groupSelectedPath || '',
        });
      });
      marker.on('popupclose', function () {
        if (activePopupPath === path) activePopupPath = null;
        if (isGroupedPhoto(entry.item)) {
          detachGroupedPopupListeners(entry);
          entry.groupPopupElement = null;
          entry.groupPopup = null;
          if (typeof config.onGroupedPopupClose === 'function') config.onGroupedPopupClose(entry.item);
        }
        debug.log('marker-popupclose', {
          path: path,
          grouped: isGroupedPhoto(entry.item),
          selectedMemberPath: entry.groupSelectedPath || '',
        });
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
    // MarkerClusterGroup's incremental API is part of the map adapter
    // contract. Rebuilding the whole layer is not equivalent: it can close a
    // grouped popup, discard spiderfy state, and cause unrelated marker work
    // to look like a viewport change. Test doubles use the same small
    // incremental fixture as the real adapter.
    if (!canReconcile) return false;
    removedEntries.forEach(function (entry) { markerLayer.removeLayer(entry.marker); });
    addedEntries.forEach(function (entry) { markerLayer.addLayer(entry.marker); });
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
      // Thumbnail readiness is supplied by the host-owned ThumbnailStore via
      // presentItem(). Do not copy a previous marker's thumbnail fields into
      // the immutable catalogue item during reconciliation.
      var markerItem = item;
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
        var groupedIcon = markerIcon(L, presentItem(markerItem), markerItem.photoMapThumbnailState);
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
    getMarkerItem: function (path) {
      var entry = markerEntries.get(String(path || ''));
      return entry ? entry.item : null;
    },
    getDebugState: function () {
      var entry = activePopupPath ? markerEntries.get(activePopupPath) : null;
      var popup = entry && (entry.groupPopup || (entry.marker && typeof entry.marker.getPopup === 'function'
        ? entry.marker.getPopup() : null));
      var content = entry && entry.groupPopupElement && typeof entry.groupPopupElement.querySelector === 'function'
        ? entry.groupPopupElement.querySelector('.leaflet-popup-content') : null;
      var selection = groupSelectionFor(entry);
      var grid = groupGridFor(entry);
      return {
        activePopupPath: activePopupPath || '',
        grouped: !!(entry && isGroupedPhoto(entry.item)),
        selectedMemberPath: entry && entry.groupSelectedPath || '',
        popupMounted: !!(entry && entry.groupPopupElement),
        popupContentLength: content ? content.innerHTML.length : 0,
        popupStoredContentLength: popup && typeof popup.getContent === 'function'
          ? String(popup.getContent() || '').length : 0,
        selectionDetailsMounted: !!(selection && selection.querySelector &&
          selection.querySelector('.photo-map-group-selection-details')),
        gridMemberCount: grid && typeof grid.querySelectorAll === 'function'
          ? grid.querySelectorAll('[data-photo-map-group-member-path]').length : 0,
        gridScrollTop: grid && Number.isFinite(Number(grid.scrollTop)) ? Number(grid.scrollTop) : null,
        popupDiagnostics: Object.assign({}, popupDiagnostics),
        recentEvents: debug.events(),
      };
    },
    showGroupedMemberForPath: function (path, memberPath) {
      var entry = markerEntries.get(String(path || ''));
      if (!entry || !isGroupedPhoto(entry.item)) return false;
      return showGroupedMember(entry, String(memberPath || ''));
    },
    fitOpenPopupIntoView: function (path) {
      var wanted = String(path || activePopupPath || '');
      var entry = markerEntries.get(wanted);
      return updateOpenPopupViewport(entry);
    },
    openPopupForPath: function (path) {
      var wanted = String(path || '');
      var entry = markerEntries.get(wanted);
      if (!entry || !entry.marker || typeof entry.marker.openPopup !== 'function') return false;
      // Closing a full-screen preview returns to the same mounted Leaflet
      // popup. Calling openPopup again makes Leaflet restore its original
      // popup markup, which predates progressive group-thumbnail updates and
      // resets the grid scroll position. Keep the live DOM intact; the host
      // will rebind listeners and restore the selected member separately.
      if (activePopupPath === wanted && entry.groupPopupElement) return true;
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
