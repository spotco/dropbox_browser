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
