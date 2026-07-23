from __future__ import annotations

import json
from http import HTTPStatus
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

from dropbox_browser.photo_map_cache import (
    MAX_BATCH_ENTRIES,
    PhotoMapCache,
    photo_map_cache_key,
)

try:
    from tests.app_test_support import AppTestCase
    from tests.support import SimulatedRclone, TestServer
except ImportError:
    from app_test_support import AppTestCase
    from support import SimulatedRclone, TestServer


def cache_record(
    path: str = "Camera Uploads/IMG_0001.JPG",
    *,
    size: int = 100,
    modified_time: float | None = 1_700_000_000.0,
    status: str = "located",
    latitude: float | None = 40.5,
    longitude: float | None = -74.0,
) -> dict:
    return {
        "path": path,
        "source_path": path,
        "size": size,
        "modified_time": modified_time,
        "status": status,
        "media_kind": "photo",
        "latitude": latitude,
        "longitude": longitude,
        "capture_date": "2024:01:01 12:00:00" if status == "located" else None,
        "capture_date_ms": 1_704_110_400_000.0 if status == "located" else None,
        "listing_date_ms": 1_700_000_000_000.0,
        "reason": None,
    }


def post_json(server: TestServer, path: str, payload: dict) -> dict:
    body = json.dumps(payload).encode("utf-8")
    request = Request(
        server.base_url + path,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "Content-Length": str(len(body))},
    )
    with urlopen(request, timeout=5) as response:
        return json.loads(response.read().decode("utf-8"))


class PhotoMapCacheTests(AppTestCase):
    def test_cache_key_includes_normalized_path_and_listing_identity(self) -> None:
        first = photo_map_cache_key("Camera Uploads/IMG.JPG", 100, 1_700_000_000.0)
        equivalent = photo_map_cache_key("Camera%20Uploads/IMG.JPG", 100, 1_700_000_000.0)
        changed_size = photo_map_cache_key("Camera Uploads/IMG.JPG", 101, 1_700_000_000.0)
        changed_time = photo_map_cache_key("Camera Uploads/IMG.JPG", 100, 1_700_000_001.0)

        self.assertEqual(first, equivalent)
        self.assertNotEqual(first, changed_size)
        self.assertNotEqual(first, changed_time)

    def test_batch_write_replaces_stale_identity_for_same_path(self) -> None:
        cache = PhotoMapCache()
        cache.write_batch("Camera Uploads", [cache_record()])
        self.assertEqual(cache.read("Camera Uploads")[0]["size"], 100)

        replacement = cache_record(size=200, modified_time=1_700_000_001.0)
        cache.write_batch("Camera Uploads", [replacement])
        entries = cache.read("Camera Uploads")

        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["size"], 200)
        self.assertEqual(entries[0]["modified_time"], 1_700_000_001.0)

    def test_cache_rejects_invalid_coordinates_and_traversal(self) -> None:
        cache = PhotoMapCache()
        invalid = cache_record(latitude=91.0)
        with self.assertRaises(Exception):
            cache.write_batch("Camera Uploads", [invalid])
        with self.assertRaises(Exception):
            cache.write_batch("Camera Uploads", [cache_record(path="../outside.jpg")])

    def test_cache_endpoints_read_and_batch_write_json_records(self) -> None:
        app = self._build_app(SimulatedRclone(), local_root=None, workers=1)
        record = cache_record()

        with TestServer(app) as server:
            written = post_json(server, "/photo-map/endpoints/cache", {
                "path": "Camera Uploads",
                "entries": [record],
            })
            payload = server.get_json("/photo-map/endpoints/cache?path=" + quote("Camera Uploads"))

        self.assertEqual(written, {"status": "ok", "path": "Camera Uploads", "written": 1})
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["path"], "Camera Uploads")
        self.assertEqual(payload["entries"][0]["path"], record["path"])
        self.assertEqual(payload["entries"][0]["latitude"], 40.5)

    def test_cache_endpoint_rejects_traversal_and_oversized_batches(self) -> None:
        app = self._build_app(SimulatedRclone(), local_root=None, workers=1)
        with TestServer(app) as server:
            with self.assertRaises(HTTPError) as traversal:
                server.get_text("/photo-map/endpoints/cache?path=" + quote("../outside"))
            with self.assertRaises(HTTPError) as oversized:
                post_json(server, "/photo-map/endpoints/cache", {
                    "path": "Camera Uploads",
                    "entries": [cache_record() for _ in range(MAX_BATCH_ENTRIES + 1)],
                })

        self.assertEqual(traversal.exception.code, HTTPStatus.BAD_REQUEST)
        self.assertEqual(oversized.exception.code, HTTPStatus.BAD_REQUEST)
