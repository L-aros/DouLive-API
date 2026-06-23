const WebSocket = require('ws');
const protobuf = require('protobufjs');
const zlib = require('zlib');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { createStorage } = require('./storage');
const { MonitorManager } = require('./monitor-manager');

// ── Config ──────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '1089', 10);
const COOKIE = process.env.DOUYIN_COOKIE || '';
const TOKEN = process.env.ACCESS_TOKEN || '';
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;

// ── Protobuf Setup ──────────────────────────────────────────────────────
let root, PushFrame, Response, Message;

function loadProto() {
  root = protobuf.loadSync(__dirname + '/new_douyin.proto');
  PushFrame = root.lookupType('new_douyin.Webcast.Im.PushFrame');
  Response = root.lookupType('new_douyin.Webcast.Im.Response');
  Message = root.lookupType('new_douyin.Webcast.Im.Message');
  console.log('✅ Protobuf definitions loaded');
}

// ── Signature (X-Bogus) Generation ─────────────────────────────────────
let getSign = null;

function loadSigner() {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
  const sandbox = {
    navigator: { userAgent: UA },
    window: {},
    document: {},
    setTimeout: () => {},
    setInterval: () => {},
    clearTimeout: () => {},
    clearInterval: () => {},
    XMLHttpRequest: class {},
    location: { href: 'https://live.douyin.com' },
    console,
  };
  sandbox.window = sandbox;

  const code = fs.readFileSync(path.join(__dirname, 'webmssdk.js'), 'utf-8');
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  getSign = sandbox.get_sign;
  console.log('✅ X-Bogus signer loaded');
}

function generateSignature(roomId, userUniqueId) {
  const params = [
    'live_id=1', 'aid=6383', 'version_code=180800',
    'webcast_sdk_version=1.0.15', `room_id=${roomId}`,
    'sub_room_id=', 'sub_channel_id=', 'did_rule=3',
    `user_unique_id=${userUniqueId}`, 'device_platform=web',
    'device_type=', 'ac=', 'identity=audience',
  ].join(',');
  const md5 = crypto.createHash('md5').update(params).digest('hex');
  return getSign(md5);
}

// ── Resolve web_rid (e.g. 386395296025) to internal room_id (e.g. 7653887015607454502)
const roomIdCache = new Map();

function resolveRoomId(webRid) {
  return new Promise((resolve, reject) => {
    if (roomIdCache.has(webRid)) return resolve(roomIdCache.get(webRid));

    const url = `https://live.douyin.com/${webRid}`;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
      'Accept-Encoding': 'identity',
    };
    if (getCookie()) headers.Cookie = getCookie();

    https.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        let match = body.match(/"roomId"\s*:\s*"(\d+)"\s*,\s*"web_rid"\s*:\s*"/);
        if (!match) {
          match = body.match(/&quot;roomId&quot;\s*:\s*&quot;(\d+)&quot;/);
        }
        if (!match) {
          const all = body.match(/"roomId"\s*:\s*"(\d{16,})"/g) || [];
          if (all.length > 0) {
            const found = all[0].match(/"(\d{16,})"/);
            if (found) match = [null, found[1]];
          }
        }
        if (match) {
          roomIdCache.set(webRid, match[1]);
          console.log(`[resolve] web_rid=${webRid} → room_id=${match[1]}`);
          resolve(match[1]);
        } else {
          reject(new Error(`Could not resolve room_id for web_rid=${webRid}`));
        }
      });
    }).on('error', reject);
  });
}

// ── Resolve a method name (e.g. "WebcastChatMessage") to its protobuf type
const typeCache = new Map();

function resolveMessageType(method) {
  if (typeCache.has(method)) return typeCache.get(method);
  const typeName = method.replace(/^Webcast/, '');
  try {
    const type = root.lookupType(`new_douyin.Webcast.Im.${typeName}`);
    typeCache.set(method, type);
    return type;
  } catch {
    return null;
  }
}

function cleanUser(user) {
  if (!user) return null;
  return {
    id: user.id?.toString() || user.shortId?.toString() || '',
    nickname: user.nickname || '',
    avatar: user.avatarThumb?.urlList?.[0] || '',
  };
}

