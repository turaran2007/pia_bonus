import { test } from 'node:test';
import assert from 'node:assert/strict';
import moment from 'moment-timezone';
import { DEFAULT_SETTINGS } from '../src/db.js';
import { TIMEZONE } from '../src/time.js';
import {
  channelModal, emojiModal, excludedModal, helpView, limitModal, meView, mentionsModal, noticeView,
  rankLine, rankingMessages, recordReplyView, resetView, scheduleModal, settingsView, weeklyIntroView
} from '../src/views.js';

const now = moment.tz('2026-11-12 10:00', TIMEZONE); // 木曜

// Discord の Components V2 の上限：1 通あたり部品 40 個まで、文字数 合計 4000 文字まで
function measure(components) {
  let count = 0;
  let chars = 0;
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node.type === 'number') count++;
    if (node.type === 10 && typeof node.content === 'string') chars += node.content.length;
    for (const key of ['components', 'component', 'accessory']) walk(node[key]);
  };
  walk(components.map(c => c.toJSON()));
  return { count, chars };
}

function assertWithinLimits(components) {
  const { count, chars } = measure(components);
  assert.ok(count <= 40, `部品が多すぎます: ${count}`);
  assert.ok(chars <= 4000, `文字数が多すぎます: ${chars}`);
}

const fullSettings = {
  ...DEFAULT_SETTINGS,
  guildId: 'g',
  channelId: '111',
  sendDay: '月曜日',
  sendTime: '09:00',
  emoji: '<:coin:123>',
  dailyPairLimit: 3,
  countRoles: false,
  excludedChannelIds: Array.from({ length: 25 }, (_, i) => String(1000000000000000000n + BigInt(i)))
};

test('設定パネル（編集用・閲覧用・未設定）', () => {
  for (const settings of [fullSettings, { ...DEFAULT_SETTINGS, guildId: 'g' }]) {
    for (const editable of [true, false]) {
      const view = settingsView(settings, now, { editable, status: { kind: 'success', message: '更新しました' } });
      assertWithinLimits(view);
    }
  }
  const json = JSON.stringify(settingsView(fullSettings, now, { editable: true }).map(c => c.toJSON()));
  for (const id of ['set_channel', 'set_schedule', 'set_emoji', 'set_limit', 'set_mentions', 'set_excluded', 'reset_stats', 'reset_settings']) {
    assert.ok(json.includes(`"${id}"`), id);
  }
  assert.ok(json.includes('次回: 11月16日(月) 09:00'));
  assert.ok(json.includes('3回まで'));
  assert.ok(json.includes('ユーザー、@everyone / @here'));

  const readOnly = JSON.stringify(settingsView(fullSettings, now).map(c => c.toJSON()));
  assert.ok(!readOnly.includes('set_channel'));
});

test('リセットの確認画面', () => {
  for (const step of ['choose', 'total', 'weekly', 'settings']) assertWithinLimits(resetView(step));
});

test('モーダルが Discord の制約を満たす', () => {
  for (const settings of [fullSettings, { ...DEFAULT_SETTINGS, guildId: 'g' }]) {
    for (const make of [channelModal, scheduleModal, emojiModal, limitModal, mentionsModal, excludedModal]) {
      const json = make(settings).toJSON();
      assert.ok(json.title.length <= 45);
      assert.ok(json.components.length >= 1 && json.components.length <= 5);
    }
  }
  const schedule = JSON.stringify(scheduleModal(fullSettings).toJSON());
  assert.ok(schedule.includes('"value":"月曜日","default":true'));
});

test('ランキングは長いと複数のメッセージに分かれる', () => {
  const lines = Array.from({ length: 400 }, (_, i) =>
    rankLine({ rank: i + 1, name: `**とても長い表示名のメンバー${i}**`, count: 400 - i }, '<:coin:123456789012345678>'));
  const pages = rankingMessages({
    title: '累計ランキング',
    subtitle: '集計期間: 11月6日～11月12日',
    sections: [{ heading: '📤 giveAward', lines }, { heading: '📥 receiveAward', lines }]
  });
  assert.ok(pages.length > 1);
  for (const page of pages) assertWithinLimits(page);

  const all = JSON.stringify(pages.map(p => p.map(c => c.toJSON())));
  for (const line of lines) assert.ok(all.includes(JSON.stringify(line).slice(1, -1)));
  assert.ok(all.includes(`（1/${pages.length}）`));
});

test('ランキングが短ければ 1 通、空の部門は「まだ記録がありません」', () => {
  const pages = rankingMessages({ title: 't', sections: [{ heading: 'a', lines: ['x'] }, { heading: 'b', lines: [] }] });
  assert.equal(pages.length, 1);
  assert.ok(JSON.stringify(pages[0][0].toJSON()).includes('まだ記録がありません'));
});

test('メダル表示', () => {
  assert.ok(rankLine({ rank: 1, name: 'A', count: 3 }, '👍').startsWith('🥇'));
  assert.ok(rankLine({ rank: 3, name: 'A', count: 3 }, '👍').startsWith('🥉'));
  assert.ok(rankLine({ rank: 4, name: 'A', count: 3 }, '👍').startsWith('` 4.`'));
});

test('その他の画面', () => {
  assertWithinLimits(helpView());
  assertWithinLimits(noticeView('テスト', 'error'));
  assertWithinLimits(weeklyIntroView({ start: now.clone().subtract(7, 'days'), end: now.clone().subtract(1, 'day') }));
  assertWithinLimits(recordReplyView({ senderId: '1', accepted: 2, limited: 1, limit: 3 }));
  assertWithinLimits(meView({
    name: 'A', emoji: '👍',
    periods: [{ label: '累計', sent: 1, received: 2 }],
    sentTo: [{ name: 'B', count: 3 }], receivedFrom: []
  }));
  const text = JSON.stringify(recordReplyView({ senderId: '1', accepted: 0, limited: 2, limit: 3 }).map(c => c.toJSON()));
  assert.ok(text.includes('記録しませんでした'));
});
