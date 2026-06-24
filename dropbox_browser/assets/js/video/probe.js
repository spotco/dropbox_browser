import {
  PROBE_STORAGE_KEY,
  PROBE_STORAGE_MAX_BYTES,
  PROBE_STORAGE_TTL_MS,
} from './constants.js';

export function initProbe(ctx) {
function probeStorageEntrySize(path, entry) {
  if (!entry || !entry.payload) return path.length + 32;
  return path.length + JSON.stringify(entry.payload).length + 32;
}

function readProbeStorageIndex() {
  try {
    var raw = sessionStorage.getItem(PROBE_STORAGE_KEY);
    if (!raw) return {entries: Object.create(null), totalBytes: 0};
    var parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.entries || typeof parsed.entries !== 'object') {
      return {entries: Object.create(null), totalBytes: 0};
    }
    return parsed;
  }
  catch (_error) {
    return {entries: Object.create(null), totalBytes: 0};
  }
}

function writeProbeStorageIndex(index) {
  try {
    sessionStorage.setItem(PROBE_STORAGE_KEY, JSON.stringify(index));
  }
  catch (_error) {
    return;
  }
}

function evictProbeStorageForSize(index) {
  var paths = Object.keys(index.entries || {});
  var rows = paths.map(function (path) {
    var entry = index.entries[path];
    return {
      path: path,
      accessedAt: entry && entry.accessedAt ? entry.accessedAt : 0,
      size: probeStorageEntrySize(path, entry),
    };
  });
  rows.sort(function (left, right) {
    return left.accessedAt - right.accessedAt;
  });
  var totalBytes = rows.reduce(function (sum, row) { return sum + row.size; }, 0);
  while (totalBytes > PROBE_STORAGE_MAX_BYTES && rows.length) {
    var oldest = rows.shift();
    if (!oldest) break;
    delete index.entries[oldest.path];
    totalBytes -= oldest.size;
  }
  index.totalBytes = totalBytes;
}

function pruneExpiredProbeStorage(index) {
  var now = Date.now();
  var totalBytes = 0;
  Object.keys(index.entries || {}).forEach(function (path) {
    var entry = index.entries[path];
    if (!entry || !entry.cachedAt || now - entry.cachedAt > PROBE_STORAGE_TTL_MS) {
      delete index.entries[path];
      return;
    }
    totalBytes += probeStorageEntrySize(path, entry);
  });
  index.totalBytes = totalBytes;
  evictProbeStorageForSize(index);
}

function getProbeFromSessionStorage(path) {
  var index = readProbeStorageIndex();
  pruneExpiredProbeStorage(index);
  var entry = index.entries[path];
  if (!entry || !entry.payload) {
    writeProbeStorageIndex(index);
    return null;
  }
  entry.accessedAt = Date.now();
  writeProbeStorageIndex(index);
  return entry.payload;
}

function setProbeInSessionStorage(path, payload) {
  var index = readProbeStorageIndex();
  pruneExpiredProbeStorage(index);
  if (index.entries[path]) {
    index.totalBytes = Math.max(
      0,
      (index.totalBytes || 0) - probeStorageEntrySize(path, index.entries[path])
    );
  }
  var entry = {
    payload: payload,
    cachedAt: Date.now(),
    accessedAt: Date.now(),
  };
  index.entries[path] = entry;
  index.totalBytes = (index.totalBytes || 0) + probeStorageEntrySize(path, entry);
  evictProbeStorageForSize(index);
  writeProbeStorageIndex(index);
}

async function loadProbeMetadata(item) {
  if (!item || !item.path) return null;
  var path = item.path;
  if (ctx.state.probeCache[path]) return ctx.state.probeCache[path];
  var storedPayload = getProbeFromSessionStorage(path);
  if (storedPayload) {
    ctx.state.probeCache[path] = storedPayload;
    return storedPayload;
  }
  if (ctx.state.probeFailures[path]) return null;
  try {
    var response = await fetch('/video/endpoints/probe?path=' + encodeURIComponent(path) + '&source=remote');
    if (!response.ok) throw new Error('Failed to probe video metadata.');
    var payload = await response.json();
    ctx.state.probeCache[path] = payload;
    setProbeInSessionStorage(path, payload);
    delete ctx.state.probeFailures[path];
    ctx.syncPlaybackProgress();
    return payload;
  }
  catch (_error) {
    ctx.state.probeFailures[path] = true;
    return null;
  }
}

async function ensureAudioTracksForItem(item) {
  if (!item) {
    ctx.renderAudioTrackSelector(null, null);
    return null;
  }
  ctx.renderAudioTrackSelector(item, ctx.state.probeCache[item.path || ''] || null);
  var payload = await loadProbeMetadata(item);
  if (item.path !== ctx.activeItemPath()) return payload;
  ctx.renderAudioTrackSelector(item, payload);
  return payload;
}

async function ensureSubtitleTracksForItem(item) {
  if (!item) {
    ctx.renderSubtitleTrackSelector(null, null);
    return null;
  }
  ctx.renderSubtitleTrackSelector(item, ctx.state.probeCache[item.path || ''] || null);
  var payload = await loadProbeMetadata(item);
  if (item.path !== ctx.activeItemPath()) return payload;
  ctx.renderSubtitleTrackSelector(item, payload);
  return payload;
}

  ctx.probeStorageEntrySize = probeStorageEntrySize;
  ctx.readProbeStorageIndex = readProbeStorageIndex;
  ctx.writeProbeStorageIndex = writeProbeStorageIndex;
  ctx.evictProbeStorageForSize = evictProbeStorageForSize;
  ctx.pruneExpiredProbeStorage = pruneExpiredProbeStorage;
  ctx.getProbeFromSessionStorage = getProbeFromSessionStorage;
  ctx.setProbeInSessionStorage = setProbeInSessionStorage;
  ctx.loadProbeMetadata = loadProbeMetadata;
  ctx.ensureAudioTracksForItem = ensureAudioTracksForItem;
  ctx.ensureSubtitleTracksForItem = ensureSubtitleTracksForItem;
}