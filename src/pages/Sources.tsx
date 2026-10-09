import type { FetchRun, ReviewItem, Source } from "../../shared/types";
import { useApi } from "../lib/api";
import { fmtAgo, fmtDate, tierLabel } from "../lib/format";

interface Data {
  sources: (Source & { n: number; latest_effective: string | null })[];
  runs: FetchRun[];
  review: ReviewItem[];
}

const ADAPTERS: Record<
  string,
  { title: string; mode: string; schedule: string; measures: string }
> = {
  "aws-regions": {
    title: "AWS regions and zones",
    mode: "automated",
    schedule: "daily",
    measures: "region codes, zone counts, launch dates",
  },
  "gcp-regions": {
    title: "Google Cloud regions and zones",
    mode: "automated",
    schedule: "daily",
    measures: "zone list with cities",
  },
  "azure-regions": {
    title: "Azure regions list",
    mode: "automated",
    schedule: "daily",
    measures: "regions with zone counts",
  },
  "epoch-ai": {
    title: "Epoch AI, AI data centers",
    mode: "automated",
    schedule: "daily",
    measures: "estimated IT power, compute, timelines for large AI sites",
  },
  "csv-import": {
    title: "Reviewed observations",
    mode: "manual review",
    schedule: "on commit",
    measures: "cited capacity, land, and investment figures",
  },
  "azure-retail-prices": {
    title: "Azure Retail Prices",
    mode: "automated",
    schedule: "hourly",
    measures: "SKU offering map, spot price ratio",
  },
  "aws-spot-advisor": {
    title: "AWS Spot Instance Advisor",
    mode: "automated",
    schedule: "hourly",
    measures: "spot interruption bands",
  },
};

const UNSUPPORTED = [
  [
    "Microsoft datacenter globe",
    "no inspectable data endpoint; page renders client-side behind bot protection",
  ],
  [
    "Azure service tags file",
    "weekly file with a changing URL behind a bot-protected download page; region codes only",
  ],
  [
    "Google data center locations",
    "campus list with prose figures under Google's terms, transcribed by hand instead",
  ],
  ["Commercial trackers", "paid datasets with proprietary estimates; not used"],
  ["SEC filings", "give capex and square footage, never power; read by hand where cited"],
];

export function Sources() {
  const { data } = useApi<Data>("/api/sources");
  const latest = new Map<string, FetchRun>();
  const latestOk = new Map<string, FetchRun>();
  for (const r of data?.runs ?? []) {
    if (!latest.has(r.adapter)) latest.set(r.adapter, r);
    if (r.ok && !latestOk.has(r.adapter)) latestOk.set(r.adapter, r);
  }
  const open = (data?.review ?? []).filter((r) => !r.resolved_at);
  return (
    <>
      <section className="block" style={{ paddingTop: "0.5rem" }}>
        <h1>Sources and health</h1>
        <p className="muted" style={{ marginTop: "0.5rem" }}>
          Retrieval freshness is shown apart from the age of each claim. A successful re-fetch does
          not make an old figure current.
        </p>
      </section>
      <section className="block">
        <h2>Ingestion paths</h2>
        <div className="table-scroll" style={{ marginTop: "0.75rem" }}>
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Mode</th>
                <th>Schedule</th>
                <th>Last attempted</th>
                <th>Last successful</th>
                <th>Changed</th>
                <th>Measures</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(ADAPTERS).map(([id, a]) => {
                const r = latest.get(id);
                const ok = latestOk.get(id);
                return (
                  <tr key={id}>
                    <td>
                      {a.title}
                      <div className="faint small mono">{id}</div>
                    </td>
                    <td>{a.mode}</td>
                    <td>{a.schedule}</td>
                    <td>
                      {r ? (
                        <>
                          <span title={r.started_at}>{fmtAgo(r.started_at)}</span>
                          {!r.ok && (
                            <div className="small" style={{ fontStyle: "italic" }}>
                              failed: {r.error}
                            </div>
                          )}
                        </>
                      ) : (
                        <span className="faint">
                          {id === "csv-import" ? "runs on import" : "never"}
                        </span>
                      )}
                    </td>
                    <td>
                      {ok ? (
                        <span title={ok.finished_at}>{fmtAgo(ok.finished_at)}</span>
                      ) : (
                        <span className="faint">{id === "csv-import" ? "" : "never"}</span>
                      )}
                    </td>
                    <td>{r ? (r.changed ? "yes" : "no") : ""}</td>
                    <td className="small muted">{a.measures}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <h3 style={{ marginTop: "1.5rem" }}>Investigated and not used</h3>
        <ul className="small">
          {UNSUPPORTED.map(([name, why]) => (
            <li key={name}>
              <strong>{name}:</strong> {why}.
            </li>
          ))}
        </ul>
      </section>
      <section className="block">
        <h2>Cited sources</h2>
        <div className="table-scroll" style={{ marginTop: "0.75rem" }}>
          <table>
            <thead>
              <tr>
                <th>Publisher</th>
                <th>Title</th>
                <th>Tier</th>
                <th className="num">Observations</th>
                <th>Latest claim</th>
                <th>Published</th>
                <th>Licence</th>
              </tr>
            </thead>
            <tbody>
              {(data?.sources ?? []).map((s) => (
                <tr key={s.id}>
                  <td>{s.publisher}</td>
                  <td>
                    <a href={s.url} rel="noopener">
                      {s.title}
                    </a>
                  </td>
                  <td>{tierLabel[s.tier]}</td>
                  <td className="num">{s.n}</td>
                  <td>{s.latest_effective ? fmtDate(s.latest_effective) : ""}</td>
                  <td>
                    {s.published_date ? (
                      fmtDate(s.published_date)
                    ) : (
                      <span className="faint">undated</span>
                    )}
                  </td>
                  <td className="small muted">{s.license ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="block">
        <h2>Review queue</h2>
        <p className="muted small">
          Ambiguous matches, unresolved places, and pre-launch region codes wait here until a
          maintainer acts.
        </p>
        {open.length ? (
          <ul>
            {open.map((r) => (
              <li key={r.id}>
                <span className="mono small">{r.adapter}</span> · {r.reason}{" "}
                <span className="faint small">({fmtDate(r.created_at.slice(0, 10))})</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Nothing waiting.</p>
        )}
      </section>
    </>
  );
}
