from __future__ import annotations

import html
import json
import posixpath
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

from . import APP_TITLE
from .formatting import display_date, file_type, human_size, status_class
from .services import diff_label


def page_html(app: Any, rel_path: str, entries: list[dict[str, Any]], sort_key: str, direction: str, msg: str, folder_cache_map: dict | None = None, current_folder_cache: dict | None = None) -> str:
    rows = "\n".join(entry_row(app, rel_path, entry, folder_cache_map or {}, current_folder_cache or {}) for entry in entries)
    crumbs = breadcrumbs(rel_path)
    upload_action = "/upload?" + urlencode({"path": rel_path})
    refresh_href = "/?" + urlencode({"path": rel_path, "sort": sort_key, "dir": direction, "refresh": "1"})
    local_note = (
        f"Comparing with {html.escape(str(app.local_root))}"
        if app.local_root
        else "Local comparison disabled"
    )
    msg_html = f'<p class="notice">{html.escape(msg)}</p>' if msg else ""
    current_folder_js = json.dumps(rel_path)
    current_local_folder = ""
    if app.local_root:
        current_local_folder = str(app.local_display_path(rel_path) or app.local_root)
    topbar_actions = (
        '<div class="topbar-actions">'
        f'<button type="button" class="copy-path" data-copy-path="{html.escape(current_local_folder)}">Copy Folder Path</button>'
        '<label class="sync-toggle"><input type="checkbox" id="sync-enabled"> Enable sync</label>'
        '</div>'
        if app.local_root
        else ""
    )

    def sort_link(label: str, key: str) -> str:
        next_dir = "desc" if sort_key == key and direction == "asc" else "asc"
        href = "/?" + urlencode({"path": rel_path, "sort": key, "dir": next_dir})
        indicator = " ^" if sort_key == key and direction == "asc" else " v" if sort_key == key else ""
        return f'<a href="{href}">{label}{indicator}</a>'

    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{APP_TITLE}</title>
  <style>{CSS}</style>
</head>
<body>
  <header>
    <h1>{APP_TITLE}</h1>
    <div class="meta">{html.escape(app.remote)} / {html.escape(rel_path)} - {local_note}</div>
  </header>
  <main>
    <div class="topbar">
      <nav class="breadcrumbs">{crumbs} <a class="refresh-link" href="{refresh_href}" title="Bypass listing cache and reload from Dropbox">&#8635; refresh</a></nav>
      {topbar_actions}
    </div>
    {msg_html}
    <form class="upload" action="{upload_action}" method="post" enctype="multipart/form-data">
      <input type="file" name="file" required>
      <button type="submit">Upload New File</button>
      <span>Create-only: existing names are blocked.</span>
    </form>
    <table>
      <thead>
        <tr>
          <th>{sort_link("Name", "name")}</th>
          <th>{sort_link("Type", "type")}</th>
          <th>{sort_link("Status", "status")}</th>
          <th>{sort_link("Size", "size")}</th>
          <th>{sort_link("Date", "date")}</th>
          <th>View</th>
          <th>Sync</th>
        </tr>
      </thead>
      <tbody>{rows or '<tr><td colspan="7" class="empty">This folder is empty.</td></tr>'}</tbody>
    </table>
  </main>
  <div id="sync-popup" class="sync-popup hidden">
    <div class="sync-popup-head">
      <strong>Sync</strong>
      <button type="button" id="sync-popup-hide">Hide</button>
    </div>
    <div id="sync-popup-message">Waiting</div>
    <div id="sync-popup-command"></div>
    <div class="sync-progress"><div id="sync-progress-bar"></div></div>
  </div>
  <div id="log-panel">
    <div id="log-toolbar" onclick="toggleLog()">
      <span id="log-arrow">&#9660;</span>
      <span id="log-title">Server Log</span>
    </div>
    <div id="log-entries"></div>
  </div>
  <script>{SETTINGS_JS}</script>
  <script>{LOG_JS}</script>
  <script>var CURRENT_FOLDER_PATH = {current_folder_js};</script>
  <script>{SYNC_JS}</script>
  <script>{FOLDER_JS}</script>
