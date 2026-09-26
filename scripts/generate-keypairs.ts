import { generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

const rawCount = process.argv[2] ?? "1";
if (!/^\d+$/.test(rawCount)) {
  throw new Error("Count must be a positive integer. Example: npm run keygen -- 5");
}

const count = Number(rawCount);
if (!Number.isSafeInteger(count) || count < 1 || count > 10_000) {
  throw new Error("Count must be between 1 and 10,000");
}

const outputDirectory = resolve("generated-keys");
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
await chmod(outputDirectory, 0o700);

const keypairs = [];
for (let index = 0; index < count; index += 1) {
  const signer = await generateKeyPairSigner(true);
  keypairs.push({
    index: index + 1,
    address: signer.address,
    secretKey: await exportSolanaSecretKey(signer),
  });
}

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const filename = `solana-keypairs-${timestamp}-${randomUUID().slice(0, 8)}.txt`;
const outputPath = resolve(outputDirectory, filename);
const payload = {
  warning: "PRIVATE KEYS — anyone with this file controls these wallets. Do not commit or share it.",
  format: "Each secretKey is a Solana CLI-compatible 64-byte array: 32-byte seed + 32-byte public key.",
  createdAt: new Date().toISOString(),
  count,
  keypairs,
};

await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600,
});

console.log(`Generated ${count} Solana keypair${count === 1 ? "" : "s"}.`);
console.log(`Private output: ${outputPath}`);
console.log("Public addresses:");
for (const keypair of keypairs) console.log(`  ${keypair.index}. ${keypair.address}`);

async function exportSolanaSecretKey(signer: KeyPairSigner): Promise<number[]> {
  const [privateKeyPkcs8, publicKeyRaw] = await Promise.all([
    crypto.subtle.exportKey("pkcs8", signer.keyPair.privateKey),
    crypto.subtle.exportKey("raw", signer.keyPair.publicKey),
  ]);
  const privateKey = new Uint8Array(privateKeyPkcs8).slice(16);
  const publicKey = new Uint8Array(publicKeyRaw);
  if (privateKey.byteLength !== 32 || publicKey.byteLength !== 32) {
    throw new Error("Unexpected Ed25519 key length; refusing to write an incompatible keypair");
  }
  return [...privateKey, ...publicKey];
}
