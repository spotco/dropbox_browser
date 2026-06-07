from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from urllib.parse import quote
from unittest.mock import patch

from dropbox_browser.foldercache import FolderCacheManager
from dropbox_browser.listingcache import ListingCacheManager
from dropbox_browser.services import DropboxBrowser
from dropbox_browser.windows_names import (
    decode_rclone_literal_escapes,
    dropbox_local_name_equal,
    match_dropbox_names_to_local_names,
    resolve_matching_local_path,
)

try:
    from tests.app_test_support import browse_listing
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
    from app_test_support import browse_listing
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
    def test_match_dropbox_names_prefers_literal_exact_name_over_canonical_variant(self) -> None:
        remote_name = "Daiki Ishikawa - Màtham Sanomh.mp3"
        decomposed_local_name = "Daiki Ishikawa - Màtham Sanomh.mp3"
        self.assertEqual(
            match_dropbox_names_to_local_names([remote_name], [decomposed_local_name, remote_name]),
            {remote_name: remote_name},
        )

    def test_match_dropbox_names_prefers_literal_exact_name_for_reported_canonical_duplicates(self) -> None:
        cases = [
            (
                "01 晴レ晴レファンファーレ(TVアニメ「甘々と稲妻」オープニングテーマ).mp3",
                "01 晴レ晴レファンファーレ(TVアニメ「甘々と稲妻」オープニングテーマ).mp3",
            ),
            (
                "onlymp3.to -  BOFXVI Catalinésie MisomyL-x6FencPeCzA-192k-1704955417.mp3",
                "onlymp3.to -  BOFXVI Catalinésie MisomyL-x6FencPeCzA-192k-1704955417.mp3",
            ),
            (
                "2.20 Hi éReila Convallaria in the Wind.mp3",
                "2.20 Hi éReila Convallaria in the Wind.mp3",
            ),
        ]
        for remote_name, canonical_variant in cases:
            with self.subTest(remote_name=remote_name):
                self.assertEqual(
                    match_dropbox_names_to_local_names([remote_name], [canonical_variant, remote_name]),
                    {remote_name: remote_name},
                )

    def test_dropbox_local_name_equal_handles_windows_invalid_char_combinations_with_unicode(self) -> None:
        remote_name = 'combo <>"\\|?*: <>:"\\|?* cafe Ωß'
        local_name = 'combo ＜＞＂＼｜？＊_ ＜＞_＂＼｜？＊ cafe Ωß'
        self.assertTrue(dropbox_local_name_equal(remote_name, local_name))

    def test_dropbox_local_name_equal_handles_private_use_colon_replacement(self) -> None:
        remote_name = "Sword of Convallaria: Night Crimson OST"
        local_name = "Sword of Convallaria\uf022 Night Crimson OST"
        self.assertTrue(dropbox_local_name_equal(remote_name, local_name))

    def test_dropbox_local_name_equal_handles_rclone_escaped_literal_fullwidth_question(self) -> None:
        remote_name = "0287 - U.N.オーエンは彼女なのか？(TO-HOlic mix).mp3"
        local_name = "0287 - U.N.オーエンは彼女なのか‛？(TO-HOlic mix).mp3"
        self.assertTrue(dropbox_local_name_equal(remote_name, local_name))

    def test_dropbox_ascii_question_does_not_match_rclone_escaped_fullwidth_question(self) -> None:
        remote_name = "track?.mp3"
        local_name = "track‛？.mp3"
        self.assertFalse(dropbox_local_name_equal(remote_name, local_name))

    def test_decode_rclone_literal_escapes_handles_common_cjk_fullwidth_punctuation(self) -> None:
        cases = [
            ("今日は晴れ‛？.txt", "今日は晴れ？.txt"),
            ("價格‛＜税込‛＞.txt", "價格＜税込＞.txt"),
            ("星‛＊月‛｜雪.txt", "星＊月｜雪.txt"),
            ("引用‛＂龍‛＼虎‛＂.txt", "引用＂龍＼虎＂.txt"),
            ("時間‛：予定.txt", "時間：予定.txt"),
        ]
        for local_name, dropbox_name in cases:
            with self.subTest(local_name=local_name):
                self.assertEqual(decode_rclone_literal_escapes(local_name), dropbox_name)
                self.assertTrue(dropbox_local_name_equal(dropbox_name, local_name))

    def test_decode_rclone_literal_escapes_keeps_marker_before_normal_unicode_text(self) -> None:
        self.assertEqual(decode_rclone_literal_escapes("今日は‛晴れ.txt"), "今日は‛晴れ.txt")

    def test_resolve_matching_local_path_uses_exact_existing_segment_without_scanning_siblings(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            local_root = Path(temp_dir)
            exact_dir = local_root / "dropbox_browser"
            exact_dir.mkdir()
            with patch.object(Path, "iterdir", side_effect=AssertionError("iterdir should not be called")):
                resolved = resolve_matching_local_path(local_root, "dropbox_browser")
            self.assertEqual(resolved, exact_dir)


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
        app = DropboxBrowser(
            rclone,
            "dropbox:",
            local_root,
            folder_cache=folder_cache,
            listing_cache=listing_cache,
            client_render=True,
        )
        self.addCleanup(app.shutdown)
        return app

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
            results = self._wait_folder_info(server, current="music", path=remote_path)
            listing = browse_listing(server, path="music")
        folder_rows = [row for row in listing["rows"] if row["display_name"] == remote_name]
        self.assertEqual(len(folder_rows), 1)
        self.assertNotIn(local_name, {row["display_name"] for row in listing["rows"]})
        self.assertEqual(folder_rows[0]["status_label"], "Synced")
        self.assertEqual(app.local_display_path(remote_path), local_root / "music" / local_name)
        self.assertEqual(results[remote_path]["diff_status"], "synced")

    def test_rclone_escaped_literal_fullwidth_question_keeps_single_row_and_actual_local_path(self) -> None:
        remote_name = "0287 - U.N.オーエンは彼女なのか？(TO-HOlic mix) - Copy.mp3"
        local_name = "0287 - U.N.オーエンは彼女なのか‛？(TO-HOlic mix) - Copy.mp3"
        remote_path = f"dropbox_browser/{remote_name}"
        local_root = self.create_local_root({
            f"dropbox_browser/{local_name}": b"audio",
        })
        rclone = SimulatedRclone({
            "dropbox:dropbox_browser": [SimulatedLsjsonResponse(items=[])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            listing = browse_listing(server, path="dropbox_browser")

        file_rows = [row for row in listing["rows"] if row["display_name"] == remote_name]
        self.assertEqual(len(file_rows), 1)
        self.assertNotIn(local_name, {row["display_name"] for row in listing["rows"]})
        self.assertEqual(file_rows[0]["status_label"], "Local Only")
        self.assertEqual(app.local_display_path(remote_path), local_root / "dropbox_browser" / local_name)
