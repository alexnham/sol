import { createKeyPairSignerFromBytes } from "@solana/kit";
import bs58 from "bs58";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

const yes = process.argv.includes("--yes");
const unexpectedArguments = process.argv.slice(2).filter((argument) => argument !== "--yes");
if (unexpectedArguments.length > 0) {
  throw new Error(
    "Do not pass a private key as an argument because it can be saved in shell history. " +
    "Run `npm run import-key` and paste it at the hidden prompt.",
  );
}

const encodedPrivateKey = (await readPrivateKey()).trim();
if (!encodedPrivateKey) throw new Error("No private key was provided");

let secretKey: Uint8Array;
try {
  secretKey = bs58.decode(encodedPrivateKey);
} catch {
  throw new Error("The private key is not valid base58");
}

if (secretKey.byteLength !== 64) {
  throw new Error(
    `Expected a base58-encoded 64-byte Solana private key, but decoded ${secretKey.byteLength} bytes`,
  );
}

const signer = await createKeyPairSignerFromBytes(secretKey);
const encodedPublicKey = bs58.decode(String(signer.address));
if (!equalBytes(secretKey.subarray(32), encodedPublicKey)) {
  throw new Error("The public-key bytes embedded in this private key do not match its derived address");
}

console.log(`Derived public address: ${signer.address}`);
if (!yes && process.stdin.isTTY && !(await confirmImport())) {
  console.log("Import cancelled; no file was written.");
  process.exit(0);
}
if (!yes && !process.stdin.isTTY) {
  throw new Error("Piped input requires --yes after you have verified the derived address");
}

const outputDirectory = resolve("generated-keys");
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
await chmod(outputDirectory, 0o700);

const createdAt = new Date().toISOString();
const timestamp = createdAt.replace(/[:.]/g, "-");
const filename = `solana-imported-key-${timestamp}-${randomUUID().slice(0, 8)}.txt`;
const outputPath = resolve(outputDirectory, filename);
const payload = {
  warning: "PRIVATE KEYS — anyone with this file controls these wallets. Do not commit or share it.",
  format: "Each secretKey is a Solana CLI-compatible 64-byte array: 32-byte seed + 32-byte public key.",
  createdAt,
  count: 1,
  keypairs: [{ index: 1, address: signer.address, secretKey: [...secretKey] }],
};

await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600,
});

console.log(`Imported key: ${outputPath}`);
console.log("Restart the server, or refresh the workbench if it is already watching this directory.");

async function readPrivateKey(): Promise<string> {
  if (!process.stdin.isTTY) {
    let input = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) input += chunk;
    return input;
  }

  const mutedOutput = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const prompt = createInterface({ input: process.stdin, output: mutedOutput, terminal: true });
  process.stdout.write("Paste the base58 private key (input hidden): ");
  try {
    return await prompt.question("");
  } finally {
    prompt.close();
    process.stdout.write("\n");
  }
}

async function confirmImport(): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question("Does this address match your wallet? Import it? [y/N] ");
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    prompt.close();
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}
