import { generateKeyPairSigner } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseWalletPortfolioNetwork, scanManagedWalletPortfolio } from "../server/features/wallets/portfolio";

const WALLET_A = "DzcSBpVniutt6w5pyuytxLUqJcWMh3mMawMmxaquLsbZ";
const WALLET_B = "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ";
const MINT_A = "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta";
const MINT_B = "BApRNbirCZhPJ2uHAcesJNJCEwCz98p9o6W4f6bc4yr1";

describe("managed wallet portfolio", () => {
  afterEach(() => vi.restoreAllMocks());

  it("aggregates SOL, SPL, and Token-2022 balances exactly and sorts contributors", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { params: { ownerAddress: string } };
      const first = request.params.ownerAddress === WALLET_A;
      return rpcResponse({
        nativeBalance: { lamports: first ? "9007199254740993123" : "7" },
        items: [
          tokenAsset(MINT_A, first ? "10000000000000000001" : "9", 6, "Exact", "EX", TOKEN_PROGRAM_ADDRESS),
          ...(first ? [tokenAsset(MINT_B, "25", 2, "Next token", "NXT", TOKEN_2022_PROGRAM_ADDRESS, "FungibleAsset")] : []),
        ],
      });
    });

    const report = await scanManagedWalletPortfolio("https://rpc.example", "devnet", [WALLET_A, WALLET_B]);

    expect(report).toMatchObject({ managedWalletCount: 2, scannedWalletCount: 2, failedWallets: [] });
    expect(report.assets.map((asset) => asset.symbol)).toEqual(["SOL", "EX", "NXT"]);
    expect(report.assets[0]).toMatchObject({ kind: "native", totalBaseUnits: "9007199254740993130" });
    expect(report.assets[1]).toMatchObject({
      mint: MINT_A,
      tokenProgram: "classic",
      totalBaseUnits: "10000000000000000010",
      wallets: [
        { address: WALLET_A, balanceBaseUnits: "10000000000000000001" },
        { address: WALLET_B, balanceBaseUnits: "9" },
      ],
    });
    expect(report.assets[2]).toMatchObject({ tokenProgram: "token2022", totalBaseUnits: "25" });
  });

  it("paginates DAS results and combines repeated mint contributions from one wallet", async () => {
    const requests: number[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { params: { page: number } };
      requests.push(request.params.page);
      return rpcResponse(request.params.page === 1
        ? { nativeBalance: { lamports: "0" }, items: Array.from({ length: 1_000 }, () => tokenAsset(MINT_A, "1", 0, "Paged", "PAGE", TOKEN_PROGRAM_ADDRESS)) }
        : { nativeBalance: { lamports: "0" }, items: [tokenAsset(MINT_A, "2", 0, "Paged", "PAGE", TOKEN_PROGRAM_ADDRESS)] });
    });

    const report = await scanManagedWalletPortfolio("https://rpc.example", "mainnet", [WALLET_A]);

    expect(requests).toEqual([1, 2]);
    expect(report.assets[0]).toMatchObject({ totalBaseUnits: "1002", wallets: [{ address: WALLET_A, balanceBaseUnits: "1002" }] });
  });

  it("keeps successful empty wallets when another wallet fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { params: { ownerAddress: string } };
      return request.params.ownerAddress === WALLET_B
        ? rpcResponse(undefined, { message: "rate limited" })
        : rpcResponse({ nativeBalance: { lamports: "0" }, items: [] });
    });

    const report = await scanManagedWalletPortfolio("https://rpc.example", "devnet", [WALLET_A, WALLET_B]);

    expect(report).toMatchObject({ managedWalletCount: 2, scannedWalletCount: 1, assets: [] });
    expect(report.failedWallets).toEqual([{ address: WALLET_B, error: "rate limited" }]);
  });

  it("runs no more than six wallet requests concurrently", async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, async () => String((await generateKeyPairSigner()).address)));
    let active = 0;
    let maximum = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return rpcResponse({ nativeBalance: { lamports: "0" }, items: [] });
    });

    await scanManagedWalletPortfolio("https://rpc.example", "devnet", wallets);

    expect(maximum).toBe(6);
  });

  it("rejects an invalid portfolio network before reading RPC configuration", () => {
    expect(() => parseWalletPortfolioNetwork("testnet")).toThrow("Network must be devnet or mainnet");
    expect(parseWalletPortfolioNetwork("devnet")).toBe("devnet");
  });
});

function tokenAsset(
  id: string,
  balance: string,
  decimals: number,
  name: string,
  symbol: string,
  tokenProgram: string,
  assetInterface = "FungibleToken",
) {
  return {
    id,
    interface: assetInterface,
    content: { metadata: { name, symbol } },
    token_info: { balance, decimals, symbol, token_program: tokenProgram },
  };
}

function rpcResponse(result?: unknown, error?: { message: string }): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ jsonrpc: "2.0", ...(error ? { error } : { result }) }),
  } as Response;
}
