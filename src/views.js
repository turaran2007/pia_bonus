// 画面（Components V2 のメッセージとモーダル）の組み立て。
// Discord への送信はしない。index.js から呼び出して使う。
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ContainerBuilder,
  LabelBuilder,
  ModalBuilder,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';
import { parseEmojiSetting } from './emoji.js';
import { DAYS, formatPeriod, nextSendTime, normalizeDay } from './time.js';

export const COLORS = Object.freeze({
  brand: 0xf47fa4,
  success: 0x57f287,
  danger: 0xed4245,
  warning: 0xfee75c,
  info: 0x5865f2
});

// 1 通に入れる文字数の目安（Components V2 の上限は 1 通あたり合計 4000 文字）
export const MESSAGE_TEXT_BUDGET = 3800;
export const MAX_DAILY_PAIR_LIMIT = 100;

const WEEK_ORDER = ['月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日', '日曜日'];

// ------------------------
// 部品
// ------------------------

const text = content => new TextDisplayBuilder().setContent(content);
const separator = (large = false) => new SeparatorBuilder()
  .setSpacing(large ? SeparatorSpacingSize.Large : SeparatorSpacingSize.Small);

function container(color) {
  return new ContainerBuilder().setAccentColor(color);
}

function button(customId, label, style = ButtonStyle.Secondary) {
  return new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style);
}

/** 文章 + 右側のボタン（ボタンが無ければ文章だけ） */
function addRow(target, content, accessory) {
  if (accessory) {
    target.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text(content)).setButtonAccessory(accessory));
  } else {
    target.addTextDisplayComponents(text(content));
  }
}

export function formatDateTime(m) {
  return `${m.format('M月D日')}(${DAYS[m.day()][0]}) ${m.format('HH:mm')}`;
}

// ------------------------
// お知らせ（成功・エラーなど）
// ------------------------

const NOTICE_STYLE = {
  success: { color: COLORS.success, icon: '✅' },
  error: { color: COLORS.danger, icon: '❌' },
  warning: { color: COLORS.warning, icon: '⚠️' },
  info: { color: COLORS.info, icon: '' }
};

/** 1 枚のカードだけのメッセージ */
export function noticeView(message, kind = 'info') {
  const { color, icon } = NOTICE_STYLE[kind];
  return [container(color).addTextDisplayComponents(text(icon ? `${icon} ${message}` : message))];
}

// ------------------------
// 記録時の返信
// ------------------------

export function recordReplyView({ senderId, accepted, limited, limit }) {
  let content;
  if (accepted === 0) {
    content = `<@${senderId}>さん、今日はもう同じ相手への上限（${limit}回）に達しているため、記録しませんでした。`;
  } else {
    content = accepted === 1
      ? `<@${senderId}>さん、記録しました！`
      : `<@${senderId}>さん、${accepted}人分を記録しました！`;
    if (limited > 0) content += `\n-# ${limited}人は今日の上限（${limit}回）に達しているため記録していません`;
  }
  return [text(content)];
}

// ------------------------
// 設定
// ------------------------

function describeEmoji(value) {
  const emoji = parseEmojiSetting(value);
  if (!emoji) return '未設定\n-# 設定するまで記録されません';
  if (emoji.customId) return `${value}\n-# サーバー独自の絵文字です。この絵文字だけを記録します`;
  return `${value}\n-# 名前 \`${emoji.label}\` で判定します（同じ名前の絵文字はどれでも記録）`;
}

