import type { Network, TransactionVersion } from "./contracts";

export interface CreateLiquidityPoolRequest {
  network: Network;
  transactionVersion: TransactionVersion;
  provider: string;
  mintX: string;
  mintY: string;
  amountX: string;
  amountY: string;
  feeBps: number;
}

export type ManageLiquidityPoolRequest = {
  network: Network;
  transactionVersion: TransactionVersion;
  pool: string;
  provider: string;
  slippageBps: number;
} & (
  | { action: "add"; amountA: string; amountB: string }
  | { action: "remove"; lpAmount: string }
  | { action: "swap"; inputMint: string; amountIn: string }
);

export interface StoredLiquidityPool {
  pool: string;
  authority: string;
  mintA: string;
  mintB: string;
  tokenProgramA: string;
  tokenProgramB: string;
  vaultA: string;
  vaultB: string;
  lpMint: string;
  initializer: string;
  feeBps: number;
  network: Network;
  creationSignature: string;
  createdAt: string;
}

export interface TrackedLiquidityPool extends StoredLiquidityPool {
  tokenAName: string;
  tokenASymbol: string;
  tokenADecimals: number;
  tokenBName: string;
  tokenBSymbol: string;
  tokenBDecimals: number;
  liveStatus: "available" | "unavailable";
  reserveA?: string;
  reserveB?: string;
  lpSupply?: string;
  liveError?: string;
}

export interface LiquidityActionResult {
  signature: string;
  pool: TrackedLiquidityPool;
}
