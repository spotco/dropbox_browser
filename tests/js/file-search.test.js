const path = require("node:path");
const {pathToFileURL} = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  return import(pathToFileURL(absolutePath).href);
}

class FakeElement {
  constructor(id, options) {
    this.id = id;
    this.hidden = !!(options && options.hidden);
    this.disabled = !!(options && options.disabled);
    this.value = options && options.value ? options.value : "";
    this.textContent = options && options.textContent ? options.textContent : "";
    this.innerHTML = options && options.innerHTML ? options.innerHTML : "";
    this.clientHeight = options && options.clientHeight ? options.clientHeight : 0;
    this.scrollTop = options && options.scrollTop ? options.scrollTop : 0;
    this.attributes = new Map();
    this.listeners = new Map();
    this.blurCount = 0;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(listener);
  }

  dispatchEvent(event) {
    const listeners = this.listeners.get(event.type) || [];
    listeners.forEach(function (listener) {
      listener.call(null, event);
    });
  }

  focus() {}

  select() {}

  blur() {
    this.blurCount += 1;
  }

  querySelector(selector) {
    if (selector === '.file-search-result[data-file-search-result-id]' && this.innerHTML.indexOf('data-file-search-result-id=') >= 0) {
      return {
        getBoundingClientRect() {
          return {height: 44};
        },
      };
    }
    return null;
  }
}

class FakeWindow {
  constructor() {
    this.listeners = new Map();
    this.timers = new Map();
    this.nextTimerId = 1;
  }

  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(listener);
  }

  dispatchEvent(event) {
    const listeners = this.listeners.get(event.type) || [];
    listeners.forEach(function (listener) {
      listener.call(null, event);
    });
  }

  requestAnimationFrame(callback) {
    callback();
  }

  setTimeout(callback, delay) {
    const id = this.nextTimerId++;
    this.timers.set(id, {callback, delay});
    return id;
  }

  clearTimeout(id) {
    this.timers.delete(id);
  }
}

function buildFakeDom(options) {
  const pane = new FakeElement("file-search-pane", {hidden: !!options.paneHidden});
  const root = new FakeElement("file-search-root-path");
  const status = new FakeElement("file-search-status");
  const count = new FakeElement("file-search-result-count");
  const query = new FakeElement("file-search-query", {value: options.query || ""});
  const type = new FakeElement("file-search-type", {value: options.typeGroup || "all"});
  const preset = new FakeElement("file-search-date-preset", {value: options.datePreset || "any"});
  const dateFrom = new FakeElement("file-search-date-from", {value: options.dateFrom || ""});
  const dateTo = new FakeElement("file-search-date-to", {value: options.dateTo || ""});
  const submit = new FakeElement("file-search-submit", {textContent: options.submitText || "Search"});
  const reset = new FakeElement("file-search-reset");
  const results = new FakeElement("file-search-results", {clientHeight: options.resultsClientHeight || 220, scrollTop: options.resultsScrollTop || 0});
  const mode = new FakeElement("bottom-pane-mode", {value: options.mode || "server-log"});
  const elements = new Map([
    [pane.id, pane],
    [root.id, root],
    [status.id, status],
    [count.id, count],
    [query.id, query],
    [type.id, type],
    [preset.id, preset],
    [dateFrom.id, dateFrom],
    [dateTo.id, dateTo],
    [submit.id, submit],
    [reset.id, reset],
    [results.id, results],
    [mode.id, mode],
  ]);
  return {
    document: {
      body: {
        dataset: {
          currentFolderPath: options.currentFolderPath || "",
        },
      },
      getElementById(id) {
        return elements.get(id) || null;
      },
    },
    window: new FakeWindow(),
    elements,
  };
}

