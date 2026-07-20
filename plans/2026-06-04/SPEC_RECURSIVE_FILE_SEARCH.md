# Recursive File Search Spec

> Updated July 19, 2026 after comparing this plan with the current recursive
> search and shared media-library implementations. The feature described in the
> "Current State" sections is shipped. The performance follow-up below is now
> implemented; the status markers in **Recommended Implementation Plan** record
> the completed work and validation.

## Goal

Provide a recursive file search pane in the existing bottom pane. It should let
the user search cached descendants of the current Dropbox folder without running
foreground recursive `rclone` work on the request thread.

The shipped feature is cache-backed and can surface partial results while
folder-cache background work is still filling in descendant listings.

## Current State

This feature is implemented and wired into the main app shell.

Implemented pieces:

- Bottom pane mode:
  - `file-search`
- Shared shell assets:
  - `dropbox_browser/assets/templates/file_search.html`
  - `dropbox_browser/assets/css/file-search.css`
  - `dropbox_browser/assets/js/file-search-api.js`
  - `dropbox_browser/assets/js/file-search.js`
- Backend endpoint:
  - `GET /browse/endpoints/search?path=<rel-path>&recursive=1&query=<q>`
- Coverage:
  - Python endpoint and shell tests
  - JavaScript behavior tests for filtering, polling, empty states, keyboard
    submission, and virtualization

Implemented UI behavior:

- Search root is the current browse folder when `Search` is pressed.
- The pane does not auto-run on open.
- The current root is captured for a search run, then reused until the next run
  or reset.
- Query, type, and date filters are local pane controls.
- `Search` starts the request and becomes `Stop Search` while polling is active.
- `Reset` clears all filters and returns the pane to its default idle state.
- Pressing `Enter` in the query box blurs the input and starts search.
- Results are virtualized for large result sets.

Implemented result actions:

- Preview
- Download
- Show Folder
- Go to Dropbox
- Copy Filepath / Copy Folder Path when a local path is available

Implemented search semantics:

