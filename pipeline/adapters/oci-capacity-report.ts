import { createSign } from "node:crypto";
import { stableId } from "../../shared/ids";
import { ensureSource, providerEntity } from "../entities";
import { ensureRegion } from "../regions";
import { log } from "../log";
import {
  DEFAULT_RETRY,
  defaultHttpClient,
  env,
  sendWithRetry,
  sha256Base64,
  type HttpClientFactory,
  type HttpRequest,
  type HttpResponse,
  type RetryOptions,
} from "../signed";
import { emptyResult, meta, type Adapter, type AdapterContext } from "./types";

const DOC =
  "https://docs.oracle.com/en-us/iaas/Content/Compute/References/compute-capacity-report.htm";
const API_VERSION = "20160918";
const HOSTS = ["oraclecloud.com"] as const;

export interface OciShape {
  sku: string;
  family: string;
  config?: { ocpus: number; memoryInGBs: number };
}

export const OCI_SHAPES: readonly OciShape[] = [
  { sku: "BM.GPU.H100.8", family: "H100" },
  { sku: "BM.GPU.H200.8", family: "H200" },
  { sku: "BM.GPU.A100-v2.8", family: "A100" },
  { sku: "VM.GPU.A10.1", family: "A10" },
  { sku: "VM.Standard.E5.Flex", family: "general", config: { ocpus: 2, memoryInGBs: 24 } },
];

export interface OciCredentials {
  tenancy: string;
  user: string;
  fingerprint: string;
  privateKey: string;
  region: string;
}

interface RegionSubscription {
  regionKey: string;
  regionName: string;
  status: "READY" | "IN_PROGRESS";
  isHomeRegion: boolean;
}

interface AvailabilityDomain {
  name: string;
  id: string;
  compartmentId: string;
}

interface ShapeAvailability {
  instanceShape: string;
  availabilityStatus: "AVAILABLE" | "OUT_OF_HOST_CAPACITY" | "HARDWARE_NOT_SUPPORTED" | string;
  availableCount: number | null;
  faultDomain: string | null;
  instanceShapeConfig: { ocpus?: number; memoryInGBs?: number } | null;
}

interface CapacityReport {
  compartmentId: string;
  availabilityDomain: string;
  timeCreated: string;
  shapeAvailabilities: ShapeAvailability[];
}

export const ociCredentials = (): OciCredentials => ({
  tenancy: env("OCI_TENANCY"),
  user: env("OCI_USER"),
  fingerprint: env("OCI_FINGERPRINT"),
  privateKey: env("OCI_PRIVATE_KEY").replace(/\\n/g, "\n"),
  region: env("OCI_REGION"),
});

// Signature version 1 as the OCI signing guide describes it: an RSA-SHA256 over
// "(request-target)", host, date and, for a body, its length, type and SHA-256.
export function ociSign(
  creds: OciCredentials,
  method: "GET" | "POST",
  url: string,
  body: string,
  now: Date,
): HttpRequest {
  const u = new URL(url);
  const headers: Record<string, string> = {
    date: now.toUTCString(),
    host: u.host,
    accept: "application/json",
  };
  const signed = ["date", "(request-target)", "host"];
  if (method === "POST") {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(body, "utf8"));
    headers["x-content-sha256"] = sha256Base64(body);
    signed.push("content-length", "content-type", "x-content-sha256");
  }
  const signingString = signed
    .map((h) =>
      h === "(request-target)"
        ? `(request-target): ${method.toLowerCase()} ${u.pathname}${u.search}`
        : `${h}: ${headers[h]}`,
    )
    .join("\n");
  const signature = createSign("RSA-SHA256")
    .update(signingString, "utf8")
    .sign(creds.privateKey, "base64");
  headers.authorization =
    `Signature version="1",keyId="${creds.tenancy}/${creds.user}/${creds.fingerprint}",` +
    `algorithm="rsa-sha256",headers="${signed.join(" ")}",signature="${signature}"`;
  return { method, url, headers, body };
}

export const capacityValue = (status: string): number => (status === "AVAILABLE" ? 1 : 0);

const throttled = (res: HttpResponse) => res.status === 429;

