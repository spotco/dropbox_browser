import { PROBE_STORAGE_KEY } from './constants.js';

export function initCache(ctx) {
  function clearClientProbeCaches() {
    ctx.state.probeCache = Object.create(null);
    ctx.state.probeFailures = Object.create(null);
    try {
      window.sessionStorage.removeItem(PROBE_STORAGE_KEY);
    }
    catch (_error) {
      return;
    }
  }

  function clearClientSubtitleCaches() {
    ctx.state.subtitleFullVttCacheByPath = Object.create(null);
    ctx.state.subtitleWarmInFlightByPath = Object.create(null);
    ctx.state.subtitleWindowCacheByPath = Object.create(null);
    ctx.state.subtitleWindowInFlightByPath = Object.create(null);
    ctx.state.subtitleCoverageByPath = Object.create(null);
    ctx.state.subtitleBackgroundCoverageByPath = Object.create(null);
    ctx.state.subtitleMountedWindowByPath = Object.create(null);
    if (typeof ctx.clearSubtitleTrack === 'function') {
      ctx.clearSubtitleTrack();
    }
  }

  async function clearVideoCaches() {
    var button = ctx.els.clearCacheButtonEl;
    if (button) button.disabled = true;
    ctx.setStatus('Clearing video caches.');
    try {
      var response = await fetch('/video/endpoints/cache/clear', { method: 'POST' });
      if (!response.ok) throw new Error('Failed to clear server video caches.');
      clearClientProbeCaches();
      clearClientSubtitleCaches();
      var active = ctx.activeQueueItem();
      if (active) {
        ctx.renderAudioTrackSelector(active, null);
        ctx.renderSubtitleTrackSelector(active, null);
        var probePayload = await ctx.reloadProbeMetadata(active);
        if (active.path === ctx.activeItemPath()) {
          ctx.renderAudioTrackSelector(active, probePayload);
          ctx.renderSubtitleTrackSelector(active, probePayload);
        }
      } else {
        ctx.renderAudioTrackSelector(null, null);
        ctx.renderSubtitleTrackSelector(null, null);
      }
      ctx.setStatus('Video caches cleared.');
    }
    catch (_error) {
      ctx.setStatus('Failed to clear video caches.');
    }
    finally {
      if (button) button.disabled = false;
    }
  }

  ctx.clearClientProbeCaches = clearClientProbeCaches;
  ctx.clearClientSubtitleCaches = clearClientSubtitleCaches;
  ctx.clearVideoCaches = clearVideoCaches;

  if (ctx.els.clearCacheButtonEl) {
    ctx.els.clearCacheButtonEl.addEventListener('click', function () {
      void clearVideoCaches();
    });
  }
}