function describeSettings(settings, now) {
  const day = normalizeDay(settings.sendDay);
  const next = nextSendTime(now, settings.sendDay, settings.sendTime);
  let schedule;
  if (day && settings.sendTime) {
    schedule = `毎週 ${day} ${settings.sendTime}（日本時間）`;
    schedule += settings.channelId && next
      ? `\n-# 次回: ${formatDateTime(next)}`
      : '\n-# 投稿先チャンネルを設定すると投稿されます';
  } else {
    schedule = '未設定\n-# 曜日と時刻を設定すると、毎週その日時に集計を投稿します';
  }

  const mentions = ['ユーザー', settings.countRoles && 'ロール', settings.countEveryone && '@everyone / @here']
    .filter(Boolean).join('、');
  const excluded = settings.excludedChannelIds.length > 0
    ? settings.excludedChannelIds.map(id => `<#${id}>`).join(' ')
    : 'なし';

  return {
    channel: settings.channelId ? `<#${settings.channelId}>` : '未設定',
    schedule,
    emoji: describeEmoji(settings.emoji),
    limit: settings.dailyPairLimit > 0 ? `${settings.dailyPairLimit}回まで` : '無制限',
    mentions,
    excluded
  };
}

/**
 * 設定パネル。editable が true なら各項目に［変更］ボタンを付ける。
 * @param {object} settings  getSettings() の戻り値
 * @param {import('moment').Moment} now
 * @param {{editable?: boolean, status?: {kind: 'success'|'error'|'info', message: string}}} options
 */
export function settingsView(settings, now, { editable = false, status } = {}) {
  const d = describeSettings(settings, now);
  const edit = id => (editable ? button(id, '変更') : null);
  const color = status?.kind === 'error' ? COLORS.danger : COLORS.brand;

  let header = editable ? '## Pia Bot の設定' : '## 現在の設定';
  if (status) {
    const { icon } = NOTICE_STYLE[status.kind];
    header += `\n${icon ? `${icon} ` : ''}${status.message}`;
  }

  const card = container(color).addTextDisplayComponents(text(header));

  card.addSeparatorComponents(separator());
  card.addTextDisplayComponents(text('### 週次の集計投稿'));
  addRow(card, `**投稿先チャンネル**\n${d.channel}`, edit('set_channel'));
  addRow(card, `**投稿日時**\n${d.schedule}`, edit('set_schedule'));

  card.addSeparatorComponents(separator());
  card.addTextDisplayComponents(text('### 記録のルール'));
  addRow(card, `**対象の絵文字**\n${d.emoji}`, edit('set_emoji'));
  addRow(card, `**同じ相手への1日の上限**\n${d.limit}`, edit('set_limit'));
  addRow(card, `**記録するメンション**\n${d.mentions}`, edit('set_mentions'));
  addRow(card, `**除外チャンネル**\n${d.excluded}`, edit('set_excluded'));

  if (editable) {
    card.addSeparatorComponents(separator());
    card.addActionRowComponents(new ActionRowBuilder().addComponents(
      button('reset_stats', '記録のリセット', ButtonStyle.Danger),
      button('reset_settings', '設定のリセット')
    ));
  } else {
    card.addTextDisplayComponents(text('-# 設定の変更は管理者が /pia_config から行えます'));
  }
  return [card];
}

/** リセットの確認画面 */
export function resetView(step) {
  const views = {
    choose: {
      body: '## 記録のリセット\nどのデータをリセットしますか？\n' +
        '- **累計データ**：/pia_total と /pia_me の累計・よくやり取りする相手が 0 になります\n' +
        '- **今週のデータ**：直近8日間の記録を消します（週次投稿・/pia_weekly の対象）',
      buttons: [
        button('confirm_reset_total', '累計データ', ButtonStyle.Danger),
        button('confirm_reset_weekly', '今週のデータ', ButtonStyle.Danger),
        button('back_to_settings', '戻る')
      ]
    },
    total: {
      body: '## 累計データのリセット\n本当に **累計データ** を削除しますか？\n-# 週次・月間・年間の集計には影響しません。元には戻せません。',
      buttons: [button('do_reset_total', '削除する', ButtonStyle.Danger), button('back_to_settings', 'キャンセル')]
    },
    weekly: {
      body: '## 今週のデータのリセット\n本当に **直近8日間の記録** を削除しますか？\n-# 累計データには影響しません。元には戻せません。',
      buttons: [button('do_reset_weekly', '削除する', ButtonStyle.Danger), button('back_to_settings', 'キャンセル')]
    },
    settings: {
      body: '## 設定のリセット\n本当に **すべての設定** を初期状態に戻しますか？\n-# 記録データは消えません。',
      buttons: [button('do_reset_settings', 'リセットする', ButtonStyle.Danger), button('back_to_settings', 'キャンセル')]
    }
  };
  const { body, buttons } = views[step];
  return [
    container(COLORS.danger)
      .addTextDisplayComponents(text(body))
      .addActionRowComponents(new ActionRowBuilder().addComponents(...buttons))
  ];
}

