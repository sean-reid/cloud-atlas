import { ADAPTER_META } from "../../shared/adapters-meta";
import type { FetchRun, Source } from "../../shared/types";
import { useApi } from "../lib/api";
import { fmtAgo, fmtDate, tierLabel } from "../lib/format";

interface Data {
  sources: (Source & { n: number; latest_effective: string | null })[];
  runs: FetchRun[];
  review_open: number;
}

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
              {ADAPTER_META.map((a) => {
                const id = a.id;
                const r = latest.get(id);
                const ok = latestOk.get(id);
                const waiting = !!r?.error?.startsWith("waiting for credentials");
                return (
                  <tr key={id}>
                    <td>
                      {a.title}
                      <div className="faint small mono">{id}</div>
                    </td>
                    <td>
                      {a.mode.replace("_", " ")}
                      {a.credentials?.length ? (
                        <div className="faint small">needs an account</div>
                      ) : null}
                    </td>
                    <td>{a.schedule}</td>
                    <td>
                      {r ? (
                        <>
                          <span title={r.started_at}>{fmtAgo(r.started_at)}</span>
                          {!r.ok && !waiting && (
                            <div className="small" style={{ fontStyle: "italic" }}>
                              failed: {r.error}
                            </div>
                          )}
                          {waiting && <div className="small faint">no account yet</div>}
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
        <h2>Awaiting review</h2>
        <p className="muted small">
          {data
            ? data.review_open
              ? `${data.review_open} item${data.review_open === 1 ? "" : "s"}`
              : "Nothing"
            : "..."}{" "}
          waiting for a maintainer: ambiguous site matches, unresolved places, candidate figures
          from feeds. Pending items never appear on the public pages.
        </p>
      </section>
    </>
  );
}
