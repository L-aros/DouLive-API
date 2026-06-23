const { fetchRoomEnter } = require('./lib/upstream');
const { normalizeRoom } = require('./lib/normalize');

const DEFAULT_POLL_MS = Math.max(15000, Number(process.env.MONITOR_POLL_MS || 45000));
const DEFAULT_FLUSH_MS = Math.max(2000, Number(process.env.MONITOR_FLUSH_MS || 5000));
const DEFAULT_RAW_BATCH_SIZE = Math.max(20, Number(process.env.RAW_MESSAGE_PERSIST_BATCH_SIZE || 200));
const SNAPSHOT_BACKFILLED_FIELDS = ['likeCount', 'diggCount', 'currentViewers', 'peakOnline'];
const WEBSOCKET_ONLY_FIELDS = ['giftCount', 'giftValue', 'shareCount'];

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

function createSummary() {
  return {
    messageCount: 0,
    commentCount: 0,
    giftCount: 0,
    giftValue: 0,
    likeCount: 0,
    memberCount: 0,
    followCount: 0,
    shareCount: 0,
    diggCount: 0,
    peakOnline: 0,
    currentViewers: null,
    currentViewersText: '',
    latestRank: null,
  };
}

function cloneSummary(summary = {}) {
  return {
    ...createSummary(),
    ...summary,
    currentViewers: summary.currentViewers == null ? null : toNumber(summary.currentViewers, null),
  };
}

function isSameInstant(left, right) {
  return toIso(left) === toIso(right);
}

function buildUnknownRoomStatus(isLive = false) {
  return {
    roomStatus: 'unknown',
    roomStatusCode: null,
    liveStatus: null,
    mosaicStatus: null,
    isLive: Boolean(isLive),
  };
}

function cloneSessionRecord(session, fallbackSnapshot = null) {
  if (!session) return null;
  return {
    webRid: session.webRid || '',
    roomId: session.roomId || '',
    sessionStartedAt: session.sessionStartedAt || null,
    captureStartedAt: session.captureStartedAt || null,
    endedAt: session.endedAt || null,
    lastUpdatedAt: session.lastUpdatedAt || null,
    isCompleteFromSessionStart: Boolean(session.isCompleteFromSessionStart),
    status: session.status || 'unknown',
    title: session.title || '',
    ownerName: session.ownerName || '',
    summary: cloneSummary(session.summary),
    latestRoomSnapshot: session.latestRoomSnapshot || fallbackSnapshot || null,
  };
}

class MonitorManager {
  constructor(options) {
    this.storage = options.storage;
    this.createUpstream = options.createUpstream;
    this.pollMs = options.pollMs || DEFAULT_POLL_MS;
    this.flushMs = options.flushMs || DEFAULT_FLUSH_MS;
    this.rawMessagePersistEnabled = Boolean(
      options.rawMessagePersistEnabled
      ?? (process.env.RAW_MESSAGE_PERSIST_ENABLED || '').toLowerCase() === 'true',
    ) && Boolean(this.storage.supportsRawMessagePersistence);
    this.rawMessagePersistBatchSize = Math.max(20, Number(options.rawMessagePersistBatchSize || DEFAULT_RAW_BATCH_SIZE));
    this.rooms = new Map();
    this.pendingSessions = [];
    this.pendingRawMessages = [];
    this.pollTimer = null;
    this.flushTimer = null;
    this.flushRequested = false;
    this.flushPromise = null;
    this.closing = false;
  }

