import {
  generateKeyPairSigner,
  type Address,
  type TransactionPartialSigner,
} from "@solana/kit";
import { describe, expect, it } from "vitest";
import type { Preparation, SignerProvider } from "../shared/contracts";
import {
  buildPreparedTransaction,
  signPreparedTransaction,
  transactionSize,
} from "../shared/transaction";

describe("single transaction builder", () => {
  it("builds and partially signs one consolidation message", async () => {
    const first = await generateKeyPairSigner();
    const second = await generateKeyPairSigner();
    const receiver = await generateKeyPairSigner();
    const preparation = consolidationPreparation(first.address, second.address, receiver.address);
    const transaction = await buildPreparedTransaction(preparation);
    const messageBeforeSigning = Array.from(transaction.messageBytes);
    const signers = new Map<string, TransactionPartialSigner>([
      [first.address, first],
      [second.address, second],
    ]);
    const provider: SignerProvider = {
      id: "test",
      getSigner: async (signerAddress) => {
        const signer = signers.get(signerAddress);
        if (!signer) throw new Error("missing signer");
        return signer;
      },
    };

    const progress: string[] = [];
    const signed = await signPreparedTransaction(
      transaction,
      preparation.requiredSigners,
      provider,
      (signerAddress, status) => progress.push(`${signerAddress}:${status}`),
    );
    expect(Array.from(signed.messageBytes)).toEqual(messageBeforeSigning);
    expect(Object.keys(signed.signatures)).toHaveLength(2);
    expect(transactionSize(signed)).toBeLessThanOrEqual(1_232);
    expect(progress).toEqual([
      `${first.address}:signing`,
      `${first.address}:signed`,
      `${second.address}:signing`,
      `${second.address}:signed`,
    ]);
  });

  it("builds and signs a v1 share message through the existing signer flow", async () => {
    const payer = await generateKeyPairSigner();
    const receiver = await generateKeyPairSigner();
    const preparation: Preparation = {
      ...sharePreparation(payer.address, [receiver.address]),
      transactionVersion: 1,
      distributorProgramId: undefined,
      loadedAccountsDataSizeLimit: 1_000,
      addressLookupTables: {},
    };
    const transaction = await buildPreparedTransaction(preparation);
    const signed = await signPreparedTransaction(transaction, [payer.address], {
      id: "v1-test",
      getSigner: async () => payer,
    });

    expect(transaction.messageBytes[0]).toBe(0x81);
    expect(signed.signatures[payer.address]).toBeDefined();
    expect(transactionSize(signed)).toBeLessThanOrEqual(4_096);
  });

  it("rejects submission when a required signer cannot be resolved", async () => {
    const first = await generateKeyPairSigner();
    const second = await generateKeyPairSigner();
    const receiver = await generateKeyPairSigner();
    const preparation = consolidationPreparation(first.address, second.address, receiver.address);
    const transaction = await buildPreparedTransaction(preparation);
    const provider: SignerProvider = {
      id: "incomplete",
      getSigner: async (signerAddress) => {
        if (signerAddress !== first.address) throw new Error("Signer unavailable");
        return first;
      },
    };
    const progress: string[] = [];
    await expect(signPreparedTransaction(
      transaction,
      preparation.requiredSigners,
      provider,
      (signerAddress, status) => progress.push(`${signerAddress}:${status}`),
    )).rejects.toThrow("Signer unavailable");
    expect(progress.at(-1)).toBe(`${second.address}:failed`);
  });

  it("compresses eligible recipients through an address lookup table", async () => {
    const payer = await generateKeyPairSigner();
    const table = await generateKeyPairSigner();
    const receivers = await Promise.all(
      Array.from({ length: 20 }, () => generateKeyPairSigner()),
    );
    const base = sharePreparation(
      payer.address,
      receivers.map((receiver) => receiver.address),
    );
    const inline = await buildPreparedTransaction(base);
    const compressed = await buildPreparedTransaction({
      ...base,
      addressLookupTables: {
        [table.address]: receivers.map((receiver) => receiver.address),
      },
    });

    expect(transactionSize(compressed)).toBeLessThan(transactionSize(inline));
    expect(transactionSize(compressed)).toBeLessThanOrEqual(1_232);
  });
});

function sharePreparation(payer: Address, receivers: Address[]): Preparation {
  return {
    preparationId: "test-share-preparation",
    network: "devnet",
    preset: "economy",
    transactionVersion: 0,
    pluginId: "native-sol-transfer",
    distributorProgramId: "AddressLookupTab1e1111111111111111111111111",
    normalizedAlias: false,
    normalizedPlan: {
      type: "share",
      senders: [{ address: payer }],
      receivers: receivers.map((receiver) => ({ address: receiver, amountSol: "0.00001" })),
    },
    feePayer: payer,
    requiredSigners: [payer],
    recentBlockhash: "11111111111111111111111111111111",
    lastValidBlockHeight: "1000",
    computeUnitLimit: 1_000,
    microLamportsPerComputeUnit: 0,
    transactionSizeBytes: 0,
    quote: {
      transactionCount: 1,
      transferLamports: String(receivers.length * 10_000),
      baseFeeLamports: "5000",
      priorityFeeLamports: "0",
      senderTipLamports: "0",
      totalFeeLamports: "5000",
      speed: "standard",
    },
    balances: {},
    expiresAtBlockHeight: "1000",
  };
}

function consolidationPreparation(
  first: Address,
  second: Address,
  receiver: Address,
): Preparation {
  return {
    preparationId: "test-preparation",
    network: "devnet",
    preset: "economy",
    transactionVersion: 0,
    pluginId: "native-sol-transfer",
    normalizedAlias: false,
    normalizedPlan: {
      type: "consolidation",
      senders: [
        { address: first, amountSol: "0.01" },
        { address: second, amountSol: "0.02" },
      ],
      receivers: [{ address: receiver }],
    },
    feePayer: first,
    requiredSigners: [first, second],
    recentBlockhash: "11111111111111111111111111111111",
    lastValidBlockHeight: "1000",
    computeUnitLimit: 1_000,
    microLamportsPerComputeUnit: 0,
    transactionSizeBytes: 0,
    quote: {
      transactionCount: 1,
      transferLamports: "30000000",
      baseFeeLamports: "10000",
      priorityFeeLamports: "0",
      senderTipLamports: "0",
      totalFeeLamports: "10000",
      speed: "standard",
    },
    balances: {},
    expiresAtBlockHeight: "1000",
  };
}
