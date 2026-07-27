const path = require("node:path");
const {pathToFileURL} = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");
const {createPhotoMapDocument, popupText} = require("./photo-map-test-fixtures");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  return import(pathToFileURL(absolutePath).href);
}

function element(initial = {}) {
  return Object.assign({
    hidden: false,
    value: "",
    textContent: "",
    dataset: {},
    classList: {toggle() {}},
    addEventListener() {},
    setAttribute(name, value) { this[name] = value; },
  }, initial);
}

function photoMapHostFixture(folderPath = "Camera Uploads", mapOverrides = {}) {
  const pane = element();
  const popupDocument = createPhotoMapDocument();
  const markers = [];
  const elements = {
    "photo-map-pane": pane,
    "photo-map-date-range": element({value: "all"}),
    "photo-map-custom-range": element(),
    "photo-map-date-from": element(),
    "photo-map-date-to": element(),
    "photo-map-grouping-distance": element({value: "20"}),
    "photo-map-refresh": element(),
    "photo-map-status": element(),
    "photo-map-map": element(),
  };
  const fakeMap = Object.assign({
    setView() {},
    invalidateSize() {},
    remove() {},
    on() {},
    off() {},
  }, mapOverrides);
  const fakeLeaflet = {
    map() { return fakeMap; },
    tileLayer() { return {addTo() {}}; },
    markerClusterGroup() {
      return {
        addTo() {},
        addLayer(marker) { markers.push(marker); },
        removeLayer(marker) {
          const index = markers.indexOf(marker);
          if (index >= 0) markers.splice(index, 1);
        },
      };
    },
    marker() {
      const listeners = {};
      return {
        popup: "",
        bindPopup(content) { this.popup = popupText(content); },
        setPopupContent(content) { this.popup = popupText(content); },
        on(name, callback) { listeners[name] = callback; },
        trigger(name) { if (listeners[name]) listeners[name](this); },
      };
    },
  };
  const win = {
    L: fakeLeaflet,
    addEventListener() {},
    Settings: {get() { return "server-log"; }},
    DropboxBrowserPhotoMap: undefined,
    Image: function () {
      const image = this;
      Object.defineProperty(image, "src", {
        configurable: true,
        get() { return image._src || ""; },
        set(value) {
          image._src = value;
          setTimeout(() => { if (image.onload) image.onload(); }, 0);
        },
      });
    },
  };
  const doc = {
    body: {dataset: {currentFolderPath: folderPath}},
    getElementById(id) { return elements[id] || null; },
    createElement: popupDocument.createElement,
    querySelector() { return null; },
    addEventListener() {},
  };
  return {doc, win, elements, markers};
}

function photoRow(path, sortDate = 1700000000) {
  return {
    kind: "file",
    remote: true,
    path,
    display_name: path.split("/").pop(),
    sort_date: sortDate,
    sort_size: 123,
  };
}

function emptyJpegRangeResponse() {
  return {
    ok: true,
    arrayBuffer: async () => new Uint8Array([0xff, 0xd8]).buffer,
    headers: {get() { return ""; }},
  };
}

function jsonResponse(payload) {
  return {ok: true, json: async () => payload};
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Timed out waiting for Photo Map test state");
}

test("Photo Map date inputs stay hidden outside from/to modes and default to an open-ended current range", async () => {
  const host = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map.js");
  const allFixture = photoMapHostFixture();
  const noOpFetch = () => Promise.resolve(jsonResponse({page: {path: "Camera Uploads"}, rows: []}));
  host.initPhotoMap({document: allFixture.doc, window: allFixture.win, fetchImpl: noOpFetch});

  assert.equal(allFixture.elements["photo-map-custom-range"].hidden, true);
  assert.equal(allFixture.elements["photo-map-date-from"].value, "1900-01-01");
  const today = new Date();
  const todayValue = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") +
    "-" + String(today.getDate()).padStart(2, "0");
  assert.equal(allFixture.elements["photo-map-date-to"].value, todayValue);

  const customFixture = photoMapHostFixture();
  customFixture.elements["photo-map-date-range"].value = "custom";
  host.initPhotoMap({document: customFixture.doc, window: customFixture.win, fetchImpl: noOpFetch});
  assert.equal(customFixture.elements["photo-map-custom-range"].hidden, false);
  assert.equal(customFixture.elements["photo-map-date-from"].max, todayValue);
  assert.equal(customFixture.elements["photo-map-date-to"].max, todayValue);
});