// ------------------------
// 設定の入力画面（モーダル）
// ------------------------

function label(name, description) {
  const l = new LabelBuilder().setLabel(name);
  if (description) l.setDescription(description);
  return l;
}

export function channelModal(settings) {
  const select = new ChannelSelectMenuBuilder()
    .setCustomId('channel')
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    .setPlaceholder('チャンネルを選択')
    .setRequired(true);
  if (settings.channelId) select.setDefaultChannels([settings.channelId]);
  return new ModalBuilder()
    .setCustomId('channel_modal')
    .setTitle('投稿先チャンネル')
    .addLabelComponents(label('投稿先チャンネル', '週次の集計をこのチャンネルに投稿し、スレッドに結果を載せます').setChannelSelectMenuComponent(select));
}

export function scheduleModal(settings) {
  const current = normalizeDay(settings.sendDay);
  return new ModalBuilder()
    .setCustomId('schedule_modal')
    .setTitle('投稿日時')
    .addLabelComponents(
      label('曜日').setStringSelectMenuComponent(
        new StringSelectMenuBuilder()
          .setCustomId('day')
          .setPlaceholder('曜日を選択')
          .setRequired(true)
          .addOptions(WEEK_ORDER.map(day => ({ label: day, value: day, default: day === current })))
      ),
      label('時刻（日本時間）', '例: 09:00').setTextInputComponent(
        new TextInputBuilder()
          .setCustomId('time')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('09:00')
          .setMaxLength(5)
          .setValue(settings.sendTime ?? '')
          .setRequired(true)
      )
    );
}

export function emojiModal(settings) {
  return new ModalBuilder()
    .setCustomId('emoji_modal')
    .setTitle('対象の絵文字')
    .addLabelComponents(
      label('対象の絵文字', '標準の絵文字は 🪙 か :coin:（名前で判定）。サーバー独自の絵文字は <:名前:ID> で、その絵文字だけ記録')
        .setTextInputComponent(new TextInputBuilder()
          .setCustomId('emoji')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(100)
          .setValue(settings.emoji ?? '')
          .setRequired(true))
    );
}

export function limitModal(settings) {
  return new ModalBuilder()
    .setCustomId('limit_modal')
    .setTitle('同じ相手への1日の上限')
    .addLabelComponents(
      label('1日の上限（回）', `同じ人から同じ相手へ、1日に何回まで数えるか。0 で無制限（最大 ${MAX_DAILY_PAIR_LIMIT}）`)
        .setTextInputComponent(new TextInputBuilder()
          .setCustomId('limit')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(3)
          .setValue(String(settings.dailyPairLimit))
          .setRequired(true))
    );
}

export function mentionsModal(settings) {
  return new ModalBuilder()
    .setCustomId('mentions_modal')
    .setTitle('記録するメンション')
    .addLabelComponents(
      label('記録するメンション', 'ユーザーへの直接メンションは常に記録します。何も選ばなければそれだけになります')
        .setStringSelectMenuComponent(new StringSelectMenuBuilder()
          .setCustomId('mentions')
          .setPlaceholder('追加で記録するメンションを選択')
          .setRequired(false)
          .setMinValues(0)
          .setMaxValues(2)
          .addOptions(
            { label: 'ロールへのメンション', value: 'roles', description: 'ロールのメンバー全員に記録', default: settings.countRoles },
            { label: '@everyone / @here', value: 'everyone', description: 'サーバーのメンバー全員に記録', default: settings.countEveryone }
          ))
    );
}

