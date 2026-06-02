export function buildFolderInfoQuery(paths, currentPath) {
  var params = new URLSearchParams();
  (paths || []).forEach(function (path) {
    if (path) params.append('paths', path);
  });
  params.set('current', currentPath || '');
  return '/folder-info?' + params.toString();
}

function statusClassFromLabel(label) {
  if (label === 'Synced') return 'both';
  if (label === 'Has Diffs') return 'diff';
  if (label === 'Dropbox Only') return 'remote';
  if (label === 'Local Only') return 'local';
  return 'loading';
}

function labelForDiff(status) {
  if (status === 'synced') return 'Synced';
  if (status === 'has_diffs') return 'Has Diffs';
  if (status === 'dropbox_only') return 'Dropbox Only';
  if (status === 'local_only') return 'Local Only';
  return 'Loading';
}

function classForLabel(label) {
  if (label === 'Synced') return 'status both';
  if (label === 'Has Diffs') return 'status diff';
  if (label === 'Dropbox Only') return 'status remote';
  if (label === 'Local Only') return 'status local';
  return 'status loading';
}

function applyStatusCell(cell, label) {
  if (!cell) return;
  cell.className = classForLabel(label);
  cell.textContent = label;
}

function findSyncCell(relPath) {
  var selector = '.sync[data-sync-path="' + CSS.escape(relPath) + '"]';
  return document.querySelector(selector);
}

function reorderFolderRows(currentSortKey, currentSortDirection) {
  if (currentSortKey !== 'date') return;
  var tbody = document.getElementById('browse-rows');
  if (!tbody) return;
  var rows = Array.prototype.slice.call(tbody.querySelectorAll('tr[data-row-kind="folder"]'));
  if (rows.length < 2) return;
  rows.sort(function (left, right) {
    var leftDate = parseFloat(left.getAttribute('data-sort-date') || '0');
    var rightDate = parseFloat(right.getAttribute('data-sort-date') || '0');
    if (leftDate !== rightDate) {
      return currentSortDirection === 'desc' ? rightDate - leftDate : leftDate - rightDate;
    }
    var leftName = left.getAttribute('data-sort-name') || '';
    var rightName = right.getAttribute('data-sort-name') || '';
    return currentSortDirection === 'desc'
      ? rightName.localeCompare(leftName)
      : leftName.localeCompare(rightName);
  });
  var firstFileRow = tbody.querySelector('tr[data-row-kind="file"]');
  rows.forEach(function (row) {
    tbody.insertBefore(row, firstFileRow);
  });
}

function applyFolderResult(relPath, info, state) {
  var stateRow = (state.rows || []).find(function (row) { return row.path === relPath; });
  var row = document.querySelector('tr[data-folder-path="' + CSS.escape(relPath) + '"]');
  if (!row && !stateRow) return false;
  var sizeCell = row ? row.querySelector('.col-size') : null;
  var dateCell = row ? row.querySelector('.col-date') : null;
  var statusCell = row ? row.querySelector('.status') : null;
  var prefix = info.complete ? '' : '<span class="spinner"></span> ';
  var affected = {};
  if (statusCell && info.diff_complete) {
    var label = labelForDiff(info.diff_status);
    applyStatusCell(statusCell, label);
    var syncCell = findSyncCell(relPath);
    if (syncCell && window.SyncControls) syncCell.innerHTML = window.SyncControls.renderCell(relPath, 'folder', label);
    if (stateRow) {
      stateRow.status_label = label;
      stateRow.status_class = statusClassFromLabel(label);
      stateRow.sync = { allowed: false, directions: [] };
      affected.status = true;
    }
  }
  if (sizeCell) {
    var sizeText = info.size_display || '—';
    if (info.count_display) sizeText += ' (' + info.count_display + ')';
    sizeCell.innerHTML = prefix + sizeText;
  }
  if (dateCell) {
    dateCell.innerHTML = prefix + (info.date_display || '');
  }
  if (row) row.setAttribute('data-sort-date', String(info.date_sort_value || 0));
  if (stateRow) {
    stateRow.size_display = info.size_display || '—';
    stateRow.count_display = info.count_display || '';
    stateRow.date_display = info.date_display || '';
    stateRow.metadata_complete = !!info.complete;
    stateRow.sort_date = Number(info.date_sort_value || 0);
    stateRow.sort_size = Number(info.size_sort_value || 0);
    affected.date = true;
    affected.size = true;
  }
  reorderFolderRows(state.sort, state.dir);
  return affected;
}

