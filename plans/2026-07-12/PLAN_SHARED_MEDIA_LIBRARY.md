# Shared Media Library + Active Playlist Plan

## Goal

Make **library + active playlist** management shared code used by both the
music player and the video player, with **identical behavior to today's music
player** (except host-configurable labels, storage keys, and optional host
chrome such as video full-window hide).

Keep **playback** separate:

- Music keeps `music` playback / metadata / cover-art code.
- Video keeps HLS/compatibility, tracks, subtitles, controls, diagnostics.

Out of scope (explicit non-goals):

- Unifying music/video playback engines.
- Server-side playlist storage.
- Browse-page “add to playlist” outside bottom panes.
- New product features beyond music-parity library/playlist on video.
- Shared cross-player e2e specs (music e2e + existing video e2e only).

Success criteria:

- Music player library + active playlist behavior is unchanged for users
  (settings keys remain readable; UI labels stay music-specific).
- Video player library + active playlist match music: recursive folder-cache
  library, Load Current Folder + poll, tree multi-select, context menus, save /
  load / rename / overwrite / delete, import / export, no path duplicates,
  drag reorder, music-style shuffle/loop playlist navigation.
- Shared client lives under `assets/js/media-library/` + shared CSS.
- Music-specific client lives under `assets/js/music/`.
- Shared server library listing is factored cleanly (shared Python module and,
  if clean, a shared endpoint or thin wrappers over one implementation).
- New music e2e coverage locks library + playlist + playback behavior before
  and through the refactor; existing video e2e stay green.
- No shared music/video e2e suite in this work.

---

## Locked Decisions (from design discussion)

| # | Decision |
|---|----------|
| 1 | Video adopts **music’s full library model** and music’s behavioral choices. Shared code is parameterized so hosts can add extras later without forking. |
| 2 | **No duplicate absolute paths** in active/persisted playlists (music rule). |
| 3 | **Separate datastores** (`music-playlists` vs `video-playlists`). Storage key is a host config on the shared store. |
| 4 | **Different titles/labels** per host, configured by host code (not hard-coded “Song” in shared modules). |
| 5 | Video uses **music shuffle behavior** for playlist navigation (not only linear queue advance). |
| 6 | **Hide library/playlist on full-window** is **opt-in host behavior** (video only). Shared code exposes a clean hook or is simply hideable via host CSS/classes. |
| 7 | Share **JS + CSS** (not a mandatory shared HTML fragment). Host templates own markup/IDs; shared modules bind through `ctx.els` + shared class names. |
| 8 | Share **everything that must be shared** for parity (library UI, playlist UI, store, layout/resizers/columns needed by those panes, helpers, CSS). |
| 9 | Server listing should work like music; **shared Python** and a **shared endpoint or thin wrappers** if clean. |
| 10 | Folders: `assets/js/music/` (music-only), `assets/js/media-library/` (shared). Keep thin root entries `music.js` / `video.js` like today. |
| 11 | **Backwards-compatible** music Settings keys preferred (`music-playlists`, library sort, pane widths, etc.). |
| 12 | E2E should cover **all existing music player functionality if possible**, in **as few/fast** Playwright specs as practical, following video integration patterns + synthetic fixtures. |
| 13 | Order: **tests → extract → wire**, keeping tests green throughout. |
| 14 | **No shared e2es** for now. Keep all video e2es; add new music e2es. |
| 15 | No new features beyond the above. |

---

## Current State (brief)

### Music (source of truth)

- Client: flat `music-*.js` modules; recursive library + full playlist management.
- Server: `music.py` `/music/endpoints/library` over folder-cache; audio extensions.
- Persistence: `PlaylistStore` + Settings key `music-playlists`.
- Layout: 3-pane resizers, playlist columns, paint throttling when pane hidden.
- Tests: one library poll integration e2e; limited JS unit tests; no full playlist/playback e2e.

### Video (to replace library/queue management)

- Client: flat current-folder library + in-memory queue (`video/library.js`,
  `video/queue.js`, `queue-core.js`).
- Server: `video.py` `video_library_payload` via live `list_entries`.
- Full-window mode hides library/queue via CSS (video-only chrome).
- Tests: several integration e2es; library/queue interactions are shallow
  (dblclick row → queue → play).

---

## Target Layout

