import { scaleLinear, scaleUtc } from "d3-scale";
import { useState } from "react";
import { LEVEL_LABEL, type DayCell, type Level } from "../../shared/availability";
import type { AvailabilitySignalKind } from "../../shared/types";
import { useApi } from "../lib/api";
import { useSize } from "./Charts";
import { fmtDate } from "../lib/format";

interface History {
  provider: string;
  family: string;
  since: string;
  days: string[];
  series: { region_code: string; sku: string; days: DayCell[] }[];
}

interface Series {
  points: {
    signal: AvailabilitySignalKind;
    observed_at: string;
    value: number;
    detail: Record<string, unknown> | null;
  }[];
}

const rank: Record<Level, number> = {
  tight: 3,
  constrained: 2,
  available: 1,
  offered: 0,
  unknown: 0,
};

// One row per region, one mark per day, worst SKU in the family per day. The strip reads like a
// calendar: a glance shows which regions were ever tight and when.
export function AvailabilityHistory({
  provider,
  family,
  days = 30,
}: {
  provider: string;
  family: string;
  days?: number;
}) {
  const { data } = useApi<History>(
    `/api/availability/history?provider=${provider}&family=${encodeURIComponent(family)}&days=${days}`,
  );
  const [selected, setSelected] = useState<{ region: string; sku: string } | null>(null);
  if (!data) return <p className="muted small">Loading history...</p>;
  if (!data.days.length) return <p className="muted small">No history yet for {family}.</p>;

  const byRegion = new Map<string, { region: string; sku: string; cells: Map<string, DayCell> }>();
  for (const s of data.series) {
    const entry = byRegion.get(s.region_code) ?? {
      region: s.region_code,
      sku: s.sku,
      cells: new Map<string, DayCell>(),
    };
    for (const d of s.days) {
      const prev = entry.cells.get(d.day);
      if (!prev || rank[d.level] > rank[prev.level]) {
        entry.cells.set(d.day, d);
        entry.sku = s.sku;
      }
    }
    byRegion.set(s.region_code, entry);
  }
  const regions = [...byRegion.values()].sort((a, b) => a.region.localeCompare(b.region));
  const first = data.days[0]!;
  const last = data.days[data.days.length - 1]!;
  const span = Math.max(1, Math.round((Date.parse(last) - Date.parse(first)) / 86_400_000) + 1);
  const columns: string[] = Array.from({ length: span }, (_, i) =>
    new Date(Date.parse(first) + i * 86_400_000).toISOString().slice(0, 10),
  );

  return (
    <div className="history">
      <p className="muted small">
        Collecting since {fmtDate(first)}; {data.days.length} day{data.days.length === 1 ? "" : "s"}{" "}
        with readings. Each mark is the worst hour of that day for the worst SKU in the family.
        Click a region for its hourly line.
      </p>
      <div className="table-scroll">
        <div
          className="ribbon"
          style={{
            gridTemplateColumns: `minmax(120px, max-content) repeat(${columns.length}, minmax(10px, 18px))`,
          }}
          role="table"
          aria-label={`${family} availability by region and day`}
        >
          <div className="ribbon-head" role="columnheader">
            region
          </div>
          {columns.map((d, i) => (
            <div key={d} className="ribbon-head day" role="columnheader" title={fmtDate(d)}>
              {i === 0 || d.endsWith("-01") ? (
                <span className="month">
                  {new Date(`${d}T00:00:00Z`).toLocaleString("en", {
                    month: "short",
                    timeZone: "UTC",
                  })}
                </span>
              ) : null}
              {String(Number(d.slice(8)))}
            </div>
          ))}
          {regions.map((r) => (
            <div key={r.region} style={{ display: "contents" }} role="row">
              <button
                type="button"
                className={`ribbon-region mono${selected?.region === r.region ? " on" : ""}`}
                onClick={() => setSelected({ region: r.region, sku: r.sku })}
                aria-pressed={selected?.region === r.region}
              >
                {r.region}
              </button>
              {columns.map((d) => {
                const c = r.cells.get(d);
                return (
                  <div
                    key={d}
                    className={`ribbon-cell ${c ? c.level : "absent"}`}
                    role="cell"
                    title={
                      c
                        ? `${fmtDate(d)}: ${LEVEL_LABEL[c.level]}${c.measure ? `, ${c.measure}` : ""} (${c.samples} reading${c.samples === 1 ? "" : "s"})`
                        : `${fmtDate(d)}: no reading`
                    }
                    aria-label={
                      c ? `${r.region} ${d} ${LEVEL_LABEL[c.level]}` : `${r.region} ${d} no reading`
                    }
                  >
                    <span className={`swatch ${c ? c.level : "absent"}`} />
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      {selected && (
        <SignalLine provider={provider} region={selected.region} sku={selected.sku} days={days} />
      )}
    </div>
  );
}

const SIGNAL_UNIT: Partial<
  Record<
    AvailabilitySignalKind,
    { label: string; format: (v: number) => string; domain?: [number, number] }
  >
> = {
  spot_ratio: {
    label: "spot price as a share of list",
    format: (v) => `${Math.round(v * 100)}%`,
    domain: [0, 1],
  },
  interruption_band: {
    label: "interruption band (0 lowest to 4 highest)",
    format: (v) => String(v),
    domain: [0, 4],
  },
  placement_score: {
    label: "placement score (10 best)",
    format: (v) => String(v),
    domain: [0, 10],
  },
  lead_time_days: {
    label: "days until a block can start",
    format: (v) => (v >= 999 ? "none" : `${v}d`),
  },
  sell_status: {
    label: "sell status (1 in stock, 0 sold out)",
    format: (v) => String(v),
    domain: [0, 1],
  },
  capacity_report: {
    label: "capacity report (1 available)",
    format: (v) => String(v),
    domain: [0, 1],
  },
};

// Hourly readings for one region and SKU, one line per signal kind, drawn as steps because a
// reading holds until the next probe.
export function SignalLine({
  provider,
  region,
  sku,
  days,
}: {
  provider: string;
  region: string;
  sku: string;
  days: number;
}) {
  const { data } = useApi<Series>(
    `/api/availability/series?provider=${provider}&region=${region}&sku=${encodeURIComponent(sku)}&days=${days}`,
  );
  const { width, ref } = useSize();
  if (!data) return <p className="muted small">Loading readings...</p>;
  const kinds = [...new Set(data.points.map((p) => p.signal))].filter(
    (k) => k !== "sku_offered",
  ) as AvailabilitySignalKind[];
  if (!kinds.length)
    return (
      <p className="muted small">
        Only offering rows for {sku} in {region}; nothing to plot.
      </p>
    );
  const height = Math.max(120, Math.min(180, Math.round(width * 0.22)));
  const pad = { top: 10, right: 12, bottom: 24, left: 44 };
  const times = data.points.map((p) => Date.parse(p.observed_at));
  const x = scaleUtc()
    .domain([new Date(Math.min(...times)), new Date(Math.max(...times) + 3_600_000)])
    .range([pad.left, width - pad.right]);
  return (
    <div style={{ marginTop: "1rem" }} ref={ref}>
      <h3>
        {region} <span className="mono muted">{sku}</span>
      </h3>
      {kinds.map((kind) => {
        const pts = data.points
          .filter((p) => p.signal === kind)
          .filter((p) => !(kind === "lead_time_days" && p.value >= 999));
        const meta = SIGNAL_UNIT[kind] ?? { label: kind, format: (v: number) => String(v) };
        const values = pts.map((p) => p.value);
        const domain = meta.domain ?? [0, Math.max(1, ...values) * 1.1];
        const y = scaleLinear()
          .domain(domain)
          .range([height - pad.bottom, pad.top]);
        let d = "";
        pts.forEach((p, i) => {
          const px = x(new Date(p.observed_at));
          const py = y(p.value);
          d += i === 0 ? `M${px},${py}` : `H${px}V${py}`;
        });
        if (pts.length) d += `H${x(new Date(Math.max(...times) + 3_600_000))}`;
        return (
          <div key={kind} className="chart-wrap" style={{ marginTop: "0.5rem" }}>
            <div className="cap">{meta.label}</div>
            <svg
              className="chart"
              viewBox={`0 0 ${width} ${height}`}
              role="img"
              aria-label={`${meta.label} for ${sku} in ${region}`}
            >
              <g className="grid">
                {y.ticks(3).map((t) => (
                  <line key={t} x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} />
                ))}
              </g>
              <g className="axis">
                {x.ticks(Math.min(6, Math.max(2, pts.length))).map((t) => (
                  <text key={+t} x={x(t)} y={height - 6} textAnchor="middle">
                    {t.toLocaleString("en", { month: "short", day: "numeric", timeZone: "UTC" })}
                  </text>
                ))}
                {y.ticks(3).map((t) => (
                  <text key={t} x={pad.left - 6} y={y(t) + 4} textAnchor="end">
                    {meta.format(t)}
                  </text>
                ))}
              </g>
              <path d={d} fill="none" stroke="var(--ink)" strokeWidth={1.6} />
              {pts.map((p) => (
                <circle
                  key={p.observed_at}
                  cx={x(new Date(p.observed_at))}
                  cy={y(p.value)}
                  r={2.5}
                  fill="var(--ink)"
                >
                  <title>
                    {new Date(p.observed_at).toUTCString()}: {meta.format(p.value)}
                  </title>
                </circle>
              ))}
            </svg>
          </div>
        );
      })}
    </div>
  );
}
