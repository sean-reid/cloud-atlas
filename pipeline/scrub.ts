const OCID = /ocid1\.[a-z0-9.-]+/gi;
const GOOGLE_PROJECT = /projects\/[^/\s]+/g;
const REQUEST_ID =
  /\b((?:x-ms-|opc-|x-amzn-|x-)?request[-_ ]?id)\b\s*[:=]?\s*["']?[A-Za-z0-9/+=_-]{6,}["']?/gi;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

// Fetch-run errors are public on /api/sources, so account identifiers come out first.
export function scrubError(text: string): string {
  return text
    .replace(OCID, "ocid1.[redacted]")
    .replace(GOOGLE_PROJECT, "projects/[redacted]")
    .replace(REQUEST_ID, "$1 [redacted]")
    .replace(UUID, "[uuid]");
}
