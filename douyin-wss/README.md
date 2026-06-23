# douyin-wss

一个独立运行的 Douyin 直播监听服务，负责：

- 注册直播间并常驻监听
- 在没有 WebSocket 客户端连接时继续监控开播/下播
- 提供当前直播场次累计统计 HTTP 接口
- 可选通过 PostgreSQL 持久化 monitor / session 状态
- 可选向连接中的客户端转发实时 WebSocket 消息

> 当前交付重点是 **当前直播场次累计统计**，尤其是 `chatCount`（累计弹幕数）。这不是一个弹幕明细查询系统。

## 当前已交付范围

- `POST /api/monitors` 注册直播间监听
- `GET /api/monitors` 查看已注册监听
- `GET /api/monitors/{webRid}` 查看单个监听详情
- `DELETE /api/monitors/{webRid}` 取消监听
- `GET /api/monitors/{webRid}/stats` 获取当前直播场次累计统计
- `WS /ws/{webRid}` 实时转发消息（可选）

## 目录说明

- `server.js` — HTTP / WS 入口
- `monitor-manager.js` — 长驻监听、开播轮询、场次聚合
- `storage/` — monitor / session / 可选 raw message 持久化
- `new_douyin.proto` — Douyin IM protobuf 定义
- `webmssdk.js` — X-Bogus 签名脚本

## 快速开始

先进入子目录：

```bash
cd douyin-wss
npm install
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

默认监听地址：

- HTTP: `http://127.0.0.1:1089`
- WebSocket: `ws://127.0.0.1:1089/ws/{webRid}`

## 环境变量

### 基础运行

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `1089` | HTTP / WS 服务端口 |
| `DOUYIN_COOKIE` | 空 | 浏览器 Cookie。强烈建议配置，提高房间解析与监听稳定性 |
| `ACCESS_TOKEN` | 空 | 可选鉴权 token。设置后，`/api/monitors*` 和 `/ws/*` 都需要携带 token |

### 监听与聚合调优

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MONITOR_POLL_MS` | `45000` | 未开播房间的轮询间隔，代码内最小值强制为 `15000` |
| `MONITOR_FLUSH_MS` | `5000` | monitor / session 持久化 flush 间隔，代码内最小值强制为 `2000` |

### 持久化

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DATABASE_URL` | 空 | PostgreSQL 连接串。为空时使用纯内存模式，重启后不会恢复 monitor / session |
| `RAW_MESSAGE_PERSIST_ENABLED` | `false` | **内部可选能力**。开启后，把 `storable` 消息批量写入 `messages` 表 |
| `RAW_MESSAGE_PERSIST_BATCH_SIZE` | `200` | raw message 批量写入大小，代码内最小值强制为 `20` |

### `.env` 与 Cookie 自动刷新

- 启动脚本使用 `node --env-file-if-exists=.env server.js`
- 服务会每 6 小时尝试刷新 `ttwid`
- 如果 `douyin-wss/.env` 不存在，服务现在会自动创建它并写入新的 `DOUYIN_COOKIE`

## 鉴权说明

只有在设置了 `ACCESS_TOKEN` 时才启用鉴权：

### HTTP

支持以下任一方式：

- `X-Token: <token>`
- `Authorization: Bearer <token>`
- `?token=<token>`

### WebSocket

使用查询参数：

```text
ws://127.0.0.1:1089/ws/{webRid}?token=<token>
```

如果 `ACCESS_TOKEN` 为空，则 monitor HTTP 和 WS 都是开放的。

## API

### 1) 健康检查

```http
GET /health
```

示例响应：

```json
{
  "ok": true,
  "service": "douyin-wss",
  "monitors": 0,
  "storage": {
    "mode": "memory",
    "persistent": false
  }
}
```

### 2) 注册监听

```http
POST /api/monitors
Content-Type: application/json

{
  "webRid": "942743272087"
}
```

兼容以下字段名：

- `webRid`
- `web_rid`
- `roomId`
- `room_id`

示例响应（节选）：

```json
{
  "ok": true,
  "created": true,
  "item": {
    "webRid": "942743272087",
    "roomId": "7654432263492438824",
    "monitor": {
      "registered": true,
      "status": "live",
      "captureActive": true,
      "hasOpenSession": true,
      "storagePersistent": false
    }
  }
}
```

### 3) 查看监听列表

