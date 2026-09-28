import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { StoredLiquidityPool } from "../shared/liquidity";

const registryFile = resolve(process.cwd(), "generated-keys", "liquidity-pools.json");
let writeQueue = Promise.resolve();

export async function listStoredLiquidityPools(file = registryFile): Promise<StoredLiquidityPool[]> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (!Array.isArray(value)) throw new Error("Liquidity pool registry must contain an array");
    return value.map(validateEntry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function recordLiquidityPool(pool: StoredLiquidityPool, file = registryFile): Promise<StoredLiquidityPool> {
  const operation = writeQueue.then(async () => {
    const entries = await listStoredLiquidityPools(file);
    if (entries.some((entry) => entry.network === pool.network && entry.pool === pool.pool)) {
      throw new Error("This liquidity pool is already tracked");
    }
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify([...entries, pool], null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
    return pool;
  });
  writeQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

function validateEntry(value: unknown): StoredLiquidityPool {
  if (!value || typeof value !== "object") throw new Error("Liquidity pool registry contains a malformed entry");
  const item = value as Record<string, unknown>;
  for (const field of ["pool", "authority", "mintA", "mintB", "tokenProgramA", "tokenProgramB", "vaultA", "vaultB", "lpMint", "initializer", "creationSignature", "createdAt"]) {
    if (typeof item[field] !== "string" || item[field] === "") throw new Error(`Liquidity pool ${field} is malformed`);
  }
  if (item.network !== "devnet" && item.network !== "mainnet") throw new Error("Liquidity pool network is malformed");
  if (!Number.isInteger(item.feeBps) || (item.feeBps as number) < 0 || (item.feeBps as number) > 1_000) throw new Error("Liquidity pool fee is malformed");
  return item as unknown as StoredLiquidityPool;
}
