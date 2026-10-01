import { address } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import type { Network } from "../../../shared/contracts";
import type {
  WalletPortfolioAsset,
  WalletPortfolioReport,
} from "../../../shared/wallet-portfolio";
import { runWithConcurrency } from "../airship/concurrency";

const WALLET_SCAN_CONCURRENCY = 6;
const DAS_PAGE_SIZE = 1_000;

export function parseWalletPortfolioNetwork(value: unknown): Network {
  if (value !== "devnet" && value !== "mainnet") throw new Error("Network must be devnet or mainnet");
  return value;
}

interface DasAsset {
  id: string;
  interface?: string;
  content?: { metadata?: { name?: string; symbol?: string } };
  token_info?: {
    balance?: string | number;
    decimals?: number;
    symbol?: string;
    token_program?: string;
  };
}

interface DasOwnerPage {
  items: DasAsset[];
  nativeBalance?: { lamports?: string | number };
}

interface JsonRpcResponse<T> {
  result?: T;
  error?: { message?: string };
}

interface MutableAsset {
  kind: WalletPortfolioAsset["kind"];
  mint?: string;
  name: string;
  symbol: string;
  decimals: number;
  tokenProgram?: WalletPortfolioAsset["tokenProgram"];
  total: bigint;
  wallets: Map<string, bigint>;
}

export async function scanManagedWalletPortfolio(
  rpcUrl: string,
  network: Network,
  walletAddresses: readonly string[],
): Promise<WalletPortfolioReport> {
  const wallets = walletAddresses.map((value) => String(address(value)));
  const results: Array<{ address: string; holdings: WalletHolding[] } | null> = Array(wallets.length).fill(null);
  const failedWallets: WalletPortfolioReport["failedWallets"] = [];

  await runWithConcurrency(wallets.length, WALLET_SCAN_CONCURRENCY, async (index) => {
    const walletAddress = wallets[index]!;
    try {
      results[index] = { address: walletAddress, holdings: await scanWallet(rpcUrl, walletAddress) };
    } catch (reason) {
      failedWallets.push({
        address: walletAddress,
        error: reason instanceof Error ? reason.message : "Wallet scan failed",
      });
    }
  });

  return {
    network,
    scannedAt: new Date().toISOString(),
    managedWalletCount: wallets.length,
    scannedWalletCount: results.filter(Boolean).length,
    failedWallets: failedWallets.sort((a, b) => a.address.localeCompare(b.address)),
    assets: aggregateHoldings(results.filter((result): result is NonNullable<typeof result> => Boolean(result))),
  };
}

interface WalletHolding {
  kind: WalletPortfolioAsset["kind"];
  mint?: string;
  name: string;
  symbol: string;
  decimals: number;
  tokenProgram?: WalletPortfolioAsset["tokenProgram"];
  balance: bigint;
}

async function scanWallet(rpcUrl: string, ownerAddress: string): Promise<WalletHolding[]> {
  const holdings: WalletHolding[] = [];
  let page = 1;
  let nativeAdded = false;

  while (true) {
    const result = await heliusDasCall<DasOwnerPage>(rpcUrl, "getAssetsByOwner", {
      ownerAddress,
      page,
      limit: DAS_PAGE_SIZE,
      displayOptions: {
        showFungible: true,
        showNativeBalance: true,
        showZeroBalance: false,
      },
    });

    if (!nativeAdded) {
      const lamports = parseBaseUnits(result.nativeBalance?.lamports ?? "0", "native SOL balance");
      if (lamports > 0n) {
        holdings.push({ kind: "native", name: "Solana", symbol: "SOL", decimals: 9, balance: lamports });
      }
      nativeAdded = true;
    }

    for (const item of result.items) {
      if (item.interface !== "FungibleToken" && item.interface !== "FungibleAsset") continue;
      const balance = parseBaseUnits(item.token_info?.balance ?? "0", `balance for ${item.id}`);
      if (balance <= 0n) continue;
      const mint = String(address(item.id));
      const tokenProgram = item.token_info?.token_program === TOKEN_2022_PROGRAM_ADDRESS
        ? "token2022"
        : item.token_info?.token_program === TOKEN_PROGRAM_ADDRESS
          ? "classic"
          : undefined;
      holdings.push({
        kind: "token",
        mint,
        name: item.content?.metadata?.name?.trim() || item.token_info?.symbol?.trim() || "Unnamed token",
        symbol: item.content?.metadata?.symbol?.trim() || item.token_info?.symbol?.trim() || shortAddress(mint),
        decimals: validDecimals(item.token_info?.decimals),
        tokenProgram,
        balance,
      });
    }

    if (result.items.length < DAS_PAGE_SIZE) break;
    page += 1;
  }

  return holdings;
}

function aggregateHoldings(
  walletResults: ReadonlyArray<{ address: string; holdings: WalletHolding[] }>,
): WalletPortfolioAsset[] {
  const assets = new Map<string, MutableAsset>();
  for (const result of walletResults) {
    for (const holding of result.holdings) {
      const key = holding.kind === "native" ? "native:sol" : `token:${holding.mint}`;
      const existing = assets.get(key) ?? {
        kind: holding.kind,
        mint: holding.mint,
        name: holding.name,
        symbol: holding.symbol,
        decimals: holding.decimals,
        tokenProgram: holding.tokenProgram,
        total: 0n,
        wallets: new Map(),
      };
      existing.total += holding.balance;
      existing.wallets.set(result.address, (existing.wallets.get(result.address) ?? 0n) + holding.balance);
      assets.set(key, existing);
    }
  }

  return [...assets.values()]
    .map((asset) => ({
      kind: asset.kind,
      ...(asset.mint ? { mint: asset.mint } : {}),
      name: asset.name,
      symbol: asset.symbol,
      decimals: asset.decimals,
      ...(asset.tokenProgram ? { tokenProgram: asset.tokenProgram } : {}),
      totalBaseUnits: asset.total.toString(),
      wallets: [...asset.wallets.entries()].map(([address, balance]) => ({
        address,
        balanceBaseUnits: balance.toString(),
      })).sort((a, b) => {
        const balanceOrder = compareBigInts(BigInt(b.balanceBaseUnits), BigInt(a.balanceBaseUnits));
        return balanceOrder || a.address.localeCompare(b.address);
      }),
    }))
    .sort((a, b) => a.kind === b.kind
      ? a.symbol.localeCompare(b.symbol) || a.name.localeCompare(b.name) || (a.mint ?? "").localeCompare(b.mint ?? "")
      : a.kind === "native" ? -1 : 1);
}

async function heliusDasCall<T>(rpcUrl: string, method: string, params: Record<string, unknown>): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "wallet-portfolio", method, params }),
  });
  const body = (await response.json()) as JsonRpcResponse<T>;
  if (!response.ok || body.error || body.result === undefined) {
    throw new Error(body.error?.message ?? `Helius ${method} request failed (${response.status})`);
  }
  return body.result;
}

function parseBaseUnits(value: string | number, label: string): bigint {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`Helius returned an inexact ${label}`);
  }
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new Error(`Helius returned an invalid ${label}`);
  return BigInt(text);
}

function validDecimals(value: number | undefined): number {
  return Number.isSafeInteger(value) && value! >= 0 && value! <= 255 ? value! : 0;
}

function compareBigInts(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function shortAddress(value: string): string {
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
