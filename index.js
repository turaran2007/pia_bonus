import http from 'node:http';
import {
  ActionRowBuilder,
  ActivityType,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  ThreadAutoArchiveDuration
} from 'discord.js';
import dotenv from 'dotenv';
import cron from 'node-cron';
import { collectReceivers, isExcludedChannel } from './src/awards.js';
import { DEFAULT_SETTINGS, createDb } from './src/db.js';
import { rankingLines, splitMessage } from './src/format.js';
import {
  DAYS,
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

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const HEALTH_PORT = Number(process.env.HEALTH_PORT ?? 8080);
const DEFAULT_EMOJI = '🔸';
const MAX_DAILY_PAIR_LIMIT = 100;
// ランキング投稿でメンションによる通知を飛ばさない
const NO_PINGS = { parse: [] };

if (!BOT_TOKEN) {
  console.error('❌ 環境変数 BOT_TOKEN が設定されていません');
  process.exit(1);
}

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
    .setDescription('Pia Botの設定メニューを表示します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
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
  new SlashCommandBuilder().setName('pia_help').setDescription('Pia Botの使い方を表示します'),
  new SlashCommandBuilder().setName('pia_settings').setDescription('現在のBot設定を確認します')
].map(command => command.toJSON());

function updatePresence() {
  client.user?.setPresence({
    activities: [{ name: `${client.guilds.cache.size}つのサーバーで導入中`, type: ActivityType.Playing }],
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
  console.log(`✅ ${readyClient.user.tag} としてログインしました`);
  updatePresence();

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
// 絵文字付きメンションの記録
// ------------------------

client.on(Events.MessageCreate, async message => {
  if (message.author.bot || !message.inGuild()) return;

  try {
    const settings = await getSettings(message.guildId);
    const emoji = settings.emoji;
    if (!emoji || !message.content.includes(emoji)) return;
    if (isExcludedChannel(message.channel, settings.excludedChannelIds)) return;

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
    if (receivers.length === 0) return;

    const { accepted, limited } = await db.recordAward(
      message.guildId, senderId, receivers, toDateString(nowJst()), settings.dailyPairLimit
    );

    let reply;
    if (accepted.length === 0) {
      reply = `<@${senderId}>さん、今日はもう同じ相手への上限（${settings.dailyPairLimit}回）に達しているため、記録しませんでした。`;
    } else {
      reply = accepted.length === 1
        ? `<@${senderId}>さん、記録しました！`
        : `<@${senderId}>さん、${accepted.length}人分を記録しました！`;
      if (limited.length > 0) {
        reply += `\n（${limited.length}人は今日の上限（${settings.dailyPairLimit}回）に達しているため対象外です）`;
      }
    }
    await message.reply(reply).catch(err => console.error('❌ 記録の返信に失敗:', err));
  } catch (err) {
    console.error('❌ メッセージの記録に失敗:', err);
  }
});

// ------------------------
// ランキングの表示
// ------------------------

/** ユーザー ID から表示名を引く。取れなければメンション表記にする */
async function resolveNames(guild, userIds) {
  const missing = userIds.filter(id => !guild.members.cache.has(id));
  if (missing.length > 0) {
    await guild.members.fetch({ user: missing }).catch(() => null);
  }
  return id => guild.members.cache.get(id)?.displayName ?? `<@${id}>`;
}

async function buildRanking(guild, rows, emoji, label, style) {
  const nameOf = await resolveNames(guild, rows.map(row => row.userId));
  const formatLine = style === 'list'
    ? ({ name, count }) => `- ${name}（${emoji} ✕ ${count}）`
    : ({ rank, name, count }) => `${rank}位: ${name} さん　（${emoji} ✕ ${count}）`;
  const header = style === 'list' ? text => `**${text}:**` : text => `==${text}==`;

  return [
    header(`${label}のgiveAward`),
    ...rankingLines(rows, 'sent', nameOf, formatLine),
    '',
    header(`${label}のreceiveAward`),
    ...rankingLines(rows, 'received', nameOf, formatLine)
  ].join('\n');
}

async function replyInChunks(interaction, text) {
  const [first, ...rest] = splitMessage(text);
  await interaction.editReply({ content: first, allowedMentions: NO_PINGS });
  for (const chunk of rest) {
    await interaction.followUp({ content: chunk, allowedMentions: NO_PINGS });
  }
}

// ------------------------
// 設定メニュー
// ------------------------

const CONFIG_COMPONENT_IDS = new Set([
  'set_channel', 'set_emoji', 'set_day', 'set_time', 'preview',
  'reset_stats', 'reset_settings', 'confirm_reset_settings_yes',
  'confirm_reset_total', 'confirm_reset_total_yes',
  'confirm_reset_weekly', 'confirm_reset_weekly_yes', 'cancel_reset',
  'channel_select', 'day_select', 'emoji_modal', 'time_modal',
  'set_limit', 'set_mentions', 'set_excluded', 'limit_modal', 'mentions_select', 'excluded_select'
]);

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
}

function ephemeral(content, extra = {}) {
  return { content, flags: MessageFlags.Ephemeral, ...extra };
}

function settingsSummary(settings) {
  const next = nextSendTime(nowJst(), settings.sendDay, settings.sendTime);
  const mentionTargets = ['ユーザー', settings.countRoles && 'ロール', settings.countEveryone && '@everyone / @here']
    .filter(Boolean).join('、');
  const excluded = settings.excludedChannelIds.length > 0
    ? settings.excludedChannelIds.map(id => `<#${id}>`).join(' ')
    : 'なし';
  return [
    '📝 **現在の設定**',
    `📌 絵文字: ${settings?.emoji || '未設定'}`,
    `📢 チャンネル: ${settings?.channelId ? `<#${settings.channelId}>` : '未設定'}`,
    `⏰ 送信時刻: ${settings?.sendTime || '未設定'}`,
    `📅 曜日: ${normalizeDay(settings?.sendDay) || '未設定'}`,
    `🗓 次回の集計投稿: ${next && settings?.channelId ? formatDateTime(next) : '（チャンネル・曜日・時刻をすべて設定すると投稿されます）'}`,
    `🔁 同じ相手への1日の上限: ${settings.dailyPairLimit > 0 ? `${settings.dailyPairLimit}回` : '無制限'}`,
    `👥 記録するメンション: ${mentionTargets}`,
    `🚫 除外チャンネル: ${excluded}`
  ].join('\n');
}

function formatDateTime(m) {
  return `${m.format('M月D日')}(${DAYS[m.day()][0]}) ${m.format('HH:mm')}`;
}

function confirmRow(yesId, yesLabel) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(yesId).setLabel(yesLabel).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('cancel_reset').setLabel('キャンセル').setStyle(ButtonStyle.Secondary)
  );
}

async function handleConfigComponent(interaction) {
  const { customId, guildId } = interaction;

  switch (customId) {
    case 'set_channel': {
      const row = new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId('channel_select')
          .setPlaceholder('送信先チャンネルを選択してください')
          .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      );
      return interaction.reply(ephemeral('📢 チャンネルを選択してください', { components: [row] }));
    }

    case 'set_emoji': {
      const modal = new ModalBuilder()
        .setCustomId('emoji_modal')
        .setTitle('絵文字設定')
        .addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('emoji_input')
            .setLabel('記録対象の絵文字（例: <:coin:123456>）')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        ));
      return interaction.showModal(modal);
    }

    case 'set_day': {
      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('day_select')
          .setPlaceholder('曜日を選択してください')
          .addOptions(['月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日', '日曜日']
            .map(day => ({ label: day, value: day })))
      );
      return interaction.reply(ephemeral('📅 曜日を選択してください', { components: [row] }));
    }

    case 'set_time': {
      const modal = new ModalBuilder()
        .setCustomId('time_modal')
        .setTitle('送信時刻設定')
        .addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('time_input')
            .setLabel('送信時刻（例: 09:00、日本時間）')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(5)
            .setRequired(true)
        ));
      return interaction.showModal(modal);
    }

    case 'set_limit': {
      const settings = await getSettings(guildId);
      const modal = new ModalBuilder()
        .setCustomId('limit_modal')
        .setTitle('連投の上限')
        .addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('limit_input')
            .setLabel(`同じ相手に1日何回まで数えるか（0 で無制限、最大${MAX_DAILY_PAIR_LIMIT}）`)
            .setStyle(TextInputStyle.Short)
            .setMaxLength(3)
            .setValue(String(settings.dailyPairLimit))
            .setRequired(true)
        ));
      return interaction.showModal(modal);
    }

    case 'set_mentions': {
      const settings = await getSettings(guildId);
      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('mentions_select')
          .setPlaceholder('記録するメンションを選択（ユーザーへの直接メンションは常に記録）')
          .setMinValues(0)
          .setMaxValues(2)
          .addOptions(
            { label: 'ロールへのメンション', value: 'roles', description: 'ロールのメンバー全員に記録', default: settings.countRoles },
            { label: '@everyone / @here', value: 'everyone', description: 'サーバーのメンバー全員に記録', default: settings.countEveryone }
          )
      );
      return interaction.reply(ephemeral('👥 記録するメンションを選んでください（何も選ばなければ、ユーザーへの直接メンションだけを記録します）', { components: [row] }));
    }

    case 'set_excluded': {
      const settings = await getSettings(guildId);
      const row = new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId('excluded_select')
          .setPlaceholder('記録しないチャンネル・カテゴリーを選択')
          .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildCategory)
          .setMinValues(0)
          .setMaxValues(25)
          .setDefaultChannels(settings.excludedChannelIds.slice(0, 25))
      );
      return interaction.reply(ephemeral(
        '🚫 記録しないチャンネルを選んでください（最大25件）。\n' +
        'カテゴリーを選ぶと、その中のチャンネルすべてが対象外になります。スレッドは親チャンネルの設定に従います。\n' +
        '選択をすべて外して確定すると、除外なしに戻ります。',
        { components: [row] }
      ));
    }

    case 'limit_modal': {
      const input = interaction.fields.getTextInputValue('limit_input').trim()
        .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
      const limit = Number(input);
      if (!/^\d+$/.test(input) || limit > MAX_DAILY_PAIR_LIMIT) {
        return interaction.reply(ephemeral(`❌ 0〜${MAX_DAILY_PAIR_LIMIT} の整数で入力してください。`));
      }
      await updateSettings(guildId, { dailyPairLimit: limit });
      return interaction.reply(ephemeral(limit === 0
        ? '🔁 同じ相手への上限を「無制限」にしました'
        : `🔁 同じ相手には1日${limit}回まで記録するようにしました`));
    }

    case 'mentions_select': {
      const countRoles = interaction.values.includes('roles');
      const countEveryone = interaction.values.includes('everyone');
      await updateSettings(guildId, { countRoles, countEveryone });
      const targets = ['ユーザー', countRoles && 'ロール', countEveryone && '@everyone / @here'].filter(Boolean).join('、');
      return interaction.update({ content: `👥 記録するメンションを「${targets}」にしました`, components: [] });
    }

    case 'excluded_select': {
      const excludedChannelIds = [...interaction.values];
      await updateSettings(guildId, { excludedChannelIds });
      return interaction.update({
        content: excludedChannelIds.length > 0
          ? `🚫 除外チャンネルを ${excludedChannelIds.map(id => `<#${id}>`).join(' ')} にしました`
          : '🚫 除外チャンネルをなしにしました',
        components: []
      });
    }

    case 'preview':
      return interaction.reply(ephemeral(settingsSummary(await getSettings(guildId))));

    case 'reset_stats': {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('confirm_reset_total').setLabel('累計データをリセット').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('confirm_reset_weekly').setLabel('今週のデータをリセット').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('cancel_reset').setLabel('キャンセル').setStyle(ButtonStyle.Secondary)
      );
      return interaction.reply(ephemeral('⚠️ **どの統計データをリセットしますか？**', { components: [row] }));
    }

    case 'reset_settings':
      return interaction.reply(ephemeral('⚠️ 本当に **設定** をリセットしますか？', {
        components: [confirmRow('confirm_reset_settings_yes', 'はい、設定をリセットします')]
      }));

    case 'confirm_reset_total':
      return interaction.update({
        content: '⚠️ 本当に **累計データ** をリセットしますか？\n（/pia_weekly と定期投稿の集計には影響しません）',
        components: [confirmRow('confirm_reset_total_yes', 'はい、累計データを削除します')]
      });

    case 'confirm_reset_total_yes':
      await db.resetTotalStats(guildId);
      return interaction.update({ content: '✅ 累計データをリセットしました。', components: [] });

    case 'confirm_reset_weekly':
      return interaction.update({
        content: '⚠️ 本当に **今週のデータ** をリセットしますか？\n（直近8日間の記録を削除します。累計データには影響しません）',
        components: [confirmRow('confirm_reset_weekly_yes', 'はい、今週のデータを削除します')]
      });

    case 'confirm_reset_weekly_yes': {
      // 定期投稿の集計期間（前日までの7日間）と /pia_weekly の期間（今日を含む7日間）の両方を消す
      const from = toDateString(nowJst().startOf('day').subtract(7, 'days'));
      await db.deleteDailyStatsSince(guildId, from);
      return interaction.update({ content: '✅ 今週のデータをリセットしました。', components: [] });
    }

    case 'confirm_reset_settings_yes':
      await resetSettings(guildId);
      return interaction.update({ content: '🧹 設定をリセットしました。', components: [] });

    case 'cancel_reset':
      return interaction.update({ content: '❎ リセットをキャンセルしました。', components: [] });

    case 'channel_select': {
      const channelId = interaction.values[0];
      await updateSettings(guildId, { channelId });
      return interaction.update({ content: `📢 チャンネルを <#${channelId}> に設定しました`, components: [] });
    }

    case 'day_select': {
      const sendDay = interaction.values[0];
      await updateSettings(guildId, { sendDay });
      return interaction.update({ content: `📅 曜日を ${sendDay} に設定しました`, components: [] });
    }

    case 'emoji_modal': {
      const emoji = interaction.fields.getTextInputValue('emoji_input').trim();
      if (!emoji) return interaction.reply(ephemeral('❌ 絵文字を入力してください。'));
      await updateSettings(guildId, { emoji });
      return interaction.reply(ephemeral(`📌 絵文字を ${emoji} に設定しました`));
    }

    case 'time_modal': {
      const input = interaction.fields.getTextInputValue('time_input');
      const sendTime = parseTime(input);
      if (!sendTime) {
        return interaction.reply(ephemeral(`❌ 「${input}」は時刻として読み取れませんでした。09:00 のように入力してください。`));
      }
      await updateSettings(guildId, { sendTime });
      return interaction.reply(ephemeral(`⏰ 送信時刻を ${sendTime} に設定しました`));
    }
  }
}

