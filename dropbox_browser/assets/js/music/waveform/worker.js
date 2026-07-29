import {packWaveformSummaries} from './peaks.js';
import {waveformResolutionStages} from './resolution.js';

// A short measured turn keeps large decoded tracks responsive; the timeout
// yield gives input, paint, and audio-related browser work a chance to run.
export const WAVEFORM_WORKER_SLICE_BUDGET_MS = 3;
export const WAVEFORM_WORKER_YIELD_DELAY_MS = 8;
export const WAVEFORM_PREVIEW_SAMPLES_PER_BUCKET = 8;
// Deadline checks are intentionally amortized. Checking performance.now() for
// every source sample costs more CPU than the reduction on some browsers, but
// this bound still keeps a slice overshoot small while retaining the existing
// 3 ms CPU budget and 8 ms cooldown.
export const WAVEFORM_WORKER_SAMPLE_CHECK_INTERVAL = 512;

function channelLength(channel) {
  return channel && typeof channel.length === 'number' ? channel.length : 0;
}

function sampleCountForChannels(channels) {
  var sampleCount = 0;
  (Array.isArray(channels) ? channels : []).forEach(function (channel) {
    sampleCount = Math.max(sampleCount, channelLength(channel));
  });
  return sampleCount;
}

function channelLengthsForChannels(channels) {
  return (Array.isArray(channels) ? channels : []).map(channelLength);
}

function createSummary(resolution) {
  var summary = {
    min: new Float32Array(resolution),
    max: new Float32Array(resolution),
    rms: new Float32Array(resolution),
    sumSquares: new Float64Array(resolution),
    counts: new Float64Array(resolution),
  };
  summary.min.fill(Infinity);
  summary.max.fill(-Infinity);
  return summary;
}

function finalizeSummary(summary) {
  for (var index = 0; index < summary.min.length; index += 1) {
    if (!summary.counts[index]) {
      summary.min[index] = 0;
      summary.max[index] = 0;
      summary.rms[index] = 0;
      continue;
    }
    summary.rms[index] = Math.sqrt(summary.sumSquares[index] / summary.counts[index]);
  }
  return summary;
}

function addSample(summary, bucket, channels, channelLengths, sampleIndex) {
  var minimum = summary.min[bucket];
  var maximum = summary.max[bucket];
  var sumSquares = summary.sumSquares[bucket];
  var count = summary.counts[bucket];
  for (var channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
    var channel = channels[channelIndex];
    var length = channelLengths[channelIndex];
    var value;
    if (sampleIndex >= length) continue;
    value = Number(channel[sampleIndex]) || 0;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
    sumSquares += value * value;
    count += 1;
  }
  summary.min[bucket] = minimum;
  summary.max[bucket] = maximum;
  summary.sumSquares[bucket] = sumSquares;
  summary.counts[bucket] = count;
}

export function sampleIndicesForBucket(sampleCount, resolution, bucket, samplesPerBucket) {
  var start;
  var end;
  var width;
  var count = Number.isInteger(samplesPerBucket) && samplesPerBucket > 0
    ? samplesPerBucket
    : WAVEFORM_PREVIEW_SAMPLES_PER_BUCKET;
  var result = [];
  if (!Number.isInteger(sampleCount) || sampleCount < 1 ||
      !Number.isInteger(resolution) || resolution < 1 ||
      !Number.isInteger(bucket) || bucket < 0 || bucket >= resolution) return result;
  start = Math.floor(bucket * sampleCount / resolution);
  end = Math.max(start + 1, Math.ceil((bucket + 1) * sampleCount / resolution));
  end = Math.min(sampleCount, end);
  width = Math.max(1, end - start);
  for (var index = 0; index < count; index += 1) {
    result.push(Math.min(end - 1, start + Math.floor((index + 0.5) * width / count)));
  }
  return result;
}

export function sampleIndicesForRound(sampleCount, resolution, samplesPerBucket) {
  var result = [];
  for (var bucket = 0; bucket < resolution; bucket += 1) {
    result.push.apply(result, sampleIndicesForBucket(sampleCount, resolution, bucket, samplesPerBucket));
  }
  return result;
}

export function computeCombinedWaveformSummarySampled(channels, resolution, samplesPerBucket) {
  var sampleCount = sampleCountForChannels(channels);
  var channelLengths = channelLengthsForChannels(channels);
  var indices;
  var summary = createSummary(resolution);
  if (!Array.isArray(channels) || !Number.isInteger(resolution) || resolution < 1 || !sampleCount) {
    return finalizeSummary(summary);
  }
  indices = sampleIndicesForRound(sampleCount, resolution, samplesPerBucket);
  for (var index = 0; index < indices.length; index += 1) {
    addSample(summary, Math.floor(index / (Number.isInteger(samplesPerBucket) && samplesPerBucket > 0
      ? samplesPerBucket : WAVEFORM_PREVIEW_SAMPLES_PER_BUCKET)), channels, channelLengths, indices[index]);
  }
  return finalizeSummary(summary);
}

