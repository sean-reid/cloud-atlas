import { stableId } from "../../shared/ids";
import { ensureSource } from "../entities";
import { USER_AGENT } from "../fetch";
import { log } from "../log";
import {
  defaultHttpClient,
  env,
  sendWithRetry,
  type HttpClientFactory,
  type HttpRequest,
  type HttpResponse,
} from "../signed";
import { emptyResult, meta, ProbeUnavailable, type Adapter, type AdapterContext } from "./types";

const API_HOST = "management.azure.com";
const LOGIN_HOST = "login.microsoftonline.com";
const REF =
  "https://learn.microsoft.com/en-us/rest/api/recommenderrp/spot-placement-scores/post?view=rest-recommenderrp-2025-06-05";
const API_VERSION = "2025-06-05";
const SCOPE = "https://management.azure.com/.default";
const TRIES = 3;
const MAX_CALLS = 40;
const RESTRICTED = "RestrictedSkuOrLocation";

export const PROBE_COUNTS: readonly number[] = [1, 8];
// One call scores up to eight regions and five sizes.
export const REGIONS_PER_CALL = 8;
export const SIZES_PER_CALL = 5;

// Five sizes fill one call: the three GPU generations buyers ask about, an A10 inference
// size, and a general-purpose control.
export const AZURE_SIZES: readonly { sku: string; family: string }[] = [
  { sku: "Standard_ND96isr_H100_v5", family: "H100" },
  { sku: "Standard_ND96asr_v4", family: "A100" },
  { sku: "Standard_NC24ads_A100_v4", family: "A100" },
  { sku: "Standard_NV36ads_A10_v5", family: "A10" },
  { sku: "Standard_D8s_v5", family: "general" },
];

export const SCORE_VALUE: Readonly<Record<string, number>> = { High: 3, Medium: 2, Low: 1 };

export interface ScoreRequest {
  availabilityZones: boolean;
  desiredCount: number;
  desiredLocations: string[];
  desiredSizes: { sku: string }[];
}

export interface PlacementScore {
  region?: string;
  availabilityZone?: string;
  sku?: string;
  score?: string;
  isQuotaAvailable?: boolean;
}

export interface ScoreResponse extends Partial<ScoreRequest> {
  placementScores?: PlacementScore[];
}

export interface AzureCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  subscriptionId: string;
}

export interface AdapterOptions {
  gapMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export const azureCredentials = (): AzureCredentials => ({
  tenantId: env("AZURE_TENANT_ID"),
  clientId: env("AZURE_CLIENT_ID"),
  clientSecret: env("AZURE_CLIENT_SECRET"),
  subscriptionId: env("AZURE_SUBSCRIPTION_ID"),
});

export function tokenRequest(c: AzureCredentials): HttpRequest {
  return {
    method: "POST",
    url: `https://${LOGIN_HOST}/${encodeURIComponent(c.tenantId)}/oauth2/v2.0/token`,
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": USER_AGENT },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: c.clientId,
      client_secret: c.clientSecret,
      scope: SCOPE,
    }).toString(),
  };
}

export function scoreUrl(subscriptionId: string, location: string): string {
  return `https://${API_HOST}/subscriptions/${encodeURIComponent(subscriptionId)}/providers/Microsoft.Compute/locations/${location}/placementScores/spot/generate?api-version=${API_VERSION}`;
}

export function scoreRequest(
  subscriptionId: string,
  token: string,
  regions: readonly string[],
  sizes: readonly string[],
  count: number,
): HttpRequest {
  const body: ScoreRequest = {
    availabilityZones: false,
    desiredCount: count,
    desiredLocations: [...regions],
    desiredSizes: sizes.map((sku) => ({ sku })),
  };
  return {
    method: "POST",
    url: scoreUrl(subscriptionId, regions[0]!),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": USER_AGENT,
    },
    body: JSON.stringify(body),
  };
}

// Region entities the store holds for Azure; the geo index stands in before the first region run.
export function azureRegions(ctx: AdapterContext): string[] {
  const known = [...ctx.store.entities.values()]
    .filter((e) => e.type === "region" && e.provider_slug === "azure" && e.code)
    .map((e) => e.code!);
  return [...new Set(known.length ? known : Object.keys(ctx.geo["azure"] ?? {}))].sort();
}

// A regional answer carries no zone; the feature page prints False in that column.
export const zoneOf = (entry: PlacementScore): string | null =>
  entry.availabilityZone && !/^false$/i.test(entry.availabilityZone)
    ? entry.availabilityZone
    : null;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

function apiError(body: string): string {
  try {
    const e = (JSON.parse(body) as ApiErrorBody).error;
    if (e?.message) return `${e.code ?? ""} ${e.message}`.trim();
  } catch {
    // Not JSON; the raw body is the message.
  }
  return body.slice(0, 200);
}

