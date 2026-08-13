const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const logPath = path.resolve(__dirname, "..", "..", "dropbox_browser/assets/js/log.js");

function createHarness(mode) {
  const listeners = new Map();
  const timers = new Map();
  const fetchCalls = [];
  const pendingFetches = [];
  let nextTimerId = 1;
  const settings = {
    get(_key, fallback) {
      return fallback;
    },
    set() {},
  };
  const modeSelect = {value: mode};
  const entries = {
    scrollHeight: 0,
    scrollTop: 0,
    appendChild() {},
    querySelector() {
      return null;
    },
  };
  const elements = {
    "log-panel": {},
    "log-entries": entries,
    "bottom-pane-mode": modeSelect,
    "log-resizer": null,
    "log-grip": null,
    "bottom-pane-full-window-toggle": null,
    "bottom-pane-minimize": null,
  };
  const windowObject = {
    innerHeight: 1000,
    addEventListener(type, handler) {
      const handlers = listeners.get(type) || [];
      handlers.push(handler);
      listeners.set(type, handlers);
    },
    removeEventListener() {},
    dispatchEvent(event) {
      for (const handler of listeners.get(event.type) || []) handler(event);
    },
  };
  const documentObject = {
    body: {classList: {toggle() {}}},
    documentElement: {style: {setProperty() {}}},
    getElementById(id) {
      return elements[id] || null;
    },
    createElement() {
      return {setAttribute() {}, className: "", innerHTML: ""};
    },
    createEvent() {
      return {initCustomEvent() {}};
    },
  };
  const context = {
    AbortController,
    CustomEvent: class CustomEvent {
      constructor(type, options) {
        this.type = type;
        this.detail = options && options.detail;
      }
    },
    Settings: settings,
    document: documentObject,
    fetch(url, options) {
      let resolve;
      let reject;
      const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      fetchCalls.push({url, options});
      pendingFetches.push({resolve, reject});
      return promise;
    },
    setTimeout(callback, delay) {
      const id = nextTimerId++;
      timers.set(id, {callback, delay});
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    window: windowObject,
  };
  vm.runInNewContext(
    require("node:fs").readFileSync(logPath, "utf8"),
    context,
    {filename: logPath},
  );

  return {
    fetchCalls,
    pendingFetches,
    dispatchMode(nextMode) {
      modeSelect.value = nextMode;
      windowObject.dispatchEvent({
        type: "bottom-pane-mode-changed",
        detail: {mode: nextMode},
      });
    },
    runTimer(delay) {
      const match = [...timers.entries()].find(([, timer]) => timer.delay === delay);
      assert.ok(match, `expected a ${delay}ms timer`);
      timers.delete(match[0]);
      match[1].callback();
    },
    timerDelays() {
      return [...timers.values()].map((timer) => timer.delay);
    },
  };
}

async function flushPromises() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("server log polling starts only when its pane opens and aborts on close", async () => {
  const harness = createHarness("music-player");

  assert.equal(harness.fetchCalls.length, 0);
  assert.deepEqual(harness.timerDelays(), []);

  harness.dispatchMode("server-log");
  harness.runTimer(500);
  assert.equal(harness.fetchCalls.length, 1);
  const signal = harness.fetchCalls[0].options.signal;
  assert.equal(signal.aborted, false);

  harness.dispatchMode("music-player");
  assert.equal(signal.aborted, true);
  harness.pendingFetches[0].resolve({
    json: async () => ({entries: [], updates: [], update_seq: 1}),
  });
  await flushPromises();
  assert.deepEqual(harness.timerDelays(), []);
});

test("server log polling resumes with its cursor after reopening", async () => {
  const harness = createHarness("server-log");

  harness.runTimer(500);
  assert.equal(harness.fetchCalls[0].url, "/logs?since=0&since_upd=0");
  harness.pendingFetches[0].resolve({
    json: async () => ({
      entries: [{index: 4, ts: "12:00:00", kind: "request", message: "ok"}],
      updates: [],
      update_seq: 9,
    }),
  });
  await flushPromises();

  harness.runTimer(2000);
  assert.equal(harness.fetchCalls[1].url, "/logs?since=5&since_upd=9");
  const secondSignal = harness.fetchCalls[1].options.signal;
  harness.dispatchMode("file-search");
  assert.equal(secondSignal.aborted, true);
  harness.pendingFetches[1].resolve({
    json: async () => ({entries: [], updates: [], update_seq: 9}),
  });
  await flushPromises();
  assert.deepEqual(harness.timerDelays(), []);

  harness.dispatchMode("server-log");
  harness.runTimer(500);
  assert.equal(harness.fetchCalls[2].url, "/logs?since=5&since_upd=9");
});
