/**
 * Media Session recorder for e2e. Headless Chromium does not surface a system
 * media card, so replace navigator.mediaSession before any page script runs
 * with a recording fake and inspect what the page published.
 */
async function installMediaSessionRecorder(page) {
  await page.addInitScript(() => {
    const describe = (metadata) => metadata
      ? {
        title: metadata.title,
        artist: metadata.artist,
        album: metadata.album,
        artwork: Array.from(metadata.artwork || []).map((item) => ({ src: item.src, type: item.type || "" })),
      }
      : null;
    const fake = {
      _metadata: null,
      _playbackState: "none",
      handlers: {},
      metadataLog: [],
      stateLog: [],
      positions: [],
      get metadata() {
        return this._metadata;
      },
      set metadata(value) {
        this._metadata = value;
        this.metadataLog.push(describe(value));
      },
      get playbackState() {
        return this._playbackState;
      },
      set playbackState(value) {
        this._playbackState = value;
        this.stateLog.push(value);
      },
      setActionHandler(action, handler) {
        if (handler) this.handlers[action] = handler;
        else delete this.handlers[action];
      },
      setPositionState(state) {
        this.positions.push(state ? { ...state } : null);
      },
    };
    fake.describe = describe;
    Object.defineProperty(Navigator.prototype, "mediaSession", {
      configurable: true,
      get() {
        return fake;
      },
    });
    window.__mediaSessionFake = fake;
  });
}

async function mediaSessionState(page) {
  return page.evaluate(() => {
    const fake = window.__mediaSessionFake;
    const current = fake.describe(fake.metadata);
    return {
      metadata: current,
      title: current ? current.title : null,
      artist: current ? current.artist : null,
      artwork: current ? current.artwork : null,
      playbackState: fake.playbackState,
      handlers: Object.keys(fake.handlers).sort(),
      position: fake.positions.length ? fake.positions[fake.positions.length - 1] : null,
      positionCount: fake.positions.length,
      titles: fake.metadataLog.map((entry) => (entry ? entry.title : null)),
    };
  });
}

// Invoke a registered action handler the way the OS would.
async function invokeMediaSessionAction(page, action, details = {}) {
  return page.evaluate(({ name, extra }) => {
    const handler = window.__mediaSessionFake.handlers[name];
    if (typeof handler !== "function") return false;
    handler({ action: name, ...extra });
    return true;
  }, { name: action, extra: details });
}

const ALL_MEDIA_SESSION_ACTIONS = [
  "nexttrack",
  "pause",
  "play",
  "previoustrack",
  "seekbackward",
  "seekforward",
  "seekto",
];

module.exports = {
  ALL_MEDIA_SESSION_ACTIONS,
  installMediaSessionRecorder,
  invokeMediaSessionAction,
  mediaSessionState,
};