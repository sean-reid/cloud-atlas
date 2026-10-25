import { Link } from "wouter";
import { providerBySlug, PROVIDERS } from "../../shared/providers";
import { CapacitySeries, ProviderBars, RegionGrowth } from "../components/Charts";
import { statedPowerMw, statedVsTracked, type StatedPick } from "../lib/stated";
import { FilterBar } from "../components/FilterBar";
import { lazy, Suspense, type ReactNode } from "react";
import type { RegionMarker } from "../components/Map";

const AtlasMap = lazy(() => import("../components/Map").then((m) => ({ default: m.AtlasMap })));
import { useApi } from "../lib/api";
import { api, useFilters } from "../lib/filters";
import { fmtAgo, fmtDate, fmtMetric, fmtMw, fmtNum, statusLabel } from "../lib/format";
import type { FeedItem, Meta, SeriesPoint, SiteRow, Summary } from "../lib/types";

// "stated / tracked" cell text; either side may be missing.
function pair(
  stated: StatedPick | null,
  fmt: (v: number) => string,
  tracked: string | null,
): ReactNode {
  const left = stated ? (
    <span title={`stated as of ${fmtDate(stated.pick.effective_date)}`}>
      {fmt(stated.pick.value ?? 0)}
    </span>
  ) : (
    <span className="faint" title="no provider statement">
      -
    </span>
  );
  return (
    <>
      {left}
      <span className="faint"> / </span>
      {tracked ?? (
        <span className="faint" title="nothing tracked">
          -
        </span>
      )}
    </>
  );
}

