import {
  blockhash,
  generateKeyPairSigner,
} from "@solana/kit";
import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from "@solana-program/compute-budget";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { describe, expect, it } from "vitest";
import { decimalAmountToBaseUnits, MAX_U64 } from "../shared/token-mints";
import {
  buildTokenMintInstructions,
  buildUnsignedTokenMintTransaction,
} from "../server/token-mints";

const LIFETIME = {
  blockhash: blockhash("11111111111111111111111111111111"),
  lastValidBlockHeight: 1_000n,
};

describe("SPL token minting", () => {
  it("converts exact decimal supplies and rejects invalid precision and overflow", () => {
    expect(decimalAmountToBaseUnits("12.340", 3)).toBe(12_340n);
    expect(decimalAmountToBaseUnits("0", 9)).toBe(0n);
    expect(decimalAmountToBaseUnits(MAX_U64.toString(), 0)).toBe(MAX_U64);
    expect(() => decimalAmountToBaseUnits("1.001", 2)).toThrow("fractional digits");
    expect(() => decimalAmountToBaseUnits("-1", 9)).toThrow("non-negative");
    expect(() => decimalAmountToBaseUnits((MAX_U64 + 1n).toString(), 0)).toThrow("u64");
  });

  it("orders creation, initialization, ATA, minting, then revocations", async () => {
    const mint = await generateKeyPairSigner();
    const authority = await generateKeyPairSigner();
    const freeze = await generateKeyPairSigner();
    const result = await buildTokenMintInstructions({
      mint,
      mintAuthority: authority,
      freezeAuthority: freeze.address,
      freezeAuthoritySigner: freeze,
      decimals: 6,
      amount: 123n,
      rentLamports: 1_500_000,
      revokeMintAuthority: true,
      revokeFreezeAuthority: true,
    });

    expect(result.associatedTokenAccount).toBeDefined();
    expect(result.instructions).toHaveLength(6);
    expect(result.instructions[0]!.programAddress).not.toBe(TOKEN_PROGRAM_ADDRESS);
    expect(result.instructions.slice(1).map((instruction) => instruction.programAddress)).toEqual([
      TOKEN_PROGRAM_ADDRESS,
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
      TOKEN_PROGRAM_ADDRESS,
      TOKEN_PROGRAM_ADDRESS,
      TOKEN_PROGRAM_ADDRESS,
    ]);
    expect(Array.from(result.instructions[1]!.data ?? [])[0]).toBe(20);
    expect(Array.from(result.instructions[3]!.data ?? [])[0]).toBe(7);
    const mintToData = result.instructions[3]!.data!;
    expect(new DataView(mintToData.buffer, mintToData.byteOffset, mintToData.byteLength).getBigUint64(1, true)).toBe(123n);
    expect(Array.from(result.instructions[4]!.data ?? [])[0]).toBe(6);
    expect(Array.from(result.instructions[5]!.data ?? [])[0]).toBe(6);
  });

  it("omits ATA and MintTo for zero supply", async () => {
    const mint = await generateKeyPairSigner();
    const authority = await generateKeyPairSigner();
    const result = await buildTokenMintInstructions({
      mint,
      mintAuthority: authority,
      freezeAuthority: authority.address,
      freezeAuthoritySigner: null,
      decimals: 9,
      amount: 0n,
      rentLamports: 1_500_000,
      revokeMintAuthority: false,
      revokeFreezeAuthority: false,
    });
    expect(result.associatedTokenAccount).toBeUndefined();
    expect(result.instructions).toHaveLength(2);
  });

  it("creates Token-2022 metadata before supply and authority changes", async () => {
    const mint = await generateKeyPairSigner();
    const authority = await generateKeyPairSigner();
    const result = await buildTokenMintInstructions({
      mint,
      mintAuthority: authority,
      freezeAuthority: authority.address,
      freezeAuthoritySigner: authority,
      decimals: 6,
      amount: 10n,
      rentLamports: 5_000_000,
      revokeMintAuthority: true,
      revokeFreezeAuthority: false,
      tokenProgram: "token2022",
      name: "On-chain token",
      symbol: "CHAIN",
      metadataUri: "https://example.com/token.json",
      imageUrl: "https://example.com/token.png",
    });
    expect(result.instructions).toHaveLength(8);
    expect(result.instructions[0]!.programAddress).not.toBe(TOKEN_2022_PROGRAM_ADDRESS);
    expect(result.instructions.slice(1).every((instruction) =>
      instruction.programAddress === TOKEN_2022_PROGRAM_ADDRESS ||
      instruction.programAddress === "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
    )).toBe(true);
    expect(result.associatedTokenAccount).toBeDefined();
  });

  it("uses Compute Budget only in v0 and emits a v1 wire message marker", async () => {
    const mint = await generateKeyPairSigner();
    const authority = await generateKeyPairSigner();
    const { instructions } = await buildTokenMintInstructions({
      mint,
      mintAuthority: authority,
      freezeAuthority: null,
      freezeAuthoritySigner: null,
      decimals: 9,
      amount: 0n,
      rentLamports: 1_500_000,
      revokeMintAuthority: false,
      revokeFreezeAuthority: false,
    });
    const resources = { computeUnitLimit: 50_000, loadedAccountsDataSizeLimit: 100_000 };
    const v0 = buildUnsignedTokenMintTransaction(0, authority, LIFETIME, instructions, resources);
    const v1 = buildUnsignedTokenMintTransaction(1, authority, LIFETIME, instructions, resources);
    expect(v0.messageBytes[0]).toBe(0x80);
    expect(v1.messageBytes[0]).toBe(0x81);
    expect(instructions.some((instruction) => instruction.programAddress === COMPUTE_BUDGET_PROGRAM_ADDRESS)).toBe(false);
  });
});