function buildWssUrl(roomId, userUniqueId) {
  const signature = generateSignature(roomId, userUniqueId);
  const params = new URLSearchParams({
    app_name: 'douyin_web',
    room_id: roomId,
    compress: 'gzip',
    version_code: '180800',
    webcast_sdk_version: '1.0.15',
    update_version_code: '1.0.15',
    live_id: '1',
    did_rule: '3',
    user_unique_id: userUniqueId,
    identity: 'audience',
    signature,
    device_platform: 'web',
    cookie_enabled: 'true',
    screen_width: '1920',
    screen_height: '1080',
    browser_language: 'zh-CN',
    browser_platform: 'Win32',
    browser_name: 'Mozilla',
    browser_version: '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    browser_online: 'true',
    tz_name: 'Etc/GMT-8',
    host: 'https://live.douyin.com',
    aid: '6383',
    endpoint: 'live_pc',
    support_wrds: '1',
    im_path: '/webcast/im/fetch/',
    need_persist_msg_count: '15',
    heartbeatDuration: '0',
  });
  return `wss://webcast100-ws-web-hl.douyin.com/webcast/im/push/v2/?${params}`;
}

function normalizeTimestamp(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return numeric < 1e12 ? numeric * 1000 : numeric;
}

// ── Storage filter: only these methods are worth persisting
const SAVE_METHODS = new Set([
  'WebcastChatMessage',
  'WebcastGiftMessage',
  'WebcastLikeMessage',
  'WebcastMemberMessage',
  'WebcastSocialMessage',
  'WebcastRoomStatsMessage',
  'WebcastRoomRankMessage',
  'WebcastEmojiChatMessage',
  'WebcastScreenChatMessage',
  'WebcastFansclubMessage',
]);

function parseMessagePayload(method, payload) {
  const type = resolveMessageType(method);
  if (!type) return { method, _raw: true };

  const decoded = type.decode(payload);
  const obj = type.toObject(decoded, { longs: String, enums: String, bytes: String });
  const common = obj.common || {};

  const result = {
    method,
    msgId: common.msgId?.toString(),
    roomId: common.roomId?.toString(),
    createTime: normalizeTimestamp(common.createTime),
    storable: SAVE_METHODS.has(method),
  };

  switch (method) {
    case 'WebcastChatMessage':
      result.user = cleanUser(obj.user);
      result.content = obj.content || '';
      break;

    case 'WebcastGiftMessage':
      result.user = cleanUser(obj.user);
      result.gift = {
        id: obj.giftId?.toString(),
        name: obj.gift?.name || '',
        diamondCount: obj.gift?.diamondCount || 0,
        repeatCount: obj.repeatCount || 1,
        comboCount: obj.comboCount || 1,
        totalCount: obj.totalCount || 0,
        groupId: obj.groupId ? String(obj.groupId) : '',
        repeatEnd: Boolean(obj.repeatEnd),
      };
      break;

    case 'WebcastLikeMessage':
      result.user = cleanUser(obj.user);
      result.count = obj.count || 0;
      result.total = obj.total || 0;
      break;

    case 'WebcastMemberMessage':
      result.user = cleanUser(obj.user);
      result.memberCount = obj.memberCount || 0;
      result.action = obj.action || 0;
      break;

    case 'WebcastSocialMessage':
      result.user = cleanUser(obj.user);
      result.action = obj.action || 0;
      result.shareType = obj.shareType || 0;
      result.shareTarget = obj.shareTarget || '';
      result.followCount = obj.followCount || 0;
      result.shareTotalCount = obj.shareTotalCount || 0;
      break;

    case 'WebcastRoomStatsMessage':
      result.stats = {
        total: obj.total?.toString() || '0',
        displayValue: obj.displayValue == null ? null : Number(obj.displayValue),
        displayShort: obj.displayShort || '',
        displayMiddle: obj.displayMiddle || '',
        displayLong: obj.displayLong || '',
      };
      break;

    case 'WebcastControlMessage':
      result.action = obj.action || 0;
      result.tips = obj.tips || '';
      if (obj.action === 3) result.liveEnded = true;
      break;

    case 'WebcastRoomRankMessage':
      result.ranks = (obj.ranks || []).map((rank) => ({
        user: cleanUser(rank.user),
        score: rank.scoreStr || '0',
      }));
      if (obj.audienceRanks) {
        result.audienceRanks = {
          score: obj.audienceRanks.score?.toString() || '0',
          rank: obj.audienceRanks.rank || 0,
          scoreDescription: obj.audienceRanks.scoreDescription || '',
          exactlyScore: obj.audienceRanks.exactlyScore || '',
          gapDescription: obj.audienceRanks.gapDescription || '',
        };
      }
      break;

    default:
      result.data = obj;
      break;
  }

  return result;
}

