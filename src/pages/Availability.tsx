import { lazy, Suspense, useState } from "react";
import { providerBySlug } from "../../shared/providers";
import type { RegionMarker } from "../components/Map";
import { useApi } from "../lib/api";
import { fmtAgo } from "../lib/format";

const AtlasMap = lazy(() => import("../components/Map").then((m) => ({ default: m.AtlasMap })));

interface Cell {
  region_code: string;
  sku: string;
  offered: boolean;
  level: string;
  signals: Record<
    string,
    { value: number; detail: Record<string, unknown> | null; baseline: number | null }
  >;
}

interface Data {
  providers: Record<string, { observed_at: string; families: Record<string, Cell[]> }>;
}

const LEVELS = ["available", "constrained", "tight", "offered", "unknown"] as const;
const LEVEL_LABEL: Record<string, string> = {
  available: "available",
  constrained: "constrained",
  tight: "tight",
  offered: "offered, no spot signal",
  unknown: "unknown",
  absent: "not offered",
};
const FAMILY_ORDER = [
  "H100",
  "H200",
  "MI300X",
  "A100",
  "L40S",
  "A10G",
  "T4",
  "Trainium",
  "Inferentia",
  "general",
  "memory",
  "compute",
];

function describe(c: Cell): string {
  const parts: string[] = [`${c.sku}: ${LEVEL_LABEL[c.level]}`];
  if (c.signals["spot_ratio"]) {
    const s = c.signals["spot_ratio"];
    parts.push(`spot at ${Math.round(s.value * 100)}% of pay-as-you-go`);
    if (s.baseline !== null) parts.push(`7-day baseline ${Math.round(s.baseline * 100)}%`);
  }
  if (c.signals["interruption_band"]) {
    const s = c.signals["interruption_band"];
    parts.push(`interruption frequency ${String(s.detail?.label ?? s.value)}`);
    if (typeof s.detail?.spot_savings_pct === "number")
      parts.push(`spot saves ${s.detail.spot_savings_pct}%`);
  }
  return parts.join(" · ");
}

// The provider's own number behind a level: AWS publishes an interruption band, Azure a price.
function measure(c: Cell): string {
  const band = c.signals["interruption_band"];
  if (band)
    return String(band.detail?.label ?? band.value)
      .replace("<", "under ")
      .replace(">", "over ");
  const ratio = c.signals["spot_ratio"];
  if (ratio) return `${Math.round(ratio.value * 100)}% of list`;
  const zones = c.signals["sku_offered"]?.detail?.zones;
  if (typeof zones === "number") return `${zones} zone${zones === 1 ? "" : "s"}`;
  return c.offered ? "list price only" : "";
}

// The worst level among a family's SKUs in a region is the one a buyer feels.
const rank: Record<string, number> = {
  tight: 3,
  constrained: 2,
  available: 1,
  offered: 0,
  unknown: 0,
};
function worst(cells: Cell[]): Cell | null {
  return cells.reduce<Cell | null>(
    (w, c) => (!w || (rank[c.level] ?? 0) > (rank[w.level] ?? 0) ? c : w),
    null,
  );
}

