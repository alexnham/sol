import {
  AccountRole,
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
} from "@solana-program/token";

export const CUSTOM_AMM_PROGRAM_ID_DEVNET = address("HwtbuEdcs3i8Y1pugfH8MTvzxvqwUUYNjE96QW5NFy3j");
export const CUSTOM_AMM_MINIMUM_LIQUIDITY = 1_000n;

export interface AmmAddresses {
  mintA: Address;
  mintB: Address;
  pool: Address;
  authority: Address;
  lpMint: Address;
  vaultA: Address;
  vaultB: Address;
}

export interface AmmTokenPair {
  mintA: Address;
  mintB: Address;
  tokenProgramA: Address;
  tokenProgramB: Address;
}

const addressEncoder = getAddressEncoder();
const textEncoder = new TextEncoder();
const discriminators = {
  initializePool: new Uint8Array([95, 180, 10, 172, 84, 174, 232, 40]),
  addLiquidity: new Uint8Array([181, 157, 89, 67, 143, 182, 52, 72]),
  removeLiquidity: new Uint8Array([80, 85, 209, 72, 24, 206, 177, 108]),
  swapExactIn: new Uint8Array([104, 104, 131, 86, 161, 189, 180, 216]),
};

export function canonicalTokenPair(
  first: { mint: Address; tokenProgram: Address },
  second: { mint: Address; tokenProgram: Address },
): AmmTokenPair {
  if (first.mint === second.mint) throw new Error("A pool requires two different token mints");
  const [a, b] = compareBytes(addressEncoder.encode(first.mint), addressEncoder.encode(second.mint)) < 0
    ? [first, second]
    : [second, first];
  return { mintA: a.mint, mintB: b.mint, tokenProgramA: a.tokenProgram, tokenProgramB: b.tokenProgram };
}

export async function deriveAmmAddresses(pair: AmmTokenPair): Promise<AmmAddresses> {
  const [pool] = await getProgramDerivedAddress({
    programAddress: CUSTOM_AMM_PROGRAM_ID_DEVNET,
    seeds: [textEncoder.encode("pool"), addressEncoder.encode(pair.mintA), addressEncoder.encode(pair.mintB)],
  });
  const [authority] = await getProgramDerivedAddress({
    programAddress: CUSTOM_AMM_PROGRAM_ID_DEVNET,
    seeds: [textEncoder.encode("authority"), addressEncoder.encode(pool)],
  });
  const [lpMint] = await getProgramDerivedAddress({
    programAddress: CUSTOM_AMM_PROGRAM_ID_DEVNET,
    seeds: [textEncoder.encode("lp"), addressEncoder.encode(pool)],
  });
  const [vaultA] = await findAssociatedTokenPda({ owner: authority, mint: pair.mintA, tokenProgram: pair.tokenProgramA });
  const [vaultB] = await findAssociatedTokenPda({ owner: authority, mint: pair.mintB, tokenProgram: pair.tokenProgramB });
  return { mintA: pair.mintA, mintB: pair.mintB, pool, authority, lpMint, vaultA, vaultB };
}

export function getInitializePoolInstruction(input: {
  initializer: TransactionSigner;
  pair: AmmTokenPair;
  addresses: AmmAddresses;
  feeBps: number;
}): Instruction {
  return instruction([
    signer(input.initializer), ro(input.pair.mintA), ro(input.pair.mintB),
    rw(input.addresses.pool), ro(input.addresses.authority), rw(input.addresses.lpMint),
    rw(input.addresses.vaultA), rw(input.addresses.vaultB),
    ro(input.pair.tokenProgramA), ro(input.pair.tokenProgramB), ro(TOKEN_PROGRAM_ADDRESS),
    ro(ASSOCIATED_TOKEN_PROGRAM_ADDRESS), ro(SYSTEM_PROGRAM_ADDRESS),
  ], data(discriminators.initializePool, u16(input.feeBps)));
}

