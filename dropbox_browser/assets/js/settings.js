var Settings = (function () {
  var PREFIX = 'dropbox-browser.';
  return {
    get: function (key, defaultVal) {
      try {
        var v = localStorage.getItem(PREFIX + key);
        return v === null ? defaultVal : JSON.parse(v);
      } catch (e) { return defaultVal; }
    },
    set: function (key, val) {
      try { localStorage.setItem(PREFIX + key, JSON.stringify(val)); } catch (e) {}
    }
  };
}());
