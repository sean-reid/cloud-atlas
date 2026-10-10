import {
  DescribeCapacityBlockOfferingsCommand,
  EC2Client,
  GetSpotPlacementScoresCommand,
  type DescribeCapacityBlockOfferingsCommandInput,
  type DescribeCapacityBlockOfferingsCommandOutput,
  type GetSpotPlacementScoresCommandInput,
  type GetSpotPlacementScoresCommandOutput,
} from "@aws-sdk/client-ec2";
import { stableId } from "../../shared/ids";
import { ensureSource } from "../entities";
import { log } from "../log";
import { AWS_TYPES } from "./aws-spot-advisor";
import { emptyResult, meta, type Adapter, type AdapterContext } from "./types";

const PLACEMENT_REF =
  "https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_GetSpotPlacementScores.html";

export interface Ec2Probe {
  getSpotPlacementScores: (
    input: GetSpotPlacementScoresCommandInput,
  ) => Promise<GetSpotPlacementScoresCommandOutput>;
  describeCapacityBlockOfferings: (
    input: DescribeCapacityBlockOfferingsCommandInput,
  ) => Promise<DescribeCapacityBlockOfferingsCommandOutput>;
}

export type Ec2ClientFactory = (region: string) => Ec2Probe;

export const SCORE_REGION = "us-east-1";
export const SMALL_CAPACITY = 8;
export const LARGE_CAPACITY = 64;
const CONTROL_FAMILIES = new Set(["general", "compute"]);

// Regions where the Capacity Blocks user guide lists p5.48xlarge or p5en.48xlarge.
export const CAPACITY_BLOCK_REGIONS: readonly string[] = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "eu-north-1",
  "eu-west-2",
  "eu-south-2",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-south-1",
  "ap-southeast-2",
  "ap-southeast-3",
  "sa-east-1",
];
export const CAPACITY_BLOCK_TYPES: readonly string[] = ["p5.48xlarge", "p5en.48xlarge"];
export const CAPACITY_BLOCK_WINDOW_DAYS = 14;
const CAPACITY_BLOCK_HOURS = 24;
export const NO_START_DATE = 999;

// GetSpotPlacementScores accepts at most 10 RegionNames per call.
const REGIONS_PER_CALL = 10;
const MAX_PAGES = 5;
const RETRIES = 3;
const BACKOFF_MS = [500, 1500];

const DAY_MS = 86_400_000;

export const defaultFactory: Ec2ClientFactory = (region) => {
  const client = new EC2Client({
    region,
    maxAttempts: 1,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
    },
  });
  return {
    getSpotPlacementScores: (input) => client.send(new GetSpotPlacementScoresCommand(input)),
    describeCapacityBlockOfferings: (input) =>
      client.send(new DescribeCapacityBlockOfferingsCommand(input)),
  };
};

export function isThrottle(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as Error & { Code?: string }).Code;
  return err.name === "RequestLimitExceeded" || code === "RequestLimitExceeded";
}

