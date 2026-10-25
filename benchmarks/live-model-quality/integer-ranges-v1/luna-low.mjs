export function mergeClosedIntegerRanges(ranges) {
  if (!Array.isArray(ranges)) throw new TypeError('ranges must be an array');

  const sorted = ranges.map((range) => {
    if (
      !Array.isArray(range) ||
      range.length !== 2 ||
      !Number.isSafeInteger(range[0]) ||
      !Number.isSafeInteger(range[1]) ||
      range[0] > range[1]
    ) {
      throw new TypeError('invalid range');
    }
    return [range[0], range[1]];
  });

  sorted.sort((a, b) => a[0] - b[0]);
  const result = [];
  for (const [start, end] of sorted) {
    const last = result.at(-1);
    if (
      last &&
      (start <= last[1] ||
        (last[1] < Number.MAX_SAFE_INTEGER && start === last[1] + 1))
    ) {
      if (end > last[1]) last[1] = end;
    } else {
      result.push([start, end]);
    }
  }
  return result;
}