```text
dropbox_browser/assets/js/
  music.js                         # thin entry (music host)
  video.js                         # thin entry (video host)
  media-library/
    shared.js                      # tiny shared utils (format, clearObject, etc.)
    library-helpers.js             # pure sort/selection helpers
    library.js                     # recursive library UI + poll + context menu
    playlist-store.js              # PlaylistModel + PlaylistStore (configurable key)
    playlist.js                    # active playlist UI + save/load/import/export
    layout.js                      # library|playlist resizers, column widths,
                                   # paint-throttle hooks used by library/playlist
  music/
    layout.js                      # music shell + playback-pane layout glue (if any
                                   # remains after shared layout extraction)
    playback.js
    metadata.js
    coverart.js
    # optional: re-export barrels if useful
  video/
    ...existing playback modules...
    # library.js / queue.js removed or reduced to host adapters
    # queue-core.js: drop management ops once playlist store owns order;
    # keep only pure next/prev helpers if still useful, or move shuffle-aware
    # advance into music-style host playback code

dropbox_browser/assets/css/
  media-library.css                # shared library + playlist chrome
  music.css                        # music-only (playback surface, host tweaks)
  video.css                        # video-only (stage, controls, full-window)

dropbox_browser/
  media_library.py                 # shared recursive folder-cache library builder
  music.py                         # audio filter + thin handle_music_get
  video.py                         # video filter; library endpoint uses shared builder
```

Host templates (`music_player.html`, `video_player.html`) keep separate IDs
(`#music-*` / `#video-*`) but use shared CSS classes (e.g.
`.media-library-tree`, `.media-playlist-table`) so one stylesheet styles both.

---

## Shared Host Config Contract

Shared `initMediaLibrary(ctx)` (or separate `initLibrary` / `initPlaylist` /
`initMediaLibraryLayout`) must be driven by host-supplied config on `ctx`, e.g.:

```js
ctx.mediaLibraryConfig = {
  // identity / copy
  libraryTitle: 'Song Library' | 'Video Library',
  playlistTitlePrefix: 'Active Playlist:',
  itemNoun: 'song' | 'video',          // status strings only
  emptyLibraryText: '...',
  emptyPlaylistText: '...',

  // persistence (separate stores)
  playlistStorageKey: 'music-playlists' | 'video-playlists',
  librarySortSettingKey: 'music-library-sort' | 'video-library-sort',
  playlistLoadSortSettingKey: '...',
  playlistLoadFilterSettingKey: '...',
  playlistColumnWidthSettingKey: '...',
  paneWidthSettingKey: '...',

  // data
  libraryEndpoint: '/music/endpoints/library' | '/video/endpoints/library',
  // or shared path with media= if introduced
  supportedExtensions: [...],         // client-side hints only if needed

  // host hooks (playback stays outside shared code)
  onPlayItem(item, index),
  onPlaylistChanged(),
  getActiveIndex(),
  setActiveIndex(index),
  // shuffle bags may live in host playback state; shared playlist calls
  // host resetShuffleBag() when membership changes

  // optional chrome
  hideLibraryPlaylistWhen: () => boolean, // video full-window opt-in
};
```

Shared modules must not import music playback or video compatibility modules.

Item schema stays the music playlist shape for both hosts:

- `remote_path`, `stream_path`, `rel_path`, `display_name`, `filename`, `extension`

Video playback maps `stream_path` / `rel_path` into existing `/file` and session
create paths (same remote-relative path model music already uses).

---

## Server Contract

### Shared recursive library builder

Factor the music recursive folder-cache walk into `media_library.py` (name flexible)
parameterized by:

- `supported_extensions` (audio vs video tuple)
- optional node label field (`songs` vs `items` — prefer **one JSON shape** for
  both clients to avoid dual parsers)

Recommended response shape (music-compatible):

```json
{
  "root": { "id", "remote_path", "rel_path", "stream_path", "display_name" },
  "status": { "complete", "pending", "cache_status", "message", ... },
  "folders": [ ... ],
  "items": [ ... ]
}
```

Migration note: music currently returns `songs`. Prefer renaming to generic
`items` **with temporary dual-field emit** (`songs` + `items` same array) until
shared client only reads `items`, then drop `songs` in a later micro-step if
desired. If dual-field is too noisy, keep `songs` as the field name in the
shared payload and treat it as “media items” in video host code (less clean
naming, fewer server/client breakages). **Prefer dual-field then single `items`
if tests make rename cheap; otherwise keep `songs` key for compatibility.**

### Endpoints

Preferred clean shape:

1. Implement builder once in `media_library.py`.
2. Keep:
   - `GET /music/endpoints/library?path=` → audio extensions
   - `GET /video/endpoints/library?path=` → video extensions  
   both calling the shared builder.
