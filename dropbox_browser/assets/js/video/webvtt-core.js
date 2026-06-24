var WEBVTT_ENTITY_RE = /&(?:amp|lt|gt|lrm|rlm);/gi;
var WEBVTT_TIMESTAMP_TAG_RE = /<\d{1,2}:\d{2}(?::\d{2})?\.\d{3}>/g;
var WEBVTT_TAG_RE = /<\/?[a-zA-Z][^>]*>/g;
var WEBVTT_SUPPORTED_TAGS = {
  b: 'b',
  i: 'i',
  u: 'u',
  c: 'span',
  v: 'span',
  lang: 'span',
  ruby: 'ruby',
  rt: 'rt',
};

function decodeWebVttEntities(text) {
  return String(text || '').replace(WEBVTT_ENTITY_RE, function (entity) {
    var key = entity.slice(1, -1).toLowerCase();
    if (key === 'amp') return '&';
    if (key === 'lt') return '<';
    if (key === 'gt') return '>';
    if (key === 'lrm') return '\u200E';
    if (key === 'rlm') return '\u200F';
    return entity;
  });
}

function escapeWebVttHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function parseWebVttTag(tagBody) {
  var closing = tagBody.charAt(0) === '/';
  var body = closing ? tagBody.slice(1) : tagBody;
  var dotIndex = body.indexOf('.');
  var spaceIndex = body.indexOf(' ');
  var nameEnd = dotIndex >= 0 && spaceIndex >= 0
    ? Math.min(dotIndex, spaceIndex)
    : (dotIndex >= 0 ? dotIndex : spaceIndex);
  var name = (nameEnd < 0 ? body : body.slice(0, nameEnd)).toLowerCase();
  var annotation = '';
  if (!closing) {
    if (name === 'v' && spaceIndex >= 0) {
      annotation = body.slice(spaceIndex + 1).trim();
    }
    else if (dotIndex >= 0) {
      annotation = body.slice(dotIndex + 1).trim();
    }
    else if (name === 'lang' && spaceIndex >= 0) {
      annotation = body.slice(spaceIndex + 1).trim();
    }
  }
  return {
    closing: closing,
    name: name,
    annotation: annotation,
  };
}

function openWebVttTagHtml(parsed) {
  var htmlTag = WEBVTT_SUPPORTED_TAGS[parsed.name];
  if (!htmlTag) return '';
  if (parsed.name === 'c') {
    if (parsed.annotation) {
      return '<span class="vtt-c ' + escapeWebVttHtml(parsed.annotation) + '">';
    }
    return '<span class="vtt-c">';
  }
  if (parsed.name === 'v') {
    var attrs = ' class="vtt-v"';
    if (parsed.annotation) {
      attrs += ' data-voice="' + escapeWebVttHtml(parsed.annotation) + '"';
    }
    return '<span' + attrs + '>';
  }
  if (parsed.name === 'lang') {
    if (parsed.annotation) {
      return '<span lang="' + escapeWebVttHtml(parsed.annotation) + '">';
    }
    return '<span>';
  }
  return '<' + htmlTag + '>';
}

function closeWebVttTagHtml(name) {
  var htmlTag = WEBVTT_SUPPORTED_TAGS[name];
  if (!htmlTag) return '';
  if (htmlTag === 'span') return '</span>';
  return '</' + htmlTag + '>';
}

export function stripWebVttMarkup(text) {
  return decodeWebVttEntities(text)
    .replace(WEBVTT_TIMESTAMP_TAG_RE, '')
    .replace(WEBVTT_TAG_RE, '');
}

export function webvttCueTextToHtml(text) {
  var input = decodeWebVttEntities(text);
  input = input.replace(WEBVTT_TIMESTAMP_TAG_RE, '');
  var result = '';
  var lastIndex = 0;
  var match;
  var tagRe = /<\/?[a-zA-Z][^>]*>/g;
  while ((match = tagRe.exec(input)) !== null) {
    result += escapeWebVttHtml(input.slice(lastIndex, match.index));
    var parsed = parseWebVttTag(match[0].slice(1, -1));
    if (!WEBVTT_SUPPORTED_TAGS[parsed.name]) {
      result += escapeWebVttHtml(match[0]);
    }
    else if (parsed.closing) {
      result += closeWebVttTagHtml(parsed.name);
    }
    else {
      result += openWebVttTagHtml(parsed);
    }
    lastIndex = tagRe.lastIndex;
  }
  result += escapeWebVttHtml(input.slice(lastIndex));
  return result;
}

export function findActiveParsedCues(cues, mediaTime) {
  if (!Array.isArray(cues) || !Number.isFinite(mediaTime)) return [];
  var active = [];
  for (var index = 0; index < cues.length; index += 1) {
    var cue = cues[index];
    if (mediaTime >= cue.start && mediaTime < cue.end) active.push(cue);
  }
  return active;
}