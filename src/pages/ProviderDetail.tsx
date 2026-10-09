import { Link, useParams } from "wouter";
import type { ProviderTotals } from "../../shared/aggregate";
import { metricById } from "../../shared/metrics";
import { PROVIDERS, type Provider } from "../../shared/providers";
import type { Observation } from "../../shared/types";
import { useApi } from "../lib/api";
import { fmtDate, fmtMetric, fmtMw, statusLabel, tierLabel } from "../lib/format";
import type { SiteRow } from "../lib/types";
import { SitesTable } from "./Sites";

interface Detail {
  provider: Provider;
  totals: ProviderTotals | null;
  sites: SiteRow[];
  stated: (Observation & { tier: number; publisher: string; title: string; url: string })[];
  regions_tracked: number;
}

export function ProviderDetail() {
  const { slug } = useParams<{ slug: string }>();
  const { data, loading } = useApi<Detail>(`/api/providers/${slug}`);
  const p = PROVIDERS.find((x) => x.slug === slug);
  if (!p) return <p>Unknown provider.</p>;
  if (loading || !data) return <p className="muted">Loading...</p>;
  const t = data.totals;
  return (
    <>
      <section className="block" style={{ paddingTop: "0.5rem" }}>
        <div className="cap">
          {p.company} ·{" "}
          {p.category === "gpu"
            ? "GPU cloud"
            : p.category === "hyperscale"
              ? "hyperscale cloud"
              : "regional cloud"}
        </div>
        <h1 style={{ marginTop: "0.4rem" }}>
          <span
            className="mark"
            style={{ ["--c" as string]: p.color, width: "0.5em", height: "0.5em" }}
          />
          {p.name}
        </h1>
      </section>
      <section className="block">
        <div className="grid stats">
          <div className="stat">
            <div className="cap">Tracked operational IT power</div>
            <div className="value">{t ? fmtMw(t.it_power_mw) : "unknown"}</div>
            <div className="note">
              {t
                ? `${t.it_sites} sites with an IT figure; ${Math.round(t.derived_share * 100)}% of the total is derived.`
                : "No site-level power evidence yet."}
            </div>
          </div>
          <div className="stat">
            <div className="cap">Facility power, IT figure unknown</div>
            <div className="value">{t ? fmtMw(t.facility_only_power_mw) : "unknown"}</div>
            <div className="note">
              {t ? `${t.facility_only_sites} sites. Kept apart from IT power.` : ""}
            </div>
          </div>
          <div className="stat">
            <div className="cap">Pipeline</div>
            <div className="value" style={{ fontSize: "1.6rem", marginTop: "0.5rem" }}>
              {t
                ? `${fmtMw(t.pipeline_it_power_mw.under_construction + t.pipeline_facility_only_power_mw.under_construction)} building`
                : "unknown"}
            </div>
            <div className="note">
              {t
                ? `${fmtMw(t.pipeline_it_power_mw.announced + t.pipeline_facility_only_power_mw.announced)} announced, as published, IT and facility bases mixed.`
                : ""}
            </div>
          </div>
          <div className="stat">
            <div className="cap">Cloud regions tracked</div>
            <div className="value">{data.regions_tracked || "unknown"}</div>
            <div className="note">
              From the provider&apos;s own region documentation. Regions are geography and carry no
              power.
            </div>
          </div>
        </div>
      </section>
      <section className="block">
        <div className="lead">
          <h2>{p.company}&apos;s own fleet-wide figures</h2>
          <span className="muted small">never summed with site figures</span>
        </div>
        {data.stated.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Metric</th>
                  <th className="num">Value</th>
                  <th>Status</th>
                  <th>Claim dated</th>
                  <th>Evidence</th>
                  <th>Source</th>
                  <th>Excerpt</th>
                </tr>
              </thead>
              <tbody>
                {data.stated.map((o) => (
                  <tr key={o.id}>
                    <td>{metricById(o.metric)?.label ?? o.metric}</td>
                    <td className="num">
                      {fmtMetric(o.metric, o.value, o.value_low, o.value_high)}
                    </td>
                    <td className={`status-${o.status}`}>{statusLabel[o.status]}</td>
                    <td>{fmtDate(o.effective_date)}</td>
                    <td>
                      <span className={`tag ${o.claim_type}`}>{o.claim_type}</span>{" "}
                      <span className="faint small">{tierLabel[o.tier]}</span>
                    </td>
                    <td>
                      <a href={o.url} rel="noopener">
                        {o.publisher}
                      </a>
                    </td>
                    <td style={{ minWidth: 240 }}>
                      {o.excerpt && <blockquote>{o.excerpt}</blockquote>}
                      {o.notes && <div className="small muted">{o.notes}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">None recorded yet.</p>
        )}
      </section>
      <section className="block">
        <div className="lead">
          <h2>Tracked sites</h2>
          <Link href={`/?provider=${p.slug}`} className="small">
            map
          </Link>
        </div>
        <SitesTable sites={data.sites} metric="it_power_mw" compact />
      </section>
    </>
  );
}
