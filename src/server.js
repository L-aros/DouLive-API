const http = require('node:http');
const { fetchRoomEnter } = require('./upstream');
const { normalizeRoom } = require('./normalize');

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const apiKey = process.env.API_KEY || '';

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8'
  });
  response.end(JSON.stringify(payload, null, 2));
}

function getProvidedApiKey(request) {
  const authHeader = request.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }

  const apiKeyHeader = request.headers['x-api-key'];
  if (Array.isArray(apiKeyHeader)) {
    return apiKeyHeader[0] || '';
  }

  return apiKeyHeader || '';
}

function isCallerAuthenticated(request) {
  return Boolean(apiKey) && getProvidedApiKey(request) === apiKey;
}

function getWebRid(requestUrl) {
  const roomByQuery = requestUrl.searchParams.get('web_rid');
  if (roomByQuery) {
    return roomByQuery;
  }

  const match = requestUrl.pathname.match(/^\/api\/room\/([^/]+)$/);
  return match?.[1] || '';
}

function isRoomRoute(pathname) {
  return pathname === '/api/room' || /^\/api\/room\/[^/]+$/.test(pathname);
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url || '/', `http://${request.headers.host}`);

  if (request.method === 'GET' && requestUrl.pathname === '/health') {
    return sendJson(response, 200, {
      ok: true,
      service: 'doulive-api'
    });
  }

  if (request.method === 'GET' && isRoomRoute(requestUrl.pathname)) {
    const authenticated = isCallerAuthenticated(request);
    const webRid = getWebRid(requestUrl);
    const aid = requestUrl.searchParams.get('aid') || undefined;
    const secUid =
      requestUrl.searchParams.get('sec_uid') ||
      requestUrl.searchParams.get('secUid') ||
      requestUrl.searchParams.get('uid') ||
      undefined;
    const proxy = requestUrl.searchParams.get('proxy') || undefined;

    if (!webRid) {
      return sendJson(response, 400, {
        ok: false,
        error: 'Missing web_rid. Use /api/room?web_rid=799834884246 or /api/room/799834884246'
      });
    }

    try {
      const result = await fetchRoomEnter(webRid, {
        aid,
        secUid,
        proxy,
        authenticated
      });
      const cleaned = normalizeRoom(result.payload, webRid, result.upstream);
      return sendJson(response, 200, cleaned);
    } catch (error) {
      return sendJson(response, 502, {
        ok: false,
        error: error.message
      });
    }
  }

  return sendJson(response, 404, {
    ok: false,
    error: 'Not found'
  });
});

server.listen(port, host, () => {
  console.log(`DouLive API listening on http://${host}:${port}`);
  console.log('Use GET /api/room?web_rid=799834884246');
  if (apiKey) {
    console.log('API_KEY set: callers with key get preset proxy; callers without key get direct upstream only');
  } else {
    console.log('No API_KEY set: all callers use direct upstream; set API_KEY to enable preset proxy for authenticated callers');
  }
});
