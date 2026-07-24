const path = require("node:path");
const {pathToFileURL} = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  return import(pathToFileURL(absolutePath).href);
}

test("Photo Map creates a Leaflet map with direct tiles and cluster layer", async () => {
  const mapModule = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/map.js");
  const calls = [];
  const fakeMap = {
    setView(view, zoom) { calls.push(["setView", view, zoom]); },
    invalidateSize(options) { calls.push(["invalidateSize", options]); },
    remove() { calls.push(["remove"]); },
  };
  const fakeLeaflet = {
    map(element, options) { calls.push(["map", element, options]); return fakeMap; },
    tileLayer(url, options) {
      calls.push(["tileLayer", url, options]);
      return {addTo(map) { calls.push(["tiles.addTo", map]); }};
    },
    markerClusterGroup(options) {
      calls.push(["markerClusterGroup", options]);
      return {addTo(map) { calls.push(["markers.addTo", map]); }};
    },
  };

  const controller = mapModule.createPhotoMap(fakeLeaflet, "map-element");
  controller.invalidateSize();
  controller.destroy();

  assert.equal(calls[0][0], "map");
  assert.equal(calls[1][0], "setView");
  assert.equal(calls[2][0], "tileLayer");
  assert.equal(calls[2][1], "https://tile.openstreetmap.org/{z}/{x}/{y}.png");
  assert.equal(calls[3][0], "tiles.addTo");
  assert.equal(calls[4][0], "markerClusterGroup");
  assert.equal(calls[5][0], "markers.addTo");
  assert.equal(calls[6][0], "invalidateSize");
  assert.equal(calls[7][0], "remove");
});

test("Photo Map Leaflet loader injects vendored assets once", async () => {
  const loader = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/leaflet.js");
  const elements = new Map();
  const appended = [];
  const win = {};
  const doc = {
    head: {
      appendChild(element) {
        appended.push(element);
        elements.set(element.id, element);
        if (element.tagName === "SCRIPT") {
          if (element.src.endsWith("leaflet.js")) win.L = {};
          if (element.src.endsWith("leaflet.markercluster.js")) win.L.markerClusterGroup = () => ({});
          element.onload();
        }
      },
    },
    getElementById(id) { return elements.get(id) || null; },
    createElement(tagName) {
      return {tagName: tagName.toUpperCase(), setAttribute() {}};
    },
  };

  const first = await loader.ensurePhotoMapLeaflet(doc, win);
  const second = await loader.ensurePhotoMapLeaflet(doc, win);

  assert.equal(first, win.L);
  assert.equal(second, win.L);
  assert.deepEqual(appended.filter((element) => element.tagName === "SCRIPT").map((element) => element.src), [
    "/assets/vendor/leaflet/leaflet.js",
    "/assets/vendor/leaflet/markercluster/leaflet.markercluster.js",
  ]);
  assert.equal(appended.filter((element) => element.tagName === "LINK").length, 3);
});

test("Photo Map renders located media into markers and fits once to useful bounds", async () => {
  const mapModule = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/map.js");
  const calls = [];
  const fakeMap = {
    setView() {},
    invalidateSize() {},
    fitBounds(bounds, options) { calls.push(["fitBounds", bounds, options]); },
    remove() {},
  };
  const markerLayer = {
    addTo() {},
    clearLayers() { calls.push(["clearLayers"]); },
    addLayers(markers) { calls.push(["addLayers", markers]); },
  };
  const fakeLeaflet = {
    map() { return fakeMap; },
    tileLayer() { return {addTo() {}}; },
    markerClusterGroup() { return markerLayer; },
    marker(point, options) {
      calls.push(["marker", point, options]);
      return {bindPopup(popup) { calls.push(["bindPopup", popup]); }};
    },
    latLngBounds(points) { return {points}; },
  };

  const controller = mapModule.createPhotoMap(fakeLeaflet, "map-element");
  const count = controller.setMarkerItems([{
    path: "Camera Uploads/photo.jpg",
    display_name: "photo.jpg",
    latitude: 40.5,
    longitude: -74,
    captureDate: "2024:01:01 12:00:00",
  }]);
  const fitted = controller.fitToItems([{
    latitude: 40.5,
    longitude: -74,
  }]);

  assert.equal(count, 1);
  assert.equal(fitted, true);
  assert.deepEqual(calls[0][0], "marker");
  assert.deepEqual(calls[0][1], [40.5, -74]);
  assert.equal(calls[1][0], "bindPopup");
  assert.equal(calls[2][0], "clearLayers");
  assert.equal(calls[3][0], "addLayers");
  assert.equal(calls[4][0], "fitBounds");
  assert.deepEqual(calls[4][1], {points: [[40.5, -74]]});
  assert.deepEqual(calls[4][2], {padding: [24, 24], maxZoom: 15});
});

