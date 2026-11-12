import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankingLines, splitMessage } from '../src/format.js';

test('短い文章は分割しない', () => {
  assert.deepEqual(splitMessage('a\nb'), ['a\nb']);
});

test('行単位で制限内に分割する', () => {
  const lines = Array.from({ length: 300 }, (_, i) => `${i + 1}位: ユーザー${i} さん　（🔸 ✕ ${i}）`);
  const chunks = splitMessage(lines.join('\n'));
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 2000);
  assert.equal(chunks.join('\n'), lines.join('\n'));
});

test('制限を超える1行は途中で切る', () => {
  const chunks = splitMessage('x'.repeat(4500));
  assert.deepEqual(chunks.map(c => c.length), [2000, 2000, 500]);
});

test('ランキングは多い順で、0件の人は除く', () => {
  const rows = [
    { userId: 'a', sent: 1, received: 0 },
    { userId: 'b', sent: 5, received: 2 },
    { userId: 'c', sent: 0, received: 7 }
  ];
  const lines = rankingLines(rows, 'sent', id => id.toUpperCase(), ({ rank, name, count }) => `${rank}:${name}:${count}`);
  assert.deepEqual(lines, ['1:B:5', '2:A:1']);
});
