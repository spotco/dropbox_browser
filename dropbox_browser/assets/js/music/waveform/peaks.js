function clampPeak(value) {
  var number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function base64Encode(binary) {
  if (typeof btoa === 'function') return btoa(binary);
  if (typeof Buffer !== 'undefined') return Buffer.from(binary, 'binary').toString('base64');
  throw new Error('Base64 encoding is unavailable');
}

function base64Decode(encoded) {
  if (typeof atob === 'function') return atob(encoded);
  if (typeof Buffer !== 'undefined') return Buffer.from(encoded, 'base64').toString('binary');
  throw new Error('Base64 decoding is unavailable');
}

export function packWaveformPeaks(peaks) {
  var bytes;
  var binary = '';
  if (!peaks || typeof peaks.length !== 'number') return '';
  bytes = new Uint8Array(peaks.length);
  for (var index = 0; index < peaks.length; index += 1) {
    bytes[index] = Math.round(clampPeak(peaks[index]) * 255);
    binary += String.fromCharCode(bytes[index]);
  }
  return base64Encode(binary);
}

export function unpackWaveformPeaks(encoded) {
  var binary;
  var peaks;
  if (typeof encoded !== 'string' || !encoded) return new Float32Array(0);
  binary = base64Decode(encoded);
  peaks = new Float32Array(binary.length);
  for (var index = 0; index < binary.length; index += 1) {
    peaks[index] = binary.charCodeAt(index) / 255;
  }
  return peaks;
}

export function waveformPeakPayloadLength(encoded) {
  return unpackWaveformPeaks(encoded).length;
}
