import http from 'node:http';
import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  ThreadAutoArchiveDuration,
  escapeMarkdown
} from 'discord.js';
import dotenv from 'dotenv';
import cron from 'node-cron';
import { collectReceivers, isExcludedChannel } from './src/awards.js';
import { applicationOwnerIds, canManage, parseUserIds } from './src/permissions.js';
import { describeDiscordError, diagnose } from './src/diagnostics.js';
import { containsEmoji } from './src/emoji.js';
import { VERSION } from './src/version.js';
import { DEFAULT_SETTINGS, createDb } from './src/db.js';
import { rankingLines } from './src/format.js';
import {
  TIMEZONE,
  formatPeriod,
  isDueToday,
  monthPeriod,
  nextSendTime,
  normalizeDay,
  nowJst,
  parseTime,
  recentPeriod,
  reportPeriod,
  toDateString,
  yearPeriod
} from './src/time.js';
import {
  MAX_DAILY_PAIR_LIMIT,
  channelModal,
  checkView,
  emojiModal,
  excludedModal,
  formatDateTime,
  helpView,
  limitModal,
  meView,
  mentionsModal,
  noticeView,
  rankLine,
  rankingMessages,
  recordReplyView,
  resetView,
  scheduleModal,
  settingsView,
  weeklyIntroView
} from './src/views.js';

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const HEALTH_PORT = Number(process.env.HEALTH_PORT ?? 8080);
// ランキング投稿でメンションによる通知を飛ばさない
const NO_PINGS = { parse: [] };

if (!BOT_TOKEN) {
  console.error('❌ 環境変数 BOT_TOKEN が設定されていません');
  process.exit(1);
}

// Bot の管理者：どのサーバーでも設定の変更とリセットができる。
// アプリケーションの所有者は起動時に自動で追加し、BOT_ADMIN_IDS で別のアカウントも追加できる
const botAdminIds = new Set(parseUserIds(process.env.BOT_ADMIN_IDS));

// DATABASE_URL が無ければ PGHOST / PGUSER / PGPASSWORD / PGDATABASE を使う（pg の標準動作）
const db = createDb(process.env.DATABASE_URL);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent
  ]
});

// ------------------------
// 設定のキャッシュ（メッセージごとに DB を読まないため）
// ------------------------

const settingsCache = new Map();

/** サーバーの設定。未設定の項目は既定値で埋めて返す */
async function getSettings(guildId) {
  if (!settingsCache.has(guildId)) {
    const row = await db.getSettings(guildId);
    settingsCache.set(guildId, { ...DEFAULT_SETTINGS, guildId, ...row });
  }
  return settingsCache.get(guildId);
}

async function updateSettings(guildId, values) {
  await db.updateSettings(guildId, values);
  settingsCache.delete(guildId);

  // 曜日・時刻を「今日の、もう過ぎた時刻」に変えた直後に、取りこぼし扱いで即投稿されないようにする
  if ('sendDay' in values || 'sendTime' in values) {
    const settings = await getSettings(guildId);
    const now = nowJst();
    if (isDueToday(now, settings.sendDay, settings.sendTime)) {
      await db.claimDailySend(guildId, toDateString(now));
    }
  }
}

async function resetSettings(guildId) {
  await db.resetSettings(guildId);
  settingsCache.delete(guildId);
}

// ------------------------
// スラッシュコマンド
// ------------------------

