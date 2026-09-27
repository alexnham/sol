import {
  AccountRole,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import {
  priorityQuote,
  sendRpc,
  submissionResult,
  waitForConfirmation,
  type DeliveryAdapter,
} from "@solana-workbench/delivery-sdk";

export const CUSTOM_DISTRIBUTOR_PROGRAM_ID_DEVNET =
  "7wRVHVQwGKkrQ4DA4auS5BtwkCgcQuSwcPtTpzFBu3bf";

const MAX_U64 = 0xffff_ffff_ffff_ffffn;

/** Raw layout: consecutive little-endian u64 lamport amounts; no discriminator or count. */
export function encodeDistributorAmounts(amounts: readonly bigint[]): Uint8Array {
  const data = new Uint8Array(amounts.length * 8);
  const view = new DataView(data.buffer);
  amounts.forEach((amount, index) => {
    if (amount < 0n || amount > MAX_U64) {
      throw new RangeError(`Distributor amount ${index} does not fit in a u64`);
    }
    view.setBigUint64(index * 8, amount, true);
  });
  return data;
}

export function getDistributeSolInstruction(
  source: TransactionSigner,
  recipients: readonly Address[],
  amounts: readonly bigint[],
  programAddress: Address,
): Instruction {
  if (recipients.length === 0 || recipients.length !== amounts.length) {
    throw new Error("The distributor requires exactly one amount per recipient");
  }
  return {
    programAddress,
    accounts: [
      { address: source.address, role: AccountRole.WRITABLE_SIGNER },
      ...recipients.map((recipient) => ({
        address: recipient,
        role: AccountRole.WRITABLE,
      })),
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: encodeDistributorAmounts(amounts),
  };
}

export const customAdapter: DeliveryAdapter = {
  id: "custom",
  label: "Custom distributor RPC",
  speed: "standard",
  supports: (network) => network === "devnet",
  quote: async (context) =>
    priorityQuote({ ...context, recommendedMicroLamports: 0 }, 0n, "standard"),
  submit: async (context) => {
    const started = Date.now();
    const signature = await sendRpc(context.rpcUrl, context.wireTransaction, false);
    const status = await waitForConfirmation(
      context.rpcUrl,
      signature,
      context.lastValidBlockHeight,
    );
    return submissionResult(signature, status, Date.now() - started, context.network);
  },
};