// ── Douyin Upstream Connection (per room) ───────────────────────────────
class DouyinUpstream {
  constructor(webRid, onMessage, onStatus) {
    this.webRid = webRid;
    this.roomId = null;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.ws = null;
    this.alive = false;
    this.shouldReconnect = true;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.stats = { messages: 0, reconnects: 0, lastMsgAt: null };
    this.userUniqueId = BigInt(Math.floor(Math.random() * 9e18)).toString();
  }

  setRoomId(roomId) {
    if (roomId) {
      this.roomId = roomId;
      roomIdCache.set(this.webRid, roomId);
    }
  }

  async connect() {
    this.shouldReconnect = true;
    if (this.ws) {
      try { this.ws.terminate(); } catch {}
    }

    if (!this.roomId) {
      try {
        this.roomId = await resolveRoomId(this.webRid);
      } catch (err) {
        console.error(`[upstream] ❌ resolve failed: ${err.message}`);
        this.onStatus('resolve_failed');
        this.scheduleReconnect();
        return;
      }
    }

    const url = buildWssUrl(this.roomId, this.userUniqueId);
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
      Origin: 'https://live.douyin.com',
    };
    if (getCookie()) headers.Cookie = getCookie();

    this.ws = new WebSocket(url, { headers });
    this.alive = true;

    this.ws.on('open', () => {
      this.reconnectAttempt = 0;
      this.onStatus('connected');
      console.log(`[upstream] ✅ web_rid=${this.webRid} room_id=${this.roomId} connected`);
    });

    this.ws.on('message', (data) => {
      this.handleRawMessage(data);
    });

    this.ws.on('close', (code) => {
      this.alive = false;
      this.onStatus('disconnected');
      console.log(`[upstream] ⚠️ web_rid=${this.webRid} closed code=${code}`);
      if (this.shouldReconnect) {
        this.roomId = null;
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err) => {
      console.error(`[upstream] ❌ web_rid=${this.webRid} error: ${err.message}`);
    });
  }

  handleRawMessage(data) {
    try {
      const frame = PushFrame.decode(new Uint8Array(data));
      if (frame.payloadType !== 'msg') return;

      const isGzip = frame.headers?.some((header) => header.key === 'compress_type' && header.value === 'gzip')
        || frame.payloadEncoding === 'gzip';
      const decompressed = isGzip
        ? zlib.gunzipSync(Buffer.from(frame.payload))
        : Buffer.from(frame.payload);

      const response = Response.decode(new Uint8Array(decompressed));
      if (response.needAck) {
        this.sendAck(frame, response);
      }

      for (const msg of response.messages || []) {
        const parsed = parseMessagePayload(msg.method, msg.payload);
        this.stats.messages++;
        this.stats.lastMsgAt = Date.now();
        this.onMessage(parsed);
      }
    } catch {
      // malformed frames are ignored
    }
  }

  sendAck(frame, response) {
    try {
      const ackFrame = PushFrame.create({
        SeqID: frame.seqID || 0,
        LogID: frame.logID || 0,
        service: 2,
        method: 2,
        payloadType: 'ack',
        payload: Buffer.from([]),
        headers: [
          { key: 'ack.type', value: 'seq' },
          { key: 'ack.cursor', value: response.cursor || '' },
          { key: 'ack.internal_ext', value: response.internalExt || '' },
        ],
      });
      const encoded = PushFrame.encode(ackFrame).finish();
      this.ws.send(encoded);
    } catch {}
  }

  scheduleReconnect() {
    if (!this.shouldReconnect || this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt), RECONNECT_MAX_MS);
    this.reconnectAttempt++;
    this.stats.reconnects++;
    console.log(`[upstream] 🔄 web_rid=${this.webRid} reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  close() {
    this.shouldReconnect = false;
    this.alive = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.terminate(); } catch {}
      this.ws = null;
    }
  }
}

// ── HTTP Helpers ─────────────────────────────────────────────────────────
function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload, null, 2));
}

function getProvidedToken(request, requestUrl) {
  const queryToken = requestUrl.searchParams.get('token');
  if (queryToken) return queryToken.trim();

  const authHeader = request.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }

  const tokenHeader = request.headers['x-token'];
  if (Array.isArray(tokenHeader)) return tokenHeader[0] || '';
  return tokenHeader || '';
}

function ensureAuthorized(request, requestUrl) {
  if (!TOKEN) return { ok: true };
  const providedToken = getProvidedToken(request, requestUrl);
  if (providedToken && providedToken === TOKEN) return { ok: true };
  return {
    ok: false,
    status: 401,
    error: 'Unauthorized. Provide a valid token via X-Token, Authorization: Bearer <token>, or ?token=...'
  };
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body too large'));
        request.destroy();
      }
    });
    request.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${err.message}`));
      }
    });
    request.on('error', reject);
  });
}

