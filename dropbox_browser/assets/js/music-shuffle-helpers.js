/**
 * Pure shuffle / next-prev playlist navigation helpers.
 * Host playback modules own persistence and audio; these only compute indices.
 */

export function isValidShuffleSequence(shuffleSequence, playlistLength) {
  var expectedLength = Number(playlistLength) || 0;
  var seen = Object.create(null);
  if (!Array.isArray(shuffleSequence) || shuffleSequence.length !== expectedLength) return false;
  for (var i = 0; i < shuffleSequence.length; i += 1) {
    var value = shuffleSequence[i];
    if (!Number.isInteger(value) || value < 0 || value >= expectedLength || seen[value]) return false;
    seen[value] = true;
  }
  return true;
}

export function buildShuffledIndices(length, randomFn) {
  var indices = [];
  var swapIndex;
  var tmp;
  var random = typeof randomFn === 'function' ? randomFn : Math.random;
  var count = Math.max(0, Number(length) || 0);
  for (var i = 0; i < count; i += 1) indices.push(i);
  for (var j = indices.length - 1; j > 0; j -= 1) {
    swapIndex = Math.floor(random() * (j + 1));
    tmp = indices[j];
    indices[j] = indices[swapIndex];
    indices[swapIndex] = tmp;
  }
  return indices;
}

export function rebuildShuffleSequence(playlistLength, currentIndex, randomFn) {
  var length = Math.max(0, Number(playlistLength) || 0);
  var index = Number.isInteger(currentIndex) ? currentIndex : -1;
  var sequence = buildShuffledIndices(length, randomFn);
  var currentPosition;
  var shuffleCursor = -1;
  if (index >= 0 && index < length) {
    currentPosition = sequence.indexOf(index);
    if (currentPosition > 0) {
      sequence.splice(currentPosition, 1);
      sequence.unshift(index);
    }
    shuffleCursor = sequence.length ? 0 : -1;
  }
  return {
    shuffleSequence: sequence,
    shuffleCursor: shuffleCursor
  };
}

export function ensureShuffleState(input, randomFn) {
  var playlistLength = Math.max(0, Number(input && input.playlistLength) || 0);
  var currentPlaylistIndex = Number.isInteger(input && input.currentPlaylistIndex)
    ? input.currentPlaylistIndex
    : -1;
  var shuffleSequence = Array.isArray(input && input.shuffleSequence)
    ? input.shuffleSequence.slice()
    : [];
  var shuffleCursor = Number.isInteger(input && input.shuffleCursor) ? input.shuffleCursor : -1;
  var rebuilt;
  if (!isValidShuffleSequence(shuffleSequence, playlistLength)) {
    rebuilt = rebuildShuffleSequence(playlistLength, currentPlaylistIndex, randomFn);
    return rebuilt;
  }
  if (shuffleCursor >= shuffleSequence.length) {
    shuffleCursor = shuffleSequence.length - 1;
  }
  return {
    shuffleSequence: shuffleSequence,
    shuffleCursor: shuffleCursor
  };
}

/**
 * Resolve next playlist index. Mutates nothing; returns next index plus shuffle state.
 * @returns {{index: number, shuffleSequence: number[], shuffleCursor: number}}
 */
