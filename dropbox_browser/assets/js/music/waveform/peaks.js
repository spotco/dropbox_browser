function clampSigned(value) {
  var number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(-1, Math.min(1, number));
}

function clampRms(value) {
  var number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function encodeSigned(value) {
  return Math.round((clampSigned(value) + 1) * 127.5);
}

function decodeSigned(value) {
  return value / 127.5 - 1;
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

export function packWaveformSummaries(summary) {
  var count;
  var bytes;
  var binary = '';
  if (!summary || !summary.min || !summary.max || !summary.rms) return '';
  count = summary.min.length;
  if (summary.max.length !== count || summary.rms.length !== count) return '';
  bytes = new Uint8Array(count * 3);
  for (var index = 0; index < count; index += 1) {
    bytes[index * 3] = encodeSigned(summary.min[index]);
    bytes[index * 3 + 1] = encodeSigned(summary.max[index]);
    bytes[index * 3 + 2] = Math.round(clampRms(summary.rms[index]) * 255);
  }
  for (var byteIndex = 0; byteIndex < bytes.length; byteIndex += 1) {
    binary += String.fromCharCode(bytes[byteIndex]);
  }
  return base64Encode(binary);
}

export function unpackWaveformSummaries(encoded) {
  var binary;
  var count;
  var summary;
  if (typeof encoded !== 'string' || !encoded) {
    return {min: new Float32Array(0), max: new Float32Array(0), rms: new Float32Array(0)};
  }
  binary = base64Decode(encoded);
  if (binary.length % 3 !== 0) throw new Error('Invalid waveform summary payload');
  count = binary.length / 3;
  summary = {
    min: new Float32Array(count),
    max: new Float32Array(count),
    rms: new Float32Array(count),
  };
  for (var index = 0; index < count; index += 1) {
    summary.min[index] = decodeSigned(binary.charCodeAt(index * 3));
    summary.max[index] = decodeSigned(binary.charCodeAt(index * 3 + 1));
    summary.rms[index] = binary.charCodeAt(index * 3 + 2) / 255;
  }
  return summary;
}

export function waveformSummaryPayloadLength(encoded) {
  return unpackWaveformSummaries(encoded).min.length;
}
