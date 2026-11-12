// PostgreSQL へのアクセス
import pg from 'pg';

// DATE 型は 'YYYY-MM-DD' の文字列のまま扱う（Date に変換するとタイムゾーンでずれるため）
pg.types.setTypeParser(pg.types.builtins.DATE, value => value);

const SETTING_COLUMNS = {
  channelId: 'channel_id',
  sendDay: 'send_day',
  sendTime: 'send_time',
  emoji: 'emoji',
  dailyPairLimit: 'daily_pair_limit',
  countRoles: 'count_roles',
  countEveryone: 'count_everyone',
  excludedChannelIds: 'excluded_channel_ids'
};

// 設定が無いサーバーで使う値（以前のバージョンと同じ動き）
export const DEFAULT_SETTINGS = Object.freeze({
  dailyPairLimit: 0,
  countRoles: true,
  countEveryone: true,
  excludedChannelIds: Object.freeze([])
});

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

      -- 誰が誰に何回送ったか（日別）。連投上限と /pia_me の「よく送った相手」に使う
      CREATE TABLE IF NOT EXISTS pair_daily_stats (
        guild_id    TEXT    NOT NULL,
        sender_id   TEXT    NOT NULL,
        receiver_id TEXT    NOT NULL,
        date        DATE    NOT NULL,
        count       INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, sender_id, receiver_id, date)
      );

      ALTER TABLE guild_settings
        ADD COLUMN IF NOT EXISTS daily_pair_limit     INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS count_roles          BOOLEAN NOT NULL DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS count_everyone       BOOLEAN NOT NULL DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS excluded_channel_ids TEXT[]  NOT NULL DEFAULT '{}';
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

  /**
   * 送った人 1 回、受け取った人それぞれ 1 回を累計と日別の両方に記録する。
   * dailyPairLimit が 1 以上なら、同じ相手へはその日その回数までしか数えない。
   * @returns {Promise<{accepted: string[], limited: string[]}>}
   */
  async function recordAward(guildId, senderId, receiverIds, date, dailyPairLimit = 0) {
    receiverIds = [...new Set(receiverIds)].filter(id => id !== senderId);
    return withTransaction(async client => {
      // 相手ごとの回数を増やす。上限に達している相手は増えない（行が返らない）
      const { rows } = await client.query(
        `INSERT INTO pair_daily_stats (guild_id, sender_id, receiver_id, date, count)
         SELECT $1, $2, unnest($3::text[]), $4, 1
         ON CONFLICT (guild_id, sender_id, receiver_id, date)
         DO UPDATE SET count = pair_daily_stats.count + 1
         WHERE $5::int <= 0 OR pair_daily_stats.count < $5::int
         RETURNING receiver_id`,
        [guildId, senderId, receiverIds, date, dailyPairLimit]
      );
      const acceptedSet = new Set(rows.map(row => row.receiver_id));
      const accepted = receiverIds.filter(id => acceptedSet.has(id));
      const limited = receiverIds.filter(id => !acceptedSet.has(id));
      if (accepted.length === 0) return { accepted, limited };
      receiverIds = accepted;

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
      return { accepted, limited };
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

  /** 1 人分の累計 */
  async function getUserTotal(guildId, userId) {
    const { rows } = await pool.query(
      'SELECT sent, received FROM stats WHERE guild_id = $1 AND user_id = $2',
      [guildId, userId]
    );
    return rows[0] ?? { sent: 0, received: 0 };
  }

  /** 1 人分の startDate〜endDate（両端を含む）の送受信数 */
  async function getUserStatsBetween(guildId, userId, startDate, endDate) {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(sent), 0)::int AS sent, COALESCE(SUM(received), 0)::int AS received
       FROM daily_stats
       WHERE guild_id = $1 AND user_id = $2 AND date BETWEEN $3 AND $4`,
      [guildId, userId, startDate, endDate]
    );
    return rows[0];
  }

  /**
   * よく送った相手（direction='sent'）／よくもらった相手（direction='received'）の上位。
   * @returns {Promise<Array<{userId: string, count: number}>>}
   */
  async function getTopPartners(guildId, userId, direction, limit = 3) {
    const [me, other] = direction === 'sent' ? ['sender_id', 'receiver_id'] : ['receiver_id', 'sender_id'];
    const { rows } = await pool.query(
      `SELECT ${other} AS "userId", SUM(count)::int AS count
       FROM pair_daily_stats
       WHERE guild_id = $1 AND ${me} = $2
       GROUP BY ${other}
       ORDER BY count DESC, ${other}
       LIMIT $3`,
      [guildId, userId, limit]
    );
    return rows;
  }

  /**
   * 累計データ（と、よく送った相手の集計・その日の連投カウント）を消す。
   * 日別データは残るので、週次・月間・年間の集計には影響しない。
   */
  async function resetTotalStats(guildId) {
    await withTransaction(async client => {
      await client.query('DELETE FROM stats WHERE guild_id = $1', [guildId]);
      await client.query('DELETE FROM pair_daily_stats WHERE guild_id = $1', [guildId]);
    });
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
      lastSentDate: row.last_sent_date,
      dailyPairLimit: row.daily_pair_limit,
      countRoles: row.count_roles,
      countEveryone: row.count_everyone,
      excludedChannelIds: row.excluded_channel_ids
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
    getUserTotal,
    getUserStatsBetween,
    getTopPartners,
    resetTotalStats,
    deleteDailyStatsSince,
    getSettings,
    getAllSettings,
    updateSettings,
    resetSettings,
    claimDailySend
  };
}
