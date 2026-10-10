import { decodeEntities, stripTags } from "./html";

export interface FeedEntry {
  title: string;
  link: string;
  published: string | null;
  text: string;
}

const tag = (xml: string, name: string): string | null => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(xml);
  if (!m) return null;
  const inner = m[1]!.trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(inner);
  return cdata ? cdata[1]! : decodeEntities(inner);
};

// Atom links sit in an href attribute; RSS puts the URL in the element body.
const atomLink = (xml: string): string | null => {
  const m =
    /<link[^>]*rel="alternate"[^>]*href="([^"]+)"/i.exec(xml) ??
    /<link[^>]*href="([^"]+)"/i.exec(xml);
  return m ? decodeEntities(m[1]!) : null;
};

function toIso(date: string | null): string | null {
  if (!date) return null;
  const t = Date.parse(date.trim());
  if (Number.isFinite(t)) return new Date(t).toISOString();
  // A few feeds omit the weekday, which Date.parse accepts, but some pad with odd spacing.
  const t2 = Date.parse(date.trim().replace(/\s+/g, " "));
  return Number.isFinite(t2) ? new Date(t2).toISOString() : null;
}

// Reads RSS 2.0 and Atom with a tolerant pass over item blocks; feeds here are hand-picked and
// well formed, and a strict XML parser would add a dependency for no gain.
export function parseFeed(xml: string): FeedEntry[] {
  const out: FeedEntry[] = [];
  const blocks = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map((m) => m[0]);
  for (const b of blocks) {
    const link = tag(b, "link")?.trim() || atomLink(b);
    const title = tag(b, "title");
    if (!link || !title) continue;
    const body =
      tag(b, "content:encoded") ??
      tag(b, "content") ??
      tag(b, "description") ??
      tag(b, "summary") ??
      "";
    out.push({
      title: stripTags(title),
      link: link.trim(),
      published: toIso(
        tag(b, "pubDate") ?? tag(b, "published") ?? tag(b, "updated") ?? tag(b, "dc:date"),
      ),
      text: stripTags(body),
    });
  }
  return out;
}

// Splits prose into sentences without a tokenizer: enough for picking the one that holds a figure.
export function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z"\u201c(])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20);
}
