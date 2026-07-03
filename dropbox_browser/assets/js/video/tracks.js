export function initTracks(ctx) {
function persistAudioSelectionFromUi(item) {
  var select = ctx.els.audioTrackSelectEl;
  var probePayload;
  var audioStreams;
  var stream;
  var layoutKey;
  if (!item || !select || select.disabled || !select.value) return;
  probePayload = ctx.state.probeCache[item.path || ''] || null;
  if (!probePayload) return;
  audioStreams = Array.isArray(probePayload.audio_streams) ? probePayload.audio_streams : [];
  stream = audioStreams.find(function (candidate) {
    return String(candidate.index) === String(select.value);
  }) || null;
  if (!stream) return;
  layoutKey = audioTrackLayoutKey(probePayload);
  setStoredAudioTrackPreference(layoutKey, audioTrackPreferenceDescriptor(audioStreams, stream));
}

function audioTrackLabel(stream) {
  var parts = [];
  if (stream.language) parts.push(String(stream.language).toUpperCase());
  if (stream.title) parts.push(stream.title);
  if (stream.codec_name) parts.push(String(stream.codec_name).toUpperCase());
  parts.push('Stream ' + String(stream.index));
  return parts.join(' • ');
}

function subtitleTrackLabel(stream) {
  var parts = [];
  if (stream.language) parts.push(String(stream.language).toUpperCase());
  if (stream.title) parts.push(stream.title);
  if (stream.codec_name) parts.push(String(stream.codec_name).toUpperCase());
  if (ctx.subtitleStreamRequiresBurnIn(stream)) parts.push('Burn-in restart');
  parts.push('Stream ' + String(stream.index));
  return parts.join(' • ');
}

function normalizedTrackLanguage(stream) {
  if (!stream || !stream.language) return 'und';
  return String(stream.language).toLowerCase();
}

function trackTitleTokens(value) {
  return String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function audioTrackRole(stream) {
  var tokens = trackTitleTokens(stream && stream.title);
  if (tokens.some(function (token) { return token === 'commentary' || token === 'comment'; })) return 'commentary';
  if (tokens.some(function (token) { return token === 'descriptive' || token === 'description' || token === 'assistive'; })) return 'descriptive';
  return 'main';
}

function subtitleTrackRole(stream) {
  var tokens = trackTitleTokens(stream && stream.title);
  if (tokens.some(function (token) { return token === 'commentary' || token === 'comment'; })) return 'commentary';
  if (tokens.some(function (token) { return token === 'forced' || token === 'force'; })) return 'forced';
  if (tokens.some(function (token) { return token === 'sign' || token === 'signs' || token === 'songs'; })) return 'signs';
  return 'main';
}

function audioTrackPreferenceSignature(stream) {
  return JSON.stringify({
    language: normalizedTrackLanguage(stream),
    role: audioTrackRole(stream),
  });
}

function subtitleTrackPreferenceSignature(stream) {
  return JSON.stringify({
    language: normalizedTrackLanguage(stream),
    role: subtitleTrackRole(stream),
    burn_in: ctx.subtitleStreamRequiresBurnIn(stream) ? 1 : 0,
  });
}

function preferenceOrdinalForTrack(streams, stream, signatureFn) {
  var targetSignature;
  var ordinal = 0;
  if (!stream || !Array.isArray(streams)) return 0;
  targetSignature = signatureFn(stream);
  for (var index = 0; index < streams.length; index += 1) {
    if (streams[index] === stream) return ordinal;
    if (signatureFn(streams[index]) === targetSignature) ordinal += 1;
  }
  return ordinal;
}

function audioTrackPreferenceDescriptor(streams, stream) {
  if (!stream) return null;
  return {
    signature: audioTrackPreferenceSignature(stream),
    ordinal: preferenceOrdinalForTrack(streams, stream, audioTrackPreferenceSignature),
  };
}

function subtitleTrackPreferenceDescriptor(streams, stream) {
  if (!stream) return {off: true};
  return {
    signature: subtitleTrackPreferenceSignature(stream),
    ordinal: preferenceOrdinalForTrack(streams, stream, subtitleTrackPreferenceSignature),
  };
}

function resolvePreferredTrackByDescriptor(streams, descriptor, signatureFn) {
  var ordinal;
  var matches;
  if (!Array.isArray(streams) || !streams.length || !descriptor || typeof descriptor !== 'object') return null;
  if (descriptor.off) return '';
  if (typeof descriptor.signature !== 'string' || !descriptor.signature) return null;
  ordinal = Number.isInteger(descriptor.ordinal) && descriptor.ordinal >= 0 ? descriptor.ordinal : 0;
  matches = streams.filter(function (stream) {
    return signatureFn(stream) === descriptor.signature;
  });
  if (!matches.length) return null;
  return matches[Math.min(ordinal, matches.length - 1)] || null;
}

function encodeTrackPreferenceLayout(layoutParts) {
  return Array.isArray(layoutParts) ? JSON.stringify(layoutParts) : '';
}

function audioTrackLayoutKey(probePayload) {
  var audioStreams = Array.isArray(probePayload && probePayload.audio_streams) ? probePayload.audio_streams : [];
  return encodeTrackPreferenceLayout(audioStreams.map(audioTrackPreferenceSignature));
}

function subtitleTrackLayoutKey(probePayload) {
  var subtitleStreams = ctx.subtitleStreamsForPayload(probePayload);
  return encodeTrackPreferenceLayout(['off'].concat(subtitleStreams.map(subtitleTrackPreferenceSignature)));
}

function loadStoredTrackPreferences(storageKey) {
  try {
    var storage = window.localStorage;
    if (!storage) return Object.create(null);
    var raw = storage.getItem(storageKey);
    if (!raw) return Object.create(null);
    var parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return Object.create(null);
    return Object.assign(Object.create(null), parsed);
  }
  catch (_error) {
    return Object.create(null);
  }
}

function saveStoredTrackPreferences(storageKey, value) {
  try {
    var storage = window.localStorage;
    if (!storage) return;
    storage.setItem(storageKey, JSON.stringify(value || {}));
  }
  catch (_error) {
    return;
  }
}

function setStoredAudioTrackPreference(layoutKey, descriptor) {
  if (!layoutKey || !descriptor) return;
  ctx.state.audioTrackPreferenceByLayout[layoutKey] = descriptor;
  saveStoredTrackPreferences('dropbox-browser-video-audio-track-preferences', ctx.state.audioTrackPreferenceByLayout);
}

function setStoredSubtitleTrackPreference(layoutKey, descriptor) {
  if (!layoutKey || !descriptor) return;
  ctx.state.subtitleTrackPreferenceByLayout[layoutKey] = descriptor;
  saveStoredTrackPreferences('dropbox-browser-video-subtitle-track-preferences', ctx.state.subtitleTrackPreferenceByLayout);
}

function selectedOptionLabel(select, fallbackText) {
  var option;
  if (!select) return String(fallbackText || '');
  option = select.options && typeof select.selectedIndex === 'number'
    ? select.options[select.selectedIndex]
    : null;
  if (option && typeof option.textContent === 'string' && option.textContent) {
    return option.textContent.trim();
  }
  return String(fallbackText || '');
}

function syncTrackSummaryValue(summaryEl, text) {
  var nextText = String(text || '').trim();
  if (!summaryEl) return;
  if (!nextText) nextText = 'None';
  summaryEl.textContent = nextText;
  summaryEl.title = nextText;
}

function syncAudioTrackSummary(fallbackText) {
  syncTrackSummaryValue(
    ctx.els.audioTrackSummaryEl,
    selectedOptionLabel(ctx.els.audioTrackSelectEl, fallbackText || 'No audio tracks found')
  );
}

function syncSubtitleTrackSummary(fallbackText) {
  syncTrackSummaryValue(
    ctx.els.subtitleTrackSummaryEl,
    selectedOptionLabel(ctx.els.subtitleTrackSelectEl, fallbackText || 'Subtitles Off')
  );
}

function syncTrackSummary() {
  syncAudioTrackSummary('No video selected');
  syncSubtitleTrackSummary('No video selected');
}

function setAudioTrackPlaceholder(text) {
  var select = ctx.els.audioTrackSelectEl;
  if (!select) return;
  select.innerHTML = '';
  var option = document.createElement('option');
  option.value = '';
  option.textContent = text;
  select.appendChild(option);
  select.disabled = true;
  syncAudioTrackSummary(text);
}

function setSubtitleTrackPlaceholder(text) {
  var select = ctx.els.subtitleTrackSelectEl;
  if (!select) return;
  select.innerHTML = '';
  var option = document.createElement('option');
  option.value = '';
  option.textContent = text;
  select.appendChild(option);
  select.disabled = true;
  syncSubtitleTrackSummary(text);
}

function selectedAudioStreamIndex(item, probePayload) {
  if (!item || !probePayload) return null;
  var path = item.path || '';
  var audioStreams = Array.isArray(probePayload.audio_streams) ? probePayload.audio_streams : [];
  var layoutKey;
  var storedPreference;
  var matchedStoredStream;
  if (!audioStreams.length) return null;
  var saved = ctx.state.selectedAudioStreamIndexByPath[path];
  if (typeof saved === 'number' && audioStreams.some(function (stream) { return stream.index === saved; })) {
    return saved;
  }
  layoutKey = audioTrackLayoutKey(probePayload);
  storedPreference = ctx.state.audioTrackPreferenceByLayout[layoutKey];
  matchedStoredStream = resolvePreferredTrackByDescriptor(audioStreams, storedPreference, audioTrackPreferenceSignature);
  if (matchedStoredStream) {
    ctx.state.selectedAudioStreamIndexByPath[path] = matchedStoredStream.index;
    return matchedStoredStream.index;
  }
  var probeDefault = probePayload.default_audio_stream_index;
  if (typeof probeDefault === 'number' && audioStreams.some(function (stream) { return stream.index === probeDefault; })) {
    ctx.state.selectedAudioStreamIndexByPath[path] = probeDefault;
    var defaultStream = audioStreams.find(function (stream) { return stream.index === probeDefault; }) || null;
    if (defaultStream) setStoredAudioTrackPreference(layoutKey, audioTrackPreferenceDescriptor(audioStreams, defaultStream));
    return probeDefault;
  }
  var fallback = audioStreams[0].index;
  ctx.state.selectedAudioStreamIndexByPath[path] = fallback;
  setStoredAudioTrackPreference(layoutKey, audioTrackPreferenceDescriptor(audioStreams, audioStreams[0]));
  return fallback;
}

function renderAudioTrackSelector(item, probePayload) {
  var select = ctx.els.audioTrackSelectEl;
  if (!select) return;
  if (!item) {
    setAudioTrackPlaceholder('No video selected');
    return;
  }
  if (!probePayload) {
    var failed = Boolean(ctx.state.probeFailures[item.path || '']);
    setAudioTrackPlaceholder(failed ? 'Audio tracks unavailable' : 'Loading audio tracks...');
    return;
  }
  var audioStreams = Array.isArray(probePayload.audio_streams) ? probePayload.audio_streams : [];
  if (!audioStreams.length) {
    setAudioTrackPlaceholder('No audio tracks found');
    return;
  }
  var selected = selectedAudioStreamIndex(item, probePayload);
  select.innerHTML = '';
  audioStreams.forEach(function (stream) {
    var option = document.createElement('option');
    option.value = String(stream.index);
    option.textContent = audioTrackLabel(stream);
    if (selected === stream.index) option.selected = true;
    select.appendChild(option);
  });
  select.disabled = false;
  syncAudioTrackSummary('No audio tracks found');
}

function selectedSubtitleStreamIndex(item, probePayload) {
  if (!item || !probePayload) return '';
  var path = item.path || '';
  var subtitleStreams = ctx.subtitleStreamsForPayload(probePayload);
  var layoutKey;
  var storedPreference;
  var matchedStoredStream;
  if (!subtitleStreams.length) return '';
  var saved = ctx.state.selectedSubtitleStreamIndexByPath[path];
  if (saved === '') return '';
  if (typeof saved === 'number' && subtitleStreams.some(function (stream) { return stream.index === saved; })) {
    return saved;
  }
  layoutKey = subtitleTrackLayoutKey(probePayload);
  storedPreference = ctx.state.subtitleTrackPreferenceByLayout[layoutKey];
  if (storedPreference && typeof storedPreference === 'object' && storedPreference.off) {
    ctx.state.selectedSubtitleStreamIndexByPath[path] = '';
    return '';
  }
  matchedStoredStream = resolvePreferredTrackByDescriptor(subtitleStreams, storedPreference, subtitleTrackPreferenceSignature);
  if (matchedStoredStream) {
    ctx.state.selectedSubtitleStreamIndexByPath[path] = matchedStoredStream.index;
    return matchedStoredStream.index;
  }
  if (probePayload.subtitle_off_default && saved === undefined) {
    setStoredSubtitleTrackPreference(layoutKey, {off: true});
    return '';
  }
  var probeDefault = probePayload.default_subtitle_stream_index;
  if (typeof probeDefault === 'number' && subtitleStreams.some(function (stream) { return stream.index === probeDefault; })) {
    ctx.state.selectedSubtitleStreamIndexByPath[path] = probeDefault;
    var defaultSubtitleStream = subtitleStreams.find(function (stream) { return stream.index === probeDefault; }) || null;
    if (defaultSubtitleStream) {
      setStoredSubtitleTrackPreference(layoutKey, subtitleTrackPreferenceDescriptor(subtitleStreams, defaultSubtitleStream));
    }
    return probeDefault;
  }
  ctx.state.selectedSubtitleStreamIndexByPath[path] = '';
  setStoredSubtitleTrackPreference(layoutKey, {off: true});
  return '';
}

function renderSubtitleTrackSelector(item, probePayload) {
  var select = ctx.els.subtitleTrackSelectEl;
  if (!select) return;
  if (!item) {
    setSubtitleTrackPlaceholder('No video selected');
    return;
  }
  if (!probePayload) {
    var failed = Boolean(ctx.state.probeFailures[item.path || '']);
    setSubtitleTrackPlaceholder(failed ? 'Subtitle tracks unavailable' : 'Loading subtitle tracks...');
    return;
  }
  var subtitleStreams = ctx.subtitleStreamsForPayload(probePayload);
  if (!subtitleStreams.length) {
    setSubtitleTrackPlaceholder('No subtitle tracks found');
    return;
  }
  var selected = selectedSubtitleStreamIndex(item, probePayload);
  select.innerHTML = '';
  var offOption = document.createElement('option');
  offOption.value = '';
  offOption.textContent = 'Subtitles Off';
  if (selected === '') offOption.selected = true;
  select.appendChild(offOption);
  subtitleStreams.forEach(function (stream) {
    var option = document.createElement('option');
    option.value = String(stream.index);
    option.textContent = subtitleTrackLabel(stream);
    if (selected === stream.index) option.selected = true;
    select.appendChild(option);
  });
  select.disabled = false;
  syncSubtitleTrackSummary('Subtitles Off');
}

async function handleAudioTrackChange() {
  var active = ctx.activeQueueItem();
  var select = ctx.els.audioTrackSelectEl;
  if (!active || !select || select.disabled) return;
  var nextValue = select.value;
  if (!nextValue) return;
  ctx.state.selectedAudioStreamIndexByPath[active.path || ''] = Number(nextValue);
  persistAudioSelectionFromUi(active);
  syncAudioTrackSummary('No audio tracks found');
  ctx.state.pendingAutoplay = true;
  ctx.state.transportWantsPlay = true;
  ctx.setStatus('Restarting compatibility playback for the selected audio track.');
  await ctx.restartCompatibilityAt(ctx.currentGlobalPlaybackSeconds(), 'audio-track-change');
}

async function handleSubtitleTrackChange() {
  var active = ctx.activeQueueItem();
  var select = ctx.els.subtitleTrackSelectEl;
  if (!active || !select || select.disabled) return;
  var path = active.path || '';
  var nextValue = select.value;
  var probePayload = ctx.state.probeCache[path] || null;
  var previousSelectedValue = ctx.state.selectedSubtitleStreamIndexByPath[path];
  var previousSelectedStream = ctx.subtitleStreamsForPayload(probePayload).find(function (stream) {
    return typeof previousSelectedValue === 'number'
      && ctx.normalizeSubtitleStreamIndex(stream.index) === ctx.normalizeSubtitleStreamIndex(previousSelectedValue);
  }) || null;
  ctx.state.selectedSubtitleStreamIndexByPath[path] = nextValue ? Number(nextValue) : '';
  ctx.persistSubtitleSelectionFromUi(active);
  syncSubtitleTrackSummary('Subtitles Off');
  if (!nextValue) {
    if (
      ctx.compatibilitySessionHasBurnedInSubtitles()
      || (previousSelectedStream && ctx.subtitleStreamRequiresBurnIn(previousSelectedStream))
    ) {
      ctx.state.compatibilitySubtitleStreamIndex = null;
      ctx.state.pendingAutoplay = true;
      ctx.state.transportWantsPlay = true;
      ctx.setStatus('Restarting compatibility playback without subtitles.');
      await ctx.restartCompatibilityAt(ctx.currentGlobalPlaybackSeconds(), 'subtitle-track-change');
      return;
    }
    ctx.clearSubtitleTrack();
    ctx.state.compatibilitySubtitleStreamIndex = null;
    ctx.setStatus('Subtitles turned off.');
    return;
  }
  if (ctx.state.seekRestartInProgress) {
    ctx.setStatus('Subtitle track will load when playback seek completes.');
    return;
  }
  var selectedStream = ctx.selectedSubtitleStream(active, probePayload);
  if (selectedStream && ctx.subtitleStreamRequiresBurnIn(selectedStream)) {
    ctx.clearSubtitleTrack();
    ctx.state.pendingAutoplay = true;
    ctx.state.transportWantsPlay = true;
    ctx.setStatus('Restarting compatibility playback for burned-in subtitles.');
    await ctx.restartCompatibilityAt(ctx.currentGlobalPlaybackSeconds(), 'subtitle-track-change');
    return;
  }
  if (ctx.compatibilitySessionHasBurnedInSubtitles()) {
    ctx.state.compatibilitySubtitleStreamIndex = null;
    ctx.state.pendingAutoplay = true;
    ctx.state.transportWantsPlay = true;
    ctx.setStatus('Restarting compatibility playback for sidecar subtitles.');
    await ctx.restartCompatibilityAt(ctx.currentGlobalPlaybackSeconds(), 'subtitle-track-change');
    return;
  }
  var fetchStartSeconds = Math.max(0, ctx.state.compatibilityStartSeconds || 0);
  var coverageTargetSeconds = Math.max(0, ctx.currentGlobalPlaybackSeconds() || 0);
  var streamIndex = Number(nextValue);
  if (ctx.subtitlesAreMounted(active, streamIndex, fetchStartSeconds, coverageTargetSeconds)) {
    ctx.setStatus('Subtitle track is ready.');
    return;
  }
  if (ctx.mountSubtitleTrackForItem(active, probePayload, streamIndex, fetchStartSeconds, {
    silent: true,
    coverageTargetSeconds: coverageTargetSeconds,
  })) {
    ctx.setStatus('Subtitle track is ready.');
    return;
  }
  ctx.setStatus('Loading subtitle track.');
  await ctx.applySubtitlesForSeek(active, probePayload, fetchStartSeconds, {
    reloadReason: 'subtitle-track-change',
    coverageTargetSeconds: coverageTargetSeconds,
  });
}

  ctx.persistAudioSelectionFromUi = persistAudioSelectionFromUi;
  ctx.audioTrackLabel = audioTrackLabel;
  ctx.subtitleTrackLabel = subtitleTrackLabel;
  ctx.normalizedTrackLanguage = normalizedTrackLanguage;
  ctx.trackTitleTokens = trackTitleTokens;
  ctx.audioTrackRole = audioTrackRole;
  ctx.subtitleTrackRole = subtitleTrackRole;
  ctx.audioTrackPreferenceSignature = audioTrackPreferenceSignature;
  ctx.subtitleTrackPreferenceSignature = subtitleTrackPreferenceSignature;
  ctx.preferenceOrdinalForTrack = preferenceOrdinalForTrack;
  ctx.audioTrackPreferenceDescriptor = audioTrackPreferenceDescriptor;
  ctx.subtitleTrackPreferenceDescriptor = subtitleTrackPreferenceDescriptor;
  ctx.resolvePreferredTrackByDescriptor = resolvePreferredTrackByDescriptor;
  ctx.encodeTrackPreferenceLayout = encodeTrackPreferenceLayout;
  ctx.audioTrackLayoutKey = audioTrackLayoutKey;
  ctx.subtitleTrackLayoutKey = subtitleTrackLayoutKey;
  ctx.loadStoredTrackPreferences = loadStoredTrackPreferences;
  ctx.saveStoredTrackPreferences = saveStoredTrackPreferences;
  ctx.setStoredAudioTrackPreference = setStoredAudioTrackPreference;
  ctx.setStoredSubtitleTrackPreference = setStoredSubtitleTrackPreference;
  ctx.selectedOptionLabel = selectedOptionLabel;
  ctx.syncTrackSummaryValue = syncTrackSummaryValue;
  ctx.syncAudioTrackSummary = syncAudioTrackSummary;
  ctx.syncSubtitleTrackSummary = syncSubtitleTrackSummary;
  ctx.syncTrackSummary = syncTrackSummary;
  ctx.setAudioTrackPlaceholder = setAudioTrackPlaceholder;
  ctx.setSubtitleTrackPlaceholder = setSubtitleTrackPlaceholder;
  ctx.selectedAudioStreamIndex = selectedAudioStreamIndex;
  ctx.renderAudioTrackSelector = renderAudioTrackSelector;
  ctx.selectedSubtitleStreamIndex = selectedSubtitleStreamIndex;
  ctx.renderSubtitleTrackSelector = renderSubtitleTrackSelector;
  ctx.handleAudioTrackChange = handleAudioTrackChange;
  ctx.handleSubtitleTrackChange = handleSubtitleTrackChange;

  if (ctx.els.audioTrackSelectEl) {
    ctx.els.audioTrackSelectEl.addEventListener('change', function () {
      void handleAudioTrackChange();
    });
  }
  if (ctx.els.subtitleTrackSelectEl) {
    ctx.els.subtitleTrackSelectEl.addEventListener('change', function () {
      void handleSubtitleTrackChange();
    });
  }
}
