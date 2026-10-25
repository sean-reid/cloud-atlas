import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  AZURE_SIZES,
  azureRegions,
  makeAdapter,
  PROBE_COUNTS,
  REGIONS_PER_CALL,
  scoreRequest,
  tokenRequest,
  zoneOf,
  type PlacementScore,
  type ScoreRequest,
  type ScoreResponse,
} from "../../pipeline/adapters/azure-placement-scores";
import { azureRegions as azureRegionsAdapter } from "../../pipeline/adapters/azure-regions";
import type { SqliteDb } from "../../pipeline/db";
import { fixtureFetch } from "../../pipeline/fixtures";
import { runAdapters } from "../../pipeline/run";
import type { HttpClient, HttpClientFactory, HttpRequest } from "../../pipeline/signed";
import { levelFor, measureFor } from "../../shared/availability";
import type { AvailabilitySignal } from "../../shared/types";
import { DATA, FIX, fast, fixedNow, memoryDb } from "./helpers";

const fixture = JSON.parse(
  readFileSync(join(FIX, "azure-placement-scores.json"), "utf8"),
) as ScoreResponse;
const SKUS = AZURE_SIZES.map((s) => s.sku);
const RESTRICTED_REGION = "westus3";
const TOKEN_URL = "https://login.microsoftonline.com/tenant-fixture/oauth2/v2.0/token";
const CREDS = {
  AZURE_TENANT_ID: "tenant-fixture",
  AZURE_CLIENT_ID: "client-fixture",
  AZURE_CLIENT_SECRET: "secret-fixture",
  AZURE_SUBSCRIPTION_ID: "00000000-0000-0000-0000-000000000000",
};

const recorded = (region: string, sku: string): PlacementScore | undefined =>
  fixture.placementScores!.find((p) => p.region === region && p.sku === sku);

// Replays the recorded scores for eastus and eastus2, answers every other region with the
// eastus block, and refuses every size in one region so the second round drops it.
function reply(body: ScoreRequest): ScoreResponse {
  const placementScores: PlacementScore[] = [];
  for (const region of body.desiredLocations)
    for (const { sku } of body.desiredSizes)
      placementScores.push(
        recorded(region, sku) ??
          (region === RESTRICTED_REGION
            ? { region, sku, score: "RestrictedSkuOrLocation", isQuotaAvailable: false }
            : { ...recorded("eastus", sku)!, region }),
      );
  return { ...body, placementScores };
}

interface Fake {
  calls: HttpRequest[];
  built: number;
  factory: HttpClientFactory;
}

function fakeClient(opts: { throttleFirst?: number; forbidden?: boolean } = {}): Fake {
  const fake: Fake = { calls: [], built: 0, factory: () => client };
  let throttles = opts.throttleFirst ?? 0;
  const client: HttpClient = async (req) => {
    fake.calls.push(req);
    if (req.url === TOKEN_URL)
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ token_type: "Bearer", expires_in: 3599, access_token: "tok" }),
      };
    if (opts.forbidden)
      return {
        status: 403,
        headers: {},
        body: JSON.stringify({
          error: {
            code: "AuthorizationFailed",
            message:
              "The client does not have authorization to perform action 'Microsoft.Compute/locations/placementScores/generate/action'.",
          },
        }),
      };
    if (throttles-- > 0) return { status: 429, headers: { "retry-after": "2" }, body: "" };
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reply(JSON.parse(req.body) as ScoreRequest)),
    };
  };
  fake.factory = () => {
    fake.built++;
    return client;
  };
  return fake;
}

let cache = "";
let db: SqliteDb;
beforeEach(async () => {
  cache = mkdtempSync(join(tmpdir(), "ca-cache-"));
  db = await memoryDb();
  for (const [k, v] of Object.entries(CREDS)) vi.stubEnv(k, v);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  rmSync(cache, { recursive: true, force: true });
  await db.close();
});

const options = () => ({
  db,
  dataRoot: DATA,
  dataset: "live" as const,
  cacheDir: cache,
  now: fixedNow,
  fetchDefaults: fast,
  tableRetryMs: 0,
  fetchImpl: fixtureFetch(FIX),
});

const run = (fake: Fake, sleeps: number[] = []) =>
  runAdapters(
    [makeAdapter(fake.factory, { gapMs: 0, sleep: async (ms) => void sleeps.push(ms) })],
    options(),
  );

const seedRegions = () => runAdapters([azureRegionsAdapter], options());

const signals = () =>
  db.query(
    "SELECT * FROM availability_signal ORDER BY region_code, sku, observed_at",
  ) as unknown as Promise<AvailabilitySignal[]>;

const scoreCalls = (fake: Fake) =>
  fake.calls
    .filter((c) => c.url !== TOKEN_URL)
    .map((c) => ({ url: c.url, headers: c.headers, body: JSON.parse(c.body) as ScoreRequest }));

