# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
npm install

# Start local server (default: http://127.0.0.1:3000)
npm start

# Dev mode with auto-reload
npm run dev

# Syntax check all root project files
npm run check

# Syntax check Vercel variant
cd vercel && node --check lib/upstream.js && node --check lib/room-handler.js
```

No test suite exists. Validation is done via syntax checks and live endpoint testing.

## Architecture

Two deployment targets share the same logic but have different entry points and runtime constraints:

```
src/            Node.js standalone (default: localhost only)
vercel/         Vercel Serverless Functions
```

### Shared modules (duplicated per target, not extracted to a shared package)

| Module | Responsibility |
|---|---|
| `upstream.js` | Fetch room data from Douyin, fallback chain, proxy support |
| `normalize.js` | Transform raw upstream payload into clean response shape |
| `abogus.js` | Generate Douyin `a_bogus` request signature |
| `signature.js` | Generate `__ac_signature` for HTML fallback requests |

When changing logic, update both variants (`src/`, `vercel/lib/`).

### Fallback chain (in `upstream.js → fetchRoomEnter`)

```
1. web enter + a_bogus signature  →  best path
2. web enter + guest cookie       →  plain fallback
3. mobile reflow (if secUid)      →  best-effort time enrichment
4. HTML page parse                →  extract embedded state JSON
5. mobile reflow retry            →  if HTML provided secUid
```

Mobile reflow (`webcast.amemv.com`) is unreliable (risk control, 10011 errors). It's used only for time field enrichment (`createTime`, `startTime`, `finishTime`), never as primary data source. A 60-second cooldown is applied per proxy/key combination after a 10011 rejection.

### Token and proxy gating

- `/api/room` is publicly callable without a token (direct upstream access)
- Preset proxy (`UPSTREAM_PROXY_URL`) and dynamic proxy (`?proxy=...`) are only used when a valid token is provided
- Token can be passed via `X-Token` header, `Authorization: Bearer <token>`, or `?token=` query param
- `meta.proxyUsed` in the response indicates whether proxy was actually used

### Vercel variant specifics

- Uses `undici.ProxyAgent` for direct HTTP(S) proxy support
- Has a 30-second in-memory room cache (`ROOM_CACHE_TTL_MS`) to avoid repeated upstream calls within a single function instance
- Default upstream timeout is 7 seconds (Vercel free tier has 10s function execution limit)

## Key response shape

The normalized response (`src/normalize.js`) always returns:
- `ok`, `fetchedAt`, `upstream`, `room`, `owner`, `viewerContext`, `stats`, `time`, `category`, `stream`, `permissions`, `interaction`, `commerce`, `meta`

`room.status.roomStatus` is always one of: `normal`, `radio`, `ended`, `unknown`.
`room.status.isLive` checks HLS + FLV + `hls_pull_url_map` together.

`time` fields (`createTime`, `startTime`, `finishTime`) come from mobile reflow and are best-effort — they may be `null` when mobile reflow is rejected by risk control.

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `ACCESS_TOKEN` | (empty) | Unlocks proxy features; without it, API is still callable but direct-only |
| `UPSTREAM_PROXY_URL` | (empty) | Preset proxy, only used with valid token |
| `UPSTREAM_TIMEOUT_MS` | `10000` (root) / `7000` (vercel) | Per-upstream-request timeout |
| `DOUYIN_COOKIE` | (empty) | Optional browser cookie for richer upstream data |
| `HOST` | `127.0.0.1` | Root variant only |
| `PORT` | `3000` | Root variant only |