  async init() {
    await this.storage.init();

    const monitoredRooms = await this.storage.listMonitoredRooms();
    const openSessions = await Promise.all(monitoredRooms.map((monitored) => this.storage.getOpenSession(monitored.webRid)));

    for (let index = 0; index < monitoredRooms.length; index++) {
      const monitored = monitoredRooms[index];
      const openSession = openSessions[index];
      const state = this._getOrCreateRoom(monitored.webRid);
      state.monitored = monitored.enabled !== false;
      state.roomId = monitored.roomId || '';
      state.monitorStatus = monitored.status || 'waiting';
      state.title = monitored.title || '';
      state.ownerName = monitored.ownerName || '';
      state.lastCheckedAt = monitored.lastCheckedAt || null;
      state.lastLiveAt = monitored.lastLiveAt || null;
      state.lastError = monitored.lastError || '';
      state.dirtyMonitor = false;

      if (openSession) {
        state.currentSession = {
          ...openSession,
          summary: cloneSummary(openSession.summary),
          dirty: false,
        };
        state.roomId = state.roomId || openSession.roomId || '';
        state.title = state.title || openSession.title || '';
        state.ownerName = state.ownerName || openSession.ownerName || '';
        state.roomSnapshot = openSession.latestRoomSnapshot || null;
      }
    }

    this._startLoops();
    await this._tickMonitors();
  }

