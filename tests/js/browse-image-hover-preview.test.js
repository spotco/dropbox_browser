const path = require("node:path");
const {pathToFileURL} = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  return import(pathToFileURL(absolutePath).href);
}

test("isPreviewableImageHref accepts browser-previewable image file links", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/image-hover-preview.js");

  assert.equal(
    mod.isPreviewableImageHref("/file?path=Camera+Uploads%2F2020-04-05+12.20.39.png&source=remote", "http://127.0.0.1:8000/"),
    true,
  );
  assert.equal(
    mod.isPreviewableImageHref("/file?path=Photos%2Fcover.JPG&source=local", "http://127.0.0.1:8000/"),
    true,
  );
  assert.equal(
    mod.isPreviewableImageHref("/file?path=music%2Falpha.mp3&source=remote", "http://127.0.0.1:8000/"),
    false,
  );
  assert.equal(
    mod.isPreviewableImageHref("/download?path=Camera+Uploads%2F2020-04-05+12.20.39.png&source=remote", "http://127.0.0.1:8000/"),
    false,
  );
});

test("computeHoverPreviewPosition centers on the pointer and clamps into the viewport", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/image-hover-preview.js");

  assert.deepEqual(
    mod.computeHoverPreviewPosition(
      {x: 400, y: 300},
      {width: 200, height: 120},
      {width: 1000, height: 800},
      18,
    ),
    {left: 418, top: 162},
  );

  assert.deepEqual(
    mod.computeHoverPreviewPosition(
      {x: 25, y: 30},
      {width: 220, height: 160},
      {width: 640, height: 480},
      18,
    ),
    {left: 43, top: 48},
  );

  assert.deepEqual(
    mod.computeHoverPreviewPosition(
      {x: 630, y: 470},
      {width: 220, height: 160},
      {width: 640, height: 480},
      18,
    ),
    {left: 402, top: 292},
  );
});