export function computeCombinedWaveformSummary(channels, resolution) {
  var sampleCount = sampleCountForChannels(channels);
  var channelLengths = channelLengthsForChannels(channels);
  var summary = createSummary(resolution);
  if (!Array.isArray(channels) || !Number.isInteger(resolution) || resolution < 1 || !sampleCount) {
    return finalizeSummary(summary);
  }
  // The old sample-major loop derived the bucket for every sample. Iterating
  // the buckets directly preserves the same sample and channel order while
  // allowing the hot accumulator state to stay in local variables.
  for (var bucket = 0; bucket < resolution; bucket += 1) {
    var start = bucket === 0 ? 0 : Math.ceil(bucket * sampleCount / resolution);
    var end = Math.min(sampleCount, Math.ceil((bucket + 1) * sampleCount / resolution));
    var minimum = Infinity;
    var maximum = -Infinity;
    var sumSquares = 0;
    var count = 0;
    for (var sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
      for (var channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
        if (sampleIndex >= channelLengths[channelIndex]) continue;
        var value = Number(channels[channelIndex][sampleIndex]) || 0;
        minimum = Math.min(minimum, value);
        maximum = Math.max(maximum, value);
        sumSquares += value * value;
        count += 1;
      }
    }
    summary.min[bucket] = minimum;
    summary.max[bucket] = maximum;
    summary.sumSquares[bucket] = sumSquares;
    summary.counts[bucket] = count;
  }
  return finalizeSummary(summary);
}

export function mergeWaveformSummary(summary, resolution) {
  var result = createSummary(resolution);
  var sourceResolution = summary && summary.min ? summary.min.length : 0;
  if (!sourceResolution || !Number.isInteger(resolution) || resolution < 1) return finalizeSummary(result);
  for (var bucket = 0; bucket < resolution; bucket += 1) {
    var start = Math.floor(bucket * sourceResolution / resolution);
    var end = Math.max(start + 1, Math.ceil((bucket + 1) * sourceResolution / resolution));
    for (var sourceBucket = start; sourceBucket < Math.min(end, sourceResolution); sourceBucket += 1) {
      result.min[bucket] = Math.min(result.min[bucket], summary.min[sourceBucket]);
      result.max[bucket] = Math.max(result.max[bucket], summary.max[sourceBucket]);
      result.sumSquares[bucket] += summary.sumSquares[sourceBucket];
      result.counts[bucket] += summary.counts[sourceBucket];
    }
  }
  return finalizeSummary(result);
}

function now() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function createPreviewJob(channels, resolution) {
  var sampleCount = sampleCountForChannels(channels);
  return {
    channels: channels,
    channelLengths: channelLengthsForChannels(channels),
    nextSample: 0,
    sampleCount: sampleCount,
    sampleIndices: sampleIndicesForRound(sampleCount, resolution, WAVEFORM_PREVIEW_SAMPLES_PER_BUCKET),
    samplesPerBucket: WAVEFORM_PREVIEW_SAMPLES_PER_BUCKET,
    summary: createSummary(resolution),
    totalSamples: resolution * WAVEFORM_PREVIEW_SAMPLES_PER_BUCKET,
    resolution: resolution,
  };
}

function processPreviewSlice(job, deadline) {
  while (job.nextSample < job.totalSamples) {
    if (now() >= deadline) return false;
    var bucket = Math.floor(job.nextSample / job.samplesPerBucket);
    addSample(job.summary, bucket, job.channels, job.channelLengths, job.sampleIndices[job.nextSample]);
    job.nextSample += 1;
  }
  finalizeSummary(job.summary);
  return true;
}

function createExactJob(channels, resolution) {
  return {
    channels: channels,
    channelLengths: channelLengthsForChannels(channels),
    bucketActive: false,
    bucketIndex: 0,
    bucketSampleCount: 0,
    bucketEnd: 0,
    bucketMinimum: Infinity,
    bucketMaximum: -Infinity,
    bucketSumSquares: 0,
    nextSample: 0,
    sampleCount: sampleCountForChannels(channels),
    summary: createSummary(resolution),
    resolution: resolution,
    samplesSinceDeadlineCheck: 0,
    lastReportedSample: 0,
  };
}

