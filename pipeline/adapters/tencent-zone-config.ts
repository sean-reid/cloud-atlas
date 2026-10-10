import { stableId } from "../../shared/ids";
import { ensureSource } from "../entities";
import { log } from "../log";
import {
  DEFAULT_RETRY,
  defaultHttpClient,
  env,
  hmacSha256,
  sendWithRetry,
  sha256Hex,
  type HttpClientFactory,
  type HttpRequest,
  type HttpResponse,
  type RetryOptions,
} from "../signed";
import { emptyResult, meta, type Adapter, type AdapterContext } from "./types";

const DOC = "https://www.tencentcloud.com/document/product/213/15753";
const HOST = "cvm.tencentcloudapi.com";
const SERVICE = "cvm";
const VERSION = "2017-03-12";
const HOSTS = ["tencentcloudapi.com"] as const;

export const TENCENT_FAMILIES: Readonly<Record<string, string>> = {
  GN10Xp: "V100",
  GT4: "A100",
  PNV4: "A10",
  GN7: "T4",
  S5: "general",
};

export interface Tc3Credentials {
  secretId: string;
  secretKey: string;
}

interface RegionsResponse {
  TotalCount: number;
  RegionSet: { Region: string; RegionName: string; RegionState: string }[];
  RequestId: string;
}

interface InstanceTypeQuotaItem {
  Zone: string;
  InstanceType: string;
  InstanceChargeType: string;
  InstanceFamily: string;
  TypeName: string;
  Status: "SELL" | "SOLD_OUT" | string;
  StatusCategory: "EnoughStock" | "NormalStock" | "UnderStock" | "WithoutStock" | string;
  SoldOutReason: string;
  Cpu: number;
  Memory: number;
  Gpu: number;
  GpuCount: number;
}

interface ZoneConfigResponse {
  InstanceTypeQuotaSet: InstanceTypeQuotaItem[];
  RequestId: string;
}

interface Envelope<T> {
  Response: T & { RequestId: string; Error?: { Code: string; Message: string } };
}

export const tc3Credentials = (): Tc3Credentials => ({
  secretId: env("TENCENT_SECRET_ID"),
  secretKey: env("TENCENT_SECRET_KEY"),
});

export interface Tc3Call {
  action: string;
  region?: string | undefined;
  body: string;
  timestamp: number;
  host?: string;
}

// TC3-HMAC-SHA256 as the API 3.0 signing guide describes it: POST to "/", the
// content-type and host headers signed, and a key derived from the UTC date.
export function tc3Sign(creds: Tc3Credentials, call: Tc3Call): HttpRequest {
  const host = call.host ?? HOST;
  const contentType = "application/json; charset=utf-8";
  const date = new Date(call.timestamp * 1000).toISOString().slice(0, 10);
  const canonical = [
    "POST",
    "/",
    "",
    `content-type:${contentType}\nhost:${host}\n`,
    "content-type;host",
    sha256Hex(call.body),
  ].join("\n");
  const scope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign = `TC3-HMAC-SHA256\n${call.timestamp}\n${scope}\n${sha256Hex(canonical)}`;
  const kDate = hmacSha256(`TC3${creds.secretKey}`, date);
  const kService = hmacSha256(kDate, SERVICE);
  const kSigning = hmacSha256(kService, "tc3_request");
  const signature = hmacSha256(kSigning, stringToSign).toString("hex");
  const headers: Record<string, string> = {
    host,
    "content-type": contentType,
    "x-tc-action": call.action,
    "x-tc-version": VERSION,
    "x-tc-timestamp": String(call.timestamp),
    authorization: `TC3-HMAC-SHA256 Credential=${creds.secretId}/${scope}, SignedHeaders=content-type;host, Signature=${signature}`,
  };
  if (call.region) headers["x-tc-region"] = call.region;
  return { method: "POST", url: `https://${host}/`, headers, body: call.body };
}

