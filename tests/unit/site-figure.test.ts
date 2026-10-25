import { expect, test } from "vitest";
import { siteFigure } from "../../src/lib/site-figure";

test("a site with only an investment figure shows dollars and does not size the marker", () => {
  const metrics = {
    investment_usd: {
      value: 648_000_000,
      claim_type: "derived",
      status: "under_construction",
    },
  };
  expect(siteFigure(metrics, "it_power_mw")).toEqual({
    text: "estimated $648M, under construction",
    sizeBy: null,
    claim: "derived",
  });
});

test("the selected power metric wins, then any power figure, then the rest", () => {
  const metrics = {
    investment_usd: { value: 2e9, claim_type: "reported", status: "announced" },
    facility_power_mw: { value: 120, claim_type: "reported", status: "operational" },
    it_power_mw: { value: 80, claim_type: "derived", status: "operational" },
  };
  expect(siteFigure(metrics, "it_power_mw")).toMatchObject({
    text: "estimated 80 MW, operational",
    sizeBy: 80,
  });
  expect(siteFigure(metrics, "facility_power_mw")).toMatchObject({
    text: "120 MW, operational",
    sizeBy: 120,
  });
  expect(siteFigure(metrics, "land_area_acres")).toMatchObject({ sizeBy: 80 });
  expect(siteFigure({}, "it_power_mw")).toEqual({
    text: "no figure",
    sizeBy: null,
    claim: "unknown",
  });
});
