import {
  appendTransactionMessageInstructions,
  assertIsTransactionWithinSizeLimit,
  compileTransaction,
  createSolanaRpc,
  createTransactionMessage,
  estimateResourceLimitsFactory,
  pipe,
  setTransactionMessageComputeUnitLimit,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageLoadedAccountsDataSizeLimit,
  setTransactionMessagePriorityFeeLamports,
  type Instruction,
  type Transaction,
  type TransactionBlockhashLifetime,
  type TransactionMessage,
  type TransactionMessageWithFeePayer,
  type TransactionSigner,
} from "@solana/kit";

export const V1_TRANSACTION_SIZE_LIMIT = 4_096;
export const V1_MAX_ACCOUNTS = 64;
export const V1_MAX_INSTRUCTIONS = 64;
export const V1_MAX_COMPUTE_UNIT_LIMIT = 1_400_000;
export const V1_MAX_LOADED_ACCOUNTS_DATA_SIZE_LIMIT = 64 * 1024 * 1024;

const COMPUTE_BUDGET_PROGRAM_ADDRESS = "ComputeBudget111111111111111111111111111111";

export type V1TransactionMessage = Extract<TransactionMessage, { version: 1 }> &
  TransactionMessageWithFeePayer;

export interface V1TransactionConfig {
  computeUnitLimit: number;
  loadedAccountsDataSizeLimit: number;
  priorityFeeLamports: bigint;
}

export interface BuildV1TransactionInput {
  feePayer: TransactionSigner;
  lifetime: TransactionBlockhashLifetime;
  instructions: readonly Instruction[];
  config: V1TransactionConfig;
}

export interface V1ResourceLimits {
  computeUnitLimit: number;
  loadedAccountsDataSizeLimit: number;
}

export function buildV1TransactionMessage(input: BuildV1TransactionInput): V1TransactionMessage {
  validateV1Instructions(input.instructions);
  validateV1Config(input.config);

  return pipe(
    createTransactionMessage({ version: 1 }),
    (message) => setTransactionMessageFeePayerSigner(input.feePayer, message),
    (message) => setTransactionMessageLifetimeUsingBlockhash(input.lifetime, message),
    (message) => appendTransactionMessageInstructions(input.instructions, message),
    (message) => setTransactionMessageComputeUnitLimit(input.config.computeUnitLimit, message),
    (message) =>
      setTransactionMessageLoadedAccountsDataSizeLimit(
        input.config.loadedAccountsDataSizeLimit,
        message,
      ),
    (message) =>
      setTransactionMessagePriorityFeeLamports(input.config.priorityFeeLamports, message),
  );
}

export function buildV1Transaction(input: BuildV1TransactionInput): Transaction {
  const transaction = compileTransaction(buildV1TransactionMessage(input));
  assertIsTransactionWithinSizeLimit(transaction);
  return transaction;
}

export async function estimateV1ResourceLimits(
  message: V1TransactionMessage,
  rpcUrl: string,
): Promise<V1ResourceLimits> {
  const estimate = await estimateResourceLimitsFactory({ rpc: createSolanaRpc(rpcUrl) })(message, {
    commitment: "confirmed",
  });
  return {
    computeUnitLimit: estimate.computeUnitLimit,
    loadedAccountsDataSizeLimit: estimate.loadedAccountsDataSizeLimit!,
  };
}

export function validateV1Instructions(instructions: readonly Instruction[]): void {
  if (instructions.length > V1_MAX_INSTRUCTIONS) {
    throw new Error(`A v1 transaction supports at most ${V1_MAX_INSTRUCTIONS} instructions`);
  }
  if (instructions.some((instruction) => instruction.programAddress === COMPUTE_BUDGET_PROGRAM_ADDRESS)) {
    throw new Error("v1 resource limits must use transaction config, not Compute Budget instructions");
  }
}

function validateV1Config(config: V1TransactionConfig): void {
  if (!Number.isInteger(config.computeUnitLimit) || config.computeUnitLimit < 1 ||
      config.computeUnitLimit > V1_MAX_COMPUTE_UNIT_LIMIT) {
    throw new RangeError("Invalid v1 compute unit limit");
  }
  if (!Number.isInteger(config.loadedAccountsDataSizeLimit) ||
      config.loadedAccountsDataSizeLimit < 1 ||
      config.loadedAccountsDataSizeLimit > V1_MAX_LOADED_ACCOUNTS_DATA_SIZE_LIMIT) {
    throw new RangeError("Invalid v1 loaded accounts data size limit");
  }
  if (config.priorityFeeLamports < 0n || config.priorityFeeLamports > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError("Invalid v1 priority fee");
  }
}
