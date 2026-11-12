// 旧バージョンの deploy-commands.js で特定サーバーに登録したコマンド
// （/pia_setemoji など、今は動かないもの）を削除する。
//
// 使い方:
//   BOT_TOKEN=... GUILD_ID=... npm run clear-guild-commands
import { REST, Routes } from 'discord.js';
import dotenv from 'dotenv';

dotenv.config();

const { BOT_TOKEN, GUILD_ID } = process.env;
if (!BOT_TOKEN || !GUILD_ID) {
  console.error('環境変数 BOT_TOKEN と GUILD_ID を設定してください。');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
const application = await rest.get(Routes.currentApplication());
await rest.put(Routes.applicationGuildCommands(application.id, GUILD_ID), { body: [] });
console.log(`✅ サーバー ${GUILD_ID} に登録されていた旧コマンドを削除しました`);
