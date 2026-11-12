// Bot が送ったメッセージの一括削除。
// 選んだチャンネル（カテゴリーなら中のチャンネル、無指定ならサーバー全体）の履歴をさかのぼり、
// この Bot が送ったメッセージを消す。チャンネル内のスレッドも調べ、Bot が作ったスレッドはスレッドごと消す。
import { ChannelType, PermissionFlagsBits as P } from 'discord.js';

// 14 日より新しいメッセージだけまとめて削除できる（Discord の制限）。少し余裕を持たせる
const BULK_DELETE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000;
const HISTORY_CHANNEL_TYPES = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice
]);
const THREAD_PARENT_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia]);

/** まとめて削除できるもの（14 日以内）と、1 件ずつ消すものに分ける */
export function splitByAge(messages, now = Date.now()) {
  const bulk = [];
  const single = [];
  for (const message of messages) {
    (now - message.createdTimestamp < BULK_DELETE_MAX_AGE_MS ? bulk : single).push(message);
  }
  return { bulk, single };
}

/**
 * 選択されたチャンネル ID を、実際に調べるチャンネルの一覧にする。
 * カテゴリーは中のチャンネルに展開し、何も選ばれていなければサーバー全体にする。
 */
export function resolveTargetChannels(allChannels, selectedIds) {
  const channels = [...allChannels].filter(c => HISTORY_CHANNEL_TYPES.has(c.type) || THREAD_PARENT_TYPES.has(c.type));
  if (!selectedIds || selectedIds.length === 0) return channels;
  const selected = new Set(selectedIds);
  return channels.filter(c => selected.has(c.id) || (c.parentId && selected.has(c.parentId)));
}

/** チャンネルの履歴から、Bot が送ったメッセージを集める */
async function collectBotMessages(channel, botId, shouldStop) {
  const found = [];
  let before;
  while (!shouldStop()) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    const list = [...batch.values()];
    if (list.length === 0) break;
    for (const message of list) if (message.author?.id === botId) found.push(message);
    before = list.reduce((oldest, m) => (BigInt(m.id) < BigInt(oldest) ? m.id : oldest), list[0].id);
    if (list.length < 100) break;
  }
  return found;
}

/** メッセージを消す。権限があれば 14 日以内のものはまとめて消す */
async function deleteMessages(channel, messages, canBulk, result) {
  const { bulk, single } = canBulk ? splitByAge(messages) : { bulk: [], single: messages };
  for (let i = 0; i < bulk.length; i += 100) {
    const chunk = bulk.slice(i, i + 100);
    if (chunk.length === 1) {
      single.push(chunk[0]);
      continue;
    }
    try {
      const deleted = await channel.bulkDelete(chunk.map(m => m.id), true);
      result.deletedMessages += deleted.size;
    } catch (err) {
      single.push(...chunk);
      result.lastError = err;
    }
  }
  for (const message of single) {
    try {
      await message.delete();
      result.deletedMessages += 1;
    } catch (err) {
      result.failedMessages += 1;
      result.lastError = err;
    }
  }
}

/** チャンネルに属するスレッド（進行中とアーカイブ済み）を集める */
async function collectThreads(channel, activeThreads) {
  const threads = activeThreads.filter(t => t.parentId === channel.id);
  if (!channel.threads?.fetchArchived) return threads;
  let before;
  for (;;) {
    const page = await channel.threads.fetchArchived({ type: 'public', limit: 100, ...(before ? { before } : {}) }).catch(() => null);
    if (!page) break;
    const list = [...page.threads.values()];
    threads.push(...list);
    if (!page.hasMore || list.length === 0) break;
    before = list[list.length - 1].id;
  }
  return threads;
}

/**
 * 一括削除を実行する。
 * @param {object} p
 * @param {import('discord.js').Guild} p.guild
 * @param {string} p.botId
 * @param {string[]} p.channelIds          選択されたチャンネル・カテゴリーの ID（空ならサーバー全体）
 * @param {(progress: object) => void} [p.onProgress]
 * @param {number} [p.deadline]            この時刻（ms）を過ぎたら途中で止める
 */
export async function deleteBotMessages({ guild, botId, channelIds, onProgress = () => {}, deadline = Infinity }) {
  const me = guild.members.me ?? await guild.members.fetchMe();
  const all = await guild.channels.fetch();
  const targets = resolveTargetChannels([...all.values()].filter(Boolean), channelIds);
  const { threads: active } = await guild.channels.fetchActiveThreads().catch(() => ({ threads: new Map() }));
  const activeThreads = [...active.values()];

  const result = {
    totalChannels: targets.length,
    checkedChannels: 0,
    deletedMessages: 0,
    deletedThreads: 0,
    failedMessages: 0,
    skippedChannels: [],
    stoppedEarly: false,
    lastError: null
  };
  const shouldStop = () => {
    if (Date.now() > deadline) result.stoppedEarly = true;
    return result.stoppedEarly;
  };

  for (const channel of targets) {
    if (shouldStop()) break;
    const perms = channel.permissionsFor(me);
    if (!perms?.has(P.ViewChannel) || !perms.has(P.ReadMessageHistory)) {
      result.skippedChannels.push(channel.id);
      result.checkedChannels += 1;
      continue;
    }
    const canBulk = perms.has(P.ManageMessages);

    try {
      // チャンネル本体のメッセージ
      if (HISTORY_CHANNEL_TYPES.has(channel.type) && channel.messages) {
        await deleteMessages(channel, await collectBotMessages(channel, botId, shouldStop), canBulk, result);
      }

      // スレッド：Bot が作ったものはスレッドごと、それ以外は中の Bot のメッセージを消す
      if (THREAD_PARENT_TYPES.has(channel.type)) {
        for (const thread of await collectThreads(channel, activeThreads)) {
          if (shouldStop()) break;
          if (thread.ownerId === botId && perms.has(P.ManageThreads)) {
            try {
              await thread.delete();
              result.deletedThreads += 1;
              continue;
            } catch (err) {
              result.lastError = err;
            }
          }
          const found = await collectBotMessages(thread, botId, shouldStop);
          if (found.length === 0) continue;
          // アーカイブ済みのスレッドは、消す間だけアーカイブを解除して元に戻す
          const wasArchived = thread.archived && !thread.locked;
          if (wasArchived) await thread.setArchived(false).catch(() => {});
          await deleteMessages(thread, found, canBulk, result);
          if (wasArchived) await thread.setArchived(true).catch(() => {});
        }
      }
    } catch (err) {
      result.skippedChannels.push(channel.id);
      result.lastError = err;
    }

    result.checkedChannels += 1;
    onProgress({ ...result });
  }
  return result;
}