const commands = [
  new SlashCommandBuilder()
    .setName('pia_config')
    .setDescription('Pia Botの設定メニューを表示します（管理者のみ）')
    // Bot の管理者がサーバーの管理者でなくても使えるよう、表示は制限しない（実行時に確認する）。
    // 以前の「管理者のみ表示」が Discord 側に残らないよう、null を明示して送る
    .setDefaultMemberPermissions(null),
  new SlashCommandBuilder().setName('pia_total').setDescription('累計の送受信数ランキングを表示します'),
  new SlashCommandBuilder().setName('pia_weekly').setDescription('直近7日間の送受信数ランキングを表示します'),
  new SlashCommandBuilder()
    .setName('pia_monthly')
    .setDescription('月間の送受信数ランキングを表示します')
    .addStringOption(option => option
      .setName('対象')
      .setDescription('どの月を表示するか（省略時は今月）')
      .addChoices({ name: '今月', value: 'this' }, { name: '先月', value: 'last' })),
  new SlashCommandBuilder()
    .setName('pia_yearly')
    .setDescription('年間の送受信数ランキングを表示します')
    .addStringOption(option => option
      .setName('対象')
      .setDescription('どの年を表示するか（省略時は今年）')
      .addChoices({ name: '今年', value: 'this' }, { name: '去年', value: 'last' })),
  new SlashCommandBuilder().setName('pia_me').setDescription('自分の送受信数とよくやり取りする相手を表示します'),
  new SlashCommandBuilder().setName('pia_check').setDescription('このチャンネルで記録できるかを確認します'),
  new SlashCommandBuilder().setName('pia_help').setDescription('Pia Botの使い方を表示します'),
  new SlashCommandBuilder().setName('pia_settings').setDescription('現在のBot設定を確認します')
].map(command => command.toJSON());

function updatePresence() {
  client.user?.setPresence({
    activities: [{ name: `${client.guilds.cache.size}つのサーバーで導入中 | ${VERSION}`, type: ActivityType.Playing }],
    status: 'online'
  });
}

/** ロールや @everyone のメンションを数えるため、メンバー一覧を読み込んでおく */
async function fetchMembers(guild) {
  try {
    await guild.members.fetch();
    console.log(`✅ ${guild.name} のメンバーを取得しました`);
  } catch (err) {
    console.error(`❌ ${guild.name} のメンバー取得に失敗:`, err);
  }
}

client.once(Events.ClientReady, async readyClient => {
  console.log(`✅ ${readyClient.user.tag} としてログインしました（${VERSION}）`);
  updatePresence();

  try {
    const owners = applicationOwnerIds(await readyClient.application.fetch());
    owners.forEach(id => botAdminIds.add(id));
    console.log(`✅ Bot の管理者: ${[...botAdminIds].join(', ') || '（なし）'}`);
  } catch (err) {
    console.error('❌ アプリケーションの所有者の取得に失敗:', err);
  }

  try {
    await readyClient.application.commands.set(commands);
    console.log('✅ スラッシュコマンドを登録しました');
  } catch (err) {
    console.error('❌ スラッシュコマンドの登録に失敗:', err);
  }

  for (const guild of readyClient.guilds.cache.values()) {
    await fetchMembers(guild);
  }
});

client.on(Events.GuildCreate, async guild => {
  updatePresence();
  await fetchMembers(guild);
});

client.on(Events.GuildDelete, guild => {
  updatePresence();
  settingsCache.delete(guild.id);
});

// ------------------------
// メッセージ送信の共通処理（Components V2）
// ------------------------

const V2 = MessageFlags.IsComponentsV2;
const EPHEMERAL_V2 = MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral;

/** 本人だけに見えるカードで返信する（返信済みなら追加で送る） */
async function replyNotice(interaction, message, kind) {
  const payload = { components: noticeView(message, kind), flags: EPHEMERAL_V2 };
  if (interaction.deferred || interaction.replied) return interaction.followUp(payload);
  return interaction.reply(payload);
}

// ------------------------
// 絵文字付きメンションの記録
// ------------------------