</body>
</html>"""


def breadcrumbs(rel_path: str) -> str:
    links = ['<a href="/">Dropbox</a>']
    current = ""
    for part in rel_path.split("/"):
        if not part:
            continue
        current = posixpath.join(current, part) if current else part
        href = "/?" + urlencode({"path": current})
        links.append(f'<a href="{href}">{html.escape(part)}</a>')
    return " / ".join(links)


def _sync_buttons(rel_path: str, kind: str, status: str) -> str:
    directions: list[tuple[str, str]] = []
    if status == "Local Only":
        directions.append(("local_to_dropbox", "Copy Local -> Dropbox"))
    elif status == "Dropbox Only":
        directions.append(("dropbox_to_local", "Copy Dropbox -> Local"))
    elif status == "Has Diffs":
        directions.append(("local_to_dropbox", "Copy Local -> Dropbox"))
        directions.append(("dropbox_to_local", "Copy Dropbox -> Local"))
    forms = []
    for direction, label in directions:
        forms.append(
            '<form class="sync-form" action="/sync" method="post">'
            f'<input type="hidden" name="path" value="{html.escape(rel_path)}">'
            f'<input type="hidden" name="kind" value="{html.escape(kind)}">'
            f'<input type="hidden" name="direction" value="{html.escape(direction)}">'
            '<input type="hidden" name="sync_enabled" value="0">'
            f'<button type="submit">{html.escape(label)}</button>'
            '</form>'
        )
    return "".join(forms)


def _sync_cell(rel_path: str, kind: str, status: str, enabled: bool) -> str:
    attrs = f' data-sync-path="{html.escape(rel_path)}" data-sync-kind="{html.escape(kind)}"'
    buttons = _sync_buttons(rel_path, kind, status) if enabled else ""
    return f'<td class="sync"{attrs}>{buttons}</td>'


def _copy_path_button(app: Any, row: dict[str, Any], child_path: str, is_dir: bool) -> str:
    if not app.local_root:
        return ""
    local_path = Path(row.get("local_path") or app.local_display_path(child_path) or (app.local_root / Path(*child_path.split("/"))))
    copy_path = local_path
    label = "Copy Folder Path" if is_dir else "Copy Filepath"
    return (
        f'<button type="button" class="copy-path" data-copy-path="{html.escape(str(copy_path))}">'
        f'{label}'
        '</button>'
    )


def entry_row(app: Any, rel_path: str, row: dict[str, Any], folder_cache_map: dict | None = None, current_folder_cache: dict | None = None) -> str:
    name = row["name"]
    child_path = posixpath.join(rel_path, name) if rel_path else name
    status = row.get("status_label") or ("Both" if row["remote"] and row["local"] else "Dropbox Only" if row["remote"] else "Local Only")
    is_dir = row["is_dir"]
    type_text = file_type(name, is_dir)
    status_attrs = ""
    sync_enabled = bool(app.local_root)

    if is_dir:
        if row["remote"]:
            cached = (folder_cache_map or {}).get(name)
            if app.local_root:
                if not row["local"]:
                    status = "Dropbox Only"
                elif cached is not None and cached.get("diff_complete"):
                    status = diff_label(cached.get("diff_status"))
                else:
                    status = "Loading"
            if cached is not None:
                complete = cached.get("complete", False)
                sz = human_size(cached["size"]) if cached.get("size") is not None else "—"
                ct = f' ({cached["file_count"]:,} files)' if cached.get("file_count") is not None else ""
                spinner = '' if complete else '<span class="spinner"></span> '
                size_td = f'<td class="col-size">{spinner}{html.escape(sz + ct)}</td>'
                date_td = f'<td class="col-date">{spinner}{display_date(cached.get("newest_mtime"))}</td>'
            else:
                pending_cell = '<span class="folder-pending"><span class="spinner"></span> calculating\u2026</span>'
                size_td = f'<td class="col-size">{pending_cell}</td>'
                date_td = f'<td class="col-date">{pending_cell}</td>'
            row_attrs = f' data-folder-path="{html.escape(child_path)}"'
        else:
            if app.local_root:
                status = "Local Only"
            size_td = '<td class="col-size">—</td>'
            date_td = f'<td class="col-date">{display_date(row.get("local_mtime"))}</td>'
            row_attrs = ""
        name_html = f'<a class="name" href="/?{urlencode({"path": child_path})}">[dir] {html.escape(name)}</a>'
        copy_button = _copy_path_button(app, row, child_path, True) if row["local"] else ""
        view_td = f'<td class="view-actions">{copy_button}</td>'
        sync_td = _sync_cell(child_path, "folder", status, sync_enabled)
    else:
        source = "remote" if row["remote"] else "local"
        if app.local_root:
            if not row["remote"]:
                status = "Local Only"
            elif not row["local"]:
                status = "Dropbox Only"
            else:
                file_status = ((current_folder_cache or {}).get("file_statuses") or {}).get(name, {})
                status = diff_label(file_status.get("diff_status"))
                status_attrs = f' data-file-status-path="{html.escape(child_path)}"'
        size = row.get("remote_size") if row.get("remote_size") is not None else row.get("local_size")
        date_value = max(row.get("remote_mtime") or 0, row.get("local_mtime") or 0) or None
        size_td = f'<td class="col-size">{human_size(size or 0)}</td>'
        date_td = f'<td class="col-date">{display_date(date_value)}</td>'
        row_attrs = status_attrs
        query = urlencode({"path": child_path, "source": source})
        name_html = f'<a class="name" href="/file?{query}">{html.escape(name)}</a>'
        copy_button = _copy_path_button(app, row, child_path, False) if row["local"] else ""
        view_td = f'<td class="view-actions"><a href="/file?{query}">Preview</a> <a href="/download?{query}">Download</a>{copy_button}</td>'
        sync_td = _sync_cell(child_path, "file", status, sync_enabled)

    return f"""<tr{row_attrs}>
  <td>{name_html}</td>
  <td>{html.escape(type_text)}</td>
  <td><span class="status {status_class(status)}">{status}</span></td>
  {size_td}
  {date_td}
  {view_td}
  {sync_td}
