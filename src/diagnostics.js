// /pia_check の診断。Bot がそのチャンネルで記録・返信できるか、週次投稿ができるかを調べる
import { PermissionFlagsBits as P } from 'discord.js';
import { parseEmojiSetting } from './emoji.js';

/** 記録するチャンネルで Bot に必要な権限 */
const RECORD_PERMISSIONS = [
  { flag: P.ViewChannel, name: 'チャンネルを見る', effect: 'メッセージが Bot に届かないため、記録されません' },
  { flag: P.SendMessages, threadFlag: P.SendMessagesInThreads, name: 'メッセージを送信', threadName: 'スレッドでメッセージを送信', effect: '記録はされますが、「記録しました」の返信ができません' },
  { flag: P.ReadMessageHistory, name: 'メッセージ履歴を読む', effect: '記録はされますが、「記録しました」の返信ができません' }
];

/** 週次の投稿先チャンネルで Bot に必要な権限 */
const REPORT_PERMISSIONS = [
  { flag: P.ViewChannel, name: 'チャンネルを見る' },
  { flag: P.SendMessages, name: 'メッセージを送信' },
  { flag: P.CreatePublicThreads, name: '公開スレッドの作成' },
  { flag: P.SendMessagesInThreads, name: 'スレッドでメッセージを送信' }
];

/** Discord のエラーコードから、足りない権限の見当を付ける */
export function describeDiscordError(err) {
  switch (err?.code) {
    case 50001: return 'Bot がこのチャンネルを見られません（「チャンネルを見る」権限がありません）';
    case 50013: return 'Bot の権限が足りません（「メッセージを送信」「メッセージ履歴を読む」などを確認してください）';
    case 160002: return 'メッセージ履歴を読めないため返信できません（「メッセージ履歴を読む」権限がありません）';
    default: return null;
  }
}

/**
 * 診断結果を作る。
 * @param {object} p
 * @param {object} p.settings               getSettings() の戻り値
 * @param {boolean} p.excluded              このチャンネルが除外チャンネルか
 * @param {{has(flag: bigint): boolean}} p.channelPermissions  このチャンネルでの Bot の権限
 * @param {boolean} p.isThread              このチャンネルがスレッドか
 * @param {{found: boolean, permissions?: {has(flag: bigint): boolean}} | null} p.reportChannel  投稿先チャンネル（未設定なら null）
 * @returns {Array<{level: 'ok'|'warning'|'error', text: string}>}
 */
export function diagnose({ settings, excluded, channelPermissions, isThread, reportChannel }) {
  const results = [];
  const ok = text => results.push({ level: 'ok', text });
  const warning = text => results.push({ level: 'warning', text });
  const error = text => results.push({ level: 'error', text });

  // 記録の設定
  const emoji = parseEmojiSetting(settings.emoji);
  if (emoji) ok(`対象の絵文字は ${settings.emoji} です（名前 \`${emoji.label}\` で判定します）`);
  else error('対象の絵文字が設定されていません。/pia_config から設定してください');

  if (excluded) error('このチャンネルは除外チャンネルに含まれているため、記録されません');

  // このチャンネルでの権限
  const missing = RECORD_PERMISSIONS.filter(p => !channelPermissions.has(isThread && p.threadFlag ? p.threadFlag : p.flag));
  for (const p of missing) {
    const name = isThread && p.threadName ? p.threadName : p.name;
    error(`Bot に「${name}」の権限がありません。${p.effect}`);
  }
  if (missing.length === 0) ok('このチャンネルで記録と返信に必要な権限はそろっています');

  // 週次の投稿先
  if (!reportChannel) {
    warning('週次の投稿先チャンネルが設定されていません（記録はされますが、集計は投稿されません）');
  } else if (!reportChannel.found) {
    error('週次の投稿先チャンネルが見つからないか、Bot から見られません');
  } else {
    const reportMissing = REPORT_PERMISSIONS.filter(p => !reportChannel.permissions.has(p.flag));
    if (reportMissing.length > 0) {
      error(`週次の投稿先チャンネルで、Bot に次の権限がありません：${reportMissing.map(p => `「${p.name}」`).join('')}`);
    } else {
      ok('週次の投稿先チャンネルで投稿に必要な権限はそろっています');
    }
  }

  return results;
}
