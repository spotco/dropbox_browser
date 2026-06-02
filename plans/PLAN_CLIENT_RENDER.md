# Client-Side Browsing Render Plan

## Goal

Add an optional client-rendered browsing mode that keeps server-rendered
browsing as the default and preserves current URL, preview/download, sync,
folder metadata, cache refresh, music-player, and bottom-pane behavior.

The initial target is feature parity for normal folder browsing with better
large-folder responsiveness:

- `GET /?path=...` deep links still work.
- Back/forward navigation still maps to the same folder URLs.
- Sorting by name, type, status, size, and date happens in the browser without a
  page reload.
- Folder metadata continues to use the existing listing cache and folder-cache
  worker system.
- Extremely wide folders render only visible rows through virtualization.
- Server-rendered browsing remains available and unchanged when the new mode is
  disabled.

Later targets build on the same client data model:

- direct-folder local search/filter without a refresh;
- recursive local search/filter from already cached/indexed folder metadata;
- richer large-list scroll previews by current sort/filter state.

## Current State Summary

- `handlers.py.render_index()` currently performs one merged listing load,
  opportunistically reads folder-cache records, computes status labels, sorts
  rows, renders HTML through `views.page_html()`, and emits
  `navigation_render_complete` traces.
- `services.py` already centralizes reusable listing and row decisions:
  `list_entries()`, `status_label_for_entry()`, `file_statuses_for_entries()`,
  and `sort_entries()`.
- `views.py` owns the current row HTML contract, icon mapping, breadcrumbs,
  Dropbox URL, sync button rendering, status CSS labels, display date, and human
  size formatting.
- `folder.js` already polls `/folder-info` and updates folder rows and direct
  file status cells after background metadata progresses.
- `sync.js` is mostly event-delegated, so dynamically rendered row sync forms can
  reuse existing `/sync`, `/sync-batch-plan`, `/sync-batch`, and `/sync-status`
  endpoints.
- Existing music endpoints are a useful model: `/music/endpoints/library` is
  JSON-only, cache-integrated, and keeps endpoint tests separate from rendering.

## Design Principles

- Keep the new mode behind an explicit flag or query/config setting until it is
  feature-complete.
- Reuse backend business logic; do not duplicate Dropbox/local merge rules,
  Windows-safe matching, status semantics, or cache invalidation decisions in
  JavaScript.
- Return JSON data that is display-ready enough for the client to render without
  knowing Python-only details, but still stable enough to sort/filter locally.
- Keep browser navigation URLs canonical. Client mode changes how content is
  fetched and rendered, not what URLs mean.
- Make the client renderer progressive: first implement non-virtualized parity,
  then switch the row body to virtualization after the data contract is stable.
- Do not introduce upload behavior, delete behavior, unsafe path behavior, icon
  hotlinking, or implicit overwrite behavior.

## Progress

- Completed: Step 1 - disabled client-render mode switch.
- Completed: Step 2 - shared browsing snapshot builder.
- Completed: Step 3 - JSON row contract and listing endpoint.
- Completed: Step 4 - client-side HTML shell split.
- Current: Step 5 - organize browser JavaScript into browse modules.

## Step 1 - Add A Disabled Client Render Mode Switch

Status: completed on 2026-06-02.

- Implemented `--client-render` in `dropbox_browser/cli.py` with default
  disabled behavior.
- Added `DropboxBrowser.client_render` state and trace metadata wiring.
- Added `data-client-render="0|1"` to the page shell.
- In client-render mode, the page now serves a stable client mount point
  (`<tbody id="browse-rows">`) with a loading placeholder instead of
  pre-rendered rows.
- Added targeted CLI and web UI tests proving server-rendered mode remains the
  default.

- Add a config/CLI-controlled boolean such as `--client-render` with default
  `False`.
- Consider a development-only query override such as `?client_render=1` only if
  useful for testing. If added, it must not change default behavior.