test("Photo Map popup exposes metadata and a safe full-preview link", async () => {
  const mapModule = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/map.js");
  let popup = "";
  const markerLayer = {
    addTo() {},
    clearLayers() {},
    addLayers() {},
  };
  const fakeLeaflet = {
    map() { return {setView() {}, invalidateSize() {}, remove() {}}; },
    tileLayer() { return {addTo() {}}; },
    markerClusterGroup() { return markerLayer; },
    marker() {
      return {
        bindPopup(content) { popup = content; },
        on() {},
      };
    },
  };

  const controller = mapModule.createPhotoMap(fakeLeaflet, "map-element");
  controller.setMarkerItems([{
    path: "Camera Uploads/photo & one.jpg",
    photoMapSourcePath: "Camera Uploads/photo & one.jpg",
    display_name: "photo & one.jpg",
    latitude: 40.5,
    longitude: -74,
    captureDate: "2024:01:01 12:00:00",
    listingDateMs: Date.UTC(2024, 0, 2),
    photoMapThumbnailUrl: "/thumbnail?path=Camera+Uploads%2Fphoto.jpg&source=remote",
  }]);

  assert.match(popup, /photo &amp; one\.jpg/);
  assert.match(popup, /Latitude/);
  assert.match(popup, />40\.5</);
  assert.match(popup, />-74</);
  assert.match(popup, /2024:01:01 12:00:00/);
  assert.match(popup, /2024-01-02T00:00:00\.000Z/);
  assert.match(popup, /href="\/file\?path=Camera\+Uploads%2Fphoto\+%26\+one\.jpg&amp;source=remote"/);
  assert.match(popup, /target="_blank"/);
  assert.match(popup, /rel="noopener noreferrer"/);
  assert.match(popup, /<img[^>]+alt="Thumbnail for photo &amp; one\.jpg"/);
});

test("Photo Map video popup keeps GPS details and shows the neutral thumbnail fallback", async () => {
  const mapModule = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/map.js");
  let popup = "";
  const markerLayer = {addTo() {}, clearLayers() {}, addLayers() {}};
  const fakeLeaflet = {
    map() { return {setView() {}, invalidateSize() {}, remove() {}}; },
    tileLayer() { return {addTo() {}}; },
    markerClusterGroup() { return markerLayer; },
    marker() {
      return {bindPopup(content) { popup = content; }, on() {}};
    },
  };

  const controller = mapModule.createPhotoMap(fakeLeaflet, "map-element");
  controller.setMarkerItems([{
    path: "Camera Uploads/video.mov",
    display_name: "video.mov",
    mediaKind: "video",
    latitude: 40,
    longitude: -73,
    listingDateMs: Date.UTC(2024, 0, 3),
  }]);

  assert.match(popup, /Video thumbnail unavailable/);
  assert.match(popup, /photo-map-preview-video-icon/);
  assert.match(popup, /Open video preview/);
  assert.doesNotMatch(popup, /<img/);
});

