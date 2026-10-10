import { expect, test } from "vitest";
import { escapeHtml } from "../../src/lib/html";

test("escapeHtml neutralises markup and quotes from upstream names", () => {
  expect(escapeHtml(`<img src=x onerror="alert('1')">`)).toBe(
    "&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;",
  );
  expect(escapeHtml("Fish & Chips")).toBe("Fish &amp; Chips");
  expect(escapeHtml(null)).toBe("");
  expect(escapeHtml(42)).toBe("42");
});
