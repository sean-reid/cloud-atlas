import { describe, expect, test } from "vitest";
import { earliestOpened } from "../../shared/dates";
import type { DatePrecision } from "../../shared/types";

const at = (effective_date: string, effective_precision: DatePrecision) => ({
  effective_date,
  effective_precision,
});

describe("earliest opened date", () => {
  test("nothing dated gives null", () => {
    expect(earliestOpened([])).toBeNull();
  });

  test("inside one year the finest precision wins over the shorter string", () => {
    expect(earliestOpened([at("2012", "year"), at("2012-06-07", "day")])).toEqual(
      at("2012-06-07", "day"),
    );
    expect(earliestOpened([at("2012-06-07", "day"), at("2012", "year")])).toEqual(
      at("2012-06-07", "day"),
    );
    expect(earliestOpened([at("2012-06", "month"), at("2012-06-07", "day")])).toEqual(
      at("2012-06-07", "day"),
    );
  });

  test("an earlier year wins whatever its precision", () => {
    expect(earliestOpened([at("2012-01-01", "day"), at("2011", "year")])).toEqual(
      at("2011", "year"),
    );
  });

  test("at equal precision the earliest date wins", () => {
    expect(earliestOpened([at("2012-06-07", "day"), at("2012-03-01", "day")])).toEqual(
      at("2012-03-01", "day"),
    );
  });
});
