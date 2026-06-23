const { StorageBackend } = require('./interface');

let pg;
try {
  pg = require('pg');
} catch {
  // pg not installed - backend will fail at init
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  const raw = typeof value === 'string' ? value.trim() : value;
  if (raw !== '' && /^\d+$/.test(String(raw))) {
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) {
      return new Date(numeric < 1e12 ? numeric * 1000 : numeric);
    }
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toIso(value) {
  const date = toDate(value);
  return date ? date.toISOString() : null;
}

function toNumber(value, fallback = 0) {
  if (value == null || value === '') return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function toJson(value) {
  return value == null ? null : JSON.stringify(value);
}

class PostgresStorage extends StorageBackend {
  constructor(config) {
    super();
    this.kind = 'postgres';
    this.persistent = true;
    this.supportsRawMessagePersistence = true;
    this.config = config;
    this.pool = null;
  }

  async init() {
    if (!pg) throw new Error('pg package not installed. Run: npm install pg');
    this.pool = new pg.Pool({
      connectionString: this.config.databaseUrl,
      max: 10,
      idleTimeoutMillis: 30000,
    });

    const client = await this.pool.connect();
    try {
      await client.query('SELECT 1');
      console.log('[storage:pg] ✅ Connected to PostgreSQL');
    } finally {
      client.release();
    }

    await this._createTables();
    await this._createHypertable();
  }

  async _createTables() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        msg_id      BIGINT PRIMARY KEY,
        room_id     VARCHAR(32) NOT NULL,
        method      VARCHAR(64) NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL,
        user_id     VARCHAR(64),
        user_name   VARCHAR(128),
        content     TEXT,
        extra       JSONB,
        raw         JSONB NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_room_time
        ON messages (room_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_messages_method
        ON messages (method, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_messages_user
        ON messages (user_id, created_at DESC)
        WHERE user_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS sessions (
        room_id     VARCHAR(32) NOT NULL,
        started_at  TIMESTAMPTZ NOT NULL,
        ended_at    TIMESTAMPTZ,
        duration_ms BIGINT,
        msg_count   INTEGER DEFAULT 0,
        gift_count  BIGINT DEFAULT 0,
        gift_value  BIGINT DEFAULT 0,
        like_count  BIGINT DEFAULT 0,
        member_count BIGINT DEFAULT 0,
        peak_online BIGINT DEFAULT 0,
        PRIMARY KEY (room_id, started_at)
      );

      CREATE TABLE IF NOT EXISTS monitored_rooms (
        web_rid         VARCHAR(32) PRIMARY KEY,
        room_id         VARCHAR(32),
        enabled         BOOLEAN NOT NULL DEFAULT TRUE,
        status          VARCHAR(32) NOT NULL DEFAULT 'waiting',
        title           VARCHAR(255),
        owner_name      VARCHAR(128),
        last_checked_at TIMESTAMPTZ,
        last_live_at    TIMESTAMPTZ,
        last_error      TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_monitored_rooms_enabled
        ON monitored_rooms (enabled, updated_at DESC);

      CREATE TABLE IF NOT EXISTS archive_log (
        id          SERIAL PRIMARY KEY,
        room_id     VARCHAR(32) NOT NULL,
        date        DATE NOT NULL,
        file_key    VARCHAR(512) NOT NULL,
        msg_count   INTEGER,
        file_size   BIGINT,
        archived_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (room_id, date)
      );
    `);

    await this.pool.query(`
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS web_rid VARCHAR(32);
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS title VARCHAR(255);
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS owner_name VARCHAR(128);
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS capture_started_at TIMESTAMPTZ;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_updated_at TIMESTAMPTZ;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS is_complete_from_session_start BOOLEAN DEFAULT FALSE;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS status VARCHAR(32);
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS comment_count BIGINT DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS follow_count BIGINT DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS share_count BIGINT DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS digg_count BIGINT DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS current_viewers BIGINT;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS current_viewers_text VARCHAR(128);
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS latest_rank JSONB;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS latest_room_snapshot JSONB;
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_sessions_web_rid_started
        ON sessions (web_rid, started_at DESC);
    `).catch(() => {});

    console.log('[storage:pg] ✅ Tables ready');
  }

  async _createHypertable() {
    try {
      await this.pool.query(`
        SELECT create_hypertable('messages', 'created_at',
          if_not_exists => TRUE,
          migrate_data => TRUE
        );
      `);
      console.log('[storage:pg] ✅ TimescaleDB hypertable enabled');

      await this.pool.query(`
        ALTER TABLE messages SET (
          timescaledb.compress,
          timescaledb.compress_segmentby = 'room_id',
          timescaledb.compress_orderby = 'created_at DESC'
        );
      `).catch(() => {});

      await this.pool.query(`
        SELECT add_compression_policy('messages', INTERVAL '3 days', if_not_exists => TRUE);
      `).catch(() => {});

      console.log('[storage:pg] ✅ Compression policy set (3 days)');
    } catch {
      console.log('[storage:pg] ℹ️  TimescaleDB not available, using regular PostgreSQL');
    }
  }

  _buildMessageExtra(msg) {
    const extra = {};
    if (msg.method === 'WebcastGiftMessage' && msg.gift) extra.gift = msg.gift;
    if (msg.method === 'WebcastLikeMessage') {
      extra.count = msg.count;
      extra.total = msg.total;
    }
    if (msg.method === 'WebcastMemberMessage') extra.memberCount = msg.memberCount;
    if (msg.method === 'WebcastSocialMessage') {
      extra.shareType = msg.shareType;
      extra.followCount = msg.followCount;
    }
    if (msg.method === 'WebcastRoomStatsMessage') extra.stats = msg.stats;
    if (msg.method === 'WebcastRoomRankMessage') {
      extra.ranks = msg.ranks;
      extra.audienceRanks = msg.audienceRanks;
    }
    return extra;
  }

  async save(msg) {
    if (!msg?.msgId) return;

    const createdAt = msg.createTime ? new Date(msg.createTime) : new Date();
    const userId = msg.user?.id || msg.data?.user?.id || null;
    const userName = msg.user?.nickname || msg.data?.user?.nickname || null;
    const extra = this._buildMessageExtra(msg);

    await this.pool.query(`
      INSERT INTO messages (msg_id, room_id, method, created_at, user_id, user_name, content, extra, raw)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (msg_id) DO NOTHING
    `, [
      BigInt(msg.msgId || 0),
      msg.roomId,
      msg.method,
      createdAt,
      userId,
      userName,
      msg.content || null,
      Object.keys(extra).length ? JSON.stringify(extra) : null,
      JSON.stringify(msg),
    ]);
  }

  async saveBatch(msgs) {
    const validMsgs = msgs.filter((msg) => msg?.msgId);
    if (!validMsgs.length) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const msg of validMsgs) {
        const createdAt = msg.createTime ? new Date(msg.createTime) : new Date();
        const userId = msg.user?.id || msg.data?.user?.id || null;
        const userName = msg.user?.nickname || msg.data?.user?.nickname || null;
        const extra = this._buildMessageExtra(msg);

        await client.query(`
          INSERT INTO messages (msg_id, room_id, method, created_at, user_id, user_name, content, extra, raw)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (msg_id) DO NOTHING
        `, [
          BigInt(msg.msgId || 0),
          msg.roomId,
          msg.method,
          createdAt,
          userId,
          userName,
          msg.content || null,
          Object.keys(extra).length ? JSON.stringify(extra) : null,
          JSON.stringify(msg),
        ]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async query(roomId, startDate, endDate, options = {}) {
    const { method, limit = 1000, offset = 0, order = 'DESC' } = options;
    const params = [roomId, startDate, endDate];
    let where = 'room_id = $1 AND created_at >= $2 AND created_at < $3';

    if (method) {
      params.push(method);
      where += ` AND method = $${params.length}`;
    }

    const result = await this.pool.query(`
      SELECT msg_id, room_id, method, created_at, user_id, user_name, content, extra
      FROM messages
      WHERE ${where}
      ORDER BY created_at ${order}
      LIMIT ${parseInt(limit, 10)} OFFSET ${parseInt(offset, 10)}
    `, params);

    return result.rows;
  }

  async getStats(roomId, date) {
    const startDate = new Date(date);
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 1);

    const result = await this.pool.query(`
      SELECT method, COUNT(*) as count
      FROM messages
      WHERE room_id = $1 AND created_at >= $2 AND created_at < $3
      GROUP BY method
    `, [roomId, startDate, endDate]);

    const stats = { roomId, date, messages: 0, byMethod: {} };
    for (const row of result.rows) {
      const count = parseInt(row.count, 10);
      stats.byMethod[row.method] = count;
      stats.messages += count;
    }

    const giftResult = await this.pool.query(`
      SELECT
        COUNT(*) as gift_count,
        COALESCE(SUM((extra->'gift'->>'diamondCount')::int * (extra->'gift'->>'repeatCount')::int), 0) as gift_value
      FROM messages
      WHERE room_id = $1 AND method = 'WebcastGiftMessage'
        AND created_at >= $2 AND created_at < $3
    `, [roomId, startDate, endDate]);

    if (giftResult.rows[0]) {
      stats.giftCount = parseInt(giftResult.rows[0].gift_count, 10);
      stats.giftValue = parseInt(giftResult.rows[0].gift_value, 10);
    }

    const userResult = await this.pool.query(`
      SELECT COUNT(DISTINCT user_id) as unique_users
      FROM messages
      WHERE room_id = $1 AND created_at >= $2 AND created_at < $3
        AND user_id IS NOT NULL
    `, [roomId, startDate, endDate]);

    stats.uniqueUsers = parseInt(userResult.rows[0]?.unique_users || 0, 10);

    const onlineResult = await this.pool.query(`
      SELECT MAX((extra->'stats'->>'total')::int) as peak_online
      FROM messages
      WHERE room_id = $1 AND method = 'WebcastRoomStatsMessage'
        AND created_at >= $2 AND created_at < $3
    `, [roomId, startDate, endDate]);

    stats.peakOnline = parseInt(onlineResult.rows[0]?.peak_online || 0, 10);

    return stats;
  }

  async archive(cutoffDate) {
    const result = await this.pool.query(`
      SELECT room_id, DATE(created_at) as date, COUNT(*) as count
      FROM messages
      WHERE created_at < $1
      GROUP BY room_id, DATE(created_at)
      ORDER BY date
    `, [cutoffDate]);

    return result.rows;
  }

  async getMessagesForArchive(roomId, date) {
    const startDate = new Date(date);
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 1);

    const result = await this.pool.query(`
      SELECT * FROM messages
      WHERE room_id = $1 AND created_at >= $2 AND created_at < $3
      ORDER BY created_at
    `, [roomId, startDate, endDate]);

    return result.rows;
  }

  async deleteArchived(roomId, date) {
    const startDate = new Date(date);
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 1);

    const result = await this.pool.query(`
      DELETE FROM messages
      WHERE room_id = $1 AND created_at >= $2 AND created_at < $3
    `, [roomId, startDate, endDate]);

    return result.rowCount;
  }

  async logArchive(roomId, date, fileKey, msgCount, fileSize) {
    await this.pool.query(`
      INSERT INTO archive_log (room_id, date, file_key, msg_count, file_size)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (room_id, date) DO UPDATE
        SET file_key = $3, msg_count = $4, file_size = $5, archived_at = NOW()
    `, [roomId, date, fileKey, msgCount, fileSize]);
  }

  async prune(retentionDate) {
    const result = await this.pool.query(`
      DELETE FROM messages WHERE created_at < $1
    `, [retentionDate]);
    return result.rowCount;
  }

  async getStorageStats() {
    const result = await this.pool.query(`
      SELECT
        COUNT(*) as total_messages,
        MIN(created_at) as oldest,
        MAX(created_at) as newest,
        pg_size_pretty(pg_total_relation_size('messages')) as table_size
      FROM messages
    `);
    return result.rows[0];
  }

  _mapMonitorRow(row) {
    return {
      webRid: row.web_rid,
      roomId: row.room_id || '',
      enabled: row.enabled !== false,
      status: row.status || 'waiting',
      title: row.title || '',
      ownerName: row.owner_name || '',
      lastCheckedAt: toIso(row.last_checked_at),
      lastLiveAt: toIso(row.last_live_at),
      lastError: row.last_error || '',
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  async listMonitoredRooms() {
    const result = await this.pool.query(`
      SELECT *
      FROM monitored_rooms
      WHERE enabled = TRUE
      ORDER BY created_at ASC
    `);
    return result.rows.map((row) => this._mapMonitorRow(row));
  }

  async upsertMonitoredRoom(record) {
    const result = await this.pool.query(`
      INSERT INTO monitored_rooms (
        web_rid, room_id, enabled, status, title, owner_name,
        last_checked_at, last_live_at, last_error, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      ON CONFLICT (web_rid) DO UPDATE SET
        room_id = EXCLUDED.room_id,
        enabled = EXCLUDED.enabled,
        status = EXCLUDED.status,
        title = EXCLUDED.title,
        owner_name = EXCLUDED.owner_name,
        last_checked_at = EXCLUDED.last_checked_at,
        last_live_at = EXCLUDED.last_live_at,
        last_error = EXCLUDED.last_error,
        updated_at = NOW()
      RETURNING *
    `, [
      record.webRid,
      record.roomId || null,
      record.enabled !== false,
      record.status || 'waiting',
      record.title || null,
      record.ownerName || null,
      toDate(record.lastCheckedAt),
      toDate(record.lastLiveAt),
      record.lastError || null,
    ]);

    return this._mapMonitorRow(result.rows[0]);
  }

  async removeMonitoredRoom(webRid) {
    const result = await this.pool.query(`
      DELETE FROM monitored_rooms WHERE web_rid = $1
    `, [webRid]);
    return result.rowCount > 0;
  }

  _mapSessionRow(row) {
    return {
      webRid: row.web_rid || '',
      roomId: row.room_id,
      sessionStartedAt: toIso(row.started_at),
      captureStartedAt: toIso(row.capture_started_at),
      endedAt: toIso(row.ended_at),
      lastUpdatedAt: toIso(row.last_updated_at),
      isCompleteFromSessionStart: Boolean(row.is_complete_from_session_start),
      status: row.status || 'live',
      title: row.title || '',
      ownerName: row.owner_name || '',
      summary: {
        messageCount: toNumber(row.msg_count),
        commentCount: toNumber(row.comment_count),
        giftCount: toNumber(row.gift_count),
        giftValue: toNumber(row.gift_value),
        likeCount: toNumber(row.like_count),
        memberCount: toNumber(row.member_count),
        followCount: toNumber(row.follow_count),
        shareCount: toNumber(row.share_count),
        diggCount: toNumber(row.digg_count),
        peakOnline: toNumber(row.peak_online),
        currentViewers: row.current_viewers == null ? null : toNumber(row.current_viewers, null),
        currentViewersText: row.current_viewers_text || '',
        latestRank: row.latest_rank || null,
      },
      latestRoomSnapshot: row.latest_room_snapshot || null,
    };
  }

  async getOpenSession(webRid) {
    const result = await this.pool.query(`
      SELECT *
      FROM sessions
      WHERE web_rid = $1 AND ended_at IS NULL
      ORDER BY started_at DESC
      LIMIT 1
    `, [webRid]);

    if (!result.rows[0]) return null;
    return this._mapSessionRow(result.rows[0]);
  }

  async saveSessionSummary(session) {
    const sessionStartedAt = toDate(session.sessionStartedAt);
    const captureStartedAt = toDate(session.captureStartedAt);
    const endedAt = toDate(session.endedAt);
    const lastUpdatedAt = toDate(session.lastUpdatedAt) || new Date();
    if (!session.roomId || !sessionStartedAt) {
      throw new Error('roomId and sessionStartedAt are required to save a session summary');
    }

    const summary = session.summary || {};
    const durationMs = endedAt ? endedAt.getTime() - sessionStartedAt.getTime() : null;

    const result = await this.pool.query(`
      INSERT INTO sessions (
        room_id, started_at, ended_at, duration_ms, msg_count, gift_count, gift_value,
        like_count, member_count, peak_online, web_rid, title, owner_name,
        capture_started_at, last_updated_at, is_complete_from_session_start, status,
        comment_count, follow_count, share_count, digg_count, current_viewers,
        current_viewers_text, latest_rank, latest_room_snapshot
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12, $13,
        $14, $15, $16, $17,
        $18, $19, $20, $21, $22,
        $23, $24, $25
      )
      ON CONFLICT (room_id, started_at) DO UPDATE SET
        ended_at = EXCLUDED.ended_at,
        duration_ms = EXCLUDED.duration_ms,
        msg_count = EXCLUDED.msg_count,
        gift_count = EXCLUDED.gift_count,
        gift_value = EXCLUDED.gift_value,
        like_count = EXCLUDED.like_count,
        member_count = EXCLUDED.member_count,
        peak_online = EXCLUDED.peak_online,
        web_rid = EXCLUDED.web_rid,
        title = EXCLUDED.title,
        owner_name = EXCLUDED.owner_name,
        capture_started_at = EXCLUDED.capture_started_at,
        last_updated_at = EXCLUDED.last_updated_at,
        is_complete_from_session_start = EXCLUDED.is_complete_from_session_start,
        status = EXCLUDED.status,
        comment_count = EXCLUDED.comment_count,
        follow_count = EXCLUDED.follow_count,
        share_count = EXCLUDED.share_count,
        digg_count = EXCLUDED.digg_count,
        current_viewers = EXCLUDED.current_viewers,
        current_viewers_text = EXCLUDED.current_viewers_text,
        latest_rank = EXCLUDED.latest_rank,
        latest_room_snapshot = EXCLUDED.latest_room_snapshot
      RETURNING *
    `, [
      session.roomId,
      sessionStartedAt,
      endedAt,
      durationMs,
      toNumber(summary.messageCount),
      toNumber(summary.giftCount),
      toNumber(summary.giftValue),
      toNumber(summary.likeCount),
      toNumber(summary.memberCount),
      toNumber(summary.peakOnline),
      session.webRid || null,
      session.title || null,
      session.ownerName || null,
      captureStartedAt,
      lastUpdatedAt,
      Boolean(session.isCompleteFromSessionStart),
      session.status || 'live',
      toNumber(summary.commentCount),
      toNumber(summary.followCount),
      toNumber(summary.shareCount),
      toNumber(summary.diggCount),
      summary.currentViewers == null ? null : toNumber(summary.currentViewers, null),
      summary.currentViewersText || null,
      toJson(summary.latestRank),
      toJson(session.latestRoomSnapshot),
    ]);

    return this._mapSessionRow(result.rows[0]);
  }

  async close() {
    if (this.pool) {
      await this.pool.end();
      console.log('[storage:pg] Connection pool closed');
    }
  }
}

module.exports = { PostgresStorage };
