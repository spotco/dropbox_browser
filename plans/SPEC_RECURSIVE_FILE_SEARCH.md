# Recursive File Search Spec

## Goal

Add a recursive file search pane to the existing bottom pane. It should help the
user find files under the current Dropbox folder using cached recursive metadata
while folder-cache workers are still running.

The search pane should be useful before the cache is complete: results should
populate incrementally as background cache threads discover more folders and
files.

Example target workflow:

- The user is browsing `Photos`.
- They open the bottom pane and switch to `File Search`.
- They search for files with a fuzzy name match for `fantasy`.
- They narrow to images.
- They restrict dates to 2020 through 2021.
- Results continue to appear as cached descendants under `Photos` finish loading.

## Non-Goals

- Do not run synchronous recursive Dropbox scans from the request thread.
- Do not add upload, delete, or overwrite behavior.
- Do not make recursive search depend on client-render mode. The bottom pane is
  shared shell UI and should work with server-rendered and client-rendered
  browsing.
- Do not search file contents. This is filename, path, type, metadata, and status
  search only.
- Do not expose unsafe local filesystem paths when local comparison is disabled.

## Existing Foundation

- Bottom pane mode switching already lives in:
  - `dropbox_browser/assets/templates/page.html`
  - `dropbox_browser/assets/js/bottom-pane.js`
  - `dropbox_browser/assets/js/log.js`
  - `dropbox_browser/assets/js/music.js`
- Current bottom pane modes:
  - `server-log`
  - `music-player`
- Recursive folder metadata is owned by `FolderCacheManager`.
- Cached records include direct child files and folders:
  - `direct_items`
  - `direct_files`
  - `direct_folders`
  - `complete`
  - recursive size/date/count fields
- A backend endpoint now exists:

```text
GET /browse/endpoints/search?path=<rel-path>&recursive=1&query=<q>
```

The endpoint is cache-only and reports completion state. The UI should build on
that contract instead of calling `rclone` or adding a second recursive walker.

## Product Shape

Add a third bottom pane mode:

```html
<option value="file-search">File Search</option>
```

The pane should be a compact work surface, not a full-page search product. It
should be optimized for repeated searching while browsing folders.

Recommended layout:

- Header row:
  - root selector/status: current folder path
  - refresh/poll status text
  - result count
- Query row:
  - filename/path fuzzy text input
  - file type selector
  - date range controls
  - clear button
- Result region:
  - virtualized list or table for large result sets
  - preview/download/open-folder actions
  - status and cache completeness indicators

## Core Features

### Search Scope

Default scope should be the current browse folder. When the user navigates to a
different folder, the search pane should update its root to that folder unless
the user has pinned a search root.

Recommended controls:

- `Current Folder` mode: follows browse navigation.
- `Pinned Folder` mode: keeps the selected root while the user browses elsewhere.
- `Use Current Folder` button: resets the pinned root to the current browse path.

Decision: start with current-folder scope only for the first UI milestone, then
add pinning if switching folders while searching becomes disruptive.

### Incremental Cache Updates

The pane must poll while results are incomplete.

Behavior:

- On pane activation, request cached recursive results for the current root.
- If `status.complete` is false, keep polling.
- Polling should continue while:
  - `status.pending` is true;
  - `status.missing_listing_count` is nonzero;
  - the pane is visible and the same root/query/filter set is active.
- Polling should stop when:
  - results are complete;
  - the pane is hidden;
  - the user navigates away and the root changes;
  - a newer request supersedes the active request.

The status line should distinguish:

- `Searching cached files...`
- `Still indexing cached folders...`
- `Search complete`
- `No cached data for this folder yet`

### Text Matching

The main search box should match:

- filename;
- relative path under the search root;
- extension without requiring a leading dot.

Matching should be forgiving:

- case-insensitive;
- Unicode-normalized in the same spirit as `filename_compare_key`;
- token-based, so `fantasy castle` can match a filename/path containing both
  words in any order;
