import { useMemo, useState } from "react";
import { Link } from "wouter";
import { providerBySlug } from "../../shared/providers";
import { countryName, FilterBar } from "../components/FilterBar";
import { useApi } from "../lib/api";
import { api, useFilters } from "../lib/filters";
import { fmtDate, fmtMw, precisionLabel, statusLabel, tierLabel } from "../lib/format";
import type { Meta, SiteRow } from "../lib/types";

type Key =
  | "name"
  | "provider"
  | "country"
  | "status"
  | "it"
  | "facility"
  | "claim"
  | "effective"
  | "precision";

const STALE_DAYS = 540;

function cell(s: SiteRow, metric: string) {
  const m = s.metrics[metric];
  if (!m) return null;
  return m;
}

const PAGE = 40;

export function SitesTable({
  sites,
  metric,
  compact = false,
}: {
  sites: SiteRow[];
  metric: string;
  compact?: boolean;
}) {
  const [sort, setSort] = useState<{ key: Key; dir: 1 | -1 }>({ key: "it", dir: -1 });
  const [reveal, setReveal] = useState<{ sites: SiteRow[]; shown: number }>({ sites, shown: PAGE });
  if (reveal.sites !== sites) setReveal({ sites, shown: PAGE });
  const shown = reveal.shown;
  const setShown = (n: number) => setReveal({ sites, shown: n });
  const rows = useMemo(() => {
    const val = (s: SiteRow, k: Key): string | number => {
      switch (k) {
        case "name":
          return s.name;
        case "provider":
          return s.provider_slug;
        case "country":
          return s.country_code ?? "";
        case "status":
          return (cell(s, metric) ?? Object.values(s.metrics)[0])?.status ?? "";
        case "it":
          return s.metrics["it_power_mw"]?.value ?? -1;
        case "facility":
          return s.metrics["facility_power_mw"]?.value ?? -1;
        case "claim":
          return (cell(s, metric) ?? Object.values(s.metrics)[0])?.claim_type ?? "";
        case "effective":
          return (cell(s, metric) ?? Object.values(s.metrics)[0])?.effective_date ?? "";
        case "precision":
          return s.location_precision;
      }
    };
    return [...sites].sort((a, b) => {
      const x = val(a, sort.key);
      const y = val(b, sort.key);
      if (x === y) return a.name.localeCompare(b.name);
      return (x < y ? -1 : 1) * sort.dir;
    });
  }, [sites, sort, metric]);
  const header = (key: Key, label: string, num = false) => (
    <th
      className={num ? "num" : ""}
      aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() =>
          setSort((s) => ({
            key,
            dir: s.key === key ? ((s.dir * -1) as 1 | -1) : key === "name" ? 1 : -1,
          }))
        }
      >
        {label}
        {sort.key === key ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
      </button>
    </th>
  );
  return (
    <div className="table-scroll">
      <table className="stack">
        <thead>
          <tr>
            {header("name", "Site")}
            {!compact && header("provider", "Provider")}
            {header("country", "Country")}
            {header("status", "Status")}
            {header("it", "IT power", true)}
            {header("facility", "Facility power", true)}
            {header("claim", "Evidence")}
            {header("effective", "Claim dated")}
            {!compact && header("precision", "Location")}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, shown).map((s) => {
            const m =
              cell(s, metric) ??
              s.metrics["it_power_mw"] ??
              s.metrics["facility_power_mw"] ??
              Object.values(s.metrics)[0];
            const it = s.metrics["it_power_mw"];
            const fac = s.metrics["facility_power_mw"];
            const stale = s.age_days !== null && s.age_days > STALE_DAYS;
            const p = providerBySlug(s.provider_slug);
            return (
              <tr key={s.id}>
                <td className="lead-cell">
                  <Link href={`/sites/${s.id}`}>{s.name}</Link>
                  {s.type !== "campus" && <span className="faint small"> · {s.type}</span>}
                </td>
                {!compact && (
                  <td data-label="Provider">
                    <span className="mark" style={{ ["--c" as string]: p?.color }} />
                    {p?.shortName}
                  </td>
                )}
                <td data-label="Country">
                  {s.country_code ? (
                    countryName(s.country_code)
                  ) : (
                    <span className="faint">unknown</span>
                  )}
                </td>
                <td className={`status-${m?.status ?? "unknown"}`} data-label="Status">
                  {m ? statusLabel[m.status] : "unknown"}
                </td>
                <td className="num" data-label="IT power">
                  {it ? (
                    <>
                      {fmtMw(it.value)}
                      {it.claim_type === "derived" ? <span title="derived estimate"> ~</span> : ""}
                      {it.competing ? (
                        <span
                          className="faint"
                          title={`${it.competing} other observation${it.competing === 1 ? "" : "s"}`}
                        >
                          {" "}
                          ({it.competing + 1})
                        </span>
                      ) : (
                        ""
                      )}
                    </>
                  ) : (
                    <span className="faint">unknown</span>
                  )}
                </td>
                <td className="num" data-label="Facility power">
                  {fac ? (
                    <>
                      {fmtMw(fac.value)}
                      {fac.claim_type === "derived" ? <span title="derived estimate"> ~</span> : ""}
                    </>
                  ) : (
                    <span className="faint">unknown</span>
                  )}
                </td>
                <td data-label="Evidence">
                  {m && (
                    <span
                      className={`tag ${m.claim_type}`}
                      title={`${m.claim_type}, ${tierLabel[m.tier]}`}
                    >
                      {m.claim_type === "derived" ? "estimate" : "reported"} · T{m.tier}
                    </span>
                  )}
                </td>
                <td data-label="Claim dated">
                  {m ? fmtDate(m.effective_date) : ""}
                  {stale && (
                    <span
                      className="tag stale"
                      style={{ marginLeft: "0.4rem" }}
                      title="latest claim is more than 18 months old"
                    >
                      stale
                    </span>
                  )}
                </td>
                {!compact && (
                  <td
                    className={s.location_precision === "unknown" ? "faint" : ""}
                    data-label="Location"
                  >
                    {precisionLabel[s.location_precision]}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {!rows.length && <p className="muted">No sites match these filters.</p>}
      {rows.length > shown && (
        <p style={{ marginTop: "0.75rem" }}>
          <button type="button" onClick={() => setShown(rows.length)}>
            Show all {rows.length} sites
          </button>
        </p>
      )}
    </div>
  );
}

export function Sites() {
  const [filters, update, query] = useFilters();
  const meta = useApi<Meta>("/api/meta");
  const sites = useApi<{ sites: SiteRow[] }>(api("sites", query));
  return (
    <>
      <section className="block" style={{ paddingTop: "0.5rem" }}>
        <h1>Tracked sites</h1>
        <p className="muted" style={{ marginTop: "0.5rem" }}>
          Every campus, building, and phase with at least one cited observation. The figure shown is
          the one the selection rule picks; the count in parentheses is how many observations
          compete for it. A tilde marks a derived estimate.
        </p>
      </section>
      <FilterBar filters={filters} update={update} countries={meta.data?.countries ?? []} />
      <section className="block">
        <div className="lead">
          <span className="muted small">
            {sites.data ? `${sites.data.sites.length} sites` : "..."}
          </span>
          <a className="small" href={api("export.csv", query)} download>
            CSV of these observations
          </a>
        </div>
        {sites.data ? (
          <SitesTable sites={sites.data.sites} metric={filters.metric} />
        ) : (
          <p className="muted">Loading...</p>
        )}
      </section>
    </>
  );
}
