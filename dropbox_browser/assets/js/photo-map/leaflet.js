var LEAFLET_SCRIPT = '/assets/vendor/leaflet/leaflet.js';
var CLUSTER_SCRIPT = '/assets/vendor/leaflet/markercluster/leaflet.markercluster.js';
var LEAFLET_CSS = '/assets/vendor/leaflet/leaflet.css';
var CLUSTER_CSS = '/assets/vendor/leaflet/markercluster/MarkerCluster.css';
var CLUSTER_DEFAULT_CSS = '/assets/vendor/leaflet/markercluster/MarkerCluster.Default.css';

function addStylesheet(doc, href, id) {
  if (doc.getElementById(id)) return;
  var link = doc.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = href;
  doc.head.appendChild(link);
}

function loadScript(doc, href, id) {
  var existing = doc.getElementById(id);
  if (existing) return Promise.resolve();
  return new Promise(function (resolve, reject) {
    var script = doc.createElement('script');
    script.id = id;
    script.src = href;
    script.async = true;
    script.onload = resolve;
    script.onerror = function () { reject(new Error('Could not load Photo Map asset: ' + href)); };
    doc.head.appendChild(script);
  });
}

export function ensurePhotoMapLeaflet(doc, win) {
  if (win.L && typeof win.L.markerClusterGroup === 'function') return Promise.resolve(win.L);
  if (win.__photoMapLeafletPromise) return win.__photoMapLeafletPromise;
  addStylesheet(doc, LEAFLET_CSS, 'photo-map-leaflet-css');
  addStylesheet(doc, CLUSTER_CSS, 'photo-map-markercluster-css');
  addStylesheet(doc, CLUSTER_DEFAULT_CSS, 'photo-map-markercluster-default-css');
  win.__photoMapLeafletPromise = loadScript(doc, LEAFLET_SCRIPT, 'photo-map-leaflet-js')
    .then(function () { return loadScript(doc, CLUSTER_SCRIPT, 'photo-map-markercluster-js'); })
    .then(function () {
      if (!win.L || typeof win.L.markerClusterGroup !== 'function') {
        throw new Error('Photo Map Leaflet clustering asset did not initialize.');
      }
      return win.L;
    });
  return win.__photoMapLeafletPromise;
}
