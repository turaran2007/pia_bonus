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
  await db.pool.query('DROP TABLE IF EXISTS guild_settings, stats, daily_stats, pair_daily_stats');
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
    guildId: 'g1', channelId: 'c1', sendDay: '月曜日', sendTime: '09:00', emoji: '👍', lastSentDate: null,
    dailyPairLimit: 0, countRoles: true, countEveryone: true, excludedChannelIds: []
  });
  await db.updateSettings('g1', { dailyPairLimit: 3, countRoles: false, countEveryone: false, excludedChannelIds: ['x', 'y'] });
  const s2 = await db.getSettings('g1');
  assert.equal(s2.dailyPairLimit, 3);
  assert.equal(s2.countRoles, false);
  assert.equal(s2.countEveryone, false);
  assert.deepEqual(s2.excludedChannelIds, ['x', 'y']);
  assert.equal(s2.emoji, '👍');
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

test('同じ相手への1日の上限', { skip }, async () => {
  const day = '2026-11-20';
  assert.deepEqual(await db.recordAward('g4', 'a', ['b', 'c'], day, 2), { accepted: ['b', 'c'], limited: [] });
  assert.deepEqual(await db.recordAward('g4', 'a', ['b'], day, 2), { accepted: ['b'], limited: [] });
  // b は上限、c はまだ
  assert.deepEqual(await db.recordAward('g4', 'a', ['b', 'c'], day, 2), { accepted: ['c'], limited: ['b'] });
  // 全員上限なら何も記録しない（送った回数も増えない）
  assert.deepEqual(await db.recordAward('g4', 'a', ['b', 'c'], day, 2), { accepted: [], limited: ['b', 'c'] });
  // 翌日はまた数える
  assert.deepEqual(await db.recordAward('g4', 'a', ['b'], '2026-11-21', 2), { accepted: ['b'], limited: [] });
  // 0 は無制限
  for (let i = 0; i < 5; i++) await db.recordAward('g4', 'd', ['b'], day, 0);

  const total = Object.fromEntries((await db.getTotalStats('g4')).map(r => [r.userId, r]));
  assert.deepEqual(total.a, { userId: 'a', sent: 4, received: 0 });
  assert.deepEqual(total.b, { userId: 'b', sent: 0, received: 8 });
  assert.deepEqual(total.c, { userId: 'c', sent: 0, received: 2 });
});

test('個人の集計とよくやり取りする相手', { skip }, async () => {
  assert.deepEqual(await db.getUserTotal('g4', 'b'), { sent: 0, received: 8 });
  assert.deepEqual(await db.getUserTotal('g4', 'nobody'), { sent: 0, received: 0 });
  assert.deepEqual(await db.getUserStatsBetween('g4', 'a', '2026-11-20', '2026-11-20'), { sent: 3, received: 0 });
  assert.deepEqual(await db.getUserStatsBetween('g4', 'a', '2026-01-01', '2026-01-31'), { sent: 0, received: 0 });
  assert.deepEqual(await db.getTopPartners('g4', 'a', 'sent'), [{ userId: 'b', count: 3 }, { userId: 'c', count: 2 }]);
  assert.deepEqual(await db.getTopPartners('g4', 'b', 'received'), [{ userId: 'd', count: 5 }, { userId: 'a', count: 3 }]);
  assert.deepEqual(await db.getTopPartners('g4', 'b', 'received', 1), [{ userId: 'd', count: 5 }]);
});

test('累計リセットで相手別の集計と当日の上限カウントも消える', { skip }, async () => {
  await db.resetTotalStats('g4');
  assert.deepEqual(await db.getTopPartners('g4', 'a', 'sent'), []);
  assert.deepEqual(await db.recordAward('g4', 'a', ['b'], '2026-11-20', 2), { accepted: ['b'], limited: [] });
  // 日別データは残る
  assert.deepEqual(await db.getUserStatsBetween('g4', 'a', '2026-11-20', '2026-11-20'), { sent: 4, received: 0 });
});
