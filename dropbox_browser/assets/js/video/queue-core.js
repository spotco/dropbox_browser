/** Pure linear playlist navigation helpers (fallback / button-disable math).
 * Membership mutations and reorder live in media-library/playlist-store.js.
 * Shuffle-aware next/prev is owned by music/shuffle-helpers.js via
 * video/media-library-bridge.js.
 */

export function playQueueIndex(queueLength, index) {
  if (index < 0 || index >= queueLength) return -1;
  return index;
}

export function advanceQueueAfterPlaybackEnd(queueLength, activeIndex, loopEnabled = false) {
  if (queueLength <= 0) return -1;
  if (activeIndex < 0) return queueLength > 0 ? 0 : -1;
  const nextIndex = activeIndex + 1;
  if (nextIndex < queueLength) return nextIndex;
  return loopEnabled ? 0 : -1;
}

export function previousQueueIndex(queueLength, activeIndex, loopEnabled = false) {
  if (queueLength <= 0) return -1;
  if (activeIndex < 0 || activeIndex >= queueLength) return -1;
  if (activeIndex > 0) return activeIndex - 1;
  return loopEnabled ? queueLength - 1 : -1;
}

export function nextQueueIndex(queueLength, activeIndex, loopEnabled = false) {
  if (queueLength <= 0) return -1;
  if (activeIndex < 0 || activeIndex >= queueLength) return -1;
  const nextIndex = activeIndex + 1;
  if (nextIndex < queueLength) return nextIndex;
  return loopEnabled ? 0 : -1;
}
