const http = require('node:http');
const { fetchRoomEnter } = require('./upstream');
const { normalizeRoom } = require('./normalize');

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const accessToken = process.env.ACCESS_TOKEN || '';

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8'
  });
  response.end(JSON.stringify(payload, null, 2));
}

function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function getProvidedToken(request) {
  const authHeader = request.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }

  const tokenHeader = request.headers['x-token'];
  if (Array.isArray(tokenHeader)) {
    return tokenHeader[0] || '';
  }

  return tokenHeader || '';
}

function getRequestAccessContext(request) {
  const providedToken = getProvidedToken(request);
  const tokenConfigured = Boolean(accessToken);
  const tokenProvided = Boolean(providedToken);
  const hasValidToken = tokenConfigured && tokenProvided && providedToken === accessToken;
  const isLocalRequest = isLoopbackAddress(request.socket.remoteAddress || '');

  if (tokenProvided && !hasValidToken) {
    return {
      ok: false,
      status: 401,
      error: 'Unauthorized. Provide a valid token via X-Token or Authorization: Bearer <token>.',
      canUseProxy: false
    };
  }

  return {
    ok: true,
    canUseProxy: hasValidToken,
    isLocalRequest,
    tokenConfigured,
    tokenProvided,
    hasValidToken
  };
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
    const access = getRequestAccessContext(request);
    if (!access.ok) {
      return sendJson(response, access.status, {
        ok: false,
        error: access.error
      });
    }

    const webRid = getWebRid(requestUrl);
    const aid = requestUrl.searchParams.get('aid') || undefined;
    const secUid =
      requestUrl.searchParams.get('sec_uid') ||
      requestUrl.searchParams.get('secUid') ||
      requestUrl.searchParams.get('uid') ||
      undefined;
    const proxy = requestUrl.searchParams.get('proxy') || undefined;

    if (proxy && !access.canUseProxy) {
      return sendJson(response, 403, {
        ok: false,
        error: 'Token required to use proxy features. Without a token, the endpoint is still available but will call the upstream directly.'
      });
    }

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
        proxy: access.canUseProxy ? proxy : '',
        allowProxy: access.canUseProxy
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
  if (accessToken) {
    console.log('Token mode: /api/room is publicly callable, but preset and dynamic proxy features require X-Token or Authorization: Bearer <token>.');
  } else {
    console.log('Token mode: no ACCESS_TOKEN configured, so all requests call the upstream directly and proxy features stay disabled.');
  }
});