export function Availability() {
  const { data } = useApi<Data>("/api/availability");
  const providers = Object.keys(data?.providers ?? {});
  const [active, setActive] = useState<string | null>(null);
  const [family, setFamily] = useState<string | null>(null);
  const slug = active ?? providers[0] ?? null;
  const p = slug ? data!.providers[slug]! : null;
  const regionsApi = useApi<{ regions: RegionMarker[] }>(
    slug ? `/api/regions?provider=${slug}` : null,
  );

  const order = (f: string) => {
    const i = FAMILY_ORDER.indexOf(f);
    return i < 0 ? FAMILY_ORDER.length : i;
  };
  const families = p
    ? Object.keys(p.families).sort((a, b) => order(a) - order(b) || a.localeCompare(b))
    : [];
  const fam = family && families.includes(family) ? family : (families[0] ?? null);
  const regions = p
    ? [
        ...new Set(
          Object.values(p.families)
            .flat()
            .map((c) => c.region_code),
        ),
      ].sort()
    : [];
  const byRegionFamily = new Map<string, Cell[]>();
  if (p) {
    for (const [f, cells] of Object.entries(p.families)) {
      for (const c of cells) {
        const k = `${c.region_code}|${f}`;
        byRegionFamily.set(k, [...(byRegionFamily.get(k) ?? []), c]);
      }
    }
  }
  const famCells = p && fam ? p.families[fam]! : [];
  const famByRegion = new Map<string, Cell[]>();
  for (const c of famCells)
    famByRegion.set(c.region_code, [...(famByRegion.get(c.region_code) ?? []), c]);
  const counts: Record<string, number> = { available: 0, constrained: 0, tight: 0, offered: 0 };
  for (const cells of famByRegion.values()) {
    const w = worst(cells);
    if (w) counts[w.level] = (counts[w.level] ?? 0) + 1;
  }

  const mapRegions: RegionMarker[] = (regionsApi.data?.regions ?? [])
    .filter((r) => r.code && famByRegion.has(r.code))
    .map((r) => {
      const w = worst(famByRegion.get(r.code!)!)!;
      return {
        ...r,
        name: `${r.name}: ${LEVEL_LABEL[w.level]}${measure(w) ? `, ${measure(w)}` : ""}`,
        level: w.level,
      } as RegionMarker & { level: string };
    });

  return (
    <>
      <section className="block" style={{ paddingTop: "0.5rem" }}>
        <h1>Availability signals</h1>
        <p className="muted" style={{ marginTop: "0.5rem" }}>
          Could a new customer get this SKU in this region now? Levels are relative within one
          provider and SKU family, from public market signals. They measure spare capacity for new
          requests, not infrastructure, and are never converted to megawatts.
        </p>
      </section>
      <section className="block">
        <div className="lead">
          <div className="chips">
            {providers.map((s) => (
              <button
                key={s}
                type="button"
                className="chip"
                aria-pressed={s === slug}
                onClick={() => setActive(s)}
                style={{ ["--c" as string]: providerBySlug(s)?.color }}
              >
                <span className="dot" />
                {providerBySlug(s)?.shortName ?? s}
              </button>
            ))}
          </div>
          {p && (
            <span className="muted small" title={p.observed_at}>
              observed {fmtAgo(p.observed_at)}
            </span>
          )}
        </div>

        {p && fam && (
          <>
            <div className="lead" style={{ marginTop: "1.25rem" }}>
              <h2>Where is {fam} available?</h2>
              <div className="chips" role="tablist" aria-label="SKU family">
                {families.map((f) => (
                  <button
                    key={f}
                    type="button"
                    role="tab"
                    className="chip"
                    aria-selected={f === fam}
                    aria-pressed={f === fam}
                    onClick={() => setFamily(f)}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>
            <p className="muted small">
              {counts.available} region{counts.available === 1 ? "" : "s"} available,{" "}
              {counts.constrained} constrained, {counts.tight} tight
              {counts.offered ? `, ${counts.offered} offered without a spot signal` : ""};{" "}
              {famByRegion.size} of {regions.length} regions offer {fam}.
            </p>
            <Suspense fallback={<div className="map" aria-busy="true" />}>
              <AtlasMap
                sites={[]}
                regions={mapRegions}
                metric="it_power_mw"
                variant="availability"
              />
            </Suspense>
          </>
        )}

        {p && (
          <>
            <div className="lead" style={{ marginTop: "1.75rem" }}>
              <h2>Every family, every region</h2>
              <span className="muted small">
                worst SKU in the family per region; hover a cell for the signal
              </span>
            </div>
            <div className="legend" style={{ marginBottom: "0.5rem" }}>
              {LEVELS.map((k) => (
                <span key={k}>
                  <span className={`swatch ${k}`} /> {LEVEL_LABEL[k]}
                </span>
              ))}
              <span>
                <span className="swatch absent" /> not offered
              </span>
            </div>
            <div className="table-scroll">
              <div
                className="avail-grid"
                style={{
                  gridTemplateColumns: `minmax(120px, max-content) repeat(${families.length}, minmax(44px, 1fr))`,
                }}
                role="table"
                aria-label="Availability level by region and SKU family"
              >
                <div className="cell head" role="columnheader">
                  region
                </div>
                {families.map((f) => (
                  <div key={f} className="cell head" role="columnheader">
                    {f}
                  </div>
                ))}
                {regions.map((r) => (
                  <div key={r} style={{ display: "contents" }} role="row">
                    <div className="cell mono rowhead" role="rowheader">
                      {r}
                    </div>
                    {families.map((f) => {
                      const cells = byRegionFamily.get(`${r}|${f}`);
                      const w = cells ? worst(cells) : null;
                      return (
                        <div
                          key={f}
                          className={`cell mark-cell ${w ? w.level : "absent"}`}
                          role="cell"
                          title={
                            cells ? cells.map(describe).join("\n") : `${f} not offered in ${r}`
                          }
                          aria-label={
                            w ? `${f} in ${r}: ${LEVEL_LABEL[w.level]}` : `${f} not offered in ${r}`
                          }
                        >
                          <span className={`swatch ${w ? w.level : "absent"}`} />
                          {w && <span className="measure">{measure(w)}</span>}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
            <p className="small muted" style={{ marginTop: "0.75rem" }}>
              {slug === "azure"
                ? "Spot to pay-as-you-go price ratio per SKU and region, Azure Retail Prices API. Terciles within the family: lowest third available, middle constrained, top third tight. On-demand only means offered, no spot signal."
                : slug === "gcp"
                  ? "GPU machine types per zone from Google's documentation, read daily. Offering only; Google publishes no public scarcity signal."
                  : "Spot interruption band per instance type and region, AWS Spot Instance Advisor. Under 10% available, 10 to 15% constrained, above tight. A low band can also mean little spot use."}
            </p>
          </>
        )}
        {!providers.length && <p className="muted">No availability signals recorded yet.</p>}
        <h2 style={{ marginTop: "2rem" }}>Not yet covered</h2>
        <ul className="small muted" style={{ marginTop: "0.5rem" }}>
          <li>
            Oracle Cloud publishes a capacity report per shape and availability domain, but only to
            an account.
          </li>
          <li>
            Alibaba Cloud and Tencent Cloud return sold-out status per instance type and zone, but
            only to an account.
          </li>
          <li>Huawei Cloud marks sold-out flavors per zone behind an IAM token.</li>
          <li>
            IBM Cloud has no spot market or sell-out flag. CoreWeave, Nebius, Nscale, and Crusoe
            publish no capacity endpoint.
          </li>
        </ul>
      </section>
    </>
  );
}
