// Uneven vertical lanes, packed from the shortest column. Fixed weights keep
// resizing and searching stable instead of shuffling images on every render.
export function masonryLayout(items, available, target = 205) {
  if (!(available > 0) || !items.length) return { tiles: [], height: 0 };
  const gap = 2;
  const count = Math.max(1, Math.min(items.length, Math.max(2, Math.round(available / target))));
  const pattern = [0.83, 1.18, 0.94, 1.27, 0.78, 1.07, 0.9];
  const weights = Array.from({ length: count }, (_, i) => pattern[i % pattern.length]);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let left = 0;
  const columns = weights.map((weight, index) => {
    const right = index === count - 1 ? available : left + (available - gap * (count - 1)) * weight / totalWeight;
    const column = { left, width: right - left, bottom: 0 };
    left = right + gap;
    return column;
  });
  const tiles = items.map((item, index) => {
    const column = columns.reduce((lowest, candidate) => candidate.bottom < lowest.bottom ? candidate : lowest);
    const height = column.width / item.ratio;
    const tile = { index, left: column.left, top: column.bottom, width: column.width, height };
    column.bottom += height + gap;
    return tile;
  });
  return { tiles, height: Math.max(...columns.map(column => column.bottom)) - gap };
}
