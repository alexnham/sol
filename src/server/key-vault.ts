import {
  address,
  createKeyPairSignerFromBytes,
  generateKeyPairSigner,
  getTransactionDecoder,
  partiallySignTransactionWithSigners,
  type KeyPairSigner,
} from "@solana/kit";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

export interface VaultKeyMetadata {
  address: string;
  file: string;
  createdAt: string;
}

interface StoredKeypair extends VaultKeyMetadata {
  secretKey: number[];
}

const vaultDirectory = resolve(process.cwd(), "generated-keys");

export async function listVaultKeys(): Promise<VaultKeyMetadata[]> {
  return (await readVault()).map(({ address: keyAddress, file, createdAt }) => ({
    address: keyAddress,
    file,
    createdAt,
  }));
}

export async function generateVaultKeys(count: number): Promise<VaultKeyMetadata[]> {
  if (!Number.isSafeInteger(count) || count < 1 || count > 1_000) {
    throw new Error("Key count must be between 1 and 1,000");
  }
  await mkdir(vaultDirectory, { recursive: true, mode: 0o700 });
  await chmod(vaultDirectory, 0o700);

  const keypairs = [];
  for (let index = 0; index < count; index += 1) {
    const signer = await generateKeyPairSigner(true);
    keypairs.push({
      index: index + 1,
      address: signer.address,
      secretKey: await exportSecretKey(signer),
    });
  }

  const createdAt = new Date().toISOString();
  const timestamp = createdAt.replace(/[:.]/g, "-");
  const file = `solana-keypairs-${timestamp}-${randomUUID().slice(0, 8)}.txt`;
  await writeFile(
    resolve(vaultDirectory, file),
    `${JSON.stringify({
      warning: "PRIVATE KEYS — anyone with this file controls these wallets. Do not commit or share it.",
      format: "Each secretKey is a Solana CLI-compatible 64-byte array.",
      createdAt,
      count,
      keypairs,
    }, null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );

  return keypairs.map((keypair) => ({ address: keypair.address, file, createdAt }));
}

export async function signWithVaultKey(
  signerAddress: string,
  wireTransaction: string,
): Promise<string> {
  address(signerAddress);
  const stored = (await readVault()).find((keypair) => keypair.address === signerAddress);
  if (!stored) throw new Error(`No managed key is available for ${signerAddress}`);
  const transaction = getTransactionDecoder().decode(Buffer.from(wireTransaction, "base64"));
  const signer = await createKeyPairSignerFromBytes(new Uint8Array(stored.secretKey));
  const signed = await partiallySignTransactionWithSigners([signer], transaction);
  const signature = signed.signatures[signer.address];
  if (!signature) throw new Error(`Managed signer ${signerAddress} returned no signature`);
  return Buffer.from(signature).toString("base64");
}

async function readVault(): Promise<StoredKeypair[]> {
  await mkdir(vaultDirectory, { recursive: true, mode: 0o700 });
  const files = (await readdir(vaultDirectory)).filter((file) => file.endsWith(".txt")).sort();
  const output: StoredKeypair[] = [];
  for (const file of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(resolve(vaultDirectory, file), "utf8"));
    } catch {
      continue;
    }
    if (!raw || typeof raw !== "object") continue;
    const payload = raw as { createdAt?: unknown; keypairs?: unknown };
    if (!Array.isArray(payload.keypairs)) continue;
    const createdAt = typeof payload.createdAt === "string" ? payload.createdAt : "Unknown";
    for (const entry of payload.keypairs) {
      if (!entry || typeof entry !== "object") continue;
      const keypair = entry as { address?: unknown; secretKey?: unknown };
      if (typeof keypair.address !== "string" || !isSecretKey(keypair.secretKey)) continue;
      address(keypair.address);
      output.push({ address: keypair.address, secretKey: keypair.secretKey, file, createdAt });
    }
  }
  return [...new Map(output.map((keypair) => [keypair.address, keypair])).values()];
}

function isSecretKey(value: unknown): value is number[] {
  return Array.isArray(value) && value.length === 64 && value.every(
    (byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255,
  );
}

async function exportSecretKey(signer: KeyPairSigner): Promise<number[]> {
  const [privateKeyPkcs8, publicKeyRaw] = await Promise.all([
    crypto.subtle.exportKey("pkcs8", signer.keyPair.privateKey),
    crypto.subtle.exportKey("raw", signer.keyPair.publicKey),
  ]);
  const privateKey = new Uint8Array(privateKeyPkcs8).slice(16);
  const publicKey = new Uint8Array(publicKeyRaw);
  if (privateKey.byteLength !== 32 || publicKey.byteLength !== 32) {
    throw new Error("Unexpected Ed25519 key length");
  }
  return [...privateKey, ...publicKey];
}
