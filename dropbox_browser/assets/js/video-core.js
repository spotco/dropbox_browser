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

export function playbackDurationSeconds(mediaDuration, probePayload, playbackMode) {
  if (playbackMode === 'compatibility' && probePayload) {
    var probeDuration = Number(probePayload.duration_seconds);
    if (Number.isFinite(probeDuration) && probeDuration > 0) return probeDuration;
  }
  if (Number.isFinite(mediaDuration) && mediaDuration > 0) return mediaDuration;
  return 0;
}
