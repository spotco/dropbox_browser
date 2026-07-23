import {
  PHOTO_MAP_JPEG_HEAD_RANGE_BYTES,
  PHOTO_MAP_PARSE_STATES,
  PHOTO_MAP_QUICKTIME_HEAD_RANGE_BYTES,
  PHOTO_MAP_QUICKTIME_TAIL_RANGE_BYTES,
  classifyPhotoMapCandidate,
} from './config.js';

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array(0);
}

function decodeAscii(bytes) {
  var input = asBytes(bytes);
  var output = '';
  for (var index = 0; index < input.length; index += 1) output += String.fromCharCode(input[index]);
  return output;
}

function decodeText(bytes) {
  var input = asBytes(bytes);
  if (typeof TextDecoder === 'function') {
    try {
      return new TextDecoder('utf-8', {fatal: false}).decode(input);
    } catch (_error) {
      // Fall through to the byte-preserving decoder for malformed metadata.
    }
  }
  return decodeAscii(input);
}

function invalidResult(reason) {
  return {status: PHOTO_MAP_PARSE_STATES.error, reason: reason};
}

function noLocationResult(reason) {
  return {status: PHOTO_MAP_PARSE_STATES.noLocation, reason: reason};
}

function locatedResult(latitude, longitude, captureDate, captureDateMs) {
  return {
    status: PHOTO_MAP_PARSE_STATES.located,
    latitude: latitude,
    longitude: longitude,
    captureDate: captureDate || null,
    captureDateMs: Number.isFinite(captureDateMs) ? captureDateMs : null,
  };
}

function validCoordinate(latitude, longitude) {
  return Number.isFinite(latitude) && Number.isFinite(longitude) &&
    latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
}

function parseExifDate(value) {
  var match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(value || '').trim());
  if (!match) return null;
  var timestamp = Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6]),
  );
  return Number.isFinite(timestamp) ? timestamp : null;
}

function readTiffValue(view, tiffStart, entryOffset, type, count, littleEndian) {
  var sizes = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8};
  var size = sizes[type];
  if (!size || count < 0 || count > 0x7fffffff) return null;
  var total = size * count;
  if (!Number.isSafeInteger(total)) return null;
  var valueOffset = total <= 4
    ? entryOffset + 8
    : tiffStart + view.getUint32(entryOffset + 8, littleEndian);
  if (valueOffset < 0 || valueOffset + total > view.byteLength) return null;
  return {offset: valueOffset, size: size, count: count, type: type};
}

function readTiffAscii(view, descriptor) {
  if (!descriptor || descriptor.type !== 2) return null;
  var bytes = new Uint8Array(view.buffer, view.byteOffset + descriptor.offset, descriptor.count);
  return decodeAscii(bytes).replace(/\0+$/, '').trim();
}

function readTiffNumber(view, descriptor, index, littleEndian) {
  if (!descriptor || index < 0 || index >= descriptor.count) return null;
  var offset = descriptor.offset + descriptor.size * index;
  if (descriptor.type === 3) return view.getUint16(offset, littleEndian);
  if (descriptor.type === 4) return view.getUint32(offset, littleEndian);
  if (descriptor.type === 5) {
    var numerator = view.getUint32(offset, littleEndian);
    var denominator = view.getUint32(offset + 4, littleEndian);
    return denominator ? numerator / denominator : null;
  }
  if (descriptor.type === 9) return view.getInt32(offset, littleEndian);
  if (descriptor.type === 10) {
    var signedNumerator = view.getInt32(offset, littleEndian);
    var signedDenominator = view.getInt32(offset + 4, littleEndian);
    return signedDenominator ? signedNumerator / signedDenominator : null;
  }
  return null;
}

function readTiffIfd(view, tiffStart, ifdOffset, littleEndian) {
  var offset = tiffStart + ifdOffset;
  if (offset < 0 || offset + 2 > view.byteLength) return null;
  var count = view.getUint16(offset, littleEndian);
  var entries = [];
  var entryStart = offset + 2;
  if (entryStart + count * 12 + 4 > view.byteLength) return null;
  for (var index = 0; index < count; index += 1) {
    var entryOffset = entryStart + index * 12;
    var tag = view.getUint16(entryOffset, littleEndian);
    var type = view.getUint16(entryOffset + 2, littleEndian);
    var valueCount = view.getUint32(entryOffset + 4, littleEndian);
    var descriptor = readTiffValue(view, tiffStart, entryOffset, type, valueCount, littleEndian);
    if (!descriptor) return null;
    entries.push({tag: tag, descriptor: descriptor});
  }
  return entries;
}

