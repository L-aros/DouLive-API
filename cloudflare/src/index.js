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

function getProvidedApiKey(request) {
  const authHeader = request.headers.get('authorization') || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }

  return request.headers.get('x-api-key') || '';
}

function isCallerAuthenticated(request, env) {
  return Boolean(env.API_KEY) && getProvidedApiKey(request) === env.API_KEY;
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
      const authenticated = isCallerAuthenticated(request, env);
      const webRid = getWebRid(url);
      const aid = url.searchParams.get('aid') || undefined;
      const secUid = url.searchParams.get('sec_uid') || url.searchParams.get('secUid') || url.searchParams.get('uid') || undefined;
      const proxy = url.searchParams.get('proxy') || undefined;

      if (!webRid) {
        return jsonResponse({
          ok: false,
          error: 'Missing web_rid. Use /api/room?web_rid=799834884246 or /api/room/799834884246',
        }, 400);
      }

      try {
        const result = await fetchRoomEnter(webRid, env, { aid, secUid, proxy, authenticated });
        const cleaned = normalizeRoom(result.payload, webRid, result.upstream);
        return jsonResponse(cleaned, 200);
      } catch (error) {
        return jsonResponse({ ok: false, error: error.message }, 502);
      }
    }

    return jsonResponse({ ok: false, error: 'Not found' }, 404);
  },
};
