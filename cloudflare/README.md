# DouLive API for Cloudflare Workers

这个目录是一个可以直接部署到 Cloudflare Workers 的版本。

> 建议先 fork 或 clone 当前仓库，再通过 Wrangler 部署 `cloudflare/` 目录。

## 部署方式

1. 进入 `cloudflare/`
2. 安装依赖：`npm install`
3. 设置密钥：
   - `npx wrangler secret put API_KEY`
   - `npx wrangler secret put DOUYIN_COOKIE`（可选）
4. 如果需要其它变量，可在 `wrangler.jsonc` 或 Cloudflare Dashboard 里配置：
   - `UPSTREAM_TIMEOUT_MS`
   - `UPSTREAM_PROXY_URL`
5. 部署：`npm run deploy`

## 路由

- `GET /health`
- `GET /api/room?web_rid=799834884246`
- `GET /api/room/799834884246`

## 鉴权

`/api/room` 必须携带以下任一请求头：

- `X-API-Key: <API_KEY>`
- `Authorization: Bearer <API_KEY>`

## 代理配置

### 静态代理
Workers 版本只支持**反向代理模板/前缀**，不支持原生 HTTP 代理地址。

```env
UPSTREAM_PROXY_URL=https://proxy.example.com/fetch?url={url}
```

### 动态代理
每次请求可通过 query 参数覆盖：

```http
GET /api/room?web_rid=799834884246&proxy=https://proxy.example.com/fetch?url={url}
```

如果动态代理为空，则回退到 `UPSTREAM_PROXY_URL`；两者都为空时，默认直连上游。