- tolerant of separators such as `_`, `-`, `.`, and spaces.

Decision: implement simple token matching first. Add ranked fuzzy scoring only
after the basic UX is proven.

### File Type Filtering

Support broad type groups first:

- `All`
- `Images`
- `Audio`
- `Video`
- `Documents`
- `Archives`
- `Code`
- `Other`

The backend rows already expose `type_label`; the client can map extensions and
type labels into these groups. The endpoint can later add an explicit
`type_group` if client mapping starts duplicating Python logic too much.

Image filtering should include common browser and camera formats:

- `.jpg`
- `.jpeg`
- `.png`
- `.gif`
- `.webp`
- `.bmp`
- `.tif`
- `.tiff`
- `.heic`
- `.avif`

### Date Filtering

Support date ranges based on the best available file timestamp.

Initial controls:

- `From` date input.
- `To` date input.
- Quick presets:
  - `Any time`
  - `This year`
  - `Last year`
  - `Last 30 days`
  - `Custom`

For the example query, the user should be able to set:

```text
From: 2020-01-01
To: 2021-12-31
Type: Images
Query: fantasy
```

Open decision: use inclusive local-date boundaries in the UI, converted to epoch
ranges in the client. This matches user expectations better than UTC-midnight
semantics.

### Result Rows

Each result should show:

- icon;
- filename;
- relative path under the search root;
- type;
- status;
- size;
- modified date;
- source availability: Dropbox, local, or both;
- actions:
  - preview/open;
  - download;
  - show containing folder;
  - copy path when available.

`Show containing folder` should navigate the main browser to the parent folder
and optionally highlight the file if the listing UI supports highlighting later.

### Sorting

Default sort should be relevance, then date descending.

Available sorts:

- relevance;
- name;
- type;
- status;
- size;
- date;
- path.

Decision: if the first version uses token matching without scoring, `relevance`
can be a stable grouping:

- filename matches before path-only matches;
- exact token-prefix matches before substring matches;
- date descending as a tie-breaker.

### Empty And Partial States

The pane needs separate states for different empty outcomes:

- No query entered: show recent cached files or a neutral empty state.
- Query has no matches but cache is still incomplete: show `No matches yet`.
- Query has no matches and cache is complete: show `No matching files`.
- No cache record exists for the root: show that indexing has started or that the
  user should browse/refresh the folder to seed metadata.

Decision: for the first UI milestone, show no results until the user types a
query or chooses a type/date filter. A later enhancement can show recent files.

## Backend Contract

Use the existing endpoint as the initial backend contract:

```text
GET /browse/endpoints/search?path=<rel-path>&recursive=1&query=<q>
```

The first UI version should call this existing endpoint directly. It likely
needs these additions later:

- `type_group=<group>` or `type=<type-label>` for server-side coarse filtering
  if result sets become large.
- `date_from=<YYYY-MM-DD>` and `date_to=<YYYY-MM-DD>` if client-side filtering
  over returned cached rows becomes too expensive.
- `limit=<n>` and `cursor=<token>` if cached result sets can be very large.
- `poll_seq` and `poll_delay_ms` fields mirroring the music-library endpoint for
  traceability.

Decision: keep filtering client-side for the first pane version. Add server-side
filters only when performance validation shows a real need.

## Client State

Recommended state fields:

- `rootPath`
- `followsCurrentFolder`
- `query`
- `typeGroup`
- `dateFrom`
- `dateTo`
- `sortKey`
- `sortDirection`
- `results`
- `status`
- `loading`
- `polling`
- `requestVersion`
- `abortController`

Persist in browser settings:

- last selected type group;
- last date preset;
- sort key/direction;
- whether the pane follows the current folder.

Do not persist arbitrary query text by default. Search text can expose personal
intent and is usually cheap to retype.

## URL Decisions