// SELL is in stock unless the provider flags the stock as about to run out.
export const sellValue = (status: string, category: string): number =>
  status === "SOLD_OUT" ? 0 : status !== "SELL" ? 0.5 : category === "UnderStock" ? 0.5 : 1;

const errorOf = (res: HttpResponse): { Code?: string; Message?: string } => {
  try {
    return (JSON.parse(res.body) as Envelope<unknown>).Response?.Error ?? {};
  } catch {
    return {};
  }
};

const throttled = (res: HttpResponse) =>
  res.status === 429 || (errorOf(res).Code ?? "").startsWith("RequestLimitExceeded");

export function makeAdapter(
  clientFactory: HttpClientFactory = () => defaultHttpClient(HOSTS),
  retry: RetryOptions = DEFAULT_RETRY,
): Adapter {
  const id = "tencent-zone-config";
  return {
    ...meta(id),
    url: DOC,
    tier: 1,
    license: "Account API; Tencent Cloud Service Agreement",
    hosts: HOSTS,
    source: () => ({
      id: "",
      publisher: "Tencent Cloud",
      title: "CVM DescribeZoneInstanceConfigInfos",
      url: DOC,
      tier: 1,
      published_date: null,
      license: "Tencent Cloud Service Agreement",
      adapter: id,
    }),
    async run(ctx: AdapterContext) {
      const result = emptyResult();
      const creds = tc3Credentials();
      const client = clientFactory();
      const now = ctx.now();
      const hour = now.toISOString().slice(0, 13) + ":00:00Z";
      const source = await ensureSource(ctx.store, { ...this.source(), adapter: id });

      const call = async <T>(action: string, body: unknown, region?: string): Promise<T> => {
        const req = tc3Sign(creds, {
          action,
          region,
          body: JSON.stringify(body),
          timestamp: Math.floor(ctx.now().getTime() / 1000),
        });
        const res = await sendWithRetry(client, req, throttled, retry, id);
        if (res.status < 200 || res.status >= 300)
          throw new Error(`http ${res.status} from ${HOST}: ${res.body.slice(0, 200)}`);
        const data = (JSON.parse(res.body) as Envelope<T>).Response;
        if (data.Error) throw new Error(`${action}: ${data.Error.Code} ${data.Error.Message}`);
        return data;
      };

      const regions = (await call<RegionsResponse>("DescribeRegions", {})).RegionSet.filter(
        (r) => r.RegionState === "AVAILABLE",
      ).map((r) => r.Region);
      let failed = 0;
      for (const region of regions) {
        try {
          const res = await call<ZoneConfigResponse>(
            "DescribeZoneInstanceConfigInfos",
            {
              Filters: [
                { Name: "instance-family", Values: Object.keys(TENCENT_FAMILIES) },
                { Name: "instance-charge-type", Values: ["POSTPAID_BY_HOUR"] },
              ],
            },
            region,
          );
          for (const item of res.InstanceTypeQuotaSet) {
            const family = TENCENT_FAMILIES[item.InstanceFamily];
            if (!family) continue;
            const sigId = await stableId("sig", [
              "tencent",
              region,
              item.Zone,
              item.InstanceType,
              "sell_status",
              hour,
            ]);
            if (
              await ctx.store.appendSignal({
                id: sigId,
                provider_slug: "tencent",
                region_code: region,
                zone_code: item.Zone,
                sku: item.InstanceType,
                sku_family: family,
                signal: "sell_status",
                value: sellValue(item.Status, item.StatusCategory),
                unit: "status",
                observed_at: hour,
                source_id: source.id,
                detail: JSON.stringify({
                  status: item.Status,
                  status_category: item.StatusCategory,
                  ...(item.SoldOutReason ? { sold_out_reason: item.SoldOutReason } : {}),
                }),
              })
            )
              result.signals++;
          }
        } catch (err) {
          failed++;
          log("warn", "probe.region_failed", { adapter: id, region, error: String(err) });
        }
      }
      if (regions.length && failed === regions.length)
        throw new Error(`every region failed (${regions.length})`);
      return result;
    },
  };
}

export const tencentZoneConfig = makeAdapter();