function findTiffEntry(entries, tag) {
  return (entries || []).find(function (entry) { return entry.tag === tag; }) || null;
}

function parseTiffGps(bytes, tiffStart) {
  var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (tiffStart + 8 > view.byteLength) return invalidResult('malformed-tiff-header');
  var byteOrder = decodeAscii(new Uint8Array(view.buffer, view.byteOffset + tiffStart, 2));
  if (byteOrder !== 'II' && byteOrder !== 'MM') return invalidResult('unsupported-tiff-byte-order');
  var littleEndian = byteOrder === 'II';
  if (view.getUint16(tiffStart + 2, littleEndian) !== 42) return invalidResult('malformed-tiff-magic');
  var ifdOffset = view.getUint32(tiffStart + 4, littleEndian);
  var ifd = readTiffIfd(view, tiffStart, ifdOffset, littleEndian);
  if (!ifd) return invalidResult('malformed-tiff-ifd');

  var captureDate = null;
  var dateEntry = findTiffEntry(ifd, 0x0132);
  if (dateEntry) captureDate = readTiffAscii(view, dateEntry.descriptor);
  var exifPointer = findTiffEntry(ifd, 0x8769);
  if (exifPointer) {
    var exifOffset = readTiffNumber(view, exifPointer.descriptor, 0, littleEndian);
    var exifIfd = exifOffset === null ? null : readTiffIfd(view, tiffStart, exifOffset, littleEndian);
    if (exifIfd) {
      var originalDateEntry = findTiffEntry(exifIfd, 0x9003);
      if (originalDateEntry) captureDate = readTiffAscii(view, originalDateEntry.descriptor) || captureDate;
    }
  }

  var gpsPointer = findTiffEntry(ifd, 0x8825);
  if (!gpsPointer) return noLocationResult('no-gps-ifd');
  var gpsOffset = readTiffNumber(view, gpsPointer.descriptor, 0, littleEndian);
  var gpsIfd = gpsOffset === null ? null : readTiffIfd(view, tiffStart, gpsOffset, littleEndian);
  if (!gpsIfd) return invalidResult('malformed-gps-ifd');
  var latitudeRefEntry = findTiffEntry(gpsIfd, 1);
  var latitudeEntry = findTiffEntry(gpsIfd, 2);
  var longitudeRefEntry = findTiffEntry(gpsIfd, 3);
  var longitudeEntry = findTiffEntry(gpsIfd, 4);
  if (!latitudeRefEntry || !latitudeEntry || !longitudeRefEntry || !longitudeEntry) {
    return noLocationResult('incomplete-gps');
  }
  var latitudeRefValue = readTiffAscii(view, latitudeRefEntry.descriptor);
  var longitudeRefValue = readTiffAscii(view, longitudeRefEntry.descriptor);
  if (!latitudeRefValue || !longitudeRefValue) return invalidResult('malformed-gps-ref');
  var latitudeRef = latitudeRefValue.toUpperCase();
  var longitudeRef = longitudeRefValue.toUpperCase();
  var latitude = readTiffNumber(view, latitudeEntry.descriptor, 0, littleEndian);
  var latitudeMinutes = readTiffNumber(view, latitudeEntry.descriptor, 1, littleEndian);
  var latitudeSeconds = readTiffNumber(view, latitudeEntry.descriptor, 2, littleEndian);
  var longitude = readTiffNumber(view, longitudeEntry.descriptor, 0, littleEndian);
  var longitudeMinutes = readTiffNumber(view, longitudeEntry.descriptor, 1, littleEndian);
  var longitudeSeconds = readTiffNumber(view, longitudeEntry.descriptor, 2, littleEndian);
  if ([latitude, latitudeMinutes, latitudeSeconds, longitude, longitudeMinutes, longitudeSeconds]
    .some(function (value) { return !Number.isFinite(value); })) {
    return invalidResult('malformed-gps-rational');
  }
  latitude = latitude + latitudeMinutes / 60 + latitudeSeconds / 3600;
  longitude = longitude + longitudeMinutes / 60 + longitudeSeconds / 3600;
  if (latitudeRef === 'S') latitude = -latitude;
  else if (latitudeRef !== 'N') return invalidResult('invalid-latitude-ref');
  if (longitudeRef === 'W') longitude = -longitude;
  else if (longitudeRef !== 'E') return invalidResult('invalid-longitude-ref');
  if (!validCoordinate(latitude, longitude)) return invalidResult('coordinate-out-of-range');
  return locatedResult(latitude, longitude, captureDate, parseExifDate(captureDate));
}