3. Optional: also expose `GET /media-library/endpoints/library?path=&kind=audio|video`
   only if it simplifies tests without extra routing debt. Not required if
   wrappers stay one-liners.

Do **not** keep video’s live flat `list_entries` library once shared recursive
library is wired.

---

## Implementation Phases

### Phase 0 — Inventory And Guardrails

- [x] Write a short behavior inventory checklist (plan appendix or test comments)
      covering music:
  - Library: load current folder, poll partial→complete, expand/collapse, sort
    name/date, multi-select, select-all, context add, dblclick add+play
  - Playlist: add/remove, multi-select, drag reorder, context play/remove/copy,
    dirty state, save/overwrite, load, rename, delete saved, import JSON/m3u,
    export, toast
  - Playback: play/pause, next/prev, loop, shuffle, volume, seek, metadata/
    cover art (music-only assertions)
- [x] Confirm Settings keys that must remain readable after extract
      (`music-playlists`, `music-library-sort`, `music-playlist-load-sort`,
      `music-playlist-load-filter`, `music-playlist-column-widths`,
      `music-pane-widths`, `music-shuffle-enabled`, `music-loop-playlist` if present).
- [x] Confirm video Settings keys to introduce (`video-playlists`, sort/filter/
      column/pane keys) without reading music keys.
- [x] Note web UI path contracts in `tests/test_web_ui.py` that will need
      incremental updates when files move.

Completed inventory lives in **Appendix A** at the end of this file.

### Phase 1 — Music E2E Baseline (before any extract)

Goal: lock current music behavior with synthetic fixtures, few/fast specs.

- [x] Add a synthetic music fixture (video-style pattern):
  - Prefer generated tiny audio files under the integration temp root (ffmpeg
    or minimal valid audio bytes) so `/file` + `<audio>` playback works without
    live Dropbox.
  - Include enough nested folders/songs for library tree + playlist flows.
  - Reuse integration server / gates pattern only where partial-cache is under
    test; for pure UI flows prefer a complete-cache or fully listed fixture for
    speed.
- [x] Add **one primary** Playwright file such as
      `tests/e2e/music-player.integration.spec.js` (serial, dedicated port,
      shared `beforeAll` server) that covers as much as practical in few tests:
  1. Library load + tree visibility + sort (and keep/port partial-poll coverage
     from existing `music-library.integration.spec.js` either merged carefully
     or kept as the second focused file if merge would slow everything).
  2. Playlist: multi-add, no-duplicate, remove, reorder, play-from-playlist.
  3. Persistence: save → reload page or reopen load dialog → load; rename;
     overwrite confirm; delete saved.
  4. Import/export: export JSON round-trip and/or m3u import path currently
     supported.
  5. Playback: play/pause, next/prev, loop, shuffle order changes next track,
     seek/volume smoke if cheap.
- [x] Prefer **fast defaults**: short media (1–2 s), small tree, short timeouts,
      minimal sleeps (`expect.poll` only).
- [x] Keep existing `music-library.integration.spec.js` green until the new suite
      fully replaces its assertions; then either delete or slim it to avoid
      duplicate long runs.
- [x] Document how to run the new suite in `docs/testing.md`.
- [x] Gate: `npx playwright test` for the new music suite passes on clean tree.

Landed:

- Fixture: `tests/e2e/fixtures/music_player_generated_fixture.py`
- Suite: `tests/e2e/music-player.integration.spec.js` (port `8012`, 6 serial tests)
- Partial-cache coverage remains in `music-library.integration.spec.js` (port `8011`)

Post–Phase-2 review gaps closed in the same suite (still Phase 1 e2e surface):

1. Shuffle e2e with seeded `Math.random` so next is not sequential TrackB
2. Library Shift-range + Ctrl/Cmd+A sibling select-all; playlist Ctrl/Cmd+A
3. JSON import e2e (in addition to m3u import + JSON export)
4. Overwrite and discard **cancel** keep prior playlist / stored playlist
5. Playlist context menu Play (not only dblclick)
6. Settings survive reload: `music-library-sort`, `music-pane-widths`,
   `music-playlist-column-widths`, load sort/filter keys + UI restore

### Phase 2 — Expand Focused Unit Tests (still on current paths)

- [x] Fill gaps in `tests/js/` for pure logic already exported (or extract pure
      helpers first if needed without moving folders yet):
  - playlist store: save/load/import/export/delete/overwrite, storage key option
  - reorder / selection helpers
  - library sort helpers
  - shuffle sequence next/prev pure helpers if extracted from playback
