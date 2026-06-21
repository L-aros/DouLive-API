import { normalizeRoom } from './normalize.js';
import { fetchRoomEnter } from './upstream.js';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function getProvidedToken(request, parsedUrl) {
  const url = parsedUrl || new URL(request.url);
  const queryToken = url.searchParams.get('token');
  if (queryToken) {
    return queryToken.trim();
  }

  const authHeader = request.headers.get('authorization') || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }

  return request.headers.get('x-token') || '';
}

function getRequestAccessContext(request, env, parsedUrl) {
  const configuredToken = env.ACCESS_TOKEN || '';
  const providedToken = getProvidedToken(request, parsedUrl);
  const tokenConfigured = Boolean(configuredToken);
  const tokenProvided = Boolean(providedToken);
  const hasValidToken = tokenConfigured && tokenProvided && providedToken === configuredToken;

  if (tokenProvided && !hasValidToken) {
    return {
      ok: false,
      status: 401,
      error: 'Unauthorized. Provide a valid token via X-Token or Authorization: Bearer <token>.',
      canUseProxy: false,
    };
  }

  return {
    ok: true,
    canUseProxy: hasValidToken,
    tokenConfigured,
    tokenProvided,
    hasValidToken,
  };
}

function getWebRid(url) {
  const roomByQuery = url.searchParams.get('web_rid');
  if (roomByQuery) {
    return roomByQuery;
  }

  const match = url.pathname.match(/^\/api\/room\/([^/]+)$/);
  return match?.[1] || '';
}

function isRoomRoute(pathname) {
  return pathname === '/api/room' || /^\/api\/room\/[^/]+$/.test(pathname);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && (url.pathname === '/health' || url.pathname === '/api/health')) {
      return jsonResponse({ ok: true, service: 'doulive-api-cloudflare' });
    }

    if (request.method === 'GET' && isRoomRoute(url.pathname)) {
      const access = getRequestAccessContext(request, env, url);
      if (!access.ok) {
        return jsonResponse({ ok: false, error: access.error }, access.status);
      }

      const webRid = getWebRid(url);
      const aid = url.searchParams.get('aid') || undefined;
      const secUid = url.searchParams.get('sec_uid') || url.searchParams.get('secUid') || url.searchParams.get('uid') || undefined;
      const proxy = url.searchParams.get('proxy') || undefined;

      if (proxy && !access.canUseProxy) {
        return jsonResponse({
          ok: false,
          error: 'Token required to use proxy features. Without a token, the endpoint is still available but will call the upstream directly.',
        }, 403);
      }

      if (!webRid) {
        return jsonResponse({
          ok: false,
          error: 'Missing web_rid. Use /api/room?web_rid=799834884246 or /api/room/799834884246',
        }, 400);
      }

      try {
        const result = await fetchRoomEnter(webRid, env, {
          aid,
          secUid,
          proxy: access.canUseProxy ? proxy : '',
          allowProxy: access.canUseProxy,
        });
        const cleaned = normalizeRoom(result.payload, webRid, result.upstream);
        return jsonResponse(cleaned, 200);
      } catch (error) {
        return jsonResponse({ ok: false, error: error.message }, 502);
      }
    }

    return jsonResponse({ ok: false, error: 'Not found' }, 404);
  },
};
