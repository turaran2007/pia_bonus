import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { applicationOwnerIds, canManage, parseUserIds } from '../src/permissions.js';

const OWNER = '123456789012345678';
const OTHER = '987654321098765432';
const admin = new PermissionsBitField(PermissionFlagsBits.Administrator);
const member = new PermissionsBitField(PermissionFlagsBits.SendMessages);

test('環境変数からユーザー ID を読む', () => {
  assert.deepEqual(parseUserIds(`${OWNER}, ${OTHER}`), [OWNER, OTHER]);
  assert.deepEqual(parseUserIds(` ${OWNER}\n`), [OWNER]);
  assert.deepEqual(parseUserIds('abc, 12'), []);
  assert.deepEqual(parseUserIds(undefined), []);
});

test('アプリケーションの所有者（個人・チーム）', () => {
  assert.deepEqual(applicationOwnerIds({ owner: { id: OWNER } }), [OWNER]);
  const members = new Map([[OWNER, { id: OWNER }], [OTHER, { id: OTHER }]]);
  assert.deepEqual(applicationOwnerIds({ owner: { id: 'team', members } }), [OWNER, OTHER]);
  assert.deepEqual(applicationOwnerIds({ owner: null }), []);
});

test('サーバーの管理者か Bot の管理者なら操作できる', () => {
  const owners = new Set([OWNER]);
  assert.equal(canManage({ userId: OWNER, memberPermissions: member }, owners), true);
  assert.equal(canManage({ userId: OWNER, memberPermissions: null }, owners), true);
  assert.equal(canManage({ userId: OTHER, memberPermissions: admin }, owners), true);
  assert.equal(canManage({ userId: OTHER, memberPermissions: member }, owners), false);
  assert.equal(canManage({ userId: OTHER, memberPermissions: null }, owners), false);
});
