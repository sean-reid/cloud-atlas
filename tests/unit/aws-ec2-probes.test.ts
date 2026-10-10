import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  DescribeCapacityBlockOfferingsCommandInput,
  GetSpotPlacementScoresCommandInput,
} from "@aws-sdk/client-ec2";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  CAPACITY_BLOCK_REGIONS,
  CAPACITY_BLOCK_TYPES,
  CAPACITY_BLOCK_WINDOW_DAYS,
  LARGE_CAPACITY,
  NO_START_DATE,
  SMALL_CAPACITY,
  leadTimeDays,
  makeAdapter,
  type Ec2ClientFactory,
} from "../../pipeline/adapters/aws-ec2-probes";
import { AWS_TYPES } from "../../pipeline/adapters/aws-spot-advisor";
import type { SqliteDb } from "../../pipeline/db";
import { runAdapters } from "../../pipeline/run";
import type { AvailabilitySignal } from "../../shared/types";
import { memoryDb } from "./helpers";

const FIX = join(__dirname, "..", "fixtures");
const DATA = join(__dirname, "..", "..", "data");
const read = (name: string) => JSON.parse(readFileSync(join(FIX, name), "utf8"));

interface ScoreFixture {
  SpotPlacementScores: { Region: string; Score: number }[];
}
interface OfferingFixture {
  CapacityBlockOfferings: {
    StartDate: string;
    EndDate: string;
    UpfrontFee: string;
    CurrencyCode: string;
    [k: string]: unknown;
  }[];
}
const scoresFixture = read("aws-spot-placement-scores.json") as ScoreFixture;
const offeringsFixture = read("aws-capacity-block-offerings.json") as OfferingFixture;

interface Call {
  op: "GetSpotPlacementScores" | "DescribeCapacityBlockOfferings";
  region: string;
  input: GetSpotPlacementScoresCommandInput | DescribeCapacityBlockOfferingsCommandInput;
}

const awsError = (name: string, message: string) => Object.assign(new Error(message), { name });

// Replays the recorded responses: scores filtered to the requested regions, offerings for one
// region and type, an empty set everywhere else.
function fakeEc2(
  calls: Call[],
  opts: { failRegions?: readonly string[]; throttleFirst?: number } = {},
): Ec2ClientFactory {
  let throttles = opts.throttleFirst ?? 0;
  return (region) => ({
    async getSpotPlacementScores(input) {
      calls.push({ op: "GetSpotPlacementScores", region, input });
      if (throttles > 0) {
        throttles--;
        throw awsError("RequestLimitExceeded", "Request limit exceeded.");
      }
      const wanted = new Set(input.RegionNames);
      return {
        $metadata: {},
        SpotPlacementScores: scoresFixture.SpotPlacementScores.filter((s) => wanted.has(s.Region)),
      };
    },
    async describeCapacityBlockOfferings(input) {
      calls.push({ op: "DescribeCapacityBlockOfferings", region, input });
      if (opts.failRegions?.includes(region))
        throw awsError(
          "UnauthorizedOperation",
          "You are not authorized to perform this operation.",
        );
      if (region !== "us-east-1" || input.InstanceType !== "p5.48xlarge")
        return { $metadata: {}, CapacityBlockOfferings: [] };
      return {
        $metadata: {},
        CapacityBlockOfferings: offeringsFixture.CapacityBlockOfferings.map((o) => ({
          ...o,
          StartDate: new Date(o.StartDate),
          EndDate: new Date(o.EndDate),
        })),
      };
    },
  });
}

const fixedNow = () => new Date("2026-10-09T12:34:56Z");
const AWS_REGION_COUNT = 34;
const SCORE_BATCHES = Math.ceil(AWS_REGION_COUNT / 10);
const GPU_TYPES = AWS_TYPES.filter((t) => t.family !== "general" && t.family !== "compute");
const SCORE_CALLS = (AWS_TYPES.length + GPU_TYPES.length) * SCORE_BATCHES;
const SCORE_SIGNALS =
  scoresFixture.SpotPlacementScores.length * (AWS_TYPES.length + GPU_TYPES.length);
const LEAD_CALLS = CAPACITY_BLOCK_REGIONS.length * CAPACITY_BLOCK_TYPES.length;

let cache = "";
let db: SqliteDb;
let sleeps: number[] = [];
const sleep = async (ms: number) => {
  sleeps.push(ms);
};