test("Photo Map preview context captures and restores the current map view", async () => {
  const host = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map.js");
  const setViewCalls = [];
  const fixture = photoMapHostFixture("Camera Uploads", {
    getCenter() { return {lat: 40.5, lng: -74}; },
    getZoom() { return 9; },
    setView(...args) { setViewCalls.push(args); },
  });
  const fetchImpl = () => Promise.resolve(jsonResponse({page: {path: "Camera Uploads"}, rows: []}));
  const api = host.initPhotoMap({document: fixture.doc, window: fixture.win, fetchImpl});
  await api.activate();

  const context = fixture.win.DropboxBrowserPhotoMap.capturePreviewContext();
  assert.deepEqual(context.center, {lat: 40.5, lng: -74});
  assert.equal(context.zoom, 9);
  assert.equal(context.popupPath, null);

  fixture.win.DropboxBrowserPhotoMap.restorePreviewContext(context);
  // The captured map view is already current. Preview restore must be
  // idempotent and avoid producing a synthetic map move.
  assert.equal(setViewCalls.length, 1);
  assert.deepEqual(setViewCalls[0], [[20, 0], 2]);
});

test("Photo Map regrouping changes markers without rereading metadata", async () => {
  const host = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map.js");
  const fixture = photoMapHostFixture();
  const rows = [photoRow("Camera Uploads/one.jpg"), photoRow("Camera Uploads/two.jpg")];
  const cachedEntries = ["one.jpg", "two.jpg"].map((name) => ({
    path: "Camera Uploads/" + name,
    size: 123,
    modified_time: 1700000000,
    status: "located",
    media_kind: "photo",
    latitude: 40.5,
    longitude: -74,
    capture_date: "2024:01:01 12:00:00",
    listing_date_ms: 1700000000000,
  }));
  let listingReads = 0;
  let cacheReads = 0;
  const fetchImpl = (url) => {
    if (url.startsWith("/browse/endpoints/listing")) {
      listingReads += 1;
      return Promise.resolve(jsonResponse({page: {path: "Camera Uploads"}, rows}));
    }
    if (url.startsWith("/photo-map/endpoints/cache?")) {
      cacheReads += 1;
      return Promise.resolve(jsonResponse({status: "ok", entries: cachedEntries}));
    }
    throw new Error(`Unexpected Photo Map request: ${url}`);
  };

  const api = host.initPhotoMap({document: fixture.doc, window: fixture.win, fetchImpl});
  await api.activate();
  await waitFor(() => fixture.markers.length === 1);
  assert.equal(listingReads, 1);
  assert.equal(cacheReads, 1);

  assert.equal(fixture.win.DropboxBrowserPhotoMap.getGroupingDistance(), 20);
  fixture.win.DropboxBrowserPhotoMap.setGroupingDistance(0);
  await waitFor(() => fixture.markers.length === 2);
  assert.equal(listingReads, 1);
  assert.equal(cacheReads, 1);
});

