# Cloud Atlas

Global datacenter capacity observatory. Tracks documented datacenter capacity across cloud providers, where it sits, what status it is in, and how the evidence has changed over time. Every figure links to a dated public source; totals are tracked capacity over documented sites, never a global estimate.

## Development

```sh
npm install
npm run setup        # local D1: migrate, import the reviewed CSVs, ingest every automated source
npm run build        # dist/, which the Worker serves
npm run dev:worker   # Worker with the local D1 on 8787
npm run dev          # Vite on 5173 with /api proxied to the Worker
```

Probe credentials are read from a `.env` file at the repo root when one exists (see `.env.example`), or from the environment. `npm run seed:offline` seeds the local database from recorded fixtures instead of the network. `npm test` runs the unit suite, `npm run test:e2e` runs Playwright against a production build, `npm run build` produces `dist/`.

## Data

The database is Cloudflare D1 (SQLite). Schema lives in `migrations/`. Observations are append only and carry source, excerpt, effective and recorded dates, claim type, method, and review status.

- `npm run ingest [adapter...]` runs the automated adapters: AWS, Google Cloud, and Azure region inventories, Google's GPU zone table, the Epoch AI data centers dataset, Azure Retail Prices, the AWS Spot Instance Advisor, the provider news feed watcher, and, when their account credentials are set, the AWS placement score, Google calendar-mode, Oracle capacity report, Alibaba available resource, and Tencent zone config probes. `--schedule hourly|daily|weekly` selects adapters by schedule, `--fixtures` replays recorded responses, `--dataset demo` writes the demo set. Add `--remote` to write to production, which needs `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. `npm run sources` lists the adapters.
- `npm run import [file.csv]` loads hand-reviewed observations from `data/imports/`; the column schema is the header row, every row cites a source, and invalid rows go to the review queue.
- `npm run review list|accept <id> [note]|reject <id> [note]` works the review queue. Accepting a feed candidate with a resolved place creates the proposed site and its observation; one without a place is transcribed into `data/imports/` by hand.
- `npm run health` prints each adapter's latest run and its outcome.
- `npm run retain` collapses hourly availability signals older than 90 days to the worst hour per zone and day; the daily ingest runs it.

GitHub Actions runs the hourly adapters every hour and everything daily, writing straight to D1.

## How it runs

One Cloudflare Worker serves the built site and a read-only JSON API over D1, rate limited to 300 requests a minute per client and cached at the edge for five minutes. The API is documented at `/api/openapi.json` and `/api`. Deploys happen from GitHub Actions when CI is green on main; the deploy creates the D1 database on first run and applies migrations.
