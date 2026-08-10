# Music player

Music is a bottom-pane player backed by the shared recursive media-library and
playlist UI. The server exposes a small JSON library endpoint; playback,
metadata, embedded artwork, and waveform work happen in the browser.

## Server library contract

`GET /music/endpoints/library?path=<folder>` walks known folder-cache records
under the requested folder and returns:

- `root` — library identity and display name;
- `folders` — recursive folder nodes with `complete`/`pending` metadata flags;
- `songs` and `items` — the same audio rows, retained for music and shared UI
  compatibility;
- `status` — cache state, pending/queued/missing counts, and snapshot timing;
- `supported_extensions` — `.mp3`, `.m4a`, `.m4b`, `.aac`, `.wav`, `.ogg`,
  `.oga`, `.opus`, and `.flac`.

The library is remote-only and cache-backed. It does not recurse live on every
poll. The client starts with **Load Current Folder**, then polls while folder
metadata is partial. A folder-cache revision invalidates the small app-local
recursive snapshot cache.

`GET /music/endpoints/status` reports the endpoint root and supported extension
list. There are no music-specific server metadata or waveform endpoints.

## Library and playlist UI

The shared UI in `assets/js/media-library/` provides:

- a recursive tree with expansion, sibling selection, shift-range selection,
  and context-menu add/play actions;
- an active playlist with deduplication by normalized stream path;
- drag reorder, multi-select remove, and playlist context actions;
- named saved playlists, load/rename/delete, overwrite confirmation, and
  cancel-safe dialogs;
- JSON export/import and M3U import/export;
- a per-player Recent history with selectable records and restoration logic;
- resizable library/playlist/playback panes and playlist columns.

Saved playlists use the browser's `Settings` wrapper and the
`music-playlists` key. Exported playlist JSON stores Dropbox absolute paths,
not copied media or metadata. M3U imports ignore comment lines and treat the
remaining lines as paths. Playlist entries are deduplicated; loading a playlist
can report paths that are no longer present in the current library.

Recent history is separate for music and video, capped at 100 records, and
stored under `music-recent-history` or `video-recent-history`. Starting the same
song from the same playlist again updates the adjacent recent record instead of
adding a duplicate.

## Playback

The player uses a native `<audio>` element with a remote `/file?source=remote`
URL. HTTP range support makes seeking possible without a server-side media
session. Playback includes play/pause, previous/next, seek, volume, loop, and a
deterministic shuffle sequence that avoids repeating the current sequence until
it is exhausted. A failed load has bounded retries before the player moves on
or reports an error.

Persisted music settings include:

- `music-volume`;
- `music-shuffle-enabled`;
- `music-loop-playlist`;
- `music-library-sort`;
- `music-playlist-load-sort` and `music-playlist-load-filter`;
- `music-recent-sort`;
- `music-playlist-column-widths` and `music-media-library-pane-widths`;
- `music-waveform-open`.

## Metadata and cover art

When a song becomes active, `music/metadata.js` fetches bounded byte ranges
from `/file` rather than downloading metadata through a separate service. It
parses:

- ID3 title/artist text for MP3;
- RIFF/WAV metadata;
- MP4/M4A/M4B metadata atoms, including a tail range when needed.
- Vorbis comments and embedded pictures for Ogg Vorbis, Opus, and FLAC.

Embedded artwork extraction supports ID3 APIC, MP4 cover atoms, and the
Vorbis/FLAC `METADATA_BLOCK_PICTURE` comment/block for browser-supported image
MIME types. Artwork is held as a temporary object URL and is revoked when the
song changes. Metadata and artwork are best-effort; playback does not depend
on them.

## Waveform visualization

The optional waveform panel is deliberately deferred. It does not fetch or
decode audio at initialization. Work starts only when the panel is open and
the current audio is confirmed playing.

The flow is:

1. Fetch the current song through `/file` into browser memory.
2. Decode it with the Web Audio API.
3. Copy channel samples to a module worker.
4. Produce progressive min/max/RMS summaries at increasing resolutions.
5. Draw the summary to a canvas and allow pointer scrubbing through the audio
   playback controller.

The worker yields in short slices so playback remains responsive. Closing the
panel, changing songs, leaving the pane, or starting a newer request aborts the
old request and suppresses late results. Completed summaries are packed into a
browser-local cache under `music-waveform-cache`, bounded by
`MusicWaveformCacheEntryLimit`; identity includes path, size, and modification
time. **Reload waveform** discards the active cached summary and recomputes it.

The waveform cache is not server state and is not a Dropbox upload. See
[Configuration](configuration.md) for the entry limit and resolution bounds.

## Client modules and tests

The host is `assets/js/music.js`. Shared library/playlist modules live in
`assets/js/media-library/`; music-only modules are under `assets/js/music/`.
The primary checks are:

```powershell
python -m tests.run music-endpoints -v
npm run test:js
npm run test:e2e:music
```

The music Playwright fixtures run against an isolated local server and fake
rclone; they do not require live Dropbox credentials. See [Testing](testing.md).