- [x] Keep import helpers working for current `music-*.js` paths.
- [x] Gate: `npm run test:js` + relevant Python music endpoint group green.

Landed:

- Extracted pure shuffle/nav helpers to `assets/js/music-shuffle-helpers.js`;
  `music-playback.js` delegates next/prev/rebuild to them.
- New `tests/js/music-shuffle-helpers.test.js` (linear + shuffle + loop cases).
- Expanded store tests: configurable `storageKey`, `removeSongsByRemotePaths`.
- Expanded playlist reorder no-op + library date helper / date-asc sort tests.
- Updated `tests/test_web_ui.py` asset contracts for the shuffle helpers module.

### Phase 3 — Extract Shared Client (`media-library/`) Using Music Host Only

No video wiring yet. Music remains the only consumer.

- [x] Create `assets/js/media-library/` modules by moving logic from:
  - `music-library.js` → `media-library/library.js`
  - `music-library-helpers.js` → `media-library/library-helpers.js`
  - `music-playlist.js` → `media-library/playlist.js`
  - `music-playlist-store.js` → `media-library/playlist-store.js`
  - shared utils from `music-shared.js` as needed → `media-library/shared.js`
  - library/playlist layout pieces from `music-layout.js` →
    `media-library/layout.js` (pane resizers between library|playlist and
    playlist columns; host may still own playback-column resizer)
- [x] Parameterize hard-coded music strings, storage keys, and endpoint URL via
      host config (defaults preserve current music behavior).
- [x] Keep DOM binding through `ctx.els` so `#music-*` IDs still work without a
      shared HTML fragment.
- [x] Introduce shared CSS classes + `assets/css/media-library.css` extracted
      from `music.css` rules that style library/playlist/modals/context menus.
      Leave music playback-only rules in `music.css`.
- [x] Update `page.html` to include `media-library.css` (before host CSS if
      needed).
- [x] Move music-only modules under `assets/js/music/`:
  - `playback.js`, `metadata.js`, `coverart.js`, remaining music layout/shell
- [x] Keep thin `assets/js/music.js` entry that builds config + `ctx` and inits
      shared media-library then music playback.
- [x] Update JS unit tests and `tests/test_web_ui.py` asset path contracts
      **in the same change** as each move.
- [x] Gate after each sub-move: music e2e + js unit + web group still pass.

Landed layout:

```text
assets/js/media-library/{shared,library-helpers,library,playlist-store,playlist,layout}.js
assets/js/music/{playback,metadata,coverart,shuffle-helpers}.js
assets/js/music.js   # host entry + mediaLibraryConfig
assets/css/media-library.css  # library/playlist chrome (keeps .music-* class names)
assets/css/music.css          # playback-only
```

`ctx.mediaLibraryConfig` currently configures library endpoint, item nouns, and
empty/loading library status strings. Settings keys remain music-* defaults on
host state. Class names still `.music-*` for e2e stability; dual/shared rename
can wait for Phase 5 video markup.

### Phase 4 — Shared Server Library Listing

- [x] Add `dropbox_browser/media_library.py` (or equivalent) with the recursive
      folder-cache builder parameterized by supported extensions.
- [x] Point `music.py` library endpoint at the shared builder (audio extensions).
- [x] Point `video.py` library endpoint at the shared builder (video extensions)
      — even before video UI is fully switched, keep response compatible for the
      upcoming client (or ship server + client video switch in the same PR/step
      to avoid a half-migrated video UI).
- [x] Prefer **one client JSON shape** for both hosts (see Server Contract).
- [x] Update `tests/test_music_endpoints.py` and add/adjust video library
      endpoint tests for recursive payload + extension filtering.
- [x] Gate: `python -m tests.run music-endpoints -v` and video endpoint library
      tests green.

Landed:

- `media_library.py`:
  - `build_recursive_library_payload` — folder-cache tree (music + future shared UI)
  - `build_flat_folder_library_payload` — current-folder `items` (legacy video UI)
  - shared extension check + video file enricher (preview_url / compatibility)
- `music.py` is a thin wrapper; emits both `songs` and `items` (same array) plus
  `supported_extensions` for shared-client readiness.
- `video_library_payload` uses the flat shared builder so `/video/endpoints/library`
  stays byte-compatible with current video client/e2e until Phase 5.
- Tests: dual-key assert on music library; new `tests/test_media_library.py`.

### Phase 5 — Wire Video Host To Shared Media Library

