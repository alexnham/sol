import { generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  CUSTOM_DISTRIBUTOR_PROGRAM_ID_DEVNET,
  encodeDistributorAmounts,
  getDistributeSolInstruction,
} from "@solana-workbench/delivery-custom";

describe("distributor instruction", () => {
  it("exports the deployed devnet Program ID", () => {
    expect(CUSTOM_DISTRIBUTOR_PROGRAM_ID_DEVNET).toBe(
      "7wRVHVQwGKkrQ4DA4auS5BtwkCgcQuSwcPtTpzFBu3bf",
    );
  });
  it("encodes only consecutive little-endian u64 amounts", () => {
    expect([...encodeDistributorAmounts([1n, 0x0102_0304_0506_0708n])]).toEqual([
      1, 0, 0, 0, 0, 0, 0, 0,
      8, 7, 6, 5, 4, 3, 2, 1,
    ]);
  });

  it("uses one instruction with recipient accounts and no addresses in data", async () => {
    const source = await generateKeyPairSigner();
    const program = await generateKeyPairSigner();
    const recipients = await Promise.all(Array.from({ length: 3 }, () => generateKeyPairSigner()));
    const instruction = getDistributeSolInstruction(
      source,
      recipients.map((recipient) => recipient.address),
      [11n, 22n, 33n],
      program.address,
    );

    expect(instruction.accounts).toHaveLength(5);
    expect(instruction.data).toHaveLength(24);
    expect(instruction.programAddress).toBe(program.address);
  });
});
