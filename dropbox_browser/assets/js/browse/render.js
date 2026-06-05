function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderCopyButton(row) {
  if (!row.local_copy_path) return '';
  var label = row.kind === 'folder' ? 'Copy Folder Path' : 'Copy Filepath';
  return '<button type="button" class="copy-path" data-copy-path="' + esc(row.local_copy_path) + '">' +
    label +
    '</button>';
}

function renderSyncCell(row) {
  var attrs = ' data-sync-path="' + esc(row.path) + '" data-sync-kind="' + esc(row.kind) + '"';
  var html = '';
  if (row.sync && row.sync.allowed && window.SyncControls && typeof window.SyncControls.renderCell === 'function') {
    html = window.SyncControls.renderCell(row.path, row.kind, row.status_label);
  }
  return '<td class="sync"' + attrs + '>' + html + '</td>';
}

function renderNameCell(row) {
  var href = row.kind === 'folder' ? row.folder_href : row.preview_href;
  return '<a class="name" href="' + esc(href) + '" title="' + esc(row.display_name) + '">' +
    '<img class="file-icon" src="' + esc(row.icon_href) + '" alt="" aria-hidden="true" loading="lazy">' +
    '<span class="entry-name">' + esc(row.display_name) + '</span>' +
    '</a>';
}

function renderViewCell(row) {
  var copyButton = renderCopyButton(row);
  if (row.kind === 'folder') {
    return '<td class="view-actions">' + copyButton + '</td>';
  }
  var preview = '<a href="' + esc(row.preview_href) + '">Preview</a>';
  var download = '<a href="' + esc(row.download_href) + '">Download</a>';
  return '<td class="view-actions">' + preview + ' ' + download + copyButton + '</td>';
}

function renderFolderMetadataCell(row, kind) {
  if (row.kind !== 'folder') {
    return kind === 'size' ? esc(row.size_display) : esc(row.date_display || '');
  }
  if (row.remote && !row.metadata_complete && row.size_display === '—' && !row.date_display) {
    return '<span class="folder-pending"><span class="spinner"></span> calculating…</span>';
  }
  var prefix = row.metadata_complete ? '' : '<span class="spinner"></span> ';
  if (kind === 'size') {
    var sizeText = esc(row.size_display);
    if (row.count_display) {
      sizeText += ' <span style="color:#607080">(' + esc(row.count_display) + ')</span>';
    }
    return prefix + sizeText;
  }
  return prefix + esc(row.date_display || '');
}

function renderBrowseRow(row) {
  var attrs = [
    ' data-browse-row-id="' + esc(row.id) + '"',
    ' data-row-kind="' + esc(row.kind) + '"',
    ' data-sort-name="' + esc(row.sort_name) + '"',
    ' data-sort-date="' + esc(row.sort_date) + '"',
  ];
  if (row.kind === 'folder' && row.remote) {
    attrs.push(' data-folder-path="' + esc(row.path) + '"');
  }
  if (row.kind === 'file' && row.remote && row.local) {
    attrs.push(' data-file-status-path="' + esc(row.path) + '"');
  }
  return '<tr' + attrs.join('') + '>' +
    '<td>' + renderNameCell(row) + '</td>' +
    '<td>' + esc(row.type_label) + '</td>' +
    '<td><span class="status ' + esc(row.status_class) + '">' + esc(row.status_label) + '</span></td>' +
    '<td class="col-size">' + renderFolderMetadataCell(row, 'size') + '</td>' +
    '<td class="col-date">' + renderFolderMetadataCell(row, 'date') + '</td>' +
    renderViewCell(row) +
    renderSyncCell(row) +
    '</tr>';
}

function renderSpacerRow(height) {
  if (!height) return '';
  return '<tr class="browse-virtual-spacer" aria-hidden="true">' +
    '<td colspan="7" style="height:' + esc(height) + 'px"></td>' +
    '</tr>';
}

export function loadingRowHtml(message) {
  return '<tr><td colspan="7" class="empty">' + esc(message || 'Loading folder listing...') + '</td></tr>';
}

export function errorRowHtml(message) {
  return '<tr><td colspan="7" class="empty">' + esc(message || 'Could not load folder listing.') + '</td></tr>';
}

export function emptyRowHtml(message) {
  return '<tr><td colspan="7" class="empty">' + esc(message || 'This folder is empty.') + '</td></tr>';
}

export function renderBrowseRowsBody(rows) {
  if (!rows || rows.length === 0) {
    return emptyRowHtml('This folder is empty.');
  }
  return rows.map(renderBrowseRow).join('');
}

export function renderVirtualBrowseRowsBody(rows, windowState) {
  if (!rows || rows.length === 0) {
    return renderBrowseRowsBody(rows);
  }
  var startIndex = Math.max(0, Number(windowState && windowState.startIndex) || 0);
  var endIndex = Math.min(rows.length, Number(windowState && windowState.endIndex) || rows.length);
  var slice = rows.slice(startIndex, endIndex);
  return renderSpacerRow(windowState && windowState.topSpacerHeight) +
    slice.map(renderBrowseRow).join('') +
    renderSpacerRow(windowState && windowState.bottomSpacerHeight);
}

export function renderBreadcrumbs(items) {
  if (!Array.isArray(items) || items.length === 0) return '<a href="/">Dropbox</a>';
  return items.map(function (item) {
    return '<a href="' + esc(item.href) + '">' + esc(item.name) + '</a>';
  }).join(' / ');
}
