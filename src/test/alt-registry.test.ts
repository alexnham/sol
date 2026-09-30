import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listStoredAddressLookupTables,
  recordAddressLookupTable,
} from "../server/features/address-lookup-tables/registry";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("ALT registry", () => {
  it("persists public table metadata and replaces the same network entry", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "solana-alt-registry-"));
    temporaryDirectories.push(directory);
    const file = resolve(directory, "tables.json");
    const base = {
      address: "Cas5qTBtAr6kPFt1LRW431JkYzqXm2Z49XMD5xAa3wuQ",
      authority: "DzcSBpVniutt6w5pyuytxLUqJcWMh3mMawMmxaquLsbZ",
      addresses: [
        "BApRNbirCZhPJ2uHAcesJNJCEwCz98p9o6W4f6bc4yr1",
        "8rb5FTPT3A8HBaYtDAbzduBZsYi18sRy7cyJmuD5AUT4",
      ],
      addressCount: 2,
      signatures: ["first"],
      network: "devnet" as const,
      createdAt: "2026-09-26T00:00:00.000Z",
    };

    await recordAddressLookupTable(base, file);
    await recordAddressLookupTable({ ...base, signatures: ["replacement"] }, file);

    expect(await listStoredAddressLookupTables(file)).toEqual([{
      address: base.address,
      authority: base.authority,
      addressCount: 2,
      signatures: ["replacement"],
      network: "devnet",
      createdAt: base.createdAt,
    }]);
  });
});
