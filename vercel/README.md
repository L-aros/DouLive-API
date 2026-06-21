# DouLive API for Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/L-aros/DouLive-API&root-directory=vercel&env=API_KEY,DOUYIN_COOKIE,UPSTREAM_TIMEOUT_MS,UPSTREAM_PROXY_URL)

这个目录是一个可直接部署到 Vercel 的版本。

## 部署方式

1. 把当前仓库导入 Vercel
2. 在项目设置里把 **Root Directory** 设为 `vercel`
3. 配置环境变量：
   - `API_KEY` 必填
   - `DOUYIN_COOKIE` 可选
   - `UPSTREAM_TIMEOUT_MS` 可选，默认 `10000`
   - `UPSTREAM_PROXY_URL` 可选
4. 点击 Deploy

## 路由

- `GET /api/health`
- `GET /api/room?web_rid=799834884246`
- `GET /api/room/799834884246`

## 鉴权与代理

- 不带 API key：可正常访问接口，但只能直连上游
- 带 API key：除了访问接口外，还会自动走预设代理（`UPSTREAM_PROXY_URL`）

请求头支持：
- `X-API-Key: <API_KEY>`
- `Authorization: Bearer <API_KEY>`

## 代理配置

### 静态代理
通过环境变量配置：

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
每次请求可通过 query 参数覆盖：

```http
GET /api/room?web_rid=799834884246&proxy=http://127.0.0.1:7890
```

如果动态代理为空，则回退到 `UPSTREAM_PROXY_URL`；两者都为空时，默认直连上游。
