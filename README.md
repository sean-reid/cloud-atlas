# Cloud Atlas

Global datacenter capacity observatory. Tracks documented datacenter capacity across cloud providers, where it sits, what status it is in, and how the evidence has changed over time. Every figure links to a dated public source.

## Development

```sh
npm install
npm run dev          # Vite on 5173, proxying /api to the Worker
npm run dev:worker   # Worker with local D1 on 8787
```

`npm test` runs unit tests, `npm run test:e2e` runs Playwright against a production build, and `npm run build` produces `dist/`.

## How it runs

One Cloudflare Worker serves the built site and a read-only JSON API over a D1 database. Deploys happen from GitHub Actions when CI is green on main.