client.on(Events.MessageCreate, async message => {
  if (message.author.bot || !message.inGuild()) return;

  try {
    const settings = await getSettings(message.guildId);
    const emoji = settings.emoji;
    // 絵文字は名前で判定する（設定が :coin: でも 🪙 でも、メッセージ側がどちらでも一致する）
    if (!emoji || !containsEmoji(message.content, emoji)) return;

    const where = `[${message.guild.name}] #${message.channel.name ?? message.channelId}`;
    if (isExcludedChannel(message.channel, settings.excludedChannelIds)) {
      console.log(`ℹ️ ${where} 除外チャンネルのため記録しませんでした`);
      return;
    }

    const senderId = message.author.id;
    const receivers = collectReceivers({
      senderId,
      botUserId: client.user.id,
      users: message.mentions.users.values(),
      roleMembers: [...message.mentions.roles.values()].map(role => role.members.values()),
      everyone: message.mentions.everyone,
      allMembers: message.guild.members.cache.values(),
      options: settings
    });
    if (receivers.length === 0) {
      // 原因を調べられるよう、Bot が受け取ったメンションの中身も出す
      const detail = {
        sender: senderId,
        users: message.mentions.users.map(user => ({ id: user.id, bot: user.bot })),
        roles: message.mentions.roles.map(role => ({ id: role.id, name: role.name, cachedMembers: role.members.size })),
        everyone: message.mentions.everyone,
        countRoles: settings.countRoles,
        countEveryone: settings.countEveryone
      };
      console.log(`ℹ️ ${where} 絵文字はありますが、記録できるメンション（自分と Bot 以外）が無いため記録しませんでした`, JSON.stringify(detail));
      return;
    }

    const { accepted, limited } = await db.recordAward(
      message.guildId, senderId, receivers, toDateString(nowJst()), settings.dailyPairLimit
    );

    await message.reply({
      components: recordReplyView({
        senderId, accepted: accepted.length, limited: limited.length, limit: settings.dailyPairLimit
      }),
      flags: V2,
      // 送った本人にだけ通知する（以前と同じ動き）
      allowedMentions: { users: [senderId], repliedUser: false }
    }).catch(err => {
      const hint = describeDiscordError(err);
      console.error(`❌ ${where} 記録はしましたが、返信に失敗しました${hint ? `: ${hint}` : ''}`, hint ? '' : err);
    });
  } catch (err) {
    console.error('❌ メッセージの記録に失敗:', err);
  }
});

// ------------------------
// ランキング
// ------------------------

/** ユーザー ID から表示名を引く。取れなければメンション表記にする */
async function resolveNames(guild, userIds) {
  const missing = [...new Set(userIds)].filter(id => !guild.members.cache.has(id));
  if (missing.length > 0) {
    await guild.members.fetch({ user: missing }).catch(() => null);
  }
  return id => {
    const name = guild.members.cache.get(id)?.displayName;
    return name ? escapeMarkdown(name) : `<@${id}>`;
  };
}

/** ランキングのメッセージ（複数通になることがある）を作る */
async function buildRankingMessages(guild, rows, { title, subtitle }) {
  const nameOf = await resolveNames(guild, rows.map(row => row.userId));
  return rankingMessages({
    title,
    subtitle,
    sections: [
      { heading: 'giveAward', lines: rankingLines(rows, 'sent', nameOf, rankLine) },
      { heading: 'receiveAward', lines: rankingLines(rows, 'received', nameOf, rankLine) }
    ]
  });
}

/** deferReply 済みのコマンドに、複数通のメッセージで答える */
async function replyPages(interaction, pages) {
  const [first, ...rest] = pages;
  await interaction.editReply({ components: first, flags: V2, allowedMentions: NO_PINGS });
  for (const components of rest) {
    await interaction.followUp({ components, flags: V2, allowedMentions: NO_PINGS });
  }
}

async function replyRanking(interaction, { title, subtitle, start, end, emptyMessage }) {
  await interaction.deferReply();
  const rows = start
    ? await db.getStatsBetween(interaction.guildId, toDateString(start), toDateString(end))
    : await db.getTotalStats(interaction.guildId);
  if (rows.length === 0) {
    return interaction.editReply({ components: noticeView(emptyMessage, 'info'), flags: V2 });
  }
  return replyPages(interaction, await buildRankingMessages(interaction.guild, rows, { title, subtitle }));
}

