import type { Network } from "./contracts";

export interface AirshipToken {
  mint: string;
  name: string;
  symbol: string;
  decimals: number;
  balanceBaseUnits: string;
  tokenProgram: "classic" | "token2022";
  supported: boolean;
}

export interface AirshipCompressedBalance {
  mint: string;
  decimals: number;
  balanceBaseUnits: string;
  accountCount: number;
}

export interface AirshipCompressedBalanceReport {
  owner: string;
  balances: AirshipCompressedBalance[];
  accountCount: number;
}

export interface DecompressAirshipTokensRequest {
  network: Network;
  owner: string;
  mint: string;
  amount: string;
  mainnetConfirmed: boolean;
}

export interface AirshipDecompressionResult {
  network: Network;
  owner: string;
  mint: string;
  amountBaseUnits: string;
  destinationTokenAccount: string;
  signature: string;
}

export interface CreateAirshipDropRequest {
  network: Network;
  delivery: "airship" | "standard";
  sender: string;
  mint: string;
  recipients: string[];
  amountPerRecipient: string;
  mainnetConfirmed: boolean;
}

export type AirshipDropState = "queued" | "preparing" | "sending" | "confirmed" | "failed";

export interface AirshipDropJob {
  id: string;
  network: Network;
  delivery: "airship" | "standard";
  sender: string;
  mint: string;
  symbol: string;
  decimals: number;
  recipientCount: number;
  amountPerRecipientBaseUnits: string;
  totalAmountBaseUnits: string;
  totalTransactions: number;
  sentTransactions: number;
  confirmedTransactions: number;
  state: AirshipDropState;
  signatures: string[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TokenCollectionSourceInput {
  owner: string;
  amount?: string;
}

export interface PreviewTokenCollectionRequest {
  network: Network;
  destination: string;
  mint: string;
  sources: TokenCollectionSourceInput[];
}

export interface TokenCollectionPreviewSource {
  owner: string;
  tokenAccount: string;
  balanceBaseUnits: string;
  balance: string;
  amountBaseUnits: string;
  amount: string;
  rentLamports: string;
  willClose: boolean;
  eligible: boolean;
  reason?: string;
}

export interface TokenCollectionPreview {
  network: Network;
  destination: string;
  destinationTokenAccount: string;
  mint: string;
  decimals: number;
  tokenProgram: "classic" | "token2022";
  sources: TokenCollectionPreviewSource[];
  eligibleSourceCount: number;
  closeableAccountCount: number;
  totalAmountBaseUnits: string;
  reclaimedRentLamports: string;
  estimatedTransactions: number;
  estimatedFeeLamports: string;
}

export interface CreateTokenCollectionRequest extends PreviewTokenCollectionRequest {
  mainnetConfirmed: boolean;
}

export type TokenCollectionState = "queued" | "preparing" | "sending" | "confirmed" | "failed";

export interface TokenCollectionJob {
  id: string;
  network: Network;
  destination: string;
  destinationTokenAccount: string;
  mint: string;
  decimals: number;
  tokenProgram: "classic" | "token2022";
  sourceCount: number;
  excludedSources: TokenCollectionPreviewSource[];
  totalAmountBaseUnits: string;
  totalTransactions: number;
  sentTransactions: number;
  confirmedTransactions: number;
  closedAccounts: number;
  reclaimedRentLamports: string;
  state: TokenCollectionState;
  signatures: string[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}
