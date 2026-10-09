type Level = "info" | "warn" | "error";

export interface LogFields {
  [key: string]: string | number | boolean | null | undefined;
}

// One JSON object per line on stdout so a cron log can be filtered with jq.
export function log(level: Level, event: string, fields: LogFields = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === "error") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}