- Recursive, cache-only endpoint
- Text matching against filename and relative path
- Case-insensitive and Unicode-normalized token matching
- Separator-tolerant tokenization for `_`, `-`, `.`, `/`, and `\`
- Client-side type-group filtering
- Client-side date preset and date range filtering

Implemented status behavior:

- Idle prompt before the first run
- Loading state while a run is fetching
- Partial-cache polling while `pending` or `missing_listing_count` remains
- Distinct empty states for incomplete vs complete cached results
- Polling stops when the pane is hidden or a request is superseded

## Non-Goals

- Do not run synchronous recursive Dropbox scans from the request thread.
- Do not add upload, delete, or overwrite behavior.
- Do not search file contents.
- Do not expose unsafe local filesystem paths when local comparison is disabled.
- Do not put file-search state into the main browse URL.

## Existing Backend Contract

The shipped UI uses this endpoint:

```text
GET /browse/endpoints/search?path=<rel-path>&recursive=1&query=<q>
```

The endpoint is cache-only and returns:

- `root`
- `search`
- `status`
- `results`

Current important status fields:

- `cache_status`
- `complete`
- `pending`
- `pending_folder_count`
- `queued_folder_count`
- `missing_folder_count`
- `missing_listing_count`
- `message`
- `generated_at`

The endpoint also emits trace events:

- `browse_search_endpoint`
- `slow_browse_search_endpoint`

## Product Shape

Current pane layout:

- Header row:
  - current captured search root
  - status text
  - result count
- Control row:
  - query
  - type group
  - date preset
  - from date
  - to date
  - `Reset`
  - full-width `Search` / `Stop Search`
- Results region:
  - virtualized list
  - filename, path, type, status, size, date
  - result actions

This is intentionally a bottom-pane work surface, not a dedicated full-page
search experience.

## Search Scope

Current behavior:

- Scope is always the current browse folder at the moment `Search` is pressed.
- The pane shows the current browse folder as the root when idle.
- After a run starts, the captured root stays fixed until the user starts a new
  search or resets the pane.

Not implemented:

- pinned root mode
- follow/pin toggle
- explicit `Use Current Folder` button

## Incremental Cache Updates

Current behavior:

- The client fetches the cached recursive snapshot only when `Search` is pressed
  or `Enter` is pressed in the query field.
- If the returned status is incomplete, the pane polls again on a timer.
- Polling continues only while:
  - the pane is visible
  - the captured search is still active
  - the endpoint reports incomplete cached state
- Polling stops when:
  - the endpoint becomes complete
  - the pane is hidden
  - the user stops search
  - a newer request supersedes the active request

Current user-facing status copy includes:

- `Press Search to capture the current folder and search cached descendants.`
- `Loading cached search results...`
- `Search complete.`
- `No matches yet. Cached folders are still indexing.`
- `No matching files.`

## Text Matching

Current implementation uses token matching, not ranked relevance.

Matching behavior:

- case-insensitive
- Unicode NFKC normalization with `casefold()`
- separator-tolerant normalization
- token-based matching against:
  - filename
  - relative path under the search root
  - extension text

The backend uses the query as a coarse recursive cache filter. The client then
applies its own local filter pass against the returned snapshot.

## File Type Filtering

Current type groups:

- `All`
- `Images`
- `Audio`
- `Video`
- `Documents`
- `Archives`
- `Code`
- `Other`

The client derives these groups from file extension and `type_label`.

## Date Filtering

Current controls:

- `Any time`
- `This year`
- `Last year`
- `Last 30 days`
- `Custom`
- `From`
- `To`

Current implementation:

- filtering is client-side
- date presets populate local date inputs
- custom mode enables manual date inputs
- inclusive local-date boundaries are used in the client filter logic

## Result Rows

Each current row shows:

- icon
- filename
- relative path
- type
- status
- size
- modified date

Current actions:

- folders:
  - `Open`
  - `Show Folder`
  - `Go to Dropbox`
  - `Copy Folder Path` when available
- files:
  - `Preview`
  - `Download`
  - `Show Folder`
  - `Go to Dropbox`
  - `Copy Filepath` when available

`Show Folder` navigates the main browser to the containing folder. For files, it
uses a `reveal` parameter in the browse link.

## Sorting

The current search pane does not expose user-selectable sorting controls.

Current behavior:

- the backend walks cached folders breadth-first from the selected root
- each folder's direct entries are name-sorted before result rows are built
- the client filters the returned snapshot but does not apply an additional
  visible sort mode

Anything in the old plan about `relevance`, `name`, `status`, `date`, or `path`
sort controls is not implemented and should not be treated as current behavior.

## Empty And Partial States

Current distinct states:

- Idle with no active filters and no prior run:
  - prompt to press `Search`
- Active/inactive filters after a previous run changed:
  - prompt to press `Search` again with current filters
- Incomplete cached results with no matches yet:
  - `No matches yet. Cached folders are still indexing.`
- Complete cached results with no matches:
  - `No matching files.`
- No cached rows available:
  - endpoint `message` or generic no-results messaging

Current behavior does not show recent files before the first search.

## Client State

Current effective client state includes:

- captured search root
- active search flag
- raw endpoint results
- endpoint status snapshot
- current filter criteria:
  - query
  - type group
  - date preset
  - date from
  - date to
- request version / cancellation state
- polling timer state
- virtualization state

Not currently implemented:

- persisted search settings
- persisted follow-root behavior
- persisted sort settings

## Performance Characteristics

Current implementation is correct functionally, but root-level searches are slow
because time-to-first-result equals full-tree scan time.

Observed current behavior from the live trace:

- Searching `uncontrollable` from Dropbox root on June 7, 2026 took about
  `6341.94 ms`.
- The endpoint scanned `6929` cached folders before returning the first
  response.
- Similar root searches in the same run also took about `6.2-6.35 s`, which
  shows the latency is dominated by full cached-tree traversal and row
  hydration, not by the specific query text.

Current root-search cost drivers:

- scanning every cached folder under the root
- rebuilding browse-style entry rows for all direct entries before applying the
  query filter
- local path matching, directory enumeration, and file status work during row
  hydration when local comparison is enabled
- child folder cache lookups for status labels
- repeated folder-cache record reads: `ensure_known_subtree()` walks known
  records and the later search traversal reads them again. Search does not yet
  use the per-request record lookup added for media library.

This feature currently optimizes for complete snapshot correctness, not
time-to-first-result.

### Recent Media-Library Cache

The shared music/video recursive library now has a small app-local LRU response
snapshot cache. It is keyed by the requested library shape and the folder-cache
revision. It also uses a per-request `record_lookup` map so the recursive
planning and payload traversal do not reread the same folder-cache record.

This does **not** currently accelerate file search. It should be reused with
care:

- Reuse the per-request `record_lookup` pattern in recursive search. This is a
  low-risk reduction in folder-cache file reads and must preserve the fallback
  behavior used by test cache doubles.
- A revision-keyed LRU can cache an exact repeated search request (same root and
  query) after the cache is stable. It can make an unchanged polling/reload
  request inexpensive, but does not improve the first request, a new query, or
  a cache revision that is changing while workers are indexing.
- Do not reuse media-library payloads or make file search depend on
  `media_library.py`: those payloads intentionally include only supported media
  extensions and have a different row contract. If an LRU is shared, extract
  only the generic cache primitive into a neutral helper.
- The current folder-cache revision is global. Any folder-cache update can
  invalidate an otherwise unrelated root snapshot. Do not represent this small
  LRU as a replacement for incremental search or as a first-search latency
  solution.

## Testing

Current test coverage includes:

Python tests:

- cache-only search endpoint behavior
- trace coverage for search endpoint
- partial and complete cache status behavior
- path traversal rejection
- image-only thumbnail fields in search results

JavaScript tests:

- query token matching
- type group matching
- date range matching
- empty states
- polling lifecycle
- stop-search behavior
- Enter key starts search
- virtualization rendering
- browse-link and Dropbox-link result actions

Shell/UI tests:

- page shell includes pane markup and assets
- HEAD handling for search assets

Not currently implemented:

- browser E2E coverage dedicated to file search

### Coverage Verification (July 19, 2026)

The existing non-browser coverage is meaningful, but it does not cover a real
file-search browser workflow end to end.

- Python endpoint tests cover cache-only traversal without `rclone`, recursive
  path/query matching, listing-cache fallback, partial cache status, parent-path
  rejection, image thumbnail fields, and the endpoint trace contract.
- JavaScript unit tests cover endpoint construction/path rejection, rendering,
  result actions, query/type/date filtering, virtualization, Search/Enter/Reset
  behavior, incomplete-cache polling, pane-hide polling cancellation, and Stop.
- Web shell tests cover pane markup and serving the search assets (including
  `HEAD`), but not interactive search behavior.
- Before this implementation there was no dedicated Playwright search test.
  The prior browser-level reference only verified that the selected
  bottom-pane mode survived reload; it did not start a search, verify results,
  poll a partial tree, or exercise result actions.

At that point the feature had solid unit and endpoint coverage for the shipped
stateless snapshot contract, but no E2E confidence in the browser/server
integration. The session work below therefore added both E2E coverage and new
focused contract tests rather than relying on manual testing alone.

Implementation update: `tests/e2e/client-render.file-search.spec.js` now covers
batched nested results and virtualization, encoded containing-folder/reveal
navigation, and Stop/cancellation against the real HTTP server. The focused
endpoint tests cover session batching, cancellation, unknown ids, local-only
rows, work metrics, and revision-keyed repeat responses.

## Open Decisions

- Should result rows remain files and folders, or become files-only?
  Current behavior includes both. No change is planned yet.
- Should the pane eventually support server-side coarse filters or paging?
  Likely yes for performance, but not yet implemented.
- Should file search become incremental or session-based instead of one full
  snapshot per request?
  This is now the main performance follow-up for root search.
- When local comparison is enabled, must recursive search continue to include
  local-only files and folders? Current browse-style row hydration can surface
  them. A raw Dropbox `direct_items` candidate pass must not silently remove
  that behavior; retaining it efficiently may need a local candidate index or
  a documented scope decision.
- What bounds should protect an in-memory incremental session (maximum active
  sessions, result rows, idle lifetime, and cancellation behavior)?

## Recommended Implementation Plan

Goal: reduce time-to-first-result for root searches from Dropbox root without
breaking the current cache-only and safe-path behavior.

### Step 0 - Baseline And Instrumentation

**Status: ✅ Complete** — endpoint traces now include planning, candidate-scan,
hydration, serialization, work-count, first-batch, and folder-record metrics;
tests assert the observable counts without wall-clock timing.

- Keep the existing total endpoint trace and add fields for:
  - recursive planning time
  - candidate scan time
  - row hydration time
  - response serialization time
  - scanned folder count
  - scanned direct-item count
  - hydrated row count
  - first-batch result count
  - folder-cache record-read count
- Capture a current root-search baseline with a selective query and with a
  no-match query before changing behavior. The June 7 ~6.3-second observation
  is useful context, not a current performance guarantee.
- Add focused test helpers that can assert work counts without wall-clock timing.

Expected outcome:

- a reproducible comparison point and regressions based on observable work,
  rather than timing-sensitive tests

### Step 1 - Fast Candidate Pass And Record Reuse

**Status: ✅ Complete** — recursive search performs a cheap remote candidate
pass, hydrates only matching rows, preserves local-only candidates, and reuses
folder-cache records through a request-local lookup.

- Split recursive search into two phases:
  - cheap candidate matching over cached Dropbox `direct_items`, while still
    traversing every remote child folder needed to discover descendants
  - browse-style row hydration only for matched entries
- Avoid rebuilding browse-style entry rows for folders that produce no matches.
- Keep text matching based on normalized filename and relative path tokens.
- Carry a request-local record map through both `ensure_known_subtree()` and the
  search traversal, following the media-library `record_lookup` pattern.
- Preserve safe Windows name matching and the visible row/action contract when
  hydrating a candidate.
- Explicitly preserve local-only search semantics, or add and approve a
  replacement local candidate strategy before optimizing the remote-only path.

Expected outcome:

- substantially lower CPU, local filesystem, status, and serialization work for
  selective root queries
- same visible result shape for matched rows
- no claim of bounded first-response time: a rare/no-match query still needs a
  full cached-tree candidate scan to establish completeness

### Step 2 - Incremental Search Session And First Batch

**Status: ✅ Complete** — bounded cancellable sessions provide opaque ids,
limited batches, separate cache/search completeness, deduplication, expiry, and
background traversal without recursive request-thread `rclone` work. Incremental
sessions skip the full-tree `ensure_known_subtree()` preflight, begin cached
folder scanning immediately, and request metadata only when a visited folder is
missing its cached listing.

- Add an app-local, cancellable background search session keyed by a generated
  opaque session id. Keep cache-only input rules: the session may inspect cached
  records and request existing folder-cache background work, but must not run
  synchronous recursive `rclone` work on the HTTP request thread.
- Add `limit=<n>` for the first batch and subsequent batches. The session should
  return a batch as soon as enough candidates have been found and hydrated.
- Return separate state for cache completeness and search-scan completeness;
  they are not the same while a session is progressing.
- Bound session count, result retention, and idle lifetime. Stop work when the
  client cancels, hides the pane, supersedes a query, or the session expires.
- Keep result identity stable and deduplicate rows by remote/local path across
  batches and cache updates.

Expected outcome:

- root searches can return the first visible batch without paying the cost of a
  complete full-tree scan up front
- later batches and final completeness are reachable without rescanning the
  same first page on every poll

### Step 3 - Client Session Polling And Result Merge

**Status: ✅ Complete** — the file-search pane starts and polls sessions,
merges batches without duplicates, retains local filters, reports distinct
progress states, and cancels on Stop, hide, or superseding searches.

- Reuse the pane's existing cancellation, visibility, and polling lifecycle.
- Replace whole-snapshot polling with session polling that merges new batches
  into the virtualized result collection without duplicates.
- Distinguish user-facing messages for:
  - folder metadata still indexing
  - search scan in progress
  - first batch available while more results are scanning
  - complete search
- Retain the existing local type/date filtering, and apply it to accumulated
  results without forcing a new server scan.

Expected outcome:

- improved time-to-first-result
- improved perceived responsiveness for root search
- preserved complete-result behavior after background search settles

### Step 4 - Revision-Keyed Repeat-Request Cache (Optional)

**Status: ✅ Complete** — completed remote-only snapshots use a bounded
revision-keyed LRU; local-root searches remain uncached and cache hits expose
fresh status/trace metadata.

- After Steps 0-3, consider an LRU for completed exact search responses or
  session snapshots, keyed by root, server query, row-shape-affecting options,
  and folder-cache revision.
- Reuse a generalized form of `MediaLibrarySnapshotCache`, not the media payload
  itself. Return fresh status metadata on a hit.
- Add a size/entry bound appropriate for arbitrary file-search result sets.

Expected outcome:

- inexpensive identical searches or polls when the folder-cache revision is
  unchanged
- no reliance on this cache for initial-query responsiveness

### Step 5 - Validate

**Status: ✅ Complete** — focused endpoint, cache/name/web, JavaScript, full
Python, and client-render Playwright coverage are passing, including the
session contract, cancellation, local-only rows, duplicate suppression,
virtualization, encoded reveal navigation, and cache invalidation cases.
The regression suite also proves a partial result is returned while a
descendant listing remains blocked.

- Add regression tests for:
  - candidate filtering hydrates only matches while preserving result semantics
  - local-only behavior under `--local-root`
  - per-request record lookup avoids duplicate cache reads
  - first batch returns before full search-scan completion
  - session cancellation, expiry, deduplication, limit handling, and final
    completion
  - cache revision invalidates an exact-result snapshot
- Add endpoint/unit contract tests for:
  - invalid, expired, cancelled, and unknown session ids
  - a session that returns a first batch before its full scan completes, then
    returns every later row exactly once
  - separate cache-indexing and search-scanning status fields
  - a selective query, an empty query, and a no-match query
  - Unicode/separator-normalized matching and Windows-renamed local paths
  - no foreground recursive `rclone` call from session creation or polling
- Extend `tests/js/file-search.test.js` for the new session payload instead of
  weakening existing snapshot tests. Cover:
  - first-batch append/merge and duplicate suppression
  - virtualization after multiple appended batches
  - Stop, pane hide, query change, and superseding search cancellation
  - distinct indexing-versus-search-progress copy and terminal states
  - retained local type/date filters while batches continue arriving
- Add a real-browser Playwright suite, preferably
  `tests/e2e/client-render.file-search.spec.js` so it runs in the existing
  `client-render` project. Use an isolated fake-rclone fixture with a nested
  tree and a controllable partial-cache phase. It must exercise:
  - selecting the File Search pane, capturing the current browse folder, and
    receiving a matching nested result through the real HTTP endpoint
  - partial cached metadata followed by a completed search, with no duplicate
    visible rows
  - Stop/cancellation and hiding the pane preventing further visible polling
  - a result action that navigates to its containing folder with the file
    revealed; include a safe encoded/Unicode path case
  - a large enough result fixture to verify virtualization remains usable after
    batch merging
- Run the relevant `cache`, `names`, and `web` test groups, plus JavaScript
  file-search tests and the client-render Playwright project; run the full
  suite before handoff because the shared folder-cache contract is involved.

`limit` must not be implemented as an isolated endpoint change: the current
client replaces its full result snapshot on every poll, so a stateless limited
endpoint would repeatedly return the first page and never safely advance to
later matches. Pair it with a cursor or, preferably, the bounded session in
Steps 2-3.

This work should be treated as the next phase of the existing recursive file
search feature rather than a separate search product.