export function excludedModal(settings) {
  const select = new ChannelSelectMenuBuilder()
    .setCustomId('channels')
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildCategory)
    .setPlaceholder('記録しないチャンネル・カテゴリーを選択')
    .setRequired(false)
    .setMinValues(0)
    .setMaxValues(25);
  if (settings.excludedChannelIds.length > 0) select.setDefaultChannels(settings.excludedChannelIds.slice(0, 25));
  return new ModalBuilder()
    .setCustomId('excluded_modal')
    .setTitle('除外チャンネル')
    .addLabelComponents(
      label('除外チャンネル（最大25件）', 'カテゴリーを選ぶと中のチャンネルすべてが対象外。スレッドは親チャンネルに従います')
        .setChannelSelectMenuComponent(select)
    );
}

// ------------------------
// ランキング
// ------------------------

/** 'rank' 行の整形。上位 3 位はメダル */
export function rankLine({ rank, name, count }) {
  return `${rank}位　${name} さん　${count}回`;
}

/**
 * ランキングのメッセージを作る。長い場合は複数のメッセージに分ける。
 * @param {object} p
 * @param {string} p.title              例: '累計ランキング'
 * @param {string} [p.subtitle]         例: '集計期間: 11月6日～11月12日'
 * @param {Array<{heading: string, lines: string[]}>} p.sections
 * @param {number} [p.color]
 * @param {number} [p.budget]           1 通あたりの文字数の目安
 * @returns {Array<Array<ContainerBuilder>>} メッセージごとの components
 */
export function rankingMessages({ title, subtitle, sections, color = COLORS.brand, budget = MESSAGE_TEXT_BUDGET }) {
  const headerReserve = title.length + (subtitle?.length ?? 0) + 40;
  const pages = [];
  let page = { parts: [], used: headerReserve };

  for (const section of sections) {
    const lines = section.lines.length > 0 ? section.lines : ['-# まだ記録がありません'];
    let part = { heading: section.heading, lines: [] };
    page.parts.push(part);
    page.used += section.heading.length + 8;

    for (const line of lines) {
      if (page.used + line.length + 1 > budget && part.lines.length > 0) {
        pages.push(page);
        page = { parts: [], used: headerReserve };
        part = { heading: `${section.heading}（続き）`, lines: [] };
        page.parts.push(part);
        page.used += part.heading.length + 8;
      }
      part.lines.push(line);
      page.used += line.length + 1;
    }
  }
  pages.push(page);

  return pages.map((p, index) => {
    const pageNo = pages.length > 1 ? `（${index + 1}/${pages.length}）` : '';
    let header;
    if (index === 0) {
      header = `## ${title}`;
      if (subtitle) header += `\n-# ${subtitle}`;
      if (pageNo) header += `\n-# ${pageNo}`;
    } else {
      header = `-# ${title}${pageNo}`;
    }
    const card = container(color).addTextDisplayComponents(text(header));
    for (const part of p.parts) {
      card.addSeparatorComponents(separator());
      card.addTextDisplayComponents(text(`### ${part.heading}\n${part.lines.join('\n')}`));
    }
    return [card];
  });
}

/** 週次投稿の最初のメッセージ（このメッセージからスレッドを作る） */
export function weeklyIntroView(period) {
  return [
    container(COLORS.brand).addTextDisplayComponents(text(
      'こんにちは！\n' +
      '今週も皆さんお疲れ様でした\n' +
      '今週のピアボーナスの結果をスレッドに投稿しました！\n' +
      'ご覧ください！\n' +
      `-# 集計期間: ${formatPeriod(period)}`
    ))
  ];
}