test("renderFileSearchResults renders result rows and file actions", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/file-search.js");
  const html = mod.renderFileSearchResults([
    {
      kind: "file",
      display_name: "Track.m4a",
      path: "Music/Album/Track.m4a",
      relative_path: "Album/Track.m4a",
      icon_href: "/assets/icons/material-icon-theme/audio.svg",
      type_label: "audio",
      status_label: "Dropbox Only",
      status_class: "remote",
      size_display: "11 B",
      date_display: "2024-01-01 12:02",
      local_copy_path: "C:/Dropbox/Music/Album/Track.m4a",
      preview_href: "/file?path=Music%2FAlbum%2FTrack.m4a&source=remote",
      download_href: "/download?path=Music%2FAlbum%2FTrack.m4a&source=remote",
    },
  ]);

  assert.match(html, /Track\.m4a/);
  assert.match(html, /Album\/Track\.m4a/);
  assert.match(html, /class="file-search-result-name" href="\/\?path=Music%2FAlbum&amp;reveal=Music%2FAlbum%2FTrack\.m4a"/);
  assert.match(html, /Preview/);
  assert.match(html, /Download/);
  assert.match(html, /Show Folder/);
  assert.match(html, /Go to Dropbox/);
  assert.match(html, /href="\/\?path=Music%2FAlbum"/);
  assert.match(html, /href="https:\/\/www\.dropbox\.com\/home\/Music\/Album\/Track\.m4a"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /class="copy-path"/);
  assert.match(html, /data-copy-path="C:\/Dropbox\/Music\/Album\/Track\.m4a"/);
  assert.match(html, /status remote/);
});

test("renderFileSearchResults renders folders with open action", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/file-search.js");
  const html = mod.renderFileSearchResults([
    {
      kind: "folder",
      display_name: "Known",
      path: "Music/Known",
      relative_path: "Known",
      icon_href: "/assets/icons/material-icon-theme/folder-base.svg",
      type_label: "folder",
      status_label: "Loading",
      status_class: "loading",
      folder_href: "/?path=Music%2FKnown",
    },
  ]);

  assert.match(html, /Open/);
  assert.match(html, /href="\/\?path=Music%2FKnown"/);
  assert.match(html, /href="https:\/\/www\.dropbox\.com\/home\/Music\/Known"/);
});

test("defaultBrowseHrefForRow sends files to their containing folder with a reveal target", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/file-search.js");
  assert.equal(mod.defaultBrowseHrefForRow({kind: "file", path: "Music/Album/Track.m4a"}), "/?path=Music%2FAlbum&reveal=Music%2FAlbum%2FTrack.m4a");
  assert.equal(mod.defaultBrowseHrefForRow({kind: "file", path: "cover.png"}), "/?reveal=cover.png");
  assert.equal(mod.defaultBrowseHrefForRow({kind: "folder", path: "Music/Known", folder_href: "/?path=Music%2FKnown"}), "/?path=Music%2FKnown");
});

test("containingFolderHrefForRow resolves parent browse targets", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/file-search.js");
  assert.equal(mod.parentFolderPathForRow({path: "Music/Album/Track.m4a"}), "Music/Album");
  assert.equal(mod.containingFolderHrefForRow({path: "Music/Album/Track.m4a"}), "/?path=Music%2FAlbum");
  assert.equal(mod.parentFolderPathForRow({path: "cover.png"}), "");
  assert.equal(mod.containingFolderHrefForRow({path: "cover.png"}), "/");
});

test("dropboxHomeHrefForRow preserves folder separators and encodes segments", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/file-search.js");
  assert.equal(mod.dropboxHomeHrefForRow({path: "THE DUMP/Garcello & Slynk/Garcello"}), "https://www.dropbox.com/home/THE%20DUMP/Garcello%20%26%20Slynk/Garcello");
  assert.equal(mod.dropboxHomeHrefForRow({path: "Plus+Folder"}), "https://www.dropbox.com/home/Plus%2BFolder");
  assert.equal(mod.dropboxHomeHrefForRow({path: ""}), "https://www.dropbox.com/home");
});

