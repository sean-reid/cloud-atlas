export const INGEST_WORKFLOW_URL =
  "https://api.github.com/repos/sean-reid/cloud-atlas/actions/workflows/ingest.yml/dispatches";

// The 05:00 UTC run is the daily full pass: every adapter plus the CSV import and retention.
// Every other hour asks for the hourly adapters only, the same split the workflow's own cron uses.
export function ingestAdaptersFor(now: Date): string {
  return now.getUTCHours() === 5 ? "" : "--schedule hourly";
}

export function ingestDispatch(now: Date, token: string): { url: string; init: RequestInit } {
  return {
    url: INGEST_WORKFLOW_URL,
    init: {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "cloud-atlas worker (+https://cloud-atlas.dwainosaur.com)",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({ ref: "main", inputs: { adapters: ingestAdaptersFor(now) } }),
    },
  };
}
