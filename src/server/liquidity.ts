import { address, type Address, type Instruction, type KeyPairSigner } from "@solana/kit";
import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
} from "@solana-program/token";
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  findAssociatedTokenPda as findToken2022AssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction as getCreateToken2022AssociatedTokenIdempotentInstruction,
} from "@solana-program/token-2022";
import {
  canonicalTokenPair,
  deriveAmmAddresses,
  getAddLiquidityInstruction,
  getInitializePoolInstruction,
  getRemoveLiquidityInstruction,
  getSwapExactInInstruction,
  quoteExactInput,
  type AmmTokenPair,
} from "@solana-workbench/custom-amm";
import type { Network } from "@solana-workbench/delivery-sdk";
import type { CreateLiquidityPoolRequest, LiquidityActionResult, ManageLiquidityPoolRequest, StoredLiquidityPool, TrackedLiquidityPool } from "../shared/liquidity";
import { decimalAmountToBaseUnits } from "../shared/token-mints";
import { listStoredTokenMints } from "./token-mint-registry";
import { listStoredLiquidityPools, recordLiquidityPool } from "./liquidity-pool-registry";
import { rpcCall } from "./rpc";
import { submitTokenInstructions } from "./token-mints";

interface TokenBalanceResponse { value: { amount: string; decimals: number } }

export async function createLiquidityPool(
  rpcUrl: string,
  request: CreateLiquidityPoolRequest,
  provider: KeyPairSigner,
): Promise<LiquidityActionResult> {
  validateCommon(request);
  if (request.network !== "devnet") throw new Error("The custom AMM is devnet-only until its program is audited and deployed to mainnet");
  if (provider.address !== request.provider) throw new Error("Provider signer does not match the request");
  if (!Number.isInteger(request.feeBps) || request.feeBps < 0 || request.feeBps > 1_000) throw new Error("Fee must be 0 to 1,000 basis points");
  const [tokenX, tokenY] = await getTrackedPair(request.network, request.mintX, request.mintY);
  const pair = canonicalTokenPair(tokenIdentity(tokenX), tokenIdentity(tokenY));
  const addresses = await deriveAmmAddresses(pair);
  if ((await listStoredLiquidityPools()).some((item) => item.network === request.network && item.pool === addresses.pool)) throw new Error("This token pair already has a tracked pool");
  const amountX = decimalAmountToBaseUnits(request.amountX, tokenX.decimals);
  const amountY = decimalAmountToBaseUnits(request.amountY, tokenY.decimals);
  const [maxA, maxB] = tokenX.mint === pair.mintA ? [amountX, amountY] : [amountY, amountX];
  if (maxA <= 0n || maxB <= 0n || integerSqrt(maxA * maxB) <= 1_000n) throw new Error("Initial liquidity is too small");
  const user = await userAccounts(provider.address, pair, addresses.lpMint);
  const instructions: Instruction[] = [
    ...createUserAtaInstructions(provider, pair, user),
    getInitializePoolInstruction({ initializer: provider, pair, addresses, feeBps: request.feeBps }),
    getAddLiquidityInstruction({ provider, pair, addresses, providerA: user.a, providerB: user.b, providerLp: user.lp, maxA, maxB, minLpOut: integerSqrt(maxA * maxB) - 1_000n }),
  ];
  const signature = await submitTokenInstructions(rpcUrl, request.transactionVersion, provider, instructions);
  const stored = await recordLiquidityPool({
    pool: addresses.pool, authority: addresses.authority, mintA: pair.mintA, mintB: pair.mintB,
    tokenProgramA: pair.tokenProgramA, tokenProgramB: pair.tokenProgramB, vaultA: addresses.vaultA,
    vaultB: addresses.vaultB, lpMint: addresses.lpMint, initializer: provider.address, feeBps: request.feeBps,
    network: request.network, creationSignature: signature, createdAt: new Date().toISOString(),
  });
  return { signature, pool: (await enrichPools(rpcUrl, [stored]))[0]! };
}

