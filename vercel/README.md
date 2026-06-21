# DouLive API for Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/L-aros/DouLive-API&root-directory=vercel&env=ACCESS_TOKEN,DOUYIN_COOKIE,UPSTREAM_TIMEOUT_MS,UPSTREAM_PROXY_URL)

这个目录是一个可直接部署到 Vercel 的版本。

## 部署方式

1. 把当前仓库导入 Vercel
2. 在项目设置里把 **Root Directory** 设为 `vercel`
3. 配置环境变量：
   - `ACCESS_TOKEN` 可选
   - `DOUYIN_COOKIE` 可选
   - `UPSTREAM_TIMEOUT_MS` 可选，默认 `10000`
   - `UPSTREAM_PROXY_URL` 可选
4. 点击 Deploy

## 路由

- `GET /api/health`
- `GET /api/room?web_rid=799834884246`
- `GET /api/room/799834884246`

## Token 与代理权限

`/api/room` 在 Vercel 版本中默认也可以直接调用。

只有当你想启用**预设代理**或**动态代理**时，才需要携带以下任一请求头：

- `X-Token: <ACCESS_TOKEN>`
- `Authorization: Bearer <ACCESS_TOKEN>`

兼容旧写法：
- `X-API-Key: <ACCESS_TOKEN>`

## 代理配置

### 静态代理
通过环境变量配置。**只有在请求里提供有效 token 时才会启用**：

```env
UPSTREAM_PROXY_URL=http://127.0.0.1:7890
```

Node/Vercel 版本支持以下代理格式：

1. **直接 HTTP(S) 代理**
   - `http://ip:port`
   - `http://user:pass@ip:port`
2. **冒号分隔简写**
   - `ip:port:user:pass`（自动转换为 `http://user:pass@ip:port`）
3. **反向代理模板**
   - `https://proxy.example.com/fetch?url={url}`

### 动态代理
每次请求可通过 query 参数覆盖。**需要有效 token**：

```http
GET /api/room?web_rid=799834884246&proxy=http://127.0.0.1:7890
```

如果动态代理为空，则回退到 `UPSTREAM_PROXY_URL`；两者都为空时，默认直连上游。
没有 token 时接口仍然可用，但会忽略预设代理与动态代理，直接访问上游。
