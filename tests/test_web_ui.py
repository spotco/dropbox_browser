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
    def test_page_renders_rows_from_folder_cache_direct_listing_without_rclone_call(self) -> None:
        class DirectListingFolderCache:
            def __init__(self) -> None:
                self.notified: list[tuple[str | None, bool]] = []
                self.requests: list[str] = []

            def notify_page_load(self, _page_time: float, *, page_key: str | None = None, force: bool = False) -> None:
                self.notified.append((page_key, force))

            def invalidate(self, _remote_path: str) -> None:
                return None

            def get(self, _remote_path: str) -> dict | None:
                return None

            def request(self, remote_path: str, *_args, **_kwargs) -> None:
                self.requests.append(remote_path)

            def get_direct_listing(self, remote_path: str) -> list[dict]:
                self.requests.append(f"direct:{remote_path}")
                return [
                    {
                        "Name": "cached.txt",
                        "Path": "cached.txt",
                        "IsDir": False,
                        "Size": 6,
                        "ModTime": "2024-01-01T12:00:00Z",
                    },
                ]

        rclone = SimulatedRclone()
        listing_cache = ListingCacheManager(ttl_seconds=1800)
        folder_cache = DirectListingFolderCache()
        app = DropboxBrowser(rclone, "dropbox:", None, folder_cache=folder_cache, listing_cache=listing_cache)

        with TestServer(app) as server:
            html = server.get_text("/")

        self.assertIn("cached.txt", html)
        self.assertEqual(folder_cache.notified, [("", False)])
        self.assertEqual(folder_cache.requests, ["direct:dropbox:"])
        self.assertEqual(rclone.calls, [])

    def test_page_render_defers_child_folder_metadata_requests(self) -> None:
        class RecordingChildFolderCache:
            def __init__(self) -> None:
                self.requests: list[str] = []

            def notify_page_load(self, *_args, **_kwargs) -> None:
                return None

            def invalidate(self, _remote_path: str) -> None:
                return None

            def get(self, _remote_path: str) -> dict | None:
                return None

            def request(self, remote_path: str, *_args, **_kwargs) -> None:
                self.requests.append(remote_path)

        local_root = self.create_local_root({
            "alpha/file.txt": b"alpha",
            "beta/file.txt": b"beta",
        })
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[
                remote_dir_item("alpha"),
                remote_dir_item("beta"),
            ])],
        })
        listing_cache = ListingCacheManager(ttl_seconds=1800)
        folder_cache = RecordingChildFolderCache()
        app = DropboxBrowser(rclone, "dropbox:", local_root, folder_cache=folder_cache, listing_cache=listing_cache)

        with TestServer(app) as server:
            html = server.get_text("/")

        self.assertIn('data-folder-path="alpha"', html)
        self.assertIn('data-folder-path="beta"', html)
        self.assertEqual(folder_cache.requests, ["dropbox:"])

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
            music_entry_js = server.get_text("/assets/js/music.js")
            music_layout_js = server.get_text("/assets/js/music-layout.js")
            music_coverart_js = server.get_text("/assets/js/music-coverart.js")
            music_library_js = server.get_text("/assets/js/music-library.js")
            music_library_helpers_js = server.get_text("/assets/js/music-library-helpers.js")
            music_playlist_js = server.get_text("/assets/js/music-playlist.js")
            music_playback_js = server.get_text("/assets/js/music-playback.js")
            music_metadata_js = server.get_text("/assets/js/music-metadata.js")
            music_shared_js = server.get_text("/assets/js/music-shared.js")
            js = "\n".join([
                server.get_text("/assets/js/settings.js"),
                server.get_text("/assets/js/bottom-pane.js"),
                server.get_text("/assets/js/log.js"),
                music_entry_js,
                music_layout_js,
                music_coverart_js,
                music_library_js,
                music_playlist_js,
                music_playback_js,
                music_metadata_js,
                music_shared_js,
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
        self.assertIn('<script type="module" src="/assets/js/music.js"></script>', html)
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
        self.assertIn("DL .bat file to delete all local-only files", html)
        self.assertIn("Copy all Dropbox-Only Files to Local", html)
        self.assertIn('data-batch-action="download_local_only_delete_bat"', html)
        self.assertIn('data-batch-action="dropbox_only_to_local_all"', html)
        self.assertIn(".batch-delete-command", css)
        self.assertIn("submitDownload('/local-only-delete-bat'", js)
        self.assertIn("function finishPopupTemporary", js)
        self.assertIn("popup.classList.add('hidden')", js)
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
        self.assertIn('id="music-library-pane"', html)
        self.assertIn('id="music-playlist-pane"', html)
        self.assertIn('id="music-playback-pane"', html)
        self.assertIn("Song Library", html)
        self.assertIn("Active Playlist", html)
        self.assertIn("Playback Controls", html)
        self.assertIn('id="music-library-load"', html)
        self.assertIn('class="music-library-status-text"', html)
        self.assertIn('class="music-library-status-actions"', html)
        self.assertIn('class="music-library-sort-controls"', html)
        self.assertIn('data-library-sort-key="name"', html)
        self.assertIn('data-library-sort-key="date"', html)
        self.assertIn('Name ↑', html)
        self.assertIn('Date ↓', html)
        self.assertIn('id="music-library-status"', html)
        self.assertIn('id="music-library-tree"', html)
        self.assertIn("Library not loaded.", html)
        self.assertIn("Load the current folder to show cached songs.", html)
        self.assertIn('id="music-resizer-library-playlist"', html)
        self.assertIn('id="music-resizer-playlist-playback"', html)
        self.assertIn('id="music-active-playlist-name"', html)
        self.assertIn('data-default-name="New Playlist">New Playlist</span>', html)
        self.assertIn('id="music-playlist-import"', html)
        self.assertIn('id="music-playlist-export"', html)
        self.assertIn('id="music-playlist-controls"', html)
        self.assertIn('id="music-playlist-rename"', html)
        self.assertIn('id="music-playlist-load"', html)
        self.assertIn('id="music-playlist-save"', html)
        self.assertIn('id="music-playlist-import-input"', html)
        self.assertIn('id="music-playlist-save-toast"', html)
        self.assertIn('id="music-playlist-save-toast-text"', html)
        self.assertIn('id="music-playlist-save-toast-close"', html)
        self.assertIn('accept=".m3u8,.json,application/json"', html)
        self.assertIn('id="music-playlist-rename-dialog"', html)
        self.assertIn('id="music-playlist-overwrite-dialog"', html)
        self.assertIn('id="music-playlist-load-dialog"', html)
        self.assertIn('id="music-playlist-rename-input"', html)
        self.assertIn('id="music-playlist-overwrite-message"', html)
        self.assertIn('id="music-playlist-load-list"', html)
        self.assertIn('id="music-playlist-sort-name"', html)
        self.assertIn('id="music-playlist-sort-last-modified"', html)
        self.assertIn('data-playlist-sort-key="name"', html)
        self.assertIn('data-playlist-sort-key="last_modified"', html)
        self.assertIn("No saved playlists yet.", html)
        self.assertIn("importPlaylistFiles", music_playlist_js)
        self.assertIn("exportPersistedPlaylists", music_playlist_js)
        self.assertIn("parseM3uPlaylistText", music_playlist_js)
        self.assertIn("playlistNameFromFilename", music_playlist_js)
        self.assertIn("function showPlaylistSaveToast(savedPlaylist)", music_playlist_js)
        self.assertIn("Saved \"", music_playlist_js)
        self.assertIn("formatShortDateTime(savedPlaylist.last_modified)", music_playlist_js)
        self.assertIn("Settings.get(state.playlistLoadSortSettingKey, {", music_playlist_js)
        self.assertIn("Settings.set(state.playlistLoadSortSettingKey, {", music_playlist_js)
        self.assertIn("new Blob([JSON.stringify(data, null, 2)]", music_playlist_js)
        self.assertIn("URL.createObjectURL(blob)", music_playlist_js)
        self.assertIn("FileReader()", music_playlist_js)
        self.assertIn("Playlist is empty.", html)
        self.assertIn('class="music-playback-surface" aria-label="Playback controls"', html)
        self.assertIn('class="music-art-shell"', html)
        self.assertIn('id="music-cover-art" class="music-cover-art hidden" alt="Current song cover art" hidden', html)
        self.assertIn('id="music-art-placeholder"', html)
        self.assertIn('id="music-current-filename"', html)
        self.assertIn('id="music-song-title"', html)
        self.assertIn('id="music-song-artist"', html)
        self.assertIn('id="music-progress-slider"', html)
        self.assertIn('id="music-elapsed-time"', html)
        self.assertIn('id="music-total-time"', html)
        self.assertIn('id="music-prev"', html)
        self.assertIn('id="music-play"', html)
        self.assertNotIn('id="music-pause"', html)
        self.assertIn('id="music-next"', html)
        self.assertIn('id="music-shuffle-toggle" aria-pressed="false"', html)
        self.assertIn('id="music-loop-toggle" aria-pressed="false"', html)
        self.assertIn('id="music-volume-slider"', html)
        self.assertIn('src="/assets/icons/material-icon-theme/music-prev.svg"', html)
        self.assertIn('src="/assets/icons/material-icon-theme/music-play.svg"', html)
        self.assertIn("/assets/icons/material-icon-theme/music-pause.svg", js)
        self.assertIn('src="/assets/icons/material-icon-theme/music-next.svg"', html)
        self.assertIn('src="/assets/icons/material-icon-theme/music-shuffle.svg"', html)
        self.assertIn('src="/assets/icons/material-icon-theme/music-loop.svg"', html)
        self.assertIn('src="/assets/icons/material-icon-theme/music-volume.svg"', html)
        self.assertNotIn('<button type="button" id="music-play">Play</button>', html)
        self.assertNotIn('<button type="button" id="music-pause">Pause</button>', html)
        self.assertNotIn('<button type="button" id="music-prev">Previous</button>', html)
        self.assertNotIn('<button type="button" id="music-next">Next</button>', html)
        self.assertIn('id="music-audio" preload="metadata"', html)
        self.assertIn('id="music-library-context-menu"', html)
        self.assertIn('id="music-playlist-context-menu"', html)
        self.assertIn('data-action="add-selected"', html)
        self.assertIn('src="/assets/icons/material-icon-theme/music-add.svg"', html)
        self.assertIn('src="/assets/icons/material-icon-theme/music-play.svg"', html)
        self.assertIn('<span>Add to Playlist</span>', html)
        self.assertIn('<span>Play</span>', html)
        self.assertIn('data-action="select-all"', html)
        self.assertIn('>Absolute Path</div>', html)
        self.assertIn('class="music-playlist-reorder-heading" role="columnheader">Reorder</div>', html)
        self.assertIn('data-action="copy-filename"', html)
        self.assertIn('data-action="copy-absolute-path"', html)
        self.assertIn('data-action="copy-dropbox-url"', html)
        self.assertIn('class="music-context-menu-parent" aria-haspopup="true"', html)
        self.assertIn('class="music-context-menu-arrow" aria-hidden="true">></span>', html)
        self.assertIn("Settings.get('log-height', defaultHeight)", js)
        self.assertIn("function musicMinHeight()", js)
        self.assertIn("getPropertyValue('--music-min-pane-height')", js)
        self.assertIn("function ensureMusicPaneHeight()", js)
        self.assertIn("if (current < target) applyHeight(target);", js)
        self.assertIn("if (ev.detail.mode === 'music-player') ensureMusicPaneHeight();", js)
        self.assertIn("var defaultMode = 'server-log'", js)
        self.assertIn("Settings.get('bottom-pane-mode', defaultMode)", js)
        self.assertIn("Settings.set('bottom-pane-mode', mode)", js)
        self.assertIn("view.hidden = !selected", js)
        self.assertIn("bottom-pane-mode-changed", js)
        self.assertIn("data-pane-mode=\"music-player\"", html)
        self.assertIn("id=\"music-playlist-list\" class=\"music-playlist-list\" role=\"rowgroup\" tabindex=\"0\"", html)
        self.assertNotIn(".music-player-stub", css)
        self.assertNotIn(".music-player-stub", music_css)
        self.assertIn("--music-min-pane-height: 320px", music_css)
        self.assertIn(".music-player-shell", music_css)
        self.assertIn("grid-template-columns: minmax(190px, 1.05fr) 8px minmax(210px, 1.15fr) 8px minmax(220px, 0.8fr);", music_css)
        self.assertIn(".music-pane-resizer", music_css)
        self.assertIn("cursor: col-resize", music_css)
        self.assertIn(".music-pane-resizer.dragging", music_css)
        self.assertIn(".music-library-tree", music_css)
        self.assertIn(".music-playlist-list", music_css)
        self.assertIn("overscroll-behavior: contain", music_css)
        self.assertIn("overflow: auto", music_css)
        self.assertIn("scrollbar-color: #70859a #162033;", music_css)
        self.assertIn(".music-library-tree::-webkit-scrollbar", music_css)
        self.assertIn(".music-playlist-list::-webkit-scrollbar-thumb", music_css)
        self.assertIn(".music-player-controls", music_css)
        self.assertIn(".music-library-sort-controls", music_css)
        self.assertIn(".music-library-status-actions", music_css)
        self.assertIn(".music-library-status-text", music_css)
        self.assertIn(".music-playlist-save-toast", music_css)
        self.assertIn(".music-playlist-save-toast-close", music_css)
        self.assertIn(".music-library-sort-controls button[aria-pressed=\"true\"]", music_css)
        self.assertIn(".music-playlist-toolbar", music_css)
        self.assertIn(".music-playlist-toolbar-secondary", music_css)
        self.assertIn(".music-active-playlist-name", music_css)
        self.assertIn(".music-hidden-file-input", music_css)
        self.assertIn(".music-playlist-modal", music_css)
        self.assertIn(".music-playlist-modal.hidden", music_css)
        self.assertIn(".music-playlist-modal-card", music_css)
        self.assertIn(".music-playlist-load-card", music_css)
        self.assertIn(".music-playlist-text-input", music_css)
        self.assertIn(".music-playlist-modal-actions", music_css)
        self.assertIn(".music-playlist-load-table", music_css)
        self.assertIn(".music-playlist-load-heading", music_css)
        self.assertIn(".music-playlist-sort-button", music_css)
        self.assertIn(".music-playlist-load-list", music_css)
        self.assertIn(".music-playback-surface", music_css)
        self.assertIn("border-radius: 8px", music_css)
        self.assertIn(".music-art-shell", music_css)
        self.assertIn("aspect-ratio: 1 / 1", music_css)
        self.assertIn(".music-cover-art.hidden", music_css)
        self.assertIn("cursor: pointer", music_css)
        self.assertIn('.music-art-placeholder[data-art-state="ready"]', music_css)
        self.assertIn(".music-art-placeholder::before", music_css)
        self.assertIn(".music-song-title", music_css)
        self.assertIn(".music-song-artist", music_css)
        self.assertIn(".music-marquee-active", music_css)
        self.assertIn("@keyframes music-marquee-scroll", music_css)
        self.assertIn(".music-progress-slider", music_css)
        self.assertIn(".music-volume-slider", music_css)
        self.assertIn("accent-color: #78aee0", music_css)
        self.assertIn(".music-time-row", music_css)
        self.assertIn(".music-transport-row", music_css)
        self.assertIn(".music-button-icon", music_css)
        self.assertIn(".music-volume-row", music_css)
        self.assertIn(".music-player-controls button[aria-pressed=\"true\"]", music_css)
        self.assertIn(".music-player-controls button[aria-pressed=\"false\"]", music_css)
        self.assertIn(".music-context-menu-group", music_css)
        self.assertIn(".music-context-submenu", music_css)
        self.assertIn(".music-context-menu-group:hover > .music-context-submenu", music_css)
        self.assertIn("@media (max-width: 860px)", music_css)
        self.assertIn(".music-tree-row", music_css)
        self.assertIn(".music-tree-details", music_css)
        self.assertIn(".music-tree-date", music_css)
        self.assertIn("overflow: visible;", music_css)
        self.assertIn("text-align: right", music_css)
        self.assertIn("z-index: 2;", music_css)
        self.assertIn("padding: 3px 8px 3px calc(8px + (var(--music-tree-depth, 0) * 16px))", music_css)
        self.assertIn(".music-playlist-entry", music_css)
        self.assertIn(".music-playlist-entry.selected", music_css)
        self.assertIn(".music-playlist-entry.current", music_css)
        self.assertIn(".music-playlist-entry.drag-source", music_css)
        self.assertIn(".music-playlist-list.dragging .music-playlist-entry:hover:not(.selected):not(.drag-source)", music_css)
        self.assertIn(".music-playlist-list.dragging::before", music_css)
        self.assertIn('data-drop-indicator-visible="true"', music_css)
        self.assertIn(".music-playlist-handle-cell", music_css)
        self.assertIn(".music-playlist-drag-handle", music_css)
        self.assertIn(".music-playlist-drag-handle-icon", music_css)
        self.assertIn("mask-image: url('/assets/icons/material-icon-theme/music-drag-handle.svg');", music_css)
        self.assertIn("grid-template-columns: minmax(120px, 0.9fr) minmax(150px, 1.1fr) 34px;", music_css)
        self.assertIn("pane.setAttribute('data-player-ready', 'library')", music_entry_js)
        self.assertIn("currentFolder: document.body.dataset.currentFolderPath || ''", music_entry_js)
        self.assertIn("loadButtonDefaultText = ctx.els.loadButton.textContent || 'Load Current Folder';", music_entry_js)
        self.assertIn("librarySortButtons: pane.querySelectorAll('[data-library-sort-key]')", music_entry_js)
        self.assertIn("var pollDelayAttr = body ? body.dataset.musicLibraryPollDelayMs : '';", music_entry_js)
        self.assertIn("var parsedPollDelayMs = Number.parseInt(pollDelayAttr || '', 10);", music_entry_js)
        self.assertIn("var defaultPollDelayMs = Number.isFinite(parsedPollDelayMs) && parsedPollDelayMs > 0", music_entry_js)
        self.assertIn("defaultPollDelayMs: defaultPollDelayMs", music_entry_js)
        self.assertIn('data-music-library-poll-delay-ms="4000"', html)
        self.assertNotIn("var maxPollDelayMs", js)
        self.assertNotIn("pollDelayMs", js)
        self.assertIn("loadTimer: null", music_entry_js)
        self.assertIn("libraryPollingActive: false", music_entry_js)
        self.assertIn("lastLibraryPollResponseAt: 0", music_entry_js)
        self.assertIn("libraryPollSequence: 0", music_entry_js)
        self.assertIn("librarySortKey: 'name'", music_entry_js)
        self.assertIn("librarySortDirection: 'asc'", music_entry_js)
        self.assertIn("librarySortSettingKey: 'music-library-sort'", music_entry_js)
        self.assertIn("musicPaneWidthSettingKey: 'music-pane-widths'", music_entry_js)
        self.assertIn("defaultMusicPanePercents: [35, 38.333333, 26.666667]", music_entry_js)
        self.assertIn("fetch(libraryUrl(isRefresh, scheduledDelayMs))", music_library_js)
        self.assertIn("'/music/endpoints/library?path=' + encodeURIComponent(state.libraryRoot)", music_library_js)
        self.assertIn("'&poll_seq=' + encodeURIComponent(String(state.libraryPollSequence))", music_library_js)
        self.assertIn("'&poll_delay_ms=' + encodeURIComponent(String(scheduledDelayMs || 0))", music_library_js)
        self.assertIn("function normalizeMusicPanePercents(values)", music_layout_js)
        self.assertIn("function musicPaneResizeEnabled()", music_layout_js)
        self.assertIn("function applyMusicPanePercents(widths, persist)", music_layout_js)
        self.assertIn("function readSavedMusicPanePercents()", music_layout_js)
        self.assertIn("function startMusicPaneResize(resizerIndex, ev)", music_layout_js)
        self.assertIn("Settings.get(state.musicPaneWidthSettingKey, state.defaultMusicPanePercents)", music_layout_js)
        self.assertIn("Settings.set(state.musicPaneWidthSettingKey, state.currentMusicPanePercents)", music_layout_js)
        self.assertIn("export function libraryNameSortKey(name)", music_library_helpers_js)
        self.assertIn("export function libraryNodeDateSortValue(node)", music_library_helpers_js)
        self.assertIn("export function compareLibraryNames(left, right)", music_library_helpers_js)
        self.assertIn("export function compareLibraryNodes(sortKey, sortDirection, left, right)", music_library_helpers_js)
        self.assertIn("export function firstSelectedVisibleNodeId(visibleNodeIds, selectedIds, selectionAnchor)", music_library_helpers_js)
        self.assertIn("sortLibraryItems(map[key], state.librarySortKey, state.librarySortDirection)", music_library_js)
        self.assertIn("function captureLibraryViewportAnchor()", music_library_js)
        self.assertIn("function restoreLibraryViewportAnchor(anchor)", music_library_js)
        self.assertIn("function currentLibrarySortDirection()", music_library_js)
        self.assertIn("function defaultLibrarySortDirection(sortKey)", music_library_js)
        self.assertIn("function normalizeLibrarySort(sortState)", music_library_js)
        self.assertIn("function persistLibrarySort()", music_library_js)
        self.assertIn("function restoreLibrarySort()", music_library_js)
        self.assertIn("function sortButtonLabel(sortKey, sortDirection)", music_library_js)
        self.assertIn("var directionArrow = sortDirection === 'desc' ? '↓' : '↑';", music_library_js)
        self.assertIn("Settings.set(state.librarySortSettingKey, {", music_library_js)
        self.assertIn("Settings.get(state.librarySortSettingKey, {", music_library_js)
        self.assertIn("function setLibrarySort(sortKey, sortDirection)", music_library_js)
        self.assertIn("function toggleLibrarySort(sortKey)", music_library_js)
        self.assertIn("formatShortDateTime(libraryNodeDateSortValue(node))", music_library_js)
        self.assertIn("button.addEventListener('click', function () {", music_library_js)
        self.assertIn("restoreLibrarySort();", music_library_js)
        self.assertNotIn("localeCompare(b.display_name || '', undefined, {sensitivity: 'base'})", js)
        self.assertIn("function renderLibrary()", music_library_js)
        self.assertIn("function primarySelectedLibraryNodeId()", music_library_js)
        self.assertIn("function selectAllVisibleLibraryNodes()", music_library_js)
        self.assertIn("function selectVisibleLibrarySiblingsOfCurrentSelection()", music_library_js)
        self.assertIn("function handleLibrarySelectAllShortcut(ev)", music_library_js)
        self.assertIn("function performLibrarySelectAll()", music_library_js)
        self.assertIn("els.treeEl.scrollTop = nextScrollTop", music_library_js)
        self.assertIn("state.expandedIds[snapshot.root.id] = true", music_library_js)
        self.assertIn("function updateLoadButtonTimer()", music_library_js)
        self.assertIn("els.loadButton.textContent = state.loadButtonDefaultText + ' (' + elapsedSeconds + ')';", music_library_js)
        self.assertIn("function startLibraryPollingUi()", music_library_js)
        self.assertIn("function stopLibraryPollingUi()", music_library_js)
        self.assertIn("function libraryPollingMessage(data, previousSnapshot)", music_library_js)
        self.assertIn("' loaded this response. Totals: '", js)
        self.assertIn("'. Remaining: '", js)
        self.assertIn("function pruneSelectedIds(snapshot)", music_library_js)
        self.assertIn("function schedulePoll()", music_library_js)
        self.assertIn("if (!state.libraryRequested || !ctx.layoutApi.playbackUiMayPaint()) return;", music_library_js)
        self.assertIn("function shouldPollLibrary()", music_library_js)
        self.assertIn("if (!shouldPollLibrary()) return;", music_library_js)
        self.assertNotIn("function libraryFingerprint(data)", js)
        self.assertNotIn("return JSON.stringify(data || null);", js)
        self.assertNotIn("function nextPollDelayMs(data, fingerprint)", js)
        self.assertNotIn("lastLibraryFingerprint", js)
        self.assertIn("if (ev.detail.mode === 'music-player') {", music_entry_js)
        self.assertIn("else {", music_entry_js)
        self.assertIn("ctx.layoutApi.clearPlaybackUiPaintTimer();", music_entry_js)
        self.assertIn("ctx.libraryApi.stopPolling();", music_entry_js)
        self.assertIn("playlistLoadSortKey: 'last_modified'", music_entry_js)
        self.assertIn("playlistLoadSortDirection: 'desc'", music_entry_js)
        self.assertIn("playlistLoadSortSettingKey: 'music-playlist-load-sort'", music_entry_js)
        self.assertIn("openLibraryContextMenu(ev, node.id, kind)", music_library_js)
        self.assertIn("function selectedSongsForPlaylist()", music_library_js)
        self.assertIn("function songsUnderFolder(folderId)", music_library_js)
        self.assertIn("function addSongsToPlaylist(songs)", music_playlist_js)
        self.assertIn("function addSongToPlaylistAndPlay(song)", music_playlist_js)
        self.assertIn("state.activePlaylist.addSongs((songs || []).map(function (song) {", music_playlist_js)
        self.assertIn("import {PlaylistStore} from './music-playlist-store.js';", music_entry_js)
        self.assertIn("focusPlaylistRemotePath(song.remote_path)", music_playlist_js)
        self.assertIn("function renderPlaylist()", music_playlist_js)
        self.assertIn("function paintPlaylist()", music_playlist_js)
        self.assertIn("playlistRenderDirty: false", music_entry_js)
        self.assertIn("playlistSelectionDirty: false", music_entry_js)
        self.assertIn("pendingPlaylistFocusRemotePath: null", music_entry_js)
        self.assertIn("playlistStore: null", music_entry_js)
        self.assertIn("ctx.state.playlistStore = new PlaylistStore({storage: Settings});", music_entry_js)
        self.assertIn("state.pendingPlaylistFocusRemotePath = remotePath;", music_playlist_js)
        self.assertIn("function selectAllPlaylistSongs()", music_playlist_js)
        self.assertIn("function handlePlaylistSelectAllShortcut(ev)", music_playlist_js)
        self.assertIn("function performPlaylistSelectAll()", music_playlist_js)
        self.assertNotIn("data-action=\"add-folder\"", html)
        self.assertIn("node.metadata_cached ? 'files cached' : 'not cached'", music_library_js)
        self.assertIn("selectedPlaylistRemotePaths: Object.create(null)", music_entry_js)
        self.assertIn("function selectPlaylistRemotePath(remotePath, ev)", music_playlist_js)
        self.assertIn("function openPlaylistContextMenu(ev, remotePath)", music_playlist_js)
        self.assertIn("function removeSelectedPlaylistSongs()", music_playlist_js)
        self.assertIn("export function draggedPlaylistBlockRemotePaths(playlist, selectedRemotePaths, anchorRemotePath)", music_playlist_js)
        self.assertIn("export function reorderPlaylistBlock(playlist, selectedRemotePaths, anchorRemotePath, targetRemotePath, insertAfter, currentPlaylistIndex)", music_playlist_js)
        self.assertIn("export function playlistAutoScrollDeltaForBounds(clientY, listTop, listBottom)", music_playlist_js)
        self.assertIn("function startPlaylistDrag(remotePath, handleEl, ev)", music_playlist_js)
        self.assertIn("function queuePlaylistAutoScroll()", music_playlist_js)
        self.assertIn("function runPlaylistAutoScroll()", music_playlist_js)
        self.assertIn("dragHandle.className = 'music-playlist-drag-handle';", music_playlist_js)
        self.assertIn("dragHandleIcon.className = 'music-playlist-drag-handle-icon';", music_playlist_js)
        self.assertIn("handleCell.className = 'music-playlist-handle-cell';", music_playlist_js)
        self.assertIn("els.playlistListEl.dataset.dropIndicatorVisible = 'true';", music_playlist_js)
        self.assertIn("Moved ' + result.draggedRemotePaths.length + ' playlist song'", music_playlist_js)
        self.assertIn("els.libraryPlaylistResizer.addEventListener('pointerdown'", music_layout_js)
        self.assertIn("els.playlistPlaybackResizer.addEventListener('pointerdown'", music_layout_js)
        self.assertIn("if (els.treeEl) els.treeEl.addEventListener('keydown', handleLibrarySelectAllShortcut)", music_library_js)
        self.assertIn("if (els.playlistListEl) els.playlistListEl.addEventListener('keydown', handlePlaylistSelectAllShortcut)", music_playlist_js)
        self.assertIn("if (action === 'select-all') performLibrarySelectAll();", music_library_js)
        self.assertIn("if (action === 'select-all') performPlaylistSelectAll();", music_playlist_js)
        self.assertIn("function playPlaylistIndex(index)", music_playback_js)
        self.assertIn("function playCurrentOrFirst()", music_playback_js)
        self.assertIn("function pausePlayback()", music_playback_js)
        self.assertIn("function playNextSong()", music_playback_js)
        self.assertIn("function playPreviousSong()", music_playback_js)
        self.assertIn("function setPlaybackStatus(message)", music_playback_js)
        self.assertIn("function setButtonLabel(button, text)", music_playback_js)
        self.assertIn("function setButtonIcon(button, iconUrl)", music_playback_js)
        self.assertIn("function setPlayPauseVisualState(isPlaying)", music_playback_js)
        self.assertIn("function setMarqueeState(el)", music_metadata_js)
        self.assertIn("function refreshNowPlayingMarqueeStates()", music_metadata_js)
        self.assertIn("function scheduleNowPlayingMarqueeRefresh()", music_metadata_js)
        self.assertIn("el.scrollWidth > el.clientWidth + 1", music_metadata_js)
        self.assertIn("scrubberDragging: false", music_entry_js)
        self.assertIn("export function formatPlaybackTime(seconds)", music_shared_js)
        self.assertIn("return '00:00:00';", music_shared_js)
        self.assertIn("function resetProgressDisplay()", music_playback_js)
        self.assertIn("function syncDurationDisplay()", music_playback_js)
        self.assertIn("function syncCurrentTimeDisplay()", music_playback_js)
        self.assertIn("function applySeekFromSlider()", music_playback_js)
        self.assertIn("defaultVolume: 1", music_entry_js)
        self.assertIn("metadataRequestId: 0", music_entry_js)
        self.assertIn("metadataChunkSize: 262144", music_entry_js)
        self.assertIn("currentArtObjectUrl: null", music_entry_js)
        self.assertIn("pendingArtworkRemotePath: null", music_entry_js)
        self.assertIn("windowFocused: document.hasFocus ? document.hasFocus() : true", music_entry_js)
        self.assertIn("function showMetadataPlaceholders()", music_metadata_js)
        self.assertIn("var metadataDebugLoggingEnabled = false", music_metadata_js)
        self.assertIn("function showUnknownMetadata()", music_metadata_js)
        self.assertIn("function applyMetadataResult(metadata)", music_metadata_js)
        self.assertIn("function revokeCurrentArtObjectUrl()", music_metadata_js)
        self.assertIn("URL.revokeObjectURL(state.currentArtObjectUrl)", music_metadata_js)
        self.assertIn("function setCoverArtImage(art)", music_metadata_js)
        self.assertIn("URL.createObjectURL(blob)", music_metadata_js)
        self.assertIn("function startMetadataLoad(song)", music_metadata_js)
        self.assertIn("function fetchRangeBytes(url, start, end)", music_metadata_js)
        self.assertIn("Range: 'bytes=' + start + '-' + end", music_metadata_js)
        self.assertIn("function fetchHeadContentLength(url)", music_metadata_js)
        self.assertIn("function fetchMetadataBytes(url, extension)", music_metadata_js)
        self.assertIn("function parseMetadataBuffers(buffers, extension)", music_metadata_js)
        self.assertIn("function artworkFetchAllowed()", music_metadata_js)
        self.assertIn("function maybeResolveCoverArt(song, requestId, extension, buffers)", music_metadata_js)
        self.assertIn("function resumeDeferredArtworkLoad()", music_metadata_js)
        self.assertIn("resolveCoverArtFromMetadata", music_metadata_js)
        self.assertIn("if (requestId !== state.metadataRequestId) return;", music_metadata_js)
        self.assertIn("state.metadataRequestId += 1;", music_metadata_js)
        self.assertIn("metadataLoadedRemotePath: null", music_entry_js)
        self.assertIn("function maybeStartCurrentSongMetadataLoad()", music_metadata_js)
        self.assertIn("window.open(ctx.state.currentArtObjectUrl, '_blank', 'noopener')", music_entry_js)
        self.assertIn("function supportedArtMime(mime)", music_coverart_js)
        self.assertIn("function extractId3ArtFromTagBytes(bytes)", music_coverart_js)
        self.assertIn("function extractMp4ArtFromBytes(bytes)", music_coverart_js)
        self.assertIn("async function resolveCoverArtFromMetadata(options)", music_coverart_js)
        self.assertIn("function clampVolume(value)", music_playback_js)
        self.assertIn("function restoreVolume()", music_playback_js)
        self.assertIn("function persistVolume(volume)", music_playback_js)
        self.assertIn("function applyVolumeFromSlider()", music_playback_js)
        self.assertIn("defaultShuffleEnabled: false", music_entry_js)
        self.assertIn("defaultLoopPlaylist: false", music_entry_js)
        self.assertIn("function restoreShuffleEnabled()", music_playback_js)
        self.assertIn("function persistShuffleEnabled()", music_playback_js)
        self.assertIn("function restoreLoopPlaylist()", music_playback_js)
        self.assertIn("function persistLoopPlaylist()", music_playback_js)
        self.assertIn("function setCurrentFilename(song)", music_metadata_js)
        self.assertIn("function resetNowPlayingForSong(song)", music_metadata_js)
        self.assertIn("shuffleEnabled: false", music_entry_js)
        self.assertIn("loopPlaylist: false", music_entry_js)
        self.assertIn("shuffleBag: []", music_entry_js)
        self.assertIn("function resetShuffleBag()", music_playlist_js)
        self.assertIn("function shuffleBagIndex()", music_playlist_js)
        self.assertIn("if (state.shuffleEnabled) return ctx.playlistApi.shuffleBagIndex();", music_playback_js)
        self.assertIn("if (state.loopPlaylist) return 0;", music_playback_js)
        self.assertIn("function toggleShuffle()", music_playback_js)
        self.assertIn("function toggleLoopPlaylist()", music_playback_js)
        self.assertIn("Settings.get('music-shuffle-enabled', state.defaultShuffleEnabled)", music_playback_js)
        self.assertIn("Settings.set('music-shuffle-enabled', state.shuffleEnabled)", music_playback_js)
        self.assertIn("Settings.get('music-loop-playlist', state.defaultLoopPlaylist)", music_playback_js)
        self.assertIn("Settings.set('music-loop-playlist', state.loopPlaylist)", music_playback_js)
        self.assertIn("setButtonLabel(els.shuffleButton, state.shuffleEnabled ? 'Shuffle' : 'Order')", music_playback_js)
        self.assertIn("setButtonLabel(els.loopButton, state.loopPlaylist ? 'Loop On' : 'Loop')", music_playback_js)
        self.assertIn("els.shuffleButton.addEventListener('click', toggleShuffle)", music_playback_js)
        self.assertIn("els.loopButton.addEventListener('click', toggleLoopPlaylist)", music_playback_js)
        self.assertIn("els.audio.src = streamUrl(song)", music_playback_js)
        self.assertIn("'/file?path=' + encodeURIComponent(song.stream_path) + '&source=remote'", music_playback_js)
        self.assertIn("els.audio.addEventListener('playing', function () {", music_playback_js)
        self.assertIn("metadata.maybeStartCurrentSongMetadataLoad();", music_playback_js)
        self.assertIn("showMetadataPlaceholders();", music_metadata_js)
        self.assertIn("showUnknownMetadata();", music_metadata_js)
        self.assertIn("scheduleNowPlayingMarqueeRefresh();", music_metadata_js)
        self.assertIn("metadata.resetNowPlayingForSong(song);", music_playback_js)
        self.assertIn("metadata.resetNowPlayingForSong(null);", music_playback_js)
        self.assertIn("setCoverArtPlaceholderState('loading')", music_metadata_js)
        self.assertIn("setCoverArtPlaceholderState('empty')", music_metadata_js)
        self.assertIn("setCoverArtPlaceholderState('unsupported')", music_metadata_js)
        self.assertIn("function togglePlayPause()", music_playback_js)
        self.assertIn("els.playButton.addEventListener('click', togglePlayPause)", music_playback_js)
        self.assertIn("els.pauseButton.addEventListener('click', pausePlayback)", music_playback_js)
        self.assertIn("els.nextButton.addEventListener('click', playNextSong)", music_playback_js)
        self.assertIn("els.prevButton.addEventListener('click', playPreviousSong)", music_playback_js)
        self.assertIn("els.progressSlider.min = '0';", music_playback_js)
        self.assertIn("els.progressSlider.addEventListener('input', function () {", music_playback_js)
        self.assertIn("els.progressSlider.addEventListener('change', function () {", music_playback_js)
        self.assertIn("playbackUiThrottleMs: 1000", music_entry_js)
        self.assertIn("libraryRenderDirty: false", music_entry_js)
        self.assertIn("pendingLibraryStatusText: null", music_entry_js)
        self.assertIn("function playbackUiMayPaint()", music_layout_js)
        self.assertIn("return !document.hidden && isVisible();", music_layout_js)
        self.assertIn("if (document.hasFocus()) {", music_layout_js)
        self.assertIn("state.playbackUiPaintTimer = window.setTimeout(function () {", music_layout_js)
        self.assertIn("function repaintPlaybackDisplay()", music_playback_js)
        self.assertIn("function flushDeferredMusicPaneUpdates()", music_layout_js)
        self.assertIn("function resumeLibraryUpdates()", music_layout_js)
        self.assertIn("document.addEventListener('visibilitychange', function () {", music_entry_js)
        self.assertIn("window.addEventListener('focus', function () {", music_entry_js)
        self.assertIn("ctx.layoutApi.flushDeferredMusicPaneUpdates();", music_entry_js)
        self.assertIn("ctx.layoutApi.clearPlaybackUiPaintTimer();", music_entry_js)
        self.assertIn("Settings.get('music-volume', state.defaultVolume)", music_playback_js)
        self.assertIn("Settings.set('music-volume', volume)", music_playback_js)
        self.assertIn("els.audio.volume = volume;", music_playback_js)
        self.assertIn("ctx.playbackApi.restoreVolume();", music_entry_js)
        self.assertIn("els.volumeSlider.addEventListener('input', applyVolumeFromSlider)", music_playback_js)
        self.assertIn("els.volumeSlider.addEventListener('change', applyVolumeFromSlider)", music_playback_js)
        self.assertIn("els.audio.addEventListener('play', function () {", music_playback_js)
        self.assertIn("els.audio.addEventListener('pause', function () {", music_playback_js)
        self.assertIn("els.audio.addEventListener('loadedmetadata', function () {", music_playback_js)
        self.assertIn("els.audio.addEventListener('durationchange', function () {", music_playback_js)
        self.assertIn("els.audio.addEventListener('timeupdate', function () {", music_playback_js)
        self.assertIn("els.audio.addEventListener('seeking', function () {", music_playback_js)
        self.assertIn("els.audio.addEventListener('seeked', function () {", music_playback_js)
        self.assertIn("els.audio.addEventListener('ended', playNextSong)", music_playback_js)
        self.assertIn("els.audio.addEventListener('ended', function () {", music_playback_js)
        self.assertIn("els.audio.addEventListener('emptied', function () {", music_playback_js)
        self.assertIn("els.audio.addEventListener('error', function () {", music_playback_js)
        self.assertIn("ctx.playbackApi.clearCurrentSong();", music_playlist_js)
        self.assertIn("setPlayPauseVisualState(false);", music_playback_js)
        self.assertIn("setPlayPauseVisualState(true);", music_playback_js)
        self.assertIn("els.progressSlider.max = duration === null ? '0' : String(duration);", music_playback_js)
        self.assertIn("els.audio.currentTime = targetTime;", music_playback_js)
        self.assertIn("extension: song.extension || ctx.playbackApi.metadata.metadataExtension(song)", music_playlist_js)
        self.assertIn("import {initLayout} from './music-layout.js';", music_entry_js)
        self.assertIn("import {initLibrary} from './music-library.js';", music_entry_js)
        self.assertIn("import {initPlaylist} from './music-playlist.js';", music_entry_js)
        self.assertIn("import {initPlayback} from './music-playback.js';", music_entry_js)
        self.assertIn("import {createMetadataController} from './music-metadata.js';", music_playback_js)
        self.assertIn("import {formatPlaybackTime} from './music-shared.js';", music_playback_js)
        self.assertIn("window.addEventListener('resize', function () {", music_entry_js)
        self.assertIn("ctx.layoutApi.applyMusicPanePercents(ctx.state.currentMusicPanePercents, false);", music_entry_js)
        self.assertIn("ctx.layoutApi.applyMusicPanePercents(ctx.layoutApi.readSavedMusicPanePercents(), false);", music_entry_js)
        self.assertIn("if (kind === 'song') {", music_library_js)
        self.assertIn("row.addEventListener('dblclick', function () {", music_library_js)
        self.assertIn("ctx.playlistApi.addSongToPlaylistAndPlay(node);", music_library_js)
        self.assertIn("row.addEventListener('dblclick'", music_playlist_js)
        self.assertIn("if (action === 'play') ctx.playbackApi.playPlaylistRemotePath", music_playlist_js)
        self.assertIn("if (action === 'remove') removeSelectedPlaylistSongs();", music_playlist_js)
        self.assertIn("ctx.libraryApi.resetLibraryForCurrentFolder();", music_entry_js)
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
            music_icon_request = Request(
                server.base_url + "/assets/icons/material-icon-theme/music-play.svg",
                method="HEAD",
            )
            with urlopen(music_icon_request, timeout=5) as response:
                music_icon_body = response.read()
                music_icon_headers = response.headers
                music_icon_status = response.status
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
        self.assertEqual(music_icon_status, HTTPStatus.OK)
        self.assertEqual(music_icon_body, b"")
        self.assertEqual(music_icon_headers["Content-Type"], "image/svg+xml; charset=utf-8")
        self.assertGreater(int(music_icon_headers["Content-Length"]), 0)
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
