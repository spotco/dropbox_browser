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

test("renderVirtualBrowseRowsBody renders spacer rows around the visible window", async () => {
  global.window = { SyncControls: null };

  const render = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/render.js");
  const html = render.renderVirtualBrowseRowsBody(
    [
      {
        id: "file:one",
        display_name: "one.txt",
        path: "one.txt",
        kind: "file",
        remote: true,
        local: false,
        type_label: "txt",
        icon_href: "/assets/icons/material-icon-theme/document.svg",
        status_label: "Dropbox Only",
        status_class: "remote",
        size_display: "1 B",
        count_display: "",
        date_display: "2024-01-01 00:00",
        metadata_complete: true,
        sort_name: "one.txt",
        sort_date: 1,
        preview_href: "/file?path=one.txt&source=remote",
        download_href: "/download?path=one.txt&source=remote",
        sync: { allowed: false, directions: [] },
      },
      {
        id: "file:two",
        display_name: "two.txt",
        path: "two.txt",
        kind: "file",
        remote: true,
        local: false,
        type_label: "txt",
        icon_href: "/assets/icons/material-icon-theme/document.svg",
        status_label: "Dropbox Only",
        status_class: "remote",
        size_display: "2 B",
        count_display: "",
        date_display: "2024-01-02 00:00",
        metadata_complete: true,
        sort_name: "two.txt",
        sort_date: 2,
        preview_href: "/file?path=two.txt&source=remote",
        download_href: "/download?path=two.txt&source=remote",
        sync: { allowed: false, directions: [] },
      },
      {
        id: "file:three",
        display_name: "three.txt",
        path: "three.txt",
        kind: "file",
        remote: true,
        local: false,
        type_label: "txt",
        icon_href: "/assets/icons/material-icon-theme/document.svg",
        status_label: "Dropbox Only",
        status_class: "remote",
        size_display: "3 B",
        count_display: "",
        date_display: "2024-01-03 00:00",
        metadata_complete: true,
        sort_name: "three.txt",
        sort_date: 3,
        preview_href: "/file?path=three.txt&source=remote",
        download_href: "/download?path=three.txt&source=remote",
        sync: { allowed: false, directions: [] },
      },
    ],
    { startIndex: 1, endIndex: 2, topSpacerHeight: 40, bottomSpacerHeight: 40 },
  );

  assert.match(html, /browse-virtual-spacer/);
  assert.match(html, /height:40px/);
  assert.doesNotMatch(html, /one\.txt/);
  assert.match(html, /two\.txt/);
  assert.doesNotMatch(html, /three\.txt/);
});
