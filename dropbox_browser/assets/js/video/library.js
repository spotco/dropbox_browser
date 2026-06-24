import {enqueueAndPlay} from '../video-core.js';

export function initLibrary(ctx) {
function renderLibrary() {
  var root = ctx.els.libraryListEl;
  if (!root) return;
  if (ctx.state.loadingLibrary) {
    root.innerHTML = '<div class="video-empty-state">Loading current folder video library...</div>';
    return;
  }
  if (!ctx.state.libraryItems.length) {
    root.innerHTML = '<div class="video-empty-state">No folders or supported video files found in this folder.</div>';
    return;
  }
  root.innerHTML = '';
  ctx.state.libraryItems.forEach(function (item) {
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'video-library-row';
    row.setAttribute('data-video-path', item.path || '');
    row.setAttribute('data-video-type', item.type || '');
    if (item.type === 'file' && ctx.state.selectedLibraryPaths[item.path]) {
      row.classList.add('is-selected');
    }
    var icon = item.type === 'folder' ? '▸' : '▶';
    var detail = item.type === 'folder'
      ? 'Open folder'
      : [item.extension || '', item.compatibility_expected ? 'Compatibility likely' : 'Native likely']
        .filter(Boolean)
        .join(' • ');
    row.innerHTML =
      '<span class="video-row-icon" aria-hidden="true">' + icon + '</span>' +
      '<span class="video-row-main">' +
      '<span class="video-row-title">' + ctx.escapeHtml(item.display_name || '') + '</span>' +
      '<span class="video-row-detail">' + ctx.escapeHtml(detail) + '</span>' +
      '</span>' +
      '<span class="video-row-action">' + (item.type === 'folder' ? 'Open' : 'Queue') + '</span>';
    row.addEventListener('click', function () {
      if (item.type === 'folder') {
        loadLibrary(item.path || '');
        return;
      }
      ctx.toggleLibrarySelection(item.path || '');
    });
    row.addEventListener('dblclick', function () {
      if (item.type !== 'file') return;
      var result = enqueueAndPlay(ctx.state.queue, ctx.state.activeQueueIndex, item);
      ctx.state.queue = result.queue;
      ctx.state.activeQueueIndex = result.activeIndex;
      ctx.state.selectedQueueIndex = result.activeIndex;
      ctx.state.pendingAutoplay = true;
      ctx.state.transportWantsPlay = true;
      ctx.renderQueue();
    });
    root.appendChild(row);
  });
  ctx.updateLibraryButtons();
}

async function loadPlaybackStatus() {
  if (ctx.state.loadingPlaybackStatus) return;
  ctx.state.loadingPlaybackStatus = true;
  try {
    var response = await fetch('/video/endpoints/status');
    if (!response.ok) throw new Error('Failed to load video playback status.');
    var payload = await response.json();
    ctx.state.playbackStatusLoaded = true;
    ctx.state.ffmpegAvailable = Boolean(payload.ffmpeg_available);
    ctx.state.ffprobeAvailable = Boolean(payload.ffprobe_available);
    ctx.state.compatibilityAvailable = Boolean(payload.compatibility_available);
    if (ctx.state.paneActive) void ctx.syncPlaybackForActiveItem();
  }
  catch (_error) {
    ctx.state.playbackStatusLoaded = true;
    ctx.state.ffmpegAvailable = false;
    ctx.state.ffprobeAvailable = false;
    ctx.state.compatibilityAvailable = false;
    if (ctx.state.paneActive) void ctx.syncPlaybackForActiveItem();
  }
  finally {
    ctx.state.loadingPlaybackStatus = false;
  }
}

async function loadLibrary(path) {
  ctx.updateCurrentFolder(path || '');
  ctx.state.loadingLibrary = true;
  ctx.state.selectedLibraryPaths = Object.create(null);
  renderLibrary();
  try {
    var response = await fetch('/video/endpoints/library?path=' + encodeURIComponent(ctx.state.currentFolder));
    if (!response.ok) throw new Error('Failed to load video library.');
    var payload = await response.json();
    ctx.state.libraryItems = Array.isArray(payload.items) ? payload.items : [];
    ctx.setStatus('Current folder video library is ready to load.');
  }
  catch (_error) {
    ctx.state.libraryItems = [];
    ctx.setStatus('Could not load current folder videos.');
  }
  finally {
    ctx.state.loadingLibrary = false;
    renderLibrary();
  }
}

  ctx.renderLibrary = renderLibrary;
  ctx.loadLibrary = loadLibrary;
  ctx.loadPlaybackStatus = loadPlaybackStatus;
}