Do not put recursive search state into the main browse URL initially. The search
pane is secondary bottom-pane state, while the URL should continue to represent
the current folder listing.

Possible future behavior:

- Add a copyable search permalink only if users need to share/reopen searches.
- Store it in hash/query parameters with a distinct namespace such as
  `search_q`, `search_type`, `search_from`, `search_to`.

## Performance Decisions

Expected first version:

- Fetch cached recursive results as JSON.
- Filter and sort in the browser.
- Virtualize the result list once result count crosses the existing browse
  virtualization threshold.
- Abort stale requests when the user changes query/filter/root quickly.
- Debounce text input before fetching.

Recommended debounce:

- 200-300 ms for text input.
- Immediate fetch for type/date/sort changes.

If result payloads become too large:

- add server-side coarse filters;
- add result limits and paging;
- consider a folder-cache-derived search index.

## Accessibility And Keyboard Behavior

Expected keyboard support:

- Focus search input when the file-search pane opens.
- `Enter` moves focus to results when results exist.
- Arrow keys move through result rows when the result list is focused.
- `Escape` clears the query if the search input is focused.
- Actions remain real buttons or links with accessible labels.

The result list should use table or grid semantics consistent with the existing
browse table patterns.

## Implementation Plan

### Step 1 - Pane Shell

- Add `file-search` option to the bottom-pane selector.
- Add `file_search.html` template or inline pane markup in the page shell.
- Add `assets/css/file-search.css` or a clearly scoped section in `app.css`.
- Add `assets/js/file-search.js`.
- Load the script in the shared shell.

### Step 2 - Endpoint Client

- Add a small client API helper around the existing
  `/browse/endpoints/search`.
- Fetch on pane activation.
- Read current browse root from `body.dataset.currentFolderPath`.
- Abort stale requests.
- Render status and simple result rows.

### Step 3 - Automatic Polling

- Poll while the endpoint reports incomplete cache state.
- Stop polling when the pane is hidden.
- Restart polling on folder navigation when following current folder.
- Listen for the existing `browse-folder-changed` event in client-render mode.
- For server-rendered navigation, initialize from the new page body dataset.

### Step 4 - Filters

- Add query, type group, and date range controls.
- Apply filters locally against the current result snapshot.
- Debounce text updates.
- Show partial-vs-complete empty states.

### Step 5 - Result Actions

- Add preview/download links.
- Add show-containing-folder navigation.
- Add copy path where available.
- Preserve existing safe path and source semantics.

### Step 6 - Large Result Handling

- Add virtualization for large result sets.
- Add tests for filtering and sort order.
- Add Playwright coverage with a large fixture.

## Testing

Python tests:

- endpoint remains cache-only and does not call `rclone`;
- partial and complete statuses are correct;
- path traversal is rejected;
- date/type fields are present and stable enough for the client filters.

JavaScript tests:

- query token matching;
- type group matching;
- date range matching;
- polling stop/start rules;
- stale request abort/ignore behavior;
- sort behavior.

E2E tests:

- switch bottom pane to `File Search`;
- search current folder recursively;
- verify results update as folder-cache workers complete;
- filter by image type and date range;
- open preview/download from a result;
- navigate to containing folder from a result.

## Open Decisions

- Should recursive search show only files, or files and folders?
  Recommended: files only for the pane's primary purpose, with folders only as
  path context.
- Should the initial result set show recent files before a query?
  Recommended: no for v1; require a query or filter to avoid noisy large lists.
- Should type/date filters be sent to the server?
  Recommended: client-side first, server-side later if payload size demands it.
- Should searches follow folder navigation by default?
  Recommended: yes, with pinned root added later if needed.
- Should result state live in the URL?
  Recommended: no for v1; keep the browse URL focused on folder navigation.
- Should fuzzy matching include typo tolerance?
  Recommended: not initially. Token matching is predictable and cheaper.
