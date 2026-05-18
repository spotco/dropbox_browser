from __future__ import annotations

import html
import json
import posixpath
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode

from .formatting import display_date, file_type, human_size, status_class
from .paths import remote_target
from .services import diff_label


ICON_BASE_URL = "/assets/icons/material-icon-theme/"
FOLDER_ICON = "folder-base.svg"
DEFAULT_FILE_ICON = "document.svg"
FILE_ICON_BY_EXTENSION = {
    ".7z": "zip.svg",
    ".aac": "audio.svg",
    ".avi": "video.svg",
    ".avif": "image.svg",
    ".bash": "console.svg",
    ".bat": "console.svg",
    ".bmp": "image.svg",
    ".bz2": "zip.svg",
    ".cjs": "javascript.svg",
    ".cmd": "console.svg",
    ".com": "exe.svg",
    ".conf": "editorconfig.svg",
    ".cfg": "editorconfig.svg",
    ".csv": "table.svg",
    ".css": "css.svg",
    ".db": "database.svg",
    ".dll": "dll.svg",
    ".doc": "word.svg",
    ".docx": "word.svg",
    ".eot": "font.svg",
    ".env": "editorconfig.svg",
    ".exe": "exe.svg",
    ".fish": "console.svg",
    ".flac": "audio.svg",
    ".gif": "image.svg",
    ".gz": "zip.svg",
    ".heic": "image.svg",
    ".htm": "html.svg",
    ".html": "html.svg",
    ".ico": "image.svg",
    ".ini": "editorconfig.svg",
    ".jpeg": "image.svg",
    ".jpg": "image.svg",
    ".js": "javascript.svg",
    ".json": "json.svg",
    ".jsonl": "json.svg",
    ".lock": "lock.svg",
    ".log": "log.svg",
    ".m4a": "audio.svg",
    ".m4v": "video.svg",
    ".markdown": "markdown.svg",
    ".md": "markdown.svg",
    ".mid": "audio.svg",
    ".midi": "audio.svg",
    ".mjs": "javascript.svg",
    ".mkv": "video.svg",
    ".mov": "video.svg",
    ".mp3": "audio.svg",
    ".mp4": "video.svg",
    ".mpeg": "video.svg",
    ".mpg": "video.svg",
    ".msi": "installation.svg",
    ".nfo": "document.svg",
    ".odp": "powerpoint.svg",
    ".ods": "table.svg",
    ".odt": "word.svg",
    ".ogg": "audio.svg",
    ".otf": "font.svg",
    ".pdf": "pdf.svg",
    ".png": "image.svg",
    ".ppt": "powerpoint.svg",
    ".pptx": "powerpoint.svg",
    ".ps1": "powershell.svg",
    ".psd1": "powershell.svg",
    ".psm1": "powershell.svg",
    ".py": "python.svg",
    ".pyw": "python.svg",
    ".rar": "zip.svg",
    ".rtf": "document.svg",
    ".sh": "console.svg",
    ".sql": "database.svg",
    ".sqlite": "database.svg",
    ".sqlite3": "database.svg",
    ".svg": "image.svg",
    ".tar": "zip.svg",
    ".text": "document.svg",
    ".tgz": "zip.svg",
    ".tif": "image.svg",
    ".tiff": "image.svg",
    ".toml": "editorconfig.svg",
    ".tsv": "table.svg",
    ".ttf": "font.svg",
    ".txt": "document.svg",
    ".wav": "audio.svg",
    ".webm": "video.svg",
    ".webp": "image.svg",
    ".wma": "audio.svg",
    ".wmv": "video.svg",
    ".woff": "font.svg",
    ".woff2": "font.svg",
    ".xls": "table.svg",
    ".xlsx": "table.svg",
    ".xml": "xml.svg",
    ".xz": "zip.svg",
    ".yaml": "editorconfig.svg",
    ".yml": "editorconfig.svg",
    ".zip": "zip.svg",
    ".zsh": "console.svg",
}


def icon_for_entry(name: str, is_dir: bool) -> str:
    if is_dir:
        return FOLDER_ICON
    return FILE_ICON_BY_EXTENSION.get(Path(name).suffix.casefold(), DEFAULT_FILE_ICON)