test("renderVirtualFileSearchResults renders spacer blocks around the visible slice", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/file-search.js");
  const html = mod.renderVirtualFileSearchResults(
    [
      {kind: "file", display_name: "one.txt", path: "one.txt", relative_path: "one.txt", type_label: "txt", icon_href: "/icon.svg", status_label: "Dropbox Only", status_class: "remote", size_display: "1 B", date_display: "2024-01-01", preview_href: "/file?one", download_href: "/download?one"},
      {kind: "file", display_name: "two.txt", path: "two.txt", relative_path: "two.txt", type_label: "txt", icon_href: "/icon.svg", status_label: "Dropbox Only", status_class: "remote", size_display: "2 B", date_display: "2024-01-02", preview_href: "/file?two", download_href: "/download?two"},
      {kind: "file", display_name: "three.txt", path: "three.txt", relative_path: "three.txt", type_label: "txt", icon_href: "/icon.svg", status_label: "Dropbox Only", status_class: "remote", size_display: "3 B", date_display: "2024-01-03", preview_href: "/file?three", download_href: "/download?three"},
    ],
    {startIndex: 1, endIndex: 2, topSpacerHeight: 40, bottomSpacerHeight: 40},
  );

  assert.match(html, /file-search-virtual-spacer/);
  assert.match(html, /height:40px/);
  assert.doesNotMatch(html, /one\.txt/);
  assert.match(html, /two\.txt/);
  assert.doesNotMatch(html, /three\.txt/);
});

test("resultCountText pluralizes counts", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/file-search.js");
  assert.equal(mod.resultCountText(0), "0 results");
  assert.equal(mod.resultCountText(1), "1 result");
  assert.equal(mod.resultCountText(2), "2 results");
});

test("tokenizeFileSearchQuery normalizes case and separators", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/file-search.js");
  assert.deepEqual(mod.tokenizeFileSearchQuery("Fantasy_Castle.MP3"), ["fantasy", "castle", "mp3"]);
});

test("classifyFileSearchTypeGroup maps representative file types", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/file-search.js");
  assert.equal(mod.classifyFileSearchTypeGroup({kind: "file", display_name: "cover.heic", type_label: "image"}), "images");
  assert.equal(mod.classifyFileSearchTypeGroup({kind: "file", display_name: "track.flac", type_label: "audio"}), "audio");
  assert.equal(mod.classifyFileSearchTypeGroup({kind: "file", display_name: "archive.zip", type_label: "zip"}), "archives");
  assert.equal(mod.classifyFileSearchTypeGroup({kind: "file", display_name: "script.py", type_label: "python"}), "code");
});

test("filterFileSearchResults applies local query, type, and date filters", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/file-search.js");
  const rows = [
    {
      kind: "file",
      display_name: "Fantasy-Castle.jpg",
      relative_path: "Art/Fantasy-Castle.jpg",
      type_label: "image",
      sort_date: 1704067200,
    },
    {
      kind: "file",
      display_name: "Fantasy Theme.flac",
      relative_path: "Music/Fantasy Theme.flac",
      type_label: "audio",
      sort_date: 1735689600,
    },
  ];
  const filtered = mod.filterFileSearchResults(rows, {
    query: "fantasy castle",
    typeGroup: "images",
    datePreset: "custom",
    dateFrom: "2023-12-31",
    dateTo: "2024-12-31",
  });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].display_name, "Fantasy-Castle.jpg");
});

test("hasActiveFileSearchCriteria reflects query, type, and date filters", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/file-search.js");
  assert.equal(mod.hasActiveFileSearchCriteria({query: "", typeGroup: "all", datePreset: "any"}), false);
  assert.equal(mod.hasActiveFileSearchCriteria({query: "track", typeGroup: "all", datePreset: "any"}), true);
  assert.equal(mod.hasActiveFileSearchCriteria({query: "", typeGroup: "audio", datePreset: "any"}), true);
  assert.equal(mod.hasActiveFileSearchCriteria({query: "", typeGroup: "all", datePreset: "custom"}), true);
});

test("shouldPollFileSearchStatus follows partial cache status rules", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/file-search.js");
  assert.equal(mod.shouldPollFileSearchStatus({complete: true, pending: false, missing_listing_count: 0}), false);
  assert.equal(mod.shouldPollFileSearchStatus({complete: false, pending: true, missing_listing_count: 0}), true);
  assert.equal(mod.shouldPollFileSearchStatus({complete: false, pending: false, missing_listing_count: 2}), true);
  assert.equal(mod.shouldPollFileSearchStatus({complete: false, pending: false, missing_listing_count: 0}), false);
});

