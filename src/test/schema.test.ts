import { describe, expect, it } from "vitest";
import {
  getFeePayer,
  parseTransferPlan,
  PlanValidationError,
  solToLamports,
} from "../shared/schema";

const SOURCE = "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE";
const DESTINATION = "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ";

describe("transfer plan schema", () => {
  it("normalizes the recievers alias", () => {
    const result = parseTransferPlan({
      type: "share",
      senders: [{ address: SOURCE }],
      recievers: [{ address: DESTINATION, amountSol: "0.1" }],
    });
    expect(result.normalizedAlias).toBe(true);
    expect(result.plan.receivers).toHaveLength(1);
  });

  it("defaults the fee payer to the first sender", () => {
    const { plan } = parseTransferPlan({
      type: "consolidation",
      senders: [{ address: SOURCE, amountSol: "0.1" }],
      receivers: [{ address: DESTINATION }],
    });
    expect(getFeePayer(plan)).toBe(SOURCE);
  });

  it("rejects overlap and duplicate wallets", () => {
    expect(() =>
      parseTransferPlan({
        type: "share",
        senders: [{ address: SOURCE }],
        receivers: [{ address: SOURCE, amountSol: "0.1" }],
      }),
    ).toThrow(PlanValidationError);
  });

  it("converts decimal SOL without floating-point arithmetic", () => {
    expect(solToLamports("1.000000001")).toBe(1_000_000_001n);
    expect(() => solToLamports("0.0000000001")).toThrow();
  });
});
