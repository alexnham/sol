import { generateKeyPairSigner } from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAddressLookupTable } from "../server/create-address-lookup-table";

afterEach(() => vi.restoreAllMocks());

describe("address lookup table creation", () => {
  it("creates, extends, confirms, and activates a table", async () => {
    const authority = await generateKeyPairSigner();
    const entries = await Promise.all(Array.from({ length: 31 }, () => generateKeyPairSigner()));
    let sent = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { method: string };
      let result: unknown;
      switch (request.method) {
        case "getSlot": result = sent === 0 ? 100 : 102; break;
        case "getLatestBlockhash": result = {
          value: {
            blockhash: "11111111111111111111111111111111",
            lastValidBlockHeight: 1_000,
          },
        }; break;
        case "sendTransaction": sent += 1; result = `signature-${sent}`; break;
        case "getSignatureStatuses": result = {
          value: [{ slot: 101, err: null, confirmationStatus: "confirmed" }],
        }; break;
        default: throw new Error(`Unexpected RPC method ${request.method}`);
      }
      return { ok: true, json: async () => ({ jsonrpc: "2.0", result }) } as Response;
    });

    const result = await createAddressLookupTable(
      "https://example.invalid",
      "devnet",
      authority,
      entries.map((entry) => entry.address),
    );

    expect(result.authority).toBe(authority.address);
    expect(result.addressCount).toBe(31);
    expect(result.signatures).toEqual(["signature-1", "signature-2"]);
    expect(result.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
  });

  it("rejects table sizes that cannot help or exceed capacity", async () => {
    const authority = await generateKeyPairSigner();
    await expect(createAddressLookupTable(
      "https://example.invalid",
      "devnet",
      authority,
      [authority.address],
    )).rejects.toThrow("between 2 and 256");
  });
});
