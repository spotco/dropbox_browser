export function clampWaveformFraction(value) {
  var fraction = Number(value);
  if (!Number.isFinite(fraction)) return 0;
  return Math.max(0, Math.min(1, fraction));
}

export function pointerPositionToPlaybackTime(clientX, rect, duration) {
  var left;
  var width;
  var trackDuration = Number(duration);
  if (!rect || !Number.isFinite(Number(rect.left)) || !Number.isFinite(Number(rect.width))) return null;
  if (!Number.isFinite(trackDuration) || trackDuration < 0) return null;
  left = Number(rect.left);
  width = Number(rect.width);
  if (width <= 0) return null;
  return clampWaveformFraction((Number(clientX) - left) / width) * trackDuration;
}
