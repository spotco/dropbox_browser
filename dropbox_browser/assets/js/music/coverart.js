function decodeLatin1(bytes) {
  var chars = [];
  bytes.forEach(function (value) {
    chars.push(String.fromCharCode(value));
  });
  return chars.join('').replace(/\u0000+$/g, '');
}

function synchsafeToInt(bytes, offset) {
  return ((bytes[offset] & 0x7F) << 21) |
    ((bytes[offset + 1] & 0x7F) << 14) |
    ((bytes[offset + 2] & 0x7F) << 7) |
    (bytes[offset + 3] & 0x7F);
}

function readAtomSize(bytes, offset) {
  return ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
}

function concatBytes(buffers) {
  var totalLength = 0;
  var offset = 0;
  var result;
  buffers.forEach(function (bytes) {
    totalLength += bytes.length;
  });
  result = new Uint8Array(totalLength);
  buffers.forEach(function (bytes) {
    result.set(bytes, offset);
    offset += bytes.length;
  });
  return result;
}

export function supportedArtMime(mime) {
  return mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/gif' || mime === 'image/webp';
}

export function parseId3TagByteLength(bytes) {
  if (!bytes || bytes.length < 10 || decodeLatin1(bytes.slice(0, 3)) !== 'ID3') return 0;
  return 10 + synchsafeToInt(bytes, 6);
}

function parseApic(bytes) {
  var encoding;
  var index = 1;
  var mimeEnd;
  var descriptionEnd;
  var artBytes;
  if (!bytes || bytes.length < 4) return null;
  encoding = bytes[0];
  mimeEnd = bytes.indexOf(0, index);
  if (mimeEnd === -1) return null;
  index = mimeEnd + 1;
  index += 1;
  if (encoding === 0 || encoding === 3) {
    descriptionEnd = bytes.indexOf(0, index);
    if (descriptionEnd === -1) descriptionEnd = index;
    index = descriptionEnd + 1;
  } else {
    while (index + 1 < bytes.length) {
      if (bytes[index] === 0 && bytes[index + 1] === 0) {
        index += 2;
        break;
      }
      index += 2;
    }
  }
  artBytes = bytes.slice(index);
  if (!artBytes.length) return null;
  return {
    mime: decodeLatin1(bytes.slice(1, mimeEnd)).trim(),
    bytes: artBytes
  };
}

export function extractId3ArtFromTagBytes(bytes) {
  var version;
  var tagSize;
  var offset;
  if (!bytes || bytes.length < 10 || decodeLatin1(bytes.slice(0, 3)) !== 'ID3') return null;
  version = bytes[3];
  tagSize = synchsafeToInt(bytes, 6);
  offset = 10;
  while (offset + 10 <= bytes.length && offset < 10 + tagSize) {
    var frameId = decodeLatin1(bytes.slice(offset, offset + 4));
    var frameSize = version === 4
      ? synchsafeToInt(bytes, offset + 4)
      : ((bytes[offset + 4] << 24) | (bytes[offset + 5] << 16) | (bytes[offset + 6] << 8) | bytes[offset + 7]);
    var frameDataStart = offset + 10;
    var frameDataEnd = frameDataStart + frameSize;
    if (!frameId.replace(/\u0000/g, '').trim() || frameSize <= 0 || frameDataEnd > bytes.length) break;
    if (frameId === 'APIC') return parseApic(bytes.slice(frameDataStart, frameDataEnd));
    offset = frameDataEnd;
  }
  return null;
}

function parseMp4CoverData(bytes, offset, end) {
  var innerOffset = offset;
  while (innerOffset + 8 <= end) {
    var atomSize = readAtomSize(bytes, innerOffset);
    var atomType = decodeLatin1(bytes.slice(innerOffset + 4, innerOffset + 8));
    var atomEnd = innerOffset + atomSize;
    if (atomSize < 8 || atomEnd > end) break;
    if (atomType === 'data' && atomSize >= 16) {
      var dataType = bytes[innerOffset + 11];
      return {
        mime: dataType === 13 ? 'image/jpeg' : dataType === 14 ? 'image/png' : '',
        bytes: bytes.slice(innerOffset + 16, atomEnd)
      };
    }
    innerOffset = atomEnd;
  }
  return null;
}

export function extractMp4ArtFromBytes(bytes) {
  var stack = [{offset: 0, end: bytes.length}];
  while (stack.length) {
    var frame = stack.pop();
    var offset = frame.offset;
    while (offset + 8 <= frame.end) {
      var atomSize = readAtomSize(bytes, offset);
      var atomType = decodeLatin1(bytes.slice(offset + 4, offset + 8));
      var atomEnd = offset + atomSize;
      if (atomSize === 1 || atomSize < 8 || atomEnd > frame.end) break;
      if (atomType === 'meta') stack.push({offset: offset + 12, end: atomEnd});
      else if (atomType === 'moov' || atomType === 'udta' || atomType === 'ilst') stack.push({offset: offset + 8, end: atomEnd});
      else if (atomType === 'covr') return parseMp4CoverData(bytes, offset + 8, atomEnd);
      offset = atomEnd;
    }
  }
  return null;
}

export function extractEmbeddedArtFromBuffers(extension, buffers) {
  var ext = String(extension || '').toLowerCase();
  var art = null;
  if (!buffers || !buffers.length) return null;
  buffers.some(function (bytes) {
    if (ext === '.mp3') art = extractId3ArtFromTagBytes(bytes);
    else if (ext === '.m4a' || ext === '.aac' || ext === '.mp4') art = extractMp4ArtFromBytes(bytes);
    return !!art;
  });
  return art;
}

export async function resolveCoverArtFromMetadata(options) {
  var extension = String((options && options.extension) || '').toLowerCase();
  var initialBuffers = (options && options.buffers) || [];
  var probeSize = (options && options.probeSize) || 0;
  var initialArt = extractEmbeddedArtFromBuffers(extension, initialBuffers);
  var firstChunk;
  var tagByteLength;
  var remainingTagBytes;

  if (initialArt) return initialArt;
  if (extension !== '.mp3' || !initialBuffers.length || !probeSize) return null;

  firstChunk = initialBuffers[0];
  tagByteLength = parseId3TagByteLength(firstChunk);
  if (!tagByteLength || tagByteLength <= firstChunk.length) return null;

  remainingTagBytes = await options.fetchRangeBytes(firstChunk.length, tagByteLength - 1);
  return extractId3ArtFromTagBytes(concatBytes([firstChunk, remainingTagBytes]));
}
