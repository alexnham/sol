import * as dotenv from "dotenv";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  blockhash,
  createKeyPairSignerFromBytes,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getTransactionSize,
  lamports,
  partiallySignTransactionWithSigners,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  buildV1Transaction,
  buildV1TransactionMessage,
  estimateV1ResourceLimits,
  V1_MAX_COMPUTE_UNIT_LIMIT,
  V1_MAX_LOADED_ACCOUNTS_DATA_SIZE_LIMIT,
} from "@solana-workbench/transaction-v1";
import { rpcCall, sendRpc, waitForConfirmation } from "@solana-workbench/delivery-sdk";

dotenv.config({ path: resolve("src/.env") });

const keypairPath = process.argv[2];
if (!keypairPath) throw new Error("Usage: npm run smoke:v1 -- /path/to/devnet-keypair.json");
const apiKey = process.env.HELIUS_API_KEY;
if (!apiKey) throw new Error("HELIUS_API_KEY is missing from src/.env");
const rpcUrl = `https://devnet.helius-rpc.com/?api-key=${apiKey}`;

const secret = JSON.parse(await readFile(resolve(keypairPath), "utf8")) as unknown;
if (!Array.isArray(secret) || secret.length !== 64 || secret.some((byte) => !Number.isInteger(byte))) {
  throw new Error("The keypair file must contain a Solana CLI-compatible 64-byte array");
}
const payer = await createKeyPairSignerFromBytes(new Uint8Array(secret as number[]));
const recipient = await generateKeyPairSigner();
const recipientLamports = BigInt(await rpcCall<number>(
  rpcUrl,
  "getMinimumBalanceForRentExemption",
  [0, { commitment: "confirmed" }],
));
const latest = await rpcCall<{
  value: { blockhash: string; lastValidBlockHeight: number };
}>(rpcUrl, "getLatestBlockhash", [{ commitment: "confirmed" }]);
const lifetime = {
  blockhash: blockhash(latest.value.blockhash),
  lastValidBlockHeight: BigInt(latest.value.lastValidBlockHeight),
};
const instructions = [getTransferSolInstruction({
  source: payer,
  destination: recipient.address,
  amount: lamports(recipientLamports),
})];
const provisionalMessage = buildV1TransactionMessage({
  feePayer: payer,
  lifetime,
  instructions,
  config: {
    computeUnitLimit: V1_MAX_COMPUTE_UNIT_LIMIT,
    loadedAccountsDataSizeLimit: V1_MAX_LOADED_ACCOUNTS_DATA_SIZE_LIMIT,
    priorityFeeLamports: 0n,
  },
});
const estimate = await estimateV1ResourceLimits(provisionalMessage, rpcUrl);
const transaction = buildV1Transaction({
  feePayer: payer,
  lifetime,
  instructions,
  config: {
    computeUnitLimit: Math.min(1_400_000, Math.max(1_000, Math.ceil(estimate.computeUnitLimit * 1.1))),
    loadedAccountsDataSizeLimit: Math.min(
      64 * 1024 * 1024,
      Math.max(1, Math.ceil(estimate.loadedAccountsDataSizeLimit * 1.1)),
    ),
    priorityFeeLamports: 0n,
  },
});
const signed = await partiallySignTransactionWithSigners([payer], transaction);
const signature = await sendRpc(rpcUrl, getBase64EncodedWireTransaction(signed), false);
const status = await waitForConfirmation(rpcUrl, signature, lifetime.lastValidBlockHeight);

console.log(JSON.stringify({
  transactionVersion: 1,
  signature,
  status,
  recipient: recipient.address,
  transactionSizeBytes: getTransactionSize(signed),
  ...estimate,
}));