// ------------------------
// 設定パネル
// ------------------------

const ADMIN_COMPONENT_IDS = new Set([
  'set_channel', 'set_schedule', 'set_emoji', 'set_limit', 'set_mentions', 'set_excluded',
  'reset_stats', 'reset_settings', 'confirm_reset_total', 'confirm_reset_weekly',
  'do_reset_total', 'do_reset_weekly', 'do_reset_settings', 'back_to_settings',
  'channel_modal', 'schedule_modal', 'emoji_modal', 'limit_modal', 'mentions_modal', 'excluded_modal'
]);

const MODALS = {
  set_channel: channelModal,
  set_schedule: scheduleModal,
  set_emoji: emojiModal,
  set_limit: limitModal,
  set_mentions: mentionsModal,
  set_excluded: excludedModal
};

/** 権限が無いときのメッセージ。Bot の管理者に登録するときのため、本人のユーザー ID も表示する */
function notAdminMessage(interaction) {
  return 'この操作はサーバーの管理者のみ行えます。\n' +
    `-# あなたのユーザー ID: ${interaction.user.id}（Bot の管理者に登録されていません）`;
}

function isAdmin(interaction) {
  const allowed = canManage({ userId: interaction.user.id, memberPermissions: interaction.memberPermissions }, botAdminIds);
  if (allowed && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    console.log(`ℹ️ Bot の管理者 ${interaction.user.tag} がサーバー「${interaction.guild?.name ?? interaction.guildId}」の設定を操作しました`);
  }
  return allowed;
}

/** 設定パネルを表示し直す（status で上部にお知らせを出す） */
async function showSettingsPanel(interaction, status) {
  const components = settingsView(await getSettings(interaction.guildId), nowJst(), { editable: true, status });
  return interaction.update({ components, flags: V2, allowedMentions: NO_PINGS });
}

const toHalfWidthDigits = s => s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

/** モーダルの入力を保存する。成功ならお知らせ、入力ミスならエラーの status を返す */
async function saveModal(interaction) {
  const { customId, guildId, fields } = interaction;
  const ok = message => ({ kind: 'success', message });
  const ng = message => ({ kind: 'error', message });

  switch (customId) {
    case 'channel_modal': {
      const channelId = fields.getSelectedChannels('channel')?.first()?.id;
      if (!channelId) return ng('チャンネルを選択してください。');
      await updateSettings(guildId, { channelId });
      return ok(`投稿先チャンネルを <#${channelId}> にしました。`);
    }

    case 'schedule_modal': {
      const sendDay = fields.getStringSelectValues('day')[0];
      const input = fields.getTextInputValue('time');
      const sendTime = parseTime(input);
      if (!normalizeDay(sendDay)) return ng('曜日を選択してください。');
      if (!sendTime) return ng(`「${input}」は時刻として読み取れませんでした。09:00 のように入力してください。`);
      await updateSettings(guildId, { sendDay, sendTime });
      return ok(`投稿日時を「毎週 ${sendDay} ${sendTime}」にしました。`);
    }

    case 'emoji_modal': {
      const emoji = fields.getTextInputValue('emoji').trim();
      if (!emoji) return ng('絵文字を入力してください。');
      await updateSettings(guildId, { emoji });
      return ok(`対象の絵文字を ${emoji} にしました。`);
    }

    case 'limit_modal': {
      const input = toHalfWidthDigits(fields.getTextInputValue('limit').trim());
      const limit = Number(input);
      if (!/^\d+$/.test(input) || limit > MAX_DAILY_PAIR_LIMIT) {
        return ng(`1日の上限は 0〜${MAX_DAILY_PAIR_LIMIT} の整数で入力してください。`);
      }
      await updateSettings(guildId, { dailyPairLimit: limit });
      return ok(limit === 0 ? '同じ相手への1日の上限を「無制限」にしました。' : `同じ相手への1日の上限を ${limit} 回にしました。`);
    }

    case 'mentions_modal': {
      const values = fields.getStringSelectValues('mentions') ?? [];
      await updateSettings(guildId, { countRoles: values.includes('roles'), countEveryone: values.includes('everyone') });
      return ok('記録するメンションを更新しました。');
    }

    case 'excluded_modal': {
      const excludedChannelIds = [...(fields.getSelectedChannels('channels')?.keys() ?? [])];
      await updateSettings(guildId, { excludedChannelIds });
      return ok(excludedChannelIds.length > 0
        ? `除外チャンネルを ${excludedChannelIds.length} 件にしました。`
        : '除外チャンネルをなしにしました。');
    }
  }
  return null;
}

