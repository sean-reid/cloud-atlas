import { Link, useParams } from "wouter";
import { metricById } from "../../shared/metrics";
import { providerBySlug } from "../../shared/providers";
import type { Entity, Method, Observation, Status } from "../../shared/types";
import { countryName } from "../components/FilterBar";
import { useApi } from "../lib/api";
import {
  fmtAgo,
  fmtDate,
  fmtMetric,
  fmtOriginal,
  precisionLabel,
  statusLabel,
  tierLabel,
} from "../lib/format";

type Obs = Observation & {
  tier: number;
  publisher: string;
  title: string;
  url: string;
  published_date: string | null;
};

interface Detail {
  entity: Entity;
  ancestors: Entity[];
  children: Entity[];
  metrics: Record<
    string,
    {
      selected: string | null;
      selected_by_status: Partial<Record<Status, string>>;
      observations: Obs[];
    }
  >;
  methods: Method[];
}

export function EntityDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading } = useApi<Detail>(`/api/entities/${id}`);
  if (loading) return <p className="muted">Loading...</p>;
  if (error || !data) return <p>Unknown entity.</p>;
  const e = data.entity;
  const p = providerBySlug(e.provider_slug);
  const metricOrder = Object.keys(data.metrics).sort(
    (a, b) =>
      (metricById(a)?.family === "power" ? -1 : 1) - (metricById(b)?.family === "power" ? -1 : 1),
  );
  return (
    <>
      <section className="block" style={{ paddingTop: "0.5rem" }}>
        <div className="cap">
          <Link href={`/providers/${e.provider_slug}`}>{p?.name}</Link>
          {data.ancestors
            .slice()
            .reverse()
            .filter((a) => a.type !== "provider")
            .map((a) => (
              <span key={a.id}>
                {" "}
                › <Link href={`/sites/${a.id}`}>{a.name}</Link>
              </span>
            ))}
        </div>
        <h1 style={{ marginTop: "0.4rem" }}>{e.name}</h1>
        <dl className="kv" style={{ marginTop: "1rem" }}>
          <dt>Kind</dt>
          <dd>{e.type}</dd>
          <dt>Location</dt>
          <dd>
            {[e.locality, e.admin_area, e.country_code ? countryName(e.country_code) : null]
              .filter(Boolean)
              .join(", ") || "unknown"}
            <span className="muted"> · {precisionLabel[e.location_precision]}</span>
            {e.lat !== null && (
              <span className="mono muted">
                {" "}
                {e.lat.toFixed(2)}, {e.lon?.toFixed(2)}
              </span>
            )}
          </dd>
          <dt>Ownership</dt>
          <dd>
            {e.ownership.replace("_", " ")}
            {e.landlord ? ` · landlord ${e.landlord}` : ""}
          </dd>
          {data.children.length > 0 && (
            <>
              <dt>Contains</dt>
              <dd>
                {data.children.map((c, i) => (
                  <span key={c.id}>
                    {i > 0 && ", "}
                    <Link href={`/sites/${c.id}`}>{c.name}</Link>
                  </span>
                ))}
              </dd>
            </>
          )}
        </dl>
      </section>

      {metricOrder.map((metric) => {
        const group = data.metrics[metric]!;
        const def = metricById(metric);
        const selectedIds = new Set(Object.values(group.selected_by_status));
        const selected = group.observations.filter((o) => selectedIds.has(o.id));
        return (
          <section className="block" key={metric}>
            <div className="lead">
              <h2>{def?.label ?? metric}</h2>
              {selected.length > 0 && (
                <span className="muted small">
                  selected:{" "}
                  {selected
                    .map(
                      (o) =>
                        `${fmtMetric(metric, o.value, o.value_low, o.value_high)} ${statusLabel[o.status]}, claim dated ${fmtDate(o.effective_date)}`,
                    )
                    .join("; ")}
                  {group.observations.length > 1
                    ? ` · ${group.observations.length} observations`
                    : ""}
                </span>
              )}
            </div>
            <div className="table-scroll">
              <table className="stack">
                <thead>
                  <tr>
                    <th className="num">Value</th>
                    <th>Status</th>
                    <th>Claim dated</th>
                    <th>Evidence</th>
                    <th>Source</th>
                    <th>Recorded</th>
                    <th>Excerpt and notes</th>
                  </tr>
                </thead>
                <tbody>
                  {group.observations.map((o) => {
                    const superseded = group.observations.some((x) => x.supersedes_id === o.id);
                    const shown = fmtMetric(metric, o.value, o.value_low, o.value_high);
                    const original = o.value_original
                      ? fmtOriginal(metric, o.value_original)
                      : null;
                    return (
                      <tr key={o.id} style={{ opacity: superseded ? 0.6 : 1 }}>
                        <td className="num lead-cell">
                          {selectedIds.has(o.id) && (
                            <span title={`selected for the dashboard as ${statusLabel[o.status]}`}>
                              ▸{" "}
                            </span>
                          )}
                          {shown}
                          {original && original !== shown && (
                            <div className="faint small">as written: {original}</div>
                          )}
                        </td>
                        <td className={`status-${o.status}`} data-label="Status">
                          {statusLabel[o.status]}
                          <div className="faint small">{o.scope.replace("_", " ")}</div>
                        </td>
                        <td data-label="Claim dated">
                          {fmtDate(o.effective_date)}
                          <div className="faint small">{o.effective_kind.replace("_", " ")}</div>
                        </td>
                        <td data-label="Evidence">
                          <span className={`tag ${o.claim_type}`}>{o.claim_type}</span>
                          <div className="faint small">{tierLabel[o.tier]}</div>
                          {o.method_id && <div className="faint small">method {o.method_id}</div>}
                          {superseded && <div className="faint small">superseded</div>}
                        </td>
                        <td data-label="Source">
                          <a href={o.url} rel="noopener">
                            {o.publisher}
                          </a>
                          <div className="faint small">
                            {o.title}
                            {o.published_date ? `, ${fmtDate(o.published_date)}` : ""}
                          </div>
                        </td>
                        <td data-label="Recorded">
                          <span title={o.recorded_at}>{fmtAgo(o.recorded_at)}</span>
                          <div className="faint small">
                            retrieved {fmtDate(o.retrieved_at.slice(0, 10))}
                          </div>
                        </td>
                        <td className="full-cell" data-label="Excerpt" style={{ minWidth: 260 }}>
                          {o.excerpt && <blockquote>{o.excerpt}</blockquote>}
                          {o.notes && (
                            <div className="small muted" style={{ marginTop: "0.3rem" }}>
                              {o.notes}
                            </div>
                          )}
                          {o.locator && <div className="faint small mono">{o.locator}</div>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}

      {data.methods.length > 0 && (
        <section className="block">
          <h2>Methods behind derived figures</h2>
          {data.methods.map((m) => (
            <div key={m.id} style={{ marginTop: "0.75rem" }}>
              <h3>
                {m.title} <span className="mono muted">{m.id}</span>
              </h3>
              <p>{m.description}</p>
              <p className="muted small">Assumptions: {m.assumptions}</p>
            </div>
          ))}
        </section>
      )}
    </>
  );
}
