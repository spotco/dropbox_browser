function decodeUtf8(bytes) {
  return new TextDecoder('utf-8').decode(bytes).replace(/\u0000+$/g, '').trim();
}

function decodeLatin1(bytes) {
  var chars = [];
  bytes.forEach(function (value) {
    chars.push(String.fromCharCode(value));
  });
  return chars.join('').replace(/\u0000+$/g, '').trim();
}

function readUint32Le(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.length) return null;
  return ((bytes[offset]) |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)) >>> 0;
}

function readUint32Be(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.length) return null;
  return ((bytes[offset] << 24) >>> 0) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3];
}

function hasSignature(bytes, offset, signature) {
  if (offset < 0 || offset + signature.length > bytes.length) return false;
  for (var index = 0; index < signature.length; index += 1) {
    if (bytes[offset + index] !== signature[index]) return false;
  }
  return true;
}

function signatureBytes(text) {
  return Array.from(text).map(function (character) { return character.charCodeAt(0); });
}

function decodeBase64(value) {
  var binary;
  var bytes;
  if (!value || typeof atob !== 'function') return null;
  try {
    binary = atob(String(value).replace(/\s+/g, ''));
  } catch (_error) {
    return null;
  }
  bytes = new Uint8Array(binary.length);
  for (var index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function parsePictureBlock(bytes) {
  var offset = 0;
  var mimeLength;
  var descriptionLength;
  var dataLength;
  var mime;
  if (!bytes || bytes.length < 32) return null;
  if (readUint32Be(bytes, offset) === null) return null;
  offset += 4;
  mimeLength = readUint32Be(bytes, offset);
  if (mimeLength === null || offset + 4 + mimeLength > bytes.length) return null;
  offset += 4;
  mime = decodeLatin1(bytes.slice(offset, offset + mimeLength));
  offset += mimeLength;
  descriptionLength = readUint32Be(bytes, offset);
  if (descriptionLength === null || offset + 4 + descriptionLength > bytes.length) return null;
  offset += 4 + descriptionLength;
  if (offset + 16 > bytes.length) return null;
  offset += 16;
  dataLength = readUint32Be(bytes, offset);
  if (dataLength === null || offset + 4 + dataLength > bytes.length) return null;
  offset += 4;
  if (!dataLength) return null;
  return {
    mime: mime || 'application/octet-stream',
    bytes: bytes.slice(offset, offset + dataLength)
  };
}

function parseCommentPayload(bytes, offset) {
  var vendorLength;
  var commentCount;
  var comments = {};
  var legacyArt = null;
  var legacyArtMime = '';
  var parsedArt = null;
  var comment;
  var equals;
  var key;
  var value;
  if (offset < 0) return {title: '', artist: '', art: null};
  vendorLength = readUint32Le(bytes, offset);
  if (vendorLength === null || offset + 4 + vendorLength > bytes.length) return {title: '', artist: '', art: null};
  offset += 4 + vendorLength;
  commentCount = readUint32Le(bytes, offset);
  if (commentCount === null) return {title: '', artist: '', art: null};
  offset += 4;
  for (var index = 0; index < commentCount; index += 1) {
    var commentLength = readUint32Le(bytes, offset);
    if (commentLength === null || offset + 4 + commentLength > bytes.length) break;
    offset += 4;
    comment = decodeUtf8(bytes.slice(offset, offset + commentLength));
    offset += commentLength;
    equals = comment.indexOf('=');
    if (equals <= 0) continue;
    key = comment.slice(0, equals).toUpperCase();
    value = comment.slice(equals + 1).trim();
    comments[key] = value;
    if (key === 'METADATA_BLOCK_PICTURE' && !parsedArt) parsedArt = parsePictureBlock(decodeBase64(value));
    if (key === 'COVERART' && !legacyArt) legacyArt = decodeBase64(value);
    if (key === 'COVERARTMIME') legacyArtMime = value;
  }
  if (!parsedArt && legacyArt && legacyArt.length) {
    parsedArt = {mime: legacyArtMime || 'application/octet-stream', bytes: legacyArt};
  }
  return {
    title: comments.TITLE || '',
    artist: comments.ARTIST || comments.ALBUMARTIST || '',
    art: parsedArt
  };
}

function parseOggMetadata(bytes) {
  var result = {title: '', artist: '', art: null};
  var vorbisSignature = signatureBytes('\u0003vorbis');
  var opusSignature = signatureBytes('OpusTags');
  var next;
  var parsed;
  if (!bytes || !bytes.length) return result;
  for (var offset = 0; offset < bytes.length; offset += 1) {
    if (hasSignature(bytes, offset, vorbisSignature)) {
      next = offset + vorbisSignature.length;
    } else if (hasSignature(bytes, offset, opusSignature)) {
      next = offset + opusSignature.length;
    } else {
      continue;
    }
    parsed = parseCommentPayload(bytes, next);
    if (!result.title && parsed.title) result.title = parsed.title;
    if (!result.artist && parsed.artist) result.artist = parsed.artist;
    if (!result.art && parsed.art) result.art = parsed.art;
    if (result.title && result.artist && result.art) break;
  }
  return result;
}

export function flacMetadataEndOffset(bytes) {
  var offset = 4;
  if (!bytes || bytes.length < 4 || !hasSignature(bytes, 0, signatureBytes('fLaC'))) return null;
  while (offset + 4 <= bytes.length) {
    var blockHeader = bytes[offset];
    var blockLength = (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
    var blockEnd = offset + 4 + blockLength;
    if (blockEnd > bytes.length) return blockEnd;
    offset = blockEnd;
    if (blockHeader & 0x80) return offset;
  }
  return null;
}

function parseFlacMetadata(bytes) {
  var result = {title: '', artist: '', art: null};
  var offset = 4;
  if (!bytes || bytes.length < 4 || !hasSignature(bytes, 0, signatureBytes('fLaC'))) return result;
  while (offset + 4 <= bytes.length) {
    var blockHeader = bytes[offset];
    var blockType = blockHeader & 0x7F;
    var blockLength = (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
    var blockStart = offset + 4;
    var blockEnd = blockStart + blockLength;
    var parsed;
    if (blockEnd > bytes.length) break;
    if (blockType === 4) parsed = parseCommentPayload(bytes, blockStart);
    else if (blockType === 6) parsed = {title: '', artist: '', art: parsePictureBlock(bytes.slice(blockStart, blockEnd))};
    if (parsed) {
      if (!result.title && parsed.title) result.title = parsed.title;
      if (!result.artist && parsed.artist) result.artist = parsed.artist;
      if (!result.art && parsed.art) result.art = parsed.art;
    }
    offset = blockEnd;
    if (blockHeader & 0x80) break;
  }
  return result;
}

export function parseOggOrFlacMetadata(extension, buffers) {
  var ext = String(extension || '').toLowerCase();
  var bytes = buffers && buffers.length === 1 ? buffers[0] : concatBytes(buffers || []);
  if (ext === '.flac') return parseFlacMetadata(bytes);
  if (ext === '.ogg' || ext === '.oga' || ext === '.opus') return parseOggMetadata(bytes);
  return {title: '', artist: '', art: null};
}

export function extractOggOrFlacArtFromBuffers(extension, buffers) {
  return parseOggOrFlacMetadata(extension, buffers).art;
}

function concatBytes(buffers) {
  var totalLength = 0;
  var offset = 0;
  var result;
  (buffers || []).forEach(function (bytes) { totalLength += bytes.length; });
  result = new Uint8Array(totalLength);
  (buffers || []).forEach(function (bytes) {
    result.set(bytes, offset);
    offset += bytes.length;
  });
  return result;
}
