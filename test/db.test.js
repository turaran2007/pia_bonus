// 実際の PostgreSQL を使うテスト。TEST_DATABASE_URL が無ければスキップする。
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db.js';

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : 'TEST_DATABASE_URL が未設定';
let db;

before(async () => {
  if (skip) return;
  db = createDb(url);
  await db.pool.query('DROP TABLE IF EXISTS guild_settings, stats, daily_stats');
  await db.init();
  await db.init(); // 2回呼んでも壊れない
});

after(async () => {
  if (db) await db.close();
});

test('記録と集計', { skip }, async () => {
  await db.recordAward('g1', 'alice', ['bob', 'carol', 'bob', 'alice'], '2026-11-10');
  await db.recordAward('g1', 'alice', ['bob'], '2026-11-11');
  await db.recordAward('g1', 'bob', ['alice'], '2026-11-12');
  await db.recordAward('g2', 'zed', ['alice'], '2026-11-12');

  const total = await db.getTotalStats('g1');
  const byUser = Object.fromEntries(total.map(r => [r.userId, r]));
  assert.deepEqual(byUser.alice, { userId: 'alice', sent: 2, received: 1 });
  assert.deepEqual(byUser.bob, { userId: 'bob', sent: 1, received: 2 });
  assert.deepEqual(byUser.carol, { userId: 'carol', sent: 0, received: 1 });

  const week = await db.getStatsBetween('g1', '2026-11-11', '2026-11-12');
  const w = Object.fromEntries(week.map(r => [r.userId, r]));
  assert.deepEqual(w.alice, { userId: 'alice', sent: 1, received: 1 });
  assert.deepEqual(w.bob, { userId: 'bob', sent: 1, received: 1 });
  assert.equal(w.carol, undefined);
});

test('累計リセットは週次データに影響しない', { skip }, async () => {
  await db.resetTotalStats('g1');
  assert.deepEqual(await db.getTotalStats('g1'), []);
  assert.equal((await db.getStatsBetween('g1', '2026-11-01', '2026-11-30')).length, 3);
  assert.equal((await db.getTotalStats('g2')).length, 2);
});

test('週次リセットは指定日以降の日別データだけ消す', { skip }, async () => {
  await db.deleteDailyStatsSince('g1', '2026-11-11');
  const rows = await db.getStatsBetween('g1', '2026-11-01', '2026-11-30');
  assert.deepEqual(rows.map(r => r.userId).sort(), ['alice', 'bob', 'carol']);
  assert.equal(rows.find(r => r.userId === 'alice').sent, 1);
  assert.equal((await db.getStatsBetween('g2', '2026-11-01', '2026-11-30')).length, 2);
});

test('設定の部分更新とリセット', { skip }, async () => {
  assert.equal(await db.getSettings('g1'), null);
  await db.updateSettings('g1', { emoji: '👍' });
  await db.updateSettings('g1', { sendDay: '月曜日', sendTime: '09:00', bogus: 'x' });
  await db.updateSettings('g1', { channelId: 'c1' });
  const s = await db.getSettings('g1');
  assert.deepEqual(s, {
    guildId: 'g1', channelId: 'c1', sendDay: '月曜日', sendTime: '09:00', emoji: '👍', lastSentDate: null
  });
  assert.equal((await db.getAllSettings()).length, 1);
  await db.resetSettings('g1');
  assert.equal(await db.getSettings('g1'), null);
});

test('同じ日の二重投稿を防ぐ', { skip }, async () => {
  await db.updateSettings('g3', { channelId: 'c' });
  assert.equal(await db.claimDailySend('g3', '2026-11-16'), true);
  assert.equal(await db.claimDailySend('g3', '2026-11-16'), false);
  assert.equal(await db.claimDailySend('g3', '2026-11-23'), true);
  assert.equal((await db.getSettings('g3')).lastSentDate, '2026-11-23');
});