test("Photo Map grouped popup queues only its initial visible member window", async () => {
  const host = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map.js");
  const fixture = photoMapHostFixture();
  const rows = Array.from({length: 20}, (_value, index) => photoRow("Camera Uploads/photo-" + index + ".jpg"));
  const cachedEntries = rows.map((row, index) => ({
    path: row.path,
    size: 123,
    modified_time: 1700000000,
    status: "located",
    media_kind: "photo",
    latitude: 40.5,
    longitude: -74,
    capture_date: "2024:01:01 12:00:00",
    listing_date_ms: 1700000000000 - index,
  }));
  const thumbnailStarts = [];
  fixture.win.Image = function () {
    const image = this;
    Object.defineProperty(image, "src", {
      configurable: true,
      get() { return image._src || ""; },
      set(value) {
        image._src = value;
        thumbnailStarts.push(value);
        setTimeout(() => { if (image.onload) image.onload(); }, 0);
      },
    });
  };
  const fetchImpl = (url) => {
    if (url.startsWith("/browse/endpoints/listing")) {
      return Promise.resolve(jsonResponse({page: {path: "Camera Uploads"}, rows}));
    }
    if (url.startsWith("/photo-map/endpoints/cache?")) {
      return Promise.resolve(jsonResponse({status: "ok", entries: cachedEntries}));
    }
    throw new Error(`Unexpected Photo Map request: ${url}`);
  };

  const api = host.initPhotoMap({document: fixture.doc, window: fixture.win, fetchImpl});
  await api.activate();
  await waitFor(() => fixture.markers.length === 1);
  const beforeOpenDiagnostics = fixture.win.DropboxBrowserPhotoMap.getDiagnostics();
  assert.equal(beforeOpenDiagnostics.groupCount, 1);
  assert.equal(beforeOpenDiagnostics.groupedMemberCount, 20);
  assert.equal(beforeOpenDiagnostics.groupingDistanceMeters, 20);
  await waitFor(() => thumbnailStarts.length === 1);
  assert.match(thumbnailStarts[0], /photo-0\.jpg/);
  const marker = fixture.markers[0];
  assert.match(marker.popup, /photo-map-group-grid/);
  marker.trigger("click");
  await waitFor(() => thumbnailStarts.length === 16);
  assert.equal(thumbnailStarts.length, 16);
  await waitFor(() => fixture.win.DropboxBrowserPhotoMap.getDiagnostics().groupedThumbnailCompleted === 16);
  const afterLoadDiagnostics = fixture.win.DropboxBrowserPhotoMap.getDiagnostics();
  assert.equal(afterLoadDiagnostics.groupedThumbnailQueued, 16);
  assert.equal(afterLoadDiagnostics.groupedThumbnailCompleted, 16);
  await waitFor(() => /photo-map-group-grid-thumbnail/.test(marker.popup));
  assert.match(marker.popup, /photo-0\.jpg/);
  assert.doesNotMatch(marker.popup, /photo-19\.jpg[^<]*photo-map-group-grid-thumbnail/);
});

test("Photo Map grouped popup visible thumbnails preempt ordinary visible map pins", async () => {
  const host = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map.js");
  const fixture = photoMapHostFixture();
  const mapPin = photoRow("Camera Uploads/map-pin.jpg");
  const groupRows = Array.from({length: 3}, (_value, index) => photoRow("Camera Uploads/group-" + index + ".jpg"));
  const rows = [mapPin].concat(groupRows);
  const cachedEntries = rows.map((row, index) => ({
    path: row.path,
    size: 123,
    modified_time: 1700000000,
    status: "located",
    media_kind: "photo",
    latitude: index === 0 ? 41.5 : 40.5,
    longitude: -74,
    capture_date: "2024:01:01 12:00:00",
    listing_date_ms: 1700000000000 - index,
  }));
  const thumbnailStarts = [];
  fixture.win.Image = function () {
    const image = this;
    Object.defineProperty(image, "src", {
      configurable: true,
      get() { return image._src || ""; },
      set(value) {
        image._src = value;
        if (!value) return;
        thumbnailStarts.push(value);
        if (!value.includes("map-pin.jpg")) setTimeout(() => { if (image.onload) image.onload(); }, 0);
      },
    });
  };
  const fetchImpl = (url) => {
    if (url.startsWith("/browse/endpoints/listing")) {
      return Promise.resolve(jsonResponse({page: {path: "Camera Uploads"}, rows}));
    }
    if (url.startsWith("/photo-map/endpoints/cache?")) {
      return Promise.resolve(jsonResponse({status: "ok", entries: cachedEntries}));
    }
    throw new Error(`Unexpected Photo Map request: ${url}`);
  };

  const api = host.initPhotoMap({document: fixture.doc, window: fixture.win, fetchImpl});
  await api.activate();
  await waitFor(() => thumbnailStarts.some((url) => url.includes("map-pin.jpg")));
  const groupMarker = fixture.markers.find((marker) => /photo-map-group-grid/.test(marker.popup));
  assert.ok(groupMarker);
  groupMarker.trigger("click");
  await waitFor(() => thumbnailStarts.some((url) => url.includes("group-0.jpg")));
  assert.match(thumbnailStarts[0], /map-pin\.jpg/);
  assert.match(thumbnailStarts[1], /group-0\.jpg/);
  api.deactivate();
});

