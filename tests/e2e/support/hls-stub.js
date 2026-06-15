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

  attachMedia() {}

  loadSource() {
    queueMicrotask(() => {
      this.emit(Events.MANIFEST_PARSED);
    });
  }

  startLoad() {}

  recoverMediaError() {}

  destroy() {}
}

export default Hls;