const { PostgresStorage } = require('./postgres');

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  const raw = typeof value === 'string' ? value.trim() : value;
  if (raw !== '' && /^\d+$/.test(String(raw))) {
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) {
      const date = new Date(numeric < 1e12 ? numeric * 1000 : numeric);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function cloneSummary(summary = {}) {
  return {
    messageCount: Number(summary.messageCount || 0),
    commentCount: Number(summary.commentCount || 0),
    giftCount: Number(summary.giftCount || 0),
    giftValue: Number(summary.giftValue || 0),
    likeCount: Number(summary.likeCount || 0),
    memberCount: Number(summary.memberCount || 0),
    followCount: Number(summary.followCount || 0),
    shareCount: Number(summary.shareCount || 0),
    diggCount: Number(summary.diggCount || 0),
    peakOnline: Number(summary.peakOnline || 0),
    currentViewers: summary.currentViewers == null ? null : Number(summary.currentViewers || 0),
    currentViewersText: summary.currentViewersText || '',
    latestRank: summary.latestRank || null,
  };
}

class MemoryStorage {
  constructor() {
    this.kind = 'memory';
    this.persistent = false;
    this.supportsRawMessagePersistence = false;
    this.monitors = new Map();
    this.sessions = new Map();
  }

  async init() {
    console.log('[storage] ℹ️ DATABASE_URL not set, using in-memory monitor storage (restart recovery disabled)');
  }

  async listMonitoredRooms() {
    return Array.from(this.monitors.values())
      .filter((item) => item.enabled !== false)
      .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  }

  async upsertMonitoredRoom(record) {
    const now = new Date().toISOString();
    const existing = this.monitors.get(record.webRid);
    const next = {
      webRid: record.webRid,
      roomId: record.roomId || existing?.roomId || '',
      enabled: record.enabled !== false,
      status: record.status || existing?.status || 'waiting',
      title: record.title || existing?.title || '',
      ownerName: record.ownerName || existing?.ownerName || '',
      lastCheckedAt: toIso(record.lastCheckedAt) || existing?.lastCheckedAt || null,
      lastLiveAt: toIso(record.lastLiveAt) || existing?.lastLiveAt || null,
      lastError: record.lastError || existing?.lastError || '',
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    this.monitors.set(record.webRid, next);
    return next;
  }

  async removeMonitoredRoom(webRid) {
    return this.monitors.delete(webRid);
  }

  async getOpenSession(webRid) {
    const sessions = Array.from(this.sessions.values())
      .filter((item) => item.webRid === webRid && !item.endedAt)
      .sort((a, b) => (b.sessionStartedAt || '').localeCompare(a.sessionStartedAt || ''));
    return sessions[0] || null;
  }

  async saveSessionSummary(session) {
    const key = `${session.roomId}:${toIso(session.sessionStartedAt)}`;
    const next = {
      webRid: session.webRid,
      roomId: session.roomId,
      sessionStartedAt: toIso(session.sessionStartedAt),
      captureStartedAt: toIso(session.captureStartedAt),
      endedAt: toIso(session.endedAt),
      lastUpdatedAt: toIso(session.lastUpdatedAt),
      isCompleteFromSessionStart: Boolean(session.isCompleteFromSessionStart),
      status: session.status || 'live',
      title: session.title || '',
      ownerName: session.ownerName || '',
      summary: cloneSummary(session.summary),
      latestRoomSnapshot: session.latestRoomSnapshot || null,
    };
    this.sessions.set(key, next);
    return next;
  }

  async close() {}
}

function createStorage(config = {}) {
  const databaseUrl = (config.databaseUrl || process.env.DATABASE_URL || '').trim();
  if (databaseUrl) {
    return new PostgresStorage({ databaseUrl });
  }
  return new MemoryStorage();
}

module.exports = {
  createStorage,
  MemoryStorage,
};
