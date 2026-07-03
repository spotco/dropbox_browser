# Recursive File Search Spec

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
- rebuilding browse-style entry rows for all scanned folders
- local path matching and file status work during row hydration
- child folder cache lookups for status labels

This feature currently optimizes for complete snapshot correctness, not
time-to-first-result.

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

## Open Decisions

- Should result rows remain files and folders, or become files-only?
  Current behavior includes both. No change is planned yet.
- Should the pane eventually support server-side coarse filters or paging?
  Likely yes for performance, but not yet implemented.
- Should file search become incremental or session-based instead of one full
  snapshot per request?
  This is now the main performance follow-up for root search.

## Next Steps

Goal: reduce time-to-first-result for root searches from Dropbox root without
breaking the current cache-only and safe-path behavior.

### Step 1 - Fast Candidate Pass

- Split recursive search into two phases:
  - cheap candidate matching over cached `direct_items`
  - row hydration only for matched results
- Avoid rebuilding browse-style entry rows for folders that produce no matches.
- Keep text matching based on normalized filename and relative path tokens.

Expected outcome:

- substantially lower first-response time for selective root queries
- same visible result shape for matched rows

### Step 2 - First-Page Limit

- Add a server-side `limit=<n>` path for search results.
- Stop scanning once enough matches are found for the first page or first batch.
- Keep endpoint status fields rich enough for the client to know whether more
  cached scanning remains.

Expected outcome:

- root searches can return the first visible batch without paying the cost of a
  complete full-tree scan up front

### Step 3 - Incremental Search Session

- Convert root recursive search from a single full snapshot request into an
  incremental background search session.
- Return the first batch as soon as matches are found.
- Continue scanning and append more results through polling until complete.
- Reuse existing search-pane polling patterns where possible.

Expected outcome:

- improved time-to-first-result
- improved perceived responsiveness for root search
- preserved complete-result behavior after background search settles

### Step 4 - Validate And Instrument

- Add trace fields that distinguish:
  - candidate-scan time
  - row-hydration time
  - first-batch result count
  - total scanned folders before first response
- Add regression tests for root-search latency-oriented behavior:
  - first batch returns before full scan completion
  - limit handling
  - incremental polling and final completion

This work should be treated as the next phase of the existing recursive file
search feature rather than a separate search product.
