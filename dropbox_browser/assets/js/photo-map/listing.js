import {buildBrowseListingEndpoint, normalizeBrowsePath} from '../browse/api.js';
import {
  PHOTO_MAP_DATE_PRESETS,
  classifyPhotoMapCandidate,
} from './config.js';

export {PHOTO_MAP_DATE_PRESETS, PHOTO_MAP_MEDIA_EXTENSIONS} from './config.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function normalizedPath(value) {
  try {
    return normalizeBrowsePath(String(value || ''));
  } catch (_error) {
    return null;
  }
}

function isDirectChildPath(rowPath, folderPath) {
  var normalizedRowPath = normalizedPath(rowPath);
  var normalizedFolderPath = normalizedPath(folderPath);
  if (normalizedRowPath === null || normalizedFolderPath === null) return false;
  var prefix = normalizedFolderPath ? normalizedFolderPath + '/' : '';
  if (prefix && normalizedRowPath.indexOf(prefix) !== 0) return false;
  var childPath = prefix ? normalizedRowPath.slice(prefix.length) : normalizedRowPath;
  return !!childPath && childPath.indexOf('/') < 0;
}

function rowDateMs(row) {
  var value = row && row.sort_date;
  if (typeof value === 'number' && Number.isFinite(value)) return value * 1000;
  if (typeof value === 'string' && value.trim()) {
    var parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function dateOnlyToUtcMs(value, endOfDay) {
  var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  var timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (!Number.isFinite(timestamp)) return null;
  return timestamp + (endOfDay ? DAY_MS - 1 : 0);
}

export function resolvePhotoMapDateBounds(range, nowMs) {
  var input = range && typeof range === 'object' ? range : {preset: range || 'all'};
  var preset = PHOTO_MAP_DATE_PRESETS[input.preset] ? input.preset : 'all';
  var now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  if (preset === 'all') return {minMs: null, maxMs: null};
  if (preset === 'custom') {
    return {
      minMs: dateOnlyToUtcMs(input.from, false),
      maxMs: dateOnlyToUtcMs(input.to, true),
    };
  }
  return {
    minMs: now - PHOTO_MAP_DATE_PRESETS[preset].days * DAY_MS,
    maxMs: now,
  };
}

export function buildPhotoMapListingEndpoint(folderPath, refresh) {
  return buildBrowseListingEndpoint({
    path: normalizedPath(folderPath) || '',
    refresh: refresh === true,
  });
}

export function selectPhotoMapCandidates(rows, folderPath, range, nowMs) {
  var bounds = resolvePhotoMapDateBounds(range, nowMs);
  var sourceRows = Array.isArray(rows) ? rows : [];
  return sourceRows
    .filter(function (row) {
      if (!row || row.kind !== 'file' || row.remote !== true) return false;
      if (!isDirectChildPath(row.path, folderPath)) return false;
      var recognition = classifyPhotoMapCandidate(row);
      // Keep configured media formats that Photo Map recognizes but cannot
      // parse yet so the result state can explain why they are absent.
      if (recognition.status !== 'supported' &&
          !(recognition.status === 'unsupported' && recognition.mediaKind)) return false;
      var dateMs = rowDateMs(row);
      if (bounds.minMs !== null && (dateMs === null || dateMs < bounds.minMs)) return false;
      if (bounds.maxMs !== null && (dateMs === null || dateMs > bounds.maxMs)) return false;
      return true;
    })
    .map(function (row) {
      var recognition = classifyPhotoMapCandidate(row);
      var dateMs = rowDateMs(row);
      return Object.assign({}, row, {
        photoMapMediaKind: recognition.mediaKind,
        photoMapRecognition: recognition,
        photoMapListingDateMs: dateMs,
        photoMapListingSize: Number.isFinite(Number(row.sort_size)) ? Number(row.sort_size) : null,
        photoMapListingModifiedTime: Number.isFinite(Number(row.sort_date)) ? Number(row.sort_date) : null,
        photoMapSourcePath: row.path,
      });
    })
    .sort(function (left, right) {
      var leftDate = left.photoMapListingDateMs === null ? -Infinity : left.photoMapListingDateMs;
      var rightDate = right.photoMapListingDateMs === null ? -Infinity : right.photoMapListingDateMs;
      if (rightDate !== leftDate) return rightDate - leftDate;
      return String(left.path || '').localeCompare(String(right.path || ''));
    });
}