function getMonitorWebRid(body = {}) {
  return String(body.webRid || body.web_rid || body.roomId || body.room_id || '').trim();
}

// ── Main Server ─────────────────────────────────────────────────────────
loadProto();
loadSigner();

const storage = createStorage();
const monitorManager = new MonitorManager({
  storage,
  createUpstream: (webRid, onMessage, onStatus) => new DouyinUpstream(webRid, onMessage, onStatus),
});

const server = http.createServer((request, response) => {
  handleHttpRequest(request, response).catch((error) => {
    console.error('[http] ❌', error.message);
    sendJson(response, 500, { ok: false, error: error.message });
  });
});

const wss = new WebSocket.Server({ server });

async function handleHttpRequest(request, response) {
  const requestUrl = new URL(request.url || '/', 'http://localhost');

  if (request.method === 'GET' && requestUrl.pathname === '/health') {
    return sendJson(response, 200, {
      ok: true,
      service: 'douyin-wss',
      monitors: monitorManager.listMonitors().length,
      storage: {
        mode: storage.kind,
        persistent: Boolean(storage.persistent),
      },
    });
  }

  if (requestUrl.pathname.startsWith('/api/monitors')) {
    const access = ensureAuthorized(request, requestUrl);
    if (!access.ok) {
      return sendJson(response, access.status, { ok: false, error: access.error });
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/monitors') {
      return sendJson(response, 200, {
        ok: true,
        items: monitorManager.listMonitors(),
      });
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/monitors') {
      const body = await readJsonBody(request);
      const webRid = getMonitorWebRid(body);
      if (!webRid) {
        return sendJson(response, 400, {
          ok: false,
          error: 'Missing webRid. Send { "webRid": "386395296025" }',
        });
      }
      const saved = await monitorManager.registerRoom(webRid);
      return sendJson(response, saved.created ? 201 : 200, {
        ok: true,
        created: saved.created,
        item: saved.item,
      });
    }

    const detailMatch = requestUrl.pathname.match(/^\/api\/monitors\/([^/]+)$/);
    if (request.method === 'GET' && detailMatch) {
      const item = await monitorManager.getMonitor(detailMatch[1]);
      if (!item) {
        return sendJson(response, 404, { ok: false, error: 'Monitor not found' });
      }
      return sendJson(response, 200, { ok: true, item });
    }

    if (request.method === 'DELETE' && detailMatch) {
      const removed = await monitorManager.unregisterRoom(detailMatch[1]);
      if (!removed.removed) {
        return sendJson(response, 404, { ok: false, error: 'Monitor not found' });
      }
      return sendJson(response, 200, {
        ok: true,
        removed: true,
        item: removed.item,
      });
    }

    const statsMatch = requestUrl.pathname.match(/^\/api\/monitors\/([^/]+)\/stats$/);
    if (request.method === 'GET' && statsMatch) {
      const stats = await monitorManager.getCurrentStats(statsMatch[1]);
      if (!stats) {
        return sendJson(response, 404, { ok: false, error: 'Monitor not found' });
      }
      return sendJson(response, 200, { ok: true, item: stats });
    }
  }

  return sendJson(response, 404, {
    ok: false,
    error: 'Not found',
  });
}

wss.on('connection', (clientWs, req) => {
  const requestUrl = new URL(req.url || '/', 'http://localhost');
  const token = requestUrl.searchParams.get('token') || '';
  if (TOKEN && token !== TOKEN) {
    clientWs.close(4003, 'Invalid or missing token');
    return;
  }

  const match = requestUrl.pathname.match(/^\/ws\/(\d+)$/);
  if (!match) {
    clientWs.close(4001, 'Expected /ws/{webRid}');
    return;
  }

  const webRid = match[1];
  console.log(`[client] 🔌 room=${webRid} connected`);

  monitorManager.addClient(webRid, clientWs).then((state) => {
    clientWs.send(JSON.stringify({
      type: 'system',
      event: 'connected',
      room_id: webRid,
      upstream_stats: state.upstream ? state.upstream.stats : null,
      monitor: {
        registered: state.monitored,
        status: state.monitorStatus,
      },
    }));
  }).catch((err) => {
    console.error(`[client] ❌ room=${webRid} attach failed: ${err.message}`);
    clientWs.close(1011, 'Failed to attach room monitor');
  });

  clientWs.on('close', () => {
    monitorManager.removeClient(webRid, clientWs);
    const state = monitorManager.rooms.get(webRid);
    console.log(`[client] 🔌 room=${webRid} disconnected (remaining: ${state?.clients.size || 0})`);
  });

  clientWs.on('error', () => {
    monitorManager.removeClient(webRid, clientWs);
  });
});

