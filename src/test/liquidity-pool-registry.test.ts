import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listStoredLiquidityPools, recordLiquidityPool } from "../server/features/liquidity/registry";

const directories: string[] = [];
const pool = {
  pool: "Cas5qTBtAr6kPFt1LRW431JkYzqXm2Z49XMD5xAa3wuQ", authority: "BApRNbirCZhPJ2uHAcesJNJCEwCz98p9o6W4f6bc4yr1",
  mintA: "8rb5FTPT3A8HBaYtDAbzduBZsYi18sRy7cyJmuD5AUT4", mintB: "DzcSBpVniutt6w5pyuytxLUqJcWMh3mMawMmxaquLsbZ",
  tokenProgramA: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", tokenProgramB: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  vaultA: "11111111111111111111111111111111", vaultB: "ComputeBudget111111111111111111111111111111", lpMint: "AddressLookupTab1e1111111111111111111111111",
  initializer: "DzcSBpVniutt6w5pyuytxLUqJcWMh3mMawMmxaquLsbZ", feeBps: 30, network: "devnet" as const,
  creationSignature: "signature", createdAt: "2026-09-27T00:00:00.000Z",
};

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("liquidity pool registry", () => {
  it("writes atomically and rejects replacement", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "pools-")); directories.push(directory);
    const file = resolve(directory, "pools.json");
    await recordLiquidityPool(pool, file);
    await expect(recordLiquidityPool(pool, file)).rejects.toThrow("already tracked");
    expect(JSON.parse(await readFile(file, "utf8"))).toHaveLength(1);
  });
  it("rejects malformed data", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "pools-")); directories.push(directory);
    const file = resolve(directory, "pools.json"); await writeFile(file, "{}", "utf8");
    await expect(listStoredLiquidityPools(file)).rejects.toThrow("array");
  });
});
