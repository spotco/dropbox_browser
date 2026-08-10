from __future__ import annotations

from http import HTTPStatus
from urllib.error import HTTPError
from urllib.parse import quote

try:
    from tests.app_test_support import AppTestCase
    from tests.support import SimulatedLsjsonResponse, SimulatedRclone, TestServer
except ImportError:
    from app_test_support import AppTestCase
    from support import SimulatedLsjsonResponse, SimulatedRclone, TestServer


class DirectFilesFolderCache:
    supports_record_lookup = True

    def __init__(self, records: dict[str, dict]) -> None:
        self.records = records
        self.revision = 0
        self.requests: list[str] = []
        self.get_calls = 0
        self.page_epoch_calls: list[str] = []
        self.ensure_calls: list[tuple[str, float]] = []

    def get(self, remote_path: str) -> dict | None:
        self.get_calls += 1
        data = self.records.get(remote_path)
        return dict(data) if data is not None else None

    def status(self, remote_path: str) -> str:
        data = self.records.get(remote_path)
        if data is None:
            return "pending"
        return "complete" if data.get("complete") else "partial"

    def request(self, remote_path: str, *_args, **_kwargs) -> None:
        self.requests.append(remote_path)

    def page_epoch_for(self, page_key: str) -> float:
        self.page_epoch_calls.append(page_key)
        return 1234.5

    def ensure_known_subtree(
        self,
        remote_path: str,
        page_epoch: float,
        record_lookup=None,
        trace_dedup: bool = True,
    ) -> dict[str, int | float]:
        self.ensure_calls.append((remote_path, page_epoch))
        queued_folder_count = 0
        pending_folder_count = 0
        missing_folder_count = 0
        seen: set[str] = set()
        queue = [remote_path]
        index = 0

        while index < len(queue):
            current_path = queue[index]
            index += 1
            if current_path in seen:
                continue
            seen.add(current_path)
            data = record_lookup(current_path) if record_lookup is not None else self.records.get(current_path)
            if data is None:
                self.requests.append(current_path)
                queued_folder_count += 1
                pending_folder_count += 1
                missing_folder_count += 1
                continue
            if not data.get("complete"):
                pending_folder_count += 1
            for child in data.get("direct_folders", []) or []:
                child_remote_path = child.get("remote_path")
                if isinstance(child_remote_path, str) and child_remote_path:
                    queue.append(child_remote_path)

        return {
            "page_epoch": page_epoch,
            "queued_folder_count": queued_folder_count,
            "pending_folder_count": pending_folder_count,
            "missing_folder_count": missing_folder_count,
        }

    def advance_revision(self) -> None:
        self.revision += 1

    def invalidate(self, remote_path: str) -> None:
        self.records.pop(remote_path, None)
        self.advance_revision()

    def invalidate_tree(self, remote_path: str) -> list[str]:
        self.invalidate(remote_path)
        return [remote_path]


class TrapListingCache:
    def get(self, _remote_path: str) -> dict | None:
        raise AssertionError("music endpoint must not read listing cache directly")