test("Photo Map activation initializes Leaflet after starting its generation", async () => {
  const host = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map.js");
  const pane = element();
  const mapElement = element();
  const status = element();
  const elements = {
    "photo-map-pane": pane,
    "photo-map-date-range": element({value: "all"}),
    "photo-map-custom-range": element(),
    "photo-map-date-from": element(),
    "photo-map-date-to": element(),
    "photo-map-refresh": element(),
    "photo-map-status": status,
    "photo-map-map": mapElement,
  };
  const mapCalls = [];
  const fakeMap = {
    setView() {},
    invalidateSize() {},
    remove() { mapCalls.push("remove"); },
    on() {},
    off() {},
  };
  const fakeLeaflet = {
    map() { mapCalls.push("map"); return fakeMap; },
    tileLayer() { return {addTo() {}}; },
    markerClusterGroup() { return {addTo() {}, addLayer() {}, removeLayer() {}}; },
  };
  const win = {
    L: fakeLeaflet,
    addEventListener() {},
    Settings: {get() { return "server-log"; }},
    DropboxBrowserPhotoMap: undefined,
  };
  const doc = {
    body: {dataset: {currentFolderPath: ""}},
    getElementById(id) { return elements[id] || null; },
    addEventListener() {},
  };
  const fetchImpl = async (url) => ({
    ok: true,
    json: async () => url.startsWith("/browse/endpoints/listing")
      ? {page: {path: ""}, rows: []}
      : {status: "ok", entries: []},
  });

  const api = host.initPhotoMap({document: doc, window: win, fetchImpl});
  await api.activate();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(mapCalls[0], "map");
  assert.equal(api.getCandidates().length, 0);
  assert.equal(win.DropboxBrowserPhotoMap.getMap(), fakeMap);
  assert.equal(status.dataset.state, "no-media");
});

test("Photo Map destroys the Leaflet instance on page teardown", async () => {
  const host = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map.js");
  const pane = element();
  const mapElement = element();
  const listeners = {};
  const mapCalls = [];
  const elements = {
    "photo-map-pane": pane,
    "photo-map-date-range": element({value: "all"}),
    "photo-map-custom-range": element(),
    "photo-map-date-from": element(),
    "photo-map-date-to": element(),
    "photo-map-refresh": element(),
    "photo-map-status": element(),
    "photo-map-map": mapElement,
  };
  const fakeMap = {
    setView() {},
    invalidateSize() {},
    remove() { mapCalls.push("remove"); },
    on() {},
    off() {},
  };
  const fakeLeaflet = {
    L: undefined,
    map() { return fakeMap; },
    tileLayer() { return {addTo() {}}; },
    markerClusterGroup() { return {addTo() {}, addLayer() {}, removeLayer() {}}; },
  };
  const win = {
    L: fakeLeaflet,
    addEventListener(name, callback) { listeners[name] = callback; },
    Settings: {get() { return "server-log"; }},
    DropboxBrowserPhotoMap: undefined,
  };
  const doc = {
    body: {dataset: {currentFolderPath: ""}},
    getElementById(id) { return elements[id] || null; },
    addEventListener() {},
  };
  const fetchImpl = async (url) => ({
    ok: true,
    json: async () => url.startsWith("/browse/endpoints/listing")
      ? {page: {path: ""}, rows: []}
      : {status: "ok", entries: []},
  });

  const api = host.initPhotoMap({document: doc, window: win, fetchImpl});
  await api.activate();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(typeof listeners.beforeunload, "function");
  assert.equal(win.DropboxBrowserPhotoMap.isDebugEnabled(), false);
  assert.equal(win.DropboxBrowserPhotoMap.setDebugEnabled(false), false);
  assert.equal(win.DropboxBrowserPhotoMap.isDebugEnabled(), false);
  assert.equal(win.DropboxBrowserPhotoMap.setDebugEnabled(true), true);
  assert.equal(typeof win.DropboxBrowserPhotoMap.getDebugState, "function");
  assert.equal(win.DropboxBrowserPhotoMap.getDebugState().active, true);

  listeners.beforeunload();

  assert.deepEqual(mapCalls, ["remove"]);
  assert.equal(win.DropboxBrowserPhotoMap.getMap(), null);
});

