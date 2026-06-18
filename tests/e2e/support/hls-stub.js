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

  attachMedia(media) {
    this._media = media || null;
  }

  loadSource() {
    const configuredCount = Number(globalThis.__HLS_STUB_FRAGMENT_COUNT);
    const fragmentCount = Number.isFinite(configuredCount) && configuredCount > 0
      ? Math.floor(configuredCount)
      : 2;
    setTimeout(() => {
      this.emit(Events.MANIFEST_LOADING, { url: "stub://manifest.m3u8" });
      this.emit(Events.MANIFEST_LOADED, { levels: [{}] });
      this.emit(Events.MANIFEST_PARSED);
      for (let index = 0; index < fragmentCount; index += 1) {
        const fragment = {
          sn: index,
          url: `stub://segment_${String(index).padStart(5, "0")}.m4s`,
        };
        this.emit(Events.FRAG_LOADING, { frag: fragment });
        this.emit(Events.FRAG_LOADED, { frag: fragment, stats: { loaded: 128, loading: { start: 0, end: 1 } } });
        this.emit(Events.FRAG_BUFFERED, { frag: fragment });
      }
      if (this._media) {
        this._media.dispatchEvent(new Event("loadedmetadata"));
        this._media.dispatchEvent(new Event("loadeddata"));
        this._media.dispatchEvent(new Event("canplay"));
        this._media.dispatchEvent(new Event("playing"));
      }
    }, 0);
  }

  startLoad() {}

  recoverMediaError() {}

  destroy() {}
}

export default Hls;