</tr>"""


def error_html(status: Any, message: str) -> str:
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Error</title><style>{CSS}</style></head>
<body><main><h1>{status.value} {status.phrase}</h1><p class="error">{html.escape(message)}</p><p><a href="/">Back to browser</a></p></main></body></html>"""


CSS = """
:root {
  color-scheme: light;
  font-family: Arial, Helvetica, sans-serif;
  background: #f7f7f4;
  color: #1f2933;
}
body {
  margin: 0;
}
header {
  background: #ffffff;
  border-bottom: 1px solid #d8dde3;
  padding: 18px 28px;
}
h1 {
  font-size: 22px;
  margin: 0 0 6px;
}
.meta {
  color: #607080;
  font-size: 14px;
}
main {
  max-width: 1180px;
  margin: 0 auto;
  padding: 24px;
}
.topbar {
  display: flex;
  gap: 16px;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.breadcrumbs {
  font-size: 15px;
}
.sync-toggle {
  align-items: center;
  display: flex;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
}
.topbar-actions {
  align-items: center;
  display: flex;
  gap: 10px;
}
.refresh-link {
  margin-left: 12px;
  font-size: 13px;
  color: #666;
  opacity: 0.75;
}
.refresh-link:hover {
  opacity: 1;
}
a {
  color: #0b63b6;
  text-decoration: none;
}
a:hover {
  text-decoration: underline;
}
.upload {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  background: #fff;
  border: 1px solid #d8dde3;
  border-radius: 6px;
  padding: 12px;
  margin-bottom: 16px;
}
.upload span {
  color: #607080;
  font-size: 13px;
}
button {
  background: #174a7c;
  border: 0;
  border-radius: 5px;
  color: #fff;
  cursor: pointer;
  font-weight: 600;
  padding: 8px 12px;
}
table {
  width: 100%;
  border-collapse: collapse;
  background: #fff;
  border: 1px solid #d8dde3;
}
th, td {
  border-bottom: 1px solid #e7ebef;
  padding: 10px 12px;
  text-align: left;
  vertical-align: middle;
}
th {
  background: #f0f3f5;
  font-size: 13px;
  text-transform: uppercase;
}
.name {
  font-weight: 600;
}
.status {
  border-radius: 999px;
  display: inline-block;
  font-size: 12px;
  padding: 3px 8px;
}
.status.both {
  background: #e7f5ec;
  color: #17633a;
}
.status.remote {
  background: #e7f0fb;
  color: #174a7c;
}
.status.local {
  background: #fff2cf;
  color: #76520b;
}
.status.diff {
  background: #fde8e8;
  color: #8a1f1f;
}
.status.loading {
  background: #eef2f6;
  color: #4a5565;
}
.view-actions,
.sync {
  white-space: nowrap;
}
.view-actions a + a,
.view-actions a + button {
  margin-left: 10px;
}
.copy-path {
  background: #eef2f6;
  color: #1f2933;
  font-size: 12px;
  padding: 5px 8px;
}
.copy-path.copied {
  background: #e7f5ec;
  color: #17633a;
}
.sync-form {
  display: none;
  margin: 0 0 4px;
}
body.sync-enabled .sync-form {
  display: block;
}
.sync-form button {
  font-size: 12px;
  padding: 5px 8px;
}
.sync-form button:disabled {
  cursor: default;
  opacity: 0.55;
}
.sync-popup {
  background: #ffffff;
  border: 1px solid #b9c4d0;
  border-radius: 6px;
  bottom: 260px;
  box-shadow: 0 8px 24px rgba(20, 30, 40, 0.16);
  max-width: 460px;
  padding: 10px 12px;
  position: fixed;
  right: 18px;
  width: calc(100% - 36px);
  z-index: 120;
}
.sync-popup.hidden {
  display: none;
}
.sync-popup-head {
  align-items: center;
  display: flex;
  justify-content: space-between;
  margin-bottom: 8px;
}
.sync-popup-head button {
  background: #eef2f6;
  color: #1f2933;
  padding: 5px 8px;
}
#sync-popup-message {
  font-size: 13px;
  margin-bottom: 6px;
}
#sync-popup-command {
  color: #607080;
  font-family: monospace;
  font-size: 12px;
  margin-bottom: 8px;
  overflow-wrap: anywhere;
}
.sync-progress {
  background: #e7ebef;
  border-radius: 999px;
  height: 9px;
  overflow: hidden;
}
#sync-progress-bar {
  background: #174a7c;
  height: 100%;
  width: 0;
}
#sync-progress-bar.running {
  animation: sync-indeterminate 1.1s linear infinite;
  width: 35%;
}
.empty {
  color: #607080;
  text-align: center;
}
.notice {
  background: #e7f5ec;
  border: 1px solid #b9dfc6;
  border-radius: 6px;
  padding: 10px 12px;
}
.error {
  background: #fde8e8;
  border: 1px solid #f3b7b7;
  border-radius: 6px;
  padding: 10px 12px;
}
#log-panel {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: #1a1f2e;
  color: #c8d0db;
  font-family: monospace;
  font-size: 12px;
  z-index: 100;
  border-top: 2px solid #3a4a5e;
  display: flex;
  flex-direction: column;
  max-height: 240px;
}
#log-panel.collapsed {
  max-height: none;
}
#log-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px;
  background: #252b3a;
  border-bottom: 1px solid #3a4a5e;
  cursor: pointer;
  user-select: none;
  flex-shrink: 0;
}
#log-arrow {
  color: #607080;
  font-size: 10px;
}
#log-title {
  font-weight: bold;
  font-size: 11px;
  color: #8fa3b8;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
#log-entries {
  overflow-y: auto;
  flex: 1;
  padding: 4px 12px 6px;
}
#log-panel.collapsed #log-entries {
  display: none;
}
.log-entry {
  padding: 1px 0;
  white-space: pre-wrap;
  word-break: break-all;
  line-height: 1.5;
}
.log-ts {
  color: #4a5a6a;
}
.log-kind-rclone {
  color: #7ec8e3;
}
.log-kind-request {
  color: #7ec87e;
}
.log-slow {
  color: #c8a832;
}
.log-very-slow {
  color: #e05050;
}
.folder-pending {
  color: #607080;
  font-size: 12px;
  white-space: nowrap;
}
.spinner {
  display: inline-block;
  width: 11px;
  height: 11px;
  border: 2px solid #d0d8e0;
  border-top-color: #0b63b6;
  border-radius: 50%;
  animation: spin 0.75s linear infinite;
  vertical-align: middle;
  margin-right: 4px;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
@keyframes sync-indeterminate {
  0%   { margin-left: -35%; }
  100% { margin-left: 100%; }
}
@keyframes pending-pulse {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.35; }
}
"""