- [x] Replace video library/queue markup in `video_player.html` with music-like
      library + active playlist structure (video IDs, video labels, shared CSS
      classes). Include playlist toolbars, modals, context menus, import input.
- [x] Remove or gut `video/library.js` and `video/queue.js` management UI.
- [x] Init shared media-library from `video.js` with:
  - labels: Video Library / Active Playlist / video nouns
  - `playlistStorageKey: 'video-playlists'`
  - library endpoint `/video/endpoints/library`
  - host hooks that call existing video playback sync (`syncPlaybackForActiveItem`,
    session create, etc.)
- [x] Map active playlist index to video’s former `activeQueueIndex` /
      `selectedQueueIndex` concepts (or replace those state fields and update
      all call sites in controls/playback/compatibility/cache/diagnostics).
- [x] Implement **music shuffle behavior** in video host playback navigation:
  - shuffle toggle UI (music-equivalent control in video transport)
  - shuffle bag reset when playlist membership changes
  - next/prev/end-of-track respect shuffle + loop like music
- [x] Preserve loop toggle; wire it to shared playlist loop semantics (music),
      not only linear `queue-core` advance.
- [x] Deduping: adding from library never inserts duplicate absolute paths.
- [x] Full-window: keep **video-only opt-in** hide of library + playlist panes
      (existing full-window CSS/state). Do not put full-window logic into shared
      media-library core beyond optional `ctx` flag/class host applies.
- [x] Delete obsolete pure queue mutation paths that duplicate playlist store
      once unused; keep pure helpers only if video playback still needs them.
- [x] Update `tests/test_web_ui.py` video markup contracts (queue → playlist
      chrome).
- [x] Gate: all existing video e2e specs pass (update selectors where they
      click library/queue rows). Prefer minimal fixture changes; recursive
      library may require “Load Current Folder” click before selecting a file.

### Phase 6 — Docs, Cleanup, Full Verification

- [ ] Update `docs/video-player.md` library/queue sections to active playlist +
      recursive library + shared modules.
- [ ] Update `docs/testing.md` for new music e2e suite and fixture pattern.
- [ ] Update `docs/architecture.md` / `AGENTS.md` ownership notes if they list
      music/video asset paths.
- [ ] Remove dead code: old flat video library helpers, unused music root files,
      unused CSS, unused queue management buttons.
- [ ] Ensure no remaining imports of deleted paths.
- [ ] Full verification:
  - music e2e suite
  - all video e2e suites
  - `npm run test:js`
  - `python -m tests.run music-endpoints -v`
  - `python -m tests.run video-endpoints -v` (or full video-related groups)
  - `python -m tests.run web -v`
  - full suite before checkin if handing off broadly

---

## Test Strategy Summary

| Layer | What | Notes |
|-------|------|--------|
| Playwright music | New fast serial suite + synthetic audio fixture | Locks full music behavior pre/post extract |
| Playwright video | Keep existing specs | Update selectors for new library/playlist DOM; no new shared e2e |
| JS unit | Store/helpers/reorder/shuffle pure logic | Paths update when modules move |
| Python | Shared builder + music/video library endpoints | Extension filtering + recursive status |
| Web contracts | Asset paths + shell markup | Update incrementally per phase |

---

## Risk Notes

- **Video e2e fragility**: specs that dblclick `#video-library-list` rows must
  learn Load Current Folder + tree rows; budget time for selector updates.
- **Shuffle on video**: requires transport UI + replacing linear
  `nextQueueIndex` call sites; easy to miss one path (ended event, buttons,
  loop edge).
- **Paint throttling**: music layout skips paints when pane hidden; video must
  either implement the same `playbackUiMayPaint` host hook or shared code must
  tolerate a no-op host layout API.
- **Large `music-playlist.js`**: extract carefully; keep pure exports testable;
  avoid rewriting behavior while moving.
- **Settings migration**: music keys stay; video new keys start empty (no
  migration from in-memory queue — none persisted today).

---

## Open Decisions (only if needed during implementation)

These are minor; defaults below are recommended so work can proceed without
blocking. Raise only if a default proves wrong.

1. **JSON field name for media rows**  
   - **Default:** emit both `items` and legacy `songs` during transition, then
     shared client reads `items` only.  
   - Alternative: keep `songs` forever as the array name for both hosts.

2. **Shared endpoint path**  
   - **Default:** keep `/music/endpoints/library` and `/video/endpoints/library`
     as thin wrappers over shared Python (no new public path required).

