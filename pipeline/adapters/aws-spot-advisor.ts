import { stableId } from "../../shared/ids";
import { ensureSource } from "../entities";
import { emptyResult, meta, type Adapter, type AdapterContext } from "./types";

const URL = "https://spot-bid-advisor.s3.amazonaws.com/spot-advisor-data.json";
const PAGE = "https://aws.amazon.com/ec2/spot/instance-advisor/";

export const AWS_TYPES: readonly { sku: string; family: string }[] = [
  { sku: "p5.48xlarge", family: "H100" },
  { sku: "p5en.48xlarge", family: "H200" },
  { sku: "p4d.24xlarge", family: "A100" },
  { sku: "g6e.xlarge", family: "L40S" },
  { sku: "g5.xlarge", family: "A10G" },
  { sku: "trn1.32xlarge", family: "Trainium" },
  { sku: "inf2.xlarge", family: "Inferentia" },
  { sku: "m5.large", family: "general" },
  { sku: "c6i.large", family: "compute" },
];

interface Advisor {
  ranges: { index: number; label: string; max: number }[];
  spot_advisor: Record<string, { Linux?: Record<string, { s: number; r: number }> }>;
}

export const awsSpotAdvisor: Adapter = {
  ...meta("aws-spot-advisor"),
  url: PAGE,
  tier: 1,
  license: "Public data file behind the Spot Instance Advisor page; AWS Site Terms",
  hosts: ["spot-bid-advisor.s3.amazonaws.com"],
  source: () => ({
    id: "",
    publisher: "Amazon Web Services",
    title: "Spot Instance Advisor data",
    url: PAGE,
    tier: 1,
    published_date: null,
    license: "AWS Site Terms",
    adapter: "aws-spot-advisor",
  }),
  async run(ctx: AdapterContext) {
    const result = emptyResult();
    const now = ctx.now();
    const hour = now.toISOString().slice(0, 13) + ":00:00Z";
    const source = await ensureSource(ctx.store, { ...this.source(), adapter: this.id });
    const data = JSON.parse((await ctx.fetch(URL)).body) as Advisor;
    const labels = new Map(data.ranges.map((r) => [r.index, r.label]));
    for (const [region, os] of Object.entries(data.spot_advisor)) {
      const linux = os.Linux;
      if (!linux) continue;
      for (const { sku, family } of AWS_TYPES) {
        const entry = linux[sku];
        if (!entry) continue;
        const offered = await stableId("sig", ["aws", region, sku, "sku_offered", hour]);
        if (
          await ctx.store.appendSignal({
            id: offered,
            provider_slug: "aws",
            region_code: region,
            zone_code: null,
            sku,
            sku_family: family,
            signal: "sku_offered",
            value: 1,
            unit: "boolean",
            observed_at: hour,
            source_id: source.id,
            detail: JSON.stringify({ spot_savings_pct: entry.s }),
          })
        )
          result.signals++;
        const band = await stableId("sig", ["aws", region, sku, "interruption_band", hour]);
        if (
          await ctx.store.appendSignal({
            id: band,
            provider_slug: "aws",
            region_code: region,
            zone_code: null,
            sku,
            sku_family: family,
            signal: "interruption_band",
            value: entry.r,
            unit: "band",
            observed_at: hour,
            source_id: source.id,
            detail: JSON.stringify({
              label: labels.get(entry.r) ?? null,
              spot_savings_pct: entry.s,
              method: "interruption-band.v1",
            }),
          })
        )
          result.signals++;
      }
    }
    return result;
  },
};
