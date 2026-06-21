# Contributing

Thanks for your interest in improving `DouLive-API`.

## Development workflow

1. Fork the repository
2. Create a feature branch from `main`
3. Make your changes
4. Run local checks:

```bash
npm install
npm run check
```

5. Update docs if your change affects:
- response structure
- deployment steps
- auth or proxy behavior
- upstream fallback strategy

6. Open a pull request with:
- a clear summary
- testing notes
- sample request/response if API behavior changed

## Project structure

- `src/` — root Node.js API
- `vercel/` — Vercel deployment target
- `cloudflare/` — Cloudflare Workers deployment target

## Style notes

- Keep `src/normalize.js` as the main cleanup layer for response shaping
- Prefer explicit field mapping over passing through raw upstream payloads
- Treat upstream-specific behavior as best-effort and document fallback assumptions
