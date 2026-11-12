// 旧バージョンの SQLite（emojiStats.db）のデータを PostgreSQL に移す。
//
// 使い方:
//   npm install --no-save better-sqlite3
//   DATABASE_URL=postgres://... node scripts/migrate-sqlite-to-postgres.js ./emojiStats.db
//
// 同じ人・同じ日のデータは SQLite 側の値で上書きするので、何度実行しても結果は同じ。
import dotenv from 'dotenv';
import { createDb } from '../src/db.js';
import { normalizeDay, parseTime } from '../src/time.js';

dotenv.config();

const sqlitePath = process.argv[2] ?? 'emojiStats.db';

let Database;
try {
  ({ default: Database } = await import('better-sqlite3'));
} catch {
  console.error('better-sqlite3 が必要です。先に `npm install --no-save better-sqlite3` を実行してください。');
  process.exit(1);
}

const sqlite = new Database(sqlitePath, { readonly: true, fileMustExist: true });
const tableExists = name =>
  Boolean(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

const db = createDb(process.env.DATABASE_URL);
await db.init();

const client = await db.pool.connect();
try {
  await client.query('BEGIN');

  let count = 0;
  if (tableExists('stats')) {
    for (const row of sqlite.prepare('SELECT guildId, userId, sent, received FROM stats').all()) {
      await client.query(
        `INSERT INTO stats (guild_id, user_id, sent, received) VALUES ($1, $2, $3, $4)
         ON CONFLICT (guild_id, user_id) DO UPDATE SET sent = EXCLUDED.sent, received = EXCLUDED.received`,
        [row.guildId, row.userId, row.sent ?? 0, row.received ?? 0]
      );
      count++;
    }
  }
  console.log(`stats: ${count} 件`);

  count = 0;
  if (tableExists('daily_stats')) {
    for (const row of sqlite.prepare('SELECT guildId, userId, date, sent, received FROM daily_stats').all()) {
      await client.query(
        `INSERT INTO daily_stats (guild_id, user_id, date, sent, received) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (guild_id, user_id, date) DO UPDATE SET sent = EXCLUDED.sent, received = EXCLUDED.received`,
        [row.guildId, row.userId, String(row.date).slice(0, 10), row.sent ?? 0, row.received ?? 0]
      );
      count++;
    }
  }
  console.log(`daily_stats: ${count} 件`);

  count = 0;
  if (tableExists('guild_settings')) {
    for (const row of sqlite.prepare('SELECT * FROM guild_settings').all()) {
      await client.query(
        `INSERT INTO guild_settings (guild_id, channel_id, send_day, send_time, emoji) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (guild_id) DO UPDATE SET channel_id = EXCLUDED.channel_id, send_day = EXCLUDED.send_day,
           send_time = EXCLUDED.send_time, emoji = EXCLUDED.emoji`,
        [
          row.guildId,
          row.channelId ?? null,
          normalizeDay(row.sendDay),
          row.sendTime ? parseTime(row.sendTime) ?? row.sendTime : null,
          row.emoji ?? null
        ]
      );
      count++;
    }
  }
  console.log(`guild_settings: ${count} 件`);

  await client.query('COMMIT');
  console.log('✅ 移行が完了しました');
} catch (err) {
  await client.query('ROLLBACK');
  console.error('❌ 移行に失敗したため、変更を取り消しました:', err);
  process.exitCode = 1;
} finally {
  client.release();
  sqlite.close();
  await db.close();
}
