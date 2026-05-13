from __future__ import annotations

import html
import posixpath
from typing import Any
from urllib.parse import urlencode

from . import APP_TITLE
from .formatting import display_date, file_type, human_size, status_class


def page_html(app: Any, rel_path: str, entries: list[dict[str, Any]], sort_key: str, direction: str, msg: str, folder_cache_map: dict | None = None) -> str:
    rows = "\n".join(entry_row(rel_path, entry, folder_cache_map or {}) for entry in entries)
    crumbs = breadcrumbs(rel_path)
    upload_action = "/upload?" + urlencode({"path": rel_path})
    refresh_href = "/?" + urlencode({"path": rel_path, "sort": sort_key, "dir": direction, "refresh": "1"})
    local_note = (
        f"Comparing with {html.escape(str(app.local_root))}"
        if app.local_root
        else "Local comparison disabled"
    )
    msg_html = f'<p class="notice">{html.escape(msg)}</p>' if msg else ""

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
    <nav class="breadcrumbs">{crumbs} <a class="refresh-link" href="{refresh_href}" title="Bypass listing cache and reload from Dropbox">&#8635; refresh</a></nav>
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
          <th>Status</th>
          <th>{sort_link("Size", "size")}</th>
          <th>{sort_link("Date", "date")}</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>{rows or '<tr><td colspan="6" class="empty">This folder is empty.</td></tr>'}</tbody>
    </table>
  </main>
  <div id="log-panel">
    <div id="log-toolbar" onclick="toggleLog()">
      <span id="log-arrow">&#9660;</span>
      <span id="log-title">Server Log</span>
    </div>
    <div id="log-entries"></div>
  </div>
  <script>{SETTINGS_JS}</script>
  <script>{LOG_JS}</script>
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


def entry_row(rel_path: str, row: dict[str, Any], folder_cache_map: dict | None = None) -> str:
    name = row["name"]
    child_path = posixpath.join(rel_path, name) if rel_path else name
    status = "Both" if row["remote"] and row["local"] else "Dropbox only" if row["remote"] else "Local only"
    is_dir = row["is_dir"]
    type_text = file_type(name, is_dir)

    if is_dir:
        if row["remote"]:
            cached = (folder_cache_map or {}).get(name)
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
            size_td = '<td class="col-size">—</td>'
            date_td = f'<td class="col-date">{display_date(row.get("local_mtime"))}</td>'
            row_attrs = ""
        name_html = f'<a class="name" href="/?{urlencode({"path": child_path})}">[dir] {html.escape(name)}</a>'
        actions_td = '<td class="actions"></td>'
    else:
        source = "remote" if row["remote"] else "local"
        size = row.get("remote_size") if row.get("remote_size") is not None else row.get("local_size")
        date_value = max(row.get("remote_mtime") or 0, row.get("local_mtime") or 0) or None
        size_td = f'<td class="col-size">{human_size(size or 0)}</td>'
        date_td = f'<td class="col-date">{display_date(date_value)}</td>'
        row_attrs = ""
        query = urlencode({"path": child_path, "source": source})
        name_html = f'<a class="name" href="/file?{query}">{html.escape(name)}</a>'
        actions_td = f'<td class="actions"><a href="/file?{query}">Preview</a> <a href="/download?{query}">Download</a></td>'

    return f"""<tr{row_attrs}>
  <td>{name_html}</td>
  <td>{html.escape(type_text)}</td>
  <td><span class="status {status_class(status)}">{status}</span></td>
  {size_td}
  {date_td}
  {actions_td}
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
.breadcrumbs {
  margin-bottom: 16px;
  font-size: 15px;
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
.actions {
  white-space: nowrap;
}
.actions a + a {
  margin-left: 10px;
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


FOLDER_JS = r"""
(function () {
  var folderRows = {};
  document.querySelectorAll('tr[data-folder-path]').forEach(function (row) {
    folderRows[row.getAttribute('data-folder-path')] = row;
  });
  var pending = Object.keys(folderRows);
  if (pending.length === 0) return;

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  var spinnerHtml = '<span class="spinner"></span> ';

  function applyResult(relPath, info) {
    var row = folderRows[relPath];
    if (!row) return;
    var sizeCell = row.querySelector('.col-size');
    var dateCell = row.querySelector('.col-date');
    var prefix = info.complete ? '' : spinnerHtml;
    if (sizeCell) {
      var sizeText = esc(info.size_display || '—');
      if (info.count_display) sizeText += ' <span style="color:#607080">(' + esc(info.count_display) + ')</span>';
      sizeCell.innerHTML = prefix + sizeText;
    }
    if (dateCell) dateCell.innerHTML = prefix + esc(info.date_display || '');
  }

  function poll() {
    if (pending.length === 0) return;
    fetch('/folder-info?paths=' + pending.map(encodeURIComponent).join(','))
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
        pending = stillPending;
        if (pending.length > 0) setTimeout(poll, 2000);
      })
      .catch(function () { if (pending.length > 0) setTimeout(poll, 5000); });
  }

  setTimeout(poll, 500);
}());
"""
