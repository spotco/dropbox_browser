# Browse UI and recursive search

The normal page is a server-rendered shell followed by client-rendered browse
rows. `--client-render` is the default and the maintained mode. The legacy
server-rendered row path exists for compatibility, but new UI behavior and
regression tests should target the client endpoint.

## Page lifecycle

1. `GET /` renders the page shell, toolbar, table headings, bottom-pane shells,
   and a loading row.
2. `assets/js/browse/main.js` reads the current folder from the page state and
   requests `GET /browse/endpoints/listing`.
3. The response replaces the table body, updates the title/breadcrumbs and
   refresh link, and starts `/folder-info` polling for folders whose recursive
   metadata is incomplete.
4. Navigation uses the History API for ordinary folder links. Back/forward
   restores the folder, filters, and client state without a full page reload.
5. Refresh invalidates the current folder; holding Shift requests the folder and
   known child folders, then reloads the listing in place.

The listing endpoint returns direct children. It does not recursively scan
Dropbox on the request thread. Folder size/count/date/diff information is
progressively patched into mounted rows as background workers complete.

## Sorting and filters

The table sorts by `Name`, `Type`, `Status`, `Size`, or `Date`. Folders remain
ahead of files, and filename comparisons use the same normalized comparison key
as the Python name matcher. Clicking the active heading toggles direction.

The current-folder filter bar supports:

- text matching against the current row's name/path fields;
- `Folders` or `Files` kind;
- `Synced`, `Has Diffs`, `Dropbox Only`, `Local Only`, or `Loading` status;
- a dynamically populated file type filter.

These filters run locally against the loaded direct listing and do not refetch
Dropbox. Sort state is persisted per folder; filter visibility and values are
also persisted per folder through the `Settings` wrapper in
`assets/js/settings.js`.

## Large and media-heavy folders

The browse client includes several UI-only performance features:

- virtualized rows for large listings, with overscan and measured row height;
- a synchronized horizontal scrollbar and drag preview;
- resizable table columns whose preferred widths persist in local storage;
- lazy image thumbnails;
- image hover previews that use the direct file stream and abort stale work;
- generation/abort checks so late folder or thumbnail responses cannot repaint
  a different folder.

Image rows use `/thumbnail` when ImageMagick is available. Video rows use
`/video/endpoints/thumbnail` when FFmpeg video posters are available. Rows that
are both local and remote with `Has Diffs` use the local source for the poster,
so the image represents the selected comparison side.

## Recursive File Search pane

Choose **File Search** in the bottom-pane selector to search descendants of the
current folder. The search root is captured when Search is pressed. It supports
filename/path tokens, type groups (`images`, `audio`, `video`, `documents`,
`archives`, `code`, and `other`), and date presets (`this-year`, `last-year`,
`last-30-days`, or a custom range).

The server scans known folder-cache listings rather than doing a fresh Dropbox
recursion. When the scan is incomplete, the client polls a short-lived search
session and merges result batches. Search sessions are bounded, cancellable,
and evicted after inactivity. Results may therefore be partial until the folder
cache is populated.

The query builder is in `assets/js/file-search-api.js`; the server-side session
manager is in `services.py`. The wire contract is in [HTTP API](http-api.md).

## Bottom-pane shell

The shared bottom pane can show server logs, File Search, Music Player, Video
Player, or Photo Map. Its mode, height, full-page preference, and panel state are
stored in browser local storage under the `dropbox-browser.` prefix. Music and
video restore their own layout only after their module initialization; a short
fallback prevents the shell from staying locked if a media module cannot load.

The shared shell is implemented by `bottom-pane.js` and `log.js`. Media-specific
behavior belongs in the corresponding pane documentation.

## Row links and path copying

File rows provide Preview and Download links, a copy-path action when a local
match exists, and sync controls when a local root and an allowed direction are
available. Folder rows link to the child folder and show background metadata
status. `local_path` values are taken from actual filesystem resolution so names
that Dropbox displays with Windows-invalid characters continue to work.

See [Windows Name Matching](windows-name-matching.md) and [Sync and rclone](sync-and-rclone.md)
before changing row actions or path serialization.
