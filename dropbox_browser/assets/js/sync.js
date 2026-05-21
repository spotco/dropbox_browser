(function () {
  var enableToLocal = document.getElementById('enable-to-local');
  var enableWriteDropbox = document.getElementById('enable-write-dropbox');
  var popup = document.getElementById('sync-popup');
  var hide = document.getElementById('sync-popup-hide');
  var message = document.getElementById('sync-popup-message');
  var command = document.getElementById('sync-popup-command');
  var bar = document.getElementById('sync-progress-bar');
  var batchConfirm = document.getElementById('batch-confirm');
  var batchSummary = document.getElementById('batch-confirm-summary');
  var batchList = document.getElementById('batch-confirm-list');
  var batchRun = document.getElementById('batch-confirm-run');
  var batchCancel = document.getElementById('batch-confirm-cancel');
  var batchRecursive = document.getElementById('batch-recursive');
  var pageState = document.body ? document.body.dataset : {};
  var pendingBatch = null;
  var syncBusyCount = 0;
  var activeSyncForm = null;

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function labelForDirection(direction) {
    if (direction === 'local_to_dropbox') return 'Copy Local -> Dropbox';
    return 'Copy Dropbox -> Local';
  }

  function directionsForStatus(status) {
    if (status === 'Local Only') return ['local_to_dropbox'];
    if (status === 'Dropbox Only') return ['dropbox_to_local'];
    if (status === 'Has Diffs') return ['local_to_dropbox', 'dropbox_to_local'];
    return [];
  }

  function renderCell(relPath, kind, status) {
    if (kind !== 'file') return '';
    return directionsForStatus(status).map(function (direction) {
      return '<form class="sync-form" data-sync-direction="' + esc(direction) + '" action="/sync" method="post">' +
        '<input type="hidden" name="path" value="' + esc(relPath) + '">' +
        '<input type="hidden" name="kind" value="' + esc(kind) + '">' +
        '<input type="hidden" name="direction" value="' + esc(direction) + '">' +
        '<input type="hidden" name="enable_to_local" value="0">' +
        '<input type="hidden" name="enable_write_dropbox" value="0">' +
        '<button type="submit">' + esc(labelForDirection(direction)) + '</button>' +
        '</form>';
    }).join('');
  }

  window.SyncControls = { renderCell: renderCell };

  function applySyncBusyState() {
    var busy = syncBusyCount > 0;
    document.querySelectorAll('.sync-form button, .batch-sync, #batch-confirm-run, #batch-confirm-cancel').forEach(function (button) {
      var baseDisabled = button.getAttribute('data-base-disabled') === '1';
      button.disabled = busy || baseDisabled;
    });
  }

  function setSyncBusy(busy) {
    syncBusyCount = busy ? (syncBusyCount + 1) : Math.max(0, syncBusyCount - 1);
    applySyncBusyState();
  }

  function setBaseDisabled(button, disabled) {
    if (!button) return;
    button.setAttribute('data-base-disabled', disabled ? '1' : '0');
    applySyncBusyState();
  }

  function clearActiveSyncForm() {
    if (!activeSyncForm) return;
    activeSyncForm.removeAttribute('data-sync-running');
    activeSyncForm = null;
  }

  function applyToggle() {
    var toLocal = !!(enableToLocal && enableToLocal.checked);
    var writeDropbox = !!(enableWriteDropbox && enableWriteDropbox.checked);
    document.body.classList.toggle('sync-to-local-enabled', toLocal);
    document.body.classList.toggle('sync-to-dropbox-enabled', writeDropbox);
    document.querySelectorAll('input[name="enable_to_local"]').forEach(function (input) {
      input.value = toLocal ? '1' : '0';
    });
    document.querySelectorAll('input[name="enable_write_dropbox"]').forEach(function (input) {
      input.value = writeDropbox ? '1' : '0';
    });
  }

  if (enableToLocal) {
    enableToLocal.checked = Settings.get('sync-enable-to-local', false);
    enableToLocal.addEventListener('change', function () {
      Settings.set('sync-enable-to-local', enableToLocal.checked);
      applyToggle();
    });
  }
  if (enableWriteDropbox) {
    enableWriteDropbox.checked = Settings.get('sync-enable-write-dropbox', false);
    enableWriteDropbox.addEventListener('change', function () {
      Settings.set('sync-enable-write-dropbox', enableWriteDropbox.checked);
      applyToggle();
    });
  }
  applyToggle();

  if (hide) {
    hide.addEventListener('click', function () {
      popup.classList.add('hidden');
    });
  }

  function showPopup(text, cmd) {
    if (!popup) return;
    popup.classList.remove('hidden');
    message.textContent = text;
    command.textContent = cmd || '';
    bar.className = 'running';
    bar.style.background = '#174a7c';
    bar.style.marginLeft = '';
    bar.style.width = '';
  }

  function finishPopup(text, cmd, ok) {
    if (!popup) return;
    popup.classList.remove('hidden');
    message.textContent = text;
    command.textContent = cmd || '';
    bar.className = '';
    bar.style.marginLeft = '0';
    bar.style.width = '100%';
    bar.style.background = ok ? '#17633a' : '#8a1f1f';
  }

  function finishPopupTemporary(text, cmd, ok) {
    finishPopup(text, cmd, ok);
    setTimeout(function () {
      if (!popup) return;
      popup.classList.add('hidden');
    }, 1800);
  }

  function gateParams() {
    return {
      enable_to_local: enableToLocal && enableToLocal.checked ? '1' : '0',
      enable_write_dropbox: enableWriteDropbox && enableWriteDropbox.checked ? '1' : '0'
    };
  }

  function formBody(fields) {
    var params = new URLSearchParams();
    Object.keys(fields).forEach(function (key) { params.set(key, fields[key]); });
    return params;
  }

  function submitDownload(url, fields) {
    var form = document.createElement('form');
    form.method = 'post';
    form.action = url;
    form.style.display = 'none';
    Object.keys(fields).forEach(function (key) {
      var input = document.createElement('input');
      input.type = 'hidden';
      input.name = key;
      input.value = fields[key];
      form.appendChild(input);
    });
    document.body.appendChild(form);
    form.submit();
    document.body.removeChild(form);
  }

  function groupTitle(key) {
    if (key === 'local_dir_to_dropbox') return 'Create Dropbox Folders';
    if (key === 'local_to_dropbox') return 'Copy Local -> Dropbox';
    if (key === 'dropbox_dir_to_local') return 'Create Local Folders';
    if (key === 'dropbox_to_local') return 'Copy Dropbox -> Local';
    return key;
  }

  function renderPlan(plan) {
    batchSummary.textContent = plan.total + ' item(s) will be affected.';
    var html = '';
    ['local_dir_to_dropbox', 'local_to_dropbox', 'dropbox_dir_to_local', 'dropbox_to_local'].forEach(function (key) {
      var items = (plan.groups && plan.groups[key]) || [];
      if (!items.length) return;
      html += '<h3>' + esc(groupTitle(key)) + ' (' + items.length + ')</h3><ul>';
      items.forEach(function (item) {
        html += '<li>' + esc(item.path) + '</li>';
      });
      html += '</ul>';
    });
    batchList.innerHTML = html || '<p>No items will be changed.</p>';
    setBaseDisabled(batchRun, !plan.total);
  }

  function pollPlanStatus(id, fields) {
    fetch('/sync-status?id=' + encodeURIComponent(id))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var progressText = data.current && data.total ? '[' + data.current + '/' + data.total + '] ' : '';
        message.textContent = progressText + (data.message || 'Batch planning');
        command.textContent = data.command || data.label || ('Preparing recursive scan for ' + (fields.path || '/'));
        if (data.status === 'complete') {
          if (!data.plan || !data.plan_token) throw new Error('Batch plan response was incomplete');
          pendingBatch = Object.assign({}, fields, { plan_token: data.plan_token });
          renderPlan(data.plan);
          batchConfirm.classList.remove('hidden');
          finishPopup(data.message || 'Batch plan complete', data.command || data.label || '', true);
          setSyncBusy(false);
          return;
        }
        if (data.status === 'error') {
          finishPopup(data.message || 'Batch plan failed', data.command || data.label || '', false);
          setSyncBusy(false);
          return;
        }
        setTimeout(function () { pollPlanStatus(id, fields); }, 300);
      })
      .catch(function (err) {
        finishPopup(err.message || 'Batch plan failed', '', false);
        setSyncBusy(false);
      });
  }

  function openBatchConfirm(action) {
    var gates = gateParams();
    var fields = {
      path: pageState.currentFolderPath || '',
      action: action,
      recursive: batchRecursive && batchRecursive.checked ? '1' : '0',
      enable_to_local: gates.enable_to_local,
      enable_write_dropbox: gates.enable_write_dropbox
    };
    setSyncBusy(true);
    showPopup('Batch planning', 'Preparing recursive scan for ' + (fields.path || '/'));
    fetch('/sync-batch-plan', { method: 'POST', body: formBody(fields) })
      .then(function (r) {
        if (!r.ok) throw new Error('Could not start batch plan');
        return r.json();
      })
      .then(function (payload) {
        pollPlanStatus(payload.id, fields);
      })
      .catch(function (err) {
        finishPopup(err.message || 'Batch plan failed', '', false);
        setSyncBusy(false);
      });
  }

  function pollStatus(id) {
    fetch('/sync-status?id=' + encodeURIComponent(id))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        command.textContent = data.command || data.label || '';
        if (data.status === 'complete') {
          clearActiveSyncForm();
          setSyncBusy(false);
          var msg = data.message || 'Sync complete';
          if (data.errors && data.errors.length) msg += ': ' + data.errors.join('; ');
          finishPopup(msg, data.command || data.label || '', data.errors && data.errors.length ? false : true);
          setTimeout(function () { window.location.reload(); }, 700);
          return;
        }
        if (data.status === 'error') {
          clearActiveSyncForm();
          setSyncBusy(false);
          finishPopup(data.message || 'Sync failed', data.command || data.label || '', false);
          return;
        }
        var progressText = data.current && data.total ? '[' + data.current + '/' + data.total + '] ' : '';
        message.textContent = progressText + (data.message || 'Sync running');
        setTimeout(function () { pollStatus(id); }, 800);
      })
      .catch(function () { setTimeout(function () { pollStatus(id); }, 1500); });
  }

  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form || !form.classList || !form.classList.contains('sync-form')) return;
    event.preventDefault();
    var direction = form.getAttribute('data-sync-direction') || '';
    if (direction === 'local_to_dropbox' && (!enableWriteDropbox || !enableWriteDropbox.checked)) return;
    if (direction === 'dropbox_to_local' && (!enableToLocal || !enableToLocal.checked)) return;
    if (syncBusyCount > 0) return;
    if (form.getAttribute('data-sync-running') === '1') return;
    applyToggle();
    activeSyncForm = form;
    activeSyncForm.setAttribute('data-sync-running', '1');
    setSyncBusy(true);
    var data = new FormData(form);
    var cmd = labelForDirection(data.get('direction')) + ': ' + data.get('path');
    showPopup('Sync running', cmd);
    fetch('/sync', {
      method: 'POST',
      body: new URLSearchParams(data)
    })
      .then(function (r) {
        if (!r.ok) throw new Error('Sync request failed');
        return r.json();
      })
      .then(function (payload) { pollStatus(payload.id); })
      .catch(function (err) {
        clearActiveSyncForm();
        setSyncBusy(false);
        finishPopup(err.message || 'Sync failed', cmd, false);
      });
  });

  document.addEventListener('click', function (event) {
    var button = event.target;
    if (!button || !button.classList || !button.classList.contains('batch-sync')) return;
    if (syncBusyCount > 0) return;
    var action = button.getAttribute('data-batch-action') || '';
    if (action === 'local_to_dropbox_all' && (!enableWriteDropbox || !enableWriteDropbox.checked)) return;
    if (action === 'dropbox_only_to_local_all' && (!enableToLocal || !enableToLocal.checked)) return;
    if (action === 'download_local_only_delete_bat') {
      if (!enableToLocal || !enableToLocal.checked) return;
      submitDownload('/local-only-delete-bat', {
        path: pageState.currentFolderPath || '',
        recursive: batchRecursive && batchRecursive.checked ? '1' : '0',
        enable_to_local: '1'
      });
      finishPopupTemporary('Batch file download started', 'Review the downloaded .bat before running it.', true);
      return;
    }
    openBatchConfirm(action);
  });

  if (batchCancel) {
    batchCancel.addEventListener('click', function () {
      pendingBatch = null;
      batchConfirm.classList.add('hidden');
    });
  }

  if (batchRun) {
    batchRun.addEventListener('click', function () {
      if (syncBusyCount > 0) return;
      if (!pendingBatch) return;
      setSyncBusy(true);
      batchConfirm.classList.add('hidden');
      showPopup('Batch sync starting', '');
      fetch('/sync-batch', { method: 'POST', body: formBody(pendingBatch) })
        .then(function (r) {
          if (!r.ok) throw new Error('Batch sync request failed');
          return r.json();
        })
        .then(function (payload) { pollStatus(payload.id); })
        .catch(function (err) {
          setSyncBusy(false);
          finishPopup(err.message || 'Batch sync failed', '', false);
        });
    });
  }

  document.addEventListener('click', function (event) {
    var button = event.target;
    if (!button || !button.classList || !button.classList.contains('copy-path')) return;
    var path = button.getAttribute('data-copy-path') || '';
    if (!path) return;

    function markCopied() {
      var original = button.textContent;
      button.textContent = 'Copied';
      button.classList.add('copied');
      setTimeout(function () {
        button.textContent = original;
        button.classList.remove('copied');
      }, 1200);
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(path).then(markCopied).catch(function () {});
    } else {
      var input = document.createElement('textarea');
      input.value = path;
      input.setAttribute('readonly', '');
      input.style.position = 'fixed';
      input.style.left = '-9999px';
      document.body.appendChild(input);
      input.select();
      try {
        document.execCommand('copy');
        markCopied();
      } catch (e) {}
      document.body.removeChild(input);
    }
  });
}());
