import * as dotenv from "dotenv";
import { resolve } from "node:path";
import {
  address,
  blockhash,
  createNoopSigner,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getTransactionSize,
  lamports,
  type Address,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  buildV1Transaction,
  V1_MAX_COMPUTE_UNIT_LIMIT,
  V1_MAX_LOADED_ACCOUNTS_DATA_SIZE_LIMIT,
} from "@solana-workbench/transaction-v1";
import { rpcCall } from "@solana-workbench/delivery-sdk";

dotenv.config({ path: resolve("src/.env") });

const sourceValue = process.argv[2] ?? process.env.V1_SOURCE_ADDRESS;
const network = process.argv[3] === "mainnet" ? "mainnet" : "devnet";
if (!sourceValue) {
  throw new Error("Usage: npm run measure:v1 -- SOURCE_ADDRESS [devnet|mainnet]");
}
const source = address(sourceValue);
const apiKey = process.env.HELIUS_API_KEY;
if (!apiKey) throw new Error("HELIUS_API_KEY is missing from src/.env");
const rpcUrl = `https://${network}.helius-rpc.com/?api-key=${apiKey}`;

const latest = await rpcCall<{
  value: { blockhash: string; lastValidBlockHeight: number };
}>(rpcUrl, "getLatestBlockhash", [{ commitment: "confirmed" }]);
const recipientLamports = BigInt(await rpcCall<number>(
  rpcUrl,
  "getMinimumBalanceForRentExemption",
  [0, { commitment: "confirmed" }],
));
const recipients = await Promise.all(Array.from({ length: 63 }, () => generateKeyPairSigner()));
const tipAccount = address("4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE");

const shapes = [
  { route: "economy/custom", tipLamports: 0n },
  { route: "fast", tipLamports: 5_000n },
  { route: "max", tipLamports: 1_000_000n },
] as const;

for (const shape of shapes) {
  const result = await findMaximum(shape.tipLamports);
  console.log(JSON.stringify({
    transactionVersion: 1,
    network,
    route: shape.route,
    ...result,
  }));
}

async function findMaximum(tipLamports: bigint): Promise<{
  recipients: number;
  transactionSizeBytes: number;
  unitsConsumed: number;
  loadedAccountsDataSize: number;
}> {
  let low = 1;
  let high = recipients.length;
  let best: Awaited<ReturnType<typeof simulate>> | null = null;
  let lastFailure: Error | null = null;
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    try {
      const result = await simulate(count, tipLamports);
      best = result;
      low = count + 1;
    } catch (reason) {
      lastFailure = reason instanceof Error ? reason : new Error(String(reason));
      high = count - 1;
    }
  }
  if (!best) throw lastFailure ?? new Error("Even one v1 recipient failed simulation");
  return best;
}

async function simulate(count: number, tipLamports: bigint) {
  const instructions = recipients.slice(0, count).map((recipient) =>
    transfer(source, recipient.address, recipientLamports));
  if (tipLamports > 0n) instructions.push(transfer(source, tipAccount, tipLamports));
  const transaction = buildV1Transaction({
    feePayer: createNoopSigner(source),
    lifetime: {
      blockhash: blockhash(latest.value.blockhash),
      lastValidBlockHeight: BigInt(latest.value.lastValidBlockHeight),
    },
    instructions,
    config: {
      computeUnitLimit: V1_MAX_COMPUTE_UNIT_LIMIT,
      loadedAccountsDataSizeLimit: V1_MAX_LOADED_ACCOUNTS_DATA_SIZE_LIMIT,
      priorityFeeLamports: 0n,
    },
  });
  const simulation = await rpcCall<{
    value: {
      err: unknown;
      logs?: string[] | null;
      unitsConsumed?: number;
      loadedAccountsDataSize?: number;
    };
  }>(rpcUrl, "simulateTransaction", [
    getBase64EncodedWireTransaction(transaction),
    {
      encoding: "base64",
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "confirmed",
    },
  ]);
  if (simulation.value.err) {
    throw new Error(`${JSON.stringify(simulation.value.err)}\n${simulation.value.logs?.join("\n") ?? ""}`);
  }
  return {
    recipients: count,
    transactionSizeBytes: getTransactionSize(transaction),
    unitsConsumed: simulation.value.unitsConsumed ?? 0,
    loadedAccountsDataSize: simulation.value.loadedAccountsDataSize ?? 0,
  };
}

function transfer(sourceAddress: Address, destination: Address, amount: bigint) {
  return getTransferSolInstruction({
    source: createNoopSigner(sourceAddress),
    destination,
    amount: lamports(amount),
  });
}
