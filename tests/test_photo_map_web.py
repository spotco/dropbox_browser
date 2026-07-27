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
            "/assets/js/photo-map-preview.js",
            "/assets/css/photo-map-preview.css",
            "/assets/js/photo-map/config.js",
            "/assets/js/photo-map/cache.js",
            "/assets/js/photo-map/diagnostics.js",
            "/assets/js/photo-map/grouping.js",
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
        self.assertIn('id="photo-map-grouping-distance"', html)
        self.assertIn('<option value="0">Off</option>', html)
        self.assertIn('<option value="50">50 m</option>', html)
        self.assertIn('<option value="100" selected>100 m</option>', html)
        self.assertIn('<option value="500">500 m</option>', html)
        self.assertIn('<option value="1000">1000 m</option>', html)
        self.assertIn('<option value="10000">10 km</option>', html)
        self.assertIn('class="photo-map-toolbar-controls"', html)
        self.assertIn('class="photo-map-toolbar-actions"', html)
        self.assertIn('id="photo-map-custom-range" class="photo-map-custom-range hidden" hidden', html)
        self.assertIn('id="photo-map-map" class="photo-map-map" role="application"', html)
        self.assertIn('type="module" src="/assets/js/photo-map.js"', html)
        self.assertIn('type="module" src="/assets/js/photo-map-preview.js"', html)
        for path, content in assets.items():
            self.assertTrue(content, path)

        self.assertIn("tile.openstreetmap.org", assets["/assets/js/photo-map/map.js"])
        self.assertIn("createPhotoMapDiagnostics", assets["/assets/js/photo-map/diagnostics.js"])
        self.assertIn("PHOTO_MAP_METADATA_CONCURRENCY", assets["/assets/js/photo-map/config.js"])
        self.assertIn("PHOTO_MAP_GROUPING_DISTANCE_DEFAULT_METERS", assets["/assets/js/photo-map/config.js"])
        self.assertIn("/video/endpoints/thumbnail?", assets["/assets/js/photo-map/thumbnails.js"])
        self.assertIn("photo-map-video-play", assets["/assets/js/photo-map/map.js"])
        self.assertIn("Show details for", assets["/assets/js/photo-map/map.js"])
        self.assertIn("/preview?", assets["/assets/js/photo-map/map.js"])
        self.assertIn("photo-map-preview-link", assets["/assets/js/photo-map/map.js"])
        self.assertNotIn("Video thumbnail unavailable", assets["/assets/js/photo-map/map.js"])
        self.assertIn(".photo-map-media-poster", assets["/assets/css/photo-map.css"])
        self.assertIn("margin-inline: auto", assets["/assets/css/photo-map.css"])
        self.assertIn(".photo-map-custom-range[hidden]", assets["/assets/css/photo-map.css"])
        self.assertIn(".photo-map-preview-page-video[hidden]", assets["/assets/css/photo-map-preview.css"])

    def test_video_preview_route_renders_standalone_controller_without_touching_photo_map_cache(self) -> None:
        rclone = SimulatedRclone({"dropbox:": [SimulatedLsjsonResponse(items=[])]})
        app = self._build_app(rclone, local_root=None, workers=1)
        with TestServer(app) as server:
            html = server.get_text("/preview?path=1350/clip.MOV&source=remote")
            request = Request(server.base_url + "/preview?path=1350/clip.MOV&source=remote", method="HEAD")
            with urlopen(request, timeout=5) as response:
                head = (response.status, response.headers, response.read())
            photo_html = server.get_text("/preview?path=1350/photo.jpg&source=remote&kind=photo")
            with self.assertRaises(HTTPError) as invalid:
                urlopen(server.base_url + "/preview?path=1350/notes.txt&source=remote", timeout=5)
            with self.assertRaises(HTTPError) as local:
                urlopen(server.base_url + "/preview?path=1350/clip.mov&source=local", timeout=5)

        self.assertIn('data-preview-path="1350/clip.MOV"', html)
        self.assertIn('data-preview-kind="video"', html)
        self.assertIn('id="photo-map-preview-video"', html)
        self.assertIn('/video/endpoints/thumbnail?path=1350%2Fclip.MOV', html)
        self.assertIn('/download?path=1350%2Fclip.MOV', html)
        self.assertIn('data-preview-kind="photo"', photo_html)
        self.assertIn('/thumbnail?path=1350%2Fphoto.jpg', photo_html)
        self.assertEqual(head[0], HTTPStatus.OK)
        self.assertEqual(head[2], b"")
        self.assertEqual(invalid.exception.code, HTTPStatus.NOT_FOUND)
        self.assertEqual(local.exception.code, HTTPStatus.BAD_REQUEST)

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