```http
GET /api/monitors
```

### 4) 查看单个监听详情

```http
GET /api/monitors/{webRid}
```

这个接口偏运维/调试用途，会返回 monitor、room、owner、session 等较完整信息。

### 5) 取消监听

```http
DELETE /api/monitors/{webRid}
```

### 6) 获取当前直播场次累计统计

```http
GET /api/monitors/{webRid}/stats
```

这是当前主接口。它返回的是 **当前直播场次累计值**，不是弹幕明细。

示例响应：

```json
{
  "ok": true,
  "item": {
    "webRid": "942743272087",
    "roomId": "7654432263492438824",
    "status": "live",
    "session": {
      "startedAt": "2026-06-23T03:46:55.000Z",
      "capturedAt": "2026-06-23T08:03:32.085Z",
      "capturedUntil": "2026-06-23T08:03:50.205Z",
      "servedAt": "2026-06-23T08:03:51.443Z",
      "endedAt": null,
      "isCompleteFromSessionStart": false
    },
    "counts": {
      "chatCount": 10,
      "commentCount": 10,
      "messageCount": 89,
      "giftCount": 6,
      "giftValue": 6,
      "likeCount": 120036,
      "followCount": 0,
      "shareCount": 0,
      "memberCount": 42,
      "peakOnline": 2055,
      "currentViewers": 2027
    }
  }
}
```

## `/stats` 字段语义

### 顶层

- `webRid` — 直播间网页房间号
- `roomId` — 抖音内部房间 ID
- `status` — 当前监听/场次状态，例如 `waiting` / `live`

### `session`

- `startedAt` — 本场直播开始时间
- `capturedAt` — 本服务开始接入采集这场直播的时间
- `capturedUntil` — 本次返回里数据实际累计覆盖到的时间点
- `servedAt` — 当前 HTTP 响应生成时间
- `endedAt` — 本场直播结束时间；直播中为 `null`
- `isCompleteFromSessionStart` — 是否从本场一开播就完整采集到现在

### `counts`

- `chatCount` — **主字段，累计弹幕数**
- `commentCount` — `chatCount` 的兼容别名
- `messageCount` — 累计的 `storable` 消息数量，不等于纯弹幕数
- `giftCount` — 累计礼物数量
- `giftValue` — 累计礼物价值
- `likeCount` — 累计点赞数
- `followCount` — 累计关注数
- `shareCount` — 累计分享数
- `memberCount` — 累计进场/成员事件数
- `peakOnline` — 本次采集区间内观察到的峰值在线人数
- `currentViewers` — 当前在线人数

## 存储模式

### Memory 模式

当 `DATABASE_URL` 为空时：

- monitor / session 只存在当前进程内
- 进程重启后不会恢复
- `/health` 里会显示：
  - `storage.mode = memory`
  - `storage.persistent = false`

### PostgreSQL 模式

当 `DATABASE_URL` 有效时：

- monitor 注册可落库到 `monitored_rooms`
- 当前场次 summary 可落库到 `sessions`
- 重启后会恢复 monitor 和未结束场次
- 如果显式开启 `RAW_MESSAGE_PERSIST_ENABLED=true`，才会把 `storable` 消息批量写入 `messages`

## WebSocket 转发

如果你仍然需要实时消息流，可以连接：

```text
ws://127.0.0.1:1089/ws/{webRid}
```

说明：

- `WS /ws/{webRid}` 仍会转发实时消息
- 但当前主产品目标不是“弹幕明细接口”
- 所以主 HTTP 接口围绕 **当前场次累计值** 设计，而不是按用户/内容返回聊天记录

## 当前明确延期的内容

下面这些能力当前不作为主交付范围：

- 历史直播场次查询接口
- 已结束 session 的 HTTP 查询 / 回放接口
- 冷热分层归档查询接口
- 弹幕明细查询接口
- 用户维度的聊天记录接口
- raw message 的导出 / 浏览接口

## 生产使用建议

- 如果你只需要当前场次累计值，优先关注 `GET /api/monitors/{webRid}/stats`
- 如果你不需要详细消息存档，保持 `RAW_MESSAGE_PERSIST_ENABLED=false`
- 如果你要在重启后自动恢复监听任务，请务必配置 `DATABASE_URL`
- 如果匿名监听不稳定，优先配置新的 `DOUYIN_COOKIE`