function currentFolderPollWaiting(info) {
  if (!info) return false;
  return info.status === 'calculating' || info.diff_status === 'loading';
}

function applyCurrentResult(info, state) {
  if (!info || !info.file_statuses) {
    return {waiting: currentFolderPollWaiting(info), affected: {}};
  }
  var waiting = currentFolderPollWaiting(info);
  var affected = {};
  document.querySelectorAll('tr[data-file-status-path]').forEach(function (row) {
    var relPath = row.getAttribute('data-file-status-path') || '';
    var statusCell = row.querySelector('.status');
    var syncCell = findSyncCell(relPath);
    var name = relPath.split('/').pop();
    var statusInfo = info.file_statuses[name];
    if (!statusInfo) return;
    var label = labelForDiff(statusInfo.diff_status);
    applyStatusCell(statusCell, label);
    if (syncCell && window.SyncControls) syncCell.innerHTML = window.SyncControls.renderCell(relPath, 'file', label);
    if (statusInfo.diff_status === 'loading') waiting = true;
    var stateRow = (state.rows || []).find(function (item) { return item.path === relPath; });
    if (stateRow) {
      stateRow.status_label = label;
      stateRow.status_class = statusClassFromLabel(label);
      affected.status = true;
    }
  });
  return {waiting: waiting, affected: affected};
}

export function startFolderInfoPolling(state, options) {
  var onRowsChanged = options && typeof options.onRowsChanged === 'function' ? options.onRowsChanged : null;
  var pending = Array.isArray(state.pendingMetadataPaths) ? state.pendingMetadataPaths.slice() : [];
  var pollCurrent = !!(state.pollCurrentFileStatuses);
  var stopped = false;
  var timeoutId = null;
  if (pending.length === 0 && !pollCurrent) return function () {};

  function scheduleNext(delayMs) {
    if (stopped) return;
    timeoutId = window.setTimeout(poll, delayMs);
  }

  function poll() {
    if (stopped) return;
    if (pending.length === 0 && !pollCurrent) return;
    fetch(buildFolderInfoQuery(pending, state.path))
      .then(function (response) { return response.json(); })
      .then(function (data) {
        if (stopped) return;
        var results = data.results || {};
        var nextPending = [];
        var affected = {};
        pending.forEach(function (relPath) {
          var info = results[relPath];
          if (!info || info.status === 'unavailable') return;
          if (info.status === 'calculating') {
            nextPending.push(relPath);
            return;
          }
          var folderAffected = applyFolderResult(relPath, info, state) || {};
          Object.keys(folderAffected).forEach(function (key) { affected[key] = true; });
          if (!info.complete) nextPending.push(relPath);
        });
        pending = nextPending;
        if (pollCurrent) {
          var currentUpdate = applyCurrentResult(results[state.path], state);
          pollCurrent = currentUpdate.waiting;
          Object.keys(currentUpdate.affected || {}).forEach(function (key) { affected[key] = true; });
        }
        if (onRowsChanged && Object.keys(affected).length) {
          onRowsChanged(affected);
        }
        if (pending.length > 0 || pollCurrent) {
          scheduleNext(2000);
        }
      })
      .catch(function () {
        if (stopped) return;
        if (pending.length > 0 || pollCurrent) {
          scheduleNext(5000);
        }
      });
  }

  scheduleNext(500);
  return function stopFolderInfoPolling() {
    stopped = true;
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
      timeoutId = null;
    }
  };
}