// ------------------------
// /pia_me
// ------------------------

/**
 * @param {object} p
 * @param {string} p.name
 * @param {Array<{label: string, sent: number, received: number}>} p.periods
 * @param {Array<{name: string, count: number}>} p.sentTo        回数の多い順
 * @param {Array<{name: string, count: number}>} p.receivedFrom  回数の多い順
 */
export function meView({ name, periods, sentTo, receivedFrom }) {
  const partners = list => (list.length > 0
    ? withRanks(list, 'count').map(({ rank, row }) => rankLine({ rank, name: row.name, count: row.count })).join('\n')
    : '-# まだいません');

  const card = container(COLORS.brand)
    .addTextDisplayComponents(text(`## ${name} さんの記録`))
    .addSeparatorComponents(separator())
    .addTextDisplayComponents(text(
      periods.map(p => `**${p.label}**　送った ${p.sent}回、もらった ${p.received}回`).join('\n')
    ))
    .addSeparatorComponents(separator())
    .addTextDisplayComponents(text(`### よく送った相手\n${partners(sentTo)}`))
    .addTextDisplayComponents(text(`### よくもらった相手\n${partners(receivedFrom)}`));
  return [card];
}

/** 回数の多い順に並んだ配列に順位を付ける（同じ回数は同じ順位） */
function withRanks(list, key) {
  return list.map(row => ({
    rank: list.findIndex(other => other[key] === row[key]) + 1,
    row
  }));
}

// ------------------------
// /pia_check
// ------------------------

const CHECK_MARKS = { ok: '✅', warning: '⚠️', error: '❌' };

/** @param {Array<{level: 'ok'|'warning'|'error', text: string}>} results */
export function checkView(results) {
  const errors = results.filter(r => r.level === 'error').length;
  const summary = errors > 0
    ? `${errors} 件の問題があります。下の ❌ を直してください。`
    : 'このチャンネルでは問題なく記録できます。';
  return [
    container(errors > 0 ? COLORS.danger : COLORS.success)
      .addTextDisplayComponents(text(`## 動作チェック\n${summary}`))
      .addSeparatorComponents(separator())
      .addTextDisplayComponents(text(results.map(r => `${CHECK_MARKS[r.level]} ${r.text}`).join('\n')))
      .addTextDisplayComponents(text('-# 権限は「サーバー設定 → ロール」や、チャンネル・カテゴリーの「権限」で Bot のロールに付けられます'))
  ];
}

// ------------------------
// /pia_help
// ------------------------

export function helpView(version) {
  return [
    container(COLORS.brand)
      .addTextDisplayComponents(text('## Pia Bot の使い方'))
      .addSeparatorComponents(separator())
      .addTextDisplayComponents(text(
        '### 記録のしかた\n' +
        '設定された絵文字を入れて相手をメンションすると、送った人ともらった人の回数が記録されます。\n' +
        'ロールや @everyone へのメンションは、その全員に記録されます（サーバーの設定によっては対象外です）。'
      ))
      .addTextDisplayComponents(text(
        '### コマンド\n' +
        '`/pia_total`　累計ランキング\n' +
        '`/pia_weekly`　直近7日間のランキング\n' +
        '`/pia_monthly`　月間ランキング（今月・先月）\n' +
        '`/pia_yearly`　年間ランキング（今年・去年）\n' +
        '`/pia_me`　自分の記録\n' +
        '`/pia_settings`　現在の設定\n' +
        '`/pia_check`　このチャンネルで記録できるかの確認\n' +
        '`/pia_config`　設定の変更（管理者のみ）'
      ))
      .addTextDisplayComponents(text(
        '-# 毎週、設定された曜日・時刻（日本時間）に、前日までの7日間の集計がスレッドに投稿されます。' +
        (version ? `\n-# バージョン ${version}` : '')
      ))
  ];
}