3. **Where shuffle toggle lives on video**  
   - **Default:** add a video transport control equivalent to music’s Order/
     shuffle toggle (required for music-parity navigation, not a new playlist
     feature). Placement near existing loop control.

4. **Playlist column + library|playlist resizer on video**  
   - **Default:** yes — shared layout owns these so video matches music pane
     UX; playback-column sizing stays video/CSS-owned where already special
     (stage, full-window).

5. **Whether `music-layout.js` playback-pane resizer stays music-only**  
   - **Default:** shared layout owns library↔playlist (± playlist columns);
     host owns playlist↔playback resizer if the third column is host-specific.

If all of the above defaults are acceptable, no further design discussion is
required before Phase 0/1.

---

## Suggested PR / Commit Cadence

1. Phase 1–2: tests only (safe to land alone).
2. Phase 3: music extract to `media-library` + `music/` (behavior-preserving).
3. Phase 4–5: shared server + video wire-up (largest functional change).
4. Phase 6: docs + cleanup.

Each cadence must keep the music e2e suite green.

---

## Progress

- [x] Phase 0 — Inventory And Guardrails
- [x] Phase 1 — Music E2E Baseline
- [x] Phase 2 — Expand Focused Unit Tests
- [x] Phase 3 — Extract Shared Client (`media-library/`)
- [x] Phase 4 — Shared Server Library Listing
- [x] Phase 5 — Wire Video Host
- [ ] Phase 6 — Docs, Cleanup, Full Verification

---

## Appendix A — Phase 0 Inventory (2026-07-12)

### A.1 Music behavior inventory (e2e target matrix)

Use this as the Phase 1 Playwright coverage checklist. Prefer one serial suite
with synthetic short audio; keep partial-cache poll coverage either merged or
in the existing `music-library.integration.spec.js`.

#### Library (`music-library.js` + `/music/endpoints/library`)

| Behavior | How it works today | Suggested e2e assertion |
|----------|--------------------|-------------------------|
| Load Current Folder | `#music-library-load` fetches root from `body` current folder; disables button while polling; shows elapsed seconds on button | Click load; tree leaves empty state; status bar updates |
| Poll partial→complete | Poll while `status.complete` is false; `poll_seq` / `poll_delay_ms` query params; `data-music-library-poll-delay-ms` override | Existing integration gates; or keep dedicated deep fixture file |
| Tree expand/collapse | Folder rows `aria-expanded`; toggle `>`/`v`; `expandedIds` state | Expand nested folder; child songs visible |
| Folder badges | `files cached` vs `not cached` from `metadata_cached` | Partial fixture shows not-cached; complete shows cached |
| Sort name/date | Buttons `[data-library-sort-key]`; default name asc, date default desc; Settings `music-library-sort` | Toggle sort; order changes; survives reload if cheap |
| Multi-select | Click / Ctrl / Shift range on visible nodes | Select range; selected class on rows |
| Select-all | Ctrl/Cmd+A on tree; context menu Select → All | All visible nodes selected |
| Context Add to Playlist | `#music-library-context-menu` `data-action=add-selected` | Adds selected songs only; status “Added N cached song(s)” |
| Dblclick song | `addSongToPlaylistAndPlay` | Song appears in playlist and becomes current/playing |
| Dedup on add | Store rejects duplicate absolute path keys | Second add of same path does not grow playlist |
| Status bar | `#music-player-status` only when music pane active | Visible during music mode |

#### Active playlist (`music-playlist.js` + `music-playlist-store.js`)

| Behavior | How it works today | Suggested e2e assertion |
|----------|--------------------|-------------------------|
| Empty state | “Playlist is empty.” | Initial empty |
| Row columns | Filename, Absolute Path, Reorder handle | Columns present |
| Multi-select | Click / Ctrl / Shift; Ctrl/Cmd+A | Selection classes |
| Drag reorder | Handle drag; multi-block reorder; drop indicator CSS var | Reorder two rows; order persists in DOM |
| Context Play | `playbackApi.playPlaylistRemotePath` | Current row + audio starts |
| Context Remove | Removes selected | Row gone; no dup path reappear |
| Context Copy | filename / absolute path / Dropbox URL | Clipboard text (if Playwright clipboard available) or skip if flaky |
| Dirty state | Signature of name+ordered paths vs last save | Rename/add marks dirty; save clears |
| Save | Upsert by name; overwrite confirm when name conflict | Toast “Saved … as of …”; reload load dialog shows it |
| Overwrite confirm | Modal when saving onto existing different content name | Cancel keeps old; confirm replaces |
| Load dialog | Filter, sort name/last_modified, OK/Cancel/New | Load replaces active; New creates “New Playlist” |
| Discard unsaved | Confirm when loading another with dirty active | Cancel keeps dirty playlist |
| Rename | Dialog; may overwrite-confirm | Name chip updates |
| Delete saved | Load dialog context menu Delete | Playlist disappears from list |
| Import JSON | File input `.json`; merge persisted store | Imported names appear in load list |
| Import m3u8 | Paths as songs; playlist name from filename | Named playlist appears |
| Export | Downloads `dropbox-browser-playlists.json` blob | Trigger export; no error status (download hard to assert) |
| Error toast | Save/load/import failures | Optional negative path |

