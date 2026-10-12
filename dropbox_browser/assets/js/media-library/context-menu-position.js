// Places a media-library context menu (position: fixed) at the pointer and
// keeps it, and each of its submenus, fully visible: a menu that would run
// past the bottom/right edge flips up/left of the pointer (or is shifted
// back inside), and submenus open to the left and/or are shifted up. The
// visible area is the viewport, narrowed by any ancestor that clips fixed
// descendants (one that is their containing block: transform, filter,
// contain, container-type, ...) together with its overflow-clipping
// ancestors. A menu larger than that area is not handled specially.

var EDGE_MARGIN_PX = 4;

function createsFixedContainingBlock(style) {
  if (!style) return false;
  if (style.transform && style.transform !== 'none') return true;
  if (style.filter && style.filter !== 'none') return true;
  if (style.perspective && style.perspective !== 'none') return true;
  if (style.backdropFilter && style.backdropFilter !== 'none') return true;
  if (/(paint|layout|strict|content)/.test(style.contain || '')) return true;
  if (style.containerType && style.containerType !== 'normal') return true;
  if (/(transform|filter|perspective)/.test(style.willChange || '')) return true;
  return false;
}

function clipsOverflow(style) {
  return !!style && (
    (style.overflowX && style.overflowX !== 'visible') ||
    (style.overflowY && style.overflowY !== 'visible')
  );
}

export function contextMenuVisibleBounds(menu) {
  var doc = menu.ownerDocument || document;
  var win = doc.defaultView || window;
  var root = doc.documentElement;
  var bounds = {
    left: 0,
    top: 0,
    right: (root && root.clientWidth) || win.innerWidth,
    bottom: (root && root.clientHeight) || win.innerHeight,
  };
  var clipping = false;
  for (var node = menu.parentElement; node && node !== root; node = node.parentElement) {
    var style = win.getComputedStyle(node);
    if (!clipping && createsFixedContainingBlock(style)) clipping = true;
    if (clipping && clipsOverflow(style)) {
      var rect = node.getBoundingClientRect();
      bounds.left = Math.max(bounds.left, rect.left);
      bounds.top = Math.max(bounds.top, rect.top);
      bounds.right = Math.min(bounds.right, rect.right);
      bounds.bottom = Math.min(bounds.bottom, rect.bottom);
    }
  }
  return bounds;
}

function fitAxis(anchor, size, min, max) {
  // Prefer opening after the anchor, else before it, else pin inside.
  if (anchor + size <= max) return anchor;
  if (anchor - size >= min) return anchor - size;
  return Math.max(min, max - size);
}

function placeSubmenus(menu, bounds) {
  var win = (menu.ownerDocument || document).defaultView || window;
  if (typeof menu.querySelectorAll !== 'function') return;
  var submenus = menu.querySelectorAll('.music-context-submenu');
  Array.prototype.forEach.call(submenus, function (submenu) {
    submenu.classList.remove('music-context-submenu-left');
    submenu.style.removeProperty('top');
    // Submenus are display:none until hovered; lay one out invisibly to
    // measure where it would open.
    var previousDisplay = submenu.style.display;
    var previousVisibility = submenu.style.visibility;
    submenu.style.display = 'flex';
    submenu.style.visibility = 'hidden';
    var rect = submenu.getBoundingClientRect();
    if (rect.right > bounds.right - EDGE_MARGIN_PX) {
      submenu.classList.add('music-context-submenu-left');
      rect = submenu.getBoundingClientRect();
    }
    var overflowBottom = rect.bottom - (bounds.bottom - EDGE_MARGIN_PX);
    if (overflowBottom > 0) {
      var shift = Math.min(overflowBottom, Math.max(0, rect.top - (bounds.top + EDGE_MARGIN_PX)));
      var currentTop = parseFloat(win.getComputedStyle(submenu).top) || 0;
      submenu.style.top = String(currentTop - shift) + 'px';
    }
    submenu.style.display = previousDisplay;
    submenu.style.visibility = previousVisibility;
  });
}

export function showContextMenuAt(menu, clientX, clientY) {
  if (!menu) return;
  var x = Number(clientX) || 0;
  var y = Number(clientY) || 0;
  menu.hidden = false;
  menu.classList.remove('hidden');
  menu.style.left = String(x) + 'px';
  menu.style.top = String(y) + 'px';
  if (typeof menu.getBoundingClientRect !== 'function') return;
  var win = (menu.ownerDocument || document).defaultView || window;
  if (!win || typeof win.getComputedStyle !== 'function') return;
  var rect = menu.getBoundingClientRect();
  // Offset of the menu's containing block from the viewport (0 unless an
  // ancestor captures position: fixed).
  var offsetX = rect.left - x;
  var offsetY = rect.top - y;
  var bounds = contextMenuVisibleBounds(menu);
  var left = fitAxis(x, rect.width, bounds.left + EDGE_MARGIN_PX, bounds.right - EDGE_MARGIN_PX);
  var top = fitAxis(y, rect.height, bounds.top + EDGE_MARGIN_PX, bounds.bottom - EDGE_MARGIN_PX);
  menu.style.left = String(left - offsetX) + 'px';
  menu.style.top = String(top - offsetY) + 'px';
  placeSubmenus(menu, bounds);
}