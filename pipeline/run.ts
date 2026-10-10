import { ProbeUnavailable } from "./adapters/types";
import { createHash } from "node:crypto";
import type { Dataset, FetchRun } from "../shared/types";
import type { Adapter, AdapterContext, AdapterResult } from "./adapters/types";
import type { Db } from "./db";
import { FetchError, safeFetch, type FetchOptions } from "./fetch";
import { loadReviewed } from "./decisions";
import { loadGeo } from "./geo";
import { log } from "./log";
import { ensureMethods } from "./methods";
import { scrubError } from "./scrub";
import { Store } from "./store";

export interface RunOptions {
  db: Db;
  dataRoot: string;
  dataset: Dataset;
  cacheDir: string;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  fetchDefaults?: Partial<FetchOptions>;
}

export interface RunOutcome {
  adapter: string;
  ok: boolean;
  skipped: boolean;
  result: AdapterResult | null;
  error: string | null;
}

export function missingCredentials(
  adapter: Adapter,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return (adapter.credentials ?? []).filter((v) => !env[v]);
}

// Each adapter runs in isolation: a failure records a failed fetch_run and leaves the
// last good observations in place, marked stale by their age rather than removed.
export async function runAdapters(
  adapters: readonly Adapter[],
  opts: RunOptions,
): Promise<{ store: Store; outcomes: RunOutcome[] }> {
  const now = opts.now ?? (() => new Date());
  const store = await Store.open(opts.db, opts.dataset, now());
  await ensureMethods(store);
  const reviewed = loadReviewed(opts.dataRoot);
  store.aliases = reviewed.aliases;
  store.decisions = reviewed.decisions;
  const geo = loadGeo(opts.dataRoot);
  const outcomes: RunOutcome[] = [];

  for (const adapter of adapters) {
    const startedAt = now().toISOString();
    const missing = missingCredentials(adapter);
    if (missing.length) {
      // Not a failure: the probe waits until the account exists. The sources page shows it as
      // waiting; the variable names stay in the log and out of the public record.
      await store.appendFetchRun({
        adapter: adapter.id,
        url: adapter.url,
        started_at: startedAt,
        finished_at: now().toISOString(),
        ok: false,
        http_status: null,
        content_hash: null,
        changed: false,
        observations: 0,
        error: "waiting for credentials",
      });
      outcomes.push({
        adapter: adapter.id,
        ok: false,
        skipped: true,
        result: null,
        error: "waiting for credentials",
      });
      log("info", "adapter.skipped", { adapter: adapter.id, missing: missing.join(",") });
      await store.flush();
      continue;
    }
    let lastStatus: number | null = null;
    let anyChanged = false;
    const hashes: string[] = [];
    const ctx: AdapterContext = {
      store,
      dataset: opts.dataset,
      now,
      geo: geo.regions,
      places: geo.places,
      fetch: async (url: string, extra: Partial<FetchOptions> = {}) => {
        const base: FetchOptions = {
          adapter: adapter.id,
          allowHosts: adapter.hosts,
          cacheDir: opts.cacheDir,
          ...opts.fetchDefaults,
          ...extra,
        };
        if (opts.fetchImpl) base.fetchImpl = opts.fetchImpl;
        const res = await safeFetch(url, base);
        lastStatus = res.status;
        anyChanged ||= res.changed;
        hashes.push(res.hash);
        return res;
      },
    };
    log("info", "adapter.start", { adapter: adapter.id });
    try {
      const result = await adapter.run(ctx);
      const run: FetchRun = {
        adapter: adapter.id,
        url: adapter.url,
        started_at: startedAt,
        finished_at: now().toISOString(),
        ok: true,
        http_status: lastStatus,
        content_hash: hashes.length
          ? createHash("sha256").update(hashes.join("")).digest("hex")
          : null,
        changed: anyChanged,
        observations: result.observations + result.signals,
        error: null,
      };
      await store.appendFetchRun(run);
      outcomes.push({ adapter: adapter.id, ok: true, skipped: false, result, error: null });
      log("info", "adapter.done", { adapter: adapter.id, ...result, changed: anyChanged });
    } catch (err) {
      const waiting = err instanceof ProbeUnavailable;
      const message = waiting
        ? `waiting for access: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
      await store.appendFetchRun({
        adapter: adapter.id,
        url: adapter.url,
        started_at: startedAt,
        finished_at: now().toISOString(),
        ok: false,
        http_status: err instanceof FetchError ? err.status : lastStatus,
        content_hash: null,
        changed: false,
        observations: 0,
        error: scrubError(message).slice(0, 500),
      });
      outcomes.push({
        adapter: adapter.id,
        ok: false,
        skipped: waiting,
        result: null,
        error: message,
      });
      log(waiting ? "warn" : "error", waiting ? "adapter.waiting" : "adapter.failed", {
        adapter: adapter.id,
        error: message,
      });
    }
    await store.flush();
  }
  await store.flush();
  return { store, outcomes };
}
