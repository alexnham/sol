import {
  appendTransactionMessageInstructions,
  blockhash,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import {
  findAddressLookupTablePda,
  getCreateLookupTableInstruction,
  getExtendLookupTableInstruction,
} from "@solana-program/address-lookup-table";
import { sendRpc, waitForConfirmation, type Network } from "@solana-workbench/delivery-sdk";
import { rpcCall } from "../../infrastructure/rpc";

// With one signer serving as both authority and fee payer, create + 30 addresses
// serializes to exactly 1,232 bytes. Adding a 31st address exceeds Solana's limit.
const EXTEND_CHUNK_SIZE = 30;

interface LatestBlockhash {
  value: { blockhash: string; lastValidBlockHeight: number };
}

interface SignatureStatuses {
  value: Array<null | { slot: number; err: unknown; confirmationStatus?: string }>;
}

export interface CreatedAddressLookupTable {
  address: string;
  authority: string;
  addressCount: number;
  signatures: string[];
  network: Network;
}

export async function createAddressLookupTable(
  rpcUrl: string,
  network: Network,
  authority: KeyPairSigner,
  addresses: readonly Address[],
): Promise<CreatedAddressLookupTable> {
  const uniqueAddresses = [...new Set(addresses)];
  if (uniqueAddresses.length < 2 || uniqueAddresses.length > 256) {
    throw new Error("An address lookup table must contain between 2 and 256 unique addresses");
  }

  const recentSlot = await rpcCall<number>(rpcUrl, "getSlot", [{ commitment: "finalized" }]);
  const lookupTable = await findAddressLookupTablePda({
    authority: authority.address,
    recentSlot,
  });
  const createInstruction = getCreateLookupTableInstruction({
    address: lookupTable,
    authority: authority.address,
    payer: authority,
    recentSlot,
  });

  const firstAddresses = uniqueAddresses.slice(0, EXTEND_CHUNK_SIZE);
  const firstExtendInstruction = getExtendLookupTableInstruction({
    address: lookupTable[0],
    authority,
    payer: authority,
    addresses: firstAddresses,
  });
  const signatures = [await sendInstructions(
    rpcUrl,
    authority,
    [createInstruction, firstExtendInstruction],
  )];
  let lastConfirmationSlot = await confirmedSlot(rpcUrl, signatures[0]!);

  for (
    let offset = EXTEND_CHUNK_SIZE;
    offset < uniqueAddresses.length;
    offset += EXTEND_CHUNK_SIZE
  ) {
    const extendInstruction = getExtendLookupTableInstruction({
      address: lookupTable[0],
      authority,
      payer: authority,
      addresses: uniqueAddresses.slice(offset, offset + EXTEND_CHUNK_SIZE),
    });
    const signature = await sendInstructions(rpcUrl, authority, [extendInstruction]);
    signatures.push(signature);
    lastConfirmationSlot = await confirmedSlot(rpcUrl, signature);
  }

  await waitUntilSlotAdvances(rpcUrl, lastConfirmationSlot);
  return {
    address: lookupTable[0],
    authority: authority.address,
    addressCount: uniqueAddresses.length,
    signatures,
    network,
  };
}

async function sendInstructions(
  rpcUrl: string,
  feePayer: KeyPairSigner,
  instructions: readonly Instruction[],
): Promise<string> {
  const latest = await rpcCall<LatestBlockhash>(rpcUrl, "getLatestBlockhash", [
    { commitment: "confirmed" },
  ]);
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (value) => setTransactionMessageFeePayerSigner(feePayer, value),
    (value) => setTransactionMessageLifetimeUsingBlockhash({
      blockhash: blockhash(latest.value.blockhash),
      lastValidBlockHeight: BigInt(latest.value.lastValidBlockHeight),
    }, value),
    (value) => appendTransactionMessageInstructions(instructions, value),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const signature = await sendRpc(rpcUrl, getBase64EncodedWireTransaction(signed), false);
  const status = await waitForConfirmation(
    rpcUrl,
    signature,
    BigInt(latest.value.lastValidBlockHeight),
  );
  if (status !== "confirmed") {
    throw new Error(`ALT transaction ${signature} is still pending; wait before retrying`);
  }
  return signature;
}

async function confirmedSlot(rpcUrl: string, signature: string): Promise<number> {
  const statuses = await rpcCall<SignatureStatuses>(rpcUrl, "getSignatureStatuses", [
    [signature],
    { searchTransactionHistory: true },
  ]);
  const status = statuses.value[0];
  if (!status || status.err) throw new Error(`Could not verify ALT transaction ${signature}`);
  return status.slot;
}

async function waitUntilSlotAdvances(rpcUrl: string, confirmedAtSlot: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const currentSlot = await rpcCall<number>(rpcUrl, "getSlot", [{ commitment: "confirmed" }]);
    if (currentSlot > confirmedAtSlot) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("ALT was created, but its addresses are not active yet; wait one slot and retry");
}
