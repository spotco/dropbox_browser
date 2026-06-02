const path = require("node:path");
const {pathToFileURL} = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  return import(pathToFileURL(absolutePath).href);
}

test("renderBrowseRowsBody renders canonical folder and file row markup", async () => {
  global.window = {
    SyncControls: {
      renderCell(relPath, kind, status) {
        return `<form data-sync-path="${relPath}" data-kind="${kind}" data-status="${status}"></form>`;
      },
    },
  };

  const render = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/render.js");
  const html = render.renderBrowseRowsBody([
    {
      id: "folder:folder",
      display_name: "folder",
      path: "folder",
      kind: "folder",
      remote: true,
      local: true,
      type_label: "folder",
      icon_href: "/assets/icons/material-icon-theme/folder-base.svg",
      status_label: "Loading",
      status_class: "loading",
      size_display: "—",
      count_display: "",
      date_display: "",
      metadata_complete: false,
      sort_name: "folder",
      sort_date: 0,
      local_copy_path: "C:/tmp/folder",
      folder_href: "/?path=folder",
      sync: { allowed: false, directions: [] },
    },
    {
      id: "file:remote-only.txt",
      display_name: "remote-only.txt",
      path: "remote-only.txt",
      kind: "file",
      remote: true,
      local: false,
      type_label: "txt",
      icon_href: "/assets/icons/material-icon-theme/document.svg",
      status_label: "Dropbox Only",
      status_class: "remote",
      size_display: "10 B",
      count_display: "",
      date_display: "2024-01-02 07:00",
      metadata_complete: true,
      sort_name: "remote-only.txt",
      sort_date: 1704196800,
      local_copy_path: null,
      preview_href: "/file?path=remote-only.txt&source=remote",
      download_href: "/download?path=remote-only.txt&source=remote",
      sync: { allowed: true, directions: ["dropbox_to_local"] },
    },
  ]);

  assert.match(html, /data-folder-path="folder"/);
  assert.match(html, /data-sync-path="remote-only\.txt"/);
  assert.match(html, /href="\/\?path=folder"/);
  assert.match(html, /href="\/file\?path=remote-only\.txt&amp;source=remote"/);
  assert.match(html, /href="\/download\?path=remote-only\.txt&amp;source=remote"/);
  assert.match(html, /Copy Folder Path/);
  assert.match(html, /calculating…/);
});