- Add mode state to the HTML shell via `data-client-render="1"` or equivalent.
- When disabled, keep the current `render_index()` and `page_html()` behavior
  byte-for-byte compatible where practical.
- When enabled, still serve `GET /?path=...` as an HTML page, but allow the page
  body to contain a client-render placeholder instead of pre-rendered rows.
- Add tests proving server-rendered mode remains the default.

## Step 2 - Extract A Shared Browsing Snapshot Builder

Status: completed on 2026-06-02.

- Moved non-HTML browse snapshot work out of `RequestHandler.render_index()`
  into `DropboxBrowser.build_browse_snapshot(...)`.
- Added a reusable snapshot object that carries canonical sort/direction state,
  merged and sorted entries, current-folder metadata, child-folder cache
  summaries, listing source, and timing fields.
- Kept `render_index()` rendering the same server HTML from the snapshot so the
  HTML route and future JSON route can share one source of truth.
- Added focused cache tests covering direct-listing reuse, refresh invalidation,
  and Windows-safe resolved local paths through the snapshot builder.

- Move the non-HTML parts of `RequestHandler.render_index()` into a service-level
  helper, for example `DropboxBrowser.build_browse_snapshot(...)`.
- Inputs:
  - `rel_path`;
  - `sort_key`;
  - `direction`;
  - `force_refresh`;
  - `page_time`;
  - a flag for whether to queue/cache current-folder and child-folder metadata.
- Outputs:
  - canonical `path`, `sort`, `dir`, `refresh` state;
  - listing source and timing trace fields;
  - merged entries before or after server sort as needed;
  - current folder cache status;
  - child folder cache summaries;
  - status labels and sort values for every row.
- Keep `render_index()` using this helper first, then render the same
  server-side HTML from the snapshot. This prevents the JSON endpoint and HTML
  route from drifting.
- Add focused tests around the snapshot helper using fake rclone and isolated
  caches.

## Step 3 - Define The JSON Row Contract

Status: completed on 2026-06-02.

- Added `GET /browse/endpoints/listing` backed by the shared browse snapshot.
- The endpoint returns display-ready page metadata, structured breadcrumbs,
  normalized sort state, pending metadata paths, and row objects with stable
  ids, canonical hrefs, icon names, status labels/classes, display strings, raw
  sort values, and sync eligibility.
- Path traversal is rejected through `clean_rel_path`.
- The endpoint reuses listing cache and folder-cache direct listings through the
  shared snapshot path.
- Refresh reuses the same force-refresh browse pipeline as server rendering.
- Windows-renamed local matches expose the actual resolved local path in row
  data.
- Added focused endpoint tests covering cache reuse, refresh behavior, path
  safety, representative row fields, and Windows-safe local path resolution.

- Add a JSON endpoint such as:

```text
GET /browse/endpoints/listing?path=<rel-path>&sort=<key>&dir=<asc|desc>&refresh=0|1
```

- Return enough data for the browser to render existing rows:
  - page metadata: title, remote, rel path, local comparison note, current local
    folder path, Dropbox home URL, refresh URL;
  - breadcrumbs as structured `{name, path, href}` items, not pre-rendered HTML;
  - rows with stable ids, display name, relative path, kind, local/remote
    presence, source for preview/download, file type label, icon name, status
    label/class, size/date display strings, raw sort values, local copy path,
    preview/download hrefs, folder href, and sync eligibility;
  - pending metadata paths for `/folder-info`;
  - current-folder file status polling requirement;
  - available sort keys and normalized current sort state.
- Keep raw sort fields separate from display strings:
  - `sort_name` should match `filename_compare_key`/server sort semantics as
    closely as feasible;
  - `sort_type`;
  - `sort_status`;
  - `sort_size`;
  - `sort_date`.
- Avoid returning unsafe local filesystem data when local comparison is disabled.
- Add endpoint tests proving:
  - path traversal is rejected through `clean_rel_path`;
  - listing cache/folder-cache direct listing are reused;
  - refresh invalidates the same caches as server rendering;
  - Windows-renamed local paths use actual resolved local paths;
  - row fields match representative existing HTML rows.

