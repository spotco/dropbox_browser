// Progressive sampling intentionally favors a useful silhouette quickly over
// an exact high-resolution reduction. The final round is capped at 1024 points.
export const WAVEFORM_MIN_RESOLUTION = 64;
export const WAVEFORM_MAX_RESOLUTION = 1024;
export const WAVEFORM_FINAL_RESOLUTION = 1024;
export const WAVEFORM_SAMPLE_ROUNDS = [64, 256, 1024];

function nextPowerOfTwo(value) {
  var result = 1;
  while (result < value && result < WAVEFORM_MAX_RESOLUTION) result *= 2;
  return result;
}

export function chooseWaveformResolution(cssWidth, devicePixelRatio, maxResolution) {
  var width = Number(cssWidth);
  var dpr = Number(devicePixelRatio);
  var maximum = Number(maxResolution);
  var target;
  if (!Number.isFinite(width) || width <= 0) return WAVEFORM_MIN_RESOLUTION;
  if (!Number.isFinite(dpr) || dpr <= 0) dpr = 1;
  if (!Number.isFinite(maximum)) maximum = WAVEFORM_MAX_RESOLUTION;
  maximum = Math.max(WAVEFORM_MIN_RESOLUTION, Math.min(WAVEFORM_MAX_RESOLUTION, Math.floor(maximum)));
  target = Math.min(maximum, Math.max(WAVEFORM_FINAL_RESOLUTION, Math.ceil(width * dpr)));
  return Math.min(maximum, nextPowerOfTwo(target));
}

export function waveformResolutionStages(targetResolution, maxResolution) {
  var target = Number(targetResolution);
  var maximum = Number(maxResolution);
  var stages;
  if (!Number.isFinite(target) || target <= 0) target = WAVEFORM_MIN_RESOLUTION;
  if (!Number.isFinite(maximum)) maximum = WAVEFORM_MAX_RESOLUTION;
  maximum = Math.max(WAVEFORM_MIN_RESOLUTION, Math.min(WAVEFORM_MAX_RESOLUTION, Math.floor(maximum)));
  target = Math.max(WAVEFORM_MIN_RESOLUTION, Math.min(maximum, Math.floor(target)));
  stages = WAVEFORM_SAMPLE_ROUNDS.filter(function (resolution) {
    return resolution <= target && resolution <= maximum;
  });
  return stages.length ? stages : [WAVEFORM_MIN_RESOLUTION];
}
