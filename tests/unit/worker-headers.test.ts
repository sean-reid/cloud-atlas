import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  CONTENT_SECURITY_POLICY,
  SECURITY_HEADERS,
  withSecurityHeaders,
} from "../../worker/headers";

describe("withSecurityHeaders", () => {
  test("adds every header and keeps the body, status, and existing headers", async () => {
    const res = withSecurityHeaders(
      new Response("hi", { status: 201, headers: { "content-type": "text/plain" } }),
    );
    expect(res.status).toBe(201);
    expect(await res.text()).toBe("hi");
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("permissions-policy")).toContain("geolocation=()");
    expect(res.headers.get("content-security-policy")).toBe(CONTENT_SECURITY_POLICY);
  });
  test("the policy has no unsafe-inline and no unsafe-eval", () => {
    expect(CONTENT_SECURITY_POLICY).not.toContain("unsafe");
    expect(CONTENT_SECURITY_POLICY).toContain("worker-src 'self' blob:");
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
  });
  test("public/_headers carries the same headers for the asset paths", () => {
    const text = readFileSync(join(__dirname, "..", "..", "public", "_headers"), "utf8");
    const block = text.split(/\n(?=\S)/).find((b) => b.startsWith("/*\n"));
    expect(block).toBeDefined();
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      const line = block!
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.toLowerCase().startsWith(`${name}:`));
      expect(line, name).toBeDefined();
      expect(line!.slice(line!.indexOf(":") + 1).trim()).toBe(value);
    }
    expect(text).toMatch(
      /\/assets\/\*\n(.*\n)*?\s+Cache-Control: public, max-age=31536000, immutable/,
    );
    expect(text).toMatch(/\/fonts\/\*\n(.*\n)*?\s+Cache-Control: public, max-age=31536000\n/);
  });
});
