import { afterEach, describe, expect, it, vi } from "vitest";
import { economyAdapter } from "@solana-workbench/delivery-economy";
import {
  CUSTOM_DISTRIBUTOR_PROGRAM_ID_DEVNET,
  customAdapter,
} from "@solana-workbench/delivery-custom";
import { fastAdapter, FAST_TIP_LAMPORTS } from "@solana-workbench/delivery-fast";
import { maxAdapter, MAX_TIP_LAMPORTS } from "@solana-workbench/delivery-max";
import { rpcCall, waitForConfirmation, type DeliveryQuoteContext } from "@solana-workbench/delivery-sdk";

afterEach(() => {
  vi.restoreAllMocks();
});

const context: DeliveryQuoteContext = {
  network: "mainnet",
  preset: "fast",
  transactionVersion: 0,
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

  it("provides the devnet custom distributor route", async () => {
    const quote = await customAdapter.quote({ ...context, preset: "custom" });
    expect(customAdapter.supports("devnet")).toBe(true);
    expect(customAdapter.supports("mainnet")).toBe(false);
    expect(quote.priorityFeeLamports).toBe("0");
    expect(CUSTOM_DISTRIBUTOR_PROGRAM_ID_DEVNET).toBe(
      "7wRVHVQwGKkrQ4DA4auS5BtwkCgcQuSwcPtTpzFBu3bf",
    );
  });

  it("retries an HTTP 429 response using Retry-After", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("rate limited", {
        status: 429,
        headers: { "Retry-After": "0" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: "2.0", result: 42 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));

    await expect(rpcCall<number>("https://rpc.example", "getSlot")).resolves.toBe(42);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent transaction confirmations into one status poll", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { method: string; params: [string[]] };
      expect(request.method).toBe("getSignatureStatuses");
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        result: {
          value: request.params[0].map(() => ({ err: null, confirmationStatus: "confirmed" })),
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    await expect(Promise.all([
      waitForConfirmation("https://rpc.example", "signature-one", 1_000n),
      waitForConfirmation("https://rpc.example", "signature-two", 1_000n),
      waitForConfirmation("https://rpc.example", "signature-three", 1_000n),
    ])).resolves.toEqual(["confirmed", "confirmed", "confirmed"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as { params: [string[]] };
    expect(request.params[0]).toEqual(["signature-one", "signature-two", "signature-three"]);
  });
});
