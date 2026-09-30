import { describe, expect, it } from "vitest";
import { expandLookupTableReceivers } from "../server/features/address-lookup-tables/selection";
import { parseLookupTableSharePlan } from "../shared/schema";

const SOURCE = "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE";
const TABLE = "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta";
const ADDRESSES = [
  "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
  "5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn",
  "DzcSBpVniutt6w5pyuytxLUqJcWMh3mMawMmxaquLsbZ",
  "Cas5qTBtAr6kPFt1LRW431JkYzqXm2Z49XMD5xAa3wuQ",
];

describe("ALT receiver selection", () => {
  it("expands indexes and ranges in ascending order without overlap", () => {
    const input = parseLookupTableSharePlan({
      type: "share",
      senders: [{ address: SOURCE }],
      receiversFromLookupTables: [{
        address: TABLE,
        amountSol: "0.00001",
        indexes: [3, 0],
        ranges: [{ start: 1, end: 3 }],
      }],
    }).plan;

    const result = expandLookupTableReceivers(input, { [TABLE]: ADDRESSES });
    expect(result.receivers.map((receiver) => receiver.address)).toEqual(ADDRESSES);
    expect(result.addressLookupTables).toEqual([TABLE]);
  });

  it("rejects an index beyond the current table length", () => {
    const input = parseLookupTableSharePlan({
      type: "share",
      senders: [{ address: SOURCE }],
      receiversFromLookupTables: [{
        address: TABLE,
        amountSol: "0.00001",
        indexes: [4],
      }],
    }).plan;

    expect(() => expandLookupTableReceivers(input, { [TABLE]: ADDRESSES })).toThrow(
      "index 4 is out of bounds",
    );
  });
});