// ------------------------
// コマンド・ボタンなどの処理
// ------------------------

async function handleCommand(interaction) {
  const { commandName, guildId, guild } = interaction;

  switch (commandName) {
    case 'pia_config': {
      if (!isAdmin(interaction)) {
        return interaction.reply(ephemeral('❌ このコマンドはサーバーの管理者のみ使用できます。'));
      }
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('set_channel').setLabel('チャンネル設定').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('set_emoji').setLabel('絵文字設定').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('set_day').setLabel('曜日設定').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('set_time').setLabel('時刻設定').setStyle(ButtonStyle.Secondary)
      );
      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('preview').setLabel('プレビュー').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('reset_stats').setLabel('記録リセット').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('reset_settings').setLabel('設定リセット').setStyle(ButtonStyle.Secondary)
      );
      const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('set_limit').setLabel('連投の上限').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('set_mentions').setLabel('メンションの対象').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('set_excluded').setLabel('除外チャンネル').setStyle(ButtonStyle.Secondary)
      );
      return interaction.reply(ephemeral('**📋 Pia Bot 設定メニュー**\n以下のボタンから設定を行ってください。', {
        components: [row, row3, row2]
      }));
    }

    case 'pia_help':
      return interaction.reply(ephemeral(
        '📘 **Pia Bot ヘルプガイド**\n\n' +
        '🎁 **使い方**\n' +
        '- 設定した絵文字を入れて相手をメンションすると、送った人と受け取った人の回数が記録されます\n' +
        '- ロールや @everyone へのメンションは、その全員に記録されます（設定で対象外にできます）\n' +
        '- 同じ相手への1日の回数の上限や、記録しないチャンネルを設定できます\n\n' +
        '🛠 **設定方法（管理者のみ）**\n' +
        '- `/pia_config` で設定メニューを表示\n' +
        '- ボタンから「チャンネル」「絵文字」「曜日」「時刻」「連投の上限」「メンションの対象」「除外チャンネル」「記録リセット」「設定リセット」を設定できます\n' +
        '- 設定した曜日・時刻（日本時間）に、前日までの7日間の集計がスレッドに投稿されます\n' +
        '- その時刻に Bot が止まっていても、同じ日のうちに再開すれば投稿されます\n\n' +
        '📊 **情報確認**\n' +
        '- `/pia_total`：累計ランキング\n' +
        '- `/pia_weekly`：直近7日間（今日を含む）のランキング\n' +
        '- `/pia_monthly`：月間ランキング（今月／先月）\n' +
        '- `/pia_yearly`：年間ランキング（今年／去年）\n' +
        '- `/pia_me`：自分の送受信数とよくやり取りする相手\n' +
        '- `/pia_settings`：現在の設定表示'
      ));

    case 'pia_settings':
      return interaction.reply(ephemeral(settingsSummary(await getSettings(guildId))));

    case 'pia_total': {
      await interaction.deferReply();
      const rows = await db.getTotalStats(guildId);
      if (rows.length === 0) return interaction.editReply('統計データがありません。');
      const emoji = (await getSettings(guildId))?.emoji ?? DEFAULT_EMOJI;
      return replyInChunks(interaction, await buildRanking(guild, rows, emoji, '累計', 'rank'));
    }

    case 'pia_weekly': {
      await interaction.deferReply();
      const period = recentPeriod(nowJst());
      const rows = await db.getStatsBetween(guildId, toDateString(period.start), toDateString(period.end));
      if (rows.length === 0) {
        return interaction.editReply(`直近7日間（${formatPeriod(period)}）のデータがありません。`);
      }
      const emoji = (await getSettings(guildId))?.emoji ?? DEFAULT_EMOJI;
      const ranking = await buildRanking(guild, rows, emoji, '今週', 'rank');
      return replyInChunks(interaction, `📊 集計期間: ${formatPeriod(period)}\n\n${ranking}`);
    }

    case 'pia_monthly':
    case 'pia_yearly': {
      await interaction.deferReply();
      const monthly = commandName === 'pia_monthly';
      const offset = interaction.options.getString('対象') === 'last' ? -1 : 0;
      const now = nowJst();
      const period = monthly ? monthPeriod(now, offset) : yearPeriod(now, offset);
      const label = monthly ? period.start.format('YYYY年M月') : period.start.format('YYYY年');
      const rows = await db.getStatsBetween(guildId, toDateString(period.start), toDateString(period.end));
      if (rows.length === 0) return interaction.editReply(`${label}のデータがありません。`);
      const emoji = (await getSettings(guildId)).emoji ?? DEFAULT_EMOJI;
      return replyInChunks(interaction, await buildRanking(guild, rows, emoji, label, 'rank'));
    }

    case 'pia_me': {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const userId = interaction.user.id;
      const now = nowJst();
      const emoji = (await getSettings(guildId)).emoji ?? DEFAULT_EMOJI;
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
      const partnerLines = list => list.length > 0
        ? list.map((row, i) => `${i + 1}. ${nameOf(row.userId)} さん（${emoji} ✕ ${row.count}）`)
        : ['（まだありません）'];
      const line = (label, stats) => `${label}: 送った ${stats.sent} 回 ／ もらった ${stats.received} 回`;

      return interaction.editReply({
        content: [
          `📊 **${interaction.member?.displayName ?? interaction.user.username} さんの記録**`,
          line('累計', total),
          line(`今年（${now.format('YYYY年')}）`, year),
          line(`今月（${now.format('M月')}）`, month),
          line('直近7日間', recent),
          '',
          '📤 **よく送った相手**',
          ...partnerLines(sentTo),
          '',
          '📥 **よくもらった相手**',
          ...partnerLines(receivedFrom)
        ].join('\n'),
        allowedMentions: NO_PINGS
      });
    }
  }
}