export function Overview() {
  const [filters, update, query] = useFilters();
  const meta = useApi<Meta>("/api/meta");
  const summary = useApi<Summary>(api("summary", query));
  const sites = useApi<{ sites: SiteRow[] }>(api("sites", query));
  const regions = useApi<{ regions: RegionMarker[] }>(
    api(
      "regions",
      [
        filters.providers.length ? `provider=${filters.providers.join(",")}` : "",
        filters.demo ? "demo=1" : "",
      ]
        .filter(Boolean)
        .join("&"),
    ),
  );
  const series = useApi<{ series: Record<string, SeriesPoint[]> }>(api("timeseries", query));
  const feed = useApi<{ items: FeedItem[] }>(
    api("feed", filters.demo ? "limit=12&demo=1" : "limit=12"),
  );

  const t = summary.data?.tracked;
  const failing =
    meta.data?.freshness.filter((f) => !f.ok && !f.error?.startsWith("waiting for ")) ?? [];
  const latestRun =
    meta.data?.freshness
      .map((f) => f.last_success)
      .filter(Boolean)
      .sort()
      .at(-1) ?? null;
  const unlocated = sites.data ? sites.data.sites.filter((s) => s.lat === null).length : 0;

  return (
    <>
      <section className="block" style={{ paddingTop: "0.5rem" }}>
        <h1>Cloud datacenter capacity from public evidence.</h1>
        <p className="muted" style={{ marginTop: "0.6rem" }}>
          Every figure links to its source. Totals cover documented sites, not whole fleets.
        </p>
      </section>

      <FilterBar filters={filters} update={update} countries={meta.data?.countries ?? []} />

      <section className="block">
        <div className="grid stats">
          <div className="stat">
            <div className="cap">Tracked operational IT power</div>
            <div className="value">{t ? fmtMw(t.it_power_mw) : "..."}</div>
            <div className="note">
              Sum of selected operational figures across{" "}
              {t ? fmtNum(summary.data!.totals.reduce((n, p) => n + p.it_sites, 0)) : "..."} sites
              with an IT power figure. Campus totals replace their buildings, never both.
            </div>
          </div>
          <div className="stat">
            <div className="cap">Facility power, IT figure unknown</div>
            <div className="value">{t ? fmtMw(t.facility_only_power_mw) : "..."}</div>
            <div className="note">
              Shown apart because facility power includes cooling and losses. Not added to the IT
              total.
            </div>
          </div>
          <div className="stat">
            <div className="cap">Construction pipeline</div>
            <div className="value">
              {t
                ? fmtMw(
                    t.pipeline_it_power_mw.under_construction +
                      t.pipeline_facility_only_power_mw.under_construction,
                  )
                : "..."}
              <small>under construction</small>
            </div>
            <div className="note">
              Plus{" "}
              {t
                ? fmtMw(
                    t.pipeline_it_power_mw.announced + t.pipeline_facility_only_power_mw.announced,
                  )
                : "..."}{" "}
              announced. Pipeline figures mix IT and facility bases as published; see each site for
              which.
            </div>
          </div>
          <div className="stat">
            <div className="cap">Evidence freshness</div>
            <div className="value" style={{ fontSize: "1.6rem", marginTop: "0.5rem" }}>
              {latestRun ? `sources checked ${fmtAgo(latestRun)}` : "..."}
            </div>
            <div className="note">
              {summary.data?.evidence.observations ?? "..."} observations in view, newest recorded{" "}
              {fmtDate(summary.data?.evidence.latest_recorded)}.{" "}
              {failing.length
                ? `${failing.length} source${failing.length === 1 ? "" : "s"} failing; last good data kept.`
                : "All sources healthy."}{" "}
              <Link href="/sources">Source health</Link>
            </div>
          </div>
        </div>
      </section>

      <section className="block">
        <div className="lead">
          <h2>Map of tracked sites</h2>
          <span className="muted small">
            {sites.data ? `${sites.data.sites.length - unlocated} located sites` : "..."}
            {unlocated ? `, ${unlocated} with unknown location in the table` : ""} ·{" "}
            {regions.data?.regions.length ?? "..."} cloud regions as centroids
          </span>
        </div>
        <Suspense fallback={<div className="map" aria-busy="true" />}>
          <AtlasMap
            sites={sites.data?.sites ?? []}
            regions={regions.data?.regions ?? []}
            metric={filters.metric}
          />
        </Suspense>
      </section>

      <section className="block">
        <div className="grid two">
          <div>
            <div className="lead">
              <h2>Providers compared</h2>
            </div>
            {summary.data ? (
              <ProviderBars
                totals={summary.data.totals}
                stated={statedPowerMw(summary.data.provider_stated)}
              />
            ) : (
              <p className="muted">Loading...</p>
            )}
            {summary.data && (
              <div className="small" style={{ marginTop: "1rem" }}>
                <div className="cap" style={{ marginBottom: "0.3rem" }}>
                  Stated by the provider, tracked by the evidence
                </div>
                <div className="table-scroll">
                  <table className="compact">
                    <thead>
                      <tr>
                        <th>Provider</th>
                        <th>Regions</th>
                        <th>Buildings</th>
                        <th>Power</th>
                      </tr>
                    </thead>
                    <tbody>
                      {statedVsTracked(
                        summary.data.provider_stated,
                        summary.data.totals,
                        regions.data?.regions ?? [],
                        sites.data?.sites ?? [],
                      ).map((r) => (
                        <tr key={r.provider_slug}>
                          <td className="lead-cell">
                            <Link href={`/providers/${r.provider_slug}`}>
                              {providerBySlug(r.provider_slug)?.shortName ?? r.provider_slug}
                            </Link>
                          </td>
                          <td data-label="Regions">
                            {pair(
                              r.regions.stated,
                              (v) => fmtNum(v),
                              r.regions.tracked ? fmtNum(r.regions.tracked) : null,
                            )}
                          </td>
                          <td data-label="Buildings">
                            {pair(
                              r.datacenters.stated,
                              (v) => fmtNum(v),
                              r.datacenters.mapped ? fmtNum(r.datacenters.mapped) : null,
                            )}
                          </td>
                          <td data-label="Operational power">
                            {pair(
                              r.power.stated,
                              (v) => fmtMw(v),
                              r.power.tracked_mw ? fmtMw(r.power.tracked_mw) : null,
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="muted" style={{ marginTop: "0.4rem" }}>
                  Each cell reads stated / tracked: the provider&apos;s own figure, dated on hover,
                  beside what cited evidence covers. Stated buildings are the provider&apos;s
                  datacenter count; tracked ones are mapped buildings. Tracked power is the bar
                  above. The two sides are never added together.
                </p>
              </div>
            )}
          </div>
          <div>
            <div className="lead">
              <h2>Tracked capacity over time</h2>
              <span className="muted small">
                {filters.mode === "known" ? "as known at the time" : "best current reconstruction"}
              </span>
            </div>
            {series.data ? (
              <CapacitySeries series={series.data.series} mode={filters.mode} />
            ) : (
              <p className="muted">Loading...</p>
            )}
          </div>
        </div>
      </section>

      <section className="block">
        <div className="grid two">
          <div>
            <div className="lead">
              <h2>Recent evidence</h2>
              <Link href="/sources" className="small">
                sources
              </Link>
            </div>
            <ul className="feed">
              {(feed.data?.items ?? []).map((i) => (
                <li key={i.id}>
                  <span className="when">{fmtDate(i.recorded_at.slice(0, 10))}</span>
                  <span className="what">
                    <span className="tag" style={{ marginRight: "0.5rem" }}>
                      {i.kind}
                    </span>
                    <Link
                      href={
                        i.entity_type === "provider"
                          ? `/providers/${i.provider_slug}`
                          : `/sites/${i.entity_id}`
                      }
                    >
                      {i.entity_name}
                    </Link>
                    : {fmtMetric(i.metric, i.value, i.value_low, i.value_high)}{" "}
                    {i.metric.replace(/_/g, " ").replace(" mw", "")}, {statusLabel[i.status]}, claim
                    dated {fmtDate(i.effective_date)} ·{" "}
                    <a href={i.url} rel="noopener">
                      {i.publisher}
                    </a>
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="lead">
              <h2>Cloud regions over time</h2>
            </div>
            <RegionGrowth regions={regions.data?.regions ?? []} />
          </div>
        </div>
      </section>

      <section className="block">
        <h2>Coverage</h2>
        <div className="grid two" style={{ marginTop: "0.75rem" }}>
          <p>
            Site power comes from statements and public records transcribed with a citation, and
            from Epoch AI&apos;s satellite estimates of large AI sites. No provider publishes power
            per region or facility, so totals cover documented sites. Regions and zones come from
            provider documentation and carry no power.
          </p>
          <p>
            Deepest for AWS, Microsoft, Google, Oracle, and CoreWeave in the United States. Alibaba,
            Tencent, Huawei, and IBM are mostly provider-level; Baidu and OVHcloud have no evidence
            yet. The <Link href="/methodology">methodology</Link> has the rules and the coverage
            matrix.
          </p>
        </div>
        <div className="chips" style={{ marginTop: "0.5rem" }}>
          {PROVIDERS.map((p) => (
            <Link
              key={p.slug}
              href={`/providers/${p.slug}`}
              className="chip"
              style={{ ["--c" as string]: p.color, textDecoration: "none" }}
            >
              <span className="dot" />
              {p.shortName}
            </Link>
          ))}
        </div>
      </section>
    </>
  );
}
