import { describe, expect, it } from "vitest";
import { economyAdapter } from "@solana-workbench/delivery-economy";
import { fastAdapter, FAST_TIP_LAMPORTS } from "@solana-workbench/delivery-fast";
import { maxAdapter, MAX_TIP_LAMPORTS } from "@solana-workbench/delivery-max";
import type { DeliveryQuoteContext } from "@solana-workbench/delivery-sdk";

const context: DeliveryQuoteContext = {
  network: "mainnet",
  preset: "fast",
  computeUnitLimit: 100_000,
  recommendedMicroLamports: 2_000_000,
  signerCount: 2,
  transferLamports: 250_000_000n,
};

describe("delivery workspace packages", () => {
  it("keeps Economy priority-free and available on both networks", async () => {
    const quote = await economyAdapter.quote({ ...context, preset: "economy" });
    expect(economyAdapter.supports("devnet")).toBe(true);
    expect(quote.priorityFeeLamports).toBe("0");
    expect(quote.senderTipLamports).toBe("0");
  });

  it("isolates the Fast SWQOS fee policy", async () => {
    const quote = await fastAdapter.quote(context);
    expect(fastAdapter.supports("devnet")).toBe(false);
    expect(quote.priorityFeeLamports).toBe("100000");
    expect(quote.senderTipLamports).toBe(FAST_TIP_LAMPORTS.toString());
  });

  it("isolates the Sender Max fee policy", async () => {
    const quote = await maxAdapter.quote({ ...context, preset: "max" });
    expect(maxAdapter.supports("mainnet")).toBe(true);
    expect(quote.priorityFeeLamports).toBe("100000");
    expect(quote.senderTipLamports).toBe(MAX_TIP_LAMPORTS.toString());
  });
});
