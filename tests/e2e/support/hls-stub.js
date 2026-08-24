const Events = {
  MANIFEST_LOADING: "hlsManifestLoading",
  MANIFEST_LOADED: "hlsManifestLoaded",
  MANIFEST_PARSED: "hlsManifestParsed",
  FRAG_LOADING: "hlsFragLoading",
  FRAG_LOADED: "hlsFragLoaded",
  FRAG_BUFFERED: "hlsFragBuffered",
  ERROR: "hlsError",
};

const ErrorTypes = {
  NETWORK_ERROR: "networkError",
  MEDIA_ERROR: "mediaError",
};

function configuredFragmentCount(key, fallback) {
  const configured = Number(globalThis[key]);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  return fallback;
}

function configuredDelayMs(key) {
  const configured = Number(globalThis[key]);
  return Number.isFinite(configured) && configured >= 0 ? configured : 0;
}

function installSeekableMedia(media, durationSeconds) {
  if (!media) return;
  const duration = Math.max(0, Number(durationSeconds) || 0);
  const seekable = {
    length: duration > 0 ? 1 : 0,
    start(index) {
      return index === 0 ? 0 : Number.NaN;
    },
    end(index) {
      return index === 0 ? duration : Number.NaN;
    },
  };
  Object.defineProperty(media, "duration", {
    configurable: true,
    get() {
      return duration;
    },
  });
  Object.defineProperty(media, "seekable", {
    configurable: true,
    get() {
      return seekable;
    },
  });
}

class Hls {
  static get Events() {
    return Events;
  }

  static get ErrorTypes() {
    return ErrorTypes;
  }

  static isSupported() {
    return true;
  }

  constructor() {
    this._listeners = Object.create(null);
    this._media = null;
  }

  on(eventName, handler) {
    if (!this._listeners[eventName]) {
      this._listeners[eventName] = [];
    }
    this._listeners[eventName].push(handler);
  }

  emit(eventName, data) {
    const handlers = this._listeners[eventName] || [];
    handlers.forEach((handler) => handler(eventName, data));
  }

  emitMissingFragmentError(fragmentIndex) {
    const fragment = {
      sn: fragmentIndex,
      url: `stub://segment_${String(fragmentIndex).padStart(5, "0")}.m4s`,
    };
    this.emit(Events.ERROR, {
      type: ErrorTypes.NETWORK_ERROR,
      details: "fragLoadError",
      fatal: true,
      frag: fragment,
      reason: "HTTP Error 404 Not Found",
    });
  }

  installMissingSegmentSeekSimulation(media) {
    if (!media || !globalThis.__HLS_STUB_SIMULATE_MISSING_ON_SEEK) return;
    const availableFragmentCount = configuredFragmentCount("__HLS_STUB_FRAGMENT_COUNT", 2);
    const hls = this;
    let internalTime = 0;
    Object.defineProperty(media, "currentTime", {
      configurable: true,
      get() {
        return internalTime;
      },
      set(value) {
        const nextTime = Math.max(0, Number(value) || 0);
        internalTime = nextTime;
        const fragmentIndex = Math.floor(nextTime / 6);
        if (fragmentIndex >= availableFragmentCount) {
          setTimeout(() => {
            hls.emitMissingFragmentError(fragmentIndex);
          }, 0);
        }
        media.dispatchEvent(new Event("seeking"));
        media.dispatchEvent(new Event("seeked"));
      },
    });
  }

  attachMedia(media) {
    this._media = media || null;
    this.installMissingSegmentSeekSimulation(media);
  }

  loadSource() {
    const availableFragmentCount = configuredFragmentCount("__HLS_STUB_FRAGMENT_COUNT", 2);
    const playlistFragmentCount = configuredFragmentCount(
      "__HLS_STUB_PLAYLIST_FRAGMENT_COUNT",
      availableFragmentCount,
    );
    const manifestLoadDelayMs = configuredDelayMs("__HLS_STUB_MANIFEST_LOAD_DELAY_MS");
    const fragmentLoadDelayMs = configuredDelayMs("__HLS_STUB_FRAGMENT_LOAD_DELAY_MS");
    const fragmentLoadIntervalMs = configuredDelayMs("__HLS_STUB_FRAGMENT_LOAD_INTERVAL_MS");
    const playlistDurationSeconds = playlistFragmentCount * 6;
    setTimeout(() => {
      this.emit(Events.MANIFEST_LOADING, { url: "stub://manifest.m3u8" });
      this.emit(Events.MANIFEST_LOADED, { levels: [{}] });
      this.emit(Events.MANIFEST_PARSED);
      installSeekableMedia(this._media, playlistDurationSeconds);
      for (let index = 0; index < availableFragmentCount; index += 1) {
        const loadStartMs = index * fragmentLoadIntervalMs;
        const loadEndMs = loadStartMs + fragmentLoadDelayMs;
        const fragment = {
          sn: index,
          url: `stub://segment_${String(index).padStart(5, "0")}.m4s`,
          stats: { loaded: 128, loading: { start: loadStartMs, first: loadEndMs, end: loadEndMs } },
        };
        setTimeout(() => {
          this.emit(Events.FRAG_LOADING, { frag: fragment });
        }, loadStartMs);
        setTimeout(() => {
          this.emit(Events.FRAG_LOADED, {
            frag: fragment,
          });
          this.emit(Events.FRAG_BUFFERED, { frag: fragment });
        }, loadEndMs);
      }
      if (this._media) {
        this._media.dispatchEvent(new Event("loadedmetadata"));
        this._media.dispatchEvent(new Event("loadeddata"));
        this._media.dispatchEvent(new Event("canplay"));
        this._media.dispatchEvent(new Event("playing"));
      }
    }, manifestLoadDelayMs);
  }

  startLoad() {}

  recoverMediaError() {}

  destroy() {
    this._media = null;
  }
}

export default Hls;