// ── Cookie Auto-Refresh ────────────────────────────────────────────────
const COOKIE_REFRESH_MS = 6 * 60 * 60 * 1000;

function getCookie() {
  return globalThis._freshCookie || COOKIE;
}

function refreshCookie() {
  return new Promise((resolve) => {
    const options = {
      hostname: 'live.douyin.com',
      path: '/',
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        'Accept-Encoding': 'identity',
      },
    };

    https.get(options, (res) => {
      const cookies = res.headers['set-cookie'] || [];
      const ttwidCookie = cookies.find((item) => item.startsWith('ttwid='));
      if (!ttwidCookie) {
        console.log('[cookie] ⚠️ 未获取到 ttwid');
        resolve(false);
        return;
      }

      const newTtwid = ttwidCookie.split(';')[0];
      const currentCookie = getCookie();
      const currentTtwid = currentCookie.match(/ttwid=[^;]+/)?.[0];
      if (newTtwid === currentTtwid) {
        console.log('[cookie] ✅ ttwid 未变化，无需更新');
        resolve(false);
        return;
      }

      const updated = currentTtwid
        ? currentCookie.replace(/ttwid=[^;]+/, newTtwid)
        : `${newTtwid}; ${currentCookie}`;

      process.env.DOUYIN_COOKIE = updated;
      globalThis._freshCookie = updated;

      const envPath = path.join(__dirname, '.env');
      try {
        let env = '';
        if (fs.existsSync(envPath)) {
          env = fs.readFileSync(envPath, 'utf-8');
        }
        if (env.includes('DOUYIN_COOKIE=')) {
          env = env.replace(/DOUYIN_COOKIE=.*/, `DOUYIN_COOKIE=${updated}`);
        } else {
          env = env ? `${env.trimEnd()}\nDOUYIN_COOKIE=${updated}\n` : `DOUYIN_COOKIE=${updated}\n`;
        }
        fs.writeFileSync(envPath, env);
        console.log(`[cookie] ✅ ttwid 已更新: ${newTtwid.slice(0, 40)}...`);
      } catch (err) {
        console.error('[cookie] ❌ 保存 .env 失败:', err.message);
      }

      resolve(true);
    }).on('error', (err) => {
      console.error('[cookie] ❌ 刷新失败:', err.message);
      resolve(false);
    });
  });
}

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, closing services...`);

  await new Promise((resolve) => wss.close(() => resolve()));
  await new Promise((resolve) => server.close(() => resolve()));
  await monitorManager.close();
  process.exit(0);
}

async function start() {
  await monitorManager.init();

  server.listen(PORT, () => {
    console.log(`🚀 douyin-wss listening on :${PORT}`);
    console.log(`   ws://127.0.0.1:${PORT}/ws/{webRid}?token=...`);
    console.log(`   GET  /api/monitors`);
    console.log(`   POST /api/monitors { \"webRid\": \"386395296025\" }`);
    console.log(`   GET  /api/monitors/{webRid}/stats`);
    console.log(`   Storage: ${storage.kind} (${storage.persistent ? 'persistent' : 'ephemeral'})`);
    console.log(`   Internal raw capture: ${monitorManager.rawMessagePersistEnabled ? '✅ enabled' : '⚠️ disabled'}`);
    console.log(`   Cookie: ${COOKIE ? '✅ configured' : '❌ not set'}`);
    console.log(`   Token:  ${TOKEN ? '✅ required' : '⚠️  not set (open access)'}`);
    console.log(`   Cookie auto-refresh: every 6h`);

    refreshCookie().then(() => {
      const timer = setInterval(refreshCookie, COOKIE_REFRESH_MS);
      if (typeof timer.unref === 'function') timer.unref();
    });
  });
}

process.on('SIGINT', () => {
  shutdown('SIGINT').catch((err) => {
    console.error('[shutdown] ❌', err.message);
    process.exit(1);
  });
});

process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch((err) => {
    console.error('[shutdown] ❌', err.message);
    process.exit(1);
  });
});

start().catch((err) => {
  console.error('[startup] ❌', err.message);
  process.exit(1);
});