export async function manageLiquidityPool(
  rpcUrl: string,
  request: ManageLiquidityPoolRequest,
  provider: KeyPairSigner,
): Promise<LiquidityActionResult> {
  validateCommon(request);
  if (request.network !== "devnet") throw new Error("The custom AMM is currently devnet-only");
  if (provider.address !== request.provider) throw new Error("Provider signer does not match the request");
  if (!Number.isInteger(request.slippageBps) || request.slippageBps < 0 || request.slippageBps > 5_000) throw new Error("Slippage must be 0 to 5,000 basis points");
  const stored = (await listStoredLiquidityPools()).find((item) => item.network === request.network && item.pool === request.pool);
  if (!stored) throw new Error("Only pools created through this workbench can be managed");
  const tokens = await getTrackedPair(request.network, stored.mintA, stored.mintB);
  const pair: AmmTokenPair = { mintA: address(stored.mintA), mintB: address(stored.mintB), tokenProgramA: address(stored.tokenProgramA), tokenProgramB: address(stored.tokenProgramB) };
  const addresses = await deriveAmmAddresses(pair);
  const user = await userAccounts(provider.address, pair, addresses.lpMint);
  const live = (await enrichPools(rpcUrl, [stored]))[0]!;
  if (live.liveStatus !== "available" || live.reserveA === undefined || live.reserveB === undefined || live.lpSupply === undefined) throw new Error(live.liveError ?? "Pool state is unavailable");
  const reserveA = BigInt(live.reserveA), reserveB = BigInt(live.reserveB), lpSupply = BigInt(live.lpSupply);
  const instructions: Instruction[] = createUserAtaInstructions(provider, pair, user);
  if (request.action === "add") {
    const amountA = decimalAmountToBaseUnits(request.amountA, tokens[0].decimals);
    const amountB = decimalAmountToBaseUnits(request.amountB, tokens[1].decimals);
    if (amountA <= 0n || amountB <= 0n) throw new Error("Liquidity amounts must be greater than zero");
    const expected = min(amountA * (lpSupply + 1_000n) / reserveA, amountB * (lpSupply + 1_000n) / reserveB);
    instructions.push(getAddLiquidityInstruction({ provider, pair, addresses, providerA: user.a, providerB: user.b, providerLp: user.lp, maxA: amountA, maxB: amountB, minLpOut: applySlippage(expected, request.slippageBps) }));
  } else if (request.action === "remove") {
    const amount = decimalAmountToBaseUnits(request.lpAmount, 9);
    if (amount <= 0n) throw new Error("LP amount must be greater than zero");
    const total = lpSupply + 1_000n;
    instructions.push(getRemoveLiquidityInstruction({ provider, pair, addresses, providerA: user.a, providerB: user.b, providerLp: user.lp, lpAmount: amount, minAOut: applySlippage(amount * reserveA / total, request.slippageBps), minBOut: applySlippage(amount * reserveB / total, request.slippageBps) }));
  } else {
    if (request.inputMint !== stored.mintA && request.inputMint !== stored.mintB) throw new Error("Swap input mint is not part of this pool");
    const aToB = request.inputMint === stored.mintA;
    const inputToken = aToB ? tokens[0] : tokens[1];
    const amount = decimalAmountToBaseUnits(request.amountIn, inputToken.decimals);
    if (amount <= 0n) throw new Error("Swap amount must be greater than zero");
    const quote = quoteExactInput(aToB ? reserveA : reserveB, aToB ? reserveB : reserveA, amount, stored.feeBps);
    if (quote <= 0n) throw new Error("Swap output rounds to zero");
    instructions.push(getSwapExactInInstruction({ trader: provider, pair, addresses, traderA: user.a, traderB: user.b, aToB, amountIn: amount, minAmountOut: applySlippage(quote, request.slippageBps) }));
  }
  const signature = await submitTokenInstructions(rpcUrl, request.transactionVersion, provider, instructions);
  return { signature, pool: (await enrichPools(rpcUrl, [stored]))[0]! };
}

export async function listLiquidityPools(rpcUrl: string, network: Network): Promise<TrackedLiquidityPool[]> {
  return enrichPools(rpcUrl, (await listStoredLiquidityPools()).filter((pool) => pool.network === network));
}