function processExactSlice(job, deadline) {
  while (job.bucketIndex < job.resolution) {
    if (!job.bucketActive) {
      var bucketStart = job.bucketIndex === 0 ? 0 : Math.ceil(job.bucketIndex * job.sampleCount / job.resolution);
      job.nextSample = bucketStart;
      job.bucketEnd = Math.min(job.sampleCount,
        Math.ceil((job.bucketIndex + 1) * job.sampleCount / job.resolution));
      job.bucketMinimum = Infinity;
      job.bucketMaximum = -Infinity;
      job.bucketSumSquares = 0;
      job.bucketSampleCount = 0;
      job.bucketActive = true;
    }
    while (job.nextSample < job.bucketEnd) {
      for (var channelIndex = 0; channelIndex < job.channels.length; channelIndex += 1) {
        if (job.nextSample >= job.channelLengths[channelIndex]) continue;
        var value = Number(job.channels[channelIndex][job.nextSample]) || 0;
        job.bucketMinimum = Math.min(job.bucketMinimum, value);
        job.bucketMaximum = Math.max(job.bucketMaximum, value);
        job.bucketSumSquares += value * value;
        job.bucketSampleCount += 1;
      }
      job.nextSample += 1;
      job.samplesSinceDeadlineCheck += 1;
      if (job.samplesSinceDeadlineCheck >= WAVEFORM_WORKER_SAMPLE_CHECK_INTERVAL) {
        job.samplesSinceDeadlineCheck = 0;
        if (now() >= deadline) return false;
      }
    }
    job.summary.min[job.bucketIndex] = job.bucketMinimum;
    job.summary.max[job.bucketIndex] = job.bucketMaximum;
    job.summary.sumSquares[job.bucketIndex] = job.bucketSumSquares;
    job.summary.counts[job.bucketIndex] = job.bucketSampleCount;
    job.bucketIndex += 1;
    job.bucketActive = false;
    if (now() >= deadline) return false;
  }
  finalizeSummary(job.summary);
  return true;
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

  function scheduleNext() {
    scope.setTimeout(processSlice, WAVEFORM_WORKER_YIELD_DELAY_MS);
  }

  function postSummary(summary, generation, resolution, sampleRound, sampleRounds, preview, completedSamples, totalSamples) {
    scope.postMessage({
      type: 'summary',
      generation: generation,
      resolution: resolution,
      preview: preview === true,
      sampleRound: sampleRound,
      sampleRounds: sampleRounds,
      completedSamples: completedSamples,
      totalSamples: totalSamples,
      summary: packWaveformSummaries(summary),
    });
  }

  function processSlice() {
    var deadline = now() + WAVEFORM_WORKER_SLICE_BUDGET_MS;
    var stages;
    var exactResolution;
    var resolution;
    var summary;
    if (!activeJob || activeJob.generation !== activeGeneration) return;
    stages = activeJob.stages;
    if (!activeJob.previewComplete) {
      if (!processPreviewSlice(activeJob.previewJob, deadline)) {
        scheduleNext();
        return;
      }
      postSummary(activeJob.previewJob.summary, activeJob.generation, stages[0], 1, stages.length, true,
        activeJob.previewJob.totalSamples, activeJob.previewJob.totalSamples);
      activeJob.previewComplete = true;
      scheduleNext();
      return;
    }
    if (!activeJob.exactComplete) {
      if (!processExactSlice(activeJob.exactJob, deadline)) {
        var progressStep = Math.max(4096, Math.floor(activeJob.exactJob.sampleCount / 100));
        if (activeJob.exactJob.nextSample - activeJob.exactJob.lastReportedSample >= progressStep) {
          activeJob.exactJob.lastReportedSample = activeJob.exactJob.nextSample;
          scope.postMessage({
            type: 'progress',
            generation: activeJob.generation,
            completedSamples: activeJob.exactJob.nextSample,
            totalSamples: activeJob.exactJob.sampleCount,
          });
        }
        scheduleNext();
        return;
      }
      activeJob.exactComplete = true;
    }
    exactResolution = stages[stages.length - 1];
    summary = activeJob.exactJob.summary;
    for (var stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
      resolution = stages[stageIndex];
      postSummary(mergeWaveformSummary(summary, resolution), activeJob.generation, resolution,
        stageIndex + 1, stages.length, false, resolution, resolution);
    }
    scope.postMessage({type: 'complete', generation: activeJob.generation, resolution: exactResolution});
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
      exactComplete: false,
      exactJob: createExactJob(Array.isArray(message.channels) ? message.channels : [], stages[stages.length - 1]),
      generation: message.generation,
      previewComplete: false,
      previewJob: createPreviewJob(Array.isArray(message.channels) ? message.channels : [], stages[0]),
      stages: stages,
    };
    processSlice();
  });
}

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
  installWaveformWorker(self);
}
