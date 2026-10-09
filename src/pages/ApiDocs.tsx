import { useApi } from "../lib/api";

interface OpenApi {
  info: { title: string; version: string; description: string };
  servers: { url: string }[];
  paths: Record<
    string,
    {
      get: {
        summary: string;
        parameters?: {
          name: string;
          description?: string;
          schema: { type: string; enum?: string[] };
        }[];
      };
    }
  >;
}

const EXAMPLES: [string, string][] = [
  ["/api/summary?provider=aws,gcp", "Tracked totals for two providers"],
  ["/api/sites?country=US&status=operational", "Operational US sites with their selected figures"],
  ["/api/timeseries?mode=known", "Capacity as it was known at each month end"],
  ["/api/export.csv?claim=reported", "Only reported figures, as CSV with provenance"],
  ["/api/availability?provider=azure", "Latest Azure availability signals and levels"],
];

export function ApiDocs() {
  const { data } = useApi<OpenApi>("/api/openapi.json");
  return (
    <div className="prose">
      <section className="block" style={{ paddingTop: "0.5rem" }}>
        <h1>Read-only API</h1>
        <p className="muted" style={{ marginTop: "0.5rem" }}>
          Same data as the site, same filters as the address bar. Every response carries provenance
          and scope. <a href="/api/openapi.json">OpenAPI document</a>.
        </p>
      </section>
      {data && (
        <>
          <p>{data.info.description}</p>
          <h2>Endpoints</h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Path</th>
                  <th>Returns</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(data.paths).map(([path, def]) => (
                  <tr key={path}>
                    <td className="mono">GET /api{path}</td>
                    <td>{def.get.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h2>Filters</h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Parameter</th>
                  <th>Meaning</th>
                </tr>
              </thead>
              <tbody>
                {(data.paths["/summary"]?.get.parameters ?? []).map((p) => (
                  <tr key={p.name}>
                    <td className="mono">{p.name}</td>
                    <td>
                      {p.description ?? ""}
                      {p.schema.enum ? (
                        <span className="faint"> ({p.schema.enum.join(", ")})</span>
                      ) : (
                        ""
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h2>Examples</h2>
          <ul>
            {EXAMPLES.map(([href, label]) => (
              <li key={href}>
                <a href={href} className="mono">
                  {href}
                </a>{" "}
                <span className="muted">{label}</span>
              </li>
            ))}
          </ul>
          <h2>Terms</h2>
          <p>
            Compiled data is CC BY 4.0; cite Cloud Atlas and the original source each observation
            names. Epoch AI figures are CC BY 4.0 and must credit Epoch AI. Responses are cached for
            five minutes. Be polite: the Worker serves a small database and there is no key, so a
            handful of requests a second is plenty.
          </p>
        </>
      )}
    </div>
  );
}
