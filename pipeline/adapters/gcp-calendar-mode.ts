import { GoogleAuth, type JWTInput } from "google-auth-library";
import { stableId } from "../../shared/ids";
import { ensureSource } from "../entities";
import { assertAllowed, retryDelayMs, USER_AGENT } from "../fetch";
import { log } from "../log";
import { GPU_ZONES_URL, gpuZoneRows } from "./gcp-gpu-zones";
import { emptyResult, meta, type Adapter, type AdapterContext } from "./types";

const API_HOST = "compute.googleapis.com";
const DOC =
  "https://docs.cloud.google.com/compute/docs/instances/create-future-reservations-calendar-mode";
const SCOPE = "https://www.googleapis.com/auth/compute";
const DURATION_S = 24 * 3600;
// The API answers for GPU VMs up to 60 days ahead.
const LOOKAHEAD_DAYS = 60;
const TRIES = 3;
const NO_START = 999;

export const PROBE_COUNTS: readonly number[] = [1, 8];

// Calendar mode accepts these four machine type names; the GPU zones page lists them by label.
export const CALENDAR_TYPES: readonly { label: string; sku: string; family: string }[] = [
  { label: "A3 High", sku: "a3-highgpu-8g", family: "H100" },
  { label: "A3 Mega", sku: "a3-megagpu-8g", family: "H100" },
  { label: "A3 Ultra", sku: "a3-ultragpu-8g", family: "H200" },
  { label: "A4", sku: "a4-highgpu-8g", family: "B200" },
];

export interface AdviceRequest {
  futureResourcesSpecs: {
    spec: {
      targetResources: { specificSkuResources: { instanceCount: string; machineType: string } };
      timeRangeSpec: {
        startTimeNotEarlierThan: string;
        startTimeNotLaterThan: string;
        minDuration: string;
        maxDuration: string;
      };
    };
  };
}

export interface Recommendation {
  recommendationId?: string;
  recommendationType?: string;
  startTime?: string;
  endTime?: string;
  location?: string;
  otherLocations?: Record<string, { status?: string; details?: string }>;
}

export interface AdviceResponse {
  recommendations?: { recommendationsPerSpec?: Record<string, Recommendation> }[];
}

export interface HttpReply {
  status: number;
  body: string;
  retryAfter: string | null;
}

export interface CalendarClient {
  token: () => Promise<string>;
  post: (url: string, token: string, body: AdviceRequest) => Promise<HttpReply>;
}

export type CalendarClientFactory = (serviceAccountJson: string) => CalendarClient;

