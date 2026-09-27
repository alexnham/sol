import { address } from "@solana/kit";
import type { Network } from "@solana-workbench/delivery-sdk";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export interface StoredAddressLookupTable {
  address: string;
  authority?: string;
  addressCount: number;
  signatures: string[];
  network: Network;
  createdAt: string;
}

interface StoredAddressLookupTableWithEntries extends StoredAddressLookupTable {
  addresses: string[];
}

const vaultDirectory = resolve(process.cwd(), "generated-keys");
const registryFile = resolve(vaultDirectory, "address-lookup-tables.json");
let registryWrite: Promise<void> = Promise.resolve();

export async function listStoredAddressLookupTables(
  filePath = registryFile,
): Promise<StoredAddressLookupTable[]> {
  return (await readRegistry(filePath)).map(({ addresses: _addresses, ...metadata }) => metadata);
}

export function recordAddressLookupTable(
  table: StoredAddressLookupTableWithEntries,
  filePath = registryFile,
): Promise<StoredAddressLookupTable> {
  const validated = validateTable(table);
  let recorded!: StoredAddressLookupTable;
  const write = async () => {
    const current = await readRegistry(filePath);
    const next = [
      validated,
      ...current.filter((entry) => !(
        entry.network === validated.network && entry.address === validated.address
      )),
    ];
    const directory = dirname(filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporaryFile = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryFile, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryFile, filePath);
    recorded = withoutEntries(validated);
  };
  registryWrite = registryWrite.then(write, write);
  return registryWrite.then(() => recorded);
}

async function readRegistry(filePath: string): Promise<StoredAddressLookupTableWithEntries[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(filePath, "utf8"));
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("Could not read the address lookup table registry");
  }
  if (!Array.isArray(raw)) throw new Error("Address lookup table registry is malformed");
  return raw.map(validateTable);
}

function validateTable(value: unknown): StoredAddressLookupTableWithEntries {
  if (!value || typeof value !== "object") throw new Error("ALT registry entry is malformed");
  const table = value as Partial<StoredAddressLookupTableWithEntries>;
  if (typeof table.address !== "string") {
    throw new Error("ALT registry address is malformed");
  }
  address(table.address);
  if (table.authority !== undefined) {
    if (typeof table.authority !== "string") throw new Error("ALT registry authority is malformed");
    address(table.authority);
  }
  if (table.network !== "devnet" && table.network !== "mainnet") {
    throw new Error("ALT registry network is malformed");
  }
  if (!Number.isSafeInteger(table.addressCount) || table.addressCount! < 0 || table.addressCount! > 256) {
    throw new Error("ALT registry address count is malformed");
  }
  if (!Array.isArray(table.signatures) || !table.signatures.every((item) => typeof item === "string")) {
    throw new Error("ALT registry signatures are malformed");
  }
  if (!Array.isArray(table.addresses) || !table.addresses.every((item) => typeof item === "string")) {
    throw new Error("ALT registry entries are malformed");
  }
  table.addresses.forEach((item) => address(item));
  if (table.addresses.length !== table.addressCount) {
    throw new Error("ALT registry address count does not match its entries");
  }
  if (typeof table.createdAt !== "string" || Number.isNaN(Date.parse(table.createdAt))) {
    throw new Error("ALT registry creation date is malformed");
  }
  return table as StoredAddressLookupTableWithEntries;
}

function withoutEntries(table: StoredAddressLookupTableWithEntries): StoredAddressLookupTable {
  const { addresses: _addresses, ...metadata } = table;
  return metadata;
}
