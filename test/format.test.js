import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankingLines } from '../src/format.js';

test('ランキングは多い順で、0件の人は除く', () => {
  const rows = [
    { userId: 'a', sent: 1, received: 0 },
    { userId: 'b', sent: 5, received: 2 },
    { userId: 'c', sent: 0, received: 7 }
  ];
  const lines = rankingLines(rows, 'sent', id => id.toUpperCase(), ({ rank, name, count }) => `${rank}:${name}:${count}`);
  assert.deepEqual(lines, ['1:B:5', '2:A:1']);
});

test('同じ回数は同じ順位', () => {
  const rows = [
    { userId: 'a', sent: 3, received: 0 },
    { userId: 'b', sent: 5, received: 0 },
    { userId: 'c', sent: 3, received: 0 },
    { userId: 'd', sent: 1, received: 0 }
  ];
  const lines = rankingLines(rows, 'sent', id => id, ({ rank, name, count }) => `${rank}:${name}:${count}`);
  assert.deepEqual(lines, ['1:b:5', '2:a:3', '2:c:3', '4:d:1']);
});
