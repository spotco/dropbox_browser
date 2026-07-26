// Keep this extension set aligned with dropbox_browser/thumbnails.py.
const PREVIEWABLE_IMAGE_EXTENSIONS = new Set([
  ".apng",
  ".avif",
  ".bmp",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
]);

const DEFAULT_MARGIN_PX = 18;

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function readPathFromHref(href, baseHref) {
  if (!href) return "";
  try {
    const url = new URL(href, baseHref || (typeof window !== "undefined" ? window.location.href : "http://127.0.0.1/"));
    if (url.pathname !== "/file") return "";
    return decodeURIComponent(url.searchParams.get("path") || "");
  } catch (_error) {
    return "";
  }
}

function fileExtensionForHref(href, baseHref) {
  const relPath = readPathFromHref(href, baseHref);
  if (!relPath) return "";
  const dotIndex = relPath.lastIndexOf(".");
  if (dotIndex < 0) return "";
  return relPath.slice(dotIndex).toLowerCase();
}

export function isPreviewableImageHref(href, baseHref) {
  return PREVIEWABLE_IMAGE_EXTENSIONS.has(fileExtensionForHref(href, baseHref));
}

export function readLoadedThumbnailSrc(link) {
  if (!link || typeof link.querySelector !== "function") return "";
  const icon = link.querySelector(".file-icon[data-thumbnail-href]");
  if (!icon || typeof icon.getAttribute !== "function") return "";
  if (icon.getAttribute("data-thumbnail-kind") === "video") return "";
  const thumbnailHref = icon.getAttribute("data-thumbnail-href") || "";
  if (!thumbnailHref) return "";
  if (icon.getAttribute("data-thumbnail-state") !== "loaded") return "";
  const src = icon.getAttribute("src") || "";
  return src === thumbnailHref ? src : "";
}

export function computeHoverPreviewPosition(pointer, previewSize, viewportSize, marginPx) {
  const safeMargin = Number.isFinite(marginPx) ? marginPx : DEFAULT_MARGIN_PX;
  const width = Math.max(0, Number(previewSize && previewSize.width) || 0);
  const height = Math.max(0, Number(previewSize && previewSize.height) || 0);
  const viewportWidth = Math.max(width + safeMargin * 2, Number(viewportSize && viewportSize.width) || 0);
  const viewportHeight = Math.max(height + safeMargin * 2, Number(viewportSize && viewportSize.height) || 0);
  const pointerX = Number(pointer && pointer.x) || 0;
  const pointerY = Number(pointer && pointer.y) || 0;
  const preferredLeft = pointerX + safeMargin;
  const preferredTop = pointerY - height - safeMargin;
  const fallbackTop = pointerY + safeMargin;
  return {
    left: clamp(preferredLeft, safeMargin, viewportWidth - width - safeMargin),
    top: preferredTop >= safeMargin
      ? preferredTop
      : clamp(fallbackTop, safeMargin, viewportHeight - height - safeMargin),
  };
}

function ensurePreviewElements(doc) {
  let root = doc.getElementById("browse-image-hover-preview");
  if (!root) {
    root = doc.createElement("div");
    root.id = "browse-image-hover-preview";
    root.className = "browse-image-hover-preview hidden";
    root.setAttribute("aria-hidden", "true");
    root.innerHTML =
      '<img class="browse-image-hover-preview-thumbnail" alt="" aria-hidden="true">' +
      '<div class="browse-image-hover-preview-shade"></div>' +
      '<div class="browse-image-hover-preview-loading">' +
        '<span class="spinner"></span>' +
        '<span>Loading preview…</span>' +
      "</div>" +
      '<img class="browse-image-hover-preview-image" alt="">' +
      '<div class="browse-image-hover-preview-caption"></div>';
    doc.body.appendChild(root);
  }
  return {
    root: root,
    thumbnail: root.querySelector(".browse-image-hover-preview-thumbnail"),
    shade: root.querySelector(".browse-image-hover-preview-shade"),
    loading: root.querySelector(".browse-image-hover-preview-loading"),
    image: root.querySelector(".browse-image-hover-preview-image"),
    caption: root.querySelector(".browse-image-hover-preview-caption"),
  };
}

