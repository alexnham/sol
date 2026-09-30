import { CompressedTokenProgram, selectMinCompressedTokenAccountsForTransfer } from "@lightprotocol/compressed-token";
import { bn, createRpc, pickRandomTreeAndQueue } from "@lightprotocol/stateless.js";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { fromLegacyTransactionInstruction } from "@solana/compat";
import { type Address, type Instruction, type KeyPairSigner } from "@solana/kit";

// Light Protocol's official TypeScript SDK is still Web3.js-based. This is the
// only compatibility boundary; signing, RPC transport, and transactions use Kit.
export async function getAirshipStateTree(rpcUrl: string): Promise<string> {
  const rpc = createRpc(rpcUrl, rpcUrl, undefined, { commitment: "confirmed" });
  const { tree } = pickRandomTreeAndQueue(await rpc.getCachedActiveStateTreeInfo());
  return tree.toBase58();
}

export function getAirshipTokenPoolAddress(mint: Address): string {
  return CompressedTokenProgram.deriveTokenPoolPda(new PublicKey(mint)).toBase58();
}

export async function getAirshipCreatePoolInstruction(input: {
  feePayer: KeyPairSigner;
  mint: Address;
  tokenProgram: Address;
}): Promise<Instruction> {
  return toKitInstruction(await CompressedTokenProgram.createTokenPool({
    feePayer: new PublicKey(input.feePayer.address),
    mint: new PublicKey(input.mint),
    tokenProgramId: new PublicKey(input.tokenProgram),
  }), input.feePayer);
}

export async function getAirshipCompressInstruction(input: {
  feePayer: KeyPairSigner;
  source: Address;
  recipients: readonly Address[];
  amount: bigint;
  mint: Address;
  tokenProgram: Address;
  outputStateTree: string;
}): Promise<Instruction> {
  return toKitInstruction(await CompressedTokenProgram.compress({
    payer: new PublicKey(input.feePayer.address),
    owner: new PublicKey(input.feePayer.address),
    source: new PublicKey(input.source),
    toAddress: input.recipients.map((recipient) => new PublicKey(recipient)),
    amount: input.recipients.map(() => Number(input.amount)),
    mint: new PublicKey(input.mint),
    tokenProgramId: new PublicKey(input.tokenProgram),
    outputStateTree: new PublicKey(input.outputStateTree),
  }), input.feePayer);
}

export async function getAirshipDecompressInstruction(input: {
  rpcUrl: string;
  feePayer: KeyPairSigner;
  destination: Address;
  amount: bigint;
  mint: Address;
  tokenProgram: Address;
  outputStateTree: string;
}): Promise<Instruction> {
  const rpc = createRpc(input.rpcUrl, input.rpcUrl, undefined, { commitment: "confirmed" });
  const owner = new PublicKey(input.feePayer.address);
  const mint = new PublicKey(input.mint);
  const amount = bn(input.amount.toString());
  const compressedAccounts = await rpc.getCompressedTokenAccountsByOwner(owner, { mint });
  const [inputAccounts] = selectMinCompressedTokenAccountsForTransfer(compressedAccounts.items, amount);
  const proof = await rpc.getValidityProof(
    inputAccounts.map((account) => bn(account.compressedAccount.hash)),
  );

  return toKitInstruction(await CompressedTokenProgram.decompress({
    payer: owner,
    inputCompressedTokenAccounts: inputAccounts,
    toAddress: new PublicKey(input.destination),
    amount,
    recentInputStateRootIndices: proof.rootIndices,
    recentValidityProof: proof.compressedProof,
    outputStateTree: new PublicKey(input.outputStateTree),
    tokenProgramId: new PublicKey(input.tokenProgram),
  }), input.feePayer);
}

export function toKitInstruction(instruction: TransactionInstruction, signer: KeyPairSigner): Instruction {
  const kitInstruction = fromLegacyTransactionInstruction(instruction);
  return {
    ...kitInstruction,
    accounts: kitInstruction.accounts?.map((account, index) =>
      instruction.keys[index]?.isSigner && account.address === signer.address
        ? { ...account, signer }
        : account),
  };
}
