// PostgreSQL へのアクセス
import pg from 'pg';

// DATE 型は 'YYYY-MM-DD' の文字列のまま扱う（Date に変換するとタイムゾーンでずれるため）
pg.types.setTypeParser(pg.types.builtins.DATE, value => value);

const SETTING_COLUMNS = {
  channelId: 'channel_id',
  sendDay: 'send_day',
  sendTime: 'send_time',
  emoji: 'emoji'
};

export function createDb(connectionString) {
  const pool = new pg.Pool({ connectionString, max: 5 });
  pool.on('error', err => console.error('❌ PostgreSQL のコネクションでエラー:', err));

  async function init() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS guild_settings (
        guild_id       TEXT PRIMARY KEY,
        channel_id     TEXT,
        send_day       TEXT,
        send_time      TEXT,
        emoji          TEXT,
        last_sent_date DATE
      );

      CREATE TABLE IF NOT EXISTS stats (
        guild_id TEXT    NOT NULL,
        user_id  TEXT    NOT NULL,
        sent     INTEGER NOT NULL DEFAULT 0,
        received INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS daily_stats (
        guild_id TEXT    NOT NULL,
        user_id  TEXT    NOT NULL,
        date     DATE    NOT NULL,
        sent     INTEGER NOT NULL DEFAULT 0,
        received INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, user_id, date)
      );
    `);
  }

  async function ping() {
    await pool.query('SELECT 1');
  }

  async function close() {
    await pool.end();
  }

  async function withTransaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // ------------------------
  // 記録
  // ------------------------

  /** 送った人 1 回、受け取った人それぞれ 1 回を累計と日別の両方に記録する */
  async function recordAward(guildId, senderId, receiverIds, date) {
    receiverIds = [...new Set(receiverIds)].filter(id => id !== senderId);
    await withTransaction(async client => {
      await client.query(
        `INSERT INTO stats (guild_id, user_id, sent) VALUES ($1, $2, 1)
         ON CONFLICT (guild_id, user_id) DO UPDATE SET sent = stats.sent + 1`,
        [guildId, senderId]
      );
      await client.query(
        `INSERT INTO daily_stats (guild_id, user_id, date, sent) VALUES ($1, $2, $3, 1)
         ON CONFLICT (guild_id, user_id, date) DO UPDATE SET sent = daily_stats.sent + 1`,
        [guildId, senderId, date]
      );
      if (receiverIds.length > 0) {
        await client.query(
          `INSERT INTO stats (guild_id, user_id, received)
           SELECT $1, unnest($2::text[]), 1
           ON CONFLICT (guild_id, user_id) DO UPDATE SET received = stats.received + 1`,
          [guildId, receiverIds]
        );
        await client.query(
          `INSERT INTO daily_stats (guild_id, user_id, date, received)
           SELECT $1, unnest($2::text[]), $3, 1
           ON CONFLICT (guild_id, user_id, date) DO UPDATE SET received = daily_stats.received + 1`,
          [guildId, receiverIds, date]
        );
      }
    });
  }

  /** 累計の送受信数（どちらかが 1 以上の人だけ） */
  async function getTotalStats(guildId) {
    const { rows } = await pool.query(
      `SELECT user_id AS "userId", sent, received
       FROM stats
       WHERE guild_id = $1 AND (sent > 0 OR received > 0)`,
      [guildId]
    );
    return rows;
  }

  /** startDate〜endDate（両端を含む、'YYYY-MM-DD'）の送受信数 */
  async function getStatsBetween(guildId, startDate, endDate) {
    const { rows } = await pool.query(
      `SELECT user_id AS "userId", SUM(sent)::int AS sent, SUM(received)::int AS received
       FROM daily_stats
       WHERE guild_id = $1 AND date BETWEEN $2 AND $3
       GROUP BY user_id
       HAVING SUM(sent) > 0 OR SUM(received) > 0`,
      [guildId, startDate, endDate]
    );
    return rows;
  }

  /** 累計データを消す（日別データは残るので週次集計には影響しない） */
  async function resetTotalStats(guildId) {
    await pool.query('DELETE FROM stats WHERE guild_id = $1', [guildId]);
  }

  /** fromDate（'YYYY-MM-DD'）以降の日別データを消す */
  async function deleteDailyStatsSince(guildId, fromDate) {
    await pool.query('DELETE FROM daily_stats WHERE guild_id = $1 AND date >= $2', [guildId, fromDate]);
  }

  // ------------------------
  // サーバー設定
  // ------------------------

  function toSettings(row) {
    if (!row) return null;
    return {
      guildId: row.guild_id,
      channelId: row.channel_id,
      sendDay: row.send_day,
      sendTime: row.send_time,
      emoji: row.emoji,
      lastSentDate: row.last_sent_date
    };
  }

  async function getSettings(guildId) {
    const { rows } = await pool.query('SELECT * FROM guild_settings WHERE guild_id = $1', [guildId]);
    return toSettings(rows[0]);
  }

  async function getAllSettings() {
    const { rows } = await pool.query('SELECT * FROM guild_settings');
    return rows.map(toSettings);
  }

  /** 設定を部分的に更新する。例: updateSettings(id, { emoji: '👍' }) */
  async function updateSettings(guildId, values) {
    const entries = Object.entries(values).filter(([key]) => key in SETTING_COLUMNS);
    if (entries.length === 0) return;
    const columns = entries.map(([key]) => SETTING_COLUMNS[key]);
    const params = entries.map(([, value]) => value);
    await pool.query(
      `INSERT INTO guild_settings (guild_id, ${columns.join(', ')})
       VALUES ($1, ${columns.map((_, i) => `$${i + 2}`).join(', ')})
       ON CONFLICT (guild_id) DO UPDATE SET ${columns.map(c => `${c} = EXCLUDED.${c}`).join(', ')}`,
      [guildId, ...params]
    );
  }

  async function resetSettings(guildId) {
    await pool.query('DELETE FROM guild_settings WHERE guild_id = $1', [guildId]);
  }

  /**
   * その日の定期投稿をまだしていなければ「送信済み」にして true を返す。
   * 再起動や複数起動で同じ日に二重投稿しないためのもの。
   */
  async function claimDailySend(guildId, date) {
    const { rowCount } = await pool.query(
      `UPDATE guild_settings SET last_sent_date = $2
       WHERE guild_id = $1 AND last_sent_date IS DISTINCT FROM $2`,
      [guildId, date]
    );
    return rowCount === 1;
  }

  return {
    pool,
    init,
    ping,
    close,
    recordAward,
    getTotalStats,
    getStatsBetween,
    resetTotalStats,
    deleteDailyStatsSince,
    getSettings,
    getAllSettings,
    updateSettings,
    resetSettings,
    claimDailySend
  };
}