async function handleAdminComponent(interaction) {
  const { customId, guildId } = interaction;

  if (interaction.isModalSubmit()) {
    const status = await saveModal(interaction);
    return showSettingsPanel(interaction, status ?? undefined);
  }

  if (MODALS[customId]) {
    return interaction.showModal(MODALS[customId](await getSettings(guildId)));
  }

  const showReset = step => interaction.update({ components: resetView(step), flags: V2 });

  switch (customId) {
    case 'reset_stats':
      return showReset('choose');
    case 'confirm_reset_total':
      return showReset('total');
    case 'confirm_reset_weekly':
      return showReset('weekly');
    case 'reset_settings':
      return showReset('settings');

    case 'do_reset_total':
      await db.resetTotalStats(guildId);
      return showSettingsPanel(interaction, { kind: 'success', message: '累計データをリセットしました。' });

    case 'do_reset_weekly': {
      // 定期投稿の集計期間（前日までの7日間）と /pia_weekly の期間（今日を含む7日間）の両方を消す
      const from = toDateString(nowJst().startOf('day').subtract(7, 'days'));
      await db.deleteDailyStatsSince(guildId, from);
      return showSettingsPanel(interaction, { kind: 'success', message: '今週のデータをリセットしました。' });
    }

    case 'do_reset_settings':
      await resetSettings(guildId);
      return showSettingsPanel(interaction, { kind: 'success', message: '設定を初期状態に戻しました。' });

    case 'back_to_settings':
      return showSettingsPanel(interaction);
  }
}

// ------------------------
// スラッシュコマンド
// ------------------------