Item fields: `remote_path`, `stream_path`, `rel_path`, `display_name`,
`filename`, `extension`. Absolute path key = lowercased stream/rel path.

#### Playback (`music-playback.js` + metadata/coverart) — music host only

| Behavior | How it works today | Suggested e2e assertion |
|----------|--------------------|-------------------------|
| Stream | `GET /file?path=<stream_path>&source=remote` into `<audio>` | Playing state after dblclick/play |
| Play/pause | Separate play/pause buttons + visual state | Toggle |
| Next/prev | Respects shuffle sequence + loop | Order differs under shuffle |
| Loop | Settings `music-loop-playlist`; wraps playlist | Last→first when loop on |
| Shuffle | Settings `music-shuffle-enabled`; rebuild bag on membership change | Next is not always sequential when on |
| Volume | Settings `music-volume`; slider 0–1 | Persist optional |
| Seek | Progress slider scrub | Current time moves |
| Metadata | Title/artist loading → loaded/unavailable | Labels change after play (if fixture has tags or accept fallbacks) |
| Cover art | ID3/MP4 extract; placeholder otherwise | Placeholder or img visible |
| Load retry | Up to 3 retries with delay on audio error | Optional; skip unless flaky load tested |
| Paint throttle | Layout skips paints when pane hidden/document hidden | Unit/layout only; not e2e critical |

### A.2 Music Settings keys (must remain readable)

Defaults live on host `ctx.state` / module constants. **Do not rename keys** without
a read-fallback (prefer keep exact strings).

| Key | Owner module | Shape / notes |
|-----|--------------|---------------|
| `music-playlists` | `PlaylistStore` default `PLAYLIST_STORAGE_KEY` | Export envelope `{version, exported_at, playlists:[{name,last_modified,songs:[path,...]}]}` |
| `music-library-sort` | library | `{key: 'name'\|'date', direction: 'asc'\|'desc'}` |
| `music-playlist-load-sort` | playlist | `{key: 'name'\|'last_modified', direction}` |
| `music-playlist-load-filter` | playlist | string |
| `music-playlist-column-widths` | layout | `{filename, path, reorder}` px |
| `music-pane-widths` | layout | 3-length percent array |
| `music-shuffle-enabled` | playback | boolean |
| `music-loop-playlist` | playback | boolean |
| `music-volume` | playback | number 0–1 |

Shared with app (not music-owned, leave alone): `bottom-pane-mode`, `log-height`.

### A.3 Video Settings keys to introduce (separate store)

New keys must **not** read music keys. Video already has unrelated keys
(`video-loop-queue`, `video-subtitle-style`, track preference keys, volume may
exist under video controls).

Recommended media-library host config for video:

| Key | Purpose | Parallel music key |
|-----|---------|-------------------|
| `video-playlists` | PlaylistStore storage | `music-playlists` |
| `video-library-sort` | Library sort | `music-library-sort` |
| `video-playlist-load-sort` | Load dialog sort | `music-playlist-load-sort` |
| `video-playlist-load-filter` | Load dialog filter | `music-playlist-load-filter` |
| `video-playlist-column-widths` | Playlist columns | `music-playlist-column-widths` |
| `video-media-library-pane-widths` | library\|playlist\|playback percents if shared layout used | `music-pane-widths` |
| `video-shuffle-enabled` | Music-parity shuffle (new UI) | `music-shuffle-enabled` |

Loop: today video uses `video-loop-queue`. Phase 5 should either keep that key
as the loop setting (host maps it into shared/host loop state) or introduce
`video-loop-playlist` with **read-fallback** from `video-loop-queue` for
back-compat. Prefer keep `video-loop-queue` as the storage key to avoid
breaking existing users.

Do **not** migrate in-memory queue → playlists (nothing persisted today).

### A.4 Existing test coverage map

