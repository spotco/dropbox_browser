const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  const source = await fs.readFile(absolutePath, "utf8");
  return import(`data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`);
}

function synchsafeBytes(value) {
  return Buffer.from([
    (value >> 21) & 0x7f,
    (value >> 14) & 0x7f,
    (value >> 7) & 0x7f,
    value & 0x7f,
  ]);
}

test("extractId3ArtFromTagBytes returns APIC artwork bytes and mime", async () => {
  const art = await importModuleFromWorkspace("dropbox_browser/assets/js/music/coverart.js");
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const apicPayload = Buffer.concat([
    Buffer.from([0x00]),
    Buffer.from("image/png\0", "latin1"),
    Buffer.from([0x03]),
    Buffer.from([0x00]),
    imageBytes,
  ]);
  const apicFrame = Buffer.concat([
    Buffer.from("APIC", "latin1"),
    Buffer.from([0x00, 0x00, 0x00, apicPayload.length]),
    Buffer.from([0x00, 0x00]),
    apicPayload,
  ]);
  const tag = Buffer.concat([
    Buffer.from("ID3\x03\x00\x00", "latin1"),
    synchsafeBytes(apicFrame.length),
    apicFrame,
  ]);

  const parsed = art.extractId3ArtFromTagBytes(new Uint8Array(tag));

  assert.equal(parsed.mime, "image/png");
  assert.deepEqual(Array.from(parsed.bytes), Array.from(imageBytes));
});

test("parseId3TagByteLength includes header bytes", async () => {
  const art = await importModuleFromWorkspace("dropbox_browser/assets/js/music/coverart.js");
  const tag = Buffer.concat([
    Buffer.from("ID3\x04\x00\x00", "latin1"),
    synchsafeBytes(32),
  ]);

  assert.equal(art.parseId3TagByteLength(new Uint8Array(tag)), 42);
});