def entry_name_link(href: str, name: str, is_dir: bool) -> str:
    icon_name = icon_for_entry(name, is_dir)
    icon_src = ICON_BASE_URL + quote(icon_name, safe="")
    escaped_name = html.escape(name)
    return (
        f'<a class="name" href="{href}">'
        f'<img class="file-icon" src="{icon_src}" alt="" aria-hidden="true" loading="lazy">'
        f'<span class="entry-name">{escaped_name}</span>'
        '</a>'
    )


def folder_page_title(remote: str, rel_path: str) -> str:
    folder_name = posixpath.basename(rel_path) if rel_path else "Dropbox"
    return f"SDB: {folder_name} ({remote_target(remote, rel_path)})"


def page_html(app: Any, rel_path: str, entries: list[dict[str, Any]], sort_key: str, direction: str, msg: str, folder_cache_map: dict | None = None, current_folder_cache: dict | None = None) -> str:
    rows = "\n".join(entry_row(app, rel_path, entry, folder_cache_map or {}, current_folder_cache or {}) for entry in entries)
    crumbs = breadcrumbs(rel_path)
    page_title = folder_page_title(app.remote, rel_path)
    refresh_href = "/?" + urlencode({"path": rel_path, "sort": sort_key, "dir": direction, "refresh": "1"})
    local_note = (
        f"Comparing with {html.escape(str(app.local_root))}"
        if app.local_root
        else "Local comparison disabled"
    )
    msg_html = f'<p class="notice">{html.escape(msg)}</p>' if msg else ""
    current_folder_js = json.dumps(rel_path)
    current_sort_key_js = json.dumps(sort_key)
    current_sort_direction_js = json.dumps(direction)
    current_local_folder = ""
    if app.local_root:
        current_local_folder = str(app.local_display_path(rel_path) or app.local_root)
    sync_toggles = (
        '<div class="sync-toggles">'
        '<label class="sync-toggle"><input type="checkbox" id="enable-to-local"> Enable sync to local</label>'
        '<label class="sync-toggle"><input type="checkbox" id="enable-write-dropbox"> Enable sync to Dropbox</label>'
        '</div>'
        if app.local_root
        else ""
    )
    topbar_actions = (
        '<div class="topbar-actions">'
        f'<button type="button" class="copy-path" data-copy-path="{html.escape(current_local_folder)}">Copy Folder Path</button>'
        f'<a class="dropbox-link" href="{html.escape(dropbox_home_url(rel_path))}" target="_blank" rel="noopener noreferrer">Go to Dropbox</a>'
        '<label class="recursive-toggle"><input type="checkbox" id="batch-recursive"> Recursive</label>'
        '<button type="button" class="batch-sync batch-to-dropbox" data-batch-action="local_to_dropbox_all">Sync All Local to Dropbox</button>'
        '<button type="button" class="batch-sync batch-to-local batch-delete-local" data-batch-action="delete_local_only_all">Delete all Local-Only Files</button>'
        '<button type="button" class="batch-sync batch-to-local" data-batch-action="dropbox_only_to_local_all">Copy all Dropbox-Only Files to Local</button>'
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
  <link rel="icon" type="image/svg+xml" href="{ICON_BASE_URL}box-favicon.svg">
  <title>{html.escape(page_title)}</title>
  <style>{CSS}</style>
</head>
<body>
  <header>
    <div>
      <h1>{html.escape(page_title)}</h1>
      <div class="meta">{html.escape(app.remote)} / {html.escape(rel_path)} - {local_note}</div>
    </div>
    {sync_toggles}
  </header>
  <main>
    <div class="topbar">
      <nav class="breadcrumbs">{crumbs} <a id="refresh-cache" class="refresh-link" href="{refresh_href}" title="Refresh cached metadata for this folder">&#8635; refresh</a></nav>
      {topbar_actions}
    </div>
    {msg_html}
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
  <div id="batch-confirm" class="batch-confirm hidden">
    <div class="batch-confirm-box">
      <h2>Confirm Batch Sync</h2>
      <div id="batch-confirm-summary"></div>
      <div id="batch-confirm-list"></div>
      <div class="batch-confirm-actions">
        <button type="button" id="batch-confirm-cancel">Cancel</button>
        <button type="button" id="batch-confirm-run">Run</button>
      </div>
    </div>
  </div>
  <div id="refresh-blocker" class="refresh-blocker hidden">
    <div class="refresh-box">
      <h2>Refreshing Cache</h2>
      <div id="refresh-message">Refreshing current folder</div>
      <div class="sync-progress"><div id="refresh-progress-bar" class="running"></div></div>
    </div>
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
  <script>var CURRENT_SORT_KEY = {current_sort_key_js}; var CURRENT_SORT_DIRECTION = {current_sort_direction_js};</script>
  <script>{REFRESH_JS}</script>
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


def dropbox_home_url(rel_path: str) -> str:
    encoded = quote(rel_path, safe="/")
    return "https://www.dropbox.com/home" + (f"/{encoded}" if encoded else "")


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
            f'<form class="sync-form" data-sync-direction="{html.escape(direction)}" action="/sync" method="post">'
            f'<input type="hidden" name="path" value="{html.escape(rel_path)}">'
            f'<input type="hidden" name="kind" value="{html.escape(kind)}">'
            f'<input type="hidden" name="direction" value="{html.escape(direction)}">'
            '<input type="hidden" name="enable_to_local" value="0">'
            '<input type="hidden" name="enable_write_dropbox" value="0">'
            f'<button type="submit">{html.escape(label)}</button>'
            '</form>'
        )
    return "".join(forms)


