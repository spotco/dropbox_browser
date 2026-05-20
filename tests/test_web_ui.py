from __future__ import annotations

import json
import threading
import time
from http import HTTPStatus
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

from dropbox_browser.errors import BrowserError
from dropbox_browser.foldercache import DIFF_CACHE_SCHEMA_VERSION
from dropbox_browser.listingcache import ListingCacheManager
from dropbox_browser.services import DropboxBrowser

try:
    from tests.app_test_support import AppTestCase, PreloadedFolderCache, RecordingFolderCache
    from tests.support import SimulatedLsjsonResponse, SimulatedRclone, TestServer, remote_dir_item, remote_file_item, wait_until
except ImportError:
    from app_test_support import AppTestCase, PreloadedFolderCache, RecordingFolderCache
    from support import SimulatedLsjsonResponse, SimulatedRclone, TestServer, remote_dir_item, remote_file_item, wait_until



class WebUiTests(AppTestCase):
    def test_page_title_uses_current_folder_name_and_dropbox_path(self) -> None:
        rel_path = "Music & Videos/Album <One>"
        rclone = SimulatedRclone({
            "dropbox:Music & Videos/Album <One>": [SimulatedLsjsonResponse(items=[])],
        })
        app = self._build_app(rclone, local_root=None, workers=1)

        with TestServer(app) as server:
            html = server.get_text("/?path=" + quote(rel_path))

        escaped_title = "SDB: Album &lt;One&gt; (dropbox:Music &amp; Videos/Album &lt;One&gt;)"
        self.assertIn(f"<title>{escaped_title}</title>", html)
        self.assertIn(f"<h1>{escaped_title}</h1>", html)

    def test_sync_controls_render_in_separate_view_and_sync_columns(self) -> None:
        local_root = self.create_local_root({
            "local.txt": b"local",
            "folder/inside.txt": b"inside",
        })
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[
                remote_dir_item("folder"),
            ])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            html = server.get_text("/")
            css = server.get_text("/assets/app.css")
            music_css = server.get_text("/assets/css/music.css")
            js = "\n".join([
                server.get_text("/assets/js/settings.js"),
                server.get_text("/assets/js/bottom-pane.js"),
                server.get_text("/assets/js/log.js"),
                server.get_text("/assets/js/music.js"),
                server.get_text("/assets/js/refresh.js"),
                server.get_text("/assets/js/sync.js"),
                server.get_text("/assets/js/folder.js"),
            ])

        self.assertIn("<th>View</th>", html)
        self.assertIn("<th>Sync</th>", html)
        self.assertIn('<link rel="stylesheet" href="/assets/app.css">', html)
        self.assertIn('<link rel="stylesheet" href="/assets/css/music.css">', html)
        self.assertIn('<script src="/assets/js/settings.js"></script>', html)
        self.assertIn('<script src="/assets/js/bottom-pane.js"></script>', html)
        self.assertIn('<script src="/assets/js/log.js"></script>', html)
        self.assertIn('<script src="/assets/js/music.js"></script>', html)
        self.assertIn('<script src="/assets/js/refresh.js"></script>', html)
        self.assertIn('<script src="/assets/js/sync.js"></script>', html)
        self.assertIn('<script src="/assets/js/folder.js"></script>', html)
        self.assertNotIn("<style>", html)
        self.assertNotIn("<script>var CURRENT_FOLDER_PATH", html)
        self.assertNotIn('action="/upload', html)
        self.assertNotIn("Upload New File", html)
        self.assertIn("SDB: Dropbox (dropbox:)", html)
        self.assertIn('id="enable-to-local"', html)
        self.assertIn('id="enable-write-dropbox"', html)
        self.assertIn("Enable sync to local", html)
        self.assertIn("Enable sync to Dropbox", html)
        self.assertIn("Copy Local -&gt; Dropbox", html)
        self.assertIn('data-sync-direction="local_to_dropbox"', html)
        self.assertIn('name="enable_to_local" value="0"', html)
        self.assertIn('name="enable_write_dropbox" value="0"', html)
        self.assertIn("body.sync-to-local-enabled .sync-form[data-sync-direction=\"dropbox_to_local\"]", css)
        self.assertIn("body.sync-to-dropbox-enabled .sync-form[data-sync-direction=\"local_to_dropbox\"]", css)
        self.assertIn("Settings.get('sync-enable-to-local', false)", js)
        self.assertIn("Settings.get('sync-enable-write-dropbox', false)", js)
        self.assertIn("Settings.set('sync-enable-to-local', enableToLocal.checked)", js)
        self.assertIn("Settings.set('sync-enable-write-dropbox', enableWriteDropbox.checked)", js)
        self.assertIn("var syncBusyCount = 0", js)
        self.assertIn("setSyncBusy(true)", js)
        self.assertIn(".sync-form button, .batch-sync, #batch-confirm-run, #batch-confirm-cancel", js)
        self.assertIn("button.disabled = busy || baseDisabled", js)
        self.assertIn("if (syncBusyCount > 0) return;", js)
        self.assertIn('id="batch-recursive"', html)
        self.assertIn("width: calc(100% - 32px)", css)
        self.assertIn("max-width: none", css)
        self.assertIn("Sync All Local to Dropbox", html)
        self.assertIn("Delete all Local-Only Files", html)
        self.assertIn("Copy all Dropbox-Only Files to Local", html)
        self.assertIn('data-batch-action="delete_local_only_all"', html)
        self.assertIn('data-batch-action="dropbox_only_to_local_all"', html)
        self.assertIn(".batch-delete-local", css)
        self.assertIn("body.sync-to-local-enabled .recursive-toggle", css)
        self.assertIn("body.sync-to-dropbox-enabled .recursive-toggle", css)
        self.assertIn("'[' + data.current + '/' + data.total + '] '", js)
        self.assertIn("Preparing recursive scan for", js)
        self.assertIn("pollPlanStatus(payload.id, fields)", js)
        self.assertIn("function scrollLogToBottom()", js)
        self.assertIn("body.has-log-panel", css)
        self.assertIn("padding-bottom: var(--log-panel-height)", css)
        self.assertIn('id="log-resizer"', html)
        self.assertIn('id="bottom-pane-mode"', html)
        self.assertIn('<option value="server-log">Server Log</option>', html)
        self.assertIn('<option value="music-player">Music Player</option>', html)
        self.assertIn('id="server-log-pane"', html)
        self.assertIn('id="music-player-pane"', html)
        self.assertIn('id="music-player-pane" class="bottom-pane-view hidden" data-pane-mode="music-player" hidden', html)
        self.assertIn("Playback controls will appear here.", html)
        self.assertIn("Settings.get('log-height', defaultHeight)", js)
        self.assertIn("var defaultMode = 'server-log'", js)
        self.assertIn("Settings.get('bottom-pane-mode', defaultMode)", js)
        self.assertIn("Settings.set('bottom-pane-mode', mode)", js)
        self.assertIn("view.hidden = !selected", js)
        self.assertIn("bottom-pane-mode-changed", js)
        self.assertIn("data-pane-mode=\"music-player\"", html)
        self.assertNotIn(".music-player-stub", css)
        self.assertIn(".music-player-stub", music_css)
        self.assertIn("data-player-ready", js)
        self.assertNotIn('onclick="toggleLog()"', html)
        self.assertNotIn("log-collapsed", js)
        self.assertIn("scrollLogToBottom();", js)
        self.assertIn("sync-batch-plan", js)
        self.assertIn("batch-confirm-list", html)
        self.assertIn("setBaseDisabled(batchRun, !plan.total)", js)
        self.assertIn('id="refresh-cache"', html)
        self.assertIn('id="refresh-blocker"', html)
        self.assertIn("refresh all children", js)
        self.assertIn("fetch('/refresh-cache'", js)
        self.assertIn("recursive: recursive ? '1' : '0'", js)
        self.assertIn("Cache invalidated. Reloading page", js)
        self.assertIn("window.location.reload();", js)
        self.assertNotIn("pollUntilReady", js)
        self.assertIn("event.key === 'Shift'", js)
        folder_row = html.split('<span class="entry-name">folder</span></a></td>', 1)[1].split("</tr>", 1)[0]
        self.assertIn('data-sync-kind="folder"', folder_row)
        self.assertNotIn("sync-form", folder_row)

    def test_entry_rows_render_material_file_type_icons(self) -> None:
        local_root = self.create_local_root({
            "archive.rar": b"archive",
            "movie.mkv": b"video",
            "program.exe": b"exe",
            "unknown.bin": b"bin",
            "folder/inside.txt": b"inside",
        })
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[
                remote_file_item("archive.rar", local_root / "archive.rar"),
                remote_file_item("movie.mkv", local_root / "movie.mkv"),
                remote_file_item("program.exe", local_root / "program.exe"),
                remote_file_item("unknown.bin", local_root / "unknown.bin"),
                remote_dir_item("folder"),
            ])],
        })
        app = self._build_app(rclone, local_root=local_root)

        with TestServer(app) as server:
            html = server.get_text("/")
            icon_svg = server.get_text("/assets/icons/material-icon-theme/folder-base.svg")
            favicon_svg = server.get_text("/assets/icons/material-icon-theme/box-favicon.svg")

        self.assertIn('<link rel="icon" type="image/svg+xml" href="/assets/icons/material-icon-theme/box-favicon.svg">', html)
        self.assertIn('src="/assets/icons/material-icon-theme/folder-base.svg"', html)
        self.assertIn('src="/assets/icons/material-icon-theme/zip.svg"', html)
        self.assertIn('src="/assets/icons/material-icon-theme/video.svg"', html)
        self.assertIn('src="/assets/icons/material-icon-theme/exe.svg"', html)
        self.assertIn('src="/assets/icons/material-icon-theme/document.svg"', html)
        self.assertIn("<svg", icon_svg)
        self.assertIn("<svg", favicon_svg)

    def test_head_requests_for_page_and_icon_return_headers_without_body(self) -> None:
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[])],
        })
        app = self._build_app(rclone, local_root=None, workers=1)

        with TestServer(app) as server:
            page_request = Request(server.base_url + "/", method="HEAD")
            with urlopen(page_request, timeout=5) as response:
                page_body = response.read()
                page_headers = response.headers
                page_status = response.status

            icon_request = Request(
                server.base_url + "/assets/icons/material-icon-theme/video.svg",
                method="HEAD",
            )
            with urlopen(icon_request, timeout=5) as response:
                icon_body = response.read()
                icon_headers = response.headers
                icon_status = response.status
            css_request = Request(server.base_url + "/assets/app.css", method="HEAD")
            with urlopen(css_request, timeout=5) as response:
                css_body = response.read()
                css_headers = response.headers
                css_status = response.status
            music_css_request = Request(server.base_url + "/assets/css/music.css", method="HEAD")
            with urlopen(music_css_request, timeout=5) as response:
                music_css_body = response.read()
                music_css_headers = response.headers
                music_css_status = response.status
            js_request = Request(server.base_url + "/assets/js/sync.js", method="HEAD")
            with urlopen(js_request, timeout=5) as response:
                js_body = response.read()
                js_headers = response.headers
                js_status = response.status

        self.assertEqual(page_status, HTTPStatus.OK)
        self.assertEqual(page_body, b"")
        self.assertEqual(page_headers["Content-Type"], "text/html; charset=utf-8")
        self.assertGreater(int(page_headers["Content-Length"]), 0)
        self.assertEqual(icon_status, HTTPStatus.OK)
        self.assertEqual(icon_body, b"")
        self.assertEqual(icon_headers["Content-Type"], "image/svg+xml; charset=utf-8")
        self.assertGreater(int(icon_headers["Content-Length"]), 0)
        self.assertEqual(css_status, HTTPStatus.OK)
        self.assertEqual(css_body, b"")
        self.assertEqual(css_headers["Content-Type"], "text/css; charset=utf-8")
        self.assertGreater(int(css_headers["Content-Length"]), 0)
        self.assertEqual(music_css_status, HTTPStatus.OK)
        self.assertEqual(music_css_body, b"")
        self.assertEqual(music_css_headers["Content-Type"], "text/css; charset=utf-8")
        self.assertGreater(int(music_css_headers["Content-Length"]), 0)
        self.assertEqual(js_status, HTTPStatus.OK)
        self.assertEqual(js_body, b"")
        self.assertEqual(js_headers["Content-Type"], "application/javascript; charset=utf-8")
        self.assertGreater(int(js_headers["Content-Length"]), 0)

    def test_copy_buttons_cover_current_folder_and_local_file_paths(self) -> None:
        local_root = self.create_local_root({
            "both.txt": b"both",
            "local.txt": b"local",
            "folder/inside.txt": b"inside",
        })
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[
                remote_file_item("both.txt", local_root / "both.txt"),
                {
                    "Name": "remote.txt",
                    "Path": "remote.txt",
                    "IsDir": False,
                    "Size": 6,
                    "ModTime": "2024-01-01T12:00:00Z",
                },
            ])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            html = server.get_text("/")
            sync_js = server.get_text("/assets/js/sync.js")

        self.assertIn('<div class="topbar-actions">', html)
        self.assertIn(">Copy Folder Path</button>", html)
        self.assertIn('href="https://www.dropbox.com/home"', html)
        self.assertIn('target="_blank"', html)
        self.assertIn(">Copy Filepath</button>", html)
        self.assertIn('class="copy-path"', html)
        self.assertIn(f'data-copy-path="{local_root}"', html)
        self.assertIn(f'data-copy-path="{local_root / "both.txt"}"', html)
        self.assertIn(f'data-copy-path="{local_root / "local.txt"}"', html)
        self.assertIn("navigator.clipboard.writeText(path)", sync_js)
        self.assertIn("document.execCommand('copy')", sync_js)
        remote_row = html.split('<span class="entry-name">remote.txt</span></a></td>', 1)[1].split("</tr>", 1)[0]
        self.assertNotIn("copy-path", remote_row)

    def test_go_to_dropbox_link_encodes_current_folder_path(self) -> None:
        local_root = self.create_local_root({
            "THE DUMP/Garcello & Slynk/Garcello/local.txt": b"local",
            "Plus+Folder/local.txt": b"plus",
        })
        rclone = SimulatedRclone({
            "dropbox:THE DUMP/Garcello & Slynk/Garcello": [SimulatedLsjsonResponse(items=[])],
            "dropbox:Plus+Folder": [SimulatedLsjsonResponse(items=[])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            html = server.get_text("/?path=THE%20DUMP%2FGarcello%20%26%20Slynk%2FGarcello")
            plus_html = server.get_text("/?path=Plus%2BFolder")

        self.assertIn(
            'href="https://www.dropbox.com/home/THE%20DUMP/Garcello%20%26%20Slynk/Garcello"',
            html,
        )
        self.assertIn('href="https://www.dropbox.com/home/Plus%2BFolder"', plus_html)

    def test_upload_endpoint_is_not_available(self) -> None:
        local_root = self.create_local_root({})
        rclone = SimulatedRclone({})
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            request = Request(
                server.base_url + "/upload",
                data=b"",
                method="POST",
                headers={"Content-Type": "multipart/form-data; boundary=x"},
            )
            with self.assertRaises(HTTPError) as ctx:
                urlopen(request, timeout=5)

        self.assertEqual(ctx.exception.code, 404)
        ctx.exception.close()