class MusicEndpointTests(AppTestCase):

    def _complete_library_cache(self) -> DirectFilesFolderCache:
        return DirectFilesFolderCache({
            "dropbox:Music": {
                "complete": True,
                "direct_files": [],
                "direct_folders": [
                    {
                        "name": "Album",
                        "path": "Album",
                        "remote_path": "dropbox:Music/Album",
                    },
                ],
            },
            "dropbox:Music/Album": {
                "complete": True,
                "direct_files": [
                    {
                        "name": "Track.mp3",
                        "path": "Track.mp3",
                        "remote_path": "dropbox:Music/Album/Track.mp3",
                        "size": 10,
                        "mtime": 1704067200.0,
                    },
                ],
                "direct_folders": [],
            },
        })

    def test_music_library_reuses_unchanged_complete_snapshot(self) -> None:
        rclone = SimulatedRclone()
        app = self._build_app(rclone, local_root=None, workers=1)
        app.listing_cache = TrapListingCache()
        cache = self._complete_library_cache()
        app.folder_cache = cache

        with TestServer(app) as server:
            first = server.get_json("/music/endpoints/library?path=Music")
            reads_after_first = cache.get_calls
            second = server.get_json("/music/endpoints/library?path=Music")

        diagnostic_keys = {
            "snapshot_cache_hit",
            "snapshot_build_count",
            "recursive_record_read_count",
            "recursive_traversal_folder_count",
            "payload_build_elapsed_ms",
            "snapshot_cache_revision",
            "snapshot_cache_entry_count",
        }
        first_status = {key: value for key, value in first["status"].items() if key not in diagnostic_keys}
        second_status = {key: value for key, value in second["status"].items() if key not in diagnostic_keys}
        self.assertEqual({**first, "status": first_status}, {**second, "status": second_status})
        self.assertEqual(cache.get_calls, reads_after_first)
        self.assertEqual(first["status"]["snapshot_cache_hit"], False)
        self.assertEqual(second["status"]["snapshot_cache_hit"], True)
        self.assertEqual(second["status"]["snapshot_build_count"], 0)
        self.assertEqual(second["status"]["recursive_record_read_count"], 0)
        self.assertEqual(rclone.calls, [])
        events = [event for event in self.read_trace_events() if event.get("event") == "music_library_poll"]
        self.assertEqual(events[-1]["snapshot_cache_hit"], True)
        self.assertEqual(events[-1]["snapshot_build_count"], 0)

    def test_music_library_reuses_partial_snapshot_until_revision_advances(self) -> None:
        rclone = SimulatedRclone()
        app = self._build_app(rclone, local_root=None, workers=1)
        app.listing_cache = TrapListingCache()
        cache = DirectFilesFolderCache({
            "dropbox:Music": {
                "complete": True,
                "direct_files": [],
                "direct_folders": [
                    {"name": "Pending", "path": "Pending", "remote_path": "dropbox:Music/Pending"},
                ],
            },
        })
        app.folder_cache = cache

        with TestServer(app) as server:
            first = server.get_json("/music/endpoints/library?path=Music")
            request_count = len(cache.requests)
            second = server.get_json("/music/endpoints/library?path=Music")

        diagnostic_keys = {
            "snapshot_cache_hit",
            "snapshot_build_count",
            "recursive_record_read_count",
            "recursive_traversal_folder_count",
            "payload_build_elapsed_ms",
            "snapshot_cache_revision",
            "snapshot_cache_entry_count",
        }
        first_status = {key: value for key, value in first["status"].items() if key not in diagnostic_keys}
        second_status = {key: value for key, value in second["status"].items() if key not in diagnostic_keys}
        self.assertEqual({**first, "status": first_status}, {**second, "status": second_status})
        self.assertTrue(second["status"]["pending"])
        self.assertEqual(second["status"]["pending_folder_count"], 1)
        self.assertEqual(second["status"]["missing_folder_count"], 1)
        self.assertEqual(len(cache.requests), request_count)
        self.assertTrue(second["status"]["snapshot_cache_hit"])

    def test_music_library_revision_advance_rebuilds_snapshot_with_new_rows(self) -> None:
        rclone = SimulatedRclone()
        app = self._build_app(rclone, local_root=None, workers=1)
        app.listing_cache = TrapListingCache()
        cache = self._complete_library_cache()
        app.folder_cache = cache

        with TestServer(app) as server:
            first = server.get_json("/music/endpoints/library?path=Music")
            cache.records["dropbox:Music"]["direct_files"] = [{
                "name": "New.wav",
                "path": "New.wav",
                "remote_path": "dropbox:Music/New.wav",
                "size": 12,
                "mtime": 1704067201.0,
            }]
            cache.advance_revision()
            second = server.get_json("/music/endpoints/library?path=Music")

        self.assertNotIn("New.wav", [song["display_name"] for song in first["songs"]])
        self.assertIn("New.wav", [song["display_name"] for song in second["songs"]])
        self.assertFalse(second["status"]["snapshot_cache_hit"])
        self.assertEqual(second["status"]["snapshot_build_count"], 1)

    def test_music_library_invalidation_revision_misses_direct_tree_and_sync_paths(self) -> None:
        rclone = SimulatedRclone()
        app = self._build_app(rclone, local_root=None, workers=1)
        app.listing_cache = TrapListingCache()
        cache = self._complete_library_cache()
        app.folder_cache = cache

        with TestServer(app) as server:
            server.get_json("/music/endpoints/library?path=Music")
            cache.invalidate("dropbox:Music/Album")
            direct = server.get_json("/music/endpoints/library?path=Music")
            cache.records["dropbox:Music/Album"] = {
                "complete": True,
                "direct_files": [],
                "direct_folders": [],
            }
            cache.advance_revision()
            cache.invalidate_tree("dropbox:Music")
            cache.records.update(self._complete_library_cache().records)
            tree = server.get_json("/music/endpoints/library?path=Music")
            cache.advance_revision()  # Represents DropboxBrowser.invalidate_sync_parents().
            sync = server.get_json("/music/endpoints/library?path=Music")

        self.assertFalse(direct["status"]["snapshot_cache_hit"])
        self.assertFalse(tree["status"]["snapshot_cache_hit"])
        self.assertFalse(sync["status"]["snapshot_cache_hit"])

    def test_music_library_large_tree_second_load_has_constant_snapshot_lookup(self) -> None:
        records = {
            "dropbox:Music": {"complete": True, "direct_files": [], "direct_folders": []},
        }
        for index in range(1200):
            remote_path = f"dropbox:Music/Folder {index}"
            records["dropbox:Music"]["direct_folders"].append({
                "name": f"Folder {index}",
                "path": f"Folder {index}",
                "remote_path": remote_path,
            })
            records[remote_path] = {
                "complete": True,
                "direct_files": [{
                    "name": f"Track {index}.mp3",
                    "path": f"Track {index}.mp3",
                    "remote_path": f"{remote_path}/Track {index}.mp3",
                    "size": 1,
                    "mtime": 1704067200.0,
                }],
                "direct_folders": [],
            }
        rclone = SimulatedRclone()
        app = self._build_app(rclone, local_root=None, workers=1)
        app.listing_cache = TrapListingCache()
        cache = DirectFilesFolderCache(records)
        app.folder_cache = cache

        with TestServer(app) as server:
            first = server.get_json("/music/endpoints/library?path=Music")
            reads_after_first = cache.get_calls
            second = server.get_json("/music/endpoints/library?path=Music")

        self.assertEqual(len(first["folders"]), 1200)
        self.assertEqual(len(first["songs"]), 1200)
        self.assertEqual(cache.get_calls, reads_after_first)
        self.assertEqual(second["status"]["recursive_record_read_count"], 0)
        self.assertEqual(second["status"]["snapshot_cache_hit"], True)
        self.assertEqual(rclone.calls, [])
        events = [event for event in self.read_trace_events() if event.get("event") == "music_library_poll"]
        self.assertEqual(len(events), 2)
        self.assertEqual(events[-1]["snapshot_cache_hit"], True)
        self.assertEqual(
            [event for event in self.read_trace_events() if event.get("event") == "request_deduplicated"],
            [],
        )

    def test_music_status_endpoint_returns_supported_extensions(self) -> None:
        rclone = SimulatedRclone()
        app = self._build_app(rclone, local_root=None, workers=1)

        with TestServer(app) as server:
            payload = server.get_json("/music/endpoints/status")

        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["endpoint_root"], "/music/endpoints")
        self.assertEqual(payload["supported_extensions"], [".mp3", ".m4a", ".m4b", ".aac", ".wav", ".ogg", ".oga", ".opus", ".flac"])
        self.assertEqual(rclone.calls, [])

    def test_unknown_music_endpoint_returns_404(self) -> None:
        rclone = SimulatedRclone()
        app = self._build_app(rclone, local_root=None, workers=1)

        with TestServer(app) as server:
            with self.assertRaises(HTTPError) as ctx:
                server.get_text("/music/endpoints/nope")

        self.assertEqual(ctx.exception.code, HTTPStatus.NOT_FOUND)
        self.assertEqual(rclone.calls, [])

    def test_music_library_uses_cached_listing_without_rclone_calls(self) -> None:
        rclone = SimulatedRclone()
        app = self._build_app(rclone, local_root=None, workers=1)
        app.listing_cache = TrapListingCache()
        app.folder_cache = DirectFilesFolderCache({
            "dropbox:Music": {
                "complete": True,
                "newest_mtime": 1704067204.0,
                "direct_files": [
                    {
                        "name": "Loose.MP3",
                        "path": "Loose.MP3",
                        "remote_path": "dropbox:Music/Loose.MP3",
                        "size": 10,
                        "mtime": 1704067201.0,
                    },
                    {
                        "name": "notes.txt",
                        "path": "notes.txt",
                        "remote_path": "dropbox:Music/notes.txt",
                        "size": 11,
                        "mtime": 1704067202.0,
                    },
                    {
                        "name": "raw.flac",
                        "path": "raw.flac",
                        "remote_path": "dropbox:Music/raw.flac",
                        "size": 12,
                        "mtime": 1704067203.0,
                    },
                ],
                "direct_folders": [
                    {
                        "name": "Album",
                        "path": "Album",
                        "remote_path": "dropbox:Music/Album",
                        "mtime": 1704067200.0,
                    },
                ],
            },
            "dropbox:Music/Album": {
                "complete": True,
                "newest_mtime": 1704067207.0,
                "direct_files": [
                    {
                        "name": "Track.m4a",
                        "path": "Track.m4a",
                        "remote_path": "dropbox:Music/Album/Track.m4a",
                        "size": 13,
                        "mtime": 1704067204.0,
                    },
                    {
                        "name": "Voice.AAC",
                        "path": "Voice.AAC",
                        "remote_path": "dropbox:Music/Album/Voice.AAC",
                        "size": 14,
                        "mtime": 1704067205.0,
                    },
                    {
                        "name": "Wave.WAV",
                        "path": "Wave.WAV",
                        "remote_path": "dropbox:Music/Album/Wave.WAV",
                        "size": 15,
                        "mtime": 1704067206.0,
                    },
                    {
                        "name": "skip.ogg",
                        "path": "skip.ogg",
                        "remote_path": "dropbox:Music/Album/skip.ogg",
                        "size": 16,
                        "mtime": 1704067207.0,
                    },
                ],
                "direct_folders": [],
            },
        })

        with TestServer(app) as server:
            payload = server.get_json("/music/endpoints/library?path=" + quote("Music"))

        self.assertEqual(payload["root"]["remote_path"], "dropbox:Music")
        self.assertEqual(payload["root"]["rel_path"], "")
        self.assertEqual(payload["root"]["stream_path"], "Music")
        self.assertEqual(payload["status"]["cache_status"], "complete")
        self.assertFalse(payload["status"]["pending"])
        self.assertEqual(payload["status"]["pending_folder_count"], 0)
        self.assertEqual(payload["status"]["queued_folder_count"], 0)
        self.assertEqual(payload["status"]["missing_folder_count"], 0)
        self.assertEqual(payload["status"]["missing_listing_count"], 0)
        self.assertEqual(app.folder_cache.page_epoch_calls, ["Music"])
        self.assertEqual(app.folder_cache.ensure_calls, [("dropbox:Music", 1234.5)])
        self.assertEqual(payload["folders"], [{
            "id": "folder:dropbox:Music/Album",
            "parent_id": "folder:dropbox:Music",
            "remote_path": "dropbox:Music/Album",
            "rel_path": "Album",
            "stream_path": "Music/Album",
            "display_name": "Album",
            "filename": "Album",
            "type": "folder",
            "listing_cached": True,
            "metadata_cached": True,
            "complete": True,
            "pending": False,
            "mtime": 1704067200.0,
            "recursive_mtime": 1704067207.0,
        }])
        self.assertEqual(
            [(song["display_name"], song["rel_path"], song["stream_path"], song["extension"], song["filename"], song["type"]) for song in payload["songs"]],
            [
                ("Loose.MP3", "Loose.MP3", "Music/Loose.MP3", ".mp3", "Loose.MP3", "file"),
                ("raw.flac", "raw.flac", "Music/raw.flac", ".flac", "raw.flac", "file"),
                ("Track.m4a", "Album/Track.m4a", "Music/Album/Track.m4a", ".m4a", "Track.m4a", "file"),
                ("Voice.AAC", "Album/Voice.AAC", "Music/Album/Voice.AAC", ".aac", "Voice.AAC", "file"),
                ("Wave.WAV", "Album/Wave.WAV", "Music/Album/Wave.WAV", ".wav", "Wave.WAV", "file"),
                ("skip.ogg", "Album/skip.ogg", "Music/Album/skip.ogg", ".ogg", "skip.ogg", "file"),
            ],
        )
        # Shared-client dual field: items aliases songs for media-library consumers.
        self.assertEqual(payload["items"], payload["songs"])
        self.assertEqual(payload["supported_extensions"], [".mp3", ".m4a", ".m4b", ".aac", ".wav", ".ogg", ".oga", ".opus", ".flac"])
        self.assertEqual(rclone.calls, [])

    def test_music_library_stops_at_missing_child_folder_cache_record(self) -> None:
        rclone = SimulatedRclone()
        app = self._build_app(rclone, local_root=None, workers=1)
        app.listing_cache = TrapListingCache()
        app.folder_cache = DirectFilesFolderCache({
            "dropbox:Music": {
                "complete": True,
                "direct_files": [
                    {
                        "name": "Cached.mp3",
                        "path": "Cached.mp3",
                        "remote_path": "dropbox:Music/Cached.mp3",
                        "size": 10,
                        "mtime": 1704067200.0,
                    },
                ],
                "direct_folders": [
                    {
                        "name": "Known",
                        "path": "Known",
                        "remote_path": "dropbox:Music/Known",
                    },
                ],
            },
        })

        with TestServer(app) as server:
            payload = server.get_json("/music/endpoints/library?path=Music")

        self.assertEqual(payload["status"]["cache_status"], "partial")
        self.assertTrue(payload["status"]["pending"])
        self.assertEqual(payload["status"]["pending_folder_count"], 1)
        self.assertEqual(payload["status"]["queued_folder_count"], 1)
        self.assertEqual(payload["status"]["missing_folder_count"], 1)
        self.assertEqual(payload["status"]["missing_listing_count"], 1)
        self.assertEqual(app.folder_cache.ensure_calls, [("dropbox:Music", 1234.5)])
        self.assertEqual(payload["folders"][0]["listing_cached"], False)
        self.assertEqual(payload["folders"][0]["metadata_cached"], False)
        self.assertTrue(payload["folders"][0]["pending"])
        self.assertEqual([song["display_name"] for song in payload["songs"]], ["Cached.mp3"])
        self.assertEqual(rclone.calls, [])

    def test_music_library_uses_folder_cache_direct_files_without_root_listing_cache(self) -> None:
        rclone = SimulatedRclone()
        app = self._build_app(rclone, local_root=None, workers=1)
        app.listing_cache = TrapListingCache()
        app.folder_cache = DirectFilesFolderCache({
            "dropbox:Music": {
                "complete": True,
                "direct_folders": [],
                "direct_files": [
                    {
                        "name": "Direct.mp3",
                        "path": "Direct.mp3",
                        "remote_path": "dropbox:Music/Direct.mp3",
                        "extension": ".mp3",
                        "size": 10,
                        "mtime": 1704067200.0,
                    },
                    {
                        "name": "notes.txt",
                        "path": "notes.txt",
                        "remote_path": "dropbox:Music/notes.txt",
                        "extension": ".txt",
                        "size": 11,
                        "mtime": 1704067201.0,
                    },
                ],
            }
        })

        with TestServer(app) as server:
            payload = server.get_json("/music/endpoints/library?path=Music")

        self.assertEqual(payload["status"]["cache_status"], "complete")
        self.assertFalse(payload["status"]["pending"])
        self.assertEqual(payload["status"]["pending_folder_count"], 0)
        self.assertEqual(payload["status"]["queued_folder_count"], 0)
        self.assertEqual(payload["status"]["missing_folder_count"], 0)
        self.assertEqual(payload["songs"][0]["display_name"], "Direct.mp3")
        self.assertEqual(payload["songs"][0]["stream_path"], "Music/Direct.mp3")
        self.assertEqual(payload["songs"][0]["rel_path"], "Direct.mp3")
        self.assertEqual(payload["songs"][0]["size"], 10)
        self.assertEqual(payload["songs"][0]["filename"], "Direct.mp3")
        self.assertEqual(payload["songs"][0]["type"], "file")
        self.assertEqual(payload["folders"], [])
        self.assertEqual(rclone.calls, [])
        self.assertEqual(app.folder_cache.requests, [])
        self.assertEqual(app.folder_cache.ensure_calls, [("dropbox:Music", 1234.5)])

    def test_music_library_handles_empty_complete_folder(self) -> None:
        rclone = SimulatedRclone()
        app = self._build_app(rclone, local_root=None, workers=1)
        app.listing_cache = TrapListingCache()
        app.folder_cache = DirectFilesFolderCache({
            "dropbox:Music": {"complete": True, "direct_files": [], "direct_folders": []},
        })

        with TestServer(app) as server:
            payload = server.get_json("/music/endpoints/library?path=Music")

        self.assertEqual(payload["status"]["cache_status"], "complete")
        self.assertFalse(payload["status"]["pending"])
        self.assertEqual(payload["status"]["pending_folder_count"], 0)
        self.assertEqual(payload["status"]["queued_folder_count"], 0)
        self.assertEqual(payload["status"]["missing_folder_count"], 0)
        self.assertEqual(payload["status"]["missing_listing_count"], 0)
        self.assertEqual(payload["folders"], [])
        self.assertEqual(payload["songs"], [])
        self.assertEqual(rclone.calls, [])
        self.assertEqual(app.folder_cache.requests, [])
        self.assertEqual(app.folder_cache.ensure_calls, [("dropbox:Music", 1234.5)])

    def test_music_library_poll_trace_includes_cache_and_client_poll_fields(self) -> None:
        rclone = SimulatedRclone()
        app = self._build_app(rclone, local_root=None, workers=1)
        app.listing_cache = TrapListingCache()
        app.folder_cache = DirectFilesFolderCache({
            "dropbox:Music": {"complete": True, "direct_files": [], "direct_folders": []},
        })

        with TestServer(app) as server:
            server.get_json("/music/endpoints/library?path=Music&poll_seq=7&poll_delay_ms=4000&poll_refresh=1")

        events = [event for event in self.read_trace_events() if event.get("event") == "music_library_poll"]
        self.assertEqual(len(events), 1)
        event = events[0]
        self.assertEqual(event["endpoint"], "library")
        self.assertEqual(event["query_path"], "Music")
        self.assertEqual(event["root_remote_path"], "dropbox:Music")
        self.assertEqual(event["http_status"], 200)
        self.assertEqual(event["cache_status"], "complete")
        self.assertEqual(event["complete"], True)
        self.assertEqual(event["pending"], False)
        self.assertEqual(event["pending_folder_count"], 0)
        self.assertEqual(event["queued_folder_count"], 0)
        self.assertEqual(event["missing_folder_count"], 0)
        self.assertEqual(event["folder_count"], 0)
        self.assertEqual(event["song_count"], 0)
        self.assertEqual(event["snapshot_cache_hit"], False)
        self.assertEqual(event["snapshot_build_count"], 1)
        self.assertEqual(event["recursive_record_read_count"], 1)
        self.assertEqual(event["recursive_traversal_folder_count"], 1)
        self.assertIsInstance(event["payload_build_elapsed_ms"], float)
        self.assertIsInstance(event["snapshot_cache_revision"], int)
        self.assertEqual(event["client_poll_seq"], "7")
        self.assertEqual(event["client_poll_delay_ms"], "4000")
        self.assertEqual(event["client_poll_refresh"], "1")
        self.assertIsInstance(event["elapsed_ms"], float)

    def test_music_library_discovers_child_folders_from_folder_cache_direct_folders(self) -> None:
        rclone = SimulatedRclone()
        app = self._build_app(rclone, local_root=None, workers=1)
        app.listing_cache = TrapListingCache()
        app.folder_cache = DirectFilesFolderCache({
            "dropbox:Music": {
                "complete": True,
                "direct_files": [
                    {
                        "name": "Root.mp3",
                        "path": "Root.mp3",
                        "remote_path": "dropbox:Music/Root.mp3",
                        "extension": ".mp3",
                        "size": 10,
                        "mtime": 1704067200.0,
                    },
                ],
                "direct_folders": [
                    {
                        "name": "Album",
                        "path": "Album",
                        "remote_path": "dropbox:Music/Album",
                        "mtime": 1704067201.0,
                    },
                ],
            },
            "dropbox:Music/Album": {
                "complete": True,
                "direct_files": [
                    {
                        "name": "Nested.m4a",
                        "path": "Nested.m4a",
                        "remote_path": "dropbox:Music/Album/Nested.m4a",
                        "extension": ".m4a",
                        "size": 11,
                        "mtime": 1704067202.0,
                    },
                ],
                "direct_folders": [
                    {
                        "name": "Disc 2",
                        "path": "Disc 2",
                        "remote_path": "dropbox:Music/Album/Disc 2",
                        "mtime": 1704067203.0,
                    },
                ],
            },
            "dropbox:Music/Album/Disc 2": {
                "complete": True,
                "direct_files": [
                    {
                        "name": "Deep.aac",
                        "path": "Deep.aac",
                        "remote_path": "dropbox:Music/Album/Disc 2/Deep.aac",
                        "extension": ".aac",
                        "size": 12,
                        "mtime": 1704067204.0,
                    },
                ],
                "direct_folders": [],
            },
        })

        with TestServer(app) as server:
            payload = server.get_json("/music/endpoints/library?path=Music")

        self.assertEqual(payload["status"]["cache_status"], "complete")
        self.assertFalse(payload["status"]["pending"])
        self.assertEqual(payload["status"]["pending_folder_count"], 0)
        self.assertEqual(payload["status"]["queued_folder_count"], 0)
        self.assertEqual(payload["status"]["missing_folder_count"], 0)
        self.assertEqual(
            [(folder["display_name"], folder["rel_path"], folder["metadata_cached"], folder["pending"]) for folder in payload["folders"]],
            [("Album", "Album", True, False), ("Disc 2", "Album/Disc 2", True, False)],
        )
        self.assertEqual(
            [(song["display_name"], song["rel_path"]) for song in payload["songs"]],
            [("Root.mp3", "Root.mp3"), ("Nested.m4a", "Album/Nested.m4a"), ("Deep.aac", "Album/Disc 2/Deep.aac")],
        )
        self.assertEqual(rclone.calls, [])
        self.assertEqual(app.folder_cache.requests, [])
        self.assertEqual(app.folder_cache.ensure_calls, [("dropbox:Music", 1234.5)])

    def test_music_library_reports_partial_when_cached_root_has_missing_descendant(self) -> None:
        rclone = SimulatedRclone()
        app = self._build_app(rclone, local_root=None, workers=1)
        app.listing_cache = TrapListingCache()
        app.folder_cache = DirectFilesFolderCache({
            "dropbox:Music": {
                "complete": True,
                "direct_files": [],
                "direct_folders": [
                    {
                        "name": "Album",
                        "path": "Album",
                        "remote_path": "dropbox:Music/Album",
                    },
                ],
            },
            "dropbox:Music/Album": {
                "complete": True,
                "direct_files": [],
                "direct_folders": [
                    {
                        "name": "Disc 2",
                        "path": "Disc 2",
                        "remote_path": "dropbox:Music/Album/Disc 2",
                    },
                ],
            },
        })

        with TestServer(app) as server:
            payload = server.get_json("/music/endpoints/library?path=Music")

        self.assertEqual(payload["status"]["cache_status"], "partial")
        self.assertTrue(payload["status"]["pending"])
        self.assertEqual(payload["status"]["pending_folder_count"], 1)
        self.assertEqual(payload["status"]["queued_folder_count"], 1)
        self.assertEqual(payload["status"]["missing_folder_count"], 1)
        self.assertEqual(payload["status"]["missing_listing_count"], 1)
        self.assertEqual(
            [(folder["display_name"], folder["metadata_cached"], folder["complete"], folder["pending"]) for folder in payload["folders"]],
            [("Album", True, True, False), ("Disc 2", False, False, True)],
        )
        self.assertEqual(rclone.calls, [])
        self.assertEqual(app.folder_cache.ensure_calls, [("dropbox:Music", 1234.5)])

    def test_music_library_uses_direct_listing_primed_by_force_refresh(self) -> None:
        rclone = SimulatedRclone({
            "dropbox:Music": [
                SimulatedLsjsonResponse(items=[
                    {
                        "Name": "Album",
                        "Path": "Album",
                        "IsDir": True,
                        "Size": 0,
                        "ModTime": "2024-01-01T00:00:00Z",
                    },
                ]),
            ],
        })
        app = self._build_app(rclone, local_root=None, workers=1)
        cache = app.folder_cache
        assert cache is not None

        app.list_entries("Music", force_refresh=True)
        root_data = cache.get("dropbox:Music") or {}
        self.assertFalse(root_data.get("complete"))
        self.assertEqual(
            [(folder["name"], folder["remote_path"]) for folder in root_data.get("direct_folders", [])],
            [("Album", "dropbox:Music/Album")],
        )

        with cache._lock:
            cache._acc["dropbox:Music/Album"] = {
                "size": 10,
                "count": 1,
                "mtime": 1704067201.0,
                "diff_status": "unavailable",
                "diff_complete": True,
                "first_diff_path": None,
                "file_statuses": {},
                "direct_items": [],
                "direct_files": [
                    {
                        "name": "Track.mp3",
                        "path": "Track.mp3",
                        "remote_path": "dropbox:Music/Album/Track.mp3",
                        "size": 10,
                        "mtime": 1704067201.0,
                    },
                ],
                "direct_folders": [],
            }
            cache._write_cache("dropbox:Music/Album", complete=True)

        with TestServer(app) as server:
            payload = server.get_json("/music/endpoints/library?path=Music")

        self.assertEqual(payload["status"]["cache_status"], "partial")
        self.assertTrue(payload["status"]["pending"])
        self.assertEqual(
            [(folder["display_name"], folder["metadata_cached"], folder["complete"]) for folder in payload["folders"]],
            [("Album", True, True)],
        )
        self.assertEqual([(song["display_name"], song["rel_path"]) for song in payload["songs"]], [("Track.mp3", "Album/Track.mp3")])

    def test_music_library_reports_unavailable_without_root_listing(self) -> None:
        rclone = SimulatedRclone()
        app = self._build_app(rclone, local_root=None, workers=1)
        app.listing_cache = TrapListingCache()
        app.folder_cache = DirectFilesFolderCache({})

        with TestServer(app) as server:
            payload = server.get_json("/music/endpoints/library?path=Music")

        self.assertEqual(payload["status"]["cache_status"], "unavailable")
        self.assertTrue(payload["status"]["pending"])
        self.assertEqual(payload["status"]["pending_folder_count"], 1)
        self.assertEqual(payload["status"]["queued_folder_count"], 1)
        self.assertEqual(payload["status"]["missing_folder_count"], 1)
        self.assertEqual(payload["status"]["missing_listing_count"], 1)
        self.assertIn(payload["status"]["message"], {
            "Library metadata is loading.",
            "No cached folder metadata is available for this folder yet.",
        })
        self.assertEqual(payload["folders"], [])
        self.assertEqual(payload["songs"], [])
        self.assertEqual(rclone.calls, [])
        self.assertEqual(app.folder_cache.requests, ["dropbox:Music"])
        self.assertEqual(app.folder_cache.ensure_calls, [("dropbox:Music", 1234.5)])

    def test_music_library_pending_fields_reflect_missing_descendants_under_complete_root(self) -> None:
        rclone = SimulatedRclone()
        app = self._build_app(rclone, local_root=None, workers=1)
        app.listing_cache = TrapListingCache()
        app.folder_cache = DirectFilesFolderCache({
            "dropbox:Music": {
                "complete": True,
                "direct_files": [],
                "direct_folders": [
                    {
                        "name": "Album",
                        "path": "Album",
                        "remote_path": "dropbox:Music/Album",
                    },
                ],
            },
        })

        def ensure_known_subtree(remote_path: str, page_epoch: float) -> dict[str, int | float]:
            app.folder_cache.ensure_calls.append((remote_path, page_epoch))
            return {
                "page_epoch": page_epoch,
                "queued_folder_count": 1,
                "pending_folder_count": 2,
                "missing_folder_count": 1,
            }

        app.folder_cache.ensure_known_subtree = ensure_known_subtree  # type: ignore[method-assign]

        with TestServer(app) as server:
            payload = server.get_json("/music/endpoints/library?path=Music")

        self.assertEqual(payload["status"]["cache_status"], "partial")
        self.assertTrue(payload["status"]["pending"])
        self.assertEqual(payload["status"]["pending_folder_count"], 2)
        self.assertEqual(payload["status"]["queued_folder_count"], 1)
        self.assertEqual(payload["status"]["missing_folder_count"], 1)
        self.assertEqual(payload["status"]["missing_listing_count"], 1)

    def test_music_library_song_and_folder_nodes_expose_sorting_fields(self) -> None:
        rclone = SimulatedRclone()
        app = self._build_app(rclone, local_root=None, workers=1)
        app.listing_cache = TrapListingCache()
        app.folder_cache = DirectFilesFolderCache({
            "dropbox:Music": {
                "complete": True,
                "direct_files": [
                    {
                        "name": "Track.mp3",
                        "path": "Track.mp3",
                        "remote_path": "dropbox:Music/Track.mp3",
                        "size": 321,
                        "mtime": 1704067200.0,
                    },
                ],
                "direct_folders": [
                    {
                        "name": "Album",
                        "path": "Album",
                        "remote_path": "dropbox:Music/Album",
                        "mtime": 1704067201.0,
                    },
                ],
            },
            "dropbox:Music/Album": {
                "complete": True,
                "newest_mtime": 1704067202.0,
                "direct_files": [],
                "direct_folders": [],
            },
        })

        with TestServer(app) as server:
            payload = server.get_json("/music/endpoints/library?path=Music")

        song = payload["songs"][0]
        folder = payload["folders"][0]
        self.assertEqual(
            song,
            {
                "id": "song:dropbox:Music/Track.mp3",
                "parent_id": "folder:dropbox:Music",
                "remote_path": "dropbox:Music/Track.mp3",
                "stream_path": "Music/Track.mp3",
                "rel_path": "Track.mp3",
                "display_name": "Track.mp3",
                "filename": "Track.mp3",
                "type": "file",
                "extension": ".mp3",
                "size": 321,
                "mtime": 1704067200.0,
            },
        )
        self.assertEqual(
            folder,
            {
                "id": "folder:dropbox:Music/Album",
                "parent_id": "folder:dropbox:Music",
                "remote_path": "dropbox:Music/Album",
                "rel_path": "Album",
                "stream_path": "Music/Album",
                "display_name": "Album",
                "filename": "Album",
                "type": "folder",
                "listing_cached": True,
                "metadata_cached": True,
                "complete": True,
                "pending": False,
                "mtime": 1704067201.0,
                "recursive_mtime": 1704067202.0,
            },
        )

    def test_music_library_rejects_parent_segments(self) -> None:
        rclone = SimulatedRclone()
        app = self._build_app(rclone, local_root=None, workers=1)

        with TestServer(app) as server:
            with self.assertRaises(HTTPError) as ctx:
                server.get_text("/music/endpoints/library?path=..")

        self.assertEqual(ctx.exception.code, HTTPStatus.BAD_REQUEST)
        self.assertEqual(rclone.calls, [])