async function handleInteraction(interaction) {
  if (!interaction.inGuild()) {
    if (interaction.isRepliable()) await interaction.reply(ephemeral('サーバー内で使用してください。'));
    return;
  }

  if (interaction.isChatInputCommand()) return handleCommand(interaction);

  if (interaction.isMessageComponent() || interaction.isModalSubmit()) {
    if (!CONFIG_COMPONENT_IDS.has(interaction.customId)) return;
    if (!isAdmin(interaction)) {
      return interaction.reply(ephemeral('❌ この操作はサーバーの管理者のみ行えます。'));
    }
    return handleConfigComponent(interaction);
  }
}

client.on(Events.InteractionCreate, async interaction => {
  try {
    await handleInteraction(interaction);
  } catch (err) {
    console.error(`❌ インタラクションの処理に失敗 (${interaction.commandName ?? interaction.customId}):`, err);
    if (!interaction.isRepliable()) return;
    const message = '⚠️ エラーが発生しました。時間をおいてもう一度お試しください。';
    const send = interaction.deferred || interaction.replied
      ? interaction.followUp(ephemeral(message))
      : interaction.reply(ephemeral(message));
    await send.catch(() => {});
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

  const msg = await channel.send(
    'こんにちは！\n今週も皆さんお疲れ様でした\n今週のピアボーナスの結果をスレッドに投稿しました！\nご覧ください！'
  );
  const thread = await msg.startThread({
    name: `${formatPeriod(period)}の集計`,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneHour
  });

  if (rows.length === 0) {
    const next = nextSendTime(now, settings.sendDay, settings.sendTime);
    await thread.send(
      `この期間（${formatPeriod(period)}）の記録はありませんでした。` +
      (next ? `\n次回の集計は **${formatDateTime(next)}** に投稿します。` : '')
    );
  } else {
    const emoji = settings.emoji ?? DEFAULT_EMOJI;
    const content = await buildRanking(guild, rows, emoji, '今週', 'list');
    for (const chunk of splitMessage(content)) {
      await thread.send({ content: chunk, allowedMentions: NO_PINGS });
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
        console.error(`❌ [${guild.name}] 週次の集計投稿に失敗:`, err);
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
