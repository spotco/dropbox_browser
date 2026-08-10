const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  const source = await fs.readFile(absolutePath, "utf8");
  return import(`data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`);
}

function u32le(value) {
  return Buffer.from([value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff]);
}

function u32be(value) {
  return Buffer.from([(value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
}

function u24be(value) {
  return Buffer.from([(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
}

function vorbisComments(entries) {
  const encoded = entries.map((entry) => Buffer.from(entry, "utf8"));
  return Buffer.concat([
    u32le(0),
    u32le(encoded.length),
    ...encoded.flatMap((entry) => [u32le(entry.length), entry]),
  ]);
}

function pictureBlock(imageBytes) {
  const mime = Buffer.from("image/png", "ascii");
  return Buffer.concat([
    u32be(3),
    u32be(mime.length),
    mime,
    u32be(0),
    Buffer.alloc(16),
    u32be(imageBytes.length),
    imageBytes,
  ]);
}

test("Ogg Vorbis and Opus comments expose title and artist", async () => {
  const tags = await importModuleFromWorkspace("dropbox_browser/assets/js/music/audio-tags.js");
  const coverart = await importModuleFromWorkspace("dropbox_browser/assets/js/music/coverart.js");
  const comments = vorbisComments(["TITLE=Fixture Song", "ARTIST=Fixture Artist"]);
  const vorbis = Buffer.concat([Buffer.from([0x03]), Buffer.from("vorbis", "ascii"), comments]);
  const opus = Buffer.concat([Buffer.from("OpusTags", "ascii"), comments]);

  assert.deepEqual(tags.parseOggOrFlacMetadata(".ogg", [new Uint8Array(vorbis)]), {
    title: "Fixture Song",
    artist: "Fixture Artist",
    art: null,
  });
  assert.deepEqual(tags.parseOggOrFlacMetadata(".opus", [new Uint8Array(opus)]), {
    title: "Fixture Song",
    artist: "Fixture Artist",
    art: null,
  });

  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const artComments = vorbisComments([
    `METADATA_BLOCK_PICTURE=${Buffer.from(pictureBlock(imageBytes)).toString("base64")}`,
  ]);
  const vorbisWithArt = Buffer.concat([Buffer.from([0x03]), Buffer.from("vorbis", "ascii"), artComments]);
  const extracted = coverart.extractEmbeddedArtFromBuffers(".ogg", [new Uint8Array(vorbisWithArt)]);
  assert.equal(extracted.mime, "image/png");
  assert.deepEqual(Array.from(extracted.bytes), Array.from(imageBytes));
});

test("FLAC Vorbis comments and METADATA_BLOCK_PICTURE are parsed", async () => {
  const tags = await importModuleFromWorkspace("dropbox_browser/assets/js/music/audio-tags.js");
  const coverart = await importModuleFromWorkspace("dropbox_browser/assets/js/music/coverart.js");
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const comments = vorbisComments([
    "TITLE=Lossless Fixture",
    "ARTIST=Lossless Artist",
    `METADATA_BLOCK_PICTURE=${Buffer.from(pictureBlock(imageBytes)).toString("base64")}`,
  ]);
  const flac = Buffer.concat([
    Buffer.from("fLaC", "ascii"),
    Buffer.from([0x84]),
    u24be(comments.length),
    comments,
  ]);
  const parsed = tags.parseOggOrFlacMetadata(".flac", [new Uint8Array(flac)]);

  assert.equal(parsed.title, "Lossless Fixture");
  assert.equal(parsed.artist, "Lossless Artist");
  assert.equal(parsed.art.mime, "image/png");
  assert.deepEqual(Array.from(parsed.art.bytes), Array.from(imageBytes));
  assert.equal(tags.flacMetadataEndOffset(new Uint8Array(flac)), flac.length);

  const extracted = coverart.extractEmbeddedArtFromBuffers(".flac", [new Uint8Array(flac)]);
  assert.equal(extracted.mime, "image/png");
  assert.deepEqual(Array.from(extracted.bytes), Array.from(imageBytes));
});
