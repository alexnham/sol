import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listStoredTokenMints, recordTokenMint, updateTokenMint } from "../server/features/token-mints/registry";

const temporaryDirectories: string[] = [];
const entry = {
  mint: "Cas5qTBtAr6kPFt1LRW431JkYzqXm2Z49XMD5xAa3wuQ",
  associatedTokenAccount: "BApRNbirCZhPJ2uHAcesJNJCEwCz98p9o6W4f6bc4yr1",
  name: "Test token",
  symbol: "TEST",
  decimals: 9,
  initialSupplyBaseUnits: "1000000000",
  network: "devnet" as const,
  transactionVersion: 1 as const,
  mintAuthorityAtCreation: "DzcSBpVniutt6w5pyuytxLUqJcWMh3mMawMmxaquLsbZ",
  freezeAuthorityAtCreation: null,
  mintAuthorityRevoked: false,
  freezeAuthorityRevoked: false,
  creationSignature: "signature",
  createdAt: "2026-09-27T00:00:00.000Z",
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("token mint registry", () => {
  it("serializes concurrent writes atomically and rejects replacement", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "token-mints-"));
    temporaryDirectories.push(directory);
    const file = resolve(directory, "mints.json");
    const second = { ...entry, mint: "8rb5FTPT3A8HBaYtDAbzduBZsYi18sRy7cyJmuD5AUT4" };
    await Promise.all([recordTokenMint(entry, file), recordTokenMint(second, file)]);
    expect(await listStoredTokenMints(file)).toHaveLength(2);
    await expect(recordTokenMint(entry, file)).rejects.toThrow("already recorded");
    expect(JSON.parse(await readFile(file, "utf8"))).toHaveLength(2);
  });

  it("rejects malformed registry files", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "token-mints-"));
    temporaryDirectories.push(directory);
    const file = resolve(directory, "mints.json");
    await writeFile(file, "{}", "utf8");
    await expect(listStoredTokenMints(file)).rejects.toThrow("malformed");
  });

  it("updates tracked labels without replacing immutable creation data", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "token-mints-"));
    temporaryDirectories.push(directory);
    const file = resolve(directory, "mints.json");
    await recordTokenMint(entry, file);
    const updated = await updateTokenMint("devnet", entry.mint, {
      name: "Renamed token",
      symbol: "NEW",
      imageUrl: "https://example.com/new.png",
    }, file);
    expect(updated).toMatchObject({
      name: "Renamed token",
      symbol: "NEW",
      imageUrl: "https://example.com/new.png",
      creationSignature: entry.creationSignature,
    });
  });
});
