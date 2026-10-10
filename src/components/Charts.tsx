import { scaleBand, scaleLinear, scaleUtc } from "d3-scale";
import { useState, type ReactNode } from "react";
import type { ProviderTotals } from "../../shared/aggregate";
import { providerBySlug } from "../../shared/providers";
import { fmtMw } from "../lib/format";
import type { SeriesPoint } from "../lib/types";

const PAD = { top: 12, right: 16, bottom: 28, left: 44 };

export function useSize(initial = 720) {
  const [width, setWidth] = useState(initial);
  const ref = (el: HTMLDivElement | null) => {
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && Math.abs(w - width) > 2) setWidth(w);
    });
    ro.observe(el);
  };
  return { width, ref };
}

interface Tip {
  x: number;
  y: number;
  body: ReactNode;
}

// Horizontal bars of tracked operational IT power per provider. The hatched portion is the
// share of that total that rests on derived estimates. Pipeline totals sit alongside as text,
// never stacked onto the operational bar.
export function ProviderBars({ totals }: { totals: ProviderTotals[] }) {
  const rows = totals.filter((t) => t.it_power_mw > 0 || t.facility_only_power_mw > 0);
  const { width, ref } = useSize();
  const rowH = 34;
  const height = PAD.top + rows.length * rowH + 8;
  const max = Math.max(1, ...rows.map((t) => t.it_power_mw));
  const labelW = 92;
  const x = scaleLinear()
    .domain([0, max])
    .range([0, Math.max(60, width - labelW - 150)]);
  const [tip, setTip] = useState<Tip | null>(null);
  return (
    <div className="chart-wrap" ref={ref}>
      <svg
        className="chart"
        width={width}
        height={height}
        role="img"
        aria-label="Tracked operational IT power by provider"
      >
        <defs>
          <pattern
            id="hatch"
            width="6"
            height="6"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--paper)" strokeWidth="2.5" />
          </pattern>
        </defs>
        {rows.map((t, i) => {
          const p = providerBySlug(t.provider_slug);
          const y = PAD.top + i * rowH;
          const w = x(t.it_power_mw);
          const derivedW = w * t.derived_share;
          const pipeline =
            t.pipeline_it_power_mw.under_construction + t.pipeline_it_power_mw.announced;
          return (
            <g
              key={t.provider_slug}
              transform={`translate(0,${y})`}
              onMouseMove={(e) =>
                setTip({
                  x: e.nativeEvent.offsetX,
                  y: e.nativeEvent.offsetY,
                  body: (
                    <>
                      <strong>{p?.name}</strong>
                      <br />
                      {fmtMw(t.it_power_mw)} operational IT power across {t.it_sites} tracked site
                      {t.it_sites === 1 ? "" : "s"}
                      <br />
                      {Math.round(t.derived_share * 100)}% of that total rests on derived estimates
                      {t.facility_only_power_mw > 0 && (
                        <>
                          <br />+ {fmtMw(t.facility_only_power_mw)} facility power at{" "}
                          {t.facility_only_sites} site{t.facility_only_sites === 1 ? "" : "s"} with
                          no IT figure (not added)
                        </>
                      )}
                      {pipeline > 0 && (
                        <>
                          <br />
                          Pipeline: {fmtMw(t.pipeline_it_power_mw.under_construction)} under
                          construction, {fmtMw(t.pipeline_it_power_mw.announced)} announced
                        </>
                      )}
                    </>
                  ),
                })
              }
              onMouseLeave={() => setTip(null)}
            >
              <text x={0} y={rowH / 2 + 4} className="label">
                {p?.shortName ?? t.provider_slug}
              </text>
              <rect x={labelW} y={6} width={w} height={rowH - 14} fill={p?.color ?? "var(--ink)"} />
              {derivedW > 0 && (
                <rect
                  x={labelW + w - derivedW}
                  y={6}
                  width={derivedW}
                  height={rowH - 14}
                  fill="url(#hatch)"
                />
              )}
              <text x={labelW + w + 8} y={rowH / 2 + 4} className="num" fill="var(--ink)">
                {fmtMw(t.it_power_mw)}
                {t.it_sites ? ` · ${t.it_sites} site${t.it_sites === 1 ? "" : "s"}` : ""}
              </text>
            </g>
          );
        })}
      </svg>
      {tip && (
        <div className="chart-tip" style={{ left: tip.x + 12, top: tip.y + 12 }}>
          {tip.body}
        </div>
      )}
      <div className="legend">
        <span>
          <span className="mark" /> reported
        </span>
        <span>
          <span
            className="mark"
            style={{
              background: "repeating-linear-gradient(45deg, var(--ink) 0 2px, transparent 2px 4px)",
            }}
          />{" "}
          share from derived estimates
        </span>
        <span className="faint">
          Bars are operational IT power only. Facility-only figures and pipeline are shown on hover
          and in the table.
        </span>
      </div>
    </div>
  );
}

