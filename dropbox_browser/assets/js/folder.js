import {compareFilenameKeys, filenameCompareKey} from './filename-compare-key.js';

(function () {
  var pageState = document.body ? document.body.dataset : {};
  var folderRows = {};
  document.querySelectorAll('tr[data-folder-path]').forEach(function (row) {
    folderRows[row.getAttribute('data-folder-path')] = row;
  });
  var currentFolderPath = pageState.currentFolderPath || '';
  var currentSortKey = pageState.currentSortKey || 'name';
  var currentSortDirection = pageState.currentSortDirection || 'asc';
  var fileStatusCells = {};
  document.querySelectorAll('tr[data-file-status-path]').forEach(function (row) {
    var cell = row.querySelector('.status');
    if (cell) fileStatusCells[row.getAttribute('data-file-status-path')] = cell;
  });
  var pending = Object.keys(folderRows);
  var pollCurrent = Object.keys(fileStatusCells).length > 0;
  if (pending.length === 0 && !pollCurrent) return;

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  var spinnerHtml = '<span class="spinner"></span> ';

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
    cell.className = classForLabel(label);
    cell.textContent = label;
  }

  function findSyncCell(relPath) {
    var cells = document.querySelectorAll('.sync[data-sync-path]');
    for (var i = 0; i < cells.length; i++) {
      if (cells[i].getAttribute('data-sync-path') === relPath) return cells[i];
    }
    return null;
  }

  function reorderFolderRows() {
    if (currentSortKey !== 'date') return;
    var tbody = document.querySelector('tbody');
    if (!tbody) return;
    var rows = Array.prototype.slice.call(tbody.querySelectorAll('tr[data-row-kind="folder"]'));
    if (rows.length < 2) return;
    rows.sort(function (a, b) {
      var aDate = parseFloat(a.getAttribute('data-sort-date') || '0');
      var bDate = parseFloat(b.getAttribute('data-sort-date') || '0');
      if (aDate !== bDate) {
        return currentSortDirection === 'desc' ? bDate - aDate : aDate - bDate;
      }
      var aLink = a.querySelector('td a');
      var bLink = b.querySelector('td a');
      var aKey = filenameCompareKey(aLink ? aLink.textContent : '');
      var bKey = filenameCompareKey(bLink ? bLink.textContent : '');
      var nameOrder = compareFilenameKeys(aKey, bKey);
      return currentSortDirection === 'desc' ? -nameOrder : nameOrder;
    });
    var firstFileRow = tbody.querySelector('tr[data-row-kind="file"]');
    rows.forEach(function (row) {
      tbody.insertBefore(row, firstFileRow);
    });
  }

  function applyResult(relPath, info) {
    var row = folderRows[relPath];
    if (!row) return;
    var sizeCell = row.querySelector('.col-size');
    var dateCell = row.querySelector('.col-date');
    var statusCell = row.querySelector('.status');
    var prefix = info.complete ? '' : spinnerHtml;
    if (statusCell && info.diff_complete) {
      var label = labelForDiff(info.diff_status);
      applyStatusCell(statusCell, label);
      var syncCell = findSyncCell(relPath);
      if (syncCell && window.SyncControls) syncCell.innerHTML = window.SyncControls.renderCell(relPath, 'folder', label);
    }
    if (sizeCell) {
      var sizeText = esc(info.size_display || '—');
      if (info.count_display) sizeText += ' <span style="color:#607080">(' + esc(info.count_display) + ')</span>';
      sizeCell.innerHTML = prefix + sizeText;
    }
    if (dateCell) dateCell.innerHTML = prefix + esc(info.date_display || '');
    row.setAttribute('data-sort-date', String(info.date_sort_value || 0));
    reorderFolderRows();
  }

  function applyCurrent(info) {
    if (!info || !info.file_statuses) return;
    Object.keys(fileStatusCells).forEach(function (relPath) {
      var name = relPath.split('/').pop();
      var statusInfo = info.file_statuses[name];
      if (statusInfo) {
        var label = labelForDiff(statusInfo.diff_status);
        applyStatusCell(fileStatusCells[relPath], label);
        var syncCell = findSyncCell(relPath);
        if (syncCell && window.SyncControls) syncCell.innerHTML = window.SyncControls.renderCell(relPath, 'file', label);
      }
    });
  }

  function poll() {
    if (pending.length === 0 && !pollCurrent) return;
    var parts = [];
    pending.forEach(function (relPath) {
      parts.push('paths=' + encodeURIComponent(relPath));
    });
    parts.push('current=' + encodeURIComponent(currentFolderPath));
    fetch('/folder-info?' + parts.join('&'))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var stillPending = [];
        pending.forEach(function (relPath) {
          var info = data.results[relPath];
          if (!info || info.status === 'unavailable') return;
          if (info.status === 'calculating') {
            stillPending.push(relPath);
          } else {
            // 'partial' or 'complete' — both have display data
            applyResult(relPath, info);
            if (!info.complete) stillPending.push(relPath);
          }
        });
        if (pollCurrent) {
          var currentInfo = data.results[currentFolderPath];
          applyCurrent(currentInfo);
          pollCurrent = !!(currentInfo && (currentInfo.status === 'calculating' || currentInfo.diff_status === 'loading'));
        }
        pending = stillPending;
        if (pending.length > 0 || pollCurrent) setTimeout(poll, 2000);
      })
      .catch(function () { if (pending.length > 0 || pollCurrent) setTimeout(poll, 5000); });
  }

  setTimeout(poll, 500);
}());
