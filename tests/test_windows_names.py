from __future__ import annotations

import html as html_module
import unittest
from pathlib import Path
from urllib.parse import quote

from dropbox_browser.foldercache import FolderCacheManager
from dropbox_browser.listingcache import ListingCacheManager
from dropbox_browser.services import DropboxBrowser
from dropbox_browser.windows_names import dropbox_local_name_equal

try:
    from tests.support import (
        IsolatedPathsTestCase,
        SimulatedLsjsonResponse,
        SimulatedRclone,
        TestServer,
        remote_dir_item,
        remote_file_item,
        wait_until,
    )
except ImportError:
    from support import (
        IsolatedPathsTestCase,
        SimulatedLsjsonResponse,
        SimulatedRclone,
        TestServer,
        remote_dir_item,
        remote_file_item,
        wait_until,
    )


class WindowsSafeNameMatcherTests(unittest.TestCase):
    def test_dropbox_local_name_equal_handles_windows_invalid_char_combinations_with_unicode(self) -> None:
        remote_name = 'combo <>"\\|?*: <>:"\\|?* cafe Ωß'
        local_name = 'combo ＜＞＂＼｜？＊_ ＜＞_＂＼｜？＊ cafe Ωß'
        self.assertTrue(dropbox_local_name_equal(remote_name, local_name))

    def test_dropbox_local_name_equal_handles_private_use_colon_replacement(self) -> None:
        remote_name = "Sword of Convallaria: Night Crimson OST"
        local_name = "Sword of Convallaria\uf022 Night Crimson OST"
        self.assertTrue(dropbox_local_name_equal(remote_name, local_name))


class WindowsSafeNameIntegrationTests(IsolatedPathsTestCase):
    def _build_app(self, rclone: SimulatedRclone, local_root: Path | None = None, workers: int = 2) -> DropboxBrowser:
        listing_cache = ListingCacheManager(ttl_seconds=1800)
        folder_cache = FolderCacheManager(
            rclone,
            workers=workers,
            ttl_seconds=86400,
            listing_cache=listing_cache,
            local_root=local_root,
            remote="dropbox:",
        )
        return DropboxBrowser(rclone, "dropbox:", local_root, folder_cache=folder_cache, listing_cache=listing_cache)

    def _wait_folder_info(self, server: TestServer, *, current: str, path: str) -> dict:
        payload_holder: dict[str, dict] = {}

        def _ready() -> dict | None:
            payload_holder["value"] = server.get_json("/folder-info?paths=" + quote(path) + "&current=" + quote(current))["results"]
            data = payload_holder["value"].get(path)
            if data and data.get("complete"):
                return payload_holder["value"]
            return None

        return wait_until(_ready, description=f"folder info for {path}")

    def test_combined_windows_safe_folder_name_keeps_single_row_link_and_synced_status(self) -> None:
        remote_name = 'combo <>"\\|?*: <>:"\\|?* cafe Ωß'
        local_name = 'combo ＜＞＂＼｜？＊_ ＜＞_＂＼｜？＊ cafe Ωß'
        remote_path = f"music/{remote_name}"
        local_root = self.create_local_root({
            f"music/{local_name}/track.txt": b"audio",
        })
        rclone = SimulatedRclone({
            "dropbox:music": [SimulatedLsjsonResponse(items=[
                remote_dir_item(remote_name),
            ])],
            f"dropbox:music/{remote_name}": [SimulatedLsjsonResponse(items=[
                remote_file_item("track.txt", local_root / "music" / local_name / "track.txt"),
            ])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            page_html = server.get_text("/?path=music")
            results = self._wait_folder_info(server, current="music", path=remote_path)
        table_body = page_html.split("<tbody>", 1)[1].split("</tbody>", 1)[0]
        self.assertEqual(table_body.count(f"[dir] {html_module.escape(remote_name)}</a>"), 1)
        self.assertNotIn(f"[dir] {html_module.escape(local_name)}</a>", table_body)
        self.assertEqual(app.local_display_path(remote_path), local_root / "music" / local_name)
        self.assertEqual(results[remote_path]["diff_status"], "synced")
