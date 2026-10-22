// Places a media-library context menu (position: fixed) at the pointer and
// keeps it, and each of its submenus, fully visible: a menu that would run
// past the bottom/right edge flips up/left of the pointer (or is shifted
// back inside), and submenus open to the left and/or are shifted up. The
// visible area is the viewport, narrowed by any ancestor that clips fixed
// descendants (one that is their containing block: transform, filter,
// contain, container-type, ...) together with its overflow-clipping
// ancestors. A menu larger than that area is not handled specially.
//
// Touch long-press opens the same menus. Hover flyouts do not work with a
// finger, so a touch open toggles submenus in place and ignores the click
// the browser synthesizes when the finger lifts.

var EDGE_MARGIN_PX = 4;
export var TOUCH_LONG_PRESS_MS = 500;
export var TOUCH_LONG_PRESS_MOVE_PX = 12;
// A second short tap within this window plays the row. touch-action:
// manipulation (set so a tap can scroll and a long-press is not a zoom)
// does not emit dblclick for touch.
export var TOUCH_DOUBLE_TAP_MS = 500;
var TOUCH_MENU_CLICK_GUARD_MS = 400;
var TOUCH_DOUBLE_TAP_SUPPRESS_MS = 700;
var RECENT_TOUCH_MS = 1500;
var INTERACTIVE_LONG_PRESS_SELECTOR = 'button, a, input, textarea, select, label';

var lastTouchAt = 0;
var touchTrackingInstalled = false;
var ignoreMenuClicksUntil = 0;
var swallowNextNonMenuClick = false;
var longPressRelease = false;
var touchDoubleTapHandledAt = 0;

function view() {
  if (typeof globalThis.window !== 'undefined') return globalThis.window;
  return globalThis;
}

export function noteTouchPointer(now) {
  lastTouchAt = typeof now === 'number' ? now : Date.now();
}

export function openedFromRecentTouch(now) {
  var current = typeof now === 'number' ? now : Date.now();
  return lastTouchAt > 0 && (current - lastTouchAt) < RECENT_TOUCH_MS;
}