## Step 4 - Add A Client-Side HTML Shell

Status: completed on 2026-06-02.

- Split page rendering into explicit shared-shell and browse-table helpers in
  `views.py`.
- Client mode now renders the same shared shell with a stable
  `<tbody id="browse-rows">` placeholder and loading row.
- Script loading is now mode-aware:
  - shared scripts stay loaded in both modes;
  - `folder.js` remains server-rendered only;
  - a new client-only browse bootstrap script is loaded in client mode.
- Asset serving now supports nested browse JS paths under `/assets/js/...`.
- Added web tests covering the client shell script contract and nested browse JS
  asset serving.

- Split `views.page_html()` into:
  - shared page shell rendering;
  - server row/table rendering;
  - client-render placeholders.
- In client mode, render the same header, topbar, sync toggles, batch controls,
  modals, log panel, and music player shell.
- Replace `<tbody>$rows</tbody>` with a stable mount point such as:

```html
<tbody id="browse-rows"></tbody>
```

- Add an initial loading row and enough body data attributes for the client to
  request the current listing.
- Keep existing script includes for `settings.js`, `bottom-pane.js`, `log.js`,
  `music.js`, `refresh.js`, and `sync.js`.
- Add new client-render scripts only in client mode at first.

## Step 5 - Organize Browser JavaScript Into Browse Modules

- Create a dedicated browse JS namespace/module set rather than expanding
  `folder.js` into a large controller.
- Suggested files:
  - `assets/js/browse/api.js` - fetch helpers and endpoint URL construction;
  - `assets/js/browse/state.js` - current path, sort, filter, rows, pending
    metadata, loading/error state;
  - `assets/js/browse/sort.js` - local comparators matching server sort;
  - `assets/js/browse/render.js` - row DOM creation and cell update helpers;
  - `assets/js/browse/navigation.js` - link interception, History API, URL
    synchronization, popstate handling;
  - `assets/js/browse/folder-info.js` - replacement/reuse of current
    `/folder-info` polling against client-owned row state;
  - `assets/js/browse/virtual-list.js` - viewport math and rendered row window;
  - `assets/js/browse/search.js` - direct and recursive filter state, added
    later;
  - `assets/js/browse/main.js` - startup wiring.
- Keep `folder.js` for server-rendered mode initially. Once parity is proven,
  extract shared functions only if it reduces duplication without making either
  mode harder to reason about.
- Add JS unit tests for pure helpers: URL construction, sort comparators,
  filtering predicates, row-window math, and path normalization assumptions.

## Step 6 - Implement Non-Virtualized Client Rendering Parity

- On page load in client mode, fetch `/browse/endpoints/listing` for the current
  URL state and render all rows normally.
- Render row links so normal browser behavior still works if JavaScript
  interception fails:
  - folders link to `/?path=<child>`;
  - remote/local file preview links to `/file?...`;
  - downloads link to `/download?...`.
- Reuse `/assets/icons/material-icon-theme/<name>.svg` for icons; do not fetch
  external icon URLs.
- Recreate the same status classes, size/date cells, copy-path buttons, and sync
  cells as server-rendered rows.
- Make `refresh.js` either work in both modes or delegate client-mode refresh to
  the browse controller.
- Confirm current `sync.js` delegated listeners work with dynamically inserted
  sync forms. If not, narrow the changes to sync initialization/event delegation.
- Add web UI tests for client shell contracts and endpoint fields.
- Add Playwright coverage for:
  - opening a deep link in client mode;
  - clicking into a folder;
  - back/forward restoring the correct rows;
  - preview/download links still pointing at existing endpoints;
  - sync controls still appearing for the same statuses.

## Step 7 - Add Client-Side Sorting Without Reload