export function parseJpegExifGps(input) {
  var bytes = asBytes(input);
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return invalidResult('not-jpeg');
  var offset = 2;
  var sawExif = false;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) break;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    var marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > bytes.length) return invalidResult('truncated-jpeg-segment');
    var segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return invalidResult('truncated-jpeg-segment');
    var payloadStart = offset + 2;
    if (marker === 0xe1 && segmentLength >= 8 &&
        decodeAscii(bytes.slice(payloadStart, payloadStart + 6)) === 'Exif\0\0') {
      sawExif = true;
      var parsed = parseTiffGps(bytes, payloadStart + 6);
      if (parsed.status !== PHOTO_MAP_PARSE_STATES.noLocation) return parsed;
      if (parsed.reason !== 'no-gps-ifd') return parsed;
    }
    offset += segmentLength;
  }
  return sawExif ? noLocationResult('no-gps') : noLocationResult('no-exif');
}

function atomType(bytes, offset) {
  return decodeAscii(bytes.slice(offset + 4, offset + 8));
}

function atomSize(bytes, offset, limit) {
  if (offset + 8 > limit) return null;
  var size = readUint32(bytes, offset);
  if (size === 1) {
    if (offset + 16 > limit) return null;
    var large = readUint64Safe(bytes, offset + 8);
    if (large === null || large > Number.MAX_SAFE_INTEGER) return null;
    return {size: large, header: 16};
  }
  if (size === 0) return {size: limit - offset, header: 8};
  return {size: size, header: 8};
}

function readUint32(bytes, offset) {
  return bytes[offset] * 0x1000000 + bytes[offset + 1] * 0x10000 + bytes[offset + 2] * 0x100 + bytes[offset + 3];
}

function readUint64Safe(bytes, offset) {
  var high = readUint32(bytes, offset);
  var low = readUint32(bytes, offset + 4);
  var value = high * 0x100000000 + low;
  return Number.isSafeInteger(value) ? value : null;
}

var QUICKTIME_CONTAINERS = Object.freeze({
  moov: true, udta: true, meta: true, ilst: true, trak: true, mdia: true,
  minf: true, stbl: true, dinf: true, edts: true, moof: true, traf: true,
  mvex: true, mfra: true, skip: true, free: true,
});

function collectAtomText(bytes, start, limit, output, depth) {
  if (depth > 12) return;
  var offset = start;
  while (offset + 8 <= limit) {
    var sizeInfo = atomSize(bytes, offset, limit);
    if (!sizeInfo || sizeInfo.size < sizeInfo.header || offset + sizeInfo.size > limit) return;
    var end = offset + sizeInfo.size;
    var type = atomType(bytes, offset);
    var contentStart = offset + sizeInfo.header;
    if (type === 'meta') contentStart += 4; // version and flags precede meta children.
    if (type === 'data') {
      output.push(decodeText(bytes.slice(Math.min(contentStart + 8, end), end)));
    } else if (QUICKTIME_CONTAINERS[type] || type === '©xyz') {
      collectAtomText(bytes, Math.min(contentStart, end), end, output, depth + 1);
    }
    offset = end;
  }
}

function parseIso6709(text) {
  var pattern = /([+-])(\d{1,3}(?:\.\d+)?)([+-])(\d{1,3}(?:\.\d+)?)(?:[+-](\d{1,3}(?:\.\d+)?))?(?:\/|(?=\0|\s|$))/g;
  var match;
  while ((match = pattern.exec(String(text || ''))) !== null) {
    var latitude = (match[1] === '-' ? -1 : 1) * Number(match[2]);
    var longitude = (match[3] === '-' ? -1 : 1) * Number(match[4]);
    if (validCoordinate(latitude, longitude)) return {latitude: latitude, longitude: longitude};
  }
  return null;
}

function quickTimeCaptureDate(text) {
  var match = String(text || '').match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/);
  if (!match) return {value: null, timestamp: null};
  var timestamp = Date.parse(match[0]);
  return {value: match[0], timestamp: Number.isFinite(timestamp) ? timestamp : null};
}

function quickTimeSegments(input) {
  if (input && Array.isArray(input.ranges)) return input.ranges;
  return [{bytes: asBytes(input), offset: 0}];
}

export function parseQuickTimeLocation(input) {
  var segments = quickTimeSegments(input);
  var textParts = [];
  segments.forEach(function (segment) {
    var bytes = asBytes(segment && segment.bytes !== undefined ? segment.bytes : segment);
    if (bytes.length === 0) return;
    collectAtomText(bytes, 0, bytes.length, textParts, 0);
    // A tail range can begin inside an atom. Keep the fallback bounded to the
    // returned range rather than attempting to reconstruct the whole movie.
    textParts.push(decodeText(bytes));
  });
  var combined = textParts.join('\n');
  var location = parseIso6709(combined);
  if (!location) return noLocationResult('no-quicktime-location');
  var captureDate = quickTimeCaptureDate(combined);
  return locatedResult(location.latitude, location.longitude, captureDate.value, captureDate.timestamp);
}

