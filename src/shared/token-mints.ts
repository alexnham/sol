import type { Network, TransactionVersion } from "./contracts";

export interface CreateTokenMintRequest {
  network: Network;
  transactionVersion: TransactionVersion;
  name: string;
  symbol: string;
  decimals: number;
  initialSupply: string;
  mintAuthority: string;
  freezeAuthority?: string | null;
  revokeMintAuthority: boolean;
  revokeFreezeAuthority: boolean;
  mainnetConfirmed?: boolean;
  tokenProgram?: "classic" | "token2022";
  metadataUri?: string;
  imageUrl?: string;
}

export interface StoredTokenMint {
  mint: string;
  associatedTokenAccount?: string;
  name: string;
  symbol: string;
  decimals: number;
  initialSupplyBaseUnits: string;
  network: Network;
  transactionVersion: TransactionVersion;
  mintAuthorityAtCreation: string;
  freezeAuthorityAtCreation: string | null;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  creationSignature: string;
  createdAt: string;
  tokenProgram?: "classic" | "token2022";
  metadataUri?: string;
  imageUrl?: string;
}

export interface TrackedTokenMint extends StoredTokenMint {
  liveStatus: "available" | "unavailable";
  supplyBaseUnits?: string;
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  liveError?: string;
  metadataUpdateAuthority?: string | null;
}

export type ManageTokenMintRequest = {
  network: Network;
  transactionVersion: TransactionVersion;
  mint: string;
  mainnetConfirmed?: boolean;
} & (
  | { action: "update-local"; name: string; symbol: string; metadataUri?: string; imageUrl?: string }
  | { action: "update-metadata"; name: string; symbol: string; metadataUri: string; imageUrl?: string }
  | { action: "mint"; amount: string; recipient: string }
  | { action: "transfer"; amount: string; owner: string; recipient: string }
  | { action: "burn"; amount: string; owner: string }
  | { action: "set-mint-authority"; newAuthority: string | null }
  | { action: "set-freeze-authority"; newAuthority: string | null }
  | { action: "set-metadata-authority"; newAuthority: string | null }
  | { action: "freeze" | "thaw"; owner: string }
);

export interface TokenMintActionResult {
  signature?: string;
  token: TrackedTokenMint;
}

export const MAX_U64 = 0xffff_ffff_ffff_ffffn;

export function decimalAmountToBaseUnits(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 9) {
    throw new Error("Decimals must be an integer between 0 and 9");
  }
  const normalized = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    throw new Error("Initial supply must be a non-negative decimal number");
  }
  const [whole, fraction = ""] = normalized.split(".");
  if (fraction.length > decimals) {
    throw new Error(`Initial supply supports at most ${decimals} fractional digits`);
  }
  const baseUnits = BigInt(whole!) * 10n ** BigInt(decimals) +
    BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
  if (baseUnits > MAX_U64) throw new Error("Initial supply exceeds the SPL Token u64 limit");
  return baseUnits;
}

export function formatBaseUnits(value: string, decimals: number): string {
  const raw = BigInt(value);
  if (decimals === 0) return raw.toString();
  const padded = raw.toString().padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}
