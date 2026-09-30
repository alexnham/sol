import { address } from "@solana/kit";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { MAX_U64, type StoredTokenMint } from "../../../shared/token-mints";

const registryFile = resolve(process.cwd(), "generated-keys", "token-mints.json");
let registryWrite: Promise<void> = Promise.resolve();

export async function listStoredTokenMints(filePath = registryFile): Promise<StoredTokenMint[]> {
  return readRegistry(filePath);
}

export function recordTokenMint(
  mint: StoredTokenMint,
  filePath = registryFile,
): Promise<StoredTokenMint> {
  const validated = validateMint(mint);
  const write = async () => {
    const current = await readRegistry(filePath);
    if (current.some((entry) => entry.network === validated.network && entry.mint === validated.mint)) {
      throw new Error(`Token mint ${validated.mint} is already recorded`);
    }
    const directory = dirname(filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporaryFile = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryFile, `${JSON.stringify([validated, ...current], null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryFile, filePath);
  };
  registryWrite = registryWrite.then(write, write);
  return registryWrite.then(() => validated);
}

export function updateTokenMint(
  network: StoredTokenMint["network"],
  mintAddress: string,
  updates: Partial<Pick<StoredTokenMint, "name" | "symbol" | "metadataUri" | "imageUrl">>,
  filePath = registryFile,
): Promise<StoredTokenMint> {
  let updated!: StoredTokenMint;
  const write = async () => {
    const current = await readRegistry(filePath);
    const index = current.findIndex((entry) => entry.network === network && entry.mint === mintAddress);
    if (index < 0) throw new Error(`Tracked token mint ${mintAddress} was not found`);
    updated = validateMint({ ...current[index], ...updates });
    const next = [...current];
    next[index] = updated;
    const directory = dirname(filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporaryFile = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryFile, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: "utf8", flag: "wx", mode: 0o600,
    });
    await rename(temporaryFile, filePath);
  };
  registryWrite = registryWrite.then(write, write);
  return registryWrite.then(() => updated);
}

async function readRegistry(filePath: string): Promise<StoredTokenMint[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(filePath, "utf8"));
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("Could not read the token mint registry");
  }
  if (!Array.isArray(raw)) throw new Error("Token mint registry is malformed");
  return raw.map(validateMint);
}

function validateMint(value: unknown): StoredTokenMint {
  if (!value || typeof value !== "object") throw new Error("Token mint registry entry is malformed");
  const mint = value as Partial<StoredTokenMint>;
  for (const field of ["mint", "mintAuthorityAtCreation"] as const) {
    if (typeof mint[field] !== "string") throw new Error(`Token mint ${field} is malformed`);
    address(mint[field]!);
  }
  if (mint.associatedTokenAccount !== undefined) address(mint.associatedTokenAccount);
  if (mint.freezeAuthorityAtCreation !== null) {
    if (typeof mint.freezeAuthorityAtCreation !== "string") throw new Error("Token freeze authority is malformed");
    address(mint.freezeAuthorityAtCreation);
  }
  if (mint.network !== "devnet" && mint.network !== "mainnet") throw new Error("Token mint network is malformed");
  if (mint.transactionVersion !== 0 && mint.transactionVersion !== 1) throw new Error("Token transaction version is malformed");
  if (typeof mint.name !== "string" || mint.name.length < 1 || mint.name.length > 64) throw new Error("Token name is malformed");
  if (typeof mint.symbol !== "string" || mint.symbol.length < 1 || mint.symbol.length > 12) throw new Error("Token symbol is malformed");
  if (!Number.isInteger(mint.decimals) || mint.decimals! < 0 || mint.decimals! > 9) throw new Error("Token decimals are malformed");
  if (typeof mint.initialSupplyBaseUnits !== "string" || !/^\d+$/.test(mint.initialSupplyBaseUnits)) throw new Error("Token supply is malformed");
  if (BigInt(mint.initialSupplyBaseUnits) > MAX_U64) throw new Error("Token supply is malformed");
  if (typeof mint.mintAuthorityRevoked !== "boolean" || typeof mint.freezeAuthorityRevoked !== "boolean") throw new Error("Token authority flags are malformed");
  if (typeof mint.creationSignature !== "string" || mint.creationSignature.length === 0) throw new Error("Token signature is malformed");
  if (typeof mint.createdAt !== "string" || Number.isNaN(Date.parse(mint.createdAt))) throw new Error("Token creation date is malformed");
  if (mint.tokenProgram !== undefined && mint.tokenProgram !== "classic" && mint.tokenProgram !== "token2022") throw new Error("Token program is malformed");
  mint.tokenProgram ??= "classic";
  for (const field of ["metadataUri", "imageUrl"] as const) {
    if (mint[field] !== undefined && typeof mint[field] !== "string") throw new Error(`Token ${field} is malformed`);
  }
  return mint as StoredTokenMint;
}
