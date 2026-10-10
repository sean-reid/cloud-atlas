import { scaleLinear, scaleUtc } from "d3-scale";
import { useState } from "react";
import { HIGHER_IS_WORSE, LEVEL_LABEL, type DayCell, type Level } from "../../shared/availability";
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

const DAY = 86_400_000;
const HOUR = 3_600_000;
const WINDOWS = [7, 30, 90] as const;
const ROW_LIMIT = 12;
type Window = (typeof WINDOWS)[number];

const rank: Record<Level, number> = {
  tight: 3,
  constrained: 2,
  available: 1,
  offered: 0,
  unknown: 0,
};

const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);

// The last `days` UTC dates ending today, so the strip always shows the whole window and days
// without readings stay visible as gaps.
function windowDays(days: number, now: number): string[] {
  const today = Date.parse(utcDay(now));
  return Array.from({ length: days }, (_, i) => utcDay(today - (days - 1 - i) * DAY));
}

// One row per region, one mark per day, worst SKU in the family per day. The strip reads like a
// calendar: a glance shows which regions were ever tight and when. Rows sort worst first by
// their latest day, and that row's hourly readings open by default.
export function AvailabilityHistory({ provider, family }: { provider: string; family: string }) {
  const [days, setDays] = useState<Window>(30);
  const [selected, setSelected] = useState<string | null | undefined>(undefined);
  const [showAll, setShowAll] = useState(false);
  const [now] = useState(() => Date.now());
  const { data } = useApi<History>(
    `/api/availability/history?provider=${provider}&family=${encodeURIComponent(family)}&days=${days}`,
  );

  const columns = windowDays(days, now);
  const byRegion = new Map<string, { region: string; sku: string; cells: Map<string, DayCell> }>();
  for (const s of data?.series ?? []) {
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
  const latestRank = (cells: Map<string, DayCell>) => {
    const last = [...cells.keys()].sort().pop();
    return last ? rank[cells.get(last)!.level] : -1;
  };
  const regions = [...byRegion.values()].sort(
    (a, b) => latestRank(b.cells) - latestRank(a.cells) || a.region.localeCompare(b.region),
  );
  const active =
    selected === null ? null : (regions.find((r) => r.region === selected) ?? regions[0] ?? null);
  const shown = showAll
    ? regions
    : regions.filter((r, i) => i < ROW_LIMIT || r.region === active?.region);
  const withReadings = data?.days.filter((d) => d >= columns[0]!) ?? [];
  const labelEvery = days <= 7 ? 1 : 7;
  const scrollToEnd = (el: HTMLDivElement | null) => {
    if (el) el.scrollLeft = el.scrollWidth;
  };

  return (
    <div className="history">
      <div className="lead">
        <h2>{family} over time</h2>
        <div className="chips" role="tablist" aria-label="History window">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              role="tab"
              className="chip mono"
              aria-selected={w === days}
              aria-pressed={w === days}
              onClick={() => setDays(w)}
            >
              {w}d
            </button>
          ))}
        </div>
      </div>
      {!data ? (
        <p className="muted small">Loading history...</p>
      ) : !withReadings.length ? (
        <p className="muted small">
          No readings for {family} in the last {days} days.
        </p>
      ) : (
        <p className="muted small">
          Readings on {withReadings.length} of the last {days} days, since{" "}
          {fmtDate(withReadings[0])}. Each mark is the day&apos;s worst hour for the family&apos;s
          worst SKU. Click a region for its hourly readings, again to hide them.
        </p>
      )}
      <div className="ribbon-scroll" ref={scrollToEnd}>
        <div
          className="ribbon"
          style={{
            gridTemplateColumns: `minmax(88px, max-content) repeat(${columns.length}, minmax(var(--cell-min), 1fr))`,
          }}
          role="table"
          aria-label={`${family} availability by region and day`}
        >
          <div className="ribbon-head" role="columnheader">
            region
          </div>
          {columns.map((d, i) => {
            const fromEnd = columns.length - 1 - i;
            const labelled = fromEnd % labelEvery === 0;
            const prevLabelled = columns[i - labelEvery];
            const month = labelled && (!prevLabelled || prevLabelled.slice(0, 7) !== d.slice(0, 7));
            return (
              <div
                key={d}
                className={`ribbon-head day${fromEnd === 0 ? " today" : ""}`}
                role="columnheader"
                title={fmtDate(d)}
              >
                {labelled && (
                  <span className={`tick${i < 2 ? " first" : ""}`}>
                    {month ? (
                      <span className="month">
                        {new Date(`${d}T00:00:00Z`).toLocaleString("en", {
                          month: "short",
                          timeZone: "UTC",
                        })}{" "}
                      </span>
                    ) : null}
                    {String(Number(d.slice(8)))}
                  </span>
                )}
              </div>
            );
          })}
          {shown.map((r) => (
            <div key={r.region} style={{ display: "contents" }} role="row">
              <button
                type="button"
                className={`ribbon-region mono${active?.region === r.region ? " on" : ""}`}
                onClick={() => setSelected(active?.region === r.region ? null : r.region)}
                aria-pressed={active?.region === r.region}
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
      {regions.length > shown.length && (
        <p style={{ marginTop: "0.75rem" }}>
          <button type="button" onClick={() => setShowAll(true)}>
            Show all {regions.length} regions
          </button>
        </p>
      )}
      {active && (
        <SignalLines provider={provider} region={active.region} sku={active.sku} days={days} />
      )}
    </div>
  );
}

interface Band {
  level: Level;
  from: number;
  to: number;
}

interface Unit {
  label: string;
  format: (v: number) => string;
  domain?: [number, number];
  bands?: Band[];
}

// Per-signal axis and the level bands the methodology page documents, so the plot shows where
// a reading sits, not just what it is. Spot ratios have no fixed bands: their terciles are
// relative within the family.
const SIGNAL_UNIT: Partial<Record<AvailabilitySignalKind, Unit>> = {
  spot_ratio: {
    label: "spot price, share of list",
    format: (v) => `${Math.round(v * 100)}%`,
    domain: [0, 1],
  },
  interruption_band: {
    label: "interruption band",
    format: (v) => String(v),
    domain: [0, 4],
    bands: [
      { level: "available", from: 0, to: 1.5 },
      { level: "constrained", from: 1.5, to: 2.5 },
      { level: "tight", from: 2.5, to: 4 },
    ],
  },
  placement_score: {
    label: "placement score",
    format: (v) => `${v}/10`,
    domain: [0, 10],
    bands: [
      { level: "tight", from: 0, to: 3.5 },
      { level: "constrained", from: 3.5, to: 6.5 },
      { level: "available", from: 6.5, to: 10 },
    ],
  },
  lead_time_days: {
    label: "days until a block can start",
    format: (v) => (v >= 999 ? "none" : v <= 0 ? "now" : `${v}d`),
    bands: [
      { level: "available", from: 0, to: 0.5 },
      { level: "constrained", from: 0.5, to: 3.5 },
      { level: "tight", from: 3.5, to: Infinity },
    ],
  },
  sell_status: {
    label: "sell status",
    format: (v) => (v >= 1 ? "in stock" : v > 0 ? "low" : "sold out"),
    domain: [0, 1],
    bands: [
      { level: "tight", from: 0, to: 0.5 },
      { level: "available", from: 0.5, to: 1 },
    ],
  },
  capacity_report: {
    label: "capacity report",
    format: (v) => (v >= 1 ? "available" : "out"),
    domain: [0, 1],
    bands: [
      { level: "tight", from: 0, to: 0.5 },
      { level: "available", from: 0.5, to: 1 },
    ],
  },
};

const fmtHour = (t: number) =>
  new Date(t).toLocaleString("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }) + " UTC";

// Hourly readings for one region and SKU, one small chart per signal sharing a time axis that
// spans the whole window. Lines are steps because a reading holds until the next probe; the
// shaded bands are the levels, so a stub of fresh data still reads at a glance.
export function SignalLines({
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
  const [hover, setHover] = useState<number | null>(null);
  const [now] = useState(() => Date.now());
  const kinds = [...new Set((data?.points ?? []).map((p) => p.signal))].filter(
    (k) => k !== "sku_offered",
  );
  const wide = width >= 560;
  const pad = { top: 6, right: wide ? 84 : 10, bottom: 4, left: 46 };
  const height = 92;
  const x = scaleUtc()
    .domain([new Date(now - days * DAY), new Date(now)])
    .range([pad.left, width - pad.right]);
  const ticks = x.ticks(Math.max(3, Math.min(8, Math.floor((width - pad.left - pad.right) / 110))));
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * width;
    if (px < pad.left || px > width - pad.right) return setHover(null);
    setHover(+x.invert(px));
  };

  return (
    <div className="signal-lines" ref={ref}>
      <h3>
        {region} <span className="mono muted">{sku}</span>
      </h3>
      {!data ? (
        <p className="muted small">Loading readings...</p>
      ) : !kinds.length ? (
        <p className="muted small">
          Only offering rows for {sku} in {region}; nothing to plot.
        </p>
      ) : (
        <>
          {kinds.map((kind) => {
            const pts = data.points
              .filter((p) => p.signal === kind)
              .filter((p) => !(kind === "lead_time_days" && p.value >= 999))
              .map((p) => ({ t: Date.parse(p.observed_at), v: p.value }))
              .sort((a, b) => a.t - b.t);
            const meta = SIGNAL_UNIT[kind] ?? { label: kind, format: (v: number) => String(v) };
            const values = pts.map((p) => p.v);
            const domain: [number, number] = meta.domain ?? [0, Math.max(1, ...values) * 1.15];
            const y = scaleLinear()
              .domain(domain)
              .range([height - pad.bottom, pad.top]);
            const last = pts[pts.length - 1];
            const until = last ? Math.min(now, last.t + 2 * HOUR) : now;
            const worse = (a: number, b: number) =>
              HIGHER_IS_WORSE.has(kind) ? Math.max(a, b) : Math.min(a, b);
            const worst = values.length ? values.reduce(worse) : null;
            const held = hover === null ? null : [...pts].reverse().find((p) => p.t <= hover);
            let d = "";
            pts.forEach((p, i) => {
              const px = x(new Date(p.t));
              const py = y(p.v);
              d += i === 0 ? `M${px},${py}` : `H${px}V${py}`;
            });
            if (last) d += `H${x(new Date(until))}`;
            const yTicks = meta.domain ? [domain[0], domain[1]] : y.ticks(2);
            return (
              <div key={kind} className="signal-row">
                <div className="cap signal-cap">
                  <span>{meta.label}</span>
                  <span className="mono">
                    {hover !== null && held
                      ? `${fmtHour(held.t)} ${meta.format(held.v)}`
                      : last
                        ? `now ${meta.format(last.v)}${worst !== null && worst !== last.v ? `, worst ${meta.format(worst)}` : ""}`
                        : ""}
                  </span>
                </div>
                <svg
                  className="chart signal-chart"
                  viewBox={`0 0 ${width} ${height}`}
                  role="img"
                  aria-label={`${meta.label} for ${sku} in ${region}`}
                  onPointerMove={onMove}
                  onPointerLeave={() => setHover(null)}
                >
                  <g className="bands">
                    {(meta.bands ?? []).map((b) => {
                      const top = y(Math.min(b.to, domain[1]));
                      const bottom = y(Math.max(b.from, domain[0]));
                      if (bottom <= top) return null;
                      return (
                        <g key={b.level}>
                          <rect
                            className={`band ${b.level}`}
                            x={pad.left}
                            width={Math.max(0, width - pad.right - pad.left)}
                            y={top}
                            height={bottom - top}
                          />
                          {wide && bottom - top >= 11 && (
                            <text x={width - pad.right + 8} y={(top + bottom) / 2 + 4}>
                              {b.level}
                            </text>
                          )}
                        </g>
                      );
                    })}
                  </g>
                  <g className="grid">
                    {ticks.map((t) => (
                      <line key={+t} x1={x(t)} x2={x(t)} y1={pad.top} y2={height - pad.bottom} />
                    ))}
                  </g>
                  <g className="axis">
                    {yTicks.map((t) => (
                      <text key={t} x={pad.left - 8} y={y(t) + 4} textAnchor="end">
                        {meta.format(t)}
                      </text>
                    ))}
                  </g>
                  <path d={d} fill="none" stroke="var(--ink)" strokeWidth={1.6} />
                  {pts.length <= 72 &&
                    pts.map((p) => (
                      <circle key={p.t} cx={x(new Date(p.t))} cy={y(p.v)} r={2.2} fill="var(--ink)">
                        <title>
                          {fmtHour(p.t)}: {meta.format(p.v)}
                        </title>
                      </circle>
                    ))}
                  {hover !== null && (
                    <g className="hover">
                      <line
                        x1={x(new Date(hover))}
                        x2={x(new Date(hover))}
                        y1={pad.top}
                        y2={height - pad.bottom}
                      />
                      {held && (
                        <circle cx={x(new Date(held.t))} cy={y(held.v)} r={4} fill="var(--ink)" />
                      )}
                    </g>
                  )}
                </svg>
              </div>
            );
          })}
          <svg
            className="chart signal-axis"
            viewBox={`0 0 ${width} 22`}
            role="presentation"
            aria-hidden="true"
          >
            <g className="axis">
              <line x1={pad.left} x2={width - pad.right} y1={0.5} y2={0.5} />
              {ticks
                .filter((t) => x(t) < width - pad.right - 40)
                .map((t) => (
                  <text key={+t} x={x(t)} y={15} textAnchor="middle">
                    {t.toLocaleString("en", { month: "short", day: "numeric", timeZone: "UTC" })}
                  </text>
                ))}
              <text x={width - pad.right} y={15} textAnchor="end" className="now">
                now
              </text>
            </g>
          </svg>
        </>
      )}
    </div>
  );
}