SETTINGS_JS = r"""
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
"""


LOG_JS = r"""
(function () {
  var collapsed = Settings.get('log-collapsed', false);
  var panel = document.getElementById('log-panel');
  var entries = document.getElementById('log-entries');
  var arrow = document.getElementById('log-arrow');

  function applyCollapsed() {
    panel.classList.toggle('collapsed', collapsed);
    arrow.innerHTML = collapsed ? '&#9654;' : '&#9660;';
  }
  applyCollapsed();

  var nextIndex = 0;
  var nextUpdateSeq = 0;

  function toggleLog() {
    collapsed = !collapsed;
    Settings.set('log-collapsed', collapsed);
    applyCollapsed();
  }
  window.toggleLog = toggleLog;

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function buildEntry(e) {
    return '<span class="log-ts">[' + esc(e.ts) + ']</span> ' +
      '<span class="log-kind-' + esc(e.kind) + '">' + esc(e.kind) + '</span> ' +
      esc(e.message);
  }

  function applyEntry(div, e) {
    var slowClass = e.elapsed >= 5 ? ' log-very-slow' : e.elapsed >= 1 ? ' log-slow' : '';
    div.className = 'log-entry' + slowClass;
    div.innerHTML = buildEntry(e);
  }

  function poll() {
    fetch('/logs?since=' + nextIndex + '&since_upd=' + nextUpdateSeq)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.update_seq !== undefined) nextUpdateSeq = data.update_seq;
        data.entries.forEach(function (e) {
          nextIndex = Math.max(nextIndex, e.index + 1);
          var div = document.createElement('div');
          div.setAttribute('data-id', e.index);
          applyEntry(div, e);
          entries.appendChild(div);
        });
        (data.updates || []).forEach(function (e) {
          var div = entries.querySelector('[data-id="' + e.index + '"]');
          if (div) applyEntry(div, e);
        });
        if (data.entries.length > 0 && !collapsed) {
          entries.scrollTop = entries.scrollHeight;
        }
      })
      .catch(function () {})
      .then(function () { setTimeout(poll, 2000); });
  }

  setTimeout(poll, 500);
}());
"""