- Convert table header sort links in client mode into enhanced controls:
  - still carry canonical `href="/?path=...&sort=...&dir=..."`;
  - intercept clicks only in client mode;
  - update in-memory sort state;
  - re-sort rows locally;
  - update indicators;
  - update `history.pushState()` to the same URL the server-rendered mode would
    use.
- Maintain folder-before-file grouping because `services.sort_entries()` sorts
  folders and files separately.
- Match server direction behavior: clicking the active sort toggles direction;
  clicking a new sort starts ascending unless existing behavior says otherwise.
- When `/folder-info` updates folder size/date/status, update row sort fields
  and re-run the active sort if the active key is affected.
- Add JS tests comparing representative row ordering to expected server
  semantics for name, type, status, size, and date.
- Add Playwright tests proving sort changes do not trigger a full page
  navigation in client mode and do still work through normal links in server
  mode.

## Step 8 - Implement URL-Compatible Client Navigation

- Intercept same-origin folder links in client mode.
- On folder navigation:
  - abort or ignore stale listing requests;
  - update loading state;
  - fetch the new listing endpoint;
  - reset scroll position;
  - update header title, meta, breadcrumbs, refresh href, batch path state, and
    body data attributes;
  - start `/folder-info` polling for the new page;
  - `pushState()` the canonical URL.
- On `popstate`, fetch and render the path/sort/dir represented by the browser
  URL without adding a new history entry.
- Preserve deep linking by deriving initial state from `window.location.search`.
- Ensure non-folder links are not intercepted:
  - `/file`;
  - `/download`;
  - `/assets`;
  - Dropbox external links;
  - form submissions.
- Add E2E coverage for reload, deep link, click navigation, back, forward, and
  sort-state restoration.

## Step 9 - Replace Full Row Rendering With Virtualization

- After non-virtualized parity is stable, add a virtual table body for large
  result sets.
- Keep a small full-render fallback for small folders and for browsers where the
  virtualization assumptions fail.
- Maintain a fixed or measured row height model:
  - estimate row height after first render;
  - compute total scroll height from row count;
  - render an overscanned window around the viewport;
  - position visible rows using spacer rows or translated row containers.
- Preserve table semantics where possible. If table virtualization becomes
  brittle, switch only the browse listing to an accessible grid/list layout in
  client mode while keeping server-rendered table mode unchanged.
- Add a scroll thumb/drag preview that shows the row currently represented by the
  dragged scroll position under the active sort/filter:
  - display name;
  - type/status;
  - index and total;
  - optionally date or size depending on active sort.
- Keep folder metadata polling independent of rendered DOM nodes. Updates should
  modify row state first and only patch DOM if the row is currently mounted.
- Add tests for virtual window math and Playwright tests using a large fixture
  such as `Camera Uploads`.

## Step 10 - Add Direct Local Search And Filtering

- Add a client-mode search box behind the same feature flag.
- Start with direct-folder filtering over the loaded row snapshot.
- Support filters that are entirely browser-local:
  - text/name contains;
  - kind: file/folder;
  - status;
  - type;
  - size/date ranges if useful.
- Filtering updates the visible row set, active counts, empty state, and virtual
  scroll height without calling the server.
- Decide whether filter state belongs in the URL. Recommended: include query
  params only after filter behavior is stable, so deep links can preserve
  filters without breaking current browsing URLs.
- Add JS tests for filter predicates and interactions with sorting.

## Step 10.5 - Promote Stable Filter State Into The URL

- After direct-folder filtering is stable, add URL query params for the filter
  state that is worth deep-linking.
- Update client navigation and `popstate` handling so path/sort/dir/filter state
  round-trips through canonical client-mode URLs.
- Add tests for reload, deep link, back/forward, and filter reset behavior once
  filter state is URL-backed.

## Step 11 - Add Recursive Cached Search

- Build recursive search only from data already local to the app:
  - folder-cache records;
  - cached direct listings;
  - optionally a new explicit background index derived from folder-cache worker
    output.
- Do not make ordinary page loads synchronously recurse through Dropbox.
- Add an endpoint to expose cached recursive results or index status, for
  example:

```text
GET /browse/endpoints/search?path=<rel-path>&recursive=1&query=<q>
```

- The endpoint should report whether results are complete, partial, or waiting
  on background work.
- The client can then search/filter the returned recursive result set locally
  while polling for incremental index updates.
- Reuse the music-library endpoint design where possible: cache-only reads,
  pending-work status, and no direct rclone call from the endpoint.
- Add tests proving recursive search endpoints do not call rclone directly and
  correctly reflect partial vs complete cache state.

## Step 12 - Observability And Performance Validation

- Add workertrace events for client-mode API requests:
  - `browse_listing_endpoint`;
  - row count;
  - source;
  - cache hit/miss counts;
  - elapsed timings matching `navigation_render_complete` phases;
  - client mode flag.
- Add optional browser-side performance logging only if needed; avoid noisy logs
  by default.
- Validate with large fixtures:
  - root;
  - `music`;
  - `Camera Uploads`;
  - folders with thousands of files;
  - folders with local-only, Dropbox-only, and diff statuses.
- Measure:
  - initial HTML shell response time;
  - listing endpoint response time;
  - first visible row render time;
  - sort time without reload;
  - scroll responsiveness;
  - folder-info update behavior while scrolled away from updated rows.

## Step 13 - Test Matrix

- Python targeted tests:

```powershell
python -m tests.run web cache names diff background-file-info -v
```

- JavaScript tests:

```powershell
npm run test:js
```

- E2E tests:

```powershell
npm run test:e2e
```

- Compile checks:

```powershell
python -m py_compile dropbox_browser.py
python -m compileall -q dropbox_browser.py dropbox_browser
python dropbox_browser.py --help
```

- Full suite before broad handoff:

```powershell
python -m unittest discover -s tests -v
```

## Likely Files To Change

- `dropbox_browser/cli.py`
- `dropbox_browser/config.py`
- `dropbox_browser/handlers.py`
- `dropbox_browser/services.py`
- `dropbox_browser/views.py`
- `dropbox_browser/assets/templates/page.html`
- `dropbox_browser/assets/app.css`
- `dropbox_browser/assets/js/folder.js`
- `dropbox_browser/assets/js/refresh.js`
- `dropbox_browser/assets/js/sync.js`
- `dropbox_browser/assets/js/browse/*.js`
- `tests/test_web_ui.py`
- `tests/test_cache.py` or adjacent cache/listing tests
- `tests/test_foldercache_*.py`
- `tests/js/*.test.js`
- `tests/e2e/*.spec.js`
- `docs/architecture.md`
- `docs/background-workers.md`
- `docs/testing.md`

## Open Design Questions

- Chosen: control the first feature gate through CLI/config only. Add a query
  override later only if manual A/B testing becomes painful.
- Chosen: keep filter/search state out of the URL until sort/navigation parity
  and direct filtering are stable, then add it as an explicit follow-up step.
- Chosen: keep recursive cached search on a browse-specific endpoint.
- Chosen: preserve table markup where practical, but allow a client-mode
  accessible grid/list if virtualization makes table semantics brittle.
- Chosen: do not embed the initial client snapshot; always fetch the JSON
  listing endpoint in client mode.

## Recommended Decisions

- Use CLI/config only for the first switch. Add a query override later if manual
  A/B testing becomes painful.
- Do not embed the first listing snapshot initially. The extra request keeps
  endpoint behavior honest and easier to test.
- Keep filter/search state out of the URL until direct filtering is stable, then
  add it in a dedicated follow-up step after sort/navigation parity.
- Implement direct-listing JSON first, then client sorting/navigation, then
  virtualization. Virtualization before data-contract parity will make
  regressions harder to isolate.
- Keep recursive search as a separate later phase because it needs index/cache
  completeness semantics that are larger than the rendering-mode migration.
- Preserve table markup where practical, but prefer a robust accessible
  client-mode grid/list over brittle virtualized table behavior if needed.
