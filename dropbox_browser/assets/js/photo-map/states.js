export const PHOTO_MAP_STATES = Object.freeze({
  idle: 'idle',
  loading: 'loading',
  cached: 'cached',
  progressive: 'progressive',
  ready: 'ready',
  noMedia: 'no-media',
  noGeotagged: 'no-geotagged',
  partialErrors: 'partial-errors',
});

function resultForItem(item, metadataResults) {
  if (metadataResults instanceof Map) return metadataResults.get(item.path) || null;
  return null;
}

function locatedResult(item, result) {
  return !!(result && result.status === 'located' &&
    Number.isFinite(result.latitude) && Number.isFinite(result.longitude));
}

export function summarizePhotoMapResults(candidates, metadataResults) {
  var summary = {
    candidateCount: 0,
    pendingCount: 0,
    locatedCount: 0,
    noLocationCount: 0,
    errorCount: 0,
    locatedItems: [],
  };
  (Array.isArray(candidates) ? candidates : []).forEach(function (item) {
    summary.candidateCount += 1;
    var result = resultForItem(item, metadataResults);
    if (!result) {
      summary.pendingCount += 1;
      return;
    }
    if (locatedResult(item, result)) {
      summary.locatedCount += 1;
      summary.locatedItems.push(Object.assign({}, item, result, {
        path: String(item.photoMapSourcePath || item.path || ''),
      }));
    } else if (result.status === 'no-location') {
      summary.noLocationCount += 1;
    } else {
      summary.errorCount += 1;
    }
  });
  return summary;
}

export function photoMapStatusForSummary(summary, phase) {
  var value = summary || {};
  var candidateCount = Number(value.candidateCount) || 0;
  var pendingCount = Number(value.pendingCount) || 0;
  var locatedCount = Number(value.locatedCount) || 0;
  var errorCount = Number(value.errorCount) || 0;
  var phaseName = String(phase || '');

  if (phaseName === 'loading') {
    return {state: PHOTO_MAP_STATES.loading, message: 'Loading Photo Map media...'};
  }
  if (candidateCount === 0) {
    return {state: PHOTO_MAP_STATES.noMedia, message: 'No supported media in the selected date range.'};
  }
  if (phaseName === 'cached' && locatedCount > 0) {
    return {
      state: PHOTO_MAP_STATES.cached,
      message: pendingCount > 0
        ? 'Showing ' + String(locatedCount) + ' cached geotagged media; loading more...'
        : 'Showing ' + String(locatedCount) + ' cached geotagged media on the map.',
    };
  }
  if (pendingCount > 0) {
    return {
      state: PHOTO_MAP_STATES.progressive,
      message: 'Showing ' + String(locatedCount) + ' geotagged media; inspecting ' +
        String(pendingCount) + ' more...',
    };
  }
  if (errorCount > 0) {
    return {
      state: PHOTO_MAP_STATES.partialErrors,
      message: String(locatedCount) + ' geotagged media shown; ' + String(errorCount) +
        ' media could not be read.',
    };
  }
  if (locatedCount === 0) {
    return {
      state: PHOTO_MAP_STATES.noGeotagged,
      message: 'No geotagged media in the selected date range.',
    };
  }
  return {
    state: PHOTO_MAP_STATES.ready,
    message: String(locatedCount) + ' geotagged media on the map.',
  };
}
