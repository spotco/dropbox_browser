const path = require("node:path");
const {pathToFileURL} = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

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
    markerClusterGroup() { return {addTo() {}, clearLayers() {}, addLayers() {}}; },
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
