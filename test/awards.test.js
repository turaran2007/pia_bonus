import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectReceivers, isExcludedChannel } from '../src/awards.js';

const member = (id, bot = false) => ({ id, user: { bot } });
const user = (id, bot = false) => ({ id, bot });

const base = {
  senderId: 'me',
  botUserId: 'pia',
  users: [user('a'), user('me'), user('somebot', true)],
  roleMembers: [[member('r1'), member('a'), member('rolebot', true)]],
  everyone: true,
  allMembers: [member('a'), member('r1'), member('x'), member('me'), member('pia', true)]
};

test('すべて数える設定', () => {
  const ids = collectReceivers({ ...base, options: { countRoles: true, countEveryone: true } });
  assert.deepEqual(ids.sort(), ['a', 'r1', 'x']);
});

test('ロールと @everyone を数えない設定', () => {
  assert.deepEqual(collectReceivers({ ...base, options: { countRoles: false, countEveryone: false } }), ['a']);
  assert.deepEqual(collectReceivers({ ...base, options: { countRoles: true, countEveryone: false } }).sort(), ['a', 'r1']);
  assert.deepEqual(collectReceivers({ ...base, options: { countRoles: false, countEveryone: true } }).sort(), ['a', 'r1', 'x']);
});

test('@everyone が無ければ全員には付かない', () => {
  const ids = collectReceivers({ ...base, everyone: false, options: { countRoles: false, countEveryone: true } });
  assert.deepEqual(ids, ['a']);
});

test('除外チャンネル', () => {
  const text = { id: 'ch', parentId: 'cat' };
  const thread = { id: 'th', parentId: 'ch', parent: text };
  assert.equal(isExcludedChannel(text, []), false);
  assert.equal(isExcludedChannel(text, ['other']), false);
  assert.equal(isExcludedChannel(text, ['ch']), true);
  assert.equal(isExcludedChannel(text, ['cat']), true);
  assert.equal(isExcludedChannel(thread, ['ch']), true);
  assert.equal(isExcludedChannel(thread, ['cat']), true);
  assert.equal(isExcludedChannel(thread, ['th']), true);
  assert.equal(isExcludedChannel({ id: 'solo', parentId: null }, ['cat']), false);
});
