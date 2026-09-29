import { describe, expect, it } from "vitest";
import type { ConsolidationPlan } from "../shared/contracts";
import { splitConsolidationPlan } from "../server/prepare";

const receiver = "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ";
const senders = [
  "DzcSBpVniutt6w5pyuytxLUqJcWMh3mMawMmxaquLsbZ",
  "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta",
  "BApRNbirCZhPJ2uHAcesJNJCEwCz98p9o6W4f6bc4yr1",
  "8rb5FTPT3A8HBaYtDAbzduBZsYi18sRy7cyJmuD5AUT4",
  "4yPAtNZ4GRPaFf183evdnKBgL8GRd4vno32P3P8LHUh1",
];

function plan(feePayer?: string): ConsolidationPlan {
  return {
    type: "consolidation",
    senders: senders.map((address) => ({ address, amountSol: "0.001" })),
    receivers: [{ address: receiver }],
    ...(feePayer ? { feePayer } : {}),
  };
}

describe("consolidation signature batching", () => {
  it("splits implicit-fee-payer consolidations at the selected signature count", () => {
    expect(splitConsolidationPlan(plan(), 2).map((batch) => batch.senders.length)).toEqual([2, 2, 1]);
  });

  it("reserves a signature for an explicit fee payer outside a batch", () => {
    expect(splitConsolidationPlan(plan(senders[0]), 2).map((batch) => batch.senders.length)).toEqual([2, 1, 1, 1]);
  });

  it("rejects a one-signature batch when a separate fee payer must also sign", () => {
    expect(() => splitConsolidationPlan(plan(senders[0]), 1)).toThrow(/At least 2 signatures/);
  });
});