export function initImageHoverPreview(options) {
  const doc = options && options.document ? options.document : document;
  const win = options && options.window ? options.window : window;
  const rootNode = options && options.root ? options.root : doc;
  if (!doc || !win || !doc.body || !rootNode || typeof rootNode.addEventListener !== "function") {
    return function cleanup() {};
  }

  const elements = ensurePreviewElements(doc);
  const state = {
    activeLink: null,
    requestToken: 0,
    pointerX: 0,
    pointerY: 0,
  };

  function updatePosition() {
    if (!state.activeLink || elements.root.classList.contains("hidden")) return;
    const rect = elements.root.getBoundingClientRect();
    const position = computeHoverPreviewPosition(
      {x: state.pointerX, y: state.pointerY},
      {width: rect.width, height: rect.height},
      {width: win.innerWidth, height: win.innerHeight},
      DEFAULT_MARGIN_PX,
    );
    elements.root.style.left = String(Math.round(position.left)) + "px";
    elements.root.style.top = String(Math.round(position.top)) + "px";
  }

  function setLoadingThumbnail(link) {
    const thumbnailSrc = readLoadedThumbnailSrc(link);
    if (thumbnailSrc && elements.thumbnail) {
      elements.thumbnail.setAttribute("src", thumbnailSrc);
      elements.root.dataset.hasThumbnail = "1";
      return;
    }
    if (elements.thumbnail) elements.thumbnail.removeAttribute("src");
    elements.root.dataset.hasThumbnail = "0";
  }

  function hidePreview() {
    state.activeLink = null;
    state.requestToken += 1;
    elements.root.classList.add("hidden");
    elements.root.dataset.state = "hidden";
    elements.root.dataset.hasThumbnail = "0";
    elements.root.setAttribute("aria-hidden", "true");
    if (elements.thumbnail) elements.thumbnail.removeAttribute("src");
    elements.image.removeAttribute("src");
    elements.caption.textContent = "";
  }

  function showLoading(link) {
    elements.root.classList.remove("hidden");
    elements.root.dataset.state = "loading";
    elements.root.setAttribute("aria-hidden", "false");
    setLoadingThumbnail(link);
    elements.caption.textContent = link.textContent || "";
    updatePosition();
  }

  function showImage(link, src) {
    if (state.activeLink !== link) return;
    elements.image.src = src;
    elements.caption.textContent = link.textContent || "";
    elements.root.dataset.state = "loaded";
    updatePosition();
  }

  function loadPreview(link) {
    state.activeLink = link;
    state.requestToken += 1;
    const token = state.requestToken;
    const href = link.href || link.getAttribute("href") || "";
    showLoading(link);
    const preload = new win.Image();
    preload.decoding = "async";
    preload.onload = function onload() {
      if (token !== state.requestToken || state.activeLink !== link) return;
      showImage(link, href);
    };
    preload.onerror = function onerror() {
      if (token !== state.requestToken || state.activeLink !== link) return;
      hidePreview();
    };
    preload.src = href;
  }

  function previewLinkForTarget(target) {
    if (!target || !target.closest) return null;
    const link = target.closest('a.name[href*="/file?"], a.name[href^="/file?"], a.name');
    if (!link || !rootNode.contains(link)) return null;
    const href = link.href || link.getAttribute("href") || "";
    if (!isPreviewableImageHref(href, win.location && win.location.href)) return null;
    return link;
  }

  function onPointerOver(event) {
    const link = previewLinkForTarget(event.target);
    if (!link) return;
    state.pointerX = event.clientX;
    state.pointerY = event.clientY;
    if (state.activeLink === link) {
      updatePosition();
      return;
    }
    loadPreview(link);
  }

  function onPointerMove(event) {
    if (!state.activeLink) return;
    state.pointerX = event.clientX;
    state.pointerY = event.clientY;
    updatePosition();
  }

  function onPointerOut(event) {
    const link = previewLinkForTarget(event.target);
    if (!link || link !== state.activeLink) return;
    if (event.relatedTarget && link.contains(event.relatedTarget)) return;
    hidePreview();
  }

  function onWindowBlur() {
    hidePreview();
  }

  rootNode.addEventListener("pointerover", onPointerOver);
  rootNode.addEventListener("pointermove", onPointerMove);
  rootNode.addEventListener("pointerout", onPointerOut);
  win.addEventListener("scroll", updatePosition, {passive: true});
  win.addEventListener("resize", updatePosition);
  win.addEventListener("blur", onWindowBlur);

  return function cleanup() {
    hidePreview();
    rootNode.removeEventListener("pointerover", onPointerOver);
    rootNode.removeEventListener("pointermove", onPointerMove);
    rootNode.removeEventListener("pointerout", onPointerOut);
    win.removeEventListener("scroll", updatePosition);
    win.removeEventListener("resize", updatePosition);
    win.removeEventListener("blur", onWindowBlur);
    if (elements.root.parentNode) elements.root.parentNode.removeChild(elements.root);
  };
}