test("initFileSearch starts searching only after Search is pressed and uses the current folder as root", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/file-search.js");
  const dom = buildFakeDom({
    mode: "server-log",
    query: "track",
    typeGroup: "audio",
    currentFolderPath: "Music",
  });
  const requests = [];
  const api = mod.initFileSearch({
    document: dom.document,
    window: dom.window,
    fetchImpl(url) {
      requests.push(url);
      return Promise.resolve({
        ok: true,
        json() {
          return Promise.resolve({
            root: {path: "Music"},
            status: {message: "Cached recursive search is complete.", complete: true, pending: false, missing_listing_count: 0, cache_status: "complete"},
            results: [
              {kind: "file", display_name: "Track.m4a", relative_path: "Album/Track.m4a", icon_href: "/icon.svg", status_label: "Dropbox Only", status_class: "remote", type_label: "audio", size_display: "11 B", date_display: "2024-01-01", sort_date: 1704067200, preview_href: "/file?x=1", download_href: "/download?x=1"},
              {kind: "file", display_name: "Cover.jpg", relative_path: "Art/Cover.jpg", icon_href: "/icon.svg", status_label: "Dropbox Only", status_class: "remote", type_label: "image", size_display: "12 B", date_display: "2024-01-02", sort_date: 1704153600, preview_href: "/file?x=2", download_href: "/download?x=2"},
            ],
          });
        },
      });
    },
  });

  dom.elements.get("bottom-pane-mode").value = "file-search";
  dom.elements.get("file-search-pane").hidden = false;
  await api.startSearch();
  assert.deepEqual(requests, ["/browse/endpoints/search?path=Music&recursive=1&query=track"]);
  assert.match(dom.elements.get("file-search-results").innerHTML, /Track\.m4a/);
  assert.doesNotMatch(dom.elements.get("file-search-results").innerHTML, /Cover\.jpg/);
  assert.equal(dom.elements.get("file-search-root-path").textContent, "Music");
  assert.equal(dom.elements.get("file-search-submit").textContent, "Search");
});

test("initFileSearch virtualizes large filtered result sets", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/file-search.js");
  const dom = buildFakeDom({
    mode: "server-log",
    query: "track",
    currentFolderPath: "Music",
    resultsClientHeight: 220,
    resultsScrollTop: 220,
  });
  const results = Array.from({length: 24}, function (_item, index) {
    return {
      kind: "file",
      display_name: "track-" + String(index).padStart(2, "0") + ".mp3",
      relative_path: "Album/track-" + String(index).padStart(2, "0") + ".mp3",
      path: "Music/Album/track-" + String(index).padStart(2, "0") + ".mp3",
      icon_href: "/icon.svg",
      status_label: "Dropbox Only",
      status_class: "remote",
      type_label: "audio",
      size_display: "11 B",
      date_display: "2024-01-01",
      sort_date: 1704067200 + index,
      preview_href: "/file?x=" + index,
      download_href: "/download?x=" + index,
    };
  });
  const api = mod.initFileSearch({
    document: dom.document,
    window: dom.window,
    fetchImpl() {
      return Promise.resolve({
        ok: true,
        json() {
          return Promise.resolve({
            root: {path: "Music"},
            status: {message: "Cached recursive search is complete.", complete: true, pending: false, missing_listing_count: 0, cache_status: "complete"},
            results: results,
          });
        },
      });
    },
  });

  const previousWindow = global.window;
  const previousDocument = global.document;
  global.window = dom.window;
  global.document = dom.document;
  try {
    dom.elements.get("bottom-pane-mode").value = "file-search";
    dom.elements.get("file-search-pane").hidden = false;
    await api.startSearch();
    assert.match(dom.elements.get("file-search-results").innerHTML, /file-search-virtual-spacer/);
    assert.doesNotMatch(dom.elements.get("file-search-results").innerHTML, /track-23\.mp3/);
  } finally {
    global.window = previousWindow;
    global.document = previousDocument;
  }
});

