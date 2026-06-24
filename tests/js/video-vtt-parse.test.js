const path = require("node:path");
const {pathToFileURL} = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  return import(pathToFileURL(absolutePath).href);
}

test("parseVttTimestamp parses mm:ss and hh:mm:ss values", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/video/vtt-parse-core.js");

  assert.equal(mod.parseVttTimestamp("01:23.456"), 83.456);
  assert.equal(mod.parseVttTimestamp("01:02:03.500"), 3723.5);
});

test("parseWebVttCues extracts cue timing and text blocks", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/video/vtt-parse-core.js");
  const vtt = [
    "WEBVTT",
    "",
    "1",
    "00:00:01.000 --> 00:00:03.000",
    "<i>Hello</i>",
    "",
    "2",
    "00:00:04.000 --> 00:00:06.000",
    "World",
  ].join("\n");

  const cues = mod.parseWebVttCues(vtt);

  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 1);
  assert.equal(cues[0].end, 3);
  assert.equal(cues[0].rawText, "<i>Hello</i>");
  assert.equal(cues[1].rawText, "World");
});

test("rebaseWebVttText shifts cue timings by the session start offset", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/video/vtt-parse-core.js");
  const vtt = [
    "WEBVTT",
    "",
    "00:00:10.000 --> 00:00:12.000",
    "shifted",
  ].join("\n");

  const rebased = mod.rebaseWebVttText(vtt, 10);

  assert.match(rebased, /00:00\.000 --> 00:02\.000/);
  assert.match(rebased, /shifted/);
});

test("shiftVttTimingLine drops cues that end before zero after shift", async () => {
  const mod = await importModuleFromWorkspace("dropbox_browser/assets/js/video/vtt-parse-core.js");
  const match = ["", "00:00:01.000", "00:00:02.000", ""];

  assert.equal(mod.shiftVttTimingLine(match, 5), null);
});