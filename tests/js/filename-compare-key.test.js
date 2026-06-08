const {spawnSync} = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const repoRoot = path.resolve(__dirname, "..", "..");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(repoRoot, relativePath);
  const source = await fs.readFile(absolutePath, "utf8");
  return import(`data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`);
}

function pythonFilenameCompareKey(value) {
  const script = [
    "from dropbox_browser.windows_names import filename_compare_key",
    "import sys",
    "sys.stdout.write(filename_compare_key(sys.argv[1]))",
  ].join("\n");
  const result = spawnSync("python", ["-c", script, value], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {...process.env, PYTHONIOENCODING: "utf-8"},
  });
  assert.equal(result.status, 0, result.stderr || "python filename_compare_key failed");
  return result.stdout;
}

test("filenameCompareKey matches Python filename_compare_key for representative names", async () => {
  const module = await importModuleFromWorkspace("dropbox_browser/assets/js/filename-compare-key.js");
  const samples = [
    // ASCII / Latin edge cases
    "Alpha.mp3",
    "\uFF21lpha.mp3",
    "stra\u00DFe.mp3",
    "STRASSE.mp3",
    "Stra\u00DFe.mp3",
    "FILE.TXT",
    "\uFB01le.mp3",
    "\u03A9mega.mp3",
    "\u0130stanbul.mp3",
    "combo <>",
    "Daiki Ishikawa - M\u00e0tham Sanomh.mp3",

    // Japanese (Cache/music + tests/test_sync_routes.py, test_windows_names.py)
    "01 \u6674\u30ec\u6674\u30ec",
    "01 \u6674\u30ec\u6674\u30ec\u30d5\u30a1\u30f3\u30d5\u30a1\u30fc\u30ec(TV\u30a2\u30cb\u30e1\u300c\u7518\u3005\u3068\u7a32\u96fb\u300d\u30aa\u30fc\u30d7\u30cb\u30f3\u30b0\u30c6\u30fc\u30de).mp3",
    "0287 - U.N.\u30aa\u30a8\u30f3\u306f\u5f7c\u5973\u306a\u306e\u304b\uff1f(TO-HOlic mix).mp3",
    "ATARAYO - \u300c\u50d5\u306f...\u300d.mp3",
    "\u300e\u30e6\u30a4\u30ab\u300f\u300c\u3055\u3093\u304b\u304f\u30b2\u30fc\u30e0\u300d TV\u30a2\u30cb\u30e1\u300c\u305f\u3060\u3044\u307e\u3001\u304a\u3058\u3083\u307e\u3055\u308c\u307e\u3059\uff01\u300d\u30ce\u30f3\u30c6\u30ed\u30c3\u30d7ED.mp3",
    "milet\u300cAnytime Anywhere\u300d\u00d7\u300c\u846c\u9001\u306e\u30d5\u30ea\u30fc\u30ec\u30f3\u300dSPECIAL MUSIC VIDEO\uff0f\u30d5\u30ea\u30fc\u30ec\u30f3ED\u30c6\u30fc\u30de\u30a2\u30cb\u30e1MV.mp3",
    "\u30e8\u30eb\u30b7\u30ab\u300c\u6674\u308b\u300d\u00d7\u300c\u846c\u9001\u306e\u30d5\u30ea\u30fc\u30ec\u30f3\u300dSPECIAL MUSIC VIDEO\uff0f\u30d5\u30ea\u30fc\u30ec\u30f3OP\u30c6\u30fc\u30de\u30a2\u30cb\u30e1MV.mp3",
    "Shikura Chiyomaru - Find the blue \u30bb\u30eb\u30d5\u30ab\u30f4\u30a1\u30fc\u30d0\u30fc\u30b8\u30e7\u30f3.mp3",
    "01 \u6b8b\u9177\u306a\u5929\u4f7f\u306e\u30c6\u30fc\u30bc (Director's Edit Version).mp3",

    // Chinese (Cache/music + tests/test_windows_names.py)
    "01 \u5922\u706f\u7c60.mp3",
    "Airi Suzuki & HOYO-MiX - \u3010\u9234\u6728\u611b\u7406\u3011\u539f\u795e\u30b9\u30ab\u30fc\u30af \u30a4\u30e1\u30fc\u30b8\u30bd\u30f3\u30b0\u300cStar Odyssey\u300dMV.mp3",
    "HOYO-MiX (C\u00e9cilia Cara) - La vaguelette Paroles - Easy Lyrics (IPA) English  Furina SQ  Genshin \u539f\u795e.mp3",
    "\u4eca\u65e5\u306f\u6674\u308c\uff1f.txt",
    "\u50f9\u683c\uff1c\u7a05\u8fbc\uff1e.txt",
    "\u5f15\u7528\uff02\u9f8d\uff3c\u864e\uff02.txt",
    "The Ramparts of Ice (\u6c37\u306e\u57ce\u58c1) Opening \u2013 Toumei_\u900f\u660e_Transparent [Instrumental] _ Novelbright (\u30ce\u30fc\u30d9\u30eb\u30d6\u30e9\u30a4\u30c8).mp3",

    // Korean (Cache/music/oct_2020, Cache FolderInfo theme tracks)
    "Every End of the Day (\ud558\ub8e8 \ub05d).mp3",
    "Gain (\uac00\uc778) - Bloom (\ud53c\uc5b4\ub098) Lyrics (HanRomEng).mp3",
    "3-11 Vylent, TSori feat. Spy Girls - What I Want to Say (\ud558\uace0 \uc2f6\uc740 \ub9d0) [The Golden Sun Rises].mp3",
    "06 Urban Night Cityscape (\ud55c\uc8fc\ubbfc \ud14c\ub9c8).mp3",

    // Mixed / game OST labels (Cache/music)
    "\u3010\u539f\u795e\u3011\u30ad\u30e3\u30e9\u30af\u30bf\u30fc\u30c8\u30ec\u30fc\u30e9\u30fc\u3000\u30b9\u30ab\u30fc\u30af\uff08CV_\u80fd\u767b\u9ebb\u7f8e\u5b50\uff09\u300c\u8352\u5ec3\u306e\u5730\u306e\u5618\u304d\u300d.mp3",
    "【\u30a6\u30de\u5a18】UNLIMITED IMPACT (\u30d1\u30fc\u30c8\u5206\u3051_Color Coded_Lyrics).mp3",
  ];

  for (const sample of samples) {
    assert.equal(
      module.filenameCompareKey(sample),
      pythonFilenameCompareKey(sample),
      `mismatch for ${JSON.stringify(sample)}`,
    );
  }
});

test("compareFilenameKeys uses lexicographic ordering on compare keys", async () => {
  const module = await importModuleFromWorkspace("dropbox_browser/assets/js/filename-compare-key.js");
  assert.ok(module.compareFilenameKeys("alpha", "bravo") < 0);
  assert.ok(module.compareFilenameKeys("bravo", "alpha") > 0);
  assert.equal(module.compareFilenameKeys("same", "same"), 0);
});