const throttled = (res: HttpResponse) => res.status === 429 || res.status >= 500;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function makeAdapter(clientFactory: HttpClientFactory, opts: AdapterOptions = {}): Adapter {
  const gapMs = opts.gapMs ?? 1000;
  const sleep = opts.sleep ?? defaultSleep;
  const retry = { tries: TRIES, sleep };
  const families = new Map(AZURE_SIZES.map((s) => [s.sku, s.family]));
  return {
    ...meta("azure-placement-scores"),
    url: REF,
    tier: 1,
    license: "Account API; Microsoft Azure terms",
    hosts: [API_HOST, LOGIN_HOST],
    source: () => ({
      id: "",
      publisher: "Microsoft",
      title: "Azure Spot Placement Scores",
      url: REF,
      tier: 1,
      published_date: null,
      license: "Account API; Microsoft Azure terms",
      adapter: "azure-placement-scores",
    }),
    async run(ctx: AdapterContext) {
      const result = emptyResult();
      const creds = azureCredentials();
      const now = ctx.now();
      const hour = now.toISOString().slice(0, 13) + ":00:00Z";
      const source = await ensureSource(ctx.store, { ...this.source(), adapter: this.id });
      const client = clientFactory();
      const tokenRes = await sendWithRetry(client, tokenRequest(creds), throttled, retry, this.id);
      if (tokenRes.status !== 200)
        throw new Error(`token request failed: http ${tokenRes.status} ${apiError(tokenRes.body)}`);
      const token = (JSON.parse(tokenRes.body) as { access_token?: string }).access_token;
      if (!token) throw new Error("token response carried no access_token");
      let regions = azureRegions(ctx);
      const skus = AZURE_SIZES.map((s) => s.sku);
      let calls = 0;
      for (const count of PROBE_COUNTS) {
        const restricted = new Map<string, number>();
        for (const batch of chunk(regions, REGIONS_PER_CALL)) {
          for (const sizes of chunk(skus, SIZES_PER_CALL)) {
            if (calls >= MAX_CALLS) {
              log("warn", "azure-placement-scores.budget", { adapter: this.id, calls, count });
              return result;
            }
            if (calls++) await sleep(gapMs);
            const res = await sendWithRetry(
              client,
              scoreRequest(creds.subscriptionId, token, batch, sizes, count),
              throttled,
              retry,
              this.id,
            );
            if (res.status === 403 && calls === 1)
              throw new ProbeUnavailable(
                `the subscription refused the placement score call: ${apiError(res.body)}`,
              );
            if (res.status !== 200) {
              log("warn", "azure-placement-scores.rejected", {
                adapter: this.id,
                regions: batch.join(","),
                count,
                status: res.status,
                error: apiError(res.body),
              });
              continue;
            }
            const parsed = JSON.parse(res.body) as ScoreResponse;
            let stale = 0;
            let refused = 0;
            for (const entry of parsed.placementScores ?? []) {
              const { region, sku, score } = entry;
              if (!region || !sku || !score) continue;
              if (score === RESTRICTED) {
                refused++;
                restricted.set(region, (restricted.get(region) ?? 0) + 1);
                continue;
              }
              const value = SCORE_VALUE[score];
              if (value === undefined) {
                stale++;
                continue;
              }
              const zone = zoneOf(entry);
              const id = await stableId("sig", [
                "azure",
                region,
                sku,
                "spot_placement",
                count,
                hour,
                ...(zone ? [zone] : []),
              ]);
              if (
                await ctx.store.appendSignal({
                  id,
                  provider_slug: "azure",
                  region_code: region,
                  zone_code: zone,
                  sku,
                  sku_family: families.get(sku) ?? sku,
                  signal: "spot_placement",
                  value,
                  unit: "score",
                  observed_at: hour,
                  source_id: source.id,
                  detail: JSON.stringify({
                    score,
                    desired_count: count,
                    quota_available: entry.isQuotaAvailable ?? null,
                    ...(zone ? { zone } : {}),
                  }),
                })
              )
                result.signals++;
            }
            if (stale || refused)
              log("info", "azure-placement-scores.skipped", {
                adapter: this.id,
                regions: batch.join(","),
                count,
                stale,
                restricted: refused,
              });
          }
        }
        // A region every size came back restricted in leaves the later rounds.
        regions = regions.filter((r) => (restricted.get(r) ?? 0) < skus.length);
      }
      return result;
    },
  };
}

export const azurePlacementScores: Adapter = makeAdapter(() =>
  defaultHttpClient([API_HOST, LOGIN_HOST], 1000),
);
