import { describe, expect, test } from "vitest";
import { escapeHtml } from "../../src/lib/html";

test("escapeHtml neutralises markup and quotes from upstream names", () => {
  expect(escapeHtml(`<img src=x onerror="alert('1')">`)).toBe(
    "&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;",
  );
  expect(escapeHtml("Fish & Chips")).toBe("Fish &amp; Chips");
  expect(escapeHtml(null)).toBe("");
  expect(escapeHtml(42)).toBe("42");
});

describe("fetching a documentation table", () => {
  test("a page without the table is fetched once more, fresh, before giving up", async () => {
    const { fetchTable } = await import("../../pipeline/html");
    const good =
      "<table><tr><th>Zones</th><th>Location</th></tr>" +
      "<tr><td>a</td><td>b</td></tr>".repeat(40) +
      "</table>";
    const calls: { url: string; fresh: boolean }[] = [];
    let served = 0;
    const page = async (url: string, extra?: { fresh?: boolean }) => {
      calls.push({ url, fresh: !!extra?.fresh });
      return { body: served++ === 0 ? "<html><body>moved</body></html>" : good };
    };
    const table = await fetchTable(
      page,
      "https://example.test/zones",
      ["zones", "location"],
      30,
      "zones table",
      0,
    );
    expect(table).toHaveLength(41);
    expect(calls).toEqual([
      { url: "https://example.test/zones", fresh: false },
      { url: "https://example.test/zones", fresh: true },
    ]);
    await expect(
      fetchTable(
        async () => ({ body: "<p>nothing</p>" }),
        "https://example.test/zones",
        ["zones"],
        30,
        "zones table",
        0,
      ),
    ).rejects.toThrow("zones table missing or too short");
  });
});
