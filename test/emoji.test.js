import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containsEmoji, normalizeEmoji, parseEmojiSetting } from '../src/emoji.js';

test('設定値から名前と標準絵文字を取り出す', () => {
  for (const value of ['🪙', ':coin:', ':COIN:', 'coin']) {
    const t = parseEmojiSetting(value);
    assert.ok(t.names.has('coin'), value);
    assert.ok(t.emojis.has('🪙'), value);
    assert.equal(t.label, ':coin:');
  }
  assert.equal(parseEmojiSetting(''), null);
  assert.equal(parseEmojiSetting(null), null);
});

test('サーバー独自の絵文字は、その絵文字（同じ ID）だけに一致する', () => {
  const t = parseEmojiSetting('<:coin:999>');
  assert.equal(t.customId, '999');
  assert.equal(t.label, ':coin:');
  for (const setting of ['<:coin:999>', '<a:coin:999>']) {
    assert.equal(containsEmoji('<@1> <:coin:999> ありがとう', setting), true, setting);
    assert.equal(containsEmoji('<@1> <a:coin:999>', setting), true, setting);
    assert.equal(containsEmoji('<@1> 🪙', setting), false, setting);
    assert.equal(containsEmoji('<@1> :coin:', setting), false, setting);
    assert.equal(containsEmoji('<@1> <:coin:123>', setting), false, setting);
    assert.equal(containsEmoji('<@1> <:other:999>', setting), true, setting); // 名前を変えても同じ絵文字
  }
});

test('標準の絵文字は、名前が同じ絵文字ならどれでも一致する', () => {
  for (const setting of ['🪙', ':coin:', 'coin']) {
    assert.equal(containsEmoji('<@1> 🪙 ありがとう', setting), true, setting);
    assert.equal(containsEmoji('<@1> <:coin:123>', setting), true, setting);
    assert.equal(containsEmoji('<@1> <a:coin:123>', setting), true, setting);
    assert.equal(containsEmoji('<@1> :coin:', setting), true, setting);
    assert.equal(containsEmoji('<@1> 👍', setting), false, setting);
    assert.equal(containsEmoji('<@1> <:coins:123>', setting), false, setting);
  }
});

test('異体字セレクタや肌の色の違いは同じ絵文字として扱う', () => {
  assert.equal(containsEmoji('❤', '❤️'), true);
  assert.equal(containsEmoji('❤️', '❤'), true);
  assert.equal(containsEmoji('👍🏽', '👍'), true);
  assert.equal(containsEmoji('👍', ':thumbsup:'), true);
  assert.equal(containsEmoji('👍', ':+1:'), true);
  assert.equal(normalizeEmoji('👍🏽'), '👍');
});

test('対応表に無い独自の文字列は、そのまま含まれているかで判定する', () => {
  assert.equal(containsEmoji('<@1> ★ありがとう★', '★'), true);
  assert.equal(containsEmoji('<@1> ありがとう', '★'), false);
});
