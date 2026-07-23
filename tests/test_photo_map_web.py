from __future__ import annotations

from http import HTTPStatus
from urllib.error import HTTPError
from urllib.request import Request, urlopen

try:
    from tests.app_test_support import AppTestCase
    from tests.support import SimulatedLsjsonResponse, SimulatedRclone, TestServer
except ImportError:
    from app_test_support import AppTestCase
    from support import SimulatedLsjsonResponse, SimulatedRclone, TestServer


class PhotoMapWebTests(AppTestCase):
    def test_photo_map_shell_and_assets_are_available(self) -> None:
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[])],
        })
        app = self._build_app(rclone, local_root=None, workers=1)
        asset_paths = [
            "/assets/css/photo-map.css",
            "/assets/js/photo-map.js",
            "/assets/js/photo-map/config.js",
            "/assets/js/photo-map/cache.js",
            "/assets/js/photo-map/diagnostics.js",
            "/assets/js/photo-map/leaflet.js",
            "/assets/js/photo-map/listing.js",
            "/assets/js/photo-map/map.js",
            "/assets/js/photo-map/parsers.js",
            "/assets/js/photo-map/queue.js",
            "/assets/js/photo-map/states.js",
            "/assets/js/photo-map/thumbnails.js",
        ]

        with TestServer(app) as server:
            html = server.get_text("/")
            assets = {path: server.get_text(path) for path in asset_paths}

        self.assertIn('<option value="photo-map">Photo Map</option>', html)
        self.assertIn('id="photo-map-pane" class="bottom-pane-view hidden" data-pane-mode="photo-map" hidden', html)
        self.assertIn('id="photo-map-date-range"', html)
        self.assertIn('id="photo-map-map" class="photo-map-map" role="application"', html)
        self.assertIn('type="module" src="/assets/js/photo-map.js"', html)
        for path, content in assets.items():
            self.assertTrue(content, path)

        self.assertIn("tile.openstreetmap.org", assets["/assets/js/photo-map/map.js"])
        self.assertIn("createPhotoMapDiagnostics", assets["/assets/js/photo-map/diagnostics.js"])
        self.assertIn("PHOTO_MAP_METADATA_CONCURRENCY", assets["/assets/js/photo-map/config.js"])

    def test_photo_map_vendor_assets_are_explicitly_served(self) -> None:
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[])],
        })
        app = self._build_app(rclone, local_root=None, workers=1)
        assets = {
            "/assets/vendor/leaflet/leaflet.css": "text/css; charset=utf-8",
            "/assets/vendor/leaflet/leaflet.js": "application/javascript; charset=utf-8",
            "/assets/vendor/leaflet/images/marker-icon.png": "image/png",
            "/assets/vendor/leaflet/markercluster/MarkerCluster.css": "text/css; charset=utf-8",
            "/assets/vendor/leaflet/markercluster/leaflet.markercluster.js": "application/javascript; charset=utf-8",
        }

        with TestServer(app) as server:
            responses = {}
            for path in assets:
                request = Request(server.base_url + path, method="HEAD")
                with urlopen(request, timeout=5) as response:
                    responses[path] = (response.status, response.headers, response.read())
            with self.assertRaises(HTTPError) as missing:
                urlopen(server.base_url + "/assets/vendor/leaflet/LICENSE", timeout=5)
            with self.assertRaises(HTTPError) as unlisted:
                urlopen(server.base_url + "/assets/vendor/leaflet/markercluster/images/not-listed.png", timeout=5)

        for path, content_type in assets.items():
            status, headers, body = responses[path]
            self.assertEqual(status, HTTPStatus.OK)
            self.assertEqual(body, b"")
            self.assertEqual(headers["Content-Type"], content_type)
            self.assertEqual(headers["Cache-Control"], "no-store, no-cache, must-revalidate")
            self.assertGreater(int(headers["Content-Length"]), 0)
        self.assertEqual(missing.exception.code, HTTPStatus.NOT_FOUND)
        self.assertEqual(unlisted.exception.code, HTTPStatus.NOT_FOUND)
