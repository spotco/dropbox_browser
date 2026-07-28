import {waveformSummaryPayloadLength} from './peaks.js';

// The cache now stores signed min/max and RMS summaries rather than one peak
// value per bucket. Do not reuse the older sparse peak-only records.
export const WAVEFORM_CACHE_SCHEMA_VERSION = 3;
export const WAVEFORM_CACHE_MAX_RESOLUTION = 512;
export const WAVEFORM_CACHE_ENTRY_LIMIT_MAX = 100;
export const WAVEFORM_CACHE_SETTINGS_KEY = 'music-waveform-cache';

function finiteNonnegative(value) {
  return Number.isFinite(Number(value)) && Number(value) >= 0;
}

export function validateWaveformCacheRecord(record, expectedKey, options) {
  var maxResolution = options && Number.isInteger(options.maxResolution)
    ? options.maxResolution
    : WAVEFORM_CACHE_MAX_RESOLUTION;
  var summaryLength;
  if (!record || typeof record !== 'object') return null;
  if (record.version !== WAVEFORM_CACHE_SCHEMA_VERSION) return null;
  if (typeof record.key !== 'string' || !record.key) return null;
  if (expectedKey && record.key !== expectedKey) return null;
  if (!finiteNonnegative(record.lastUsed)) return null;
  if (!Number.isFinite(Number(record.duration)) || Number(record.duration) <= 0) return null;
  if (!Number.isInteger(record.resolution) || record.resolution < 1 || record.resolution > maxResolution) return null;
  if (typeof record.summary !== 'string' || !record.summary) return null;
  try {
    summaryLength = waveformSummaryPayloadLength(record.summary);
  } catch (_error) {
    return null;
  }
  if (summaryLength !== record.resolution) return null;
  return record;
}

export function findWaveformCacheRecord(entries, expectedKey, options) {
  if (!Array.isArray(entries) || !expectedKey) return null;
  for (var index = 0; index < entries.length; index += 1) {
    if (validateWaveformCacheRecord(entries[index], expectedKey, options)) return entries[index];
  }
  return null;
}

export function waveformCacheEntriesFromSettingsValue(value) {
  if (!value || typeof value !== 'object' || value.version !== WAVEFORM_CACHE_SCHEMA_VERSION) return [];
  return Array.isArray(value.entries) ? value.entries.slice() : [];
}

export function waveformCacheSettingsValue(entries) {
  return {
    version: WAVEFORM_CACHE_SCHEMA_VERSION,
    entries: Array.isArray(entries) ? entries.slice() : [],
  };
}

export function mergeWaveformCacheRecord(entries, record, limit) {
  var nextEntries;
  if (!Array.isArray(entries) || !record || typeof record.key !== 'string') return [];
  nextEntries = entries.filter(function (entry) {
    return !entry || entry.key !== record.key;
  });
  nextEntries.push(record);
  return evictWaveformCacheEntries(nextEntries, limit);
}

export function evictWaveformCacheEntries(entries, limit) {
  var maxEntries = Number(limit);
  if (!Array.isArray(entries) || !Number.isFinite(maxEntries) || maxEntries <= 0) return [];
  maxEntries = Math.floor(maxEntries);
  return entries
    .map(function (entry, index) {
      return {entry: entry, index: index};
    })
    .sort(function (left, right) {
      var leftTime = Number(left.entry && left.entry.lastUsed);
      var rightTime = Number(right.entry && right.entry.lastUsed);
      leftTime = Number.isFinite(leftTime) ? leftTime : 0;
      rightTime = Number.isFinite(rightTime) ? rightTime : 0;
      return rightTime - leftTime || left.index - right.index;
    })
    .slice(0, maxEntries)
    .map(function (item) {
      return item.entry;
    });
}