function parseContentRange(value) {
  var match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(String(value || ''));
  if (!match) return null;
  return {start: Number(match[1]), end: Number(match[2]), size: match[3] === '*' ? null : Number(match[3])};
}

export function buildPhotoMapFileUrl(sourcePath) {
  var params = new URLSearchParams();
  params.set('path', String(sourcePath || ''));
  params.set('source', 'remote');
  return '/file?' + params.toString();
}

export async function readPhotoMapRange(fetchImpl, sourcePath, range, signal) {
  var start = Number.isInteger(range && range.start) ? range.start : 0;
  var count = Number.isInteger(range && range.count) ? range.count : 0;
  if (count <= 0 || start < 0) throw new Error('Invalid Photo Map byte range.');
  var end = start + count - 1;
  var rangeHeader = range && range.suffix ? 'bytes=-' + String(count) : 'bytes=' + String(start) + '-' + String(end);
  var response = await fetchImpl(buildPhotoMapFileUrl(sourcePath), {
    headers: {Range: rangeHeader},
    signal: signal,
  });
  if (!response || !response.ok) throw new Error('Photo Map range request failed.');
  var bytes = new Uint8Array(await response.arrayBuffer());
  var contentRange = parseContentRange(response.headers && response.headers.get
    ? response.headers.get('Content-Range')
    : '');
  var actualStart = contentRange ? contentRange.start : (range && range.suffix ? 0 : start);
  return {
    bytes: bytes,
    start: actualStart,
    end: actualStart + Math.max(bytes.length - 1, 0),
    fileSize: contentRange ? contentRange.size : null,
  };
}

function itemBaseResult(item) {
  var sourcePath = String((item && (item.photoMapSourcePath || item.path)) || '');
  return {
    path: sourcePath,
    sourcePath: sourcePath,
    mediaKind: item && item.photoMapMediaKind ? item.photoMapMediaKind : null,
    listingDateMs: item && Number.isFinite(item.photoMapListingDateMs) ? item.photoMapListingDateMs : null,
    listingSize: item && Number.isFinite(item.photoMapListingSize) ? item.photoMapListingSize : null,
    listingModifiedTime: item && Number.isFinite(item.photoMapListingModifiedTime)
      ? item.photoMapListingModifiedTime
      : null,
    captureDate: null,
    captureDateMs: null,
    latitude: null,
    longitude: null,
  };
}

export async function readPhotoMapItemMetadata(item, options) {
  var config = options || {};
  var recognition = item && item.photoMapRecognition
    ? item.photoMapRecognition
    : classifyPhotoMapCandidate(item);
  var base = itemBaseResult(item);
  if (!recognition || recognition.status !== 'supported') {
    return Object.assign(base, {status: PHOTO_MAP_PARSE_STATES.unsupported, reason: 'format-not-supported'});
  }
  try {
    var parsed;
    if (recognition.parser === 'jpeg-exif-gps') {
      var jpegRange = await readPhotoMapRange(
        config.fetchImpl,
        base.sourcePath,
        {start: 0, count: PHOTO_MAP_JPEG_HEAD_RANGE_BYTES},
        config.signal,
      );
      parsed = parseJpegExifGps(jpegRange.bytes);
    } else if (recognition.parser === 'quicktime-location') {
      var ranges = await Promise.all([
        readPhotoMapRange(config.fetchImpl, base.sourcePath, {
          start: 0,
          count: PHOTO_MAP_QUICKTIME_HEAD_RANGE_BYTES,
        }, config.signal),
        readPhotoMapRange(config.fetchImpl, base.sourcePath, {
          count: PHOTO_MAP_QUICKTIME_TAIL_RANGE_BYTES,
          suffix: true,
        }, config.signal),
      ]);
      parsed = parseQuickTimeLocation({ranges: ranges});
    } else {
      parsed = {status: PHOTO_MAP_PARSE_STATES.unsupported, reason: 'parser-not-configured'};
    }
    return Object.assign(base, parsed);
  } catch (error) {
    return Object.assign(base, {
      status: PHOTO_MAP_PARSE_STATES.error,
      reason: error && error.name === 'AbortError' ? 'aborted' : 'range-or-parser-failure',
    });
  }
}