def _sync_cell(rel_path: str, kind: str, status: str, enabled: bool) -> str:
    attrs = f' data-sync-path="{html.escape(rel_path)}" data-sync-kind="{html.escape(kind)}"'
    buttons = _sync_buttons(rel_path, kind, status) if enabled and kind == "file" else ""
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
    sort_date_value = (
        row.get("cached_mtime")
        if is_dir and row.get("cached_mtime") is not None
        else max(row.get("remote_mtime") or 0, row.get("local_mtime") or 0)
    ) or 0
    common_row_attrs = (
        f' data-row-kind="{"folder" if is_dir else "file"}"'
        f' data-sort-name="{html.escape(name.casefold())}"'
        f' data-sort-date="{sort_date_value}"'
    )
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
            row_attrs = common_row_attrs + f' data-folder-path="{html.escape(child_path)}"'
        else:
            if app.local_root:
                status = "Local Only"
            size_td = '<td class="col-size">—</td>'
            date_td = f'<td class="col-date">{display_date(row.get("local_mtime"))}</td>'
            row_attrs = common_row_attrs
        name_html = entry_name_link("/?" + urlencode({"path": child_path}), name, True)
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
        row_attrs = common_row_attrs + status_attrs
        query = urlencode({"path": child_path, "source": source})
        name_html = entry_name_link("/file?" + query, name, False)
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
  align-items: center;
  background: #ffffff;
  border-bottom: 1px solid #d8dde3;
  display: flex;
  gap: 16px;
  justify-content: space-between;
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
  box-sizing: border-box;
  margin: 0 16px;
  max-width: none;
  padding: 24px 0;
  width: calc(100% - 32px);
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
.sync-toggles {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  justify-content: flex-end;
}
.topbar-actions {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.recursive-toggle {
  align-items: center;
  display: none;
  gap: 5px;
  font-size: 12px;
  font-weight: 600;
}
.refresh-link {
  margin-left: 12px;
  font-size: 13px;
  color: #666;
  opacity: 0.75;
  white-space: nowrap;
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
  align-items: center;
  display: inline-flex;
  gap: 8px;
  font-weight: 600;
  min-width: 0;
}
.file-icon {
  flex: 0 0 18px;
  height: 18px;
  width: 18px;
}
.entry-name {
  overflow-wrap: anywhere;
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
.dropbox-link {
  background: #eef2f6;
  border-radius: 5px;
  color: #1f2933;
  font-size: 12px;
  font-weight: 600;
  padding: 5px 8px;
}
.batch-sync {
  display: none;
  font-size: 12px;
  padding: 5px 8px;
}
.batch-delete-local {
  background: #8a1f1f;
}
body.sync-to-dropbox-enabled .batch-to-dropbox,
body.sync-to-local-enabled .batch-to-local {
  display: inline-block;
}
body.sync-to-local-enabled .recursive-toggle,
body.sync-to-dropbox-enabled .recursive-toggle {
  display: flex;
}
.copy-path.copied {
  background: #e7f5ec;
  color: #17633a;
}
.sync-form {
  display: none;
  margin: 0 0 4px;
}
body.sync-to-local-enabled .sync-form[data-sync-direction="dropbox_to_local"],
body.sync-to-dropbox-enabled .sync-form[data-sync-direction="local_to_dropbox"] {
  display: block;
}
.sync-form button {
  font-size: 12px;
  padding: 5px 8px;
}
button:disabled {
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
.batch-confirm {
  align-items: center;
  background: rgba(0, 0, 0, 0.32);
  bottom: 0;
  display: flex;
  justify-content: center;
  left: 0;
  position: fixed;
  right: 0;
  top: 0;
  z-index: 200;
}
.batch-confirm.hidden {
  display: none;
}
.refresh-blocker {
  align-items: center;
  background: rgba(0, 0, 0, 0.36);
  bottom: 0;
  display: flex;
  justify-content: center;
  left: 0;
  position: fixed;
  right: 0;
  top: 0;
  z-index: 260;
}
.refresh-blocker.hidden {
  display: none;
}
.refresh-box {
  background: #fff;
  border: 1px solid #b9c4d0;
  border-radius: 6px;
  box-shadow: 0 12px 32px rgba(20, 30, 40, 0.18);
  max-width: 420px;
  padding: 18px;
  width: calc(100% - 40px);
}
.refresh-box h2 {
  font-size: 18px;
  margin: 0 0 10px;
}
#refresh-message {
  color: #1f2933;
  font-size: 13px;
  margin-bottom: 12px;
}
.batch-confirm-box {
  background: #fff;
  border: 1px solid #b9c4d0;
  border-radius: 6px;
  max-height: 82vh;
  max-width: 760px;
  padding: 16px;
  width: calc(100% - 40px);
}
.batch-confirm-box h2 {
  font-size: 18px;
  margin: 0 0 10px;
}
#batch-confirm-list {
  border: 1px solid #d8dde3;
  max-height: 48vh;
  overflow: auto;
  padding: 10px;
}
#batch-confirm-list h3 {
  font-size: 13px;
  margin: 10px 0 6px;
}
#batch-confirm-list ul {
  margin: 0 0 8px 18px;
  padding: 0;
}
#batch-confirm-list li {
  font-family: monospace;
  font-size: 12px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.batch-confirm-actions {
  display: flex;
  gap: 10px;
  justify-content: space-between;
  margin-top: 12px;
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
#refresh-progress-bar {
  background: #174a7c;
  height: 100%;
  width: 35%;
}
#refresh-progress-bar.running {
  animation: sync-indeterminate 1.1s linear infinite;
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

  function scrollLogToBottom() {
    entries.scrollTop = entries.scrollHeight;
  }

  function applyCollapsed() {
    panel.classList.toggle('collapsed', collapsed);
    arrow.innerHTML = collapsed ? '&#9654;' : '&#9660;';
    if (!collapsed) {
      scrollLogToBottom();
    }
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
          scrollLogToBottom();
        }
      })
      .catch(function () {})
      .then(function () { setTimeout(poll, 2000); });
  }

  setTimeout(poll, 500);
}());
"""


REFRESH_JS = r"""
(function () {
  var link = document.getElementById('refresh-cache');
  var blocker = document.getElementById('refresh-blocker');
  var message = document.getElementById('refresh-message');
  var progress = document.getElementById('refresh-progress-bar');
  if (!link || !blocker || !message) return;

  var shiftDown = false;
  var refreshing = false;

  function formBody(fields) {
    var params = new URLSearchParams();
    Object.keys(fields).forEach(function (key) { params.set(key, fields[key]); });
    return params;
  }

  function setShiftState(active) {
    shiftDown = !!active;
    link.textContent = shiftDown ? '\u21bb refresh all children' : '\u21bb refresh';
    link.title = shiftDown ? 'Refresh cached metadata for this folder and all known child folders' : 'Refresh cached metadata for this folder';
  }

  function showBlocker(text) {
    message.textContent = text;
    if (progress) progress.className = 'running';
    blocker.classList.remove('hidden');
  }

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Shift') setShiftState(true);
  });
  document.addEventListener('keyup', function (event) {
    if (event.key === 'Shift') setShiftState(false);
  });
  window.addEventListener('blur', function () {
    setShiftState(false);
  });
  link.addEventListener('mousemove', function (event) {
    setShiftState(event.shiftKey);
  });
  link.addEventListener('mouseleave', function () {
    if (!shiftDown) setShiftState(false);
  });
  link.addEventListener('click', function (event) {
    event.preventDefault();
    if (refreshing) return;
    refreshing = true;
    var recursive = !!event.shiftKey;
    showBlocker(recursive ? 'Refreshing current folder and known child folders' : 'Refreshing current folder');
    fetch('/refresh-cache', {
      method: 'POST',
      body: formBody({
        path: window.CURRENT_FOLDER_PATH || '',
        recursive: recursive ? '1' : '0'
      })
    })
      .then(function (r) {
        if (!r.ok) throw new Error('Refresh request failed');
        return r.json();
      })
      .then(function () {
        message.textContent = 'Cache invalidated. Reloading page';
        window.location.reload();
      })
      .catch(function (err) {
        refreshing = false;
        message.textContent = err.message || 'Refresh failed';
        if (progress) {
          progress.className = '';
          progress.style.width = '100%';
          progress.style.background = '#8a1f1f';
        }
      });
  });
  setShiftState(false);
}());
"""


SYNC_JS = r"""
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

  function groupTitle(key) {
    if (key === 'local_dir_to_dropbox') return 'Create Dropbox Folders';
    if (key === 'local_to_dropbox') return 'Copy Local -> Dropbox';
    if (key === 'dropbox_dir_to_local') return 'Create Local Folders';
    if (key === 'dropbox_to_local') return 'Copy Dropbox -> Local';
    return 'Delete Local';
  }

  function renderPlan(plan) {
    batchSummary.textContent = plan.total + ' item(s) will be affected.';
    var html = '';
    ['local_dir_to_dropbox', 'local_to_dropbox', 'dropbox_dir_to_local', 'dropbox_to_local', 'delete_local'].forEach(function (key) {
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

  function openBatchConfirm(action) {
    var gates = gateParams();
    var fields = {
      path: window.CURRENT_FOLDER_PATH || '',
      action: action,
      recursive: batchRecursive && batchRecursive.checked ? '1' : '0',
      enable_to_local: gates.enable_to_local,
      enable_write_dropbox: gates.enable_write_dropbox
    };
    setSyncBusy(true);
    fetch('/sync-batch-plan', { method: 'POST', body: formBody(fields) })
      .then(function (r) {
        if (!r.ok) throw new Error('Could not build batch plan');
        return r.json();
      })
      .then(function (plan) {
        pendingBatch = fields;
        renderPlan(plan);
        batchConfirm.classList.remove('hidden');
      })
      .catch(function (err) {
        finishPopup(err.message || 'Batch plan failed', '', false);
      })
      .then(function () {
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
    if ((action === 'delete_local_only_all' || action === 'dropbox_only_to_local_all') && (!enableToLocal || !enableToLocal.checked)) return;
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
"""


FOLDER_JS = r"""
(function () {
  var folderRows = {};
  document.querySelectorAll('tr[data-folder-path]').forEach(function (row) {
    folderRows[row.getAttribute('data-folder-path')] = row;
  });
  var currentSortKey = window.CURRENT_SORT_KEY || 'name';
  var currentSortDirection = window.CURRENT_SORT_DIRECTION || 'asc';
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
      var aName = a.getAttribute('data-sort-name') || '';
      var bName = b.getAttribute('data-sort-name') || '';
      return currentSortDirection === 'desc' ? bName.localeCompare(aName) : aName.localeCompare(bName);
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
