import type {
  Address,
  Instruction,
  Transaction,
  TransactionPartialSigner,
} from "@solana/kit";
import type {
  DeliveryAdapter,
  DeliveryPreset,
  DeliveryQuoteContext,
  DeliverySubmitContext,
  Network,
  SubmissionResult,
  TransactionQuote,
} from "@solana-workbench/delivery-sdk";

export type {
  DeliveryAdapter,
  DeliveryPreset,
  DeliveryQuoteContext,
  DeliverySubmitContext,
  Network,
  SubmissionResult,
  TransactionQuote,
} from "@solana-workbench/delivery-sdk";

export type TransferType = "share" | "consolidation";

export interface WalletAddress {
  address: string;
}

export interface WalletAmount extends WalletAddress {
  amountSol: string;
}

export interface SharePlan {
  type: "share";
  senders: [WalletAddress];
  receivers: WalletAmount[];
  feePayer?: string;
  plugin?: string;
}

export interface ConsolidationPlan {
  type: "consolidation";
  senders: WalletAmount[];
  receivers: [WalletAddress];
  feePayer?: string;
  plugin?: string;
}

export type TransferPlan = SharePlan | ConsolidationPlan;

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export interface TransferContext {
  plan: TransferPlan;
  network: Network;
}

export interface BuildContext extends TransferContext {
  feePayer: Address;
  tipAccount?: Address;
  tipLamports: bigint;
}

export interface TransferPlugin {
  id: string;
  label: string;
  supports(plan: TransferPlan, network: Network): boolean;
  validate(context: TransferContext): ValidationResult;
  buildInstructions(context: BuildContext): Promise<readonly Instruction[]>;
  requiredSigners(context: TransferContext): readonly Address[];
}

export interface SignerProvider {
  id: string;
  getSigner(address: Address): Promise<TransactionPartialSigner>;
}

export interface Preparation {
  preparationId: string;
  network: Network;
  preset: DeliveryPreset;
  pluginId: string;
  normalizedPlan: TransferPlan;
  normalizedAlias: boolean;
  feePayer: string;
  requiredSigners: string[];
  recentBlockhash: string;
  lastValidBlockHeight: string;
  computeUnitLimit: number;
  microLamportsPerComputeUnit: number;
  tipAccount?: string;
  quote: TransactionQuote;
  balances: Record<string, string>;
  expiresAtBlockHeight: string;
}

export interface PrepareRequest {
  plan: unknown;
  network: Network;
  preset: DeliveryPreset;
  pluginId?: string;
}

export interface SubmitRequest {
  preparationId: string;
  transaction: string;
}

export interface PluginCatalog {
  transfer: Array<{ id: string; label: string }>;
  delivery: Array<{
    id: string;
    label: string;
    speed: TransactionQuote["speed"];
    supportsDevnet: boolean;
    supportsMainnet: boolean;
  }>;
}

export type SignedTransaction = Transaction;