async function enrichPools(rpcUrl: string, pools: StoredLiquidityPool[]): Promise<TrackedLiquidityPool[]> {
  const mints = await listStoredTokenMints();
  return Promise.all(pools.map(async (pool) => {
    const a = mints.find((mint) => mint.network === pool.network && mint.mint === pool.mintA);
    const b = mints.find((mint) => mint.network === pool.network && mint.mint === pool.mintB);
    const base = { ...pool, tokenAName: a?.name ?? "Unknown", tokenASymbol: a?.symbol ?? "?", tokenADecimals: a?.decimals ?? 0, tokenBName: b?.name ?? "Unknown", tokenBSymbol: b?.symbol ?? "?", tokenBDecimals: b?.decimals ?? 0 };
    try {
      const [reserveA, reserveB, supply] = await Promise.all([
        rpcCall<TokenBalanceResponse>(rpcUrl, "getTokenAccountBalance", [pool.vaultA, { commitment: "confirmed" }]),
        rpcCall<TokenBalanceResponse>(rpcUrl, "getTokenAccountBalance", [pool.vaultB, { commitment: "confirmed" }]),
        rpcCall<TokenBalanceResponse>(rpcUrl, "getTokenSupply", [pool.lpMint, { commitment: "confirmed" }]),
      ]);
      return { ...base, liveStatus: "available" as const, reserveA: reserveA.value.amount, reserveB: reserveB.value.amount, lpSupply: supply.value.amount };
    } catch (error) {
      return { ...base, liveStatus: "unavailable" as const, liveError: error instanceof Error ? error.message : "RPC refresh failed" };
    }
  }));
}

async function getTrackedPair(network: Network, mintA: string, mintB: string) {
  if (mintA === mintB) throw new Error("A pool requires two different tokens");
  const all = await listStoredTokenMints();
  const first = all.find((mint) => mint.network === network && mint.mint === mintA);
  const second = all.find((mint) => mint.network === network && mint.mint === mintB);
  if (!first || !second) throw new Error("Both pool tokens must have been created through this workbench");
  return [first, second] as const;
}
function tokenIdentity(token: { mint: string; tokenProgram?: "classic" | "token2022" }) {
  return { mint: address(token.mint), tokenProgram: token.tokenProgram === "token2022" ? TOKEN_2022_PROGRAM_ADDRESS : TOKEN_PROGRAM_ADDRESS };
}
async function userAccounts(owner: Address, pair: AmmTokenPair, lpMint: Address) {
  const findA = pair.tokenProgramA === TOKEN_2022_PROGRAM_ADDRESS ? findToken2022AssociatedTokenPda : findAssociatedTokenPda;
  const findB = pair.tokenProgramB === TOKEN_2022_PROGRAM_ADDRESS ? findToken2022AssociatedTokenPda : findAssociatedTokenPda;
  const [[a], [b], [lp]] = await Promise.all([
    findA({ owner, mint: pair.mintA, tokenProgram: pair.tokenProgramA }),
    findB({ owner, mint: pair.mintB, tokenProgram: pair.tokenProgramB }),
    findAssociatedTokenPda({ owner, mint: lpMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
  ]);
  return { a, b, lp };
}
function createUserAtaInstructions(payer: KeyPairSigner, pair: AmmTokenPair, accounts: { a: Address; b: Address; lp: Address }): Instruction[] {
  return [
    pair.tokenProgramA === TOKEN_2022_PROGRAM_ADDRESS
      ? getCreateToken2022AssociatedTokenIdempotentInstruction({ payer, ata: accounts.a, owner: payer.address, mint: pair.mintA, tokenProgram: pair.tokenProgramA })
      : getCreateAssociatedTokenIdempotentInstruction({ payer, ata: accounts.a, owner: payer.address, mint: pair.mintA, tokenProgram: pair.tokenProgramA }),
    pair.tokenProgramB === TOKEN_2022_PROGRAM_ADDRESS
      ? getCreateToken2022AssociatedTokenIdempotentInstruction({ payer, ata: accounts.b, owner: payer.address, mint: pair.mintB, tokenProgram: pair.tokenProgramB })
      : getCreateAssociatedTokenIdempotentInstruction({ payer, ata: accounts.b, owner: payer.address, mint: pair.mintB, tokenProgram: pair.tokenProgramB }),
  ];
}
function validateCommon(input: { network: Network; transactionVersion: number; provider: string }) {
  if (input.network !== "devnet" && input.network !== "mainnet") throw new Error("Network must be devnet or mainnet");
  if (input.transactionVersion !== 0 && input.transactionVersion !== 1) throw new Error("Transaction version must be 0 or 1");
  address(input.provider);
}
function applySlippage(amount: bigint, bps: number) { return amount * BigInt(10_000 - bps) / 10_000n; }
function min(a: bigint, b: bigint) { return a < b ? a : b; }
function integerSqrt(value: bigint) {
  if (value < 2n) return value;
  let x = value, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + value / x) / 2n; }
  return x;
}
