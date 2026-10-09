# Cloud Atlas

Global datacenter capacity observatory. Tracks documented datacenter capacity across cloud providers, where it sits, what status it is in, and how the evidence has changed over time. Every figure links to a dated public source; totals are tracked capacity over documented sites, never a global estimate.

## Development

```sh
npm install
npm run setup        # local D1: migrate, import the reviewed CSVs, ingest every automated source
npm run dev:worker   # Worker with the local D1 on 8787
npm run dev          # Vite on 5173 with /api proxied to the Worker
```

`npm run seed:offline` seeds the local database from recorded fixtures instead of the network. `npm test` runs the unit suite, `npm run test:e2e` runs Playwright against a production build, `npm run build` produces `dist/`.

## Data

The database is Cloudflare D1 (SQLite). Schema lives in `migrations/`. Observations are append only and carry source, excerpt, effective and recorded dates, claim type, method, and review status.

- `npm run ingest [adapter...]` runs the automated adapters: AWS, Google Cloud, and Azure region inventories, the Epoch AI data centers dataset, Azure Retail Prices, and the AWS Spot Instance Advisor. Add `--remote` to write to production, which needs `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.
- `npm run import [file.csv]` loads hand-reviewed observations from `data/imports/`; the column schema is the header row, every row cites a source, and invalid rows go to the review queue.
- `npm run review list|accept <id>|reject <id>` works the review queue.
- `npm run health` prints the last attempt and success per adapter.

GitHub Actions runs the hourly adapters every hour and everything daily, writing straight to D1.

## How it runs

One Cloudflare Worker serves the built site and a read-only JSON API over D1. The API is documented at `/api/openapi.json` and `/api`. Deploys happen from GitHub Actions when CI is green on main; the deploy creates the D1 database on first run and applies migrations.
