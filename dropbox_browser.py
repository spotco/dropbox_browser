#!/usr/bin/env python3
"""A small stdlib-only Dropbox file browser backed by rclone."""

from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import mimetypes
import os
from pathlib import Path
import posixpath
import shutil
import subprocess
import sys
import tempfile
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, quote, unquote, urlencode, urlparse


APP_TITLE = "Dropbox Browser"
MAX_UPLOAD_BYTES = 1024 * 1024 * 1024


class BrowserError(Exception):
    def __init__(self, status: HTTPStatus, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def find_default_rclone() -> str:
    local = Path(__file__).with_name("rclone.exe")
    if local.exists():
        return str(local)
    found = shutil.which("rclone")
    return found or "rclone"


def find_default_config() -> str | None:
    pointer = Path(__file__).with_name("config_location.txt")
    if pointer.exists():
        value = pointer.read_text(encoding="utf-8").strip()
        return os.path.expandvars(value) if value else None
    return None


def clean_rel_path(raw: str | None) -> str:
    if not raw:
        return ""
    raw = unquote(raw).replace("\\", "/")
    parts: list[str] = []
    for part in raw.split("/"):
        if not part or part == ".":
            continue
        if part == "..":
            raise BrowserError(HTTPStatus.BAD_REQUEST, "Parent path segments are not allowed.")
        parts.append(part)
    return "/".join(parts)


def safe_join_local(root: Path, rel_path: str) -> Path:
    candidate = (root / Path(*rel_path.split("/")) if rel_path else root).resolve()
    root_resolved = root.resolve()
    if candidate != root_resolved and root_resolved not in candidate.parents:
        raise BrowserError(HTTPStatus.BAD_REQUEST, "Path escapes the configured local folder.")
    return candidate


def remote_target(remote: str, rel_path: str) -> str:
    remote = remote.rstrip("/")
    if not rel_path:
        return remote
    return f"{remote.rstrip(':')}:{rel_path}" if remote.endswith(":") else f"{remote}/{rel_path}"


def display_date(value: float | None) -> str:
    if not value:
        return ""
    return dt.datetime.fromtimestamp(value).strftime("%Y-%m-%d %H:%M")


def parse_rclone_time(value: str | None) -> float | None:
    if not value:
        return None
    normalized = value.replace("Z", "+00:00")
    try:
        return dt.datetime.fromisoformat(normalized).timestamp()
    except ValueError:
        return None


def file_type(name: str, is_dir: bool) -> str:
    if is_dir:
        return "folder"
    suffix = Path(name).suffix.lower().lstrip(".")
    return suffix or "file"


class RcloneClient:
    def __init__(self, executable: str, config: str | None):
        self.executable = executable
        self.config = config

    def command(self, *args: str) -> list[str]:
        cmd = [self.executable]
        if self.config:
            cmd += ["--config", self.config]
        cmd += list(args)
        return cmd

    def run(self, *args: str, input_file: Any | None = None) -> subprocess.CompletedProcess[bytes]:
        try:
            return subprocess.run(
                self.command(*args),
                stdin=input_file,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )
        except FileNotFoundError as exc:
            raise BrowserError(HTTPStatus.INTERNAL_SERVER_ERROR, f"rclone was not found: {exc}") from exc

    def lsjson(self, target: str) -> list[dict[str, Any]]:
        proc = self.run("lsjson", "--", target)
        if proc.returncode != 0:
            message = proc.stderr.decode("utf-8", "replace").strip() or "Could not list Dropbox folder."
            raise BrowserError(HTTPStatus.BAD_GATEWAY, message)
        if not proc.stdout.strip():
            return []
        return json.loads(proc.stdout.decode("utf-8"))

    def exists(self, target: str) -> bool:
        proc = self.run("lsjson", "--", target)
        return proc.returncode == 0

    def copy_file_to_remote(self, source: Path, destination: str) -> None:
        proc = self.run("copyto", "--ignore-existing", "--", str(source), destination)
        if proc.returncode != 0:
            message = proc.stderr.decode("utf-8", "replace").strip() or "Upload failed."
            raise BrowserError(HTTPStatus.BAD_GATEWAY, message)

    def open_cat(self, target: str) -> subprocess.Popen[bytes]:
        try:
            return subprocess.Popen(
                self.command("cat", "--", target),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
        except FileNotFoundError as exc:
            raise BrowserError(HTTPStatus.INTERNAL_SERVER_ERROR, f"rclone was not found: {exc}") from exc


class DropboxBrowser:
    def __init__(self, rclone: RcloneClient, remote: str, local_root: Path | None):
        self.rclone = rclone
        self.remote = remote
        self.local_root = local_root.resolve() if local_root else None

    def list_entries(self, rel_path: str) -> list[dict[str, Any]]:
        merged: dict[str, dict[str, Any]] = {}

        for item in self.rclone.lsjson(remote_target(self.remote, rel_path)):
            name = item.get("Name") or item.get("Path") or ""
            if not name or "/" in name:
                continue
            is_dir = bool(item.get("IsDir"))
            merged[name] = {
                "name": name,
                "is_dir": is_dir,
                "remote": True,
                "local": False,
                "remote_size": None if is_dir else item.get("Size"),
                "local_size": None,
                "remote_mtime": parse_rclone_time(item.get("ModTime")),
                "local_mtime": None,
            }

        if self.local_root:
            local_folder = safe_join_local(self.local_root, rel_path)
            if local_folder.exists() and local_folder.is_dir():
                for child in local_folder.iterdir():
                    stat = child.stat()
                    row = merged.setdefault(
                        child.name,
                        {
                            "name": child.name,
                            "is_dir": child.is_dir(),
                            "remote": False,
                            "local": False,
                            "remote_size": None,
                            "local_size": None,
                            "remote_mtime": None,
                            "local_mtime": None,
                        },
                    )
                    row["local"] = True
                    row["is_dir"] = bool(row["is_dir"] or child.is_dir())
                    row["local_size"] = None if child.is_dir() else stat.st_size
                    row["local_mtime"] = stat.st_mtime

        return list(merged.values())

    def sort_entries(self, entries: list[dict[str, Any]], sort_key: str, direction: str) -> list[dict[str, Any]]:
        reverse = direction == "desc"

        def key(row: dict[str, Any]) -> tuple[Any, str]:
            name = row["name"].lower()
            if sort_key == "type":
                primary = file_type(row["name"], row["is_dir"])
            elif sort_key == "date":
                primary = max(row.get("remote_mtime") or 0, row.get("local_mtime") or 0)
            else:
                primary = name
            return (primary, name)

        folders = sorted((row for row in entries if row["is_dir"]), key=key, reverse=reverse)
        files = sorted((row for row in entries if not row["is_dir"]), key=key, reverse=reverse)
        return folders + files

    def name_exists_in_folder(self, rel_path: str, filename: str) -> tuple[bool, str | None]:
        remote_file = posixpath.join(rel_path, filename) if rel_path else filename
        if self.rclone.exists(remote_target(self.remote, remote_file)):
            return True, "Dropbox already has an item with that name."
        if self.local_root:
            local_file = safe_join_local(self.local_root, remote_file)
            if local_file.exists():
                return True, "The local folder already has an item with that name."
        return False, None

    def upload_new_file(self, rel_path: str, filename: str, temp_file: Path) -> None:
        filename = Path(filename).name
        if not filename:
            raise BrowserError(HTTPStatus.BAD_REQUEST, "The upload needs a filename.")
        exists, reason = self.name_exists_in_folder(rel_path, filename)
        if exists:
            raise BrowserError(HTTPStatus.CONFLICT, reason or "That name already exists.")
        remote_file = posixpath.join(rel_path, filename) if rel_path else filename
        self.rclone.copy_file_to_remote(temp_file, remote_target(self.remote, remote_file))


class RequestHandler(BaseHTTPRequestHandler):
    server_version = "DropboxBrowser/0.1"

    @property
    def app(self) -> DropboxBrowser:
        return self.server.app  # type: ignore[attr-defined]

    def do_GET(self) -> None:
        try:
            parsed = urlparse(self.path)
            if parsed.path == "/":
                self.render_index(parsed.query)
            elif parsed.path == "/file":
                self.serve_file(parsed.query, inline=True)
            elif parsed.path == "/download":
                self.serve_file(parsed.query, inline=False)
            else:
                raise BrowserError(HTTPStatus.NOT_FOUND, "Not found.")
        except BrowserError as exc:
            self.render_error(exc.status, exc.message)
        except Exception as exc:
            self.render_error(HTTPStatus.INTERNAL_SERVER_ERROR, str(exc))

    def do_POST(self) -> None:
        try:
            parsed = urlparse(self.path)
            if parsed.path != "/upload":
                raise BrowserError(HTTPStatus.NOT_FOUND, "Not found.")
            self.handle_upload(parsed.query)
        except BrowserError as exc:
            self.render_error(exc.status, exc.message)
        except Exception as exc:
            self.render_error(HTTPStatus.INTERNAL_SERVER_ERROR, str(exc))

    def render_index(self, query: str) -> None:
        params = parse_qs(query)
        rel_path = clean_rel_path(params.get("path", [""])[0])
        sort_key = params.get("sort", ["name"])[0]
        direction = params.get("dir", ["asc"])[0]
        if sort_key not in {"name", "type", "date"}:
            sort_key = "name"
        if direction not in {"asc", "desc"}:
            direction = "asc"

        entries = self.app.sort_entries(self.app.list_entries(rel_path), sort_key, direction)
        body = self.page_html(rel_path, entries, sort_key, direction, params.get("msg", [""])[0])
        self.send_html(HTTPStatus.OK, body)

    def serve_file(self, query: str, inline: bool) -> None:
        params = parse_qs(query)
        rel_path = clean_rel_path(params.get("path", [""])[0])
        source = params.get("source", ["remote"])[0]
        name = Path(rel_path).name
        content_type = mimetypes.guess_type(name)[0] or "application/octet-stream"
        disposition = "inline" if inline else "attachment"

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Disposition", f'{disposition}; filename="{quote(name)}"')
        self.end_headers()

        if source == "local" and self.app.local_root:
            local_file = safe_join_local(self.app.local_root, rel_path)
            if not local_file.is_file():
                raise BrowserError(HTTPStatus.NOT_FOUND, "Local file not found.")
            with local_file.open("rb") as handle:
                shutil.copyfileobj(handle, self.wfile)
            return

        proc = self.app.rclone.open_cat(remote_target(self.app.remote, rel_path))
        assert proc.stdout is not None
        try:
            shutil.copyfileobj(proc.stdout, self.wfile)
        finally:
            proc.stdout.close()
            proc.wait(timeout=30)

    def handle_upload(self, query: str) -> None:
        params = parse_qs(query)
        rel_path = clean_rel_path(params.get("path", [""])[0])
        length = int(self.headers.get("Content-Length") or "0")
        if length <= 0:
            raise BrowserError(HTTPStatus.BAD_REQUEST, "No upload body was received.")
        if length > MAX_UPLOAD_BYTES:
            raise BrowserError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Upload is too large.")

        content_type = self.headers.get("Content-Type", "")
        boundary_key = "boundary="
        if "multipart/form-data" not in content_type or boundary_key not in content_type:
            raise BrowserError(HTTPStatus.BAD_REQUEST, "Expected multipart form upload.")
        boundary = content_type.split(boundary_key, 1)[1].strip().strip('"')
        body = self.rfile.read(length)
        filename, data = parse_multipart_file(body, boundary, "file")

        with tempfile.NamedTemporaryFile(delete=False) as tmp:
            tmp.write(data)
            tmp_path = Path(tmp.name)
        try:
            self.app.upload_new_file(rel_path, filename, tmp_path)
        finally:
            try:
                tmp_path.unlink()
            except OSError:
                pass

        location = "/?" + urlencode({"path": rel_path, "msg": f"Uploaded {filename}"})
        self.send_response(HTTPStatus.SEE_OTHER)
        self.send_header("Location", location)
        self.end_headers()

    def page_html(self, rel_path: str, entries: list[dict[str, Any]], sort_key: str, direction: str, msg: str) -> str:
        rows = "\n".join(self.entry_row(rel_path, entry) for entry in entries)
        breadcrumbs = self.breadcrumbs(rel_path)
        upload_action = "/upload?" + urlencode({"path": rel_path})
        local_note = (
            f"Comparing with {html.escape(str(self.app.local_root))}"
            if self.app.local_root
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
    <div class="meta">{html.escape(self.app.remote)} / {html.escape(rel_path)} - {local_note}</div>
  </header>
  <main>
    <nav class="breadcrumbs">{breadcrumbs}</nav>
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
          <th>Size</th>
          <th>{sort_link("Date", "date")}</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>{rows or '<tr><td colspan="6" class="empty">This folder is empty.</td></tr>'}</tbody>
    </table>
  </main>
</body>
</html>"""

    def breadcrumbs(self, rel_path: str) -> str:
        links = ['<a href="/">Dropbox</a>']
        current = ""
        for part in rel_path.split("/"):
            if not part:
                continue
            current = posixpath.join(current, part) if current else part
            href = "/?" + urlencode({"path": current})
            links.append(f'<a href="{href}">{html.escape(part)}</a>')
        return " / ".join(links)

    def entry_row(self, rel_path: str, row: dict[str, Any]) -> str:
        name = row["name"]
        child_path = posixpath.join(rel_path, name) if rel_path else name
        status = "Both" if row["remote"] and row["local"] else "Dropbox only" if row["remote"] else "Local only"
        size = row.get("remote_size") if row.get("remote_size") is not None else row.get("local_size")
        size_text = "" if row["is_dir"] else human_size(size or 0)
        date_value = max(row.get("remote_mtime") or 0, row.get("local_mtime") or 0) or None
        type_text = file_type(name, row["is_dir"])

        if row["is_dir"]:
            name_html = f'<a class="name" href="/?{urlencode({"path": child_path})}">[dir] {html.escape(name)}</a>'
            actions = ""
        else:
            source = "remote" if row["remote"] else "local"
            query = urlencode({"path": child_path, "source": source})
            name_html = f'<a class="name" href="/file?{query}">{html.escape(name)}</a>'
            actions = f'<a href="/file?{query}">Preview</a> <a href="/download?{query}">Download</a>'

        return f"""<tr>
  <td>{name_html}</td>
  <td>{html.escape(type_text)}</td>
  <td><span class="status {status_class(status)}">{status}</span></td>
  <td>{size_text}</td>
  <td>{display_date(date_value)}</td>
  <td class="actions">{actions}</td>
</tr>"""

    def send_html(self, status: HTTPStatus, body: str) -> None:
        encoded = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def render_error(self, status: HTTPStatus, message: str) -> None:
        body = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Error</title><style>{CSS}</style></head>
<body><main><h1>{status.value} {status.phrase}</h1><p class="error">{html.escape(message)}</p><p><a href="/">Back to browser</a></p></main></body></html>"""
        self.send_html(status, body)

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), fmt % args))


