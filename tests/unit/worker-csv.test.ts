import { describe, expect, test } from "vitest";
import { csvCell } from "../../worker/csv";

describe("csvCell", () => {
  test("quotes separators and doubles embedded quotes", () => {
    expect(csvCell("Abilene, TX")).toBe('"Abilene, TX"');
    expect(csvCell('the "Stargate" site')).toBe('"the ""Stargate"" site"');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });
  test("neutralises cells a spreadsheet would run as formulas", () => {
    expect(csvCell('=HYPERLINK("https://evil.example","click")')).toBe(
      '"\'=HYPERLINK(""https://evil.example"",""click"")"',
    );
    expect(csvCell("+1 (555) 000")).toBe("'+1 (555) 000");
    expect(csvCell("-cmd|' /C calc'!A0")).toBe("'-cmd|' /C calc'!A0");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\t=1+1")).toBe("'\t=1+1");
  });
  test("numbers stay numbers, including negative coordinates", () => {
    expect(csvCell(-73.98)).toBe("-73.98");
    expect(csvCell(0)).toBe("0");
    expect(csvCell(NaN)).toBe("");
  });
});