const regionsInStore = async () =>
  (
    await db.query<{ code: string }>(
      "SELECT code FROM entity WHERE type = 'region' AND provider_slug = 'azure' ORDER BY code",
    )
  ).map((r) => r.code);

describe("azure spot placement scores", () => {
  test("the token request is a client-credentials form post for the management scope", () => {
    const req = tokenRequest({
      tenantId: "tenant-fixture",
      clientId: "client-fixture",
      clientSecret: "secret-fixture",
      subscriptionId: "sub",
    });
    expect(req.method).toBe("POST");
    expect(req.url).toBe(TOKEN_URL);
    expect(req.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(req.body))).toEqual({
      grant_type: "client_credentials",
      client_id: "client-fixture",
      client_secret: "secret-fixture",
      scope: "https://management.azure.com/.default",
    });
  });

  test("the score request matches the documented body and path", () => {
    const req = scoreRequest("sub-1", "tok", ["eastus", "eastus2"], SKUS, 8);
    expect(req.url).toBe(
      "https://management.azure.com/subscriptions/sub-1/providers/Microsoft.Compute/locations/eastus/placementScores/spot/generate?api-version=2025-06-05",
    );
    expect(req.headers.authorization).toBe("Bearer tok");
    expect(JSON.parse(req.body)).toEqual({
      availabilityZones: false,
      desiredCount: 8,
      desiredLocations: ["eastus", "eastus2"],
      desiredSizes: SKUS.map((sku) => ({ sku })),
    });
  });

  test("a regional answer has no zone, a zonal one keeps it", () => {
    expect(zoneOf({ region: "eastus" })).toBeNull();
    expect(zoneOf({ region: "eastus", availabilityZone: "False" })).toBeNull();
    expect(zoneOf({ region: "eastus", availabilityZone: "" })).toBeNull();
    expect(zoneOf({ region: "eastus", availabilityZone: "2" })).toBe("2");
  });

  test("regions come from the store's Azure region entities, else the geo index", async () => {
    const { store } = await runAdapters([], options());
    const ctx = {
      store,
      geo: { azure: { eastus: {}, westus: {} } },
    } as unknown as Parameters<typeof azureRegions>[0];
    expect(azureRegions(ctx)).toEqual(["eastus", "westus"]);
    await seedRegions();
    const seeded = await runAdapters([], options());
    expect(azureRegions({ ...ctx, store: seeded.store })).toEqual(await regionsInStore());
  });

  test("one signal per region, size and count, batched eight regions and five sizes per call", async () => {
    await seedRegions();
    const regions = await regionsInStore();
    expect(regions).toContain("eastus");
    expect(regions).toContain("eastus2");
    expect(regions).toContain(RESTRICTED_REGION);
    const fake = fakeClient();
    const { outcomes, store } = await run(fake);
    expect(outcomes[0]!.ok, outcomes[0]!.error ?? "").toBe(true);
    expect(fake.built).toBe(1);
    expect(fake.calls[0]!.url).toBe(TOKEN_URL);

    const calls = scoreCalls(fake);
    const firstRound = Math.ceil(regions.length / REGIONS_PER_CALL);
    const secondRound = Math.ceil((regions.length - 1) / REGIONS_PER_CALL);
    expect(calls).toHaveLength(firstRound + secondRound);
    expect(calls.length).toBeLessThan(40);
    expect(calls.slice(0, firstRound).map((c) => c.body.desiredCount)).toEqual(
      Array<number>(firstRound).fill(PROBE_COUNTS[0]!),
    );
    expect(calls.slice(firstRound).map((c) => c.body.desiredCount)).toEqual(
      Array<number>(secondRound).fill(PROBE_COUNTS[1]!),
    );
    for (const c of calls) {
      expect(c.headers.authorization).toBe("Bearer tok");
      expect(c.body.availabilityZones).toBe(false);
      expect(c.body.desiredLocations.length).toBeGreaterThan(0);
      expect(c.body.desiredLocations.length).toBeLessThanOrEqual(REGIONS_PER_CALL);
      expect(c.body.desiredSizes).toEqual(SKUS.map((sku) => ({ sku })));
      expect(c.url).toContain(`/locations/${c.body.desiredLocations[0]}/placementScores/spot/`);
    }
    expect(calls.slice(0, firstRound).flatMap((c) => c.body.desiredLocations)).toEqual(regions);
    expect(calls.slice(firstRound).flatMap((c) => c.body.desiredLocations)).toEqual(
      regions.filter((r) => r !== RESTRICTED_REGION),
    );

    const rows = await signals();
    const perRound = 5 * (regions.length - 3) + 5 + 3;
    expect(rows).toHaveLength(perRound * 2);
    expect(outcomes[0]!.result!.signals).toBe(rows.length);
    expect(rows.every((r) => r.signal === "spot_placement" && r.unit === "score")).toBe(true);
    expect(
      rows.every((r) => r.zone_code === null && r.observed_at === "2026-10-09T12:00:00Z"),
    ).toBe(true);
    expect(rows.some((r) => r.region_code === RESTRICTED_REGION)).toBe(false);
    expect(
      rows.some((r) => r.region_code === "eastus2" && r.sku === "Standard_ND96isr_H100_v5"),
    ).toBe(false);
    expect(rows.some((r) => r.region_code === "eastus2" && r.sku === "Standard_ND96asr_v4")).toBe(
      false,
    );

    const at = (region: string, sku: string, count: number) =>
      rows.find(
        (r) =>
          r.region_code === region &&
          r.sku === sku &&
          (JSON.parse(r.detail!) as { desired_count: number }).desired_count === count,
      )!;
    const high = at("eastus", "Standard_ND96isr_H100_v5", 8);
    expect(high.value).toBe(3);
    expect(high.sku_family).toBe("H100");
    expect(JSON.parse(high.detail!)).toEqual({
      score: "High",
      desired_count: 8,
      quota_available: true,
    });
    expect(at("eastus", "Standard_ND96isr_H100_v5", 1).id).not.toBe(high.id);
    const medium = at("eastus", "Standard_ND96asr_v4", 1);
    expect([medium.value, medium.sku_family]).toEqual([2, "A100"]);
    const low = at("eastus", "Standard_NC24ads_A100_v4", 1);
    expect([low.value, low.sku_family]).toEqual([1, "A100"]);
    expect((JSON.parse(low.detail!) as { quota_available: boolean }).quota_available).toBe(false);
    expect(at("eastus", "Standard_D8s_v5", 8).sku_family).toBe("general");
    expect(at("eastus2", "Standard_NV36ads_A10_v5", 8).value).toBe(2);

    const reading = (row: AvailabilitySignal) => ({
      spot_placement: {
        value: row.value,
        detail: JSON.parse(row.detail!) as Record<string, unknown>,
        baseline: null,
      },
    });
    expect([high, medium, low].map((r) => levelFor(reading(r), null))).toEqual([
      "available",
      "constrained",
      "tight",
    ]);
    expect(measureFor(reading(low))).toBe("spot score Low");
    expect(
      store.fetchRuns.filter((r) => r.ok && r.adapter === "azure-placement-scores"),
    ).toHaveLength(1);
  });

  test("a second run in the same hour adds nothing", async () => {
    const first = await run(fakeClient());
    expect(first.outcomes[0]!.result!.signals).toBeGreaterThan(0);
    const before = (await signals()).length;
    const second = await run(fakeClient());
    expect(second.outcomes[0]!.ok).toBe(true);
    expect(second.outcomes[0]!.result!.signals).toBe(0);
    expect(await signals()).toHaveLength(before);
    expect(second.store.fetchRuns.filter((r) => r.ok)).toHaveLength(2);
  });

  test("a 429 is retried after the Retry-After delay with the same body", async () => {
    const fake = fakeClient({ throttleFirst: 1 });
    const sleeps: number[] = [];
    const { outcomes } = await run(fake, sleeps);
    expect(outcomes[0]!.ok, outcomes[0]!.error ?? "").toBe(true);
    expect(sleeps).toContain(2000);
    const [first, second] = scoreCalls(fake);
    expect(first!.url).toBe(second!.url);
    expect(first!.body).toEqual(second!.body);
  });

  test("a subscription without the role records a waiting run after one call", async () => {
    const fake = fakeClient({ forbidden: true });
    const { outcomes, store } = await run(fake);
    expect(scoreCalls(fake)).toHaveLength(1);
    expect(outcomes[0]!.ok).toBe(false);
    expect(outcomes[0]!.skipped).toBe(true);
    expect(outcomes[0]!.error).toMatch(/^waiting for access: .*AuthorizationFailed/);
    expect(store.fetchRuns.at(-1)!.error).toMatch(/^waiting for access/);
    expect(await signals()).toHaveLength(0);
  });

  test("without the four variables the runner records a waiting run and never builds a client", async () => {
    vi.stubEnv("AZURE_CLIENT_SECRET", "");
    const fake = fakeClient();
    const { outcomes, store } = await run(fake);
    expect(outcomes[0]!.skipped).toBe(true);
    expect(outcomes[0]!.error).toBe("waiting for credentials");
    expect(fake.built).toBe(0);
    expect(fake.calls).toHaveLength(0);
    expect(store.fetchRuns).toHaveLength(1);
    expect(store.fetchRuns[0]!.ok).toBe(false);
    expect(store.fetchRuns[0]!.error).toBe("waiting for credentials");
    expect(await signals()).toHaveLength(0);
  });
});