export interface AdapterOptions {
  gapMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export const googleClient: CalendarClientFactory = (serviceAccountJson) => {
  const auth = new GoogleAuth({
    credentials: JSON.parse(serviceAccountJson) as JWTInput,
    scopes: [SCOPE],
  });
  return {
    async token() {
      const token = await auth.getAccessToken();
      if (!token) throw new Error("service account returned no access token");
      return token;
    },
    async post(url, token, body) {
      const u = assertAllowed(url, [API_HOST]);
      const res = await fetch(u, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "user-agent": USER_AGENT,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      return {
        status: res.status,
        body: await res.text(),
        retryAfter: res.headers.get("retry-after"),
      };
    },
  };
};

export function adviceUrl(project: string, region: string): string {
  return `https://${API_HOST}/compute/v1/projects/${encodeURIComponent(project)}/regions/${region}/advice/calendarMode`;
}

export function adviceRequest(sku: string, count: number, from: Date): AdviceRequest {
  const to = new Date(from.getTime() + LOOKAHEAD_DAYS * 86_400_000);
  return {
    futureResourcesSpecs: {
      spec: {
        targetResources: {
          specificSkuResources: { instanceCount: String(count), machineType: sku },
        },
        timeRangeSpec: {
          startTimeNotEarlierThan: from.toISOString().replace(/\.\d{3}Z$/, "Z"),
          startTimeNotLaterThan: to.toISOString().replace(/\.\d{3}Z$/, "Z"),
          minDuration: `${DURATION_S}s`,
          maxDuration: `${DURATION_S}s`,
        },
      },
    },
  };
}

// Whole UTC days between now and the advised start; a start earlier today counts as now.
export function leadTimeDays(start: string | undefined, now: Date): number {
  const t = start ? Date.parse(start) : NaN;
  if (!Number.isFinite(t)) return NO_START;
  const day = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.max(0, Math.round((day(new Date(t)) - day(now)) / 86_400_000));
}

export function regionsByType(html: string): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  for (const row of gpuZoneRows(html)) {
    for (const t of CALENDAR_TYPES) {
      if (!row.types.includes(t.label)) continue;
      const set = out.get(t.sku) ?? new Set<string>();
      set.add(row.region);
      out.set(t.sku, set);
    }
  }
  return new Map([...out].map(([sku, set]) => [sku, [...set].sort()]));
}

interface ApiErrorBody {
  error?: { message?: string; status?: string };
}

function parseJson(body: string): ApiErrorBody {
  try {
    return JSON.parse(body) as ApiErrorBody;
  } catch {
    return {};
  }
}

function apiError(body: string): string {
  const e = parseJson(body).error;
  return e?.message ? `${e.status ?? ""} ${e.message}`.trim() : body.slice(0, 200);
}

type Advice =
  { ok: true; rec: Recommendation | null } | { ok: false; status: number | null; error: string };

async function advise(
  client: CalendarClient,
  token: string,
  url: string,
  body: AdviceRequest,
  sleep: (ms: number) => Promise<void>,
): Promise<Advice> {
  for (let attempt = 0; ; attempt++) {
    let res: HttpReply;
    try {
      res = await client.post(url, token, body);
    } catch (err) {
      if (attempt < TRIES - 1) {
        await sleep(retryDelayMs(attempt, null));
        continue;
      }
      return { ok: false, status: null, error: err instanceof Error ? err.message : String(err) };
    }
    if ((res.status === 429 || res.status >= 500) && attempt < TRIES - 1) {
      await sleep(retryDelayMs(attempt, res.retryAfter));
      continue;
    }
    if (res.status !== 200) return { ok: false, status: res.status, error: apiError(res.body) };
    const parsed = JSON.parse(res.body) as AdviceResponse;
    return { ok: true, rec: parsed.recommendations?.[0]?.recommendationsPerSpec?.spec ?? null };
  }
}

const zoneOf = (location: string | undefined): string | null =>
  location ? location.replace(/^zones\//, "") : null;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function makeAdapter(
  clientFactory: CalendarClientFactory,
  opts: AdapterOptions = {},
): Adapter {
  const gapMs = opts.gapMs ?? 300;
  const sleep = opts.sleep ?? defaultSleep;
  return {
    ...meta("gcp-calendar-mode"),
    url: DOC,
    tier: 1,
    license: "Compute Engine API; Google Cloud Platform Terms of Service",
    hosts: ["docs.cloud.google.com", API_HOST],
    source: () => ({
      id: "",
      publisher: "Google Cloud",
      title: "Compute Engine calendar-mode advice",
      url: DOC,
      tier: 1,
      published_date: null,
      license: "Google Cloud Platform Terms of Service",
      adapter: "gcp-calendar-mode",
    }),
    async run(ctx: AdapterContext) {
      const result = emptyResult();
      const project = process.env.GCP_PROJECT;
      const serviceAccountJson = process.env.GCP_SERVICE_ACCOUNT_JSON;
      if (!project || !serviceAccountJson)
        throw new Error("GCP_PROJECT and GCP_SERVICE_ACCOUNT_JSON are required");
      const now = ctx.now();
      const hour = now.toISOString().slice(0, 13) + ":00:00Z";
      const source = await ensureSource(ctx.store, { ...this.source(), adapter: this.id });
      const regions = regionsByType((await ctx.fetch(GPU_ZONES_URL)).body);
      const client = clientFactory(serviceAccountJson);
      const token = await client.token();
      let calls = 0;
      for (const type of CALENDAR_TYPES) {
        for (const region of regions.get(type.sku) ?? []) {
          for (const count of PROBE_COUNTS) {
            if (calls++) await sleep(gapMs);
            const url = adviceUrl(project, region);
            const advice = await advise(
              client,
              token,
              url,
              adviceRequest(type.sku, count, new Date(hour)),
              sleep,
            );
            if (!advice.ok) {
              log("warn", "gcp-calendar-mode.rejected", {
                region,
                sku: type.sku,
                count,
                status: advice.status,
                error: advice.error,
              });
              continue;
            }
            const rec = advice.rec;
            const id = await stableId("sig", [
              "gcp",
              region,
              type.sku,
              "lead_time_days",
              count,
              hour,
            ]);
            const zones = Object.fromEntries(
              Object.entries(rec?.otherLocations ?? {}).map(([k, v]) => [
                zoneOf(k),
                v.status ?? null,
              ]),
            );
            if (
              await ctx.store.appendSignal({
                id,
                provider_slug: "gcp",
                region_code: region,
                zone_code: zoneOf(rec?.location),
                sku: type.sku,
                sku_family: type.family,
                signal: "lead_time_days",
                value: leadTimeDays(rec?.startTime, now),
                unit: "days",
                observed_at: hour,
                source_id: source.id,
                detail: JSON.stringify({
                  instance_count: count,
                  earliest_start: rec?.startTime ?? null,
                  end_time: rec?.endTime ?? null,
                  duration_hours: DURATION_S / 3600,
                  zones,
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
}
