import { describe, expect, it } from "vitest";
import { TransactionInstruction, PublicKey } from "@solana/web3.js";
import { AccountRole, generateKeyPairSigner } from "@solana/kit";
import { toKitInstruction } from "../server/light-kit-adapter";

describe("Light Protocol Kit adapter", () => {
  it("preserves account roles, signer capability, program address, and data", async () => {
    const signer = await generateKeyPairSigner();
    const readonly = new PublicKey("11111111111111111111111111111111");
    const web3Instruction = new TransactionInstruction({
      programId: new PublicKey("ComputeBudget111111111111111111111111111111"),
      keys: [
        { pubkey: new PublicKey(signer.address), isSigner: true, isWritable: true },
        { pubkey: readonly, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([4, 8, 15, 16, 23, 42]),
    });

    const instruction = toKitInstruction(web3Instruction, signer);

    expect(instruction.programAddress).toBe(web3Instruction.programId.toBase58());
    expect(instruction.data).toEqual(new Uint8Array([4, 8, 15, 16, 23, 42]));
    expect(instruction.accounts?.[0]).toMatchObject({
      address: signer.address,
      role: AccountRole.WRITABLE_SIGNER,
      signer,
    });
    expect(instruction.accounts?.[1]).toEqual({
      address: readonly.toBase58(),
      role: AccountRole.READONLY,
    });
  });
});