def parse_multipart_file(body: bytes, boundary: str, field_name: str) -> tuple[str, bytes]:
    marker = ("--" + boundary).encode()
    for part in body.split(marker):
        part = part.strip(b"\r\n")
        if not part or part == b"--":
            continue
        headers_blob, _, content = part.partition(b"\r\n\r\n")
        headers = headers_blob.decode("utf-8", "replace")
        disposition = next((line for line in headers.splitlines() if line.lower().startswith("content-disposition:")), "")
        if f'name="{field_name}"' not in disposition:
            continue
        filename = ""
        for segment in disposition.split(";"):
            segment = segment.strip()
            if segment.startswith("filename="):
                filename = segment.split("=", 1)[1].strip().strip('"')
                break
        if content.endswith(b"\r\n"):
            content = content[:-2]
        if not filename:
            raise BrowserError(HTTPStatus.BAD_REQUEST, "No file was selected.")
        return Path(filename).name, content
    raise BrowserError(HTTPStatus.BAD_REQUEST, "Upload file field was not found.")


def human_size(size: int) -> str:
    value = float(size)
    for unit in ["B", "KB", "MB", "GB"]:
        if value < 1024 or unit == "GB":
            return f"{value:.1f} {unit}" if unit != "B" else f"{int(value)} B"
        value /= 1024
    return f"{size} B"


def status_class(status: str) -> str:
    return {
        "Both": "both",
        "Dropbox only": "remote",
        "Local only": "local",
    }.get(status, "")


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
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a stdlib Dropbox browser backed by rclone.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--remote", default="dropbox:")
    parser.add_argument("--local-root", type=Path)
    parser.add_argument("--rclone", default=find_default_rclone())
    parser.add_argument("--rclone-config", default=find_default_config())
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.local_root and not args.local_root.is_dir():
        print(f"Local root is not a directory: {args.local_root}", file=sys.stderr)
        return 2

    app = DropboxBrowser(RcloneClient(args.rclone, args.rclone_config), args.remote, args.local_root)
    server = ThreadingHTTPServer((args.host, args.port), RequestHandler)
    server.app = app  # type: ignore[attr-defined]

    print(f"Serving {args.remote} at http://{args.host}:{args.port}/")
    if args.local_root:
        print(f"Comparing with local folder: {args.local_root.resolve()}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