beforeEach(async () => {
  cache = mkdtempSync(join(tmpdir(), "ca-cache-"));
  db = await memoryDb();
  sleeps = [];
  vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIAEXAMPLE");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "secret");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  rmSync(cache, { recursive: true, force: true });
  await db.close();
});

const run = (factory: Ec2ClientFactory) =>
  runAdapters([makeAdapter(factory, sleep)], {
    db,
    dataRoot: DATA,
    dataset: "live",
    cacheDir: cache,
    now: fixedNow,
  });

const signals = async (where: string) =>
  (await db.query(
    `SELECT * FROM availability_signal WHERE ${where}`,
  )) as unknown as AvailabilitySignal[];

describe("aws-ec2-probes", () => {
  test("scores every basket type across all regions and records lead times per region", async () => {
    const calls: Call[] = [];
    const { outcomes, store } = await run(fakeEc2(calls));
    expect(outcomes[0]!.ok, outcomes[0]!.error ?? "").toBe(true);
    expect(outcomes[0]!.result!.signals).toBe(SCORE_SIGNALS + LEAD_CALLS);
    expect(store.signalIds.size).toBe(SCORE_SIGNALS + LEAD_CALLS);

    const scoreCalls = calls.filter((c) => c.op === "GetSpotPlacementScores");
    expect(scoreCalls).toHaveLength(SCORE_CALLS);
    for (const c of scoreCalls) {
      const input = c.input as GetSpotPlacementScoresCommandInput;
      expect(c.region).toBe("us-east-1");
      expect(input.TargetCapacityUnitType).toBe("units");
      expect(input.SingleAvailabilityZone).toBe(false);
      expect(input.InstanceTypes).toHaveLength(1);
      expect(input.RegionNames!.length).toBeGreaterThan(0);
      expect(input.RegionNames!.length).toBeLessThanOrEqual(10);
      expect([SMALL_CAPACITY, LARGE_CAPACITY]).toContain(input.TargetCapacity);
    }
    const covered = new Set(
      scoreCalls.flatMap((c) => (c.input as GetSpotPlacementScoresCommandInput).RegionNames ?? []),
    );
    expect(covered.size).toBe(AWS_REGION_COUNT);
    expect(covered.has("us-east-1") && covered.has("ap-southeast-7")).toBe(true);
    expect(
      scoreCalls.filter(
        (c) => (c.input as GetSpotPlacementScoresCommandInput).TargetCapacity === 64,
      ),
    ).toHaveLength(GPU_TYPES.length * SCORE_BATCHES);

    const p5 = await signals(
      "signal = 'placement_score' AND sku = 'p5.48xlarge' AND region_code = 'us-west-2'",
    );
    expect(p5.map((s) => s.value)).toEqual([9, 9]);
    expect(p5.map((s) => JSON.parse(s.detail!).target_capacity).sort((a, b) => a - b)).toEqual([
      8, 64,
    ]);
    expect(p5.every((s) => s.sku_family === "H100" && s.unit === "score")).toBe(true);
    expect(p5[0]!.observed_at).toBe("2026-10-09T12:00:00Z");
    const m5 = await signals(
      "signal = 'placement_score' AND sku = 'm5.large' AND region_code = 'sa-east-1'",
    );
    expect(m5).toHaveLength(1);
    expect(m5[0]!.value).toBe(1);
    expect(JSON.parse(m5[0]!.detail!)).toEqual({
      target_capacity: 8,
      instance_types: ["m5.large"],
    });

    const leadCalls = calls.filter((c) => c.op === "DescribeCapacityBlockOfferings");
    expect(leadCalls).toHaveLength(LEAD_CALLS);
    for (const c of leadCalls) {
      const input = c.input as DescribeCapacityBlockOfferingsCommandInput;
      expect(CAPACITY_BLOCK_REGIONS).toContain(c.region);
      expect(CAPACITY_BLOCK_TYPES).toContain(input.InstanceType);
      expect(input.InstanceCount).toBe(1);
      expect(input.CapacityDurationHours).toBe(24);
      expect(input.StartDateRange).toEqual(fixedNow());
      const span = input.EndDateRange!.getTime() - fixedNow().getTime();
      expect(span).toBeGreaterThanOrEqual(CAPACITY_BLOCK_WINDOW_DAYS * 86_400_000);
    }
    const lead = await signals(
      "signal = 'lead_time_days' AND region_code = 'us-east-1' ORDER BY sku",
    );
    expect(lead.map((s) => [s.sku, s.sku_family, s.value, s.unit])).toEqual([
      ["p5.48xlarge", "H100", 1, "days"],
      ["p5en.48xlarge", "H200", NO_START_DATE, "days"],
    ]);
    expect(JSON.parse(lead[0]!.detail!)).toMatchObject({
      offerings: 2,
      earliest_start: "2026-10-11T11:30:00.000Z",
      upfront_fee: "787.68",
      currency_code: "USD",
    });
    expect(JSON.parse(lead[1]!.detail!)).toMatchObject({
      offerings: 0,
      earliest_start: null,
      upfront_fee: null,
    });
    const all = await signals("signal = 'lead_time_days'");
    expect(all).toHaveLength(LEAD_CALLS);
    expect(all.filter((s) => s.value === NO_START_DATE)).toHaveLength(LEAD_CALLS - 1);
  });

  test("a region that errors loses only its own signals", async () => {
    const calls: Call[] = [];
    const { outcomes } = await run(fakeEc2(calls, { failRegions: ["sa-east-1"] }));
    expect(outcomes[0]!.ok).toBe(true);
    expect(outcomes[0]!.result!.signals).toBe(
      SCORE_SIGNALS + LEAD_CALLS - CAPACITY_BLOCK_TYPES.length,
    );
    expect(await signals("signal = 'lead_time_days' AND region_code = 'sa-east-1'")).toHaveLength(
      0,
    );
    expect(await signals("signal = 'lead_time_days' AND region_code = 'us-east-1'")).toHaveLength(
      2,
    );
  });

  test("throttling backs off and retries, then falls back to single regions", async () => {
    const calls: Call[] = [];
    const { outcomes } = await run(fakeEc2(calls, { throttleFirst: 2 }));
    expect(outcomes[0]!.ok).toBe(true);
    expect(outcomes[0]!.result!.signals).toBe(SCORE_SIGNALS + LEAD_CALLS);
    expect(sleeps).toEqual([500, 1500]);
    expect(calls.filter((c) => c.op === "GetSpotPlacementScores")).toHaveLength(SCORE_CALLS + 2);

    const again: Call[] = [];
    sleeps = [];
    const second = await runAdapters([makeAdapter(fakeEc2(again, { throttleFirst: 3 }), sleep)], {
      db: await memoryDb(),
      dataRoot: DATA,
      dataset: "live",
      cacheDir: cache,
      now: fixedNow,
    });
    expect(second.outcomes[0]!.ok).toBe(true);
    expect(second.outcomes[0]!.result!.signals).toBe(SCORE_SIGNALS + LEAD_CALLS);
    expect(sleeps).toEqual([500, 1500]);
    expect(again.filter((c) => c.op === "GetSpotPlacementScores")).toHaveLength(
      SCORE_CALLS - 1 + 3 + 10,
    );
  });

  test("a second run in the same hour adds nothing", async () => {
    const first = await run(fakeEc2([]));
    const before = first.store.signalIds.size;
    const second = await run(fakeEc2([]));
    expect(second.outcomes[0]!.ok).toBe(true);
    expect(second.outcomes[0]!.result!.signals).toBe(0);
    expect(second.store.signalIds.size).toBe(before);
    expect(second.store.fetchRuns.filter((r) => r.ok)).toHaveLength(2);
  });

  test("without credentials the runner records a waiting run and calls nothing", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "");
    const calls: Call[] = [];
    const { outcomes, store } = await run(fakeEc2(calls));
    expect(outcomes[0]!.ok).toBe(false);
    expect(outcomes[0]!.skipped).toBe(true);
    expect(outcomes[0]!.error).toBe("waiting for credentials");
    expect(store.fetchRuns.at(-1)!.error).toMatch(/^waiting for credentials/);
    expect(store.signalIds.size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("lead time counts whole days and treats the first 24 hours as now", () => {
    const now = fixedNow();
    expect(leadTimeDays(now, undefined)).toBe(NO_START_DATE);
    expect(leadTimeDays(now, new Date("2026-10-09T13:00:00Z"))).toBe(0);
    expect(leadTimeDays(now, new Date("2026-10-10T11:30:00Z"))).toBe(0);
    expect(leadTimeDays(now, new Date("2026-10-11T11:30:00Z"))).toBe(1);
    expect(leadTimeDays(now, new Date("2026-10-23T11:30:00Z"))).toBe(13);
    expect(leadTimeDays(now, new Date("2026-10-08T11:30:00Z"))).toBe(0);
  });
});
