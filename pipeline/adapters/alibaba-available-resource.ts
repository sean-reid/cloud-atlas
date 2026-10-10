import { randomUUID } from "node:crypto";
import { stableId } from "../../shared/ids";
import { ensureSource, providerEntity } from "../entities";
import { ensureRegion } from "../regions";
import { log } from "../log";
import {
  canonicalQuery,
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

const DOC =
  "https://www.alibabacloud.com/help/en/ecs/developer-reference/api-ecs-2014-05-26-describeavailableresource";
const VERSION = "2014-05-26";
const HOSTS = ["aliyuncs.com"] as const;
const REGION_LIST_HOST = "ecs.cn-hangzhou.aliyuncs.com";

export const ALIBABA_TYPES: readonly { sku: string; family: string }[] = [
  { sku: "ecs.gn8is-8x.32xlarge", family: "L20" },
  { sku: "ecs.ebmgn8v.48xlarge", family: "H800" },
  { sku: "ecs.gn7e-c16g1.4xlarge", family: "A100" },
  { sku: "ecs.gn7i-c8g1.2xlarge", family: "A10" },
  { sku: "ecs.g7.large", family: "general" },
];

export interface AcsCredentials {
  keyId: string;
  secret: string;
}

interface RegionsResponse {
  RequestId: string;
  Regions: { Region: { RegionId: string; RegionEndpoint: string; LocalName: string }[] };
}

interface SupportedResource {
  Value: string;
  Status: "Available" | "SoldOut" | string;
  StatusCategory: string;
}

interface AvailableResourceResponse {
  RequestId: string;
  AvailableZones: {
    AvailableZone: {
      ZoneId: string;
      RegionId: string;
      Status: string;
      StatusCategory: string;
      AvailableResources: {
        AvailableResource: {
          Type: string;
          SupportedResources: { SupportedResource: SupportedResource[] };
        }[];
      };
    }[];
  };
}

interface AcsError {
  Code?: string;
  Message?: string;
  RequestId?: string;
}

export const acsCredentials = (): AcsCredentials => ({
  keyId: env("ALIBABA_ACCESS_KEY_ID"),
  secret: env("ALIBABA_ACCESS_KEY_SECRET"),
});

export interface AcsCall {
  host: string;
  action: string;
  params: Record<string, string>;
  now: Date;
  nonce?: string;
}

// ACS3-HMAC-SHA256 over an RPC-style GET: action and version travel as headers, the
// operation's parameters as a sorted query string, and the empty body still gets hashed.
export function acsSign(creds: AcsCredentials, call: AcsCall): HttpRequest {
  const query = canonicalQuery(call.params);
  const headers: Record<string, string> = {
    host: call.host,
    "x-acs-action": call.action,
    "x-acs-version": VERSION,
    "x-acs-date": call.now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    "x-acs-signature-nonce": call.nonce ?? randomUUID(),
    "x-acs-content-sha256": sha256Hex(""),
  };
  const names = Object.keys(headers).sort();
  const canonical = [
    "GET",
    "/",
    query,
    names.map((h) => `${h}:${headers[h]!.trim()}`).join("\n") + "\n",
    names.join(";"),
    headers["x-acs-content-sha256"],
  ].join("\n");
  const stringToSign = `ACS3-HMAC-SHA256\n${sha256Hex(canonical)}`;
  const signature = hmacSha256(creds.secret, stringToSign).toString("hex");
  headers.authorization = `ACS3-HMAC-SHA256 Credential=${creds.keyId},SignedHeaders=${names.join(";")},Signature=${signature}`;
  headers.accept = "application/json";
  return {
    method: "GET",
    url: `https://${call.host}/${query ? `?${query}` : ""}`,
    headers,
    body: "",
  };
}

// Available is in stock and SoldOut is out; anything else the API adds is read as low stock.
export const sellValue = (status: string): number =>
  status === "Available" ? 1 : status === "SoldOut" ? 0 : 0.5;

const errorOf = (res: HttpResponse): AcsError => {
  try {
    return JSON.parse(res.body) as AcsError;
  } catch {
    return {};
  }
};

const throttled = (res: HttpResponse) =>
  res.status === 429 || (res.status >= 400 && (errorOf(res).Code ?? "").startsWith("Throttling"));

export function makeAdapter(
  clientFactory: HttpClientFactory = () => defaultHttpClient(HOSTS),
  retry: RetryOptions = DEFAULT_RETRY,
): Adapter {
  const id = "alibaba-available-resource";
  return {
    ...meta(id),
    url: DOC,
    tier: 1,
    license: "Account API; Alibaba Cloud International Website Product Terms of Service",
    hosts: HOSTS,
    source: () => ({
      id: "",
      publisher: "Alibaba Cloud",
      title: "ECS DescribeAvailableResource",
      url: DOC,
      tier: 1,
      published_date: null,
      license: "Alibaba Cloud International Website Product Terms of Service",
      adapter: id,
    }),
    async run(ctx: AdapterContext) {
      const result = emptyResult();
      const creds = acsCredentials();
      const client = clientFactory();
      const now = ctx.now();
      const hour = now.toISOString().slice(0, 13) + ":00:00Z";
      const source = await ensureSource(ctx.store, { ...this.source(), adapter: id });

      const call = async <T>(host: string, action: string, params: Record<string, string>) => {
        const res = await sendWithRetry(
          client,
          acsSign(creds, { host, action, params, now: ctx.now() }),
          throttled,
          retry,
          id,
        );
        if (res.status < 200 || res.status >= 300) {
          const e = errorOf(res);
          throw new Error(
            `http ${res.status} from ${host}: ${e.Code ?? ""} ${e.Message ?? ""}`.trim(),
          );
        }
        return JSON.parse(res.body) as T;
      };

      const listed = (
        await call<RegionsResponse>(REGION_LIST_HOST, "DescribeRegions", {
          AcceptLanguage: "en-US",
        })
      ).Regions.Region;
      const parent = await providerEntity(ctx.store, "alibaba", "Alibaba Cloud", ctx.dataset);
      for (const r of listed) {
        const placed = await ensureRegion(ctx, this, {
          provider: "alibaba",
          code: r.RegionId,
          name: r.LocalName,
          parent,
          source,
        });
        result.entities++;
        result.observations += placed.observations;
        result.review += placed.review;
      }
      const regions = listed.map((r) => r.RegionId);
      let failed = 0;
      for (const region of regions) {
        try {
          for (const { sku, family } of ALIBABA_TYPES) {
            const res = await call<AvailableResourceResponse>(
              `ecs.${region}.aliyuncs.com`,
              "DescribeAvailableResource",
              {
                RegionId: region,
                DestinationResource: "InstanceType",
                InstanceType: sku,
                IoOptimized: "optimized",
                InstanceChargeType: "PostPaid",
                ResourceType: "instance",
              },
            );
            for (const zone of res.AvailableZones?.AvailableZone ?? []) {
              const row = (zone.AvailableResources?.AvailableResource ?? [])
                .filter((r) => r.Type === "InstanceType")
                .flatMap((r) => r.SupportedResources?.SupportedResource ?? [])
                .find((r) => r.Value === sku);
              if (!row) continue;
              const sigId = await stableId("sig", [
                "alibaba",
                region,
                zone.ZoneId,
                sku,
                "sell_status",
                hour,
              ]);
              if (
                await ctx.store.appendSignal({
                  id: sigId,
                  provider_slug: "alibaba",
                  region_code: region,
                  zone_code: zone.ZoneId,
                  sku,
                  sku_family: family,
                  signal: "sell_status",
                  value: sellValue(row.Status),
                  unit: "status",
                  observed_at: hour,
                  source_id: source.id,
                  detail: JSON.stringify({
                    status: row.Status,
                    status_category: row.StatusCategory,
                  }),
                })
              )
                result.signals++;
            }
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

export const alibabaAvailableResource = makeAdapter();
