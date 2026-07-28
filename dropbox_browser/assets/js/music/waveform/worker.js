import {packWaveformPeaks} from './peaks.js';
import {waveformResolutionStages} from './resolution.js';

// A short measured turn keeps large decoded tracks responsive; the timeout
// yield gives input, paint, and audio-related browser work a chance to run.
export const WAVEFORM_WORKER_SLICE_BUDGET_MS = 3;
export const WAVEFORM_WORKER_YIELD_DELAY_MS = 8;

function channelLength(channel) {
  return channel && typeof channel.length === 'number' ? channel.length : 0;
}

export function computeCombinedWaveformPeaks(channels, resolution) {
  var sampleCount = 0;
  var result = new Float32Array(resolution);
  if (!Array.isArray(channels) || !Number.isInteger(resolution) || resolution < 1) return result;
  channels.forEach(function (channel) {
    sampleCount = Math.max(sampleCount, channelLength(channel));
  });
  if (!sampleCount) return result;
  for (var bucket = 0; bucket < resolution; bucket += 1) {
    var start = Math.floor(bucket * sampleCount / resolution);
    var end = Math.max(start + 1, Math.ceil((bucket + 1) * sampleCount / resolution));
    var peak = 0;
    channels.forEach(function (channel) {
      var limit = Math.min(end, channelLength(channel));
      for (var index = Math.min(start, limit); index < limit; index += 1) {
        peak = Math.max(peak, Math.abs(Number(channel[index]) || 0));
      }
    });
    result[bucket] = Math.min(1, peak);
  }
  return result;
}

// Each round samples the center of a distinct equal-width interval. For
// power-of-two rounds, the center fractions are disjoint: 64 uses odd/128,
// 256 uses odd/512, and 1024 uses odd/2048. This makes every round add new
// source locations.
export function sampleIndicesForRound(sampleCount, resolution) {
  var result = [];
  if (!Number.isInteger(sampleCount) || sampleCount < 1 ||
      !Number.isInteger(resolution) || resolution < 1) return result;
  for (var index = 0; index < resolution; index += 1) {
    result.push(Math.min(sampleCount - 1, Math.floor((index + 0.5) * sampleCount / resolution)));
  }
  return result;
}

export function computeCombinedWaveformSampledPeaks(channels, resolution) {
  var sampleCount = 0;
  var result = new Float32Array(resolution);
  if (!Array.isArray(channels) || !Number.isInteger(resolution) || resolution < 1) return result;
  channels.forEach(function (channel) {
    sampleCount = Math.max(sampleCount, channelLength(channel));
  });
  if (!sampleCount) return result;
  sampleIndicesForRound(sampleCount, resolution).forEach(function (sampleIndex, bucket) {
    var peak = 0;
    channels.forEach(function (channel) {
      if (sampleIndex < channelLength(channel)) {
        peak = Math.max(peak, Math.abs(Number(channel[sampleIndex]) || 0));
      }
    });
    result[bucket] = Math.min(1, peak);
  });
  return result;
}

function now() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function createStageJob(channels, resolution) {
  var sampleCount = 0;
  channels.forEach(function (channel) {
    sampleCount = Math.max(sampleCount, channelLength(channel));
  });
  return {
    sampleIndex: 0,
    channels: channels,
    peaks: new Float32Array(resolution),
    resolution: resolution,
    sampleCount: sampleCount,
  };
}

function processStageSlice(stage, deadline) {
  var indices = sampleIndicesForRound(stage.sampleCount, stage.resolution);
  while (stage.sampleIndex < stage.resolution) {
    if (now() >= deadline) return false;
    var sourceIndex = indices[stage.sampleIndex];
    var peak = 0;
    stage.channels.forEach(function (channel) {
      if (sourceIndex < channelLength(channel)) {
        peak = Math.max(peak, Math.abs(Number(channel[sourceIndex]) || 0));
      }
    });
    stage.peaks[stage.sampleIndex] = Math.min(1, peak);
    stage.sampleIndex += 1;
  }
  return stage.sampleIndex >= stage.resolution;
}

export function installWaveformWorker(scope) {
  var activeGeneration = null;
  var activeJob = null;

  function cancelJob(generation) {
    if (generation === undefined || generation === activeGeneration) {
      activeGeneration = null;
      activeJob = null;
    }
  }

  function processSlice() {
    var deadline = now() + WAVEFORM_WORKER_SLICE_BUDGET_MS;
    if (!activeJob || activeJob.generation !== activeGeneration) return;
    if (activeJob.stageIndex < activeJob.stages.length) {
      var resolution = activeJob.stages[activeJob.stageIndex];
      if (!activeJob.stageJob) activeJob.stageJob = createStageJob(activeJob.channels, resolution);
      if (!processStageSlice(activeJob.stageJob, deadline)) {
        scope.setTimeout(processSlice, WAVEFORM_WORKER_YIELD_DELAY_MS);
        return;
      }
      scope.postMessage({
        type: 'peaks',
        generation: activeJob.generation,
        resolution: resolution,
        preview: activeJob.stageIndex === 0,
        sampleRound: activeJob.stageIndex + 1,
        sampleRounds: activeJob.stages.length,
        completedSamples: activeJob.stageJob.sampleIndex,
        totalSamples: resolution,
        peaks: packWaveformPeaks(activeJob.stageJob.peaks),
      });
      activeJob.stageIndex += 1;
      activeJob.stageJob = null;
      scope.setTimeout(processSlice, WAVEFORM_WORKER_YIELD_DELAY_MS);
      return;
    }
    scope.postMessage({type: 'complete', generation: activeJob.generation});
    activeJob = null;
  }

  scope.addEventListener('message', function (event) {
    var message = event && event.data ? event.data : {};
    if (message.type === 'cancel') {
      cancelJob(message.generation);
      return;
    }
    if (message.type !== 'start') return;
    cancelJob();
    activeGeneration = message.generation;
    var stages = waveformResolutionStages(message.targetResolution, message.maxResolution);
    activeJob = {
      channels: Array.isArray(message.channels) ? message.channels : [],
      generation: message.generation,
      stageIndex: 0,
      stages: stages,
      stageJob: null,
    };
    processSlice();
  });
}

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
  installWaveformWorker(self);
}
