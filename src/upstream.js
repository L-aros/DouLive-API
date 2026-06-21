const { ProxyAgent } = require('undici');
const { ABogus } = require('./abogus');
const { extractCookieValue, generateNonce, getAcSignature } = require('./signature');

const ROOM_ENTER_URL = 'https://live.douyin.com/webcast/room/web/enter/';
const LIVE_HOME_URL = 'https://live.douyin.com/';
const MOBILE_ROOM_INFO_URL = 'https://webcast.amemv.com/webcast/room/reflow/info/';
const DEFAULT_AID = '6383';
const GUEST_COOKIE_TTL_MS = 6 * 60 * 60 * 1000;
const HTML_NONCE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Edg/148.0.0.0';
const DEFAULT_UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 10000);
const ROOM_HTML_STATE_REGEX = /(\{\\"state\\":.*?)\]\\n"\]\)/;

let guestCookieCache = null;
let htmlNonceCache = null;
let mobileCooldownUntil = 0;

function buildRoomEnterParams(webRid, aid = DEFAULT_AID) {
  const params = new URLSearchParams();

  params.set('aid', String(aid));
  params.set('live_id', '1');
  params.set('device_platform', 'web');
  params.set('language', 'zh-CN');
  params.set('enter_from', 'web_live');
  params.set('cookie_enabled', 'true');
  params.set('screen_width', '1920');
  params.set('screen_height', '1080');
  params.set('browser_language', 'zh-CN');
  params.set('browser_platform', 'Win32');
  params.set('browser_name', 'Edge');
  params.set('browser_version', '148.0.0.0');
  params.set('web_rid', String(webRid));
  params.set('Room-Enter-User-Login-Ab', '0');
  params.set('is_need_double_stream', 'false');

  return params;
}

function resolveProxyValue(options = {}) {
  return (options.proxy || process.env.UPSTREAM_PROXY_URL || '').trim();
}

function isProxyTemplate(proxy) {
  return proxy.includes('{url}') || proxy.includes('{{url}}') || proxy.endsWith('=') || proxy.includes('?url=');
}

function buildProxyTarget(proxy, targetUrl) {
  if (!proxy) {
    return targetUrl;
  }

  if (proxy.includes('{{url}}')) {
    return proxy.replaceAll('{{url}}', encodeURIComponent(targetUrl));
  }

  if (proxy.includes('{url}')) {
    return proxy.replaceAll('{url}', encodeURIComponent(targetUrl));
  }

  return `${proxy}${encodeURIComponent(targetUrl)}`;
}

function parseProxyToUrl(proxy) {
  if (!proxy) return '';

  if (proxy.startsWith('http://') || proxy.startsWith('https://')) {
    return proxy;
  }

  const parts = proxy.split(':');
  if (parts.length === 2) {
    const [host, port] = parts;
    return `http://${host}:${port}`;
  }
  if (parts.length === 4) {
    const [host, port, user, pass] = parts;
    return `http://${user}:${pass}@${host}:${port}`;
  }

  return proxy;
}

function buildRoomEnterRequest(webRid, aid = DEFAULT_AID) {
  const params = buildRoomEnterParams(webRid, aid);
  const abogus = new ABogus(undefined, DEFAULT_USER_AGENT);
  const [signedQuery, signature, userAgent] = abogus.generateAbogus(params.toString(), '');

  return {
    label: 'web+a_bogus',
    url: `${ROOM_ENTER_URL}?${signedQuery}`,
    userAgent: userAgent || DEFAULT_USER_AGENT,
    signature,
  };
}

function buildPlainRoomEnterRequest(webRid, aid = DEFAULT_AID) {
  const params = buildRoomEnterParams(webRid, aid);

  return {
    label: 'web+guest',
    url: `${ROOM_ENTER_URL}?${params.toString()}`,
    userAgent: DEFAULT_USER_AGENT,
    signature: '',
  };
}

function buildHeaders(webRid, cookie, userAgent = DEFAULT_USER_AGENT, extraHeaders = {}) {
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    Referer: `https://live.douyin.com/${webRid}`,
    'User-Agent': userAgent,
    'sec-ch-ua': '"Chromium";v="148", "Microsoft Edge";v="148", "Not/A)Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    ...extraHeaders,
  };

  if (cookie) {
    headers.Cookie = cookie;
  }

  return headers;
}

