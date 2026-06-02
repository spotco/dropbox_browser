from __future__ import annotations

import html
import posixpath
from functools import lru_cache
from pathlib import Path
from string import Template
from typing import Any
from urllib.parse import quote, urlencode

from .formatting import display_date, file_type, human_size, status_class
from .paths import remote_target
from .services import diff_label


ICON_BASE_URL = "/assets/icons/material-icon-theme/"
TEMPLATE_DIR = Path(__file__).resolve().parent / "assets" / "templates"
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


@lru_cache(maxsize=None)
def _template(name: str) -> Template:
    return Template((TEMPLATE_DIR / name).read_text(encoding="utf-8"))


def _render_template(name: str, **values: str) -> str:
    return _template(name).substitute(values)


def _render_static_template(name: str) -> str:
    return _template(name).template


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


def server_browse_rows_html(
    app: Any,
    rel_path: str,
    entries: list[dict[str, Any]],
    folder_cache_map: dict | None = None,
    current_folder_cache: dict | None = None,
) -> str:
    rows = "\n".join(entry_row(app, rel_path, entry, folder_cache_map or {}, current_folder_cache or {}) for entry in entries)
    return rows or '<tr><td colspan="7" class="empty">This folder is empty.</td></tr>'


def client_browse_rows_html() -> str:
    return '<tr><td colspan="7" class="empty">Loading folder listing...</td></tr>'


def browse_table_html(*, rows_html: str, tbody_attrs: str = "") -> str:
    return (
        "<table>\n"
        "      <thead>\n"
        "        <tr>\n"
        "          <th>$sort_name</th>\n"
        "          <th>$sort_type</th>\n"
        "          <th>$sort_status</th>\n"
        "          <th>$sort_size</th>\n"
        "          <th>$sort_date</th>\n"
        "          <th>View</th>\n"
        "          <th>Sync</th>\n"
        "        </tr>\n"
        "      </thead>\n"
        f"      <tbody{tbody_attrs}>{rows_html}</tbody>\n"
        "    </table>"
    )


def browse_script_tags(client_render: bool) -> str:
    tags = [
        '<script src="/assets/js/settings.js"></script>',
        '<script src="/assets/js/bottom-pane.js"></script>',
        '<script src="/assets/js/log.js"></script>',
        '<script type="module" src="/assets/js/music.js"></script>',
        '<script src="/assets/js/refresh.js"></script>',
        '<script src="/assets/js/sync.js"></script>',
    ]
    if client_render:
        tags.append('<script src="/assets/js/browse/main.js"></script>')
    else:
        tags.append('<script src="/assets/js/folder.js"></script>')
    return "\n  ".join(tags)


def page_html(app: Any, rel_path: str, entries: list[dict[str, Any]], sort_key: str, direction: str, msg: str, folder_cache_map: dict | None = None, current_folder_cache: dict | None = None) -> str:
    client_render = bool(getattr(app, "client_render", False))
    if client_render:
        rows_html = client_browse_rows_html()
        tbody_attrs = ' id="browse-rows"'
    else:
        rows_html = server_browse_rows_html(app, rel_path, entries, folder_cache_map, current_folder_cache)
        tbody_attrs = ""
    crumbs = breadcrumbs(rel_path)
    page_title = folder_page_title(app.remote, rel_path)
    refresh_href = "/?" + urlencode({"path": rel_path, "sort": sort_key, "dir": direction, "refresh": "1"})
    local_note = (
        f"Comparing with {html.escape(str(app.local_root))}"
        if app.local_root
        else "Local comparison disabled"
    )
    msg_html = f'<p class="notice">{html.escape(msg)}</p>' if msg else ""
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
        '<button type="button" class="batch-sync batch-to-local batch-delete-command" data-batch-action="download_local_only_delete_bat">DL .bat file to delete all local-only files</button>'
        '<button type="button" class="batch-sync batch-to-local" data-batch-action="dropbox_only_to_local_all">Copy all Dropbox-Only Files to Local</button>'
        '</div>'
        if app.local_root
        else ""
    )
    music_library_poll_delay_ms = int(getattr(app, "music_library_poll_delay_ms", 4000) or 4000)

    def sort_link(label: str, key: str) -> str:
        next_dir = "desc" if sort_key == key and direction == "asc" else "asc"
        href = "/?" + urlencode({"path": rel_path, "sort": key, "dir": next_dir})
        indicator = " ^" if sort_key == key and direction == "asc" else " v" if sort_key == key else ""
        return f'<a href="{href}">{label}{indicator}</a>'

    table_html = Template(browse_table_html(rows_html=rows_html, tbody_attrs=tbody_attrs)).substitute(
        sort_name=sort_link("Name", "name"),
        sort_type=sort_link("Type", "type"),
        sort_status=sort_link("Status", "status"),
        sort_size=sort_link("Size", "size"),
        sort_date=sort_link("Date", "date"),
    )

    return _render_template(
        "page.html",
        icon_base_url=ICON_BASE_URL,
        page_title=html.escape(page_title),
        remote=html.escape(app.remote),
        rel_path=html.escape(rel_path),
        local_note=local_note,
        sync_toggles=sync_toggles,
        crumbs=crumbs,
        refresh_href=html.escape(refresh_href, quote=True),
        topbar_actions=topbar_actions,
        msg_html=msg_html,
        browse_table_html=table_html,
        music_player_html=_render_static_template("music_player.html"),
        current_folder_attr=html.escape(rel_path, quote=True),
        current_sort_key_attr=html.escape(sort_key, quote=True),
        current_sort_direction_attr=html.escape(direction, quote=True),
        music_library_poll_delay_ms_attr=html.escape(str(music_library_poll_delay_ms), quote=True),
        client_render_attr="1" if client_render else "0",
        browse_script_tags=browse_script_tags(client_render),
    )


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
    return _render_template(
        "error.html",
        status_value=html.escape(str(status.value)),
        status_phrase=html.escape(status.phrase),
        message=html.escape(message),
    )