| Layer | Files | Covers |
|-------|-------|--------|
| E2E | `tests/e2e/music-library.integration.spec.js` | Deep partial library poll only |
| JS unit | `music-playlist-store.test.js` | Serialize, dedupe, store helpers |
| JS unit | `music-playlist.test.js` | Drag block reorder pure helpers |
| JS unit | `music-library-helpers.test.js` | Sort/compare helpers |
| JS unit | `music-playback.test.js` | Limited pure/playback helpers |
| JS unit | `music-coverart.test.js` | Cover art parsers |
| Python | `tests/test_music_endpoints.py` | Library endpoint |
| Web | `tests/test_web_ui.py` | Markup + string contracts on asset paths |

Gaps for Phase 1: playlist CRUD, import/export, multi-select, reorder e2e,
playback transport, shuffle/loop e2e.

### A.5 `tests/test_web_ui.py` asset path contracts (Phase 3 touch list)

Fetched paths that **must be updated when files move**:

**Music (today → after extract)**

| Current path | Likely new path |
|--------------|-----------------|
| `/assets/js/music.js` | stays thin entry |
| `/assets/js/music-layout.js` | split → `/assets/js/media-library/layout.js` + maybe `/assets/js/music/layout.js` |
| `/assets/js/music-library.js` | `/assets/js/media-library/library.js` |
| `/assets/js/music-library-helpers.js` | `/assets/js/media-library/library-helpers.js` |
| `/assets/js/music-playlist.js` | `/assets/js/media-library/playlist.js` |
| `/assets/js/music-playlist-store.js` | `/assets/js/media-library/playlist-store.js` (may only be imported, not always string-asserted) |
| `/assets/js/music-shared.js` | `/assets/js/media-library/shared.js` and/or music-only leftovers |
| `/assets/js/music-playback.js` | `/assets/js/music/playback.js` |
| `/assets/js/music-metadata.js` | `/assets/js/music/metadata.js` |
| `/assets/js/music-coverart.js` | `/assets/js/music/coverart.js` |
| `/assets/css/music.css` | stays + new `/assets/css/media-library.css` link in `page.html` |

**Video paths that change in Phase 5 (not Phase 3)**

| Current path | Phase 5 fate |
|--------------|--------------|
| `/assets/js/video/library.js` | remove or host stub |
| `/assets/js/video/queue.js` | remove or host stub |
| `/assets/js/video/queue-core.js` | shrink / drop management ops |

**HTML shell contracts** (music player template strings, video queue buttons)
are asserted heavily under class names `.music-*` and `#music-*` / `#video-*`.
When extracting CSS, either:

- keep dual class lists during transition, or
- update web assertions when shared classes land.

**Import path strings** inside modules are also asserted, e.g. music helpers
import `./filename-compare-key.js`. Nested `media-library/` will need
`../filename-compare-key.js` and matching assertion updates.

### A.6 DOM ID prefixes (host-owned; shared binds via `ctx.els`)

Music keeps `#music-*` (see `music_player.html`). Video Phase 5 should mirror
structure with `#video-*` IDs and shared CSS classes (`.media-library-*` /
temporary dual `.music-*` during extract).

Critical music IDs for e2e:

- `#music-player-pane`, `#music-library-load`, `#music-library-tree`
- `#music-playlist-list`, `#music-active-playlist-name`
- `#music-playlist-save|load|rename|import|export`
- dialogs: rename / overwrite / load
- `#music-audio`, transport buttons, shuffle/loop, progress/volume
- context menus: library, playlist, load

### A.7 Cross-module API surface (must survive extract)

Shared modules expose via `ctx.*Api` (names may stabilize):

- `libraryApi`: `paintLibrary`, `fetchLibrary`, `hideLibraryContextMenu`, …
- `playlistApi`: `renderPlaylist`, `paintPlaylist`, `addSongsToPlaylist`,
  `addSongToPlaylistAndPlay`, `resetShuffleBag`, `playlistIndexByRemotePath`,
  `focusPlaylistRemotePath`, toast helpers, …
- Host provides `playbackApi` for play/current index (music only today).
- `layoutApi`: `playbackUiMayPaint`, schedule paint, pane resize, …

Shared code must **not** import `music/playback` or `video/*` playback modules.

### A.8 Phase 0 decisions locked for Phase 1

- No production code moves in Phase 1.
- Music e2e first; do not touch video product code yet.
- Keep existing `music-library.integration.spec.js` until new suite supersedes
  its assertions.
- Synthetic short audio + nested folders for full player suite; deep gated
  fixture remains valid for partial-cache only.

