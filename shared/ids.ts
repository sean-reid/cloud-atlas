// Deterministic ids so re-running an adapter over unchanged input writes nothing new.
// Works in Node, Workers, and browsers through WebCrypto.
export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function stableId(
  prefix: string,
  parts: readonly (string | number | null)[],
): Promise<string> {
  const hash = await sha256Hex(parts.map((p) => (p === null ? "" : String(p))).join("\u001f"));
  return `${prefix}_${hash.slice(0, 16)}`;
}

export function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
