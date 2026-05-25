export function clearObject(obj) {
  Object.keys(obj).forEach(function (key) {
    delete obj[key];
  });
}

export function itemCount(data, key) {
  var items = data && data[key];
  return Array.isArray(items) ? items.length : 0;
}

export function plural(count, singular, pluralName) {
  return count + ' ' + (count === 1 ? singular : pluralName);
}

export function setTextOrFallback(el, text, fallback) {
  if (!el) return;
  el.textContent = text || fallback;
}

export function formatPlaybackTime(seconds) {
  var totalSeconds;
  var hours;
  var minutes;
  var secs;
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00:00';
  totalSeconds = Math.floor(seconds);
  hours = Math.floor(totalSeconds / 3600);
  minutes = Math.floor((totalSeconds % 3600) / 60);
  secs = totalSeconds % 60;
  return String(hours).padStart(2, '0') + ':' +
    String(minutes).padStart(2, '0') + ':' +
    String(secs).padStart(2, '0');
}
