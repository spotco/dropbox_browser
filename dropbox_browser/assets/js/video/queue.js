import {
  advanceQueueAfterPlaybackEnd,
  clearQueue,
  enqueueAndPlay,
  enqueueSelected,
  moveQueueIndex,
  playQueueIndex,
  removeQueueIndex,
} from '../video-core.js';

export function initQueue(ctx) {
function renderQueue() {
  var root = ctx.els.queueListEl;
  if (!root) return;
  if (!ctx.state.queue.length) {
    root.innerHTML = '<div class="video-empty-state">Queue is empty.</div>';
    updateQueueButtons();
    void ctx.syncPlaybackForActiveItem();
    return;
  }
  root.innerHTML = '';
  ctx.state.queue.forEach(function (item, index) {
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'video-queue-row';
    if (index === ctx.state.selectedQueueIndex) row.classList.add('is-selected');
    if (index === ctx.state.activeQueueIndex) row.classList.add('is-active');
    row.setAttribute('data-video-queue-index', String(index));
    row.innerHTML =
      '<span class="video-row-main">' +
      '<span class="video-row-title">' + ctx.escapeHtml(item.display_name || '') + '</span>' +
      '<span class="video-row-detail">' + ctx.escapeHtml(item.path || '') + '</span>' +
      '</span>' +
      '<span class="video-row-action">' + (index === ctx.state.activeQueueIndex ? 'Now Playing' : 'Queued') + '</span>';
    row.addEventListener('click', function () {
      ctx.state.selectedQueueIndex = index;
      renderQueue();
    });
    row.addEventListener('dblclick', function () {
      ctx.state.activeQueueIndex = playQueueIndex(ctx.state.queue.length, index);
      ctx.state.selectedQueueIndex = ctx.state.activeQueueIndex;
      ctx.state.pendingAutoplay = true;
      ctx.state.transportWantsPlay = true;
      renderQueue();
    });
    root.appendChild(row);
  });
  updateQueueButtons();
  void ctx.syncPlaybackForActiveItem();
}

function updateLibraryButtons() {
  if (!ctx.els.libraryAddSelectedButton || !ctx.els.libraryUpButton) return;
  ctx.els.libraryAddSelectedButton.disabled = ctx.selectedLibraryItems().length === 0;
  ctx.els.libraryUpButton.disabled = !ctx.state.currentFolder;
}

function updateQueueButtons() {
  var hasQueue = ctx.state.queue.length > 0;
  var hasSelection = ctx.state.selectedQueueIndex >= 0 && ctx.state.selectedQueueIndex < ctx.state.queue.length;
  if (ctx.els.queuePlayButton) ctx.els.queuePlayButton.disabled = !hasSelection;
  if (ctx.els.queueRemoveButton) ctx.els.queueRemoveButton.disabled = !hasSelection;
  if (ctx.els.queueUpButton) ctx.els.queueUpButton.disabled = !hasSelection || ctx.state.selectedQueueIndex <= 0;
  if (ctx.els.queueDownButton) ctx.els.queueDownButton.disabled = !hasSelection || ctx.state.selectedQueueIndex < 0 || ctx.state.selectedQueueIndex >= ctx.state.queue.length - 1;
  if (ctx.els.queueClearButton) ctx.els.queueClearButton.disabled = !hasQueue;
}

function toggleLibrarySelection(path) {
  if (!path) return;
  if (ctx.state.selectedLibraryPaths[path]) delete ctx.state.selectedLibraryPaths[path];
  else ctx.state.selectedLibraryPaths[path] = true;
  ctx.renderLibrary();
}

function addSelectedVideos() {
  var items = ctx.selectedLibraryItems();
  if (!items.length) return;
  var result = enqueueSelected(ctx.state.queue, ctx.state.activeQueueIndex, items);
  ctx.state.queue = result.queue;
  ctx.state.activeQueueIndex = result.activeIndex;
  ctx.state.selectedQueueIndex = ctx.state.queue.length - 1;
  ctx.setStatus('Added ' + items.length + ' video' + (items.length === 1 ? '' : 's') + ' to the queue.');
  renderQueue();
}

function removeSelectedQueueItem() {
  var result = removeQueueIndex(ctx.state.queue, ctx.state.activeQueueIndex, ctx.state.selectedQueueIndex);
  ctx.state.queue = result.queue;
  ctx.state.activeQueueIndex = result.activeIndex;
  ctx.state.selectedQueueIndex = result.activeIndex;
  ctx.state.pendingAutoplay = false;
  ctx.state.transportWantsPlay = false;
  renderQueue();
}

function moveSelectedQueueItem(delta) {
  var fromIndex = ctx.state.selectedQueueIndex;
  var toIndex = fromIndex + delta;
  var result = moveQueueIndex(ctx.state.queue, ctx.state.activeQueueIndex, fromIndex, toIndex);
  ctx.state.queue = result.queue;
  ctx.state.activeQueueIndex = result.activeIndex;
  if (result.moved) ctx.state.selectedQueueIndex = toIndex;
  renderQueue();
}

function clearEntireQueue() {
  var result = clearQueue();
  ctx.state.queue = result.queue;
  ctx.state.activeQueueIndex = result.activeIndex;
  ctx.state.selectedQueueIndex = -1;
  ctx.state.pendingAutoplay = false;
  ctx.state.transportWantsPlay = false;
  renderQueue();
}

function playSelectedQueueItem() {
  ctx.state.activeQueueIndex = playQueueIndex(ctx.state.queue.length, ctx.state.selectedQueueIndex);
  if (ctx.state.activeQueueIndex >= 0) {
    ctx.state.selectedQueueIndex = ctx.state.activeQueueIndex;
    ctx.state.pendingAutoplay = true;
    ctx.state.transportWantsPlay = true;
    renderQueue();
  }
}

  ctx.renderQueue = renderQueue;
  ctx.updateLibraryButtons = updateLibraryButtons;
  ctx.updateQueueButtons = updateQueueButtons;
  ctx.toggleLibrarySelection = toggleLibrarySelection;
  ctx.addSelectedVideos = addSelectedVideos;
  ctx.removeSelectedQueueItem = removeSelectedQueueItem;
  ctx.moveSelectedQueueItem = moveSelectedQueueItem;
  ctx.clearEntireQueue = clearEntireQueue;
  ctx.playSelectedQueueItem = playSelectedQueueItem;

  if (ctx.els.libraryUpButton) {
    ctx.els.libraryUpButton.addEventListener('click', function () {
      void ctx.loadLibrary(ctx.parentFolderPath(ctx.state.currentFolder));
    });
  }
  if (ctx.els.libraryAddSelectedButton) {
    ctx.els.libraryAddSelectedButton.addEventListener('click', addSelectedVideos);
  }
  if (ctx.els.queuePlayButton) {
    ctx.els.queuePlayButton.addEventListener('click', playSelectedQueueItem);
  }
  if (ctx.els.queueRemoveButton) {
    ctx.els.queueRemoveButton.addEventListener('click', removeSelectedQueueItem);
  }
  if (ctx.els.queueUpButton) {
    ctx.els.queueUpButton.addEventListener('click', function () {
      moveSelectedQueueItem(-1);
    });
  }
  if (ctx.els.queueDownButton) {
    ctx.els.queueDownButton.addEventListener('click', function () {
      moveSelectedQueueItem(1);
    });
  }
  if (ctx.els.queueClearButton) {
    ctx.els.queueClearButton.addEventListener('click', clearEntireQueue);
  }
}