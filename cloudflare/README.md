# DouLive API for Cloudflare Workers

这个目录是一个可以直接部署到 Cloudflare Workers 的版本。

> 建议先 fork 或 clone 当前仓库，再通过 Wrangler 部署 `cloudflare/` 目录。

## 部署方式

1. 进入 `cloudflare/`
2. 安装依赖：`npm install`
3. 设置密钥：
   - `npx wrangler secret put ACCESS_TOKEN`（可选）
   - `npx wrangler secret put DOUYIN_COOKIE`（可选）
4. 如果需要其它变量，可在 `wrangler.jsonc` 或 Cloudflare Dashboard 里配置：
   - `UPSTREAM_TIMEOUT_MS`
   - `UPSTREAM_PROXY_URL`
5. 部署：`npm run deploy`

## 路由

- `GET /health`
- `GET /api/room?web_rid=799834884246`
- `GET /api/room/799834884246`

## Token 与代理权限

`/api/room` 在 Cloudflare Workers 版本中默认也可以直接调用。

只有当你想启用**预设代理**或**动态代理**时，才需要携带以下任一请求头：

- `X-Token: <ACCESS_TOKEN>`
- `Authorization: Bearer <ACCESS_TOKEN>`

## 代理配置

### 静态代理
Workers 版本只支持**反向代理模板/前缀**，不支持原生 HTTP 代理地址。
**只有在请求里提供有效 token 时才会启用**。

```env
UPSTREAM_PROXY_URL=https://proxy.example.com/fetch?url={url}
```

### 动态代理
每次请求可通过 query 参数覆盖。**需要有效 token**：

```http
GET /api/room?web_rid=799834884246&proxy=https://proxy.example.com/fetch?url={url}
```

如果动态代理为空，则回退到 `UPSTREAM_PROXY_URL`；两者都为空时，默认直连上游。
没有 token 时接口仍然可用，但会忽略预设代理与动态代理，直接访问上游。
