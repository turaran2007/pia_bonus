import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionFlagsBits as P, PermissionsBitField } from 'discord.js';
import { deleteBotMessages, resolveTargetChannels, splitByAge } from '../src/cleanup.js';
import { deleteConfirmView, deleteProgressView, deleteResultView } from '../src/views.js';

const BOT = '999';
const DAY = 24 * 60 * 60 * 1000;
const perms = (...flags) => new PermissionsBitField(flags);
const FULL = perms(P.ViewChannel, P.ReadMessageHistory, P.ManageMessages, P.ManageThreads);

// discord.js の Channel / Message に似せた最小限の模擬データ
function makeChannel({ id, type = ChannelType.GuildText, parentId = null, messages = [], permissions = FULL, log }) {
  let list = messages.map(m => ({ ...m, delete: async () => { log.single.push(m.id); list = list.filter(x => x.id !== m.id); } }));
  return {
    id, type, parentId,
    permissionsFor: () => permissions,
    messages: {
      fetch: async ({ limit, before }) => {
        const sorted = list.filter(m => !before || BigInt(m.id) < BigInt(before)).sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
        return new Map(sorted.slice(0, limit).map(m => [m.id, m]));
      }
    },
    bulkDelete: async ids => { log.bulk.push(...ids); list = list.filter(m => !ids.includes(m.id)); return new Map(ids.map(i => [i, true])); },
    threads: { fetchArchived: async () => ({ threads: new Map(), hasMore: false }) }
  };
}

function makeGuild(channels, activeThreads = []) {
  return {
    members: { me: {} },
    channels: {
      fetch: async () => new Map(channels.map(c => [c.id, c])),
      fetchActiveThreads: async () => ({ threads: new Map(activeThreads.map(t => [t.id, t])) })
    }
  };
}

const msg = (id, authorId, ageDays = 1) => ({ id: String(id), author: { id: authorId }, createdTimestamp: Date.now() - ageDays * DAY });

test('14 日より古いものは 1 件ずつ消す', () => {
  const { bulk, single } = splitByAge([msg(1, BOT, 1), msg(2, BOT, 13), msg(3, BOT, 15)]);
  assert.deepEqual(bulk.map(m => m.id), ['1', '2']);
  assert.deepEqual(single.map(m => m.id), ['3']);
});

test('チャンネルの選択：空ならサーバー全体、カテゴリーは中のチャンネルに展開', () => {
  const channels = [
    { id: 'a', type: ChannelType.GuildText, parentId: 'cat' },
    { id: 'b', type: ChannelType.GuildText, parentId: null },
    { id: 'cat', type: ChannelType.GuildCategory, parentId: null }
  ];
  assert.deepEqual(resolveTargetChannels(channels, []).map(c => c.id), ['a', 'b']);
  assert.deepEqual(resolveTargetChannels(channels, ['cat']).map(c => c.id), ['a']);
  assert.deepEqual(resolveTargetChannels(channels, ['b']).map(c => c.id), ['b']);
});

test('Bot のメッセージだけを、履歴をさかのぼって消す', async () => {
  const log = { bulk: [], single: [] };
  const messages = [];
  for (let i = 1; i <= 250; i++) messages.push(msg(1000 + i, i % 2 === 0 ? BOT : 'user', i > 240 ? 20 : 1));
  const channel = makeChannel({ id: '10', messages, log });
  const result = await deleteBotMessages({ guild: makeGuild([channel]), botId: BOT, channelIds: [] });

  const expected = messages.filter(m => m.author.id === BOT).map(m => m.id).sort();
  assert.deepEqual([...log.bulk, ...log.single].sort(), expected);
  assert.ok(log.single.length > 0, '古いものは 1 件ずつ');
  assert.equal(result.deletedMessages, expected.length);
  assert.equal(result.checkedChannels, 1);
});

test('メッセージの管理権限が無ければ、まとめて消さずに 1 件ずつ消す', async () => {
  const log = { bulk: [], single: [] };
  const channel = makeChannel({ id: '10', messages: [msg(1, BOT), msg(2, BOT), msg(3, 'user')], permissions: perms(P.ViewChannel, P.ReadMessageHistory), log });
  const result = await deleteBotMessages({ guild: makeGuild([channel]), botId: BOT, channelIds: [] });
  assert.deepEqual(log.bulk, []);
  assert.deepEqual(log.single.sort(), ['1', '2']);
  assert.equal(result.deletedMessages, 2);
});

test('見られないチャンネルは飛ばして報告する', async () => {
  const log = { bulk: [], single: [] };
  const hidden = makeChannel({ id: '11', messages: [msg(1, BOT)], permissions: perms(), log });
  const result = await deleteBotMessages({ guild: makeGuild([hidden]), botId: BOT, channelIds: [] });
  assert.deepEqual(result.skippedChannels, ['11']);
  assert.equal(result.deletedMessages, 0);
});

test('Bot が作ったスレッドはスレッドごと、ほかのスレッドは中の Bot のメッセージだけ消す', async () => {
  const log = { bulk: [], single: [] };
  const parent = makeChannel({ id: '10', messages: [], log });
  let deletedThread = false;
  const botThread = { ...makeChannel({ id: '20', type: ChannelType.PublicThread, parentId: '10', messages: [msg(1, BOT)], log }), ownerId: BOT, delete: async () => { deletedThread = true; } };
  const archivedStates = [];
  const userThread = {
    ...makeChannel({ id: '21', type: ChannelType.PublicThread, parentId: '10', messages: [msg(2, BOT), msg(3, 'user')], log }),
    ownerId: 'user', archived: true, locked: false,
    setArchived: async v => { archivedStates.push(v); }
  };
  const result = await deleteBotMessages({ guild: makeGuild([parent], [botThread, userThread]), botId: BOT, channelIds: ['10'] });
  assert.equal(deletedThread, true);
  assert.equal(result.deletedThreads, 1);
  assert.deepEqual([...log.bulk, ...log.single], ['2']);
  assert.deepEqual(archivedStates, [false, true], 'アーカイブを一時的に解除して元に戻す');
});

test('期限を過ぎたら途中で止める', async () => {
  const log = { bulk: [], single: [] };
  const channel = makeChannel({ id: '10', messages: [msg(1, BOT)], log });
  const result = await deleteBotMessages({ guild: makeGuild([channel]), botId: BOT, channelIds: [], deadline: Date.now() - 1 });
  assert.equal(result.stoppedEarly, true);
  assert.equal(result.deletedMessages, 0);
});

test('削除の画面', () => {
  for (const view of [
    deleteConfirmView([]), deleteConfirmView(['1', '2']), deleteProgressView(), deleteProgressView({ checkedChannels: 1, totalChannels: 3, deletedMessages: 5, deletedThreads: 1 }),
    deleteResultView({ deletedMessages: 3, deletedThreads: 1, failedMessages: 1, checkedChannels: 2, totalChannels: 2, skippedChannels: ['5'], stoppedEarly: true })
  ]) {
    assert.ok(JSON.stringify(view.map(c => c.toJSON())).length > 0);
  }
  assert.ok(JSON.stringify(deleteConfirmView([]).map(c => c.toJSON())).includes('サーバー全体'));
});
