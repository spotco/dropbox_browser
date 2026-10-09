const path = require("node:path");
const {pathToFileURL} = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  return import(pathToFileURL(absolutePath).href);
}

test("listingWarningMessage is empty when the live listing succeeded", async () => {
  const {listingWarningMessage} = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/listing-warning.js");
  assert.equal(listingWarningMessage(undefined), "");
  assert.equal(listingWarningMessage({source: "rclone", remote_error: null, stale: false}), "");
});

test("listingWarningMessage explains local-only rows with unknown Dropbox status", async () => {
  const {listingWarningMessage} = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/listing-warning.js");
  const message = listingWarningMessage({
    source: "local_only_after_remote_error",
    remote_error: "too_many_requests",
    stale: false,
  });
  assert.match(message, /^Dropbox listing unavailable, showing local files/);
  assert.match(message, /unknown/);
});

test("listingWarningMessage labels a stale last-good listing with its age", async () => {
  const {listingWarningMessage} = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/listing-warning.js");
  const message = listingWarningMessage({
    source: "stale_after_remote_error",
    remote_error: "too_many_requests",
    stale: true,
    stale_cached_display: "2026-10-08 20:15",
  });
  assert.match(message, /last known Dropbox listing from 2026-10-08 20:15/);
  assert.match(message, /out of date/);
});
