import { afterEach, describe, expect, it, vi } from "vitest";
import { getTokenProgramAccountsByMint } from "../server/features/airship";

describe("Airship token account discovery", () => {
  afterEach(() => vi.restoreAllMocks());

  it("paginates getProgramAccountsV2 until Helius returns a null cursor", async () => {
    const requests: Array<{ method: string; params: unknown[] }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      requests.push(request);
      const config = request.params[1] as { paginationKey?: string };
      const result = config.paginationKey
        ? { accounts: [{ pubkey: "account-2", account: { lamports: 2, data: {} } }], paginationKey: null }
        : { accounts: [{ pubkey: "account-1", account: { lamports: 1, data: {} } }], paginationKey: "next-page" };
      return { ok: true, json: async () => ({ jsonrpc: "2.0", result }) } as Response;
    });

    const accounts = await getTokenProgramAccountsByMint("https://rpc.example", "token-program", "mint");

    expect(accounts.map((account) => account.pubkey)).toEqual(["account-1", "account-2"]);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      method: "getProgramAccountsV2",
      params: ["token-program", { encoding: "jsonParsed", limit: 1_000, filters: [{ memcmp: { offset: 0, bytes: "mint" } }] }],
    });
    expect(requests[1]!.params[1]).toMatchObject({ paginationKey: "next-page" });
  });

  it("falls back to legacy getProgramAccounts when the RPC does not support V2", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ jsonrpc: "2.0", error: { code: -32601, message: "Method not found" } }),
    } as Response);
    const fallback = vi.fn().mockResolvedValue([
      { pubkey: "legacy-account", account: { lamports: 1n, data: {} } },
    ]);

    const accounts = await getTokenProgramAccountsByMint(
      "https://rpc.example",
      "token-program",
      "mint",
      fallback,
    );

    expect(accounts).toHaveLength(1);
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("stops if an RPC repeats a pagination cursor", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ jsonrpc: "2.0", result: { accounts: [], paginationKey: "stuck" } }),
    } as Response);

    await expect(getTokenProgramAccountsByMint("https://rpc.example", "token-program", "mint"))
      .rejects.toThrow("repeated a pagination key");
  });
});