function installTouchTracking() {
  var doc = typeof document !== 'undefined' ? document : null;
  if (touchTrackingInstalled || !doc || typeof doc.addEventListener !== 'function') return;
  touchTrackingInstalled = true;
  doc.addEventListener('pointerdown', function (ev) {
    if (ev && ev.pointerType === 'touch') noteTouchPointer();
  }, true);
  // The click after a long press would otherwise dismiss the menu or activate
  // the item that opened under the finger. A touch contextmenu arms a short
  // guard; a long-press release only swallows the non-menu click.
  doc.addEventListener('click', function (ev) {
    var onMenu = !!(ev && ev.target && typeof ev.target.closest === 'function' &&
      ev.target.closest('.music-context-menu'));
    if (onMenu && Date.now() <= ignoreMenuClicksUntil) {
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    if (swallowNextNonMenuClick && !onMenu) {
      swallowNextNonMenuClick = false;
      ev.preventDefault();
      ev.stopPropagation();
    }
  }, true);
}

export function touchPointMoved(startX, startY, x, y, limit) {
  var dx = (Number(x) || 0) - (Number(startX) || 0);
  var dy = (Number(y) || 0) - (Number(startY) || 0);
  var maxDistance = Number(limit);
  if (!Number.isFinite(maxDistance)) maxDistance = TOUCH_LONG_PRESS_MOVE_PX;
  return (dx * dx) + (dy * dy) > maxDistance * maxDistance;
}

export function touchLongPressShouldArm(ev) {
  var target;
  if (!ev || ev.pointerType !== 'touch') return false;
  if (ev.isPrimary === false) return false;
  if (ev.button !== undefined && ev.button !== 0) return false;
  target = ev.target;
  if (target && typeof target.closest === 'function' && target.closest(INTERACTIVE_LONG_PRESS_SELECTOR)) return false;
  return true;
}

export function createLongPressGesture() {
  var pending = null;
  return {
    begin: function (ev) {
      if (!touchLongPressShouldArm(ev)) return false;
      pending = {
        pointerId: ev.pointerId,
        x: ev.clientX,
        y: ev.clientY,
        target: ev.target,
        ready: false
      };
      return true;
    },
    markReady: function () {
      if (pending) pending.ready = true;
    },
    move: function (ev) {
      if (!pending || !ev || ev.pointerId !== pending.pointerId) return 'ignore';
      if (touchPointMoved(pending.x, pending.y, ev.clientX, ev.clientY, TOUCH_LONG_PRESS_MOVE_PX)) {
        pending = null;
        return 'cancel';
      }
      return 'pending';
    },
    matches: function (ev) {
      return !!(pending && ev && ev.pointerId === pending.pointerId);
    },
    end: function (ev) {
      var fired;
      if (!pending || !ev || ev.pointerId !== pending.pointerId) return null;
      fired = pending.ready ? {
        clientX: pending.x,
        clientY: pending.y,
        target: pending.target
      } : null;
      pending = null;
      return fired;
    }
  };
}

export function createTouchDoubleTap(options) {
  var maxGap = options && Number.isFinite(Number(options.maxGap))
    ? Number(options.maxGap)
    : TOUCH_DOUBLE_TAP_MS;
  var keyFor = options && typeof options.keyFor === 'function'
    ? options.keyFor
    : function (target) { return target || ''; };
  var last = null;
  return {
    reset: function () {
      last = null;
    },
    note: function (ev, now) {
      var at;
      var key;
      if (!ev || ev.pointerType !== 'touch') return false;
      at = typeof now === 'number' ? now : Date.now();
      key = keyFor(ev.target);
      if (key === undefined || key === null || key === '') {
        last = null;
        return false;
      }
      if (last && last.key === key && at >= last.at && (at - last.at) <= maxGap) {
        last = null;
        return true;
      }
      last = {key: key, at: at};
      return false;
    }
  };
}

export function touchDoubleTapSuppressesNativeDblclick(now) {
  var current = typeof now === 'number' ? now : Date.now();
  return touchDoubleTapHandledAt > 0 && (current - touchDoubleTapHandledAt) < TOUCH_DOUBLE_TAP_SUPPRESS_MS;
}

function noteTouchDoubleTapHandled(now) {
  touchDoubleTapHandledAt = typeof now === 'number' ? now : Date.now();
}

export function bindTouchLongPress(target, onLongPress, options) {
  var gesture;
  var timer = null;
  var onDoubleTap = options && typeof options.onDoubleTap === 'function' ? options.onDoubleTap : null;
  var doubleTap = null;
  if (!target || typeof target.addEventListener !== 'function' || typeof onLongPress !== 'function') return;
  installTouchTracking();
  gesture = createLongPressGesture();
  if (onDoubleTap) {
    doubleTap = createTouchDoubleTap({
      keyFor: options && typeof options.doubleTapKey === 'function' ? options.doubleTapKey : null
    });
  }

  function clearTimer() {
    if (timer === null) return;
    view().clearTimeout(timer);
    timer = null;
  }

  function detachWindow() {
    var win = view();
    win.removeEventListener('pointermove', onMove);
    win.removeEventListener('pointerup', onUp);
    win.removeEventListener('pointercancel', onCancel);
  }

  function onMove(ev) {
    if (gesture.move(ev) !== 'cancel') return;
    clearTimer();
    detachWindow();
  }

  function onCancel(ev) {
    clearTimer();
    detachWindow();
    gesture.end(ev);
  }

  function onUp(ev) {
    var tracked;
    var fired;
    clearTimer();
    detachWindow();
    tracked = gesture.matches(ev);
    fired = gesture.end(ev);
    if (!tracked) return;
    if (fired) {
      if (doubleTap) doubleTap.reset();
      longPressRelease = true;
      try {
        onLongPress(fired);
      } finally {
        longPressRelease = false;
      }
      return;
    }
    if (doubleTap && doubleTap.note(ev)) {
      noteTouchDoubleTapHandled();
      onDoubleTap(ev);
    }
  }

  target.addEventListener('pointerdown', function (ev) {
    if (!gesture.begin(ev)) return;
    clearTimer();
    var win = view();
    win.addEventListener('pointermove', onMove);
    win.addEventListener('pointerup', onUp);
    win.addEventListener('pointercancel', onCancel);
    timer = win.setTimeout(function () {
      timer = null;
      gesture.markReady();
    }, TOUCH_LONG_PRESS_MS);
  });
}

export function contextMenuEventShouldDismiss(ev) {
  var menu;
  if (!ev || !ev.target || typeof ev.target.closest !== 'function') return true;
  menu = ev.target.closest('.music-context-menu');
  if (!menu || !menu.classList) return true;
  return !menu.classList.contains('music-context-menu-touch');
}

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

function closeContextSubmenus(menu) {
  if (!menu || typeof menu.querySelectorAll !== 'function') return;
  Array.prototype.forEach.call(menu.querySelectorAll('.music-context-submenu-open'), function (group) {
    var parent;
    group.classList.remove('music-context-submenu-open');
    parent = typeof group.querySelector === 'function' ? group.querySelector('.music-context-menu-parent') : null;
    if (parent) parent.setAttribute('aria-expanded', 'false');
  });
}

function placeContextMenu(menu, clientX, clientY) {
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

function refitContextMenu(menu) {
  if (!menu || menu.hidden) return;
  placeContextMenu(menu, menu._contextAnchorX || 0, menu._contextAnchorY || 0);
}

function ensureTouchSubmenuToggle(menu) {
  if (!menu || menu.dataset && menu.dataset.touchSubmenuBound === 'true') return;
  if (menu.dataset) menu.dataset.touchSubmenuBound = 'true';
  menu.addEventListener('click', function (ev) {
    var parent;
    var group;
    var willOpen;
    if (!menu.classList.contains('music-context-menu-touch')) return;
    if (!ev.target || typeof ev.target.closest !== 'function') return;
    parent = ev.target.closest('.music-context-menu-parent');
    if (!parent || (typeof menu.contains === 'function' && !menu.contains(parent))) return;
    group = typeof parent.closest === 'function' ? parent.closest('.music-context-menu-group') : null;
    if (!group) return;
    ev.preventDefault();
    ev.stopPropagation();
    willOpen = !group.classList.contains('music-context-submenu-open');
    closeContextSubmenus(menu);
    if (willOpen) {
      group.classList.add('music-context-submenu-open');
      parent.setAttribute('aria-expanded', 'true');
    }
    refitContextMenu(menu);
  });
}

export function showContextMenuAt(menu, clientX, clientY) {
  var touchOpen;
  if (!menu) return;
  installTouchTracking();
  ensureTouchSubmenuToggle(menu);
  closeContextSubmenus(menu);
  touchOpen = openedFromRecentTouch();
  if (menu.classList) {
    menu.classList.toggle('music-context-menu-touch', touchOpen);
  }
  if (touchOpen) {
    // Only the click synthesized by lifting the finger is swallowed. A later
    // tap outside still dismisses the menu.
    swallowNextNonMenuClick = true;
    view().setTimeout(function () {
      swallowNextNonMenuClick = false;
    }, TOUCH_MENU_CLICK_GUARD_MS);
    if (!longPressRelease) ignoreMenuClicksUntil = Date.now() + TOUCH_MENU_CLICK_GUARD_MS;
  } else {
    ignoreMenuClicksUntil = 0;
    swallowNextNonMenuClick = false;
  }
  menu._contextAnchorX = Number(clientX) || 0;
  menu._contextAnchorY = Number(clientY) || 0;
  placeContextMenu(menu, menu._contextAnchorX, menu._contextAnchorY);
}
