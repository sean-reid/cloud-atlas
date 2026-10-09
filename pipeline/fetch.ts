import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log";

export interface FetchOptions {
  adapter: string;
  allowHosts: readonly string[];
  cacheDir: string;
  timeoutMs?: number;
  retries?: number;
  minIntervalMs?: number;
  accept?: string;
  now?: () => Date;
  fetchImpl?: typeof fetch;
}

export interface FetchResult {
  url: string;
  status: number;
  body: string;
  hash: string;
  changed: boolean;
  fromCache: boolean;
  startedAt: string;
  finishedAt: string;
}

interface CacheEntry {
  etag: string | null;
  lastModified: string | null;
  hash: string;
  body: string;
  fetchedAt: string;
}

export class FetchError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly startedAt: string,
    readonly finishedAt: string,
  ) {
    super(message);
  }
}

const lastCall = new Map<string, number>();

export function hashBody(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

// Refuses anything that is not https to an allow-listed hostname, so an adapter can
// never be steered at an internal address by data it read.
export function assertAllowed(url: string, allowHosts: readonly string[]): URL {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new Error(`refusing non-https url ${url}`);
  if (u.username || u.password) throw new Error(`refusing credentials in url ${url}`);
  if (/^[\d.]+$|^\[/.test(u.hostname)) throw new Error(`refusing ip literal ${u.hostname}`);
  const ok = allowHosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
  if (!ok) throw new Error(`host ${u.hostname} is not allowed for this adapter`);
  return u;
}

function cachePath(dir: string, url: string): string {
  return join(dir, `${hashBody(url).slice(0, 24)}.json`);
}

function readCache(path: string): CacheEntry | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CacheEntry;
  } catch {
    return null;
  }
}

function retryDelayMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) return Math.min(secs * 1000, 120_000);
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.max(0, Math.min(at - Date.now(), 120_000));
  }
  return Math.min(1000 * 2 ** attempt, 30_000) + Math.floor(Math.random() * 250);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function safeFetch(url: string, opts: FetchOptions): Promise<FetchResult> {
  const u = assertAllowed(url, opts.allowHosts);
  const now = opts.now ?? (() => new Date());
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const retries = opts.retries ?? 3;
  const minInterval = opts.minIntervalMs ?? 1000;
  mkdirSync(opts.cacheDir, { recursive: true });
  const path = cachePath(opts.cacheDir, url);
  const cached = readCache(path);
  const startedAt = now().toISOString();

  const since = Date.now() - (lastCall.get(u.hostname) ?? 0);
  if (since < minInterval) await sleep(minInterval - since);

  let attempt = 0;
  for (;;) {
    lastCall.set(u.hostname, Date.now());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {
        "user-agent": "cloud-atlas/0.1 (+https://github.com/sean-reid/cloud-atlas)",
        accept: opts.accept ?? "application/json, text/csv, text/html;q=0.8, */*;q=0.5",
      };
      if (cached?.etag) headers["if-none-match"] = cached.etag;
      if (cached?.lastModified) headers["if-modified-since"] = cached.lastModified;
      const res = await doFetch(u, { headers, signal: controller.signal, redirect: "follow" });
      clearTimeout(timer);
      if (res.status === 304 && cached) {
        log("info", "fetch.not_modified", { adapter: opts.adapter, url });
        const finishedAt = now().toISOString();
        return {
          url,
          status: 304,
          body: cached.body,
          hash: cached.hash,
          changed: false,
          fromCache: true,
          startedAt,
          finishedAt,
        };
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= retries) {
          throw new FetchError(
            `http ${res.status} after ${attempt + 1} attempts`,
            res.status,
            startedAt,
            now().toISOString(),
          );
        }
        const delay = retryDelayMs(attempt, res.headers.get("retry-after"));
        log("warn", "fetch.retry", {
          adapter: opts.adapter,
          url,
          status: res.status,
          delay_ms: delay,
        });
        attempt++;
        await sleep(delay);
        continue;
      }
      if (!res.ok)
        throw new FetchError(`http ${res.status}`, res.status, startedAt, now().toISOString());
      const body = await res.text();
      const hash = hashBody(body);
      const changed = !cached || cached.hash !== hash;
      const entry: CacheEntry = {
        etag: res.headers.get("etag"),
        lastModified: res.headers.get("last-modified"),
        hash,
        body,
        fetchedAt: now().toISOString(),
      };
      writeFileSync(path, JSON.stringify(entry));
      log("info", "fetch.ok", {
        adapter: opts.adapter,
        url,
        status: res.status,
        bytes: body.length,
        changed,
      });
      return {
        url,
        status: res.status,
        body,
        hash,
        changed,
        fromCache: false,
        startedAt,
        finishedAt: now().toISOString(),
      };
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof FetchError) throw err;
      if (attempt >= retries) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new FetchError(msg, null, startedAt, now().toISOString());
      }
      const delay = retryDelayMs(attempt, null);
      log("warn", "fetch.retry", {
        adapter: opts.adapter,
        url,
        error: String(err),
        delay_ms: delay,
      });
      attempt++;
      await sleep(delay);
    }
  }
}