test("Photo Map persists completed metadata before the metadata queue finishes", async () => {
  const host = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map.js");
  const fixture = photoMapHostFixture();
  const rows = [photoRow("Camera Uploads/one.jpg", 1700000002), photoRow("Camera Uploads/two.jpg", 1700000001)];
  const posted = [];
  let releaseSecond;
  const fetchImpl = (url, options = {}) => {
    if (url.startsWith("/browse/endpoints/listing")) {
      return Promise.resolve(jsonResponse({page: {path: "Camera Uploads"}, rows}));
    }
    if (url.startsWith("/photo-map/endpoints/cache?")) {
      return Promise.resolve(jsonResponse({status: "ok", entries: []}));
    }
    if (url === "/photo-map/endpoints/cache") {
      posted.push(JSON.parse(options.body));
      return Promise.resolve(jsonResponse({status: "ok", written: 1}));
    }
    if (url.includes("one.jpg")) return Promise.resolve(emptyJpegRangeResponse());
    if (url.includes("two.jpg")) {
      return new Promise((resolve, reject) => {
        releaseSecond = () => resolve(emptyJpegRangeResponse());
        if (options.signal) options.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, {once: true});
      });
    }
    throw new Error(`Unexpected Photo Map request: ${url}`);
  };

  const api = host.initPhotoMap({document: fixture.doc, window: fixture.win, fetchImpl});
  const loading = api.activate();
  await waitFor(() => posted.length >= 1);
  assert.equal(posted[0].entries.length, 1);
  assert.equal(posted[0].entries[0].path, "Camera Uploads/one.jpg");
  assert.equal(typeof releaseSecond, "function");

  releaseSecond();
  await loading;
  assert.equal(posted.length, 2);
});

