import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  adviceRequest,
  leadTimeDays,
  makeAdapter,
  regionsByType,
  type AdviceRequest,
  type AdviceResponse,
  type CalendarClientFactory,
} from "../../pipeline/adapters/gcp-calendar-mode";
import type { SqliteDb } from "../../pipeline/db";
import { fixtureFetch } from "../../pipeline/fixtures";
import { runAdapters } from "../../pipeline/run";
import type { AvailabilitySignal } from "../../shared/types";
import { levelFor } from "../../shared/availability";
import { DATA, FIX, fast, fixedNow, memoryDb } from "./helpers";

const fixture = readFileSync(join(FIX, "gcp-calendar-mode.json"), "utf8");
const zonesPage = readFileSync(join(FIX, "gcp-gpu-zones.html"), "utf8");
const KEY = JSON.stringify({
  type: "service_account",
  project_id: "atlas-probe",
  client_email: "probe@atlas-probe.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n",
});

interface Call {
  url: string;
  token: string;
  body: AdviceRequest;
}

// Replays the recorded response, moved into the requested region. A3 Mega starts in five
// days, A3 Ultra has no start, and A4 is rejected as unsupported; everything else starts today.
function fakeClient(calls: Call[], keys: string[], failFirst = 0): CalendarClientFactory {
  let remaining = failFirst;
  return (json) => {
    keys.push(json);
    return {
      token: async () => "fake-token",
      post: async (url, token, body) => {
        calls.push({ url, token, body });
        if (remaining-- > 0) return { status: 429, body: "slow down", retryAfter: "1" };
        const sku = body.futureResourcesSpecs.spec.targetResources.specificSkuResources.machineType;
        const region = /regions\/([a-z0-9-]+)\//.exec(url)![1]!;
        if (sku === "a4-highgpu-8g")
          return {
            status: 400,
            body: JSON.stringify({
              error: {
                code: 400,
                message: `Machine type ${sku} is not supported in region ${region}.`,
                status: "INVALID_ARGUMENT",
              },
            }),
            retryAfter: null,
          };
        const res = JSON.parse(fixture.replaceAll("us-central1", region)) as AdviceResponse;
        const rec = res.recommendations![0]!.recommendationsPerSpec!.spec!;
        if (sku === "a3-megagpu-8g") {
          rec.startTime = "2026-10-14T00:00:00Z";
          rec.endTime = "2026-10-15T00:00:00Z";
        }
        if (sku === "a3-ultragpu-8g") {
          delete rec.startTime;
          delete rec.endTime;
          delete rec.location;
          for (const z of Object.values(rec.otherLocations!)) z.status = "NO_CAPACITY";
        }
        return { status: 200, body: JSON.stringify(res), retryAfter: null };
      },
    };
  };
}

let cache = "";
let db: SqliteDb;
beforeEach(async () => {
  cache = mkdtempSync(join(tmpdir(), "ca-cache-"));
  db = await memoryDb();
  vi.stubEnv("GCP_PROJECT", "atlas-probe");
  vi.stubEnv("GCP_SERVICE_ACCOUNT_JSON", KEY);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  rmSync(cache, { recursive: true, force: true });
  await db.close();
});

const run = (factory: CalendarClientFactory, sleeps: number[] = []) =>
  runAdapters([makeAdapter(factory, { gapMs: 0, sleep: async (ms) => void sleeps.push(ms) })], {
    db,
    dataRoot: DATA,
    dataset: "live",
    cacheDir: cache,
    now: fixedNow,
    fetchDefaults: fast,
    fetchImpl: fixtureFetch(FIX),
  });

const signals = () =>
  db.query("SELECT * FROM availability_signal") as unknown as Promise<AvailabilitySignal[]>;

