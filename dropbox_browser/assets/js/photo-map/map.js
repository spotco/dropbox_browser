export const PHOTO_MAP_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const PHOTO_MAP_TILE_ATTRIBUTION = '&copy; OpenStreetMap contributors';
export const PHOTO_MAP_INITIAL_VIEW = [20, 0];
export const PHOTO_MAP_INITIAL_ZOOM = 2;
export const PHOTO_MAP_MIN_ZOOM = 1;
export const PHOTO_MAP_MAX_ZOOM = 19;
export const PHOTO_MAP_CLUSTER_RADIUS = 50;
export const PHOTO_MAP_FIT_MAX_ZOOM = 15;

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

function markerPopup(item) {
  var label = escapeHtml(markerLabel(item));
  var captureDate = item && (item.captureDate || item.capture_date);
  return '<strong>' + label + '</strong>' + (captureDate ? '<br>' + escapeHtml(captureDate) : '');
}

export function createPhotoMap(L, element) {
  var map = L.map(element, {
    minZoom: PHOTO_MAP_MIN_ZOOM,
    maxZoom: PHOTO_MAP_MAX_ZOOM,
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
  function setMarkerItems(items) {
    var markers = (Array.isArray(items) ? items : []).map(function (item) {
      var marker = L.marker([item.latitude, item.longitude], {title: markerLabel(item)});
      if (typeof marker.bindPopup === 'function') marker.bindPopup(markerPopup(item));
      return marker;
    });
    if (typeof markerLayer.clearLayers === 'function') markerLayer.clearLayers();
    if (typeof markerLayer.addLayers === 'function') markerLayer.addLayers(markers);
    else markers.forEach(function (marker) { markerLayer.addLayer(marker); });
    return markers.length;
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
    fitToItems: fitToItems,
    destroy: function () { map.remove(); },
  };
}