test("Photo Map lifecycle debug logs are enabled by default and toggleable", async () => {
  const mapModule = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/map.js");
  const calls = [];
  const mapListeners = {};
  const clusterListeners = {};
  const markers = [];
  const fakeMap = {
    setView() {},
    invalidateSize() {},
    remove() {},
    on(name, callback) { mapListeners[name] = callback; },
  };
  const markerLayer = {
    addTo() {},
    clearLayers() {},
    addLayers() {},
    on(name, callback) { clusterListeners[name] = callback; },
    trigger(name, event) { if (clusterListeners[name]) clusterListeners[name](event); },
  };
  const fakeLeaflet = {
    map() { return fakeMap; },
    tileLayer() { return {addTo() {}}; },
    markerClusterGroup() { return markerLayer; },
    marker(_point, options) {
      const listeners = {};
      const marker = {
        options,
        bindPopup() {},
        on(name, callback) { listeners[name] = callback; },
        trigger(name, event) { if (listeners[name]) listeners[name](event); },
      };
      markers.push(marker);
      return marker;
    },
  };
  const controller = mapModule.createPhotoMap(fakeLeaflet, "map-element", {
    console: {debug(...args) { calls.push(args); }},
  });

  controller.setMarkerItems([{path: "photo.jpg", display_name: "photo.jpg", latitude: 1, longitude: 2}]);
  markers[0].trigger("popupopen", {layer: markers[0]});
  markers[0].trigger("popupclose", {layer: markers[0]});
  clusterListeners.spiderfied({layer: {getChildCount() { return 3; }}});

  assert.equal(controller.isDebugEnabled(), true);
  assert.ok(calls.some((call) => call[1] === "map-created"));
  assert.ok(calls.some((call) => call[1] === "markers-reconciled"));
  assert.ok(calls.some((call) => call[1] === "marker-popupopen"));
  assert.ok(calls.some((call) => call[1] === "marker-popupclose"));
  assert.ok(calls.some((call) => call[1] === "cluster-spiderfied" && call[2].childCount === 3));

  const countBeforeDisable = calls.length;
  controller.setDebugEnabled(false);
  markers[0].trigger("popupclose", {layer: markers[0]});
  markerLayer.trigger("spiderfied", {layer: {getChildCount() { return 2; }}});
  assert.equal(calls.length, countBeforeDisable);

  controller.setDebugEnabled(true);
  mapListeners.popupclose({popup: {}});
  assert.equal(calls[calls.length - 1][1], "map-popupclose");
});

test("Photo Map reconciles marker metadata without replacing the marker or popup binding", async () => {
  const mapModule = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/map.js");
  const createdMarkers = [];
  const layerCalls = [];
  const fakeMap = {
    setView() {},
    invalidateSize() {},
    remove() {},
  };
  const markerLayer = {
    addTo() {},
    addLayer(marker) { layerCalls.push(["addLayer", marker]); },
    removeLayer(marker) { layerCalls.push(["removeLayer", marker]); },
    refreshClusters(markers) { layerCalls.push(["refreshClusters", markers]); },
  };
  const fakeLeaflet = {
    map(_element, options) {
      assert.equal(options.closePopupOnClick, false);
      return fakeMap;
    },
    tileLayer() { return {addTo() {}}; },
    markerClusterGroup() { return markerLayer; },
    marker(point, options) {
      const listeners = {};
      const marker = {
        _point: point,
        options,
        bindCount: 0,
        setPopupContentCount: 0,
        bindPopup(content) { this.bindCount += 1; this.popup = content; },
        setPopupContent(content) { this.setPopupContentCount += 1; this.popup = content; },
        getLatLng() { return {lat: this._point[0], lng: this._point[1]}; },
        setLatLng(next) { this._point = next; },
        on(name, callback) { listeners[name] = callback; },
      };
      createdMarkers.push(marker);
      return marker;
    },
  };

  const controller = mapModule.createPhotoMap(fakeLeaflet, "map-element");
  const item = {path: "photo.jpg", display_name: "photo.jpg", latitude: 1, longitude: 2};
  controller.setMarkerItems([item]);
  const marker = createdMarkers[0];
  controller.setMarkerItems([Object.assign({}, item, {captureDate: "2024:01:01 12:00:00"})]);

  assert.equal(createdMarkers.length, 1);
  assert.equal(marker.bindCount, 1);
  assert.equal(marker.setPopupContentCount, 1);
  assert.equal(layerCalls.filter((call) => call[0] === "removeLayer").length, 0);
  assert.equal(layerCalls.filter((call) => call[0] === "refreshClusters").length, 1);
  assert.match(marker.popup, /2024:01:01 12:00:00/);
});

