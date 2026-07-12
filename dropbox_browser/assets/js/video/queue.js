/**
 * Legacy video queue UI — retired in Phase 5.
 * Active playlist is owned by media-library/playlist.js; queue[] is mirrored
 * from the playlist by video/media-library-bridge.js for playback modules.
 * Kept as a no-op so old import paths do not hard-fail if referenced.
 */
export function initQueue(_ctx) {
  // no-op
}
