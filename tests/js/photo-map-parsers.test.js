const path = require("node:path");
const {pathToFileURL} = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  return import(pathToFileURL(absolutePath).href);
}

function arrayBufferOf(value) {
  const bytes = Buffer.from(value);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function makeJpegWithGps() {
  const tiff = Buffer.alloc(220);
  tiff.write("II", 0, "ascii");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(2, 8);

  // IFD0: GPSInfo pointer and the original capture/listing date.
  tiff.writeUInt16LE(0x8825, 10);
  tiff.writeUInt16LE(4, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt32LE(50, 18);
  tiff.writeUInt16LE(0x0132, 22);
  tiff.writeUInt16LE(2, 24);
  tiff.writeUInt32LE(20, 26);
  tiff.writeUInt32LE(110, 30);
  tiff.write("2024:07:22 12:34:56\0", 110, "ascii");

  // GPS IFD: N 40°30'0", W 74°0'0".
  tiff.writeUInt16LE(4, 50);
  writeAsciiEntry(tiff, 52, 1, "N");
  writeRationalEntry(tiff, 64, 2, 130);
  writeAsciiEntry(tiff, 76, 3, "W");
  writeRationalEntry(tiff, 88, 4, 154);
  writeRational(tiff, 130, 40, 1);
  writeRational(tiff, 138, 30, 1);
  writeRational(tiff, 146, 0, 1);
  writeRational(tiff, 154, 74, 1);
  writeRational(tiff, 162, 0, 1);
  writeRational(tiff, 170, 0, 1);

  const exifPayload = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]);
  const segment = Buffer.alloc(4);
  segment[0] = 0xff;
  segment[1] = 0xe1;
  segment.writeUInt16BE(exifPayload.length + 2, 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), segment, exifPayload, Buffer.from([0xff, 0xd9])]);
}

function writeAsciiEntry(buffer, offset, tag, value) {
  buffer.writeUInt16LE(tag, offset);
  buffer.writeUInt16LE(2, offset + 2);
  buffer.writeUInt32LE(2, offset + 4);
  buffer.write(value + "\0", offset + 8, "ascii");
}

function writeRationalEntry(buffer, offset, tag, valueOffset) {
  buffer.writeUInt16LE(tag, offset);
  buffer.writeUInt16LE(5, offset + 2);
  buffer.writeUInt32LE(3, offset + 4);
  buffer.writeUInt32LE(valueOffset, offset + 8);
}

function writeRational(buffer, offset, numerator, denominator) {
  buffer.writeUInt32LE(numerator, offset);
  buffer.writeUInt32LE(denominator, offset + 4);
}

function quickTimeAtom(type, payload) {
  const typeBytes = Buffer.isBuffer(type) ? type : Buffer.from(type, "ascii");
  const atom = Buffer.concat([Buffer.alloc(4), typeBytes, Buffer.from(payload)]);
  atom.writeUInt32BE(atom.length, 0);
  return atom;
}

function makeQuickTimeWithLocation() {
  const text = Buffer.from("+40.1234-074.5678+000.0/2024-07-22T12:34:56Z", "ascii");
  const data = quickTimeAtom("data", Buffer.concat([Buffer.alloc(8), text]));
  const xyz = quickTimeAtom(Buffer.from([0xa9, 0x78, 0x79, 0x7a]), data);
  const ilst = quickTimeAtom("ilst", xyz);
  const meta = quickTimeAtom("meta", Buffer.concat([Buffer.alloc(4), ilst]));
  const udta = quickTimeAtom("udta", meta);
  return quickTimeAtom("moov", udta);
}

function makeResponse(bytes, start, size) {
  return {
    ok: true,
    status: 206,
    headers: {
      get(name) {
        return name.toLowerCase() === "content-range"
          ? `bytes ${start}-${start + bytes.length - 1}/${size}`
          : null;
      },
    },
    arrayBuffer: async () => arrayBufferOf(bytes),
  };
}

test("parseJpegExifGps extracts GPS coordinates and capture date", async () => {
  const parsers = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/parsers.js");
  const parsed = parsers.parseJpegExifGps(makeJpegWithGps());

  assert.equal(parsed.status, "located");
  assert.equal(parsed.latitude, 40.5);
  assert.equal(parsed.longitude, -74);
  assert.equal(parsed.captureDate, "2024:07:22 12:34:56");
  assert.equal(parsed.captureDateMs, Date.UTC(2024, 6, 22, 12, 34, 56));
});

test("JPEG parser reports no location and malformed metadata per input", async () => {
  const parsers = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/parsers.js");

  assert.deepEqual(parsers.parseJpegExifGps(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), {
    status: "no-location",
    reason: "no-exif",
  });
  assert.equal(parsers.parseJpegExifGps(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x0a, 0x45, 0x78])).status, "error");
});

