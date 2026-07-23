import {
  PHOTO_MAP_CACHE_BATCH_LIMIT,
} from './config.js';

export function buildPhotoMapCacheEndpoint(folderPath) {
  var params = new URLSearchParams();
  params.set('path', String(folderPath || ''));
  return '/photo-map/endpoints/cache?' + params.toString();
}

async function readJsonResponse(response, fallbackMessage) {
  if (!response || !response.ok) throw new Error(fallbackMessage);
  var payload = await response.json();
  if (!payload || payload.status !== 'ok') throw new Error(fallbackMessage);
  return payload;
}

export async function readPhotoMapCache(fetchImpl, folderPath, signal) {
  var response = await fetchImpl(buildPhotoMapCacheEndpoint(folderPath), {signal: signal});
  var payload = await readJsonResponse(response, 'Could not read Photo Map cache.');
  if (!Array.isArray(payload.entries)) throw new Error('Photo Map cache response is invalid.');
  return payload.entries.slice();
}

export async function writePhotoMapCache(fetchImpl, folderPath, entries, signal) {
  if (!Array.isArray(entries) || entries.length === 0) return {status: 'ok', written: 0};
  if (entries.length > PHOTO_MAP_CACHE_BATCH_LIMIT) {
    throw new Error('Photo Map cache batch is too large.');
  }
  var response = await fetchImpl('/photo-map/endpoints/cache', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({path: String(folderPath || ''), entries: entries}),
    signal: signal,
  });
  return readJsonResponse(response, 'Could not write Photo Map cache.');
}

export function photoMapCacheRecordForResult(item, result) {
  var sourcePath = String((result && (result.sourcePath || result.path)) || (item && item.path) || '');
  return {
    path: sourcePath,
    source_path: sourcePath,
    size: result && Number.isFinite(result.listingSize)
      ? result.listingSize
      : (item && Number.isFinite(item.photoMapListingSize) ? item.photoMapListingSize : null),
    modified_time: result && Number.isFinite(result.listingModifiedTime)
      ? result.listingModifiedTime
      : (item && Number.isFinite(item.photoMapListingModifiedTime) ? item.photoMapListingModifiedTime : null),
    status: String((result && result.status) || 'error'),
    media_kind: (result && result.mediaKind) || (item && item.photoMapMediaKind) || null,
    latitude: result && Number.isFinite(result.latitude) ? result.latitude : null,
    longitude: result && Number.isFinite(result.longitude) ? result.longitude : null,
    capture_date: (result && result.captureDate) || null,
    capture_date_ms: result && Number.isFinite(result.captureDateMs) ? result.captureDateMs : null,
    listing_date_ms: result && Number.isFinite(result.listingDateMs)
      ? result.listingDateMs
      : (item && Number.isFinite(item.photoMapListingDateMs) ? item.photoMapListingDateMs : null),
    reason: (result && result.reason) || null,
  };
}

function sameIdentity(item, record) {
  if (!item || !record || String(record.path || '') !== String(item.photoMapSourcePath || item.path || '')) {
    return false;
  }
  var itemSize = Number.isFinite(item.photoMapListingSize) ? item.photoMapListingSize : null;
  var recordSize = Number.isFinite(record.size) ? record.size : null;
  var itemModified = Number.isFinite(item.photoMapListingModifiedTime) ? item.photoMapListingModifiedTime : null;
  var recordModified = Number.isFinite(record.modified_time) ? record.modified_time : null;
  return itemSize === recordSize && itemModified === recordModified;
}

function cachedResultForItem(item, record) {
  return {
    path: String(item.photoMapSourcePath || item.path || ''),
    sourcePath: String(item.photoMapSourcePath || item.path || ''),
    mediaKind: record.media_kind || item.photoMapMediaKind || null,
    listingDateMs: Number.isFinite(record.listing_date_ms)
      ? record.listing_date_ms
      : (Number.isFinite(item.photoMapListingDateMs) ? item.photoMapListingDateMs : null),
    listingSize: item.photoMapListingSize,
    listingModifiedTime: item.photoMapListingModifiedTime,
    captureDate: record.capture_date || null,
    captureDateMs: Number.isFinite(record.capture_date_ms) ? record.capture_date_ms : null,
    latitude: Number.isFinite(record.latitude) ? record.latitude : null,
    longitude: Number.isFinite(record.longitude) ? record.longitude : null,
    status: record.status,
    reason: record.reason || null,
    cached: true,
  };
}

export function mergePhotoMapCacheCandidates(candidates, entries) {
  var records = Array.isArray(entries) ? entries : [];
  var cached = [];
  var pending = [];
  (Array.isArray(candidates) ? candidates : []).forEach(function (item) {
    var record = records.find(function (candidate) { return sameIdentity(item, candidate); });
    if (record) cached.push({item: item, result: cachedResultForItem(item, record)});
    else pending.push(item);
  });
  return {cached: cached, pending: pending};
}
