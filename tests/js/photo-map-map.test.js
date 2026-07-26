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
  assert.equal(calls[4][1].disableClusteringAtZoom, mapModule.PHOTO_MAP_MAX_ZOOM);
  assert.equal(calls[4][1].spiderfyOnMaxZoom, false);
  assert.equal(calls[5][0], "markers.addTo");
  assert.equal(calls[6][0], "invalidateSize");
  assert.equal(calls[7][0], "remove");
});

test("Photo Map cluster badges sum represented grouped media", async () => {
  const mapModule = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/map.js");
  let clusterOptions;
  const fakeLeaflet = {
    map() { return {setView() {}, invalidateSize() {}, remove() {}}; },
    tileLayer() { return {addTo() {}}; },
    markerClusterGroup(options) { clusterOptions = options; return {addTo() {}}; },
    divIcon(options) { return options; },
  };

  mapModule.createPhotoMap(fakeLeaflet, "map-element");
  const icon = clusterOptions.iconCreateFunction({
    getAllChildMarkers() {
      return [
        {options: {photoMapRepresentedMediaCount: 105}},
        {options: {photoMapRepresentedMediaCount: 42}},
        {options: {}},
        {options: {photoMapRepresentedMediaCount: 74}},
        {options: {photoMapRepresentedMediaCount: 2}},
      ];
    },
  });

  assert.match(icon.html, />224</);
  assert.equal(icon.className, "marker-cluster marker-cluster-large");
  assert.deepEqual(icon.iconSize, [40, 40]);
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

test("Photo Map renders grouped pins with count tiers and accessible labels", async () => {
  const mapModule = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/map.js");
  const iconCalls = [];
  const markerOptions = [];
  const clusterOptions = [];
  const popups = [];
  const markerLayer = {
    addTo() {},
    addLayer() {},
    removeLayer() {},
  };
  const fakeLeaflet = {
    map() { return {setView() {}, invalidateSize() {}, remove() {}}; },
    tileLayer() { return {addTo() {}}; },
    markerClusterGroup(options) { clusterOptions.push(options); return markerLayer; },
    divIcon(options) { iconCalls.push(options); return options; },
    marker(_point, options) {
      markerOptions.push(options);
      return {
        bindPopup(content) { popups.push(content); },
        on() {},
      };
    },
  };

  const controller = mapModule.createPhotoMap(fakeLeaflet, "map-element");
  controller.setMarkerItems([
    {path: "group-small", display_name: "3 photos", photoMapGrouped: true, photoMapGroupCount: 3, latitude: 1, longitude: 2},
    {path: "group-medium", display_name: "12 photos", photoMapGrouped: true, photoMapGroupCount: 12, latitude: 2, longitude: 3},
    {path: "group-large", display_name: "50 photos", photoMapGrouped: true, photoMapGroupCount: 50, latitude: 3, longitude: 4},
  ]);

  assert.equal(clusterOptions[0].spiderfyOnMaxZoom, false);
  assert.deepEqual(iconCalls.map((icon) => icon.className), [
    "photo-map-group-icon photo-map-group-icon-tier-small",
    "photo-map-group-icon photo-map-group-icon-tier-medium",
    "photo-map-group-icon photo-map-group-icon-tier-large",
  ]);
  assert.match(iconCalls[0].html, /photo-map-group-marker-badge[^>]*aria-hidden="true">3</);
  assert.match(iconCalls[1].html, /photo-map-group-marker-badge[^>]*aria-hidden="true">12</);
  assert.match(iconCalls[2].html, /photo-map-group-marker-badge[^>]*aria-hidden="true">50</);
  assert.ok(iconCalls[0].iconSize[0] < iconCalls[1].iconSize[0]);
  assert.ok(iconCalls[1].iconSize[0] < iconCalls[2].iconSize[0]);
  assert.equal(markerOptions[0].title, "Grouped media pin containing 3 media items");
  assert.equal(markerOptions[2].alt, "Grouped media pin containing 50 media items");
  assert.match(popups[2], /photo-map-group-grid/);
  assert.match(popups[2], /Select a thumbnail to view its details/);
  assert.match(popups[2], /50 media items/);
  assert.doesNotMatch(popups[2], /photo-map-group:group-large/);
});

test("Photo Map reuses a grouped marker while updating its count tier", async () => {
  const mapModule = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/map.js");
  const createdMarkers = [];
  const markerLayer = {addTo() {}, addLayer() {}, removeLayer() {}};
  const fakeLeaflet = {
    map() { return {setView() {}, invalidateSize() {}, remove() {}}; },
    tileLayer() { return {addTo() {}}; },
    markerClusterGroup() { return markerLayer; },
    divIcon(options) { return options; },
    marker(_point, options) {
      const marker = {
        options,
        icons: [options.icon],
        bindPopup() {},
        on() {},
        setIcon(icon) { this.icons.push(icon); },
      };
      createdMarkers.push(marker);
      return marker;
    },
  };

  const controller = mapModule.createPhotoMap(fakeLeaflet, "map-element");
  const group = {path: "group", display_name: "3 photos", photoMapGrouped: true, photoMapGroupCount: 3, latitude: 1, longitude: 2};
  controller.setMarkerItems([group]);
  controller.setMarkerItems([Object.assign({}, group, {display_name: "12 photos", photoMapGroupCount: 12})]);

  assert.equal(createdMarkers.length, 1);
  assert.equal(createdMarkers[0].icons.length, 2);
  assert.match(createdMarkers[0].icons[1].className, /tier-medium/);
  assert.equal(createdMarkers[0].options.title, "Grouped media pin containing 12 media items");
});

test("Photo Map grouped pin renders and refreshes its newest-photo thumbnail", async () => {
  const mapModule = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/map.js");
  const icons = [];
  let marker;
  const fakeLeaflet = {
    map() { return {setView() {}, invalidateSize() {}, remove() {}}; },
    tileLayer() { return {addTo() {}}; },
    markerClusterGroup() { return {addTo() {}, addLayer() {}, removeLayer() {}}; },
    divIcon(options) { icons.push(options); return options; },
    marker(_point, options) {
      marker = {
        options,
        icons: [options.icon],
        bindPopup() {},
        on() {},
        setIcon(icon) { this.icons.push(icon); },
      };
      return marker;
    },
  };
  const controller = mapModule.createPhotoMap(fakeLeaflet, "map-element");
  controller.setMarkerItems([{
    path: "group",
    display_name: "2 media items",
    photoMapGrouped: true,
    photoMapGroupCount: 2,
    photoMapGroupThumbnailPath: "newest.jpg",
    latitude: 40.5,
    longitude: -74,
    photoMapGroupMembers: [
      {path: "older.jpg", display_name: "older.jpg", latitude: 40.5, longitude: -74},
      {path: "newest.jpg", display_name: "newest.jpg", latitude: 40.5, longitude: -74},
    ],
  }]);

  assert.match(icons[0].html, /Loading newest group thumbnail/);
  assert.equal(controller.setGroupedMemberThumbnail("older.jpg", {url: "/thumbnail?older"}), true);
  assert.equal(marker.icons.length, 1);
  assert.equal(controller.setGroupedMemberThumbnail("newest.jpg", {url: "/thumbnail?newest"}), true);
  assert.equal(marker.icons.length, 2);
  assert.match(marker.icons[1].html, /photo-map-group-marker-thumbnail/);
  assert.match(marker.icons[1].html, /thumbnail\?newest/);
  assert.equal(marker.options.title, "Grouped media pin containing 2 media items");
});

test("Photo Map grouped popup renders member grid and updates shared thumbnail state", async () => {
  const mapModule = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/map.js");
  let popup = "";
  const markerLayer = {addTo() {}, addLayer() {}, removeLayer() {}};
  const fakeLeaflet = {
    map() { return {setView() {}, invalidateSize() {}, remove() {}}; },
    tileLayer() { return {addTo() {}}; },
    markerClusterGroup() { return markerLayer; },
    divIcon(options) { return options; },
    marker() {
      return {
        bindPopup(content) { popup = content; },
        setPopupContent(content) { popup = content; },
        on() {},
      };
    },
  };
  const controller = mapModule.createPhotoMap(fakeLeaflet, "map-element");
  controller.setMarkerItems([{
    path: "group",
    display_name: "3 media items",
    photoMapGrouped: true,
    photoMapGroupCount: 3,
    latitude: 40.5,
    longitude: -74,
    photoMapGroupMembers: [
      {path: "one.jpg", display_name: "one.jpg", latitude: 40.5, longitude: -74, captureDate: "2024:01:01"},
      {path: "two.jpg", display_name: "two.jpg", latitude: 40.5, longitude: -74, captureDate: "2024:01:02"},
      {path: "clip.mov", display_name: "clip.mov", mediaKind: "video", photoMapMediaKind: "video", latitude: 40.5, longitude: -74},
    ],
  }]);

  assert.match(popup, /photo-map-group-grid/);
  assert.match(popup, /data-photo-map-group-member-path="one.jpg"/);
  assert.match(popup, /data-photo-map-group-member-path="two.jpg"/);
  assert.match(popup, /photo-map-group-grid-loading/);
  assert.match(popup, /photo-map-group-grid-loading/);
  assert.match(popup, /Select a thumbnail to view its details/);
  assert.doesNotMatch(popup, /photo-map-group:group/);

  assert.equal(controller.setGroupedMemberThumbnail("one.jpg", {url: "/thumbnail?one"}), true);
  assert.match(popup, /photo-map-group-grid-thumbnail/);
  assert.match(popup, /thumbnail\?one/);
  assert.doesNotMatch(popup, /<button[^>]*>\s*<button/);
  assert.equal(controller.setGroupedMemberThumbnailState("two.jpg", "error"), true);
  assert.match(popup, /photo-map-group-grid-error/);
});

test("Photo Map grouped popup selects video member details and keeps a safe grid return", async () => {
  const mapModule = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/map.js");
  const listeners = {};
  const cells = [];
  const selection = {innerHTML: ""};
  const contentRoot = {innerHTML: ""};
  const grid = {
    clientHeight: 120,
    scrollTop: 0,
    addEventListener(name, callback) { listeners["grid-" + name] = callback; },
    removeEventListener() {},
    querySelector(selector) {
      if (selector === ".leaflet-popup-content") return contentRoot;
      return selector === "[data-photo-map-group-grid]" ? this : null;
    },
    querySelectorAll() { return cells; },
  };
  const root = {
    addEventListener(name, callback) { listeners["root-" + name] = callback; },
    removeEventListener() {},
    querySelector(selector) {
      if (selector === ".leaflet-popup-content") return contentRoot;
      if (selector === "[data-photo-map-group-grid]") return grid;
      if (selector === "[data-photo-map-group-selection]") return selection;
      return null;
    },
  };
  const member = {
    path: "Camera Uploads/one & two.mov",
    display_name: "one & two.mov",
    photoMapMediaKind: "video",
    mediaKind: "video",
    latitude: 40.5,
    longitude: -74,
    captureDate: "2024:01:01 12:00:00",
    listingDateMs: Date.UTC(2024, 0, 2),
  };
  const cell = {
    parentNode: grid,
    attrs: {"data-photo-map-group-member-path": member.path},
    getAttribute(name) { return this.attrs[name] || null; },
    setAttribute(name, value) { this.attrs[name] = value; },
    offsetTop: 0,
    offsetHeight: 50,
  };
  cells.push(cell);
  let popup = "";
  let marker;
  const markerLayer = {addTo() {}, addLayer() {}, removeLayer() {}};
  const fakeLeaflet = {
    map() { return {setView() {}, invalidateSize() {}, remove() {}}; },
    tileLayer() { return {addTo() {}}; },
    markerClusterGroup() { return markerLayer; },
    divIcon(options) { return options; },
    marker() {
      marker = {
        bindPopup(content) { popup = content; },
        setPopupContent(content) { popup = content; },
        getPopup() { return {getElement() { return root; }}; },
        on(name, callback) { listeners["marker-" + name] = callback; },
        trigger(name, event) { if (listeners["marker-" + name]) listeners["marker-" + name](event); },
      };
      return marker;
    },
  };
  const controller = mapModule.createPhotoMap(fakeLeaflet, "map-element");
  controller.setMarkerItems([{
    path: "group",
    display_name: "1 photo",
    photoMapGrouped: true,
    photoMapGroupCount: 2,
    latitude: 40.5,
    longitude: -74,
    photoMapGroupMembers: [member],
  }]);
  marker.trigger("popupopen", {popup: {getElement() { return root; }}});
  // A preview overlay can restore the URL while Leaflet keeps this popup
  // mounted and therefore skips a second popupopen event. The public refresh
  // hook must restore delegated grid handling in that case.
  listeners["grid-click"] = null;
  assert.equal(controller.refreshPopupListenersForPath("group"), true);
  grid.scrollTop = 180;
  // Progressive marker reconciliation replaces Leaflet popup content. The
  // grouped grid must reattach its delegated listeners to the replacement.
  controller.setMarkerItems([{
    path: "group",
    display_name: "1 photo",
    photoMapGrouped: true,
    photoMapGroupCount: 2,
    latitude: 40.5,
    longitude: -74,
    photoMapGroupMembers: [member],
  }]);
  assert.equal(grid.scrollTop, 180);
  listeners["grid-click"]({target: cell});

  assert.match(selection.innerHTML, /one &amp; two\.mov/);
  assert.match(selection.innerHTML, /Latitude/);
  assert.match(selection.innerHTML, /Loading thumbnail/);
  assert.match(selection.innerHTML, /Open full preview for one &amp; two\.mov/);
  assert.match(selection.innerHTML, /href="\/preview\?path=Camera\+Uploads%2Fone\+%26\+two\.mov&amp;source=remote&amp;kind=video/);
  assert.match(selection.innerHTML, /Close preview/);

  const back = {
    parentNode: root,
    getAttribute(name) { return name === "data-photo-map-group-back" ? "true" : null; },
  };
  listeners["root-click"]({target: back});
  assert.match(selection.innerHTML, /Select a thumbnail to view its details/);
  assert.match(popup, /photo-map-group-grid/);
});

test("Photo Map keeps an open grouped grid mounted while thumbnail state reconciles", async () => {
  const mapModule = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/map.js");
  const listeners = {};
  let popupContentUpdates = 0;
  const contentRoot = {};
  Object.defineProperty(contentRoot, "innerHTML", {
    get() { return ""; },
    set(_value) { popupContentUpdates += 1; },
  });
  const member = {
    path: "Camera Uploads/member.jpg",
    display_name: "member.jpg",
    latitude: 40.5,
    longitude: -74,
  };
  const cell = {
    attrs: {"data-photo-map-group-member-path": member.path},
    getAttribute(name) { return this.attrs[name] || null; },
    setAttribute(name, value) { this.attrs[name] = value; },
    parentNode: null,
  };
  const grid = {
    clientHeight: 120,
    scrollTop: 90,
    addEventListener(name, callback) { listeners["grid-" + name] = callback; },
    removeEventListener() {},
    querySelectorAll() { return [cell]; },
  };
  cell.parentNode = grid;
  const root = {
    addEventListener(name, callback) { listeners["root-" + name] = callback; },
    removeEventListener() {},
    querySelector(selector) {
      if (selector === ".leaflet-popup-content") return contentRoot;
      if (selector === "[data-photo-map-group-grid]") return grid;
      return null;
    },
  };
  let marker;
  const fakeLeaflet = {
    map() { return {setView() {}, invalidateSize() {}, remove() {}}; },
    tileLayer() { return {addTo() {}}; },
    markerClusterGroup() { return {addTo() {}, addLayer() {}, removeLayer() {}}; },
    divIcon(options) { return options; },
    marker() {
      marker = {
        bindPopup() {},
        setPopupContent() { popupContentUpdates += 1; },
        getPopup() { return {getElement() { return root; }}; },
        on(name, callback) { listeners["marker-" + name] = callback; },
        trigger(name, event) { listeners["marker-" + name](event); },
      };
      return marker;
    },
  };
  const group = {
    path: "group",
    display_name: "1 photo",
    photoMapGrouped: true,
    photoMapGroupCount: 1,
    latitude: 40.5,
    longitude: -74,
    photoMapGroupMembers: [member],
  };
  const controller = mapModule.createPhotoMap(fakeLeaflet, "map-element");
  controller.setMarkerItems([group]);
  marker.trigger("popupopen", {popup: {getElement() { return root; }}});

  assert.equal(controller.setGroupedMemberThumbnail(member.path, {url: "/thumbnail?member"}), true);
  assert.equal(popupContentUpdates, 0);
  assert.equal(grid.scrollTop, 90);

  controller.setMarkerItems([Object.assign({}, group, {
    photoMapGroupMembers: [Object.assign({}, member, {photoMapThumbnailUrl: "/thumbnail?member"})],
  })]);
  assert.equal(popupContentUpdates, 0);
  assert.equal(grid.scrollTop, 90);
});

test("Photo Map attaches loading/ready thumbnail cards and reports individually visible pins", async () => {
  const mapModule = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/map.js");
  const createdMarkers = [];
  const visible = new Set();
  const mapListeners = {};
  let visibleItems = [];
  const markerLayer = {
    addTo() {},
    addLayer(marker) {
      visible.add(marker);
      if (marker.point[0] === 3) visible.delete(marker);
    },
    removeLayer() {},
    getVisibleParent(marker) { return visible.has(marker) ? marker : null; },
  };
  const fakeLeaflet = {
    map() {
      return {
        setView() {},
        invalidateSize() {},
        remove() {},
        on(name, callback) { mapListeners[name] = callback; },
        getBounds() { return {contains() { return true; }}; },
      };
    },
    tileLayer() { return {addTo() {}}; },
    markerClusterGroup() { return markerLayer; },
    divIcon(options) { return options; },
    marker(point, options) {
      const marker = {
        point,
        options,
        icons: [options.icon],
        bindPopup(content) { this.popup = content; },
        setPopupContent(content) { this.popup = content; },
        setIcon(icon) { this.icons.push(icon); },
        getLatLng() { return {lat: this.point[0], lng: this.point[1]}; },
        on() {},
      };
      createdMarkers.push(marker);
      return marker;
    },
  };

  const controller = mapModule.createPhotoMap(fakeLeaflet, "map-element", {
    onVisibleMarkers(items) { visibleItems = items; },
  });
  controller.setMarkerItems([
    {path: "visible.jpg", display_name: "visible.jpg", latitude: 1, longitude: 2},
    {path: "clustered.jpg", display_name: "clustered.jpg", latitude: 3, longitude: 4},
  ]);

  assert.deepEqual(visibleItems.map((item) => item.path), ["visible.jpg"]);
  visible.clear();
  mapListeners.moveend({});
  assert.deepEqual(visibleItems, []);
  assert.match(createdMarkers[0].icons[0].html, /photo-map-marker-thumbnail-loading/);
  controller.setMarkerThumbnail("visible.jpg", {
    url: "/thumbnail?path=visible.jpg&source=remote",
  });
  assert.match(createdMarkers[0].icons.at(-1).html, /photo-map-marker-thumbnail-image/);
  assert.match(createdMarkers[0].icons.at(-1).html, /visible\.jpg/);
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
  assert.match(popup, /href="\/preview\?path=Camera\+Uploads%2Fphoto\+%26\+one\.jpg&amp;source=remote&amp;kind=photo/);
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

  assert.match(popup, /Loading thumbnail/);
  assert.match(popup, /photo-map-preview-thumbnail-placeholder/);
  assert.match(popup, /Open full preview for video\.mov/);
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

test("Photo Map defers membership changes until a spiderfied cluster closes", async () => {
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
    _layerAddCount: 0,
    _listeners: new Map(),
    addTo() {},
    on(name, callback) {
      if (!this._listeners.has(name)) this._listeners.set(name, []);
      this._listeners.get(name).push(callback);
    },
    once(name, callback) {
      const layer = this;
      const onceCallback = function (event) {
        layer.off(name, onceCallback);
        callback(event);
      };
      this.on(name, onceCallback);
    },
    off(name, callback) {
      this._listeners.set(name, (this._listeners.get(name) || []).filter((entry) => entry !== callback));
    },
    trigger(name, event) {
      (this._listeners.get(name) || []).slice().forEach((callback) => callback(event));
    },
    addLayer(marker) {
      this._layerAddCount += 1;
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
        setLatLngCount: 0,
        bindPopup() {},
        on() {},
        getLatLng() { return {lat: this._point[0], lng: this._point[1]}; },
        setLatLng(next) { this.setLatLngCount += 1; this._point = next; },
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
  // Spiderfy moves the rendered marker, but must not look like a source
  // coordinate update on the next progressive metadata render.
  createdMarkers[0]._point = [8, 9];
  markerLayer._spiderfied = cluster;
  controller.setMarkerItems([
    {path: "one.jpg", latitude: 1, longitude: 2},
    {path: "two.jpg", latitude: 1, longitude: 2},
  ]);
  assert.equal(createdMarkers[0].setLatLngCount, 0);
  assert.equal(markerLayer._spiderfied, cluster);
  controller.setMarkerItems([
    {path: "one.jpg", latitude: 3, longitude: 4},
    {path: "two.jpg", latitude: 1, longitude: 2},
    {path: "three.jpg", latitude: 1, longitude: 2},
  ]);

  assert.equal(markerLayer._layerAddCount, 2);
  assert.equal(createdMarkers[0].setLatLngCount, 0);
  markerLayer._spiderfied = null;
  markerLayer.trigger("unspiderfied", {cluster});
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(markerLayer._layerAddCount, 3);
  assert.equal(createdMarkers[0].setLatLngCount, 1);
});