export function getAddLiquidityInstruction(input: {
  provider: TransactionSigner;
  pair: AmmTokenPair;
  addresses: AmmAddresses;
  providerA: Address;
  providerB: Address;
  providerLp: Address;
  maxA: bigint;
  maxB: bigint;
  minLpOut: bigint;
}): Instruction {
  return instruction([
    ro(input.addresses.pool), ro(input.addresses.authority), signer(input.provider),
    ro(input.pair.mintA), ro(input.pair.mintB), rw(input.addresses.lpMint),
    rw(input.addresses.vaultA), rw(input.addresses.vaultB), rw(input.providerA), rw(input.providerB), rw(input.providerLp),
    ro(input.pair.tokenProgramA), ro(input.pair.tokenProgramB), ro(TOKEN_PROGRAM_ADDRESS),
    ro(ASSOCIATED_TOKEN_PROGRAM_ADDRESS), ro(SYSTEM_PROGRAM_ADDRESS),
  ], data(discriminators.addLiquidity, u64(input.maxA), u64(input.maxB), u64(input.minLpOut)));
}

export function getRemoveLiquidityInstruction(input: {
  provider: TransactionSigner;
  pair: AmmTokenPair;
  addresses: AmmAddresses;
  providerA: Address;
  providerB: Address;
  providerLp: Address;
  lpAmount: bigint;
  minAOut: bigint;
  minBOut: bigint;
}): Instruction {
  return instruction([
    ro(input.addresses.pool), ro(input.addresses.authority), signer(input.provider),
    ro(input.pair.mintA), ro(input.pair.mintB), rw(input.addresses.lpMint),
    rw(input.addresses.vaultA), rw(input.addresses.vaultB), rw(input.providerA), rw(input.providerB), rw(input.providerLp),
    ro(input.pair.tokenProgramA), ro(input.pair.tokenProgramB), ro(TOKEN_PROGRAM_ADDRESS),
  ], data(discriminators.removeLiquidity, u64(input.lpAmount), u64(input.minAOut), u64(input.minBOut)));
}

export function getSwapExactInInstruction(input: {
  trader: TransactionSigner;
  pair: AmmTokenPair;
  addresses: AmmAddresses;
  traderA: Address;
  traderB: Address;
  aToB: boolean;
  amountIn: bigint;
  minAmountOut: bigint;
}): Instruction {
  return instruction([
    ro(input.addresses.pool), ro(input.addresses.authority), signer(input.trader),
    ro(input.pair.mintA), ro(input.pair.mintB), rw(input.addresses.vaultA), rw(input.addresses.vaultB),
    rw(input.traderA), rw(input.traderB), ro(input.pair.tokenProgramA), ro(input.pair.tokenProgramB),
  ], data(discriminators.swapExactIn, new Uint8Array([input.aToB ? 1 : 0]), u64(input.amountIn), u64(input.minAmountOut)));
}

export function quoteExactInput(reserveIn: bigint, reserveOut: bigint, amountIn: bigint, feeBps: number): bigint {
  if (reserveIn <= 0n || reserveOut <= 0n || amountIn <= 0n) return 0n;
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 1_000) throw new Error("Fee must be 0 to 1,000 basis points");
  const afterFee = amountIn * BigInt(10_000 - feeBps) / 10_000n;
  return afterFee * reserveOut / (reserveIn + afterFee);
}

function instruction(accounts: NonNullable<Instruction["accounts"]>, instructionData: Uint8Array): Instruction {
  return { programAddress: CUSTOM_AMM_PROGRAM_ID_DEVNET, accounts, data: instructionData };
}
function ro(value: Address) { return { address: value, role: AccountRole.READONLY } as const; }
function rw(value: Address) { return { address: value, role: AccountRole.WRITABLE } as const; }
function signer(value: TransactionSigner) { return { address: value.address, role: AccountRole.WRITABLE_SIGNER, signer: value } as const; }
function data(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}
function u16(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new RangeError("Value does not fit u16");
  const result = new Uint8Array(2); new DataView(result.buffer).setUint16(0, value, true); return result;
}
function u64(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) throw new RangeError("Value does not fit u64");
  const result = new Uint8Array(8); new DataView(result.buffer).setBigUint64(0, value, true); return result;
}
function compareBytes(a: ArrayLike<number>, b: ArrayLike<number>): number {
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return a[index]! - b[index]!;
  return 0;
}
