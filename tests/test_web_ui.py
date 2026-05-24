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
        self.assertIn("Folder Song Library", html)
        self.assertIn("Active Playlist", html)
        self.assertIn("Playback Controls", html)
        self.assertIn('id="music-library-load"', html)
        self.assertIn('id="music-library-status"', html)
        self.assertIn('id="music-library-tree"', html)
        self.assertIn("Library not loaded.", html)
        self.assertIn("Load the current folder library to show cached songs.", html)
        self.assertIn('id="music-playlist-future-controls"', html)
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
        self.assertIn('data-action="select-all"', html)
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
        self.assertIn("grid-template-columns: minmax(190px, 1.05fr)", music_css)
        self.assertIn(".music-library-tree", music_css)
        self.assertIn(".music-playlist-list", music_css)
        self.assertIn("overflow: auto", music_css)
        self.assertIn(".music-player-controls", music_css)
        self.assertIn(".music-playback-surface", music_css)
        self.assertIn("border-radius: 8px", music_css)
        self.assertIn(".music-art-shell", music_css)
        self.assertIn("aspect-ratio: 1 / 1", music_css)
        self.assertIn(".music-cover-art.hidden", music_css)
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
        self.assertIn("@media (max-width: 860px)", music_css)
        self.assertIn(".music-tree-row", music_css)
        self.assertIn("padding: 3px 8px 3px calc(8px + (var(--music-tree-depth, 0) * 16px))", music_css)
        self.assertIn(".music-playlist-entry", music_css)
        self.assertIn(".music-playlist-entry.selected", music_css)
        self.assertIn(".music-playlist-entry.current", music_css)
        self.assertIn("data-player-ready', 'library'", js)
        self.assertIn("var currentFolder = document.body.dataset.currentFolderPath || ''", js)
        self.assertIn("var defaultPollDelayMs = 4000", js)
        self.assertIn("var pollDelayMs = defaultPollDelayMs", js)
        self.assertIn("fetch(libraryUrl())", js)
        self.assertIn("'/music/endpoints/library?path=' + encodeURIComponent(libraryRoot)", js)
        self.assertIn("function renderLibrary()", js)
        self.assertIn("function primarySelectedLibraryNodeId()", js)
        self.assertIn("function selectAllVisibleLibraryNodes()", js)
        self.assertIn("function selectVisibleLibrarySiblingsOfCurrentSelection()", js)
        self.assertIn("function handleLibrarySelectAllShortcut(ev)", js)
        self.assertIn("function performLibrarySelectAll()", js)
        self.assertIn("treeEl.scrollTop = scrollTop", js)
        self.assertIn("expandedIds[snapshot.root.id] = true", js)
        self.assertIn("function pruneSelectedIds(snapshot)", js)
        self.assertIn("function schedulePoll()", js)
        self.assertIn("if (!libraryRequested || !isVisible()) return;", js)
        self.assertIn("function libraryFingerprint(data)", js)
        self.assertIn("status = data.status || null", js)
        self.assertIn("missing_listing_count: status.missing_listing_count || 0", js)
        self.assertNotIn("return JSON.stringify(data || null);", js)
        self.assertIn("if (fingerprint && fingerprint === lastLibraryFingerprint)", js)
        self.assertIn("pollDelayMs *= 2", js)
        self.assertIn("pollDelayMs = defaultPollDelayMs", js)
        self.assertIn("if (ev.detail.mode === 'music-player') schedulePoll();", js)
        self.assertIn("else stopPolling();", js)
        self.assertIn("openLibraryContextMenu(ev, node.id, kind)", js)
        self.assertIn("function selectedSongsForPlaylist()", js)
        self.assertIn("function songsUnderFolder(folderId)", js)
        self.assertIn("function addSongsToPlaylist(songs)", js)
        self.assertIn("function addSongToPlaylistAndPlay(song)", js)
        self.assertIn("playlistRemotePaths[song.remote_path]", js)
        self.assertIn("focusPlaylistRemotePath(song.remote_path)", js)
        self.assertIn("function renderPlaylist()", js)
        self.assertIn("function selectAllPlaylistSongs()", js)
        self.assertIn("function handlePlaylistSelectAllShortcut(ev)", js)
        self.assertIn("function performPlaylistSelectAll()", js)
        self.assertNotIn("data-action=\"add-folder\"", html)
        self.assertIn("node.metadata_cached ? 'files cached' : 'not cached'", js)
        self.assertIn("var playlistMenu = document.getElementById('music-playlist-context-menu')", js)
        self.assertIn("var selectedPlaylistRemotePaths = Object.create(null)", js)
        self.assertIn("function selectPlaylistRemotePath(remotePath, ev)", js)
        self.assertIn("function openPlaylistContextMenu(ev, remotePath)", js)
        self.assertIn("function removeSelectedPlaylistSongs()", js)
        self.assertIn("if (treeEl) treeEl.addEventListener('keydown', handleLibrarySelectAllShortcut)", js)
        self.assertIn("if (playlistListEl) playlistListEl.addEventListener('keydown', handlePlaylistSelectAllShortcut)", js)
        self.assertIn("if (action === 'select-all') performLibrarySelectAll();", js)
        self.assertIn("if (action === 'select-all') performPlaylistSelectAll();", js)
        self.assertIn("function playPlaylistIndex(index)", js)
        self.assertIn("function playCurrentOrFirst()", js)
        self.assertIn("function pausePlayback()", js)
        self.assertIn("function playNextSong()", js)
        self.assertIn("function playPreviousSong()", js)
        self.assertIn("function setPlaybackStatus(message)", js)
        self.assertIn("function setButtonLabel(button, text)", js)
        self.assertIn("function setButtonIcon(button, iconUrl)", js)
        self.assertIn("function setPlayPauseVisualState(isPlaying)", js)
        self.assertIn("function setMarqueeState(el)", js)
        self.assertIn("function refreshNowPlayingMarqueeStates()", js)
        self.assertIn("function scheduleNowPlayingMarqueeRefresh()", js)
        self.assertIn("el.scrollWidth > el.clientWidth + 1", js)
        self.assertIn("var scrubberDragging = false", js)
        self.assertIn("function formatPlaybackTime(seconds)", js)
        self.assertIn("return '00:00:00';", js)
        self.assertIn("function resetProgressDisplay()", js)
        self.assertIn("function syncDurationDisplay()", js)
        self.assertIn("function syncCurrentTimeDisplay()", js)
        self.assertIn("function applySeekFromSlider()", js)
        self.assertIn("var defaultVolume = 1", js)
        self.assertIn("var metadataRequestId = 0", js)
        self.assertIn("var metadataChunkSize = 262144", js)
        self.assertIn("var currentArtObjectUrl = null", js)
        self.assertIn("function showMetadataPlaceholders()", js)
        self.assertIn("function showUnknownMetadata()", js)
        self.assertIn("function applyMetadataResult(metadata)", js)
        self.assertIn("function revokeCurrentArtObjectUrl()", js)
        self.assertIn("URL.revokeObjectURL(currentArtObjectUrl)", js)
        self.assertIn("function supportedArtMime(mime)", js)
        self.assertIn("function setCoverArtImage(art)", js)
        self.assertIn("URL.createObjectURL(blob)", js)
        self.assertIn("function startMetadataLoad(song)", js)
        self.assertIn("function fetchRangeBytes(url, start, end)", js)
        self.assertIn("Range: 'bytes=' + start + '-' + end", js)
        self.assertIn("function fetchHeadContentLength(url)", js)
        self.assertIn("function fetchMetadataBytes(url, extension)", js)
        self.assertIn("function parseMetadataBuffers(buffers, extension)", js)
        self.assertIn("if (requestId !== metadataRequestId) return;", js)
        self.assertIn("metadataRequestId += 1;", js)
        self.assertIn("var metadataLoadedRemotePath = null", js)
        self.assertIn("function maybeStartCurrentSongMetadataLoad()", js)
        self.assertIn("function clampVolume(value)", js)
        self.assertIn("function restoreVolume()", js)
        self.assertIn("function persistVolume(volume)", js)
        self.assertIn("function applyVolumeFromSlider()", js)
        self.assertIn("var defaultShuffleEnabled = false", js)
        self.assertIn("var defaultLoopPlaylist = false", js)
        self.assertIn("function restoreShuffleEnabled()", js)
        self.assertIn("function persistShuffleEnabled()", js)
        self.assertIn("function restoreLoopPlaylist()", js)
        self.assertIn("function persistLoopPlaylist()", js)
        self.assertIn("function setCurrentFilename(song)", js)
        self.assertIn("function resetNowPlayingForSong(song)", js)
        self.assertIn("var shuffleEnabled = false", js)
        self.assertIn("var loopPlaylist = false", js)
        self.assertIn("var shuffleBag = []", js)
        self.assertIn("function resetShuffleBag()", js)
        self.assertIn("function shuffleBagIndex()", js)
        self.assertIn("if (shuffleEnabled) return shuffleBagIndex();", js)
        self.assertIn("if (loopPlaylist) return 0;", js)
        self.assertIn("function toggleShuffle()", js)
        self.assertIn("function toggleLoopPlaylist()", js)
        self.assertIn("Settings.get('music-shuffle-enabled', defaultShuffleEnabled)", js)
        self.assertIn("Settings.set('music-shuffle-enabled', shuffleEnabled)", js)
        self.assertIn("Settings.get('music-loop-playlist', defaultLoopPlaylist)", js)
        self.assertIn("Settings.set('music-loop-playlist', loopPlaylist)", js)
        self.assertIn("setButtonLabel(shuffleButton, shuffleEnabled ? 'Shuffle' : 'Order')", js)
        self.assertIn("setButtonLabel(loopButton, loopPlaylist ? 'Loop On' : 'Loop')", js)
        self.assertIn("shuffleButton.addEventListener('click', toggleShuffle)", js)
        self.assertIn("loopButton.addEventListener('click', toggleLoopPlaylist)", js)
        self.assertIn("audio.src = streamUrl(song)", js)
        self.assertIn("'/file?path=' + encodeURIComponent(song.stream_path) + '&source=remote'", js)
        self.assertIn("audio.addEventListener('playing', function () {", js)
        self.assertIn("maybeStartCurrentSongMetadataLoad();", js)
        self.assertIn("showMetadataPlaceholders();", js)
        self.assertIn("showUnknownMetadata();", js)
        self.assertIn("scheduleNowPlayingMarqueeRefresh();", js)
        self.assertIn("resetNowPlayingForSong(song);", js)
        self.assertIn("resetNowPlayingForSong(null);", js)
        self.assertIn("setCoverArtPlaceholderState('loading')", js)
        self.assertIn("setCoverArtPlaceholderState('empty')", js)
        self.assertIn("setCoverArtPlaceholderState('unsupported')", js)
        self.assertIn("function togglePlayPause()", js)
        self.assertIn("playButton.addEventListener('click', togglePlayPause)", js)
        self.assertIn("pauseButton.addEventListener('click', pausePlayback)", js)
        self.assertIn("nextButton.addEventListener('click', playNextSong)", js)
        self.assertIn("prevButton.addEventListener('click', playPreviousSong)", js)
        self.assertIn("progressSlider.min = '0';", js)
        self.assertIn("progressSlider.addEventListener('input', function () {", js)
        self.assertIn("progressSlider.addEventListener('change', function () {", js)
        self.assertIn("Settings.get('music-volume', defaultVolume)", js)
        self.assertIn("Settings.set('music-volume', volume)", js)
        self.assertIn("audio.volume = volume;", js)
        self.assertIn("restoreVolume();", js)
        self.assertIn("volumeSlider.addEventListener('input', applyVolumeFromSlider)", js)
        self.assertIn("volumeSlider.addEventListener('change', applyVolumeFromSlider)", js)
        self.assertIn("audio.addEventListener('play', function () {", js)
        self.assertIn("audio.addEventListener('pause', function () {", js)
        self.assertIn("audio.addEventListener('loadedmetadata', function () {", js)
        self.assertIn("audio.addEventListener('durationchange', function () {", js)
        self.assertIn("audio.addEventListener('timeupdate', function () {", js)
        self.assertIn("audio.addEventListener('seeking', function () {", js)
        self.assertIn("audio.addEventListener('seeked', function () {", js)
        self.assertIn("audio.addEventListener('ended', playNextSong)", js)
        self.assertIn("audio.addEventListener('ended', function () {", js)
        self.assertIn("audio.addEventListener('emptied', function () {", js)
        self.assertIn("audio.addEventListener('error'", js)
        self.assertIn("clearCurrentSong();", js)
        self.assertIn("setPlayPauseVisualState(false);", js)
        self.assertIn("setPlayPauseVisualState(true);", js)
        self.assertIn("progressSlider.max = duration === null ? '0' : String(duration);", js)
        self.assertIn("audio.currentTime = targetTime;", js)
        self.assertIn("extension: song.extension || metadataExtension(song)", js)
        self.assertIn("window.addEventListener('resize', scheduleNowPlayingMarqueeRefresh)", js)
        self.assertIn("if (kind === 'song') {", js)
        self.assertIn("row.addEventListener('dblclick', function () {", js)
        self.assertIn("addSongToPlaylistAndPlay(node);", js)
        self.assertIn("row.addEventListener('dblclick'", js)
        self.assertIn("if (action === 'play') playPlaylistRemotePath", js)
        self.assertIn("if (action === 'remove') removeSelectedPlaylistSongs();", js)
        self.assertIn("resetLibraryForCurrentFolder();", js)
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