function getSetCookieHeaders(headers) {
  if (headers && typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }

  const setCookie = headers?.get?.('set-cookie');
  return setCookie ? [setCookie] : [];
}

function toCookieHeader(setCookieHeaders) {
  return setCookieHeaders
    .map((item) => String(item).split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

async function requestText(url, options = {}) {
  const { timeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS, proxy = '', ...fetchOptions } = options;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let requestUrl = url;
  const finalOptions = {
    ...fetchOptions,
    signal: controller.signal,
  };

  if (proxy) {
    if (isProxyTemplate(proxy)) {
      requestUrl = buildProxyTarget(proxy, url);
    } else {
      const proxyUrl = parseProxyToUrl(proxy);
      finalOptions.dispatcher = new ProxyAgent(proxyUrl);
    }
  }

  try {
    const response = await fetch(requestUrl, finalOptions);
    const text = await response.text();

    return {
      response,
      text,
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Upstream request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function parsePayload(text, response) {
  if (!text) {
    throw new Error(`Upstream returned an empty response body with status ${response.status}`);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Failed to parse upstream JSON: ${error.message}. Body preview: ${text.slice(0, 200)}`);
  }
}

function isWebPayloadUsable(payload) {
  const room = payload?.data?.data?.[0];

  return Boolean(
    room?.stream_url?.hls_pull_url ||
      Object.keys(room?.stream_url?.hls_pull_url_map || {}).length ||
      Object.keys(room?.stream_url?.flv_pull_url || {}).length,
  );
}

async function bootstrapGuestCookie(options = {}) {
  const forceRefresh = Boolean(options.forceRefresh);
  const now = Date.now();

  if (
    !forceRefresh &&
    guestCookieCache &&
    guestCookieCache.cookies &&
    now - guestCookieCache.startTimestamp < GUEST_COOKIE_TTL_MS
  ) {
    return guestCookieCache.cookies;
  }

  const { response } = await requestText(LIVE_HOME_URL, {
    method: 'GET',
    proxy: resolveProxyValue(options),
    headers: {
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'User-Agent': DEFAULT_USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to bootstrap guest cookie with status ${response.status}`);
  }

  const setCookieHeaders = getSetCookieHeaders(response.headers);
  const cookies = toCookieHeader(setCookieHeaders);

  if (!cookies || !cookies.includes('ttwid=')) {
    if (guestCookieCache?.cookies) {
      return guestCookieCache.cookies;
    }
    throw new Error('Failed to bootstrap guest cookie because upstream did not return ttwid');
  }

  guestCookieCache = {
    startTimestamp: now,
    cookies,
  };

  return cookies;
}

async function getHtmlNonce(url, userAgent = DEFAULT_USER_AGENT, options = {}) {
  const forceRefresh = Boolean(options.forceRefresh);
  const now = Date.now();

  if (
    !forceRefresh &&
    htmlNonceCache &&
    htmlNonceCache.nonce &&
    now - htmlNonceCache.startTimestamp < HTML_NONCE_TTL_MS
  ) {
    return htmlNonceCache.nonce;
  }

  const { response } = await requestText(url, {
    method: 'GET',
    proxy: resolveProxyValue(options),
    headers: {
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'User-Agent': userAgent,
    },
  });

  const nonce = extractCookieValue(getSetCookieHeaders(response.headers), '__ac_nonce');
  const finalNonce = nonce || generateNonce();

  htmlNonceCache = {
    startTimestamp: now,
    nonce: finalNonce,
  };

  return finalNonce;
}

function buildHtmlSignatureCookie(url, nonce, userAgent = DEFAULT_USER_AGENT) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = getAcSignature(timestamp, url, nonce, userAgent);
  return `__ac_nonce=${nonce}; __ac_signature=${signature}; __ac_referer=__ac_blank`;
}

function toWebLikePayload({
  room,
  user,
  enterRoomId,
  roomStatus,
  enterMode,
  qrcodeUrl,
  partitionRoadMap,
  isLogin,
  serverTimeMs,
}) {
  return {
    status_code: 0,
    data: {
      data: [room],
      enter_room_id: enterRoomId || room?.id_str || '',
      user: user || room?.owner || {},
      qrcode_url: qrcodeUrl || '',
      enter_mode: enterMode ?? 0,
      room_status: roomStatus ?? 0,
      partition_road_map: partitionRoadMap || {},
      login_lead: {
        is_login: Boolean(isLogin),
      },
    },
    extra: {
      now: serverTimeMs ?? Date.now(),
    },
  };
}

function buildHtmlFallbackPayload(stateData, webRid, isLogin) {
  const roomStore = stateData?.state?.roomStore || {};
  const roomInfo = roomStore.roomInfo || {};
  const room = roomInfo.room || {};
  const user = room.owner || roomInfo.anchor || {};

  return {
    payload: toWebLikePayload({
      room,
      user,
      enterRoomId: roomInfo.roomId || room.id_str || '',
      roomStatus: roomStore.liveStatus ?? room.status ?? 0,
      enterMode: roomInfo.enter_mode ?? 0,
      qrcodeUrl: roomInfo.qrcode_url || '',
      partitionRoadMap: roomInfo.partition_road_map || {},
      isLogin,
      serverTimeMs: Date.now(),
    }),
    secUid: roomInfo.anchor?.sec_uid || room.owner?.sec_uid || user.sec_uid || '',
  };
}

function buildRoomViewStatsFromMobileRoom(room) {
  const viewers = room?.user_count ?? null;
  const viewersShort = room?.stats?.user_count_str || (viewers == null ? '' : String(viewers));
  const viewersLong = viewers == null ? '' : `${viewers}在线观众`;

  return {
    is_hidden: false,
    display_short: viewersShort,
    display_middle: viewersShort,
    display_long: viewersLong,
    display_value: viewers,
    display_version: 0,
    incremental: false,
    display_type: 1,
    display_short_anchor: viewersShort,
    display_middle_anchor: viewersShort,
    display_long_anchor: viewersLong,
  };
}

function buildMobileFallbackPayload(room, webRid) {
  const synthesizedRoom = {
    ...room,
    user_count_str: room?.stats?.user_count_str || (room?.user_count == null ? '' : String(room.user_count)),
    room_view_stats: buildRoomViewStatsFromMobileRoom(room),
    like_count: room?.like_count ?? room?.stats?.like_count ?? 0,
    linker_detail: room?.linker_detail || {
      linker_ui_layout: room?.linkmic_layout ?? 0,
    },
    live_room_mode: room?.live_type_audio ? 1 : 0,
    room_cart: room?.room_cart || {
      contain_cart: false,
      total: 0,
    },
    paid_live_data: room?.paid_live_data || {
      paid_type: 0,
      view_right: 0,
    },
  };

  return toWebLikePayload({
    room: synthesizedRoom,
    user: room?.owner || {},
    enterRoomId: room?.id_str || '',
    roomStatus: room?.status === 2 ? (room?.live_type_audio ? 1 : 0) : 2,
    enterMode: room?.live_type_audio ? 1 : 0,
    qrcodeUrl: room?.share_url || '',
    partitionRoadMap: {},
    isLogin: false,
    serverTimeMs: Date.now(),
  });
}

async function requestRoomEnter(url, webRid, cookie, userAgent, options = {}) {
  return requestText(url, {
    method: 'GET',
    proxy: resolveProxyValue(options),
    headers: buildHeaders(webRid, cookie, userAgent),
  });
}

async function fetchRoomInfoByWeb(webRid, options = {}) {
  const aid = options.aid || DEFAULT_AID;
  const explicitCookie = options.cookie || process.env.DOUYIN_COOKIE || '';
  const requestConfigs = [buildRoomEnterRequest(webRid, aid), buildPlainRoomEnterRequest(webRid, aid)];
  const errors = [];

  for (const requestConfig of requestConfigs) {
    const attempts = [];

    if (explicitCookie) {
      attempts.push({
        label: 'provided cookie',
        cookie: explicitCookie,
        canRefresh: false,
      });
    }

    attempts.push({
      label: 'guest cookie',
      cookie: await bootstrapGuestCookie(),
      canRefresh: true,
    });

    for (const attempt of attempts) {
      const triedCookies = new Set();
      let cookie = attempt.cookie;

      for (let retry = 0; retry < 2; retry += 1) {
        if (!cookie || triedCookies.has(cookie)) {
          break;
        }
        triedCookies.add(cookie);

        try {
          const { response, text } = await requestRoomEnter(requestConfig.url, webRid, cookie, requestConfig.userAgent, options);

          if (!response.ok) {
            throw new Error(`Upstream request failed with status ${response.status}. Body preview: ${text.slice(0, 200)}`);
          }

          const payload = parsePayload(text, response);

          if (!isWebPayloadUsable(payload)) {
            throw new Error('Upstream returned a partial room payload without usable stream data');
          }

          return {
            payload,
            upstream: {
              status: response.status,
              aid,
              url: requestConfig.url,
            },
          };
        } catch (error) {
          errors.push(`${requestConfig.label}/${attempt.label}: ${error.message}`);

          if (!attempt.canRefresh || retry > 0) {
            break;
          }

          cookie = await bootstrapGuestCookie({ forceRefresh: true });
        }
      }
    }
  }

  throw new Error(errors.join(' | '));
}

async function fetchRoomInfoByHtml(webRid, options = {}) {
  const aid = options.aid || DEFAULT_AID;
  const url = `https://live.douyin.com/${webRid}`;
  const explicitCookie = options.cookie || process.env.DOUYIN_COOKIE || '';
  const isLogin = Boolean(explicitCookie);
  let cookie = explicitCookie;

  if (!cookie) {
    const nonce = await getHtmlNonce(url, DEFAULT_USER_AGENT);
    cookie = buildHtmlSignatureCookie(url, nonce, DEFAULT_USER_AGENT);
  }

  const { response, text } = await requestText(url, {
    method: 'GET',
    proxy: resolveProxyValue(options),
    headers: buildHeaders(webRid, cookie, DEFAULT_USER_AGENT),
  });

  if (!response.ok) {
    throw new Error(`Room HTML request failed with status ${response.status}. Body preview: ${text.slice(0, 200)}`);
  }

  if (text.includes('验证码')) {
    throw new Error('Room HTML fallback hit verification challenge');
  }

  const match = text.match(ROOM_HTML_STATE_REGEX);
  if (!match) {
    throw new Error('Room HTML fallback could not find the embedded state payload');
  }

  const jsonText = match[1].replace(/\\"/g, '"').replace(/\\"/g, '"');
  const stateData = JSON.parse(jsonText);
  const result = buildHtmlFallbackPayload(stateData, webRid, isLogin);

  return {
    payload: result.payload,
    upstream: {
      status: response.status,
      aid,
      url,
    },
    secUid: result.secUid,
  };
}

function createMobileUpstreamError(payload) {
  const statusCode = Number(payload?.status_code);
  const message =
    payload?.data?.message ||
    payload?.data?.prompts ||
    payload?.message ||
    'Unknown mobile upstream error';

  const error = new Error(
    `Mobile fallback rejected: status_code=${statusCode || 'unknown'}, message=${message}`
  );

  error.code = statusCode === 10011 ? 'MOBILE_REJECTED_10011' : 'MOBILE_UPSTREAM_ERROR';
  error.upstreamStatusCode = statusCode;
  error.riskSuspected = statusCode === 10011;

  return error;
}

async function fetchRoomInfoByMobile(webRid, secUid, options = {}) {
  if (!secUid || typeof secUid !== 'string') {
    throw new Error('Mobile fallback requires secUid');
  }

  if (Date.now() < mobileCooldownUntil) {
    throw Object.assign(
      new Error('Mobile fallback skipped due to recent upstream rejection (cooldown active)'),
      { code: 'MOBILE_COOLDOWN', riskSuspected: true }
    );
  }

  const aid = options.aid || DEFAULT_AID;
  const url = new URL(MOBILE_ROOM_INFO_URL);
  url.searchParams.set('app_id', '1128');
  url.searchParams.set('live_id', '1');
  url.searchParams.set('verifyFp', '');
  url.searchParams.set('room_id', '2');
  url.searchParams.set('type_id', '0');
  url.searchParams.set('sec_user_id', secUid);

  const { response, text } = await requestText(url.toString(), {
    method: 'GET',
    proxy: resolveProxyValue(options),
    headers: {
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'User-Agent': DEFAULT_USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new Error(`Mobile fallback request failed with status ${response.status}. Body preview: ${text.slice(0, 200)}`);
  }

  const payload = parsePayload(text, response);

  if (payload?.status_code !== 0) {
    const error = createMobileUpstreamError(payload);
    if (error.riskSuspected) {
      mobileCooldownUntil = Date.now() + 60_000;
    }
    throw error;
  }

  const room = payload?.data?.room;
  if (!room) {
    throw new Error('Mobile fallback succeeded but did not contain room data');
  }

  return {
    payload: buildMobileFallbackPayload(room, webRid),
    upstream: {
      status: response.status,
      aid,
      url: url.toString(),
    },
  };
}

function hasCompleteRoomTimes(payload) {
  const room = payload?.data?.data?.[0];
  return Boolean(
    room &&
    room.create_time != null &&
    room.start_time != null &&
    room.finish_time != null
  );
}

const MOBILE_TIME_FIELDS = ['create_time', 'start_time', 'finish_time'];

async function enrichTimeFromMobile(webRid, secUid, basePayload, options = {}) {
  if (!secUid || hasCompleteRoomTimes(basePayload)) {
    return basePayload;
  }

  try {
    const mobileResult = await fetchRoomInfoByMobile(webRid, secUid, options);
    const mobileRoom = mobileResult?.payload?.data?.data?.[0];
    const baseRoom = basePayload?.data?.data?.[0];

    if (mobileRoom && baseRoom) {
      for (const field of MOBILE_TIME_FIELDS) {
        if (baseRoom[field] == null && mobileRoom[field] != null) {
          baseRoom[field] = mobileRoom[field];
        }
      }
    }
  } catch (error) {
    console.warn(`[mobile-time-enrichment] ${error.code || 'ERROR'}: ${error.message}`);
  }

  return basePayload;
}

async function fetchRoomEnter(webRid, options = {}) {
  if (!webRid) {
    throw new Error('webRid is required');
  }

  const errors = [];
  const explicitCookie = options.cookie || process.env.DOUYIN_COOKIE || '';
  let secUid = options.secUid || options.uid || '';
  let htmlResult = null;

  try {
    const webResult = await fetchRoomInfoByWeb(webRid, options);
    const webSecUid = webResult?.payload?.data?.user?.sec_uid || '';
    webResult.payload = await enrichTimeFromMobile(webRid, secUid || webSecUid, webResult.payload, options);
    return webResult;
  } catch (error) {
    errors.push(`web: ${error.message}`);
  }

  if (secUid) {
    try {
      return await fetchRoomInfoByMobile(webRid, secUid, options);
    } catch (error) {
      errors.push(`mobile: ${error.message}`);
    }
  }

  try {
    htmlResult = await fetchRoomInfoByHtml(webRid, {
      ...options,
      cookie: explicitCookie,
    });

    secUid = secUid || htmlResult.secUid;

    if (htmlResult?.payload?.data?.data?.[0]?.stream_url) {
      htmlResult.payload = await enrichTimeFromMobile(webRid, secUid, htmlResult.payload, options);
      return htmlResult;
    }
  } catch (error) {
    errors.push(`webHTML: ${error.message}`);
  }

  if (secUid) {
    try {
      return await fetchRoomInfoByMobile(webRid, secUid, options);
    } catch (error) {
      errors.push(`mobile: ${error.message}`);
    }
  }

  if (htmlResult) {
    htmlResult.payload = await enrichTimeFromMobile(webRid, secUid, htmlResult.payload, options);
    return htmlResult;
  }

  throw new Error(errors.join(' | '));
}

module.exports = {
  DEFAULT_AID,
  bootstrapGuestCookie,
  buildRoomEnterRequest,
  fetchRoomEnter,
};