test("Photo Map cancellation retains completed records and suppresses late results", async () => {
  const host = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map.js");
  const fixture = photoMapHostFixture();
  const rows = [photoRow("Camera Uploads/one.jpg", 1700000002), photoRow("Camera Uploads/two.jpg", 1700000001)];
  const posted = [];
  let secondAborted = false;
  const fetchImpl = (url, options = {}) => {
    if (url.startsWith("/browse/endpoints/listing")) {
      return Promise.resolve(jsonResponse({page: {path: "Camera Uploads"}, rows}));
    }
    if (url.startsWith("/photo-map/endpoints/cache?")) {
      return Promise.resolve(jsonResponse({status: "ok", entries: []}));
    }
    if (url === "/photo-map/endpoints/cache") {
      posted.push(JSON.parse(options.body));
      return Promise.resolve(jsonResponse({status: "ok", written: 1}));
    }
    if (url.includes("one.jpg")) return Promise.resolve(emptyJpegRangeResponse());
    if (url.includes("two.jpg")) {
      return new Promise((_resolve, reject) => {
        if (options.signal) options.signal.addEventListener("abort", () => {
          secondAborted = true;
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, {once: true});
      });
    }
    throw new Error(`Unexpected Photo Map request: ${url}`);
  };

  const api = host.initPhotoMap({document: fixture.doc, window: fixture.win, fetchImpl});
  const loading = api.activate();
  await waitFor(() => posted.length >= 1);
  api.deactivate();
  await loading;

  assert.equal(secondAborted, true);
  assert.deepEqual(posted.flatMap((batch) => batch.entries.map((entry) => entry.path)), [
    "Camera Uploads/one.jpg",
  ]);
});

test("Photo Map reuses incrementally written records without rereading media ranges", async () => {
  const host = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map.js");
  const fixture = photoMapHostFixture();
  const rows = [photoRow("Camera Uploads/one.jpg")];
  let cachedEntries = [];
  let rangeRequests = 0;
  let cacheReads = 0;
  const fetchImpl = (url, options = {}) => {
    if (url.startsWith("/browse/endpoints/listing")) {
      return Promise.resolve(jsonResponse({page: {path: "Camera Uploads"}, rows}));
    }
    if (url.startsWith("/photo-map/endpoints/cache?")) {
      cacheReads += 1;
      return Promise.resolve(jsonResponse({status: "ok", entries: cachedEntries}));
    }
    if (url === "/photo-map/endpoints/cache") {
      cachedEntries = JSON.parse(options.body).entries;
      return Promise.resolve(jsonResponse({status: "ok", written: cachedEntries.length}));
    }
    if (url.includes("one.jpg")) {
      rangeRequests += 1;
      return Promise.resolve(emptyJpegRangeResponse());
    }
    throw new Error(`Unexpected Photo Map request: ${url}`);
  };

  const api = host.initPhotoMap({document: fixture.doc, window: fixture.win, fetchImpl});
  await api.activate();
  assert.equal(rangeRequests, 1);
  await api.activate();

  assert.equal(cacheReads, 2);
  assert.equal(rangeRequests, 1);
  assert.equal(fixture.elements["photo-map-status"].dataset.state, "no-geotagged");
});

test("Photo Map marker selection loads and retains a thumbnail in the preview", async () => {
  const host = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map.js");
  const fixture = photoMapHostFixture();
  const rows = [photoRow("Camera Uploads/photo.jpg")];
  const cachedEntries = [{
    path: "Camera Uploads/photo.jpg",
    size: 123,
    modified_time: 1700000000,
    status: "located",
    media_kind: "photo",
    latitude: 40.5,
    longitude: -74,
    capture_date: "2024:01:01 12:00:00",
    listing_date_ms: 1700000000000,
  }];
  const fetchImpl = (url) => {
    if (url.startsWith("/browse/endpoints/listing")) {
      return Promise.resolve(jsonResponse({page: {path: "Camera Uploads"}, rows}));
    }
    if (url.startsWith("/photo-map/endpoints/cache?")) {
      return Promise.resolve(jsonResponse({status: "ok", entries: cachedEntries}));
    }
    throw new Error(`Unexpected Photo Map request: ${url}`);
  };

  const api = host.initPhotoMap({document: fixture.doc, window: fixture.win, fetchImpl});
  await api.activate();
  await waitFor(() => fixture.markers.length === 1);
  const marker = fixture.markers[0];
  assert.match(marker.popup, /Thumbnail loading/);
  assert.doesNotMatch(marker.popup, /<img/);

  marker.trigger("click");
  await waitFor(() => /photo-map-preview-thumbnail/.test(marker.popup));
  assert.match(marker.popup, /photo-map-preview-thumbnail/);
  assert.match(marker.popup, /Camera\+Uploads%2Fphoto\.jpg/);
  assert.match(marker.popup, /target="_blank"/);
  assert.match(marker.popup, /rel="noopener noreferrer"/);
});

test("Photo Map reports recognized unsupported formats without issuing range requests", async () => {
  const host = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map.js");
  const fixture = photoMapHostFixture();
  const rows = [
    photoRow("Camera Uploads/photo.heic"),
    photoRow("Camera Uploads/notes.txt"),
  ];
  const written = [];
  const fetchImpl = (url, options = {}) => {
    if (url.startsWith("/browse/endpoints/listing")) {
      return Promise.resolve(jsonResponse({page: {path: "Camera Uploads"}, rows}));
    }
    if (url.startsWith("/photo-map/endpoints/cache?")) {
      return Promise.resolve(jsonResponse({status: "ok", entries: []}));
    }
    if (url === "/photo-map/endpoints/cache") {
      written.push(JSON.parse(options.body));
      return Promise.resolve(jsonResponse({status: "ok", written: 1}));
    }
    throw new Error(`Unexpected Photo Map range request: ${url}`);
  };

  const api = host.initPhotoMap({document: fixture.doc, window: fixture.win, fetchImpl});
  await api.activate();

  assert.deepEqual(api.getCandidates().map((item) => item.path), ["Camera Uploads/photo.heic"]);
  assert.equal(fixture.elements["photo-map-status"].dataset.state, "unsupported");
  assert.match(fixture.elements["photo-map-status"].textContent, /unsupported formats/);
  assert.equal(written.length, 1);
  assert.equal(written[0].entries[0].status, "unsupported");
});
