(function () {
  function readConfig() {
    var body = document.body;
    var enabled = !body || body.dataset.clientLogEnabled !== '0';
    var subsystems = {};
    if (body && body.dataset.clientLogSubsystems) {
      try {
        subsystems = JSON.parse(body.dataset.clientLogSubsystems) || {};
      }
      catch (_error) {
        subsystems = {};
      }
    }
    return {enabled: enabled, subsystems: subsystems};
  }

  function enabledFor(subsystem) {
    var config = readConfig();
    return Boolean(config.enabled && config.subsystems && config.subsystems[subsystem]);
  }

  function safeDetails(details) {
    if (!details || typeof details !== 'object') return {};
    try {
      return JSON.parse(JSON.stringify(details));
    }
    catch (_error) {
      return {value: String(details)};
    }
  }

  function send(subsystem, level, message, details) {
    if (!enabledFor(subsystem)) return false;
    try {
      var body = new URLSearchParams();
      body.set('subsystem', subsystem);
      body.set('level', level || 'info');
      body.set('message', message || '');
      body.set('url', window.location.href);
      body.set('details', JSON.stringify(safeDetails(details)));
      fetch('/client-log', {
        method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8'},
        body: body.toString(),
        keepalive: true,
      }).catch(function () {});
      return true;
    }
    catch (_error) {
      return false;
    }
  }

  function writeConsole(subsystem, level, message, details) {
    var consoleLevel = level === 'debug' ? 'log' : level;
    if (!window.console || typeof window.console[consoleLevel] !== 'function') return;
    window.console[consoleLevel]('[' + subsystem + '] ' + message, details || {});
  }

  window.ClientLogger = {
    enabledFor: enabledFor,
    log: function (subsystem, level, message, details) {
      if (!enabledFor(subsystem)) return false;
      writeConsole(subsystem, level || 'info', message || '', details || {});
      return send(subsystem, level || 'info', message || '', details || {});
    },
    debug: function (subsystem, message, details) {
      return this.log(subsystem, 'debug', message, details);
    },
    info: function (subsystem, message, details) {
      return this.log(subsystem, 'info', message, details);
    },
    warn: function (subsystem, message, details) {
      return this.log(subsystem, 'warn', message, details);
    },
    error: function (subsystem, message, details) {
      return this.log(subsystem, 'error', message, details);
    }
  };
}());
