export function mergeClosedIntegerRanges(ranges) {
  if (!Array.isArray(ranges)) throw new TypeError('Expected an array of ranges');
  const sorted = [];
  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i];
    if (!Array.isArray(range) || range.length !== 2) {
      throw new TypeError('Expected a pair of safe integers');
    }
    const start = range[0];
    const end = range[1];
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) {
      throw new TypeError('Invalid range');
    }
    sorted.push([start, end]);
  }
  sorted.sort((a, b) => a[0] - b[0]);
  const result = [];
  for (const [start, end] of sorted) {
    const last = result.at(-1);
    if (last && (start <= last[1] || start - last[1] === 1)) {
      last[1] = Math.max(last[1], end);
    } else {
      result.push([start, end]);
    }
  }
  return result;
}
