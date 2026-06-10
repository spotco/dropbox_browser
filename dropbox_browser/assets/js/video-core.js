export function appendQueueItems(queue, items) {
  return queue.concat(items.map(function (item) {
    return Object.assign({}, item);
  }));
}

export function enqueueAndPlay(queue, activeIndex, item) {
  const nextQueue = appendQueueItems(queue, [item]);
  return { queue: nextQueue, activeIndex: nextQueue.length - 1 };
}

export function enqueueSelected(queue, activeIndex, items) {
  const nextQueue = appendQueueItems(queue, items);
  return { queue: nextQueue, activeIndex };
}

export function removeQueueIndex(queue, activeIndex, removeIndex) {
  if (removeIndex < 0 || removeIndex >= queue.length) return { queue, activeIndex };
  const nextQueue = queue.slice(0, removeIndex).concat(queue.slice(removeIndex + 1));
  if (nextQueue.length === 0) return { queue: nextQueue, activeIndex: -1 };
  if (activeIndex === removeIndex) {
    return { queue: nextQueue, activeIndex: Math.min(removeIndex, nextQueue.length - 1) };
  }
  if (activeIndex > removeIndex) {
    return { queue: nextQueue, activeIndex: activeIndex - 1 };
  }
  return { queue: nextQueue, activeIndex };
}

export function clearQueue() {
  return { queue: [], activeIndex: -1 };
}

export function moveQueueIndex(queue, activeIndex, fromIndex, toIndex) {
  if (fromIndex < 0 || fromIndex >= queue.length) return { queue, activeIndex, moved: false };
  if (toIndex < 0 || toIndex >= queue.length) return { queue, activeIndex, moved: false };
  if (fromIndex === toIndex) return { queue, activeIndex, moved: false };
  const nextQueue = queue.slice();
  const [item] = nextQueue.splice(fromIndex, 1);
  nextQueue.splice(toIndex, 0, item);
  let nextActiveIndex = activeIndex;
  if (activeIndex === fromIndex) {
    nextActiveIndex = toIndex;
  }
  else if (fromIndex < activeIndex && toIndex >= activeIndex) {
    nextActiveIndex -= 1;
  }
  else if (fromIndex > activeIndex && toIndex <= activeIndex) {
    nextActiveIndex += 1;
  }
  return { queue: nextQueue, activeIndex: nextActiveIndex, moved: true };
}

export function playQueueIndex(queueLength, index) {
  if (index < 0 || index >= queueLength) return -1;
  return index;
}

export function advanceQueueAfterPlaybackEnd(queueLength, activeIndex) {
  if (queueLength <= 0) return -1;
  if (activeIndex < 0) return queueLength > 0 ? 0 : -1;
  const nextIndex = activeIndex + 1;
  return nextIndex < queueLength ? nextIndex : -1;
}

export function nativePlaybackUrl(item) {
  if (!item || !item.stream_path) return '';
  return '/file?path=' + encodeURIComponent(item.stream_path) + '&source=remote';
}

export function shouldPreferCompatibilityPlayback(item) {
  if (!item) return false;
  if (item.compatibility_expected) return true;
  const extension = typeof item.extension === 'string' ? item.extension.toLowerCase() : '';
  return extension === '.mkv';
}

export function canAttemptNativePlayback(item, canPlayTypeFn) {
  if (!item) return false;
  if (shouldPreferCompatibilityPlayback(item)) return false;
  if (typeof canPlayTypeFn !== 'function') return true;
  const extension = typeof item.extension === 'string' ? item.extension.toLowerCase() : '';
  const mime = ({
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
  })[extension];
  if (!mime) return true;
  const result = canPlayTypeFn(mime);
  return result === 'probably' || result === 'maybe';
}

export function playbackDecisionForItem(item, canPlayTypeFn) {
  if (!item) {
    return { mode: 'none', url: '', status: 'No video selected.' };
  }
  if (shouldPreferCompatibilityPlayback(item)) {
    return {
      mode: 'compatibility-needed',
      url: '',
      status: 'Compatibility playback will be required for this format.',
    };
  }
  if (canAttemptNativePlayback(item, canPlayTypeFn)) {
    return {
      mode: 'native',
      url: nativePlaybackUrl(item),
      status: 'Native playback is ready.',
    };
  }
  return {
    mode: 'native-unavailable',
    url: '',
    status: 'This format is not expected to play natively in the browser.',
  };
}