test("Photo Map keeps the same pin popup open when the pin is clicked again", async () => {
  const mapModule = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/map.js");
  const fakeMap = {
    setView() {},
    invalidateSize() {},
    remove() {},
  };
  const markerLayer = {addTo() {}, addLayer() {}, removeLayer() {}};
  const fakeLeaflet = {
    map() { return fakeMap; },
    tileLayer() { return {addTo() {}}; },
    markerClusterGroup() { return markerLayer; },
    marker() {
      const listeners = new Map();
      const marker = {
        open: false,
        bindPopup() {
          listeners.get("click").push(() => {
            if (this.open) {
              this.open = false;
              this.trigger("popupclose");
            } else {
              this.open = true;
              this.trigger("popupopen");
            }
          });
        },
        isPopupOpen() { return this.open; },
        openPopup() { this.open = true; this.trigger("popupopen"); },
        on(name, callback) {
          if (!listeners.has(name)) listeners.set(name, []);
          listeners.get(name).push(callback);
        },
        trigger(name, event) {
          (listeners.get(name) || []).slice().forEach((callback) => callback(event));
        },
      };
      return marker;
    },
  };

  const controller = mapModule.createPhotoMap(fakeLeaflet, "map-element");
  controller.setMarkerItems([{path: "photo.jpg", latitude: 1, longitude: 2}]);
  // The fake layer records the marker just as the real layer retains it.
  markerLayer.addLayer = function (added) { this._lastMarker = added; };
  // Re-add to populate the recording after replacing the test double method.
  controller.setMarkerItems([]);
  controller.setMarkerItems([{path: "photo.jpg", latitude: 1, longitude: 2}]);
  const currentMarker = markerLayer._lastMarker;
  currentMarker.trigger("click");
  assert.equal(currentMarker.isPopupOpen(), true);
  currentMarker.trigger("click");
  assert.equal(currentMarker.isPopupOpen(), true);
});

test("Photo Map restores a visible spiderfied cluster after membership changes", async () => {
  const mapModule = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/map.js");
  const createdMarkers = [];
  const fakeMap = {
    setView() {},
    invalidateSize() {},
    remove() {},
    getBounds() { return {contains() { return true; }}; },
  };
  const cluster = {
    spiderfyCount: 0,
    getAllChildMarkers() { return createdMarkers.slice(0, 2); },
    spiderfy() { this.spiderfyCount += 1; },
  };
  const markerLayer = {
    _spiderfied: null,
    addTo() {},
    addLayer(marker) {
      marker.__parent = cluster;
      this._spiderfied = null;
    },
    removeLayer() {},
    getVisibleParent() { return null; },
  };
  const fakeLeaflet = {
    map() { return fakeMap; },
    tileLayer() { return {addTo() {}}; },
    markerClusterGroup() { return markerLayer; },
    marker(point) {
      const marker = {
        _point: point,
        bindPopup() {},
        on() {},
        getLatLng() { return {lat: this._point[0], lng: this._point[1]}; },
        setLatLng(next) { this._point = next; },
      };
      createdMarkers.push(marker);
      return marker;
    },
  };

  const controller = mapModule.createPhotoMap(fakeLeaflet, "map-element");
  controller.setMarkerItems([
    {path: "one.jpg", latitude: 1, longitude: 2},
    {path: "two.jpg", latitude: 1, longitude: 2},
  ]);
  markerLayer._spiderfied = cluster;
  controller.setMarkerItems([
    {path: "one.jpg", latitude: 1, longitude: 2},
    {path: "two.jpg", latitude: 1, longitude: 2},
    {path: "three.jpg", latitude: 1, longitude: 2},
  ]);

  assert.equal(cluster.spiderfyCount, 1);
});