test("initFileSearch polls incomplete results until a complete snapshot arrives, then returns to idle button state", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/file-search.js");
  const dom = buildFakeDom({
    mode: "server-log",
    query: "track",
    currentFolderPath: "Music",
  });
  const payloads = [
    {
      root: {path: "Music"},
      status: {message: "Recursive search is loading cached metadata.", complete: false, pending: true, missing_listing_count: 1, cache_status: "partial"},
      results: [{kind: "file", display_name: "Track.m4a", relative_path: "Album/Track.m4a", icon_href: "/icon.svg", status_label: "Dropbox Only", status_class: "remote", type_label: "audio", size_display: "11 B", date_display: "2024-01-01", sort_date: 1704067200, preview_href: "/file?x=1", download_href: "/download?x=1"}],
    },
    {
      root: {path: "Music"},
      status: {message: "Cached recursive search is complete.", complete: true, pending: false, missing_listing_count: 0, cache_status: "complete"},
      results: [{kind: "file", display_name: "Track.m4a", relative_path: "Album/Track.m4a", icon_href: "/icon.svg", status_label: "Dropbox Only", status_class: "remote", type_label: "audio", size_display: "11 B", date_display: "2024-01-01", sort_date: 1704067200, preview_href: "/file?x=1", download_href: "/download?x=1"}],
    },
  ];
  const requests = [];

  const api = mod.initFileSearch({
    document: dom.document,
    window: dom.window,
    pollDelayMs: 25,
    fetchImpl(url) {
      requests.push(url);
      const payload = payloads.shift();
      return Promise.resolve({
        ok: true,
        json() {
          return Promise.resolve(payload);
        },
      });
    },
  });

  dom.elements.get("bottom-pane-mode").value = "file-search";
  dom.elements.get("file-search-pane").hidden = false;
  await api.startSearch();
  assert.equal(requests.length, 1);
  assert.equal(dom.window.timers.size, 1);
  dom.window.timers.clear();
  await api.loadResults({isPolling: true});
  assert.equal(requests.length, 2);
  assert.equal(dom.window.timers.size, 0);
  assert.equal(dom.elements.get("file-search-status").textContent, "Search complete.");
  assert.equal(dom.elements.get("file-search-submit").textContent, "Search");
});

test("initFileSearch changing criteria after a run resets to press-search state instead of auto-refetching", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/file-search.js");
  const dom = buildFakeDom({
    mode: "server-log",
    query: "track",
    currentFolderPath: "Music",
  });
  const requests = [];
  const payloads = [
    {
      root: {path: "Music"},
      status: {message: "Cached recursive search is complete.", complete: true, pending: false, missing_listing_count: 0, cache_status: "complete"},
      results: [{kind: "file", display_name: "Track.m4a", relative_path: "Album/Track.m4a", icon_href: "/icon.svg", status_label: "Dropbox Only", status_class: "remote", type_label: "audio", size_display: "11 B", date_display: "2024-01-01", sort_date: 1704067200, preview_href: "/file?x=1", download_href: "/download?x=1"}],
    },
  ];

  const api = mod.initFileSearch({
    document: dom.document,
    window: dom.window,
    fetchImpl(url) {
      requests.push(url);
      return Promise.resolve({
        ok: true,
        json() {
          return Promise.resolve(payloads.shift());
        },
      });
    },
  });

  dom.elements.get("bottom-pane-mode").value = "file-search";
  dom.elements.get("file-search-pane").hidden = false;
  await api.startSearch();
  dom.elements.get("file-search-query").value = "cover";
  api.applyFilters();
  assert.deepEqual(requests, ["/browse/endpoints/search?path=Music&recursive=1&query=track"]);
  assert.match(dom.elements.get("file-search-results").innerHTML, /Press Search to run with the current filters/);
  assert.equal(dom.elements.get("file-search-submit").textContent, "Search");
});