export function makeAdapter(
  clientFactory: HttpClientFactory = () => defaultHttpClient(HOSTS),
  retry: RetryOptions = DEFAULT_RETRY,
): Adapter {
  const id = "oci-capacity-report";
  return {
    ...meta(id),
    url: DOC,
    tier: 1,
    license: "Account API; Oracle Cloud Infrastructure service terms",
    hosts: HOSTS,
    source: () => ({
      id: "",
      publisher: "Oracle",
      title: "OCI Compute capacity reports",
      url: DOC,
      tier: 1,
      published_date: null,
      license: "Oracle Cloud Infrastructure service terms",
      adapter: id,
    }),
    async run(ctx: AdapterContext) {
      const result = emptyResult();
      const creds = ociCredentials();
      const client = clientFactory();
      const now = ctx.now();
      const hour = now.toISOString().slice(0, 13) + ":00:00Z";
      const source = await ensureSource(ctx.store, { ...this.source(), adapter: id });

      const call = async <T>(method: "GET" | "POST", url: string, body = ""): Promise<T> => {
        const res = await sendWithRetry(
          client,
          ociSign(creds, method, url, body, ctx.now()),
          throttled,
          retry,
          id,
        );
        if (res.status < 200 || res.status >= 300)
          throw new Error(
            `http ${res.status} from ${new URL(url).host}: ${res.body.slice(0, 200)}`,
          );
        return JSON.parse(res.body) as T;
      };

      const subs = await call<RegionSubscription[]>(
        "GET",
        `https://identity.${creds.region}.oci.oraclecloud.com/${API_VERSION}/tenancies/${creds.tenancy}/regionSubscriptions`,
      );
      const regions = subs.filter((s) => s.status === "READY").map((s) => s.regionName);
      const parent = await providerEntity(
        ctx.store,
        "oracle",
        "Oracle Cloud Infrastructure",
        ctx.dataset,
      );
      for (const code of regions) {
        const placed = await ensureRegion(ctx, this, {
          provider: "oracle",
          code,
          name: null,
          parent,
          source,
        });
        result.entities++;
        result.observations += placed.observations;
        result.review += placed.review;
      }
      let failed = 0;
      for (const region of regions) {
        try {
          const ads = await call<AvailabilityDomain[]>(
            "GET",
            `https://identity.${region}.oci.oraclecloud.com/${API_VERSION}/availabilityDomains?compartmentId=${encodeURIComponent(creds.tenancy)}`,
          );
          for (const ad of ads) {
            const body = JSON.stringify({
              compartmentId: creds.tenancy,
              availabilityDomain: ad.name,
              shapeAvailabilities: OCI_SHAPES.map((s) => ({
                instanceShape: s.sku,
                ...(s.config ? { instanceShapeConfig: s.config } : {}),
              })),
            });
            const report = await call<CapacityReport>(
              "POST",
              `https://iaas.${region}.oraclecloud.com/${API_VERSION}/computeCapacityReports`,
              body,
            );
            for (const row of report.shapeAvailabilities) {
              const shape = OCI_SHAPES.find((s) => s.sku === row.instanceShape);
              // Not offered in this domain at all, which is not a capacity verdict.
              if (!shape || row.availabilityStatus === "HARDWARE_NOT_SUPPORTED") continue;
              const sigId = await stableId("sig", [
                "oracle",
                region,
                ad.name,
                shape.sku,
                "capacity_report",
                hour,
              ]);
              if (
                await ctx.store.appendSignal({
                  id: sigId,
                  provider_slug: "oracle",
                  region_code: region,
                  zone_code: ad.name,
                  sku: shape.sku,
                  sku_family: shape.family,
                  signal: "capacity_report",
                  value: capacityValue(row.availabilityStatus),
                  unit: "verdict",
                  observed_at: hour,
                  source_id: source.id,
                  detail: JSON.stringify({
                    status: row.availabilityStatus,
                    available_count: row.availableCount,
                    ...(shape.config ? { shape_config: shape.config } : {}),
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
        throw new Error(`every subscribed region failed (${regions.length})`);
      return result;
    },
  };
}

export const ociCapacityReport = makeAdapter();