export interface SeriesSet {
  [provider: string]: SeriesPoint[];
}

// Step lines because capacity changes at observations, not between them. Triangles mark months
// where a newly tracked site entered the total; circles mark revisions of a site already tracked.
export function CapacitySeries({
  series,
  mode,
}: {
  series: SeriesSet;
  mode: "known" | "reconstructed";
}) {
  const { width, ref } = useSize();
  const height = 300;
  const [tip, setTip] = useState<Tip | null>(null);
  const providers = Object.keys(series).filter((k) => series[k]!.length > 0);
  const all = providers.flatMap((p) => series[p]!);
  const parse = (d: string) => new Date(`${d}-01T00:00:00Z`);
  const dates = all.map((d) => parse(d.date).getTime());
  const x = scaleUtc()
    .domain([new Date(Math.min(...dates)), new Date(Math.max(...dates))])
    .range([PAD.left, width - PAD.right]);
  const y = scaleLinear()
    .domain([0, Math.max(10, ...all.map((d) => d.it_power_mw)) * 1.08])
    .range([height - PAD.bottom, PAD.top]);
  if (!providers.length)
    return <p className="muted">No dated power observations match these filters.</p>;
  const ticks = x.ticks(Math.max(3, Math.floor(width / 110)));
  return (
    <div className="chart-wrap" ref={ref}>
      <svg
        className="chart"
        width={width}
        height={height}
        role="img"
        aria-label="Tracked operational IT power over time by provider"
      >
        <g className="grid">
          {y.ticks(4).map((t) => (
            <line key={t} x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
          ))}
        </g>
        <g className="axis">
          <line
            x1={PAD.left}
            x2={width - PAD.right}
            y1={height - PAD.bottom}
            y2={height - PAD.bottom}
          />
          {ticks.map((t) => (
            <text key={+t} x={x(t)} y={height - 8} textAnchor="middle">
              {t.getUTCFullYear()}
              {ticks.length > 8
                ? ""
                : ` ${t.toLocaleString("en", { month: "short", timeZone: "UTC" })}`}
            </text>
          ))}
          {y.ticks(4).map((t) => (
            <text key={t} x={PAD.left - 6} y={y(t) + 4} textAnchor="end">
              {t >= 1000 ? `${t / 1000} GW` : `${t}`}
            </text>
          ))}
        </g>
        {providers.map((slug) => {
          const pts = series[slug]!;
          const color = providerBySlug(slug)?.color ?? "var(--ink)";
          let d = "";
          pts.forEach((pt, i) => {
            const px = x(parse(pt.date));
            const py = y(pt.it_power_mw);
            if (i === 0) d += `M${px},${py}`;
            else d += `H${px}V${py}`;
          });
          const last = pts[pts.length - 1]!;
          d += `H${x(parse(last.date))}`;
          return (
            <g key={slug}>
              <path d={d} fill="none" stroke={color} strokeWidth={1.8} />
              {pts.map((pt) => {
                const px = x(parse(pt.date));
                const py = y(pt.it_power_mw);
                const show = (e: React.MouseEvent) =>
                  setTip({
                    x: e.nativeEvent.offsetX,
                    y: e.nativeEvent.offsetY,
                    body: (
                      <>
                        <strong>{providerBySlug(slug)?.shortName}</strong> · {pt.date}
                        <br />
                        {fmtMw(pt.it_power_mw)} tracked operational IT power, {pt.sites} site
                        {pt.sites === 1 ? "" : "s"}
                        {pt.new_sites > 0 && (
                          <>
                            <br />▲ {pt.new_sites} newly tracked site{pt.new_sites === 1 ? "" : "s"}{" "}
                            this month
                          </>
                        )}
                        {pt.revised_sites > 0 && (
                          <>
                            <br />○ {pt.revised_sites} revised figure
                            {pt.revised_sites === 1 ? "" : "s"}
                          </>
                        )}
                        <br />
                        <span className="muted">
                          {mode === "known"
                            ? "as known at the time"
                            : "best current reconstruction"}
                        </span>
                      </>
                    ),
                  });
                if (pt.new_sites > 0)
                  return (
                    <path
                      key={pt.date}
                      d={`M${px},${py - 7}l5,8h-10z`}
                      fill={color}
                      onMouseMove={show}
                      onMouseLeave={() => setTip(null)}
                    />
                  );
                if (pt.revised_sites > 0)
                  return (
                    <circle
                      key={pt.date}
                      cx={px}
                      cy={py}
                      r={3.5}
                      fill="var(--paper)"
                      stroke={color}
                      strokeWidth={1.5}
                      onMouseMove={show}
                      onMouseLeave={() => setTip(null)}
                    />
                  );
                return (
                  <circle
                    key={pt.date}
                    cx={px}
                    cy={py}
                    r={6}
                    fill="transparent"
                    onMouseMove={show}
                    onMouseLeave={() => setTip(null)}
                  />
                );
              })}
            </g>
          );
        })}
      </svg>
      {tip && (
        <div
          className="chart-tip"
          style={{ left: Math.min(tip.x + 12, width - 290), top: tip.y + 12 }}
        >
          {tip.body}
        </div>
      )}
      <div className="legend">
        {providers.map((slug) => (
          <span key={slug}>
            <span className="mark" style={{ ["--c" as string]: providerBySlug(slug)?.color }} />
            {providerBySlug(slug)?.shortName}
          </span>
        ))}
        <span>▲ newly tracked site</span>
        <span>○ revised figure</span>
        <span className="faint">
          A rise in tracked capacity is not the same as new construction; the markers say which it
          was.
        </span>
      </div>
    </div>
  );
}

