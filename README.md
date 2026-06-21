# DouLive API

一个轻量的 Node.js API，用来代理上游：

`https://live.douyin.com/webcast/room/web/enter/?aid=6383&web_rid=...`

并把返回结果整理成更干净的结构，避免直接消费巨大的原始 body。

## 功能

- 上游抓取房间数据
- 提取核心字段：房间、主播、统计、时间、分类、播放流、权限
- 内置多种抓取策略：`web + a_bogus`、guest cookie、HTML fallback、mobile 时间补全
- 支持两种调用方式：
  - `GET /api/room?web_rid=799834884246`
  - `GET /api/room/799834884246`
- 可选通过 `DOUYIN_COOKIE` 传入浏览器 Cookie，拿到更完整的数据
- 默认仅监听 `127.0.0.1`，并支持通过 `API_KEY` 做接口鉴权

## 启动

```bash
npm start
```

开发模式：

```bash
npm run dev
```

语法检查：

```bash
npm run check
```

## 环境变量

复制 `.env.example` 到 `.env` 后填写：

```env
DOUYIN_COOKIE=你的浏览器 Cookie（可选）
PORT=3000
HOST=127.0.0.1
UPSTREAM_TIMEOUT_MS=10000
UPSTREAM_PROXY_URL=
API_KEY=your-secret-key
```

- `DOUYIN_COOKIE`: 可选，部分房间能拿到更完整的数据
- `HOST`: 默认 `127.0.0.1`，建议保持本地监听
- `UPSTREAM_TIMEOUT_MS`: 上游请求超时，默认 `10000`
- `UPSTREAM_PROXY_URL`: 可选静态代理；Node 版本支持直接 HTTP(S) 代理（如 `http://127.0.0.1:7890`）或反向代理模板（如 `https://proxy.example.com/fetch?url={url}`）
- `API_KEY`: 如果设置，`/api/room` 需要 `X-API-Key` 或 `Authorization: Bearer <key>`

> 有些房间匿名抓取会返回不完整数据，或者直接空 body。遇到这种情况，把浏览器里的 Cookie 配到 `DOUYIN_COOKIE`。

## API 示例

### 1. 查询房间

```http
GET /api/room?web_rid=799834884246
```

### 2. 动态代理覆盖（可选）

```http
GET /api/room?web_rid=799834884246&proxy=http://127.0.0.1:7890
```

如果 `proxy` 留空，则优先使用静态 `UPSTREAM_PROXY_URL`；两者都为空时，默认直连上游。

### 3. 返回结构示例

```json
{
  "ok": true,
  "room": {
    "webRid": "799834884246",
    "roomId": "7653506554259360548",
    "title": "总有些惊奇的奇遇"
  },
  "owner": {
    "id": "3927882986161776",
    "nickname": "HaHA（无畏契约职业教练）"
  },
  "stats": {
    "viewers": 1468,
    "likes": 31235
  },
  "stream": {
    "defaultResolution": "HD1"
  }
}
```

## 当前清洗后的字段

- `room`: 房间 ID、标题、状态、封面、二维码
- `owner`: 主播 ID、sec_uid、昵称、头像
- `viewerContext`: 当前登录态、关注状态、订阅状态
- `stats`: 在线人数、累计观看、点赞数
- `time`: `createTime`、`startTime`、`finishTime`（best-effort，从 mobile fallback 补充）
- `category`: 分类、子分类、游戏标签
- `stream`: 默认清晰度、FLV/HLS 地址、可选清晰度
- `permissions`: 聊天、礼物、分享、投屏、粉丝团等
- `interaction`: 连麦相关能力
- `commerce`: 商品、购物车、付费直播相关字段
- `meta`: `enterMode`、`serverTimeMs`

### 状态字段说明

- `room.status.roomStatus`: 统一后的房间状态文本，如 `normal` / `radio` / `ended` / `unknown`
- `room.status.roomStatusCode`: 房间状态码，若上游未提供数值则可能为 `null`
- `room.status.isLive`: 同时根据 HLS 与 FLV 拉流地址判断

如果后面你想继续精简字段，优先改 `src/normalize.js`。
