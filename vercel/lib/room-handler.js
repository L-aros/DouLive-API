const { fetchRoomEnter } = require('./upstream');
const { normalizeRoom } = require('./normalize');

function sendJson(res, statusCode, payload) {
  res.status(statusCode).setHeader('Cache-Control', 'no-store').json(payload);
}

function getProvidedToken(req) {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }

  const tokenHeader = req.headers['x-token'];
  if (Array.isArray(tokenHeader)) {
    return tokenHeader[0] || '';
  }
  if (tokenHeader) {
    return tokenHeader;
  }

  const legacyApiKeyHeader = req.headers['x-api-key'];
  if (Array.isArray(legacyApiKeyHeader)) {
    return legacyApiKeyHeader[0] || '';
  }

  return legacyApiKeyHeader || '';
}

function getRequestAccessContext(req) {
  const configuredToken = process.env.ACCESS_TOKEN || process.env.API_KEY || '';
  const providedToken = getProvidedToken(req);
  const tokenConfigured = Boolean(configuredToken);
  const tokenProvided = Boolean(providedToken);
  const hasValidToken = tokenConfigured && tokenProvided && providedToken === configuredToken;

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
    tokenConfigured,
    tokenProvided,
    hasValidToken
  };
}

async function handleRoomRequest(req, res, explicitWebRid) {
  if (req.method !== 'GET') {
    return sendJson(res, 405, {
      ok: false,
      error: 'Method not allowed'
    });
  }

  const access = getRequestAccessContext(req);
  if (!access.ok) {
    return sendJson(res, access.status, {
      ok: false,
      error: access.error
    });
  }

  const webRid = explicitWebRid || req.query.web_rid || '';
  const aid = req.query.aid || undefined;
  const secUid = req.query.sec_uid || req.query.secUid || req.query.uid || undefined;
  const proxy = req.query.proxy || undefined;

  if (proxy && !access.canUseProxy) {
    return sendJson(res, 403, {
      ok: false,
      error: 'Token required to use proxy features. Without a token, the endpoint is still available but will call the upstream directly.'
    });
  }

  if (!webRid) {
    return sendJson(res, 400, {
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
    return sendJson(res, 200, cleaned);
  } catch (error) {
    return sendJson(res, 502, {
      ok: false,
      error: error.message
    });
  }
}

module.exports = {
  handleRoomRequest
};
