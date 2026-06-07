export const DEFAULT_THUMBNAIL_ROOT_MARGIN = "88px 0px";
export const DEFAULT_MAX_CONCURRENT_THUMBNAILS = 4;

function readThumbnailHref(element) {
  if (!element || typeof element.getAttribute !== "function") return "";
  return element.getAttribute("data-thumbnail-href") || "";
}

function collectThumbnailTargets(root) {
  if (!root || typeof root.querySelectorAll !== "function") return [];
  return Array.from(root.querySelectorAll(".file-icon[data-thumbnail-href]")).filter(function (element) {
    return !!readThumbnailHref(element);
  });
}

export function initBrowseThumbnails(options) {
  const doc = options && options.document ? options.document : document;
  const win = options && options.window ? options.window : window;
  const rootNode = options && options.root ? options.root : doc;
  const rootMargin = options && options.rootMargin ? String(options.rootMargin) : DEFAULT_THUMBNAIL_ROOT_MARGIN;
  const maxConcurrent = Math.max(1, Number(options && options.maxConcurrentLoads) || DEFAULT_MAX_CONCURRENT_THUMBNAILS);
  if (!doc || !win || !rootNode) {
    return {
      refresh() {},
      cleanup() {},
    };
  }

  let observer = null;
  let generation = 0;
  let activeLoads = 0;
  let pending = [];
  let failedUrls = new Set();
  let loadedUrls = new Set();
  let inflightUrls = new Set();
  const queuedUrls = new Set();

  function clearPending() {
    pending = [];
    queuedUrls.clear();
  }

  function disconnectObserver() {
    if (observer && typeof observer.disconnect === "function") observer.disconnect();
  }

  function applyLoadedThumbnail(element, href) {
    if (!element || typeof element.setAttribute !== "function") return;
    element.setAttribute("src", href);
    element.setAttribute("data-thumbnail-state", "loaded");
  }

  function applyLoadedToMountedTargets(href) {
    if (!href) return;
    collectThumbnailTargets(rootNode).forEach(function (element) {
      if (readThumbnailHref(element) !== href) return;
      applyLoadedThumbnail(element, href);
    });
  }

  function processQueue() {
    while (activeLoads < maxConcurrent && pending.length > 0) {
      const nextItem = pending.shift();
      if (!nextItem) continue;
      queuedUrls.delete(nextItem.href);
      if (nextItem.generation !== generation) continue;
      if (!nextItem.element || !nextItem.element.isConnected) continue;
      if (failedUrls.has(nextItem.href)) continue;
      if (loadedUrls.has(nextItem.href)) {
        applyLoadedThumbnail(nextItem.element, nextItem.href);
        continue;
      }
      if (inflightUrls.has(nextItem.href)) continue;
      inflightUrls.add(nextItem.href);
      if (typeof nextItem.element.setAttribute === "function") {
        nextItem.element.setAttribute("data-thumbnail-state", "loading");
      }
      activeLoads += 1;
      const preload = new win.Image();
      preload.decoding = "async";
      preload.onload = function onload() {
        activeLoads = Math.max(0, activeLoads - 1);
        inflightUrls.delete(nextItem.href);
        loadedUrls.add(nextItem.href);
        if (
          nextItem.generation === generation &&
          nextItem.element &&
          nextItem.element.isConnected &&
          readThumbnailHref(nextItem.element) === nextItem.href
        ) {
          applyLoadedThumbnail(nextItem.element, nextItem.href);
        } else {
          applyLoadedToMountedTargets(nextItem.href);
        }
        processQueue();
      };
      preload.onerror = function onerror() {
        activeLoads = Math.max(0, activeLoads - 1);
        inflightUrls.delete(nextItem.href);
        failedUrls.add(nextItem.href);
        if (
          nextItem.generation === generation &&
          nextItem.element &&
          nextItem.element.isConnected &&
          readThumbnailHref(nextItem.element) === nextItem.href &&
          typeof nextItem.element.setAttribute === "function"
        ) {
          nextItem.element.setAttribute("data-thumbnail-state", "error");
        }
        processQueue();
      };
      preload.src = nextItem.href;
    }
  }

  function queueVisibleTarget(element) {
    const href = readThumbnailHref(element);
    if (!href || failedUrls.has(href)) return;
    if (loadedUrls.has(href)) {
      applyLoadedThumbnail(element, href);
      return;
    }
    if (inflightUrls.has(href) || queuedUrls.has(href)) return;
    pending.push({
      element: element,
      href: href,
      generation: generation,
    });
    queuedUrls.add(href);
    processQueue();
  }

  function ensureObserver() {
    if (observer || typeof win.IntersectionObserver !== "function") return observer;
    observer = new win.IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry || !entry.target) return;
        if (entry.isIntersecting || entry.intersectionRatio > 0) queueVisibleTarget(entry.target);
      });
    }, {
      root: null,
      rootMargin: rootMargin,
      threshold: 0.01,
    });
    return observer;
  }

  function resetPageState() {
    generation += 1;
    clearPending();
    failedUrls = new Set();
    loadedUrls = new Set();
    inflightUrls = new Set();
  }

  function refresh() {
    clearPending();
    disconnectObserver();
    const targets = collectThumbnailTargets(rootNode);
    if (targets.length === 0) return;
    targets.forEach(function (element) {
      const href = readThumbnailHref(element);
      if (loadedUrls.has(href)) applyLoadedThumbnail(element, href);
    });
    const activeObserver = ensureObserver();
    if (!activeObserver) {
      targets.forEach(queueVisibleTarget);
      return;
    }
    targets.forEach(function (element) {
      activeObserver.observe(element);
    });
  }

  function onBrowseFolderChanged() {
    resetPageState();
  }

  if (typeof win.addEventListener === "function") {
    win.addEventListener("browse-folder-changed", onBrowseFolderChanged);
  }

  return {
    refresh: refresh,
    cleanup: function cleanup() {
      resetPageState();
      disconnectObserver();
      if (typeof win.removeEventListener === "function") {
        win.removeEventListener("browse-folder-changed", onBrowseFolderChanged);
      }
    },
  };
}