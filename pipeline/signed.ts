import { createHash, createHmac } from "node:crypto";
import { assertAllowed } from "./fetch";
import { log } from "./log";

// Account probes sign their own requests, so they bypass the cached GET fetcher and
// go through this minimal client instead. Tests inject a fake that replays fixtures.
export interface HttpRequest {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type HttpClient = (req: HttpRequest) => Promise<HttpResponse>;
export type HttpClientFactory = () => HttpClient;

export interface RetryOptions {
  tries: number;
  sleep: (ms: number) => Promise<void>;
}

export const DEFAULT_RETRY: RetryOptions = {
  tries: 3,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

const lastCall = new Map<string, number>();

export function defaultHttpClient(allowHosts: readonly string[], minIntervalMs = 250): HttpClient {
  return async (req) => {
    const u = assertAllowed(req.url, allowHosts);
    const since = Date.now() - (lastCall.get(u.hostname) ?? 0);
    if (since < minIntervalMs) await DEFAULT_RETRY.sleep(minIntervalMs - since);
    lastCall.set(u.hostname, Date.now());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(u, {
        method: req.method,
        headers: req.headers,
        ...(req.method === "POST" ? { body: req.body } : {}),
        signal: controller.signal,
        redirect: "manual",
      });
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
      return { status: res.status, headers, body: await res.text() };
    } finally {
      clearTimeout(timer);
    }
  };
}

function retryDelayMs(attempt: number, retryAfter: string | undefined): number {
  const secs = Number(retryAfter);
  if (retryAfter && Number.isFinite(secs)) return Math.min(secs * 1000, 60_000);
  return Math.min(1000 * 2 ** attempt, 20_000);
}

// Resends when the provider says it is throttling, up to opts.tries attempts in total.
// Any other response, including other errors, goes straight back to the caller.
export async function sendWithRetry(
  client: HttpClient,
  req: HttpRequest,
  throttled: (res: HttpResponse) => boolean,
  opts: RetryOptions,
  adapter: string,
): Promise<HttpResponse> {
  for (let attempt = 0; ; attempt++) {
    const res = await client(req);
    if (!throttled(res) || attempt + 1 >= opts.tries) return res;
    const delay = retryDelayMs(attempt, res.headers["retry-after"]);
    log("warn", "probe.throttled", { adapter, url: req.url, status: res.status, delay_ms: delay });
    await opts.sleep(delay);
  }
}

export const sha256Hex = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

export const sha256Base64 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("base64");

export const hmacSha256 = (key: Buffer | string, text: string): Buffer =>
  createHmac("sha256", key).update(text, "utf8").digest();

// RFC 3986 encoding: the WHATWG encoder leaves !'()* alone, the signing schemes do not.
export const rfc3986 = (s: string): string =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

export function canonicalQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(params[k]!)}`)
    .join("&");
}

export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}
