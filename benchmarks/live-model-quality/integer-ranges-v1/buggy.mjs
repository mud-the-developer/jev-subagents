export function mergeClosedIntegerRanges(ranges) {
  const sorted = ranges.sort((a, b) => a[0] - b[0]);
  const result = [];
  for (const [start, end] of sorted) {
    const last = result.at(-1);
    if (last && start <= last[1]) last[1] = end;
    else result.push([start, end]);
  }
  return result;
}
