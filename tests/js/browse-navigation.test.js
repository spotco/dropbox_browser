const path = require("node:path");
const {pathToFileURL} = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  return import(pathToFileURL(absolutePath).href);
}

test("readBrowseHref parses only same-origin browse URLs", async () => {
  global.window = {
    location: {
      href: "http://127.0.0.1:8010/?path=folder",
      origin: "http://127.0.0.1:8010",
    },
  };

  const navigation = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/navigation.js");

  assert.deepEqual(navigation.readBrowseHref("/?path=music&sort=date&dir=desc"), {
    path: "music",
    sort: "date",
    dir: "desc",
    refresh: false,
  });
  assert.equal(navigation.readBrowseHref("/file?path=music/song.mp3&source=remote"), null);
  assert.equal(navigation.readBrowseHref("https://www.dropbox.com/home/music"), null);
});

test("shouldInterceptBrowseLink only accepts canonical browse navigation anchors", async () => {
  global.window = {
    location: {
      href: "http://127.0.0.1:8010/",
      origin: "http://127.0.0.1:8010",
    },
  };

  const navigation = await importModuleFromWorkspace("dropbox_browser/assets/js/browse/navigation.js");

  function createLink(options = {}) {
    return {
      href: options.href || "/",
      id: options.id || "",
      getAttribute(name) {
        if (name === "target") return options.target || "";
        if (name === "href") return options.href || "/";
        return "";
      },
      hasAttribute(name) {
        return name === "download" ? !!options.download : false;
      },
      classList: {
        contains(name) {
          return !!options.classNames && options.classNames.indexOf(name) >= 0;
        },
      },
      closest(selector) {
        return selector === "thead" && options.inTableHead ? {} : null;
      },
    };
  }

  assert.equal(navigation.shouldInterceptBrowseLink(createLink({href: "/?path=folder"})), true);
  assert.equal(navigation.shouldInterceptBrowseLink(createLink({href: "/"})), true);
  assert.equal(navigation.shouldInterceptBrowseLink(createLink({href: "/download?path=file.txt"})), false);
  assert.equal(navigation.shouldInterceptBrowseLink(createLink({href: "/?path=folder", target: "_blank"})), false);
  assert.equal(navigation.shouldInterceptBrowseLink(createLink({href: "/?path=folder", classNames: ["refresh-link"]})), false);
  assert.equal(navigation.shouldInterceptBrowseLink(createLink({href: "/?path=folder", inTableHead: true})), false);
});
