import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { assertAllowed, safeFetch } from "../../pipeline/fetch";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function fakeFetch(
  responses: Array<{ status: number; body?: string; headers?: Record<string, string> }>,
) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = (async (input: URL | string | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers as Record<string, string>) ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return new Response(next.status === 304 ? null : (next.body ?? ""), {
      status: next.status,
      headers: next.headers ?? {},
    });
  }) as typeof fetch;
  return { impl, calls };
}

const base = (dir: string, impl: typeof fetch) => ({
  adapter: "test",
  allowHosts: ["example.com"],
  cacheDir: dir,
  fetchImpl: impl,
  minIntervalMs: 0,
  retries: 2,
});

describe("url guard", () => {
  test("allows only https to listed hosts", () => {
    expect(() => assertAllowed("http://example.com/x", ["example.com"])).toThrow(/https/);
    expect(() => assertAllowed("https://evil.com/x", ["example.com"])).toThrow(/not allowed/);
    expect(() => assertAllowed("https://10.0.0.1/x", ["10.0.0.1"])).toThrow(/ip literal/);
    expect(() => assertAllowed("https://user:pw@example.com/x", ["example.com"])).toThrow(
      /credentials/,
    );
    expect(assertAllowed("https://api.example.com/x", ["example.com"]).hostname).toBe(
      "api.example.com",
    );
  });
});

describe("safeFetch", () => {
  test("caches, detects change, and sends conditional headers", async () => {
    dir = mkdtempSync(join(tmpdir(), "ca-fetch-"));
    const f = fakeFetch([
      { status: 200, body: "v1", headers: { etag: '"a"' } },
      { status: 304 },
      { status: 200, body: "v2", headers: { etag: '"b"' } },
    ]);
    const first = await safeFetch("https://example.com/data", base(dir, f.impl));
    expect(first.changed).toBe(true);
    const second = await safeFetch("https://example.com/data", base(dir, f.impl));
    expect(second.fromCache).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.body).toBe("v1");
    expect(f.calls[1]?.headers["if-none-match"]).toBe('"a"');
    const third = await safeFetch("https://example.com/data", base(dir, f.impl));
    expect(third.changed).toBe(true);
    expect(third.body).toBe("v2");
  });

  test("retries on 429 honouring Retry-After, then succeeds", async () => {
    dir = mkdtempSync(join(tmpdir(), "ca-fetch-"));
    const f = fakeFetch([
      { status: 429, headers: { "retry-after": "0" } },
      { status: 200, body: "ok" },
    ]);
    const res = await safeFetch("https://example.com/r", base(dir, f.impl));
    expect(res.body).toBe("ok");
    expect(f.calls.length).toBe(2);
  });

  test("gives up after the retry budget with the status attached", async () => {
    dir = mkdtempSync(join(tmpdir(), "ca-fetch-"));
    const f = fakeFetch([
      { status: 503, headers: { "retry-after": "0" } },
      { status: 503, headers: { "retry-after": "0" } },
      { status: 503, headers: { "retry-after": "0" } },
    ]);
    await expect(safeFetch("https://example.com/r", base(dir, f.impl))).rejects.toMatchObject({
      status: 503,
    });
  });

  test("a 404 is not retried", async () => {
    dir = mkdtempSync(join(tmpdir(), "ca-fetch-"));
    const f = fakeFetch([{ status: 404 }]);
    await expect(safeFetch("https://example.com/r", base(dir, f.impl))).rejects.toMatchObject({
      status: 404,
    });
    expect(f.calls.length).toBe(1);
  });
});