SYNC_JS = r"""
(function () {
  var toggle = document.getElementById('sync-enabled');
  var popup = document.getElementById('sync-popup');
  var hide = document.getElementById('sync-popup-hide');
  var message = document.getElementById('sync-popup-message');
  var command = document.getElementById('sync-popup-command');
  var bar = document.getElementById('sync-progress-bar');

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
    return directionsForStatus(status).map(function (direction) {
      return '<form class="sync-form" action="/sync" method="post">' +
        '<input type="hidden" name="path" value="' + esc(relPath) + '">' +
        '<input type="hidden" name="kind" value="' + esc(kind) + '">' +
        '<input type="hidden" name="direction" value="' + esc(direction) + '">' +
        '<input type="hidden" name="sync_enabled" value="0">' +
        '<button type="submit">' + esc(labelForDirection(direction)) + '</button>' +
        '</form>';
    }).join('');
  }

  window.SyncControls = { renderCell: renderCell };

  function setSyncBusy(busy) {
    document.querySelectorAll('.sync-form button').forEach(function (button) {
      button.disabled = busy;
    });
  }

  function applyToggle() {
    var enabled = !!(toggle && toggle.checked);
    document.body.classList.toggle('sync-enabled', enabled);
    document.querySelectorAll('input[name="sync_enabled"]').forEach(function (input) {
      input.value = enabled ? '1' : '0';
    });
  }

  if (toggle) {
    toggle.checked = Settings.get('sync-enabled', false);
    toggle.addEventListener('change', function () {
      Settings.set('sync-enabled', toggle.checked);
      applyToggle();
    });
    applyToggle();
  }

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

  function pollStatus(id) {
    fetch('/sync-status?id=' + encodeURIComponent(id))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        command.textContent = data.command || data.label || '';
        if (data.status === 'complete') {
          finishPopup(data.message || 'Sync complete', data.command || data.label || '', true);
          setTimeout(function () { window.location.reload(); }, 700);
          return;
        }
        if (data.status === 'error') {
          setSyncBusy(false);
          finishPopup(data.message || 'Sync failed', data.command || data.label || '', false);
          return;
        }
        message.textContent = data.message || 'Sync running';
        setTimeout(function () { pollStatus(id); }, 800);
      })
      .catch(function () { setTimeout(function () { pollStatus(id); }, 1500); });
  }

  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form || !form.classList || !form.classList.contains('sync-form')) return;
    event.preventDefault();
    if (!toggle || !toggle.checked) return;
    if (form.getAttribute('data-sync-running') === '1') return;
    applyToggle();
    form.setAttribute('data-sync-running', '1');
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
        form.removeAttribute('data-sync-running');
        setSyncBusy(false);
        finishPopup(err.message || 'Sync failed', cmd, false);
      });
  });

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
"""


FOLDER_JS = r"""
(function () {
  var folderRows = {};
  document.querySelectorAll('tr[data-folder-path]').forEach(function (row) {
    folderRows[row.getAttribute('data-folder-path')] = row;
  });
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
    if (pending.length > 0) parts.push('paths=' + pending.map(encodeURIComponent).join(','));
    if (pollCurrent) parts.push('current=' + encodeURIComponent(CURRENT_FOLDER_PATH || ''));
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
          var currentInfo = data.results[CURRENT_FOLDER_PATH || ''];
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
"""
