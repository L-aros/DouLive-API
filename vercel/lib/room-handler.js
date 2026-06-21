const { fetchRoomEnter } = require('./upstream');
const { normalizeRoom } = require('./normalize');

function sendJson(res, statusCode, payload) {
  res.status(statusCode).setHeader('Cache-Control', 'no-store').json(payload);
}

function getProvidedApiKey(req) {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }

  const apiKeyHeader = req.headers['x-api-key'];
  if (Array.isArray(apiKeyHeader)) {
    return apiKeyHeader[0] || '';
  }

  return apiKeyHeader || '';
}

function authorizeApiRequest(req) {
  const configuredApiKey = process.env.API_KEY || '';

  if (!configuredApiKey) {
    return {
      ok: false,
      status: 500,
      error: 'API_KEY is required for the Vercel deployment to avoid exposing the upstream publicly.'
    };
  }

  if (getProvidedApiKey(req) !== configuredApiKey) {
    return {
      ok: false,
      status: 401,
      error: 'Unauthorized. Provide the API key via X-API-Key or Authorization: Bearer <key>.'
    };
  }

  return { ok: true };
}

async function handleRoomRequest(req, res, explicitWebRid) {
  if (req.method !== 'GET') {
    return sendJson(res, 405, {
      ok: false,
      error: 'Method not allowed'
    });
  }

  const auth = authorizeApiRequest(req);
  if (!auth.ok) {
    return sendJson(res, auth.status, {
      ok: false,
      error: auth.error
    });
  }

  const webRid = explicitWebRid || req.query.web_rid || '';
  const aid = req.query.aid || undefined;
  const secUid = req.query.sec_uid || req.query.secUid || req.query.uid || undefined;
  const proxy = req.query.proxy || undefined;

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
      proxy
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