test("initFileSearch Enter in the query blurs the field and starts searching", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/file-search.js");
  const dom = buildFakeDom({
    mode: "file-search",
    query: "track",
    typeGroup: "audio",
    currentFolderPath: "Music",
  });
  const requests = [];
  mod.initFileSearch({
    document: dom.document,
    window: dom.window,
    fetchImpl(url) {
      requests.push(url);
      return Promise.resolve({
        ok: true,
        json() {
          return Promise.resolve({
            root: {path: "Music"},
            status: {message: "Cached recursive search is complete.", complete: true, pending: false, missing_listing_count: 0, cache_status: "complete"},
            results: [],
          });
        },
      });
    },
  });

  const query = dom.elements.get("file-search-query");
  query.dispatchEvent({
    type: "keydown",
    key: "Enter",
    preventDefault() {},
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(query.blurCount, 1);
  assert.deepEqual(requests, ["/browse/endpoints/search?path=Music&recursive=1&query=track"]);
});

test("initFileSearch stops polling when the pane is hidden", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/file-search.js");
  const dom = buildFakeDom({
    mode: "file-search",
    query: "track",
    currentFolderPath: "Music",
  });

  const api = mod.initFileSearch({
    document: dom.document,
    window: dom.window,
    pollDelayMs: 25,
    fetchImpl() {
      return Promise.resolve({
        ok: true,
        json() {
          return Promise.resolve({
            root: {path: "Music"},
            status: {message: "Recursive search is loading cached metadata.", complete: false, pending: true, missing_listing_count: 1, cache_status: "partial"},
            results: [],
          });
        },
      });
    },
  });

  await api.startSearch();
  assert.equal(dom.window.timers.size, 1);
  dom.elements.get("bottom-pane-mode").value = "server-log";
  dom.elements.get("file-search-pane").hidden = true;
  dom.window.dispatchEvent({type: "bottom-pane-mode-changed", detail: {mode: "server-log"}});
  assert.equal(dom.window.timers.size, 0);
});

test("initFileSearch shows partial and complete empty states from the cached snapshot", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/file-search.js");
  const dom = buildFakeDom({
    mode: "server-log",
    query: "missing",
    currentFolderPath: "Photos",
  });
  const payloads = [
    {
      root: {path: "Photos"},
      status: {message: "Recursive search is loading cached metadata.", complete: false, pending: true, missing_listing_count: 1, cache_status: "partial"},
      results: [{kind: "file", display_name: "cover.png", relative_path: "cover.png", type_label: "image", sort_date: 1704067200}],
    },
    {
      root: {path: "Photos"},
      status: {message: "Cached recursive search is complete.", complete: true, pending: false, missing_listing_count: 0, cache_status: "complete"},
      results: [{kind: "file", display_name: "cover.png", relative_path: "cover.png", type_label: "image", sort_date: 1704067200}],
    },
  ];
  const api = mod.initFileSearch({
    document: dom.document,
    window: dom.window,
    fetchImpl() {
      const payload = payloads.shift();
      return Promise.resolve({
        ok: true,
        json() {
          return Promise.resolve(payload);
        },
      });
    },
  });

  dom.elements.get("bottom-pane-mode").value = "file-search";
  dom.elements.get("file-search-pane").hidden = false;
  await api.startSearch();
  assert.match(dom.elements.get("file-search-results").innerHTML, /No matches yet/);
  dom.window.timers.clear();
  await api.loadResults({isPolling: true});
  assert.match(dom.elements.get("file-search-results").innerHTML, /No matching files/);
});

test("initFileSearch stop button stops background polling and keeps current results", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/file-search.js");
  const dom = buildFakeDom({
    mode: "file-search",
    query: "track",
    currentFolderPath: "Music",
  });
  const api = mod.initFileSearch({
    document: dom.document,
    window: dom.window,
    pollDelayMs: 25,
    fetchImpl() {
      return Promise.resolve({
        ok: true,
        json() {
          return Promise.resolve({
            root: {path: "Music"},
            status: {message: "Recursive search is loading cached metadata.", complete: false, pending: true, pending_folder_count: 3, queued_folder_count: 2, missing_listing_count: 1, cache_status: "partial"},
            results: [{kind: "file", display_name: "Track.m4a", relative_path: "Album/Track.m4a", icon_href: "/icon.svg", status_label: "Dropbox Only", status_class: "remote", type_label: "audio", size_display: "11 B", date_display: "2024-01-01", sort_date: 1704067200, preview_href: "/file?x=1", download_href: "/download?x=1"}],
          });
        },
      });
    },
  });

  await api.startSearch();
  assert.equal(dom.elements.get("file-search-submit").textContent, "Stop Search");
  assert.match(dom.elements.get("file-search-status").textContent, /pending folders/);
  assert.match(dom.elements.get("file-search-results").innerHTML, /Track\.m4a/);
  dom.elements.get("file-search-submit").dispatchEvent({type: "click", target: dom.elements.get("file-search-submit")});
  assert.equal(dom.window.timers.size, 0);
  assert.equal(dom.elements.get("file-search-submit").textContent, "Search");
  assert.match(dom.elements.get("file-search-results").innerHTML, /Track\.m4a/);
});