export function leadTimeDays(now: Date, start: Date | undefined): number {
  if (!start) return NO_START_DATE;
  return Math.max(0, Math.floor((start.getTime() - now.getTime()) / DAY_MS));
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

type Sleep = (ms: number) => Promise<void>;
const defaultSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeAdapter(factory: Ec2ClientFactory, sleep: Sleep = defaultSleep): Adapter {
  const clients = new Map<string, Ec2Probe>();
  const client = (region: string) => {
    let c = clients.get(region);
    if (!c) {
      c = factory(region);
      clients.set(region, c);
    }
    return c;
  };

  async function withRetry<T>(op: string, region: string, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (!isThrottle(err) || attempt >= RETRIES) throw err;
        log("warn", "adapter.throttled", { adapter: "aws-ec2-probes", op, region, attempt });
        await sleep(BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!);
      }
    }
  }

  async function scores(sku: string, capacity: number, regions: readonly string[]) {
    const out = new Map<string, number>();
    let token: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await withRetry("GetSpotPlacementScores", SCORE_REGION, () =>
        client(SCORE_REGION).getSpotPlacementScores({
          InstanceTypes: [sku],
          TargetCapacity: capacity,
          TargetCapacityUnitType: "units",
          SingleAvailabilityZone: false,
          RegionNames: [...regions],
          NextToken: token,
        }),
      );
      for (const s of res.SpotPlacementScores ?? []) {
        if (s.Region && typeof s.Score === "number") out.set(s.Region, s.Score);
      }
      token = res.NextToken;
      if (!token) break;
    }
    return out;
  }

  // A failed batch retries one region at a time so one bad region costs only itself.
  async function scoreRegions(
    sku: string,
    capacity: number,
    regions: readonly string[],
  ): Promise<Map<string, number>> {
    try {
      return await scores(sku, capacity, regions);
    } catch (err) {
      if (regions.length === 1) {
        log("warn", "adapter.region_failed", {
          adapter: "aws-ec2-probes",
          op: "GetSpotPlacementScores",
          region: regions[0]!,
          sku,
          error: errorText(err),
        });
        return new Map();
      }
      const out = new Map<string, number>();
      for (const region of regions) {
        for (const [k, v] of await scoreRegions(sku, capacity, [region])) out.set(k, v);
      }
      return out;
    }
  }

  return {
    ...meta("aws-ec2-probes"),
    url: PLACEMENT_REF,
    tier: 1,
    license: "Account API responses; AWS Customer Agreement",
    hosts: [...new Set([SCORE_REGION, ...CAPACITY_BLOCK_REGIONS])].map(
      (r) => `ec2.${r}.amazonaws.com`,
    ),
    source: () => ({
      id: "",
      publisher: "Amazon Web Services",
      title: "EC2 Spot placement scores and Capacity Block offerings",
      url: PLACEMENT_REF,
      tier: 1,
      published_date: null,
      license: "AWS Customer Agreement",
      adapter: "aws-ec2-probes",
    }),
    async run(ctx: AdapterContext) {
      const result = emptyResult();
      const now = ctx.now();
      const hour = now.toISOString().slice(0, 13) + ":00:00Z";
      const source = await ensureSource(ctx.store, { ...this.source(), adapter: this.id });
      const regions = Object.keys(ctx.geo["aws"] ?? {}).sort();

      for (const { sku, family } of AWS_TYPES) {
        const capacities = CONTROL_FAMILIES.has(family)
          ? [SMALL_CAPACITY]
          : [SMALL_CAPACITY, LARGE_CAPACITY];
        for (const capacity of capacities) {
          for (const batch of chunk(regions, REGIONS_PER_CALL)) {
            for (const [region, score] of await scoreRegions(sku, capacity, batch)) {
              const id = await stableId("sig", [
                "aws",
                region,
                sku,
                "placement_score",
                hour,
                capacity,
              ]);
              if (
                await ctx.store.appendSignal({
                  id,
                  provider_slug: "aws",
                  region_code: region,
                  zone_code: null,
                  sku,
                  sku_family: family,
                  signal: "placement_score",
                  value: score,
                  unit: "score",
                  observed_at: hour,
                  source_id: source.id,
                  detail: JSON.stringify({ target_capacity: capacity, instance_types: [sku] }),
                })
              )
                result.signals++;
            }
          }
        }
      }

      const windowEnd = new Date(
        now.getTime() + CAPACITY_BLOCK_WINDOW_DAYS * DAY_MS + CAPACITY_BLOCK_HOURS * 3_600_000,
      );
      for (const region of CAPACITY_BLOCK_REGIONS) {
        for (const sku of CAPACITY_BLOCK_TYPES) {
          const family = AWS_TYPES.find((t) => t.sku === sku)?.family ?? sku;
          let res: DescribeCapacityBlockOfferingsCommandOutput;
          try {
            res = await withRetry("DescribeCapacityBlockOfferings", region, () =>
              client(region).describeCapacityBlockOfferings({
                InstanceType: sku,
                InstanceCount: 1,
                CapacityDurationHours: CAPACITY_BLOCK_HOURS,
                StartDateRange: now,
                EndDateRange: windowEnd,
              }),
            );
          } catch (err) {
            log("warn", "adapter.region_failed", {
              adapter: "aws-ec2-probes",
              op: "DescribeCapacityBlockOfferings",
              region,
              sku,
              error: errorText(err),
            });
            continue;
          }
          const offerings = (res.CapacityBlockOfferings ?? []).filter((o) => o.StartDate);
          offerings.sort((a, b) => a.StartDate!.getTime() - b.StartDate!.getTime());
          const earliest = offerings[0];
          const id = await stableId("sig", ["aws", region, sku, "lead_time_days", hour]);
          if (
            await ctx.store.appendSignal({
              id,
              provider_slug: "aws",
              region_code: region,
              zone_code: null,
              sku,
              sku_family: family,
              signal: "lead_time_days",
              value: leadTimeDays(now, earliest?.StartDate),
              unit: "days",
              observed_at: hour,
              source_id: source.id,
              detail: JSON.stringify({
                offerings: offerings.length,
                earliest_start: earliest?.StartDate?.toISOString() ?? null,
                upfront_fee: earliest?.UpfrontFee ?? null,
                currency_code: earliest?.CurrencyCode ?? null,
                instance_count: 1,
                duration_hours: CAPACITY_BLOCK_HOURS,
                method: "lead-time-days.v1",
              }),
            })
          )
            result.signals++;
        }
      }
      return result;
    },
  };
}

export const awsEc2Probes: Adapter = makeAdapter(defaultFactory);
