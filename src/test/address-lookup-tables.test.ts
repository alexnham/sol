import { describe, expect, it } from "vitest";
import { selectUsefulLookupTables } from "../server/features/address-lookup-tables/selection";

describe("address lookup table selection", () => {
  it("greedily selects the fewest high-coverage tables", () => {
    expect(selectUsefulLookupTables({
      tableA: ["one", "two", "three"],
      tableB: ["three", "four"],
      tableC: ["five"],
    }, ["one", "two", "three", "four", "five"])).toEqual({
      tableA: ["one", "two", "three"],
    });
  });

  it("skips a table that would only replace one inline address", () => {
    expect(selectUsefulLookupTables({ tableA: ["one", "unused"] }, ["one"])).toEqual({});
  });
});
