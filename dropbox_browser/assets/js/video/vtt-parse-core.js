export var VTT_TIMING_LINE_RE = /(\d{1,2}:\d{2}(?::\d{2})?\.\d{1,3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?\.\d{1,3})([^\n]*)/;

export function parseVttTimestamp(raw) {
  var text = String(raw || '').trim();
  if (!text) return NaN;
  var chunks = text.split(':');
  var seconds = 0;
  if (chunks.length === 3) {
    seconds = Number(chunks[0]) * 3600 + Number(chunks[1]) * 60 + Number(chunks[2]);
  }
  else if (chunks.length === 2) {
    seconds = Number(chunks[0]) * 60 + Number(chunks[1]);
  }
  else {
    seconds = Number(text);
  }
  return Number.isFinite(seconds) ? seconds : NaN;
}

export function parseWebVttCues(vttText) {
  var cues = [];
  var normalized = String(vttText || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  var blocks = normalized.split(/\n\n+/);
  blocks.forEach(function (block) {
    var trimmed = block.trim();
    if (!trimmed || trimmed.indexOf('WEBVTT') === 0) return;
    var lines = trimmed.split('\n');
    var timingIndex = 0;
    if (lines.length > 1 && lines[0].indexOf('-->') < 0 && lines[1].indexOf('-->') >= 0) {
      timingIndex = 1;
    }
    var timingLine = lines[timingIndex] || '';
    if (timingLine.indexOf('-->') < 0) return;
    var timingParts = timingLine.split('-->');
    var start = parseVttTimestamp(timingParts[0]);
    var end = parseVttTimestamp(String(timingParts[1] || '').trim().split(/\s+/)[0]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return;
    var rawText = lines.slice(timingIndex + 1).join('\n');
    cues.push({
      start: start,
      end: end,
      rawTimingLine: timingLine.trim(),
      rawText: rawText,
      rawBlock: trimmed,
    });
  });
  return cues;
}

export function formatVttTimestamp(seconds) {
  var clamped = Math.max(0, Number(seconds) || 0);
  var whole = Math.floor(clamped);
  var millis = Math.round((clamped - whole) * 1000);
  if (millis === 1000) {
    whole += 1;
    millis = 0;
  }
  var hours = Math.floor(whole / 3600);
  var minutes = Math.floor((whole % 3600) / 60);
  var remainder = whole % 60;
  if (hours > 0) {
    return String(hours).padStart(2, '0')
      + ':'
      + String(minutes).padStart(2, '0')
      + ':'
      + String(remainder).padStart(2, '0')
      + '.'
      + String(millis).padStart(3, '0');
  }
  return String(minutes).padStart(2, '0')
    + ':'
    + String(remainder).padStart(2, '0')
    + '.'
    + String(millis).padStart(3, '0');
}

export function shiftVttTimingLine(match, shiftSeconds) {
  var start = parseVttTimestamp(match[1]);
  var end = parseVttTimestamp(match[2]);
  var shiftedStart = start - shiftSeconds;
  var shiftedEnd = end - shiftSeconds;
  if (shiftedEnd <= 0) return null;
  if (shiftedStart < 0) shiftedStart = 0;
  return formatVttTimestamp(shiftedStart) + ' --> ' + formatVttTimestamp(shiftedEnd) + (match[3] || '');
}

export function rebaseWebVttText(body, startTimeSeconds) {
  if (!(startTimeSeconds > 0)) return body;
  var blocks = String(body || '').trim().split(/\n\n+/);
  var outBlocks = [];
  blocks.forEach(function (block) {
    var trimmed = block.trim();
    if (!trimmed) return;
    if (trimmed.indexOf('WEBVTT') === 0) {
      outBlocks.push(trimmed);
      return;
    }
    var lines = trimmed.split('\n');
    var timingIdx = 0;
    if (lines.length > 1 && lines[0].indexOf('-->') < 0 && lines[1].indexOf('-->') >= 0) {
      timingIdx = 1;
    }
    var timingMatch = lines[timingIdx].trim().match(VTT_TIMING_LINE_RE);
    if (!timingMatch) {
      outBlocks.push(trimmed);
      return;
    }
    var shiftedTiming = shiftVttTimingLine(timingMatch, startTimeSeconds);
    if (!shiftedTiming) return;
    lines[timingIdx] = shiftedTiming;
    outBlocks.push(lines.join('\n'));
  });
  if (!outBlocks.length) return 'WEBVTT\n\n';
  return outBlocks.join('\n\n') + '\n';
}