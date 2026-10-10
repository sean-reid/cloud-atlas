import { lazy, Suspense, useState } from "react";
import { ADAPTER_META } from "../../shared/adapters-meta";
import {
  LEVEL_LABEL,
  measureFor,
  SIGNAL_NOTES,
  worstLevel,
  type Level,
  type Readings,
} from "../../shared/availability";
import { providerBySlug } from "../../shared/providers";
import type { AvailabilitySignalKind } from "../../shared/types";
import type { RegionMarker } from "../components/Map";
import { useApi } from "../lib/api";
import { fmtAgo } from "../lib/format";

const AtlasMap = lazy(() => import("../components/Map").then((m) => ({ default: m.AtlasMap })));

interface Cell {
  region_code: string;
  sku: string;
  offered: boolean;
  level: Level;
  signals: Readings;
}

interface Data {
  providers: Record<
    string,
    { observed_at: string; signals: AvailabilitySignalKind[]; families: Record<string, Cell[]> }
  >;
}

const LEVELS: Level[] = ["available", "constrained", "tight", "offered", "unknown"];
const FAMILY_ORDER = [
  "H100",
  "H200",
  "B200",
  "GB200",
  "MI300X",
  "A100",
  "L40S",
  "L4",
  "A10G",
  "RTX PRO 6000",
  "T4",
  "V100",
  "P100",
  "P4",
  "Trainium",
  "Inferentia",
  "general",
  "memory",
  "compute",
];
const order = (f: string) => {
  const i = FAMILY_ORDER.indexOf(f);
  return i < 0 ? FAMILY_ORDER.length : i;
};

const describe = (c: Cell) =>
  `${c.sku}: ${LEVEL_LABEL[c.level]}${measureFor(c.signals) ? `, ${measureFor(c.signals)}` : ""}`;

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
      for (const c of cells)
        byRegionFamily.set(`${c.region_code}|${f}`, [
          ...(byRegionFamily.get(`${c.region_code}|${f}`) ?? []),
          c,
        ]);
    }
  }
  const famByRegion = new Map<string, Cell[]>();
  for (const c of p && fam ? p.families[fam]! : [])
    famByRegion.set(c.region_code, [...(famByRegion.get(c.region_code) ?? []), c]);
  const counts: Record<string, number> = {
    available: 0,
    constrained: 0,
    tight: 0,
    offered: 0,
    unknown: 0,
  };
  for (const cells of famByRegion.values()) {
    const w = worstLevel(cells);
    if (w) counts[w.level] = (counts[w.level] ?? 0) + 1;
  }
  const mapRegions: RegionMarker[] = (regionsApi.data?.regions ?? [])
    .filter((r) => r.code && famByRegion.has(r.code))
    .map((r) => {
      const w = worstLevel(famByRegion.get(r.code!)!)!;
      return {
        ...r,
        name: `${r.name}: ${LEVEL_LABEL[w.level]}${measureFor(w.signals) ? `, ${measureFor(w.signals)}` : ""}`,
        level: w.level,
      };
    });
  const waiting = ADAPTER_META.filter((a) => a.credentials?.length);

  return (
    <>
      <section className="block" style={{ paddingTop: "0.5rem" }}>
        <h1>Availability signals</h1>
        <p className="muted" style={{ marginTop: "0.5rem" }}>
          Could a new customer get this SKU in this region now? Levels are relative within one
          provider and SKU family, from public market signals and, where an account allows, the
          provider&apos;s own capacity answers. They measure spare capacity for new requests, not
          infrastructure, and are never converted to megawatts.
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
              {counts.offered ? `, ${counts.offered} offered without a scarcity signal` : ""};{" "}
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
                worst SKU per region; the figure is the provider&apos;s own measurement
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
                      const w = cells ? worstLevel(cells) : null;
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
                          {w && <span className="measure">{measureFor(w.signals)}</span>}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
            <ul className="small muted" style={{ marginTop: "0.75rem", paddingLeft: "1.1rem" }}>
              {p.signals.map((k) => (
                <li key={k}>
                  <span className="mono">{k.replace(/_/g, " ")}</span>: {SIGNAL_NOTES[k]}
                </li>
              ))}
            </ul>
          </>
        )}
        {!providers.length && <p className="muted">No availability signals recorded yet.</p>}
        <h2 style={{ marginTop: "2rem" }}>Not yet covered</h2>
        <ul className="small muted" style={{ marginTop: "0.5rem" }}>
          {waiting.map((a) => (
            <li key={a.id}>
              {a.title}: {a.measures} Waiting for {a.credentials!.join(", ")}.
            </li>
          ))}
          <li>
            Tencent Cloud returns sold-out status per instance type and zone, but only to an
            account.
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
