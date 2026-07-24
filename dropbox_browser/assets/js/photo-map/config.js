// Photo Map recognition and queue defaults. Keep format decisions and byte
// budgets in one place so the range parsers and browser queues can tune them
// without changing listing or UI code.
export const PHOTO_MAP_JPEG_EXTENSIONS = Object.freeze(['.jpg', '.jpeg']);
export const PHOTO_MAP_VIDEO_EXTENSIONS = Object.freeze(['.mov', '.mp4']);
export const PHOTO_MAP_UNSUPPORTED_EXTENSIONS = Object.freeze([
  '.png',
  '.heic',
]);

export const PHOTO_MAP_MEDIA_EXTENSIONS = Object.freeze({
  '.jpg': 'photo',
  '.jpeg': 'photo',
  '.mov': 'video',
  '.mp4': 'video',
});

export const PHOTO_MAP_DATE_PRESETS = Object.freeze({
  all: Object.freeze({label: 'All time', usesFromTo: false}),
  '90-days': Object.freeze({label: 'Last 90 days', days: 90, usesFromTo: false}),
  '1-year': Object.freeze({label: 'Last year', days: 365, usesFromTo: false}),
  custom: Object.freeze({label: 'Custom range', usesFromTo: true}),
});

// Date-input defaults make an untouched custom range equivalent to all dates
// through today while remaining valid for the browser's date input control.
export const PHOTO_MAP_DEFAULT_FROM_DATE = '1900-01-01';

// JPEG EXIF is normally near the beginning of the file. This bounded first
// range is intentionally large enough for common camera metadata without
// downloading a whole photo.
export const PHOTO_MAP_JPEG_HEAD_RANGE_BYTES = 256 * 1024;
// iPhone QuickTime location atoms may be in either the head or tail. The
// parser may request each bounded range, never an unbounded media download.
export const PHOTO_MAP_QUICKTIME_HEAD_RANGE_BYTES = 1024 * 1024;
export const PHOTO_MAP_QUICKTIME_TAIL_RANGE_BYTES = 1024 * 1024;
// Conservative defaults for independent metadata and visible-thumbnail work.
export const PHOTO_MAP_METADATA_CONCURRENCY = 3;
export const PHOTO_MAP_THUMBNAIL_CONCURRENCY = 2;
export const PHOTO_MAP_CACHE_BATCH_LIMIT = 200;

export const PHOTO_MAP_PARSE_STATES = Object.freeze({
  located: 'located',
  noLocation: 'no-location',
  unsupported: 'unsupported',
  error: 'error',
});

export const PHOTO_MAP_CONFIG = Object.freeze({
  jpegExtensions: PHOTO_MAP_JPEG_EXTENSIONS,
  videoExtensions: PHOTO_MAP_VIDEO_EXTENSIONS,
  unsupportedExtensions: PHOTO_MAP_UNSUPPORTED_EXTENSIONS,
  datePresets: PHOTO_MAP_DATE_PRESETS,
  ranges: Object.freeze({
    jpegHeadBytes: PHOTO_MAP_JPEG_HEAD_RANGE_BYTES,
    quicktimeHeadBytes: PHOTO_MAP_QUICKTIME_HEAD_RANGE_BYTES,
    quicktimeTailBytes: PHOTO_MAP_QUICKTIME_TAIL_RANGE_BYTES,
  }),
  concurrency: Object.freeze({
    metadata: PHOTO_MAP_METADATA_CONCURRENCY,
    thumbnails: PHOTO_MAP_THUMBNAIL_CONCURRENCY,
  }),
  cacheBatchLimit: PHOTO_MAP_CACHE_BATCH_LIMIT,
});

function extensionForRow(row) {
  var value = String((row && (row.display_name || row.path)) || '');
  var dot = value.lastIndexOf('.');
  return dot >= 0 ? value.slice(dot).toLowerCase() : '';
}

export function classifyPhotoMapCandidate(row) {
  var extension = extensionForRow(row);
  if (Object.prototype.hasOwnProperty.call(PHOTO_MAP_MEDIA_EXTENSIONS, extension)) {
    return {
      status: 'supported',
      extension: extension,
      mediaKind: PHOTO_MAP_MEDIA_EXTENSIONS[extension],
      parser: extension === '.jpg' || extension === '.jpeg'
        ? 'jpeg-exif-gps'
        : 'quicktime-location',
    };
  }
  if (PHOTO_MAP_UNSUPPORTED_EXTENSIONS.indexOf(extension) >= 0) {
    return {
      status: 'unsupported',
      extension: extension,
      mediaKind: 'photo',
      parser: null,
      reason: 'format-not-supported',
    };
  }
  return {
    status: 'unsupported',
    extension: extension,
    mediaKind: null,
    parser: null,
    reason: 'format-not-supported',
  };
}
