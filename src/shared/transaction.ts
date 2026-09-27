import {
  address,
  appendTransactionMessageInstructions,
  assertIsTransactionWithinSizeLimit,
  blockhash,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getTransactionSize,
  lamports,
  partiallySignTransactionWithSigners,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Transaction,
} from "@solana/kit";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import type { Preparation, SignerProvider } from "./contracts";
import { transferPlugins } from "./plugin-registry";

export type SignerProgressStatus = "signing" | "signed" | "failed";
export type SignerProgressCallback = (
  signerAddress: string,
  status: SignerProgressStatus,
  error?: string,
) => void;

export async function buildPreparedTransaction(preparation: Preparation): Promise<Transaction> {
  const plugin = transferPlugins.get(preparation.pluginId);
  const feePayer = address(preparation.feePayer);
  const userInstructions = await plugin.buildInstructions({
    plan: preparation.normalizedPlan,
    network: preparation.network,
    feePayer,
    tipAccount: preparation.tipAccount ? address(preparation.tipAccount) : undefined,
    tipLamports: BigInt(preparation.quote.senderTipLamports),
  });

  const computeInstructions =
    preparation.microLamportsPerComputeUnit > 0
      ? [
          getSetComputeUnitPriceInstruction({
            microLamports: preparation.microLamportsPerComputeUnit,
          }),
          getSetComputeUnitLimitInstruction({ units: preparation.computeUnitLimit }),
        ]
      : [];

  const uncompressedMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (value) => setTransactionMessageFeePayerSigner(createNoopSigner(feePayer), value),
    (value) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: blockhash(preparation.recentBlockhash),
          lastValidBlockHeight: BigInt(preparation.lastValidBlockHeight),
        },
        value,
      ),
    (value) => appendTransactionMessageInstructions([...computeInstructions, ...userInstructions], value),
  );

  const lookupTables = Object.fromEntries(
    Object.entries(preparation.addressLookupTables ?? {}).map(([tableAddress, addresses]) => [
      address(tableAddress),
      addresses.map((lookupAddress) => address(lookupAddress)),
    ]),
  );
  const message = Object.keys(lookupTables).length
    ? compressTransactionMessageUsingAddressLookupTables(uncompressedMessage, lookupTables)
    : uncompressedMessage;

  const transaction = compileTransaction(message);
  assertIsTransactionWithinSizeLimit(transaction);
  return transaction;
}

export async function signPreparedTransaction(
  transaction: Transaction,
  signerAddresses: readonly string[],
  provider: SignerProvider,
  onProgress?: SignerProgressCallback,
): Promise<Transaction> {
  const originalMessage = Uint8Array.from(transaction.messageBytes);
  let signed = transaction;

  for (const signerAddress of signerAddresses) {
    onProgress?.(signerAddress, "signing");
    try {
      const signer = await provider.getSigner(address(signerAddress));
      signed = await partiallySignTransactionWithSigners([signer], signed);
      if (!equalBytes(originalMessage, signed.messageBytes)) {
        throw new Error("A signer attempted to modify the transaction message");
      }
      onProgress?.(signerAddress, "signed");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Signature request failed";
      onProgress?.(signerAddress, "failed", message);
      throw reason;
    }
  }

  return signed;
}

export function encodeSignedTransaction(transaction: Transaction): string {
  return getBase64EncodedWireTransaction(transaction);
}

export function transactionSize(transaction: Transaction): number {
  return getTransactionSize(transaction);
}

function equalBytes(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export const LAMPORTS_PER_SOL = lamports(1_000_000_000n);