test("QuickTime parser reads bounded location atom text and capture date", async () => {
  const parsers = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/parsers.js");
  const fixture = makeQuickTimeWithLocation();
  const parsed = parsers.parseQuickTimeLocation({ranges: [{bytes: fixture, offset: 0}]});

  assert.equal(parsed.status, "located");
  assert.equal(parsed.latitude, 40.1234);
  assert.equal(parsed.longitude, -74.5678);
  assert.equal(parsed.captureDate, "2024-07-22T12:34:56Z");
  assert.equal(parsed.captureDateMs, Date.parse("2024-07-22T12:34:56Z"));
});

test("QuickTime parser prefers a structurally complete location over binary false matches", async () => {
  const parsers = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/parsers.js");
  const noisy = Buffer.from("-5-5+0/\0\0+38.8763-077.1918+110.587/2022-03-13T13:57:03-04:00", "ascii");
  const parsed = parsers.parseQuickTimeLocation({ranges: [{bytes: noisy, offset: 0}]});

  assert.equal(parsed.status, "located");
  assert.equal(parsed.latitude, 38.8763);
  assert.equal(parsed.longitude, -77.1918);
});

test("QuickTime parser ignores short binary matches and zero-coordinate placeholders", async () => {
  const parsers = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/parsers.js");

  assert.deepEqual(parsers.parseQuickTimeLocation({
    ranges: [{bytes: Buffer.from("+0-9+0/\\0random", "ascii")}],
  }), {
    status: "no-location",
    reason: "no-quicktime-location",
  });
  assert.deepEqual(parsers.parseQuickTimeLocation({
    ranges: [{bytes: Buffer.from("+00.0000+000.0000/", "ascii")}],
  }), {
    status: "no-location",
    reason: "no-quicktime-location",
  });
});

test("readPhotoMapItemMetadata uses bounded ranges and preserves item identity", async () => {
  const parsers = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/parsers.js");
  const config = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/config.js");
  const jpeg = makeJpegWithGps();
  const requests = [];
  const fetchImpl = async (_url, options) => {
    requests.push(options.headers.Range);
    return makeResponse(jpeg, 0, jpeg.length);
  };
  const result = await parsers.readPhotoMapItemMetadata({
    path: "Camera Uploads/IMG_0001.JPG",
    photoMapSourcePath: "Camera Uploads/IMG_0001.JPG",
    photoMapMediaKind: "photo",
    photoMapListingDateMs: 123,
    photoMapRecognition: {status: "supported", parser: "jpeg-exif-gps"},
  }, {fetchImpl});

  assert.deepEqual(requests, [`bytes=0-${config.PHOTO_MAP_JPEG_HEAD_RANGE_BYTES - 1}`]);
  assert.equal(result.path, "Camera Uploads/IMG_0001.JPG");
  assert.equal(result.sourcePath, "Camera Uploads/IMG_0001.JPG");
  assert.equal(result.listingDateMs, 123);
  assert.equal(result.status, "located");
  assert.equal(result.longitude, -74);
});

test("QuickTime metadata reads bounded head and suffix ranges", async () => {
  const parsers = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/parsers.js");
  const config = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/config.js");
  const fixture = makeQuickTimeWithLocation();
  const requests = [];
  const fetchImpl = async (_url, options) => {
    requests.push(options.headers.Range);
    return makeResponse(fixture, 0, fixture.length);
  };
  const result = await parsers.readPhotoMapItemMetadata({
    path: "Camera Uploads/IMG_0002.MOV",
    photoMapRecognition: {status: "supported", parser: "quicktime-location"},
  }, {fetchImpl});

  assert.deepEqual(requests.sort(), [
    `bytes=0-${config.PHOTO_MAP_QUICKTIME_HEAD_RANGE_BYTES - 1}`,
    `bytes=-${config.PHOTO_MAP_QUICKTIME_TAIL_RANGE_BYTES}`,
  ].sort());
  assert.equal(result.status, "located");
  assert.equal(result.latitude, 40.1234);
  assert.equal(result.longitude, -74.5678);
});

test("metadata range failures become per-item errors and unsupported items do not fetch", async () => {
  const parsers = await importModuleFromWorkspace("dropbox_browser/assets/js/photo-map/parsers.js");
  let fetchCount = 0;
  const failed = await parsers.readPhotoMapItemMetadata({
    path: "Camera Uploads/broken.jpg",
    photoMapRecognition: {status: "supported", parser: "jpeg-exif-gps"},
  }, {fetchImpl: async () => {
    fetchCount += 1;
    throw new Error("network failure");
  }});
  const unsupported = await parsers.readPhotoMapItemMetadata({
    path: "Camera Uploads/photo.heic",
    photoMapRecognition: {status: "unsupported"},
  }, {fetchImpl: async () => {
    fetchCount += 1;
    throw new Error("must not fetch");
  }});

  assert.equal(failed.status, "error");
  assert.equal(failed.reason, "range-or-parser-failure");
  assert.equal(unsupported.status, "unsupported");
  assert.equal(fetchCount, 1);
});