// Cumulative count of cloud regions by launch date, from the providers' own documentation.
export function RegionGrowth({
  regions,
}: {
  regions: { provider_slug: string; opened: string | null }[];
}) {
  const { width, ref } = useSize();
  const height = 220;
  const byProvider = new Map<string, Date[]>();
  for (const r of regions) {
    if (!r.opened) continue;
    byProvider.set(r.provider_slug, [
      ...(byProvider.get(r.provider_slug) ?? []),
      new Date(r.opened),
    ]);
  }
  const providers = [...byProvider.keys()];
  if (!providers.length)
    return <p className="muted">No dated region launches for these providers yet.</p>;
  const allDates = [...byProvider.values()].flat();
  const x = scaleUtc()
    .domain([new Date(Math.min(...allDates.map((d) => +d))), new Date()])
    .range([PAD.left, width - PAD.right]);
  const y = scaleLinear()
    .domain([0, Math.max(...[...byProvider.values()].map((d) => d.length)) + 2])
    .range([height - PAD.bottom, PAD.top]);
  const band = scaleBand().domain(providers).range([0, 1]);
  void band;
  return (
    <div className="chart-wrap" ref={ref}>
      <svg
        className="chart"
        width={width}
        height={height}
        role="img"
        aria-label="Cumulative cloud regions by launch date"
      >
        <g className="axis">
          <line
            x1={PAD.left}
            x2={width - PAD.right}
            y1={height - PAD.bottom}
            y2={height - PAD.bottom}
          />
          {x.ticks(6).map((t) => (
            <text key={+t} x={x(t)} y={height - 8} textAnchor="middle">
              {t.getUTCFullYear()}
            </text>
          ))}
          {y.ticks(4).map((t) => (
            <text key={t} x={PAD.left - 6} y={y(t) + 4} textAnchor="end">
              {t}
            </text>
          ))}
        </g>
        {providers.map((slug) => {
          const dates = [...byProvider.get(slug)!].sort((a, b) => +a - +b);
          let d = `M${x(dates[0]!)},${y(0)}`;
          dates.forEach((dt, i) => {
            d += `H${x(dt)}V${y(i + 1)}`;
          });
          d += `H${x(new Date())}`;
          return (
            <path
              key={slug}
              d={d}
              fill="none"
              stroke={providerBySlug(slug)?.color ?? "var(--ink)"}
              strokeWidth={1.6}
            />
          );
        })}
      </svg>
      <div className="legend">
        {providers.map((slug) => (
          <span key={slug}>
            <span className="mark" style={{ ["--c" as string]: providerBySlug(slug)?.color }} />
            {providerBySlug(slug)?.shortName}
          </span>
        ))}
        <span className="faint">
          Regions are geography, not capacity. Only providers whose documentation dates each launch
          appear here.
        </span>
      </div>
    </div>
  );
}
