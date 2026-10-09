// Minimal, deterministic table extraction for documentation pages. Not a general HTML
// parser: it handles the plain <table><tr><td> markup docs sites emit.
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "\u2013",
  mdash: "\u2014",
};

export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}

export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

export function tables(html: string): string[][][] {
  const out: string[][][] = [];
  for (const t of html.matchAll(/<table\b[\s\S]*?<\/table>/gi)) {
    const rows: string[][] = [];
    for (const r of t[0].matchAll(/<tr\b[\s\S]*?<\/tr>/gi)) {
      const cells = [...r[0].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) =>
        stripTags(c[1] ?? ""),
      );
      if (cells.length) rows.push(cells);
    }
    if (rows.length) out.push(rows);
  }
  return out;
}

// Finds the table whose header row contains every given column label.
export function tableWithColumns(html: string, labels: readonly string[]): string[][] | null {
  for (const rows of tables(html)) {
    const header = rows[0]?.map((h) => h.toLowerCase()) ?? [];
    if (labels.every((l) => header.some((h) => h.includes(l.toLowerCase())))) return rows;
  }
  return null;
}

export function columnIndex(header: readonly string[], label: string): number {
  const i = header.findIndex((h) => h.toLowerCase().includes(label.toLowerCase()));
  if (i < 0) throw new Error(`column ${label} missing from table`);
  return i;
}
