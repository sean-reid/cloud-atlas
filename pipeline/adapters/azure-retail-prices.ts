import { stableId } from "../../shared/ids";
import { ensureSource } from "../entities";
import { emptyResult, meta, type Adapter, type AdapterContext } from "./types";

const API = "https://prices.azure.com/api/retail/prices";

// SKU basket: the GPU families people fight over plus two general-purpose controls.
export const AZURE_SKUS: readonly { sku: string; family: string }[] = [
  { sku: "Standard_ND96isr_H100_v5", family: "H100" },
  { sku: "Standard_NC40ads_H100_v5", family: "H100" },
  { sku: "Standard_ND96isr_MI300X_v5", family: "MI300X" },
  { sku: "Standard_NC24ads_A100_v4", family: "A100" },
  { sku: "Standard_NC4as_T4_v3", family: "T4" },
  { sku: "Standard_D4s_v5", family: "general" },
  { sku: "Standard_E8s_v5", family: "memory" },
];

interface Item {
  armRegionName: string;
  armSkuName: string;
  retailPrice: number;
  unitOfMeasure: string;
  productName: string;
  skuName: string;
  meterName: string;
  type: string;
}

interface Page {
  Items: Item[];
  NextPageLink: string | null;
}

export interface RegionPrices {
  onDemand: number | null;
  spot: number | null;
}

export function summarise(items: readonly Item[]): Map<string, RegionPrices> {
  const out = new Map<string, RegionPrices>();
  for (const it of items) {
    if (it.type !== "Consumption") continue;
    if (/windows/i.test(it.productName)) continue;
    if (/low priority/i.test(it.meterName)) continue;
    if (!/^1 hour$/i.test(it.unitOfMeasure)) continue;
    const entry = out.get(it.armRegionName) ?? { onDemand: null, spot: null };
    const isSpot = /spot/i.test(it.skuName) || /spot/i.test(it.meterName);
    if (isSpot)
      entry.spot = entry.spot === null ? it.retailPrice : Math.min(entry.spot, it.retailPrice);
    else
      entry.onDemand =
        entry.onDemand === null ? it.retailPrice : Math.min(entry.onDemand, it.retailPrice);
    out.set(it.armRegionName, entry);
  }
  return out;
}

export const azureRetailPrices: Adapter = {
  ...meta("azure-retail-prices"),
  url: API,
  tier: 1,
  license: "Public API, no authentication; Microsoft Terms of Use",
  hosts: ["prices.azure.com"],
  source: () => ({
    id: "",
    publisher: "Microsoft",
    title: "Azure Retail Prices API",
    url: API,
    tier: 1,
    published_date: null,
    license: "Microsoft Terms of Use",
    adapter: "azure-retail-prices",
  }),
  async run(ctx: AdapterContext) {
    const result = emptyResult();
    const now = ctx.now();
    const hour = now.toISOString().slice(0, 13) + ":00:00Z";
    const source = await ensureSource(ctx.store, { ...this.source(), adapter: this.id });
    for (const { sku, family } of AZURE_SKUS) {
      const filter = `serviceName eq 'Virtual Machines' and priceType eq 'Consumption' and armSkuName eq '${sku}'`;
      let url: string | null = `${API}?$filter=${encodeURIComponent(filter)}`;
      const items: Item[] = [];
      let pages = 0;
      while (url && pages < 20) {
        const page = JSON.parse((await ctx.fetch(url)).body) as Page;
        items.push(...page.Items);
        url = page.NextPageLink;
        pages++;
      }
      for (const [region, prices] of summarise(items)) {
        if (prices.onDemand === null) continue;
        const offered = await stableId("sig", ["azure", region, sku, "sku_offered", hour]);
        if (
          await ctx.store.appendSignal({
            id: offered,
            provider_slug: "azure",
            region_code: region,
            zone_code: null,
            sku,
            sku_family: family,
            signal: "sku_offered",
            value: 1,
            unit: "boolean",
            observed_at: hour,
            source_id: source.id,
            detail: JSON.stringify({ on_demand_usd_hour: prices.onDemand }),
          })
        )
          result.signals++;
        if (prices.spot !== null && prices.onDemand > 0) {
          const id = await stableId("sig", ["azure", region, sku, "spot_ratio", hour]);
          if (
            await ctx.store.appendSignal({
              id,
              provider_slug: "azure",
              region_code: region,
              zone_code: null,
              sku,
              sku_family: family,
              signal: "spot_ratio",
              value: Math.round((prices.spot / prices.onDemand) * 1000) / 1000,
              unit: "ratio",
              observed_at: hour,
              source_id: source.id,
              detail: JSON.stringify({
                spot_usd_hour: prices.spot,
                on_demand_usd_hour: prices.onDemand,
                method: "spot-ratio.v1",
              }),
            })
          )
            result.signals++;
        }
      }
    }
    return result;
  },
};