  _startLoops() {
    this.pollTimer = setInterval(() => {
      this._tickMonitors().catch((err) => {
        console.error('[monitor] ❌ poll failed:', err.message);
      });
    }, this.pollMs);
    if (typeof this.pollTimer.unref === 'function') this.pollTimer.unref();

    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => {
        console.error('[monitor] ❌ flush failed:', err.message);
      });
    }, this.flushMs);
    if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref();
  }

  _scheduleFlush() {
    if (this.closing || this.flushRequested) return;
    this.flushRequested = true;
    const timer = setTimeout(() => {
      this.flushRequested = false;
      this.flush().catch((err) => {
        console.error('[monitor] ❌ scheduled flush failed:', err.message);
      });
    }, 0);
    if (typeof timer.unref === 'function') timer.unref();
  }

  _getOrCreateRoom(webRid) {
    let state = this.rooms.get(webRid);
    if (state) return state;

    state = {
      webRid,
      roomId: '',
      monitored: false,
      monitorStatus: 'idle',
      title: '',
      ownerName: '',
      lastCheckedAt: null,
      lastLiveAt: null,
      lastError: '',
      roomSnapshot: null,
      currentSession: null,
      giftCombos: new Map(),
      clients: new Set(),
      upstream: null,
      checking: false,
      dirtyMonitor: false,
      ignoreNextDisconnect: false,
    };
    this.rooms.set(webRid, state);
    return state;
  }

  _shouldKeepRoomActive(state) {
    return state.monitored || state.clients.size > 0;
  }

  _setMonitorStatus(state, status) {
    if (state.monitorStatus !== status) {
      state.monitorStatus = status;
      state.dirtyMonitor = true;
    }
  }

  _markSessionDirty(state) {
    if (state.currentSession) {
      state.currentSession.dirty = true;
    }
  }

  _resetSessionRuntimeState(state) {
    state.giftCombos.clear();
  }

  _buildGiftComboKey(msg) {
    if (!msg.gift?.groupId) return '';
    return [
      msg.roomId || '',
      msg.user?.id || '',
      msg.gift.id || '',
      msg.gift.groupId || '',
    ].join(':');
  }

  _consumeGiftCount(state, msg) {
    const comboKey = this._buildGiftComboKey(msg);
    const repeatCount = Math.max(1, toNumber(msg.gift?.totalCount || msg.gift?.repeatCount || msg.gift?.comboCount, 1));

    if (!comboKey) {
      return repeatCount;
    }

    const previous = toNumber(state.giftCombos.get(comboKey), 0);
    const delta = previous > 0 ? Math.max(0, repeatCount - previous) : (repeatCount > 1 ? 1 : repeatCount);

    if (msg.gift?.repeatEnd) {
      state.giftCombos.delete(comboKey);
    } else {
      state.giftCombos.set(comboKey, Math.max(previous, repeatCount));
      if (state.giftCombos.size > 500) {
        const oldestKey = state.giftCombos.keys().next().value;
        if (oldestKey) state.giftCombos.delete(oldestKey);
      }
    }

    return Math.max(1, delta);
  }

  _enqueueRawMessage(msg) {
    if (!this.rawMessagePersistEnabled || !msg?.storable || !msg?.msgId) {
      return;
    }
    this.pendingRawMessages.push(msg);
    if (this.pendingRawMessages.length >= this.rawMessagePersistBatchSize) {
      this._scheduleFlush();
    }
  }

  _buildMonitorRecord(state) {
    return {
      webRid: state.webRid,
      roomId: state.roomId || '',
      enabled: state.monitored,
      status: state.monitorStatus,
      title: state.title || '',
      ownerName: state.ownerName || '',
      lastCheckedAt: state.lastCheckedAt,
      lastLiveAt: state.lastLiveAt,
      lastError: state.lastError || '',
    };
  }

  _buildRoomPayload(state) {
    if (state.roomSnapshot?.room) {
      return {
        webRid: state.webRid,
        roomId: state.roomSnapshot.room.roomId || state.roomId || '',
        title: state.roomSnapshot.room.title || state.title || '',
        status: state.roomSnapshot.room.status || buildUnknownRoomStatus(Boolean(state.currentSession && !state.currentSession.endedAt)),
      };
    }

    return {
      webRid: state.webRid,
      roomId: state.roomId || '',
      title: state.title || '',
      status: buildUnknownRoomStatus(
        state.monitorStatus === 'live'
          || state.monitorStatus === 'connecting'
          || state.monitorStatus === 'reconnecting'
          || Boolean(state.currentSession && !state.currentSession.endedAt),
      ),
    };
  }

  _buildOwnerPayload(state) {
    if (state.roomSnapshot?.owner) {
      return state.roomSnapshot.owner;
    }

    return {
      id: '',
      secUid: '',
      nickname: state.ownerName || '',
      avatar: '',
      avatars: [],
    };
  }

  _serializeSession(session, servedAt = new Date().toISOString()) {
    if (!session) return null;
    const capturedUntil = session.lastUpdatedAt || null;
    return {
      roomId: session.roomId || '',
      sessionStartedAt: session.sessionStartedAt || null,
      captureStartedAt: session.captureStartedAt || null,
      requestedUntil: servedAt,
      servedAt,
      capturedUntil,
      dataUpdatedAt: capturedUntil,
      endedAt: session.endedAt || null,
      isCompleteFromSessionStart: Boolean(session.isCompleteFromSessionStart),
      status: session.status || 'unknown',
      title: session.title || '',
      ownerName: session.ownerName || '',
      coverage: {
        sessionStartedAt: session.sessionStartedAt || null,
        captureStartedAt: session.captureStartedAt || null,
        requestedUntil: servedAt,
        capturedUntil,
        isCompleteFromSessionStart: Boolean(session.isCompleteFromSessionStart),
        snapshotBackfilledFields: SNAPSHOT_BACKFILLED_FIELDS,
        websocketOnlyFields: WEBSOCKET_ONLY_FIELDS,
      },
      stats: cloneSummary(session.summary),
    };
  }

  serializeMonitor(state) {
    const servedAt = new Date().toISOString();
    const hasOpenSession = Boolean(state.currentSession && !state.currentSession.endedAt);
    const captureActive = Boolean(state.upstream?.alive);

    return {
      webRid: state.webRid,
      roomId: state.roomId || '',
      monitor: {
        registered: state.monitored,
        status: state.monitorStatus,
        clients: state.clients.size,
        captureActive,
        hasOpenSession,
        storagePersistent: Boolean(this.storage.persistent),
        lastCheckedAt: state.lastCheckedAt,
        lastLiveAt: state.lastLiveAt,
        lastError: state.lastError || '',
      },
      room: this._buildRoomPayload(state),
      owner: this._buildOwnerPayload(state),
      session: this._serializeSession(state.currentSession, servedAt),
      upstream: state.upstream ? state.upstream.stats : null,
    };
  }

  listMonitors() {
    return Array.from(this.rooms.values())
      .filter((state) => state.monitored)
      .sort((a, b) => a.webRid.localeCompare(b.webRid))
      .map((state) => this.serializeMonitor(state));
  }

  async getMonitor(webRid) {
    const state = this.rooms.get(webRid);
    if (!state || !state.monitored) {
      return null;
    }
    return this.serializeMonitor(state);
  }

  async registerRoom(webRid) {
    const state = this._getOrCreateRoom(webRid);
    const created = !state.monitored;
    state.monitored = true;
    if (!state.monitorStatus || state.monitorStatus === 'idle') {
      state.monitorStatus = 'waiting';
    }
    state.dirtyMonitor = true;
    await this._persistMonitor(state);
    await this.refreshRoom(webRid, { force: true });
    return {
      created,
      item: this.serializeMonitor(state),
    };
  }

  async unregisterRoom(webRid) {
    const state = this.rooms.get(webRid);
    if (!state || !state.monitored) {
      return { removed: false, item: null };
    }

    state.monitored = false;
    state.dirtyMonitor = false;
    await this.storage.removeMonitoredRoom(webRid);

    if (!this._shouldKeepRoomActive(state)) {
      const item = this.serializeMonitor(state);
      this._teardownRoom(state);
      return { removed: true, item };
    }

    if (!state.upstream) {
      this._setMonitorStatus(state, 'idle');
    }

    return { removed: true, item: this.serializeMonitor(state) };
  }

  async addClient(webRid, clientWs) {
    const state = this._getOrCreateRoom(webRid);
    state.clients.add(clientWs);

    if (state.monitored) {
      if (!state.upstream) {
        await this.refreshRoom(webRid, { force: true });
      }
    } else if (!state.upstream) {
      this._ensureUpstream(state);
    }

    return state;
  }

  removeClient(webRid, clientWs) {
    const state = this.rooms.get(webRid);
    if (!state) return;

    state.clients.delete(clientWs);
    if (!this._shouldKeepRoomActive(state)) {
      this._teardownRoom(state);
    }
  }

  _buildCountsPayload(summary = {}) {
    return {
      chatCount: toNumber(summary.commentCount, 0),
      commentCount: toNumber(summary.commentCount, 0),
      messageCount: toNumber(summary.messageCount, 0),
      giftCount: toNumber(summary.giftCount, 0),
      giftValue: toNumber(summary.giftValue, 0),
      likeCount: toNumber(summary.likeCount, 0),
      followCount: toNumber(summary.followCount, 0),
      shareCount: toNumber(summary.shareCount, 0),
      memberCount: toNumber(summary.memberCount, 0),
      peakOnline: toNumber(summary.peakOnline, 0),
      currentViewers: summary.currentViewers == null ? null : toNumber(summary.currentViewers, null),
    };
  }

  serializePublicStats(state) {
    const servedAt = new Date().toISOString();
    const session = state.currentSession;
    const room = this._buildRoomPayload(state);

    return {
      webRid: state.webRid,
      roomId: room.roomId || state.roomId || '',
      status: state.monitorStatus,
      session: session ? {
        startedAt: session.sessionStartedAt || null,
        capturedAt: session.captureStartedAt || null,
        capturedUntil: session.lastUpdatedAt || null,
        servedAt,
        endedAt: session.endedAt || null,
        isCompleteFromSessionStart: Boolean(session.isCompleteFromSessionStart),
      } : null,
      counts: this._buildCountsPayload(session?.summary || {}),
    };
  }

  async getCurrentStats(webRid) {
    const state = this.rooms.get(webRid);
    if (!state || !state.monitored) {
      return null;
    }
    return this.serializePublicStats(state);
  }

  _broadcastToClients(state, payload) {
    const json = JSON.stringify(payload);
    for (const client of state.clients) {
      if (client.readyState === 1) {
        client.send(json);
      }
    }
  }

  _ensureUpstream(state) {
    if (state.upstream || this.closing) return state.upstream;

    const upstream = this.createUpstream(
      state.webRid,
      (msg) => this._handleUpstreamMessage(state, msg),
      (status) => this._handleUpstreamStatus(state, status),
    );

    if (state.roomId) {
      upstream.setRoomId(state.roomId);
    }

    state.upstream = upstream;
    if (state.monitored) {
      this._setMonitorStatus(state, 'connecting');
    }
    upstream.connect();
    return upstream;
  }

  _closeUpstream(state) {
    if (!state.upstream) return;
    state.ignoreNextDisconnect = true;
    state.upstream.close();
    state.upstream = null;
  }

  _queueFinishedSession(state, session = state.currentSession) {
    const snapshot = cloneSessionRecord(session, state.roomSnapshot);
    if (!snapshot || !snapshot.roomId) return;
    if (!snapshot.endedAt) {
      snapshot.endedAt = snapshot.lastUpdatedAt || new Date().toISOString();
    }
    if (!snapshot.status || snapshot.status === 'live') {
      snapshot.status = 'ended';
    }
    this.pendingSessions.push(snapshot);
  }

  _finalizeCurrentSession(state, endedAt, status = 'ended') {
    if (!state.currentSession || state.currentSession.endedAt) return;
    state.currentSession.endedAt = endedAt;
    state.currentSession.status = status;
    state.currentSession.lastUpdatedAt = endedAt;
    this._markSessionDirty(state);
    this._queueFinishedSession(state, state.currentSession);
    state.currentSession = null;
    this._resetSessionRuntimeState(state);
    this._scheduleFlush();
  }

  _teardownRoom(state) {
    if (state.currentSession) {
      if (!state.currentSession.endedAt) {
        state.currentSession.endedAt = state.currentSession.lastUpdatedAt || new Date().toISOString();
      }
      if (!state.currentSession.status || state.currentSession.status === 'live') {
        state.currentSession.status = 'ended';
      }
      this._queueFinishedSession(state, state.currentSession);
      state.currentSession = null;
    }
    this._resetSessionRuntimeState(state);
    this._closeUpstream(state);
    this.rooms.delete(state.webRid);
    this._scheduleFlush();
  }

  _createSessionFromSnapshot(state, snapshot, nowIso) {
    const sessionStartedAt = toIso(snapshot.time.startTime) || nowIso;
    const captureStartedAt = nowIso;
    const isComplete = Boolean(snapshot.time.startTime) && captureStartedAt <= sessionStartedAt;

    this._resetSessionRuntimeState(state);

    return {
      webRid: state.webRid,
      roomId: snapshot.room.roomId || state.roomId || '',
      sessionStartedAt,
      captureStartedAt,
      endedAt: null,
      lastUpdatedAt: nowIso,
      isCompleteFromSessionStart: isComplete,
      status: 'live',
      title: snapshot.room.title || state.title || '',
      ownerName: snapshot.owner.nickname || state.ownerName || '',
      summary: createSummary(),
      latestRoomSnapshot: snapshot,
      dirty: true,
    };
  }

  _applySnapshotToSession(session, snapshot, nowIso) {
    session.roomId = snapshot.room.roomId || session.roomId || '';
    session.title = snapshot.room.title || session.title || '';
    session.ownerName = snapshot.owner.nickname || session.ownerName || '';
    session.status = snapshot.room.status.isLive ? 'live' : 'ended';
    session.lastUpdatedAt = nowIso;
    session.latestRoomSnapshot = snapshot;

    const viewers = toNumber(snapshot.stats.viewers, 0);
    const likes = toNumber(snapshot.stats.likes, 0);
    const diggs = toNumber(snapshot.stats.diggCount ?? snapshot.stats.likes, 0);
    const giftValue = toNumber(snapshot.stats.money, 0);

    session.summary.commentCount = Math.max(session.summary.commentCount, toNumber(snapshot.stats.commentCount, 0));
    session.summary.giftValue = Math.max(session.summary.giftValue, giftValue);
    session.summary.likeCount = Math.max(session.summary.likeCount, likes);
    session.summary.memberCount = Math.max(session.summary.memberCount, toNumber(snapshot.stats.enterCount, 0));
    session.summary.followCount = Math.max(session.summary.followCount, toNumber(snapshot.stats.followCount, 0));
    session.summary.diggCount = Math.max(session.summary.diggCount, diggs);
    session.summary.peakOnline = Math.max(session.summary.peakOnline, viewers);
    session.summary.currentViewers = viewers || null;
    session.summary.currentViewersText = snapshot.stats.viewersText || snapshot.stats.viewersShort || '';
  }

  _canBackfillExistingSession(state, snapshot, desiredStart) {
    if (!state.currentSession || state.currentSession.endedAt || state.currentSession.isCompleteFromSessionStart) {
      return false;
    }

    const currentStart = toDate(state.currentSession.sessionStartedAt || state.currentSession.captureStartedAt);
    const nextStart = toDate(desiredStart);
    if (!currentStart || !nextStart || nextStart >= currentStart) {
      return false;
    }

    const snapshotRoomId = snapshot?.room?.roomId || '';
    return !snapshotRoomId || !state.currentSession.roomId || snapshotRoomId === state.currentSession.roomId;
  }

  _ensureCurrentSession(state, snapshot, nowIso) {
    const desiredStart = toIso(snapshot?.time?.startTime) || state.currentSession?.sessionStartedAt || nowIso;

    if (this._canBackfillExistingSession(state, snapshot, desiredStart)) {
      state.currentSession.sessionStartedAt = desiredStart;
      state.currentSession.isCompleteFromSessionStart = Boolean(snapshot.time.startTime)
        && state.currentSession.captureStartedAt <= desiredStart;
    }

    const needsNewSession = !state.currentSession
      || Boolean(state.currentSession.endedAt)
      || (snapshot?.room?.roomId && state.currentSession.roomId && snapshot.room.roomId !== state.currentSession.roomId)
      || (!this._canBackfillExistingSession(state, snapshot, desiredStart)
        && !isSameInstant(state.currentSession.sessionStartedAt, desiredStart));

    if (needsNewSession) {
      if (state.currentSession && !state.currentSession.endedAt) {
        this._finalizeCurrentSession(state, nowIso);
      }
      state.currentSession = this._createSessionFromSnapshot(state, snapshot, nowIso);
    }

    this._applySnapshotToSession(state.currentSession, snapshot, nowIso);
    this._markSessionDirty(state);
  }

  _ensureFallbackSession(state, msg, nowIso) {
    if (state.currentSession && !state.currentSession.endedAt) {
      return state.currentSession;
    }

    this._resetSessionRuntimeState(state);

    state.currentSession = {
      webRid: state.webRid,
      roomId: msg.roomId || state.roomId || '',
      sessionStartedAt: nowIso,
      captureStartedAt: nowIso,
      endedAt: null,
      lastUpdatedAt: nowIso,
      isCompleteFromSessionStart: false,
      status: 'live',
      title: state.title || '',
      ownerName: state.ownerName || '',
      summary: createSummary(),
      latestRoomSnapshot: state.roomSnapshot,
      dirty: true,
    };

    return state.currentSession;
  }

  _handleUpstreamMessage(state, msg) {
    const nowIso = new Date().toISOString();
    const session = this._ensureFallbackSession(state, msg, nowIso);
    session.lastUpdatedAt = nowIso;
    session.status = 'live';
    session.roomId = msg.roomId || session.roomId || state.roomId || '';
    state.roomId = session.roomId || state.roomId || '';

    if (msg.storable) {
      session.summary.messageCount += 1;
      this._enqueueRawMessage(msg);
    }

    switch (msg.method) {
      case 'WebcastChatMessage':
      case 'WebcastEmojiChatMessage':
      case 'WebcastScreenChatMessage':
        session.summary.commentCount += 1;
        break;
      case 'WebcastGiftMessage': {
        const giftCount = this._consumeGiftCount(state, msg);
        const diamondCount = toNumber(msg.gift?.diamondCount, 0);
        session.summary.giftCount += giftCount;
        session.summary.giftValue += diamondCount * giftCount;
        break;
      }
      case 'WebcastLikeMessage': {
        const total = toNumber(msg.total, 0);
        if (total > 0) {
          session.summary.likeCount = Math.max(session.summary.likeCount, total);
          session.summary.diggCount = Math.max(session.summary.diggCount, total);
        } else {
          const delta = Math.max(0, toNumber(msg.count, 0));
          session.summary.likeCount += delta;
          session.summary.diggCount += delta;
        }
        break;
      }
      case 'WebcastMemberMessage':
        session.summary.memberCount += 1;
        break;
      case 'WebcastSocialMessage':
        if (toNumber(msg.shareTotalCount, 0) > 0) {
          session.summary.shareCount = Math.max(session.summary.shareCount, toNumber(msg.shareTotalCount, 0));
        } else if (toNumber(msg.followCount, 0) > 0) {
          session.summary.followCount = Math.max(session.summary.followCount, toNumber(msg.followCount, 0));
        } else if (msg.shareTarget || toNumber(msg.shareType, 0) > 0 || toNumber(msg.action, 0) > 1) {
          session.summary.shareCount += 1;
        } else {
          session.summary.followCount += 1;
        }
        break;
      case 'WebcastRoomStatsMessage': {
        const viewers = toNumber(msg.stats?.displayValue ?? msg.stats?.total, 0);
        session.summary.currentViewers = viewers || null;
        session.summary.currentViewersText = msg.stats?.displayLong || msg.stats?.displayShort || '';
        session.summary.peakOnline = Math.max(session.summary.peakOnline, viewers);
        break;
      }
      case 'WebcastRoomRankMessage':
        session.summary.latestRank = {
          updatedAt: nowIso,
          ranks: msg.ranks || [],
          audienceRanks: msg.audienceRanks || null,
        };
        break;
      default:
        break;
    }

    this._markSessionDirty(state);
    this._broadcastToClients(state, msg);

    if (msg.liveEnded) {
      this._handleLiveEnded(state, nowIso);
    }
  }

  _handleUpstreamStatus(state, status) {
    if (status === 'disconnected' && state.ignoreNextDisconnect) {
      state.ignoreNextDisconnect = false;
      return;
    }

    switch (status) {
      case 'connected':
        state.lastError = '';
        state.lastLiveAt = new Date().toISOString();
        this._setMonitorStatus(state, 'live');
        break;
      case 'disconnected':
        if (state.monitored) {
          this._setMonitorStatus(state, 'reconnecting');
        } else {
          this._setMonitorStatus(state, 'disconnected');
        }
        break;
      case 'resolve_failed':
        state.lastError = 'resolve_failed';
        this._setMonitorStatus(state, 'error');
        break;
      default:
        this._setMonitorStatus(state, status);
        break;
    }

    this._broadcastToClients(state, {
      type: 'system',
      event: status,
      room_id: state.webRid,
    });
  }

  _handleLiveEnded(state, nowIso) {
    this._finalizeCurrentSession(state, nowIso);
    state.lastLiveAt = nowIso;
    if (state.monitored) {
      this._setMonitorStatus(state, 'waiting');
    }

    this._closeUpstream(state);
    if (!this._shouldKeepRoomActive(state)) {
      this.rooms.delete(state.webRid);
    }
  }

  async refreshRoom(webRid, options = {}) {
    const state = this._getOrCreateRoom(webRid);
    if (state.checking && !options.force) {
      return this.serializeMonitor(state);
    }

    state.checking = true;
    if (!state.upstream) {
      this._setMonitorStatus(state, 'checking');
    }

    const checkedAt = new Date().toISOString();

    try {
      const result = await fetchRoomEnter(webRid);
      const snapshot = normalizeRoom(result.payload, webRid, result.upstream);
      state.roomSnapshot = snapshot;
      state.roomId = snapshot.room.roomId || state.roomId || '';
      state.title = snapshot.room.title || state.title || '';
      state.ownerName = snapshot.owner.nickname || state.ownerName || '';
      state.lastCheckedAt = checkedAt;
      state.lastError = '';
      state.dirtyMonitor = true;

      if (snapshot.room.status.isLive) {
        this._ensureCurrentSession(state, snapshot, checkedAt);
        state.lastLiveAt = checkedAt;
        if (!state.upstream) {
          this._ensureUpstream(state);
        } else if (state.roomId) {
          state.upstream.setRoomId(state.roomId);
        }
        this._setMonitorStatus(state, state.upstream?.alive ? 'live' : 'connecting');
      } else {
        if (state.currentSession && !state.currentSession.endedAt) {
          this._finalizeCurrentSession(state, checkedAt);
        }
        this._closeUpstream(state);
        this._setMonitorStatus(state, state.monitored ? 'waiting' : 'idle');
      }
    } catch (err) {
      state.lastCheckedAt = checkedAt;
      state.lastError = err.message;
      state.dirtyMonitor = true;
      if (!state.upstream) {
        this._setMonitorStatus(state, 'error');
      }
    } finally {
      state.checking = false;
    }

    return this.serializeMonitor(state);
  }

  async _persistMonitor(state) {
    if (!state.monitored) return null;
    const saved = await this.storage.upsertMonitoredRoom(this._buildMonitorRecord(state));
    state.dirtyMonitor = false;
    return saved;
  }

  async _persistSessionRecord(session) {
    if (!session?.roomId) return null;
    return this.storage.saveSessionSummary(cloneSessionRecord(session));
  }

  async _flushPendingSessions() {
    while (this.pendingSessions.length > 0) {
      const session = this.pendingSessions.shift();
      await this._persistSessionRecord(session);
    }
  }

  async _flushPendingRawMessages() {
    if (!this.rawMessagePersistEnabled || this.pendingRawMessages.length === 0) {
      return;
    }

    while (this.pendingRawMessages.length > 0) {
      const batch = this.pendingRawMessages.splice(0, this.rawMessagePersistBatchSize);
      await this.storage.saveBatch(batch);
    }
  }

  async _persistCurrentSession(state) {
    if (!state.currentSession || !state.currentSession.dirty || !state.currentSession.roomId) {
      return null;
    }
    const saved = await this.storage.saveSessionSummary({
      ...state.currentSession,
      latestRoomSnapshot: state.currentSession.latestRoomSnapshot || state.roomSnapshot || null,
    });
    state.currentSession = {
      ...saved,
      summary: cloneSummary(saved.summary),
      dirty: false,
    };
    return saved;
  }

  async _tickMonitors() {
    if (this.closing) return;
    for (const state of this.rooms.values()) {
      if (!state.monitored) continue;
      if (state.checking) continue;
      if (state.upstream && state.monitorStatus !== 'reconnecting') continue;
      await this.refreshRoom(state.webRid);
    }
  }

  async flush() {
    if (this.flushPromise) {
      return this.flushPromise;
    }

    this.flushPromise = (async () => {
      if (this.closing) return;
      await this._flushPendingSessions();
      for (const state of this.rooms.values()) {
        if (state.monitored && state.dirtyMonitor) {
          await this._persistMonitor(state);
        }
        if (state.currentSession?.dirty) {
          await this._persistCurrentSession(state);
        }
      }
      if (this.rawMessagePersistEnabled) {
        try {
          await this._flushPendingRawMessages();
        } catch (err) {
          console.warn('[monitor] ⚠️ raw message persistence skipped:', err.message);
        }
      }
    })();

    try {
      await this.flushPromise;
    } finally {
      this.flushPromise = null;
    }
  }

  async close() {
    this.closing = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);

    for (const state of this.rooms.values()) {
      this._closeUpstream(state);
      if (state.monitored && state.dirtyMonitor) {
        await this._persistMonitor(state);
      }
      if (state.currentSession?.dirty) {
        await this._persistCurrentSession(state);
      }
    }

    await this._flushPendingSessions();
    if (this.rawMessagePersistEnabled) {
      try {
        await this._flushPendingRawMessages();
      } catch (err) {
        console.warn('[monitor] ⚠️ raw message persistence skipped during shutdown:', err.message);
      }
    }
    await this.storage.close();
  }
}

module.exports = { MonitorManager };
