import type { Network } from "./contracts";

export interface WalletPortfolioContribution {
  address: string;
  balanceBaseUnits: string;
}

export interface WalletPortfolioAsset {
  kind: "native" | "token";
  mint?: string;
  name: string;
  symbol: string;
  decimals: number;
  tokenProgram?: "classic" | "token2022";
  totalBaseUnits: string;
  wallets: WalletPortfolioContribution[];
}

export interface WalletPortfolioFailure {
  address: string;
  error: string;
}

export interface WalletPortfolioReport {
  network: Network;
  scannedAt: string;
  managedWalletCount: number;
  scannedWalletCount: number;
  failedWallets: WalletPortfolioFailure[];
  assets: WalletPortfolioAsset[];
}