async function handleCommand(interaction) {
  const { commandName, guildId, guild } = interaction;
  const now = nowJst();

  switch (commandName) {
    case 'pia_config': {
      if (!isAdmin(interaction)) {
        return replyNotice(interaction, notAdminMessage(interaction), 'error');
      }
      const components = settingsView(await getSettings(guildId), now, { editable: true });
      return interaction.reply({ components, flags: EPHEMERAL_V2, allowedMentions: NO_PINGS });
    }

    case 'pia_settings': {
      const components = settingsView(await getSettings(guildId), now);
      return interaction.reply({ components, flags: EPHEMERAL_V2, allowedMentions: NO_PINGS });
    }

    case 'pia_help':
      return interaction.reply({ components: helpView(VERSION), flags: EPHEMERAL_V2 });

    case 'pia_check': {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const settings = await getSettings(guildId);
      // Bot がこのチャンネルを見られなくても、appPermissions で権限は分かる
      const channel = interaction.channel ?? await guild.channels.fetch(interaction.channelId).catch(() => null);

      let reportChannel = null;
      if (settings.channelId) {
        const target = await guild.channels.fetch(settings.channelId).catch(() => null);
        const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
        reportChannel = target && me
          ? { found: true, permissions: target.permissionsFor(me) ?? { has: () => false } }
          : { found: false };
      }

      const results = diagnose({
        settings,
        excluded: isExcludedChannel(channel ?? { id: interaction.channelId }, settings.excludedChannelIds),
        channelPermissions: interaction.appPermissions,
        isThread: channel?.isThread?.() ?? false,
        reportChannel
      });
      return interaction.editReply({ components: checkView(results), flags: V2, allowedMentions: NO_PINGS });
    }

    case 'pia_total':
      return replyRanking(interaction, { title: '累計ランキング', emptyMessage: 'まだ記録がありません。' });

    case 'pia_weekly': {
      const period = recentPeriod(now);
      return replyRanking(interaction, {
        title: '直近7日間のランキング',
        subtitle: `集計期間: ${formatPeriod(period)}`,
        ...period,
        emptyMessage: `直近7日間（${formatPeriod(period)}）の記録はありません。`
      });
    }

    case 'pia_monthly':
    case 'pia_yearly': {
      const monthly = commandName === 'pia_monthly';
      const offset = interaction.options.getString('対象') === 'last' ? -1 : 0;
      const period = monthly ? monthPeriod(now, offset) : yearPeriod(now, offset);
      const label = monthly ? period.start.format('YYYY年M月') : period.start.format('YYYY年');
      return replyRanking(interaction, {
        title: `${label}のランキング`,
        subtitle: `集計期間: ${formatPeriod(period)}`,
        ...period,
        emptyMessage: `${label}の記録はありません。`
      });
    }

    case 'pia_me': {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const userId = interaction.user.id;
      const between = period => db.getUserStatsBetween(guildId, userId, toDateString(period.start), toDateString(period.end));
      const [total, year, month, recent, sentTo, receivedFrom] = await Promise.all([
        db.getUserTotal(guildId, userId),
        between(yearPeriod(now)),
        between(monthPeriod(now)),
        between(recentPeriod(now)),
        db.getTopPartners(guildId, userId, 'sent'),
        db.getTopPartners(guildId, userId, 'received')
      ]);
      const nameOf = await resolveNames(guild, [...sentTo, ...receivedFrom].map(row => row.userId));
      const named = list => list.map(row => ({ name: nameOf(row.userId), count: row.count }));

      return interaction.editReply({
        components: meView({
          name: escapeMarkdown(interaction.member?.displayName ?? interaction.user.username),
          periods: [
            { label: '累計', ...total },
            { label: now.format('YYYY年'), ...year },
            { label: now.format('M月'), ...month },
            { label: '直近7日間', ...recent }
          ],
          sentTo: named(sentTo),
          receivedFrom: named(receivedFrom)
        }),
        flags: V2,
        allowedMentions: NO_PINGS
      });
    }
  }
}

async function handleInteraction(interaction) {
  if (!interaction.inGuild()) {
    if (interaction.isRepliable()) await replyNotice(interaction, 'サーバー内で使用してください。', 'error');
    return;
  }

  if (interaction.isChatInputCommand()) return handleCommand(interaction);

  if (interaction.isMessageComponent() || interaction.isModalSubmit()) {
    if (!ADMIN_COMPONENT_IDS.has(interaction.customId)) return;
    if (!isAdmin(interaction)) {
      return replyNotice(interaction, notAdminMessage(interaction), 'error');
    }
    return handleAdminComponent(interaction);
  }
}

client.on(Events.InteractionCreate, async interaction => {
  try {
    await handleInteraction(interaction);
  } catch (err) {
    console.error(`❌ インタラクションの処理に失敗 (${interaction.commandName ?? interaction.customId}):`, err);
    if (!interaction.isRepliable()) return;
    await replyNotice(interaction, 'エラーが発生しました。時間をおいてもう一度お試しください。', 'error').catch(() => {});
  }
});

// ------------------------
// 週次の定期投稿
// ------------------------

