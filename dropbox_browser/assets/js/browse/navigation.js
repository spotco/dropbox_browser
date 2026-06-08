import {normalizeBrowseState} from './api.js';

export function readBrowseLocation(search) {
  var params = new URLSearchParams((search || '').replace(/^\?/, ''));
  try {
    return normalizeBrowseState({
      path: params.get('path') || '',
      reveal: params.get('reveal') || '',
      sort: params.get('sort') || 'name',
      dir: params.get('dir') || 'asc',
      refresh: params.get('refresh') === '1',
      q: params.get('q') || '',
      kind: params.get('kind') || 'all',
      status: params.get('status') || 'all',
      type: params.get('type') || 'all',
    });
  } catch (_error) {
    return normalizeBrowseState({});
  }
}

export function readBrowseHref(href) {
  if (!href) return null;
  try {
    var url = new URL(href, window.location.href);
    if (url.origin !== window.location.origin) return null;
    if (url.pathname !== '/') return null;
    return readBrowseLocation(url.search);
  } catch (_error) {
    return null;
  }
}

export function shouldInterceptBrowseLink(link) {
  if (!link || typeof link.getAttribute !== 'function') return false;
  if (link.hasAttribute('download')) return false;
  if ((link.getAttribute('target') || '').trim()) return false;
  if (link.id === 'refresh-cache' || link.classList.contains('refresh-link')) return false;
  if (link.closest && link.closest('thead')) return false;
  return !!readBrowseHref(link.href || link.getAttribute('href') || '');
}
