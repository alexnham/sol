import { address, generateKeyPairSigner } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import {
  canonicalTokenPair,
  deriveAmmAddresses,
  getInitializePoolInstruction,
  getSwapExactInInstruction,
  quoteExactInput,
} from "@solana-workbench/custom-amm";
import { describe, expect, it } from "vitest";

describe("custom AMM client", () => {
  it("canonicalizes a mixed-program pair and derives stable PDAs", async () => {
    const first = address("DzcSBpVniutt6w5pyuytxLUqJcWMh3mMawMmxaquLsbZ");
    const second = address("BApRNbirCZhPJ2uHAcesJNJCEwCz98p9o6W4f6bc4yr1");
    const pair = canonicalTokenPair(
      { mint: first, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS },
      { mint: second, tokenProgram: TOKEN_PROGRAM_ADDRESS },
    );
    const one = await deriveAmmAddresses(pair);
    const two = await deriveAmmAddresses(pair);
    expect(one).toStrictEqual(two);
    expect(new Set([one.pool, one.authority, one.lpMint, one.vaultA, one.vaultB]).size).toBe(5);
  });

  it("encodes Anchor discriminators and compact little-endian arguments", async () => {
    const signer = await generateKeyPairSigner();
    const other = await generateKeyPairSigner();
    const pair = canonicalTokenPair(
      { mint: signer.address, tokenProgram: TOKEN_PROGRAM_ADDRESS },
      { mint: other.address, tokenProgram: TOKEN_PROGRAM_ADDRESS },
    );
    const addresses = await deriveAmmAddresses(pair);
    const initialize = getInitializePoolInstruction({ initializer: signer, pair, addresses, feeBps: 30 });
    expect([...initialize.data!]).toEqual([95, 180, 10, 172, 84, 174, 232, 40, 30, 0]);
    const swap = getSwapExactInInstruction({ trader: signer, pair, addresses, traderA: addresses.vaultA, traderB: addresses.vaultB, aToB: true, amountIn: 7n, minAmountOut: 5n });
    expect(swap.data).toHaveLength(25);
    expect(swap.data![8]).toBe(1);
    expect(new DataView(swap.data!.buffer, swap.data!.byteOffset).getBigUint64(9, true)).toBe(7n);
    expect(new DataView(swap.data!.buffer, swap.data!.byteOffset).getBigUint64(17, true)).toBe(5n);
  });

  it("quotes constant-product output after fees", () => {
    expect(quoteExactInput(1_000_000n, 2_000_000n, 100_000n, 30)).toBe(181_322n);
    expect(quoteExactInput(0n, 2_000_000n, 100_000n, 30)).toBe(0n);
  });
});