async function sendWeeklyReport(guild, settings, now) {
  const channel = await guild.channels.fetch(settings.channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !('threads' in channel)) {
    console.log(`⚠️ [${guild.name}] 送信先チャンネルが見つかりません: ${settings.channelId}`);
    return;
  }

  const period = reportPeriod(now);
  const rows = await db.getStatsBetween(guild.id, toDateString(period.start), toDateString(period.end));

  const msg = await channel.send({ components: weeklyIntroView(period), flags: V2 });
  const thread = await msg.startThread({
    name: `${formatPeriod(period)}の集計`,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneHour
  });

  if (rows.length === 0) {
    const next = nextSendTime(now, settings.sendDay, settings.sendTime);
    const message = `この期間（${formatPeriod(period)}）の記録はありませんでした。` +
      (next ? `\n次回の集計は **${formatDateTime(next)}** に投稿します。` : '');
    await thread.send({ components: noticeView(message, 'info'), flags: V2 });
  } else {
    const pages = await buildRankingMessages(guild, rows, {
      title: '今週のランキング',
      subtitle: `集計期間: ${formatPeriod(period)}`
    });
    for (const components of pages) {
      await thread.send({ components, flags: V2, allowedMentions: NO_PINGS });
    }
  }
  console.log(`✅ [${guild.name}] 週次の集計を投稿しました`);
}

let schedulerRunning = false;

async function runScheduler() {
  if (schedulerRunning || !client.isReady()) return;
  schedulerRunning = true;
  try {
    const now = nowJst();
    const date = toDateString(now);

    for (const settings of await db.getAllSettings()) {
      if (!settings.channelId) continue;
      // 設定時刻ちょうどでなくても、その日のうちに送っていなければ送る（停止中の取りこぼし対策）
      if (!isDueToday(now, settings.sendDay, settings.sendTime)) continue;
      const guild = client.guilds.cache.get(settings.guildId);
      if (!guild) continue;
      // 同じ日に二重投稿しない
      if (!(await db.claimDailySend(settings.guildId, date))) continue;

      try {
        await sendWeeklyReport(guild, settings, now);
      } catch (err) {
        const hint = describeDiscordError(err);
        console.error(`❌ [${guild.name}] 週次の集計投稿に失敗${hint ? `: ${hint}` : ''}`, hint ? '' : err);
      }
    }
  } catch (err) {
    console.error('❌ 定期投稿の確認に失敗:', err);
  } finally {
    schedulerRunning = false;
  }
}

// ------------------------
// ヘルスチェック（Kubernetes の probe 用）
// ------------------------

function startHealthServer() {
  const server = http.createServer(async (req, res) => {
    const respond = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(body);
    };

    if (req.url === '/healthz') {
      // 生存確認：Discord に接続できていれば OK
      return client.isReady() ? respond(200, 'ok') : respond(503, 'discord not ready');
    }
    if (req.url === '/readyz') {
      // 準備完了：Discord と DB の両方に接続できていれば OK
      if (!client.isReady()) return respond(503, 'discord not ready');
      try {
        await db.ping();
        return respond(200, 'ok');
      } catch {
        return respond(503, 'database not ready');
      }
    }
    respond(404, 'not found');
  });
  server.listen(HEALTH_PORT, () => console.log(`✅ ヘルスチェックを :${HEALTH_PORT} で待ち受けています`));
  return server;
}

// ------------------------
// 起動と終了
// ------------------------

async function initDatabase() {
  const maxAttempts = 30;
  for (let attempt = 1; ; attempt++) {
    try {
      await db.init();
      console.log('✅ データベースの準備ができました');
      return;
    } catch (err) {
      if (attempt >= maxAttempts) throw err;
      console.log(`⏳ データベースに接続できません（${attempt}/${maxAttempts}）: ${err.message}`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

const healthServer = startHealthServer();
await initDatabase();
const schedulerTask = cron.schedule('* * * * *', runScheduler, { timezone: TIMEZONE });
await client.login(BOT_TOKEN);

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`🛑 ${signal} を受け取りました。終了します`);
  schedulerTask.stop();
  healthServer.close();
  await client.destroy();
  await db.close();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
