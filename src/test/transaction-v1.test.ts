import {
  address,
  blockhash,
  createNoopSigner,
  generateKeyPairSigner,
  getTransactionSize,
  lamports,
  type Address,
  type Instruction,
} from "@solana/kit";
import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  getSetComputeUnitLimitInstruction,
} from "@solana-program/compute-budget";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  buildV1Transaction,
  buildV1TransactionMessage,
  validateV1Instructions,
  V1_TRANSACTION_SIZE_LIMIT,
} from "@solana-workbench/transaction-v1";
import { describe, expect, it } from "vitest";
import { nativeSolTransferPlugin } from "../shared/plugin-registry";

const LIFETIME = {
  blockhash: blockhash("11111111111111111111111111111111"),
  lastValidBlockHeight: 1_000n,
};

const CONFIG = {
  computeUnitLimit: 1_400_000,
  loadedAccountsDataSizeLimit: 64 * 1024 * 1024,
  priorityFeeLamports: 123n,
};

describe("transaction v1 package", () => {
  it("builds a 0x81 message with resources in config and no budget instruction", async () => {
    const payer = await generateKeyPairSigner();
    const recipient = await generateKeyPairSigner();
    const message = buildV1TransactionMessage({
      feePayer: createNoopSigner(payer.address),
      lifetime: LIFETIME,
      instructions: [transfer(payer.address, recipient.address, 7n)],
      config: CONFIG,
    });
    const transaction = buildV1Transaction({
      feePayer: createNoopSigner(payer.address),
      lifetime: LIFETIME,
      instructions: message.instructions,
      config: CONFIG,
    });

    expect(transaction.messageBytes[0]).toBe(0x81);
    expect(message.config).toStrictEqual(CONFIG);
    expect(message.instructions).toHaveLength(1);
    expect(message.instructions[0]?.programAddress).not.toBe(COMPUTE_BUDGET_PROGRAM_ADDRESS);
    expect(getTransactionSize(transaction)).toBeLessThanOrEqual(V1_TRANSACTION_SIZE_LIMIT);
  });

  it("uses individual System transfers and retains different u64 amounts", async () => {
    const payer = await generateKeyPairSigner();
    const recipients = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
    const instructions = await nativeSolTransferPlugin.buildInstructions({
      transactionVersion: 1,
      network: "devnet",
      feePayer: payer.address,
      plan: {
        type: "share",
        senders: [{ address: payer.address }],
        receivers: [
          { address: recipients[0].address, amountSol: "0.000000007" },
          { address: recipients[1].address, amountSol: "0.000000011" },
        ],
      },
      tipLamports: 0n,
    });

    expect(instructions).toHaveLength(2);
    expect(instructions.map(decodeSystemTransferLamports)).toEqual([7n, 11n]);
  });

  it("rejects Compute Budget instructions", () => {
    expect(() => validateV1Instructions([
      getSetComputeUnitLimitInstruction({ units: 1_000 }),
    ])).toThrow("transaction config");
  });

  it("fits 62 unique recipients in exactly 64 accounts", async () => {
    const payer = await generateKeyPairSigner();
    const recipients = await Promise.all(
      Array.from({ length: 62 }, () => generateKeyPairSigner()),
    );
    const transaction = buildV1Transaction({
      feePayer: createNoopSigner(payer.address),
      lifetime: LIFETIME,
      instructions: recipients.map((recipient) => transfer(payer.address, recipient.address, 1n)),
      config: CONFIG,
    });

    expect(transaction.messageBytes[0]).toBe(0x81);
    expect(getTransactionSize(transaction)).toBeLessThanOrEqual(V1_TRANSACTION_SIZE_LIMIT);
  });

  it("rejects a 63rd unique recipient and oversized payloads", async () => {
    const payer = await generateKeyPairSigner();
    const recipients = await Promise.all(
      Array.from({ length: 63 }, () => generateKeyPairSigner()),
    );
    expect(() => buildV1Transaction({
      feePayer: createNoopSigner(payer.address),
      lifetime: LIFETIME,
      instructions: recipients.map((recipient) => transfer(payer.address, recipient.address, 1n)),
      config: CONFIG,
    })).toThrow();

    const oversizedInstruction: Instruction = {
      programAddress: address("11111111111111111111111111111111"),
      data: new Uint8Array(V1_TRANSACTION_SIZE_LIMIT),
    };
    expect(() => buildV1Transaction({
      feePayer: createNoopSigner(payer.address),
      lifetime: LIFETIME,
      instructions: [oversizedInstruction],
      config: CONFIG,
    })).toThrow();
  });

  it("leaves room for only 61 recipients when a distinct tip account is present", async () => {
    const payer = await generateKeyPairSigner();
    const tip = await generateKeyPairSigner();
    const recipients = await Promise.all(
      Array.from({ length: 61 }, () => generateKeyPairSigner()),
    );
    expect(() => buildV1Transaction({
      feePayer: createNoopSigner(payer.address),
      lifetime: LIFETIME,
      instructions: [
        ...recipients.map((recipient) => transfer(payer.address, recipient.address, 1n)),
        transfer(payer.address, tip.address, 5_000n),
      ],
      config: CONFIG,
    })).not.toThrow();
  });
});

function transfer(source: Address, destination: Address, amount: bigint): Instruction {
  return getTransferSolInstruction({
    source: createNoopSigner(source),
    destination,
    amount: lamports(amount),
  });
}

function decodeSystemTransferLamports(instruction: Instruction): bigint {
  const data = instruction.data;
  if (!data || data.length !== 12) throw new Error("Unexpected System transfer layout");
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(4, true);
}
