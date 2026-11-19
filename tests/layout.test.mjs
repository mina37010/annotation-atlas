import { test } from 'node:test';
import assert from 'node:assert/strict';
import { masonryLayout } from '../dist/layout.js';

test('uneven masonry preserves ratios without overlaps or horizontal overflow', () => {
  const items = Array.from({ length: 120 }, (_, i) => ({ ratio: [0.33, 1, 2.4, 0.7, 4.1, 1.5][i % 6] }));
  for (const width of [320, 390, 700, 1400, 2200]) {
    const { tiles, height } = masonryLayout(items, width);
    assert.equal(tiles.length, items.length);
    assert.ok(new Set(tiles.slice(0, 6).map(tile => tile.width)).size > 1);
    for (const tile of tiles) {
      assert.ok(tile.left >= 0 && tile.left + tile.width <= width + 1e-6);
      assert.ok(tile.top >= 0 && tile.top + tile.height <= height + 1e-6);
      assert.ok(Math.abs(tile.width / tile.height - items[tile.index].ratio) < 1e-6);
    }
    for (let i = 0; i < tiles.length; i++) {
      for (let j = i + 1; j < tiles.length; j++) {
        const a = tiles[i], b = tiles[j];
        assert.ok(a.left + a.width <= b.left + 1e-6 || b.left + b.width <= a.left + 1e-6 || a.top + a.height <= b.top + 1e-6 || b.top + b.height <= a.top + 1e-6);
      }
    }
    for (const left of new Set(tiles.map(tile => tile.left))) {
      const column = tiles.filter(tile => tile.left === left);
      for (let i = 1; i < column.length; i++) assert.ok(Math.abs(column[i].top - (column[i - 1].top + column[i - 1].height) - 2) < 1e-6);
    }
  }
});

test('layout is stable and can resize or clear search results', () => {
  const items = [{ ratio: 0.6 }, { ratio: 2 }, { ratio: 1.2 }];
  assert.deepEqual(masonryLayout(items, 1400), masonryLayout(items, 1400));
  assert.deepEqual(masonryLayout([], 1400), { tiles: [], height: 0 });
  assert.deepEqual(masonryLayout(items, 0), { tiles: [], height: 0 });
  assert.ok(masonryLayout(items, 390).tiles.every(tile => tile.width < 390));
});