describe("gcp calendar-mode lead times", () => {
  test("regions come from the GPU zones page per machine type", () => {
    const regions = regionsByType(zonesPage);
    expect(regions.get("a3-ultragpu-8g")).toEqual([
      "europe-west1",
      "europe-west4",
      "us-central1",
      "us-east4",
      "us-west1",
    ]);
    expect(regions.get("a4-highgpu-8g")).toEqual([
      "asia-northeast1",
      "asia-southeast1",
      "europe-west1",
      "europe-west4",
      "us-central1",
      "us-east1",
      "us-east4",
    ]);
    expect(regions.get("a3-highgpu-8g")).toContain("asia-east1");
    expect(regions.get("a3-megagpu-8g")).toContain("us-west1");
  });

  test("the request matches the documented calendarMode body", () => {
    expect(adviceRequest("a3-highgpu-8g", 8, new Date("2026-10-09T12:00:00Z"))).toEqual({
      futureResourcesSpecs: {
        spec: {
          targetResources: {
            specificSkuResources: { instanceCount: "8", machineType: "a3-highgpu-8g" },
          },
          timeRangeSpec: {
            startTimeNotEarlierThan: "2026-10-09T12:00:00Z",
            startTimeNotLaterThan: "2026-12-08T12:00:00Z",
            minDuration: "86400s",
            maxDuration: "86400s",
          },
        },
      },
    });
  });

  test("lead time is whole days from now, 0 for today, 999 for no start", () => {
    const now = fixedNow();
    expect(leadTimeDays("2026-10-09T00:00:00Z", now)).toBe(0);
    expect(leadTimeDays("2026-10-09T23:59:59Z", now)).toBe(0);
    expect(leadTimeDays("2026-10-10T00:00:00Z", now)).toBe(1);
    expect(leadTimeDays("2026-10-14T00:00:00Z", now)).toBe(5);
    expect(leadTimeDays(undefined, now)).toBe(999);
    expect(leadTimeDays("garbage", now)).toBe(999);
  });

  test("one signal per region, machine type, and probe size, with rejections skipped", async () => {
    const calls: Call[] = [];
    const keys: string[] = [];
    const { outcomes, store } = await run(fakeClient(calls, keys));
    expect(outcomes[0]!.ok, outcomes[0]!.error ?? "").toBe(true);
    expect(keys).toEqual([KEY]);

    const regions = regionsByType(zonesPage);
    const probed = [...regions.values()].reduce((n, r) => n + r.length, 0) * 2;
    expect(calls).toHaveLength(probed);
    expect(calls.every((c) => c.token === "fake-token")).toBe(true);
    expect(calls.map((c) => c.url)).toContain(
      "https://compute.googleapis.com/compute/v1/projects/atlas-probe/regions/us-central1/advice/calendarMode",
    );
    expect(
      calls.map((c) => c.body.futureResourcesSpecs.spec.timeRangeSpec.startTimeNotEarlierThan),
    ).toContain("2026-10-09T12:00:00Z");

    const rows = await signals();
    const rejected = regions.get("a4-highgpu-8g")!.length * 2;
    expect(rows).toHaveLength(probed - rejected);
    expect(outcomes[0]!.result!.signals).toBe(rows.length);
    expect(rows.every((r) => r.signal === "lead_time_days" && r.unit === "days")).toBe(true);
    expect(rows.some((r) => r.sku === "a4-highgpu-8g")).toBe(false);

    const at = (sku: string, count: number) =>
      rows.find(
        (r) =>
          r.region_code === "us-central1" &&
          r.sku === sku &&
          (JSON.parse(r.detail!) as { instance_count: number }).instance_count === count,
      )!;
    const today = at("a3-highgpu-8g", 8);
    expect(today.value).toBe(0);
    expect(today.zone_code).toBe("us-central1-b");
    expect(today.sku_family).toBe("H100");
    expect(today.observed_at).toBe("2026-10-09T12:00:00Z");
    expect(JSON.parse(today.detail!)).toEqual({
      instance_count: 8,
      earliest_start: "2026-10-09T00:00:00Z",
      end_time: "2026-10-10T00:00:00Z",
      duration_hours: 24,
      zones: {
        "us-central1-a": "RECOMMENDED",
        "us-central1-c": "NO_CAPACITY",
        "us-central1-f": "NOT_SUPPORTED",
      },
    });
    expect(at("a3-highgpu-8g", 1).id).not.toBe(today.id);

    const later = at("a3-megagpu-8g", 1);
    expect(later.value).toBe(5);
    expect(later.sku_family).toBe("H100");

    const never = at("a3-ultragpu-8g", 8);
    expect(never.value).toBe(999);
    expect(never.zone_code).toBeNull();
    expect(never.sku_family).toBe("H200");
    expect((JSON.parse(never.detail!) as { earliest_start: unknown }).earliest_start).toBeNull();

    const level = (v: number) =>
      levelFor({ lead_time_days: { value: v, detail: null, baseline: null } }, null);
    expect([today, later, never].map((r) => level(r.value))).toEqual([
      "available",
      "tight",
      "tight",
    ]);
    expect(store.fetchRuns.filter((r) => r.ok)).toHaveLength(1);
  });

  test("a second run in the same hour adds nothing", async () => {
    const first = await run(fakeClient([], []));
    expect(first.outcomes[0]!.result!.signals).toBeGreaterThan(0);
    const before = (await signals()).length;
    const second = await run(fakeClient([], []));
    expect(second.outcomes[0]!.ok).toBe(true);
    expect(second.outcomes[0]!.result!.signals).toBe(0);
    expect(await signals()).toHaveLength(before);
    expect(second.store.fetchRuns.filter((r) => r.ok)).toHaveLength(2);
  });

  test("a 429 is retried after the Retry-After delay", async () => {
    const calls: Call[] = [];
    const sleeps: number[] = [];
    const { outcomes } = await run(fakeClient(calls, [], 1), sleeps);
    expect(outcomes[0]!.ok).toBe(true);
    expect(sleeps).toContain(1000);
    expect(calls[0]!.url).toBe(calls[1]!.url);
    expect(calls[0]!.body).toEqual(calls[1]!.body);
  });

  test("without GCP_PROJECT the runner records a waiting run and never builds a client", async () => {
    vi.stubEnv("GCP_PROJECT", "");
    const keys: string[] = [];
    const { outcomes, store } = await run(fakeClient([], keys));
    expect(outcomes[0]!.skipped).toBe(true);
    expect(outcomes[0]!.error).toBe("waiting for credentials: GCP_PROJECT");
    expect(keys).toHaveLength(0);
    expect(store.fetchRuns).toHaveLength(1);
    expect(store.fetchRuns[0]!.ok).toBe(false);
    expect(store.fetchRuns[0]!.error).toBe("waiting for credentials: GCP_PROJECT");
    expect(await signals()).toHaveLength(0);
  });
});