export function resolveNextPlaylistIndex(input, randomFn) {
  var playlistLength = Math.max(0, Number(input && input.playlistLength) || 0);
  var currentPlaylistIndex = Number.isInteger(input && input.currentPlaylistIndex)
    ? input.currentPlaylistIndex
    : -1;
  var shuffleEnabled = !!(input && input.shuffleEnabled);
  var loopPlaylist = !!(input && input.loopPlaylist);
  var shuffleState;
  if (playlistLength === 0) {
    return {index: -1, shuffleSequence: [], shuffleCursor: -1};
  }
  if (shuffleEnabled) {
    shuffleState = ensureShuffleState(input, randomFn);
    if (shuffleState.shuffleCursor < 0) {
      return {
        index: shuffleState.shuffleSequence[0] ?? -1,
        shuffleSequence: shuffleState.shuffleSequence,
        shuffleCursor: 0
      };
    }
    if (shuffleState.shuffleCursor + 1 < shuffleState.shuffleSequence.length) {
      return {
        index: shuffleState.shuffleSequence[shuffleState.shuffleCursor + 1],
        shuffleSequence: shuffleState.shuffleSequence,
        shuffleCursor: shuffleState.shuffleCursor + 1
      };
    }
    if (loopPlaylist && shuffleState.shuffleSequence.length > 0) {
      return {
        index: shuffleState.shuffleSequence[0],
        shuffleSequence: shuffleState.shuffleSequence,
        shuffleCursor: 0
      };
    }
    return {
      index: -1,
      shuffleSequence: shuffleState.shuffleSequence,
      shuffleCursor: shuffleState.shuffleCursor
    };
  }
  if (currentPlaylistIndex < 0) {
    return {
      index: 0,
      shuffleSequence: Array.isArray(input && input.shuffleSequence) ? input.shuffleSequence.slice() : [],
      shuffleCursor: Number.isInteger(input && input.shuffleCursor) ? input.shuffleCursor : -1
    };
  }
  if (currentPlaylistIndex + 1 < playlistLength) {
    return {
      index: currentPlaylistIndex + 1,
      shuffleSequence: Array.isArray(input && input.shuffleSequence) ? input.shuffleSequence.slice() : [],
      shuffleCursor: Number.isInteger(input && input.shuffleCursor) ? input.shuffleCursor : -1
    };
  }
  return {
    index: loopPlaylist ? 0 : -1,
    shuffleSequence: Array.isArray(input && input.shuffleSequence) ? input.shuffleSequence.slice() : [],
    shuffleCursor: Number.isInteger(input && input.shuffleCursor) ? input.shuffleCursor : -1
  };
}

/**
 * Resolve previous playlist index.
 * @returns {{index: number, shuffleSequence: number[], shuffleCursor: number}}
 */
export function resolvePreviousPlaylistIndex(input, randomFn) {
  var playlistLength = Math.max(0, Number(input && input.playlistLength) || 0);
  var currentPlaylistIndex = Number.isInteger(input && input.currentPlaylistIndex)
    ? input.currentPlaylistIndex
    : -1;
  var shuffleEnabled = !!(input && input.shuffleEnabled);
  var loopPlaylist = !!(input && input.loopPlaylist);
  var shuffleState;
  if (playlistLength === 0) {
    return {index: -1, shuffleSequence: [], shuffleCursor: -1};
  }
  if (shuffleEnabled) {
    shuffleState = ensureShuffleState(input, randomFn);
    if (shuffleState.shuffleCursor < 0) {
      if (shuffleState.shuffleSequence.length === 0) {
        return {index: -1, shuffleSequence: shuffleState.shuffleSequence, shuffleCursor: -1};
      }
      return {
        index: shuffleState.shuffleSequence[0],
        shuffleSequence: shuffleState.shuffleSequence,
        shuffleCursor: 0
      };
    }
    if (shuffleState.shuffleCursor > 0) {
      return {
        index: shuffleState.shuffleSequence[shuffleState.shuffleCursor - 1],
        shuffleSequence: shuffleState.shuffleSequence,
        shuffleCursor: shuffleState.shuffleCursor - 1
      };
    }
    if (loopPlaylist && shuffleState.shuffleSequence.length > 0) {
      return {
        index: shuffleState.shuffleSequence[shuffleState.shuffleSequence.length - 1],
        shuffleSequence: shuffleState.shuffleSequence,
        shuffleCursor: shuffleState.shuffleSequence.length - 1
      };
    }
    return {
      index: shuffleState.shuffleSequence[0] ?? -1,
      shuffleSequence: shuffleState.shuffleSequence,
      shuffleCursor: 0
    };
  }
  if (currentPlaylistIndex <= 0) {
    return {
      index: loopPlaylist ? playlistLength - 1 : 0,
      shuffleSequence: Array.isArray(input && input.shuffleSequence) ? input.shuffleSequence.slice() : [],
      shuffleCursor: Number.isInteger(input && input.shuffleCursor) ? input.shuffleCursor : -1
    };
  }
  return {
    index: currentPlaylistIndex - 1,
    shuffleSequence: Array.isArray(input && input.shuffleSequence) ? input.shuffleSequence.slice() : [],
    shuffleCursor: Number.isInteger(input && input.shuffleCursor) ? input.shuffleCursor : -1
  };
}
