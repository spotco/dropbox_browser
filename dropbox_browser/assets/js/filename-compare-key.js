function unicodeCasefold(text) {
  var normalized = String(text || '').normalize('NFKC');
  var folded = normalized.replace(/\u00DF/g, 'ss');
  return folded.toLocaleLowerCase('en');
}

export function filenameCompareKey(name) {
  return unicodeCasefold(name);
}

export function compareFilenameKeys(left, right) {
  var leftKey = String(left || '');
  var rightKey = String(right || '');
  if (leftKey < rightKey) return -1;
  if (leftKey > rightKey) return 1;
  return 0;
}