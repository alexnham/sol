import {
  address,
  assertIsTransactionWithinSizeLimit,
  getBase64EncodedWireTransaction,
  getTransactionSize,
} from "@solana/kit";
import type {
  DeliveryPreset,
  Network,
  Preparation,
  PrepareRequest,
  TransactionQuote,
  TransferPlan,
} from "../shared/contracts";
import { deliveryAdapters, transferPlugins } from "../shared/plugin-registry";
import {
  getFeePayer,
  getTransferTotal,
  parseTransferPlanInput,
  solToLamports,
} from "../shared/schema";
import { buildPreparedTransaction } from "../shared/transaction";
import { quoteRate } from "./delivery";
import { rpcCall } from "./rpc";
import {
  fetchUsefulLookupTables,
  resolveLookupTableReceivers,
} from "./address-lookup-tables";

const TIP_ACCOUNTS = [
  "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE",
  "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
  "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta",
  "5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn",
];

interface LatestBlockhash {
  value: { blockhash: string; lastValidBlockHeight: number };
}

interface MultipleAccountsResult {
  value: Array<{ lamports: number } | null>;
}

interface SimulationResult {
  value: { err: unknown; unitsConsumed?: number };
}

interface PriorityFeeResult {
  priorityFeeEstimate?: number;
}

export interface StoredPreparation {
  preparation: Preparation;
  messageBase64: string;
}

export async function prepareTransaction(
  input: PrepareRequest,
  rpcUrl: string,
): Promise<StoredPreparation> {
  validateNetwork(input.network);
  const parsedInput = parseTransferPlanInput(input.plan);
  const plan = parsedInput.plan ?? await resolveLookupTableReceivers(
    rpcUrl,
    parsedInput.lookupPlan!,
  );
  const normalizedAlias = parsedInput.normalizedAlias;

  const pluginId = input.pluginId ?? plan.plugin ?? "native-sol-transfer";
  const plugin = transferPlugins.get(pluginId);
  if (!plugin.supports(plan, input.network)) {
    throw new Error(`${plugin.label} does not support ${input.network}`);
  }
  const pluginValidation = plugin.validate({ plan, network: input.network });
  if (!pluginValidation.ok) throw new Error(pluginValidation.errors.join("; "));

  const delivery = deliveryAdapters.get(input.preset);
  if (!delivery.supports(input.network)) {
    throw new Error(`${delivery.label} is only available on mainnet`);
  }

  const feePayer = getFeePayer(plan);
  const declaredSigners = plugin.requiredSigners({ plan, network: input.network }).map(String);
  const requiredSigners = [...new Set([...declaredSigners, feePayer])];
  const latest = await rpcCall<LatestBlockhash>(rpcUrl, "getLatestBlockhash", [
    { commitment: "confirmed" },
  ]);
  const balances = await fetchBalances(rpcUrl, [...new Set([...requiredSigners, ...wallets(plan)])]);
  const tipAccount = delivery.requiresTipAccount ? selectTipAccount() : undefined;
  const addressLookupTables = await fetchUsefulLookupTables(
    rpcUrl,
    plan.addressLookupTables ?? [],
    [...wallets(plan), ...(tipAccount ? [tipAccount] : [])].filter(
      (wallet) => !requiredSigners.includes(wallet),
    ),
  );

  const provisionalQuote = await delivery.quote({
    network: input.network,
    preset: input.preset,
    computeUnitLimit: 1_000,
    recommendedMicroLamports: 0,
    signerCount: requiredSigners.length,
    transferLamports: getTransferTotal(plan),
  });

  const basePreparation: Preparation = {
    preparationId: crypto.randomUUID(),
    network: input.network,
    preset: input.preset,
    pluginId,
    normalizedPlan: plan,
    normalizedAlias,
    feePayer,
    requiredSigners,
    recentBlockhash: latest.value.blockhash,
    lastValidBlockHeight: latest.value.lastValidBlockHeight.toString(),
    computeUnitLimit: 1_000,
    microLamportsPerComputeUnit: 0,
    transactionSizeBytes: 0,
    tipAccount,
    quote: { transactionCount: 1, ...provisionalQuote },
    balances,
    expiresAtBlockHeight: latest.value.lastValidBlockHeight.toString(),
    addressLookupTables,
  };

  validateNativeAccountLimit(basePreparation);
  const draft = await buildPreparedTransaction(basePreparation);
  assertIsTransactionWithinSizeLimit(draft);
  const units = await estimateComputeUnits(rpcUrl, getBase64EncodedWireTransaction(draft));
  const computeUnitLimit = Math.min(1_400_000, Math.max(1_000, Math.ceil(units * 1.1)));
  const recommendedMicroLamports =
    input.preset === "economy" ? 0 : await fetchPriorityFee(rpcUrl, wallets(plan));
  const quoteWithoutCount = await delivery.quote({
    network: input.network,
    preset: input.preset,
    computeUnitLimit,
    recommendedMicroLamports,
    signerCount: requiredSigners.length,
    transferLamports: getTransferTotal(plan),
  });
  const quote: TransactionQuote = { transactionCount: 1, ...quoteWithoutCount };

  const preparation: Preparation = {
    ...basePreparation,
    computeUnitLimit,
    microLamportsPerComputeUnit: quoteRate(quoteWithoutCount, computeUnitLimit),
    quote,
  };

  validateBalances(plan, preparation);
  validateNativeAccountLimit(preparation);
  const transaction = await buildPreparedTransaction(preparation);
  assertIsTransactionWithinSizeLimit(transaction);
  const transactionSizeBytes = getTransactionSize(transaction);
  if (transactionSizeBytes > 1_232) {
    throw new Error("The request cannot fit in one version-0 transaction");
  }

  const finalPreparation: Preparation = {
    ...preparation,
    transactionSizeBytes,
  };

  return {
    preparation: finalPreparation,
    messageBase64: Buffer.from(transaction.messageBytes).toString("base64"),
  };
}

function validateNativeAccountLimit(preparation: Preparation): void {
  if (preparation.pluginId !== "native-sol-transfer") return;
  const planAddresses = wallets(preparation.normalizedPlan);
  const accountAddresses = new Set([
    ...planAddresses,
    ...preparation.requiredSigners,
    "11111111111111111111111111111111",
    ...(preparation.microLamportsPerComputeUnit > 0
      ? ["ComputeBudget111111111111111111111111111111"]
      : []),
    ...(preparation.tipAccount ? [preparation.tipAccount] : []),
  ]);
  if (accountAddresses.size > 64) {
    throw new Error(
      `This transaction references ${accountAddresses.size} accounts; Solana v0 transactions allow at most 64, even with address lookup tables`,
    );
  }
}

function validateNetwork(value: string): asserts value is Network {
  if (value !== "devnet" && value !== "mainnet") throw new Error("Invalid network");
}

function wallets(plan: TransferPlan): string[] {
  return [...plan.senders, ...plan.receivers].map((wallet) => wallet.address);
}

function selectTipAccount(): string {
  return TIP_ACCOUNTS[Math.floor(Math.random() * TIP_ACCOUNTS.length)]!;
}

async function fetchBalances(rpcUrl: string, addresses: string[]): Promise<Record<string, string>> {
  const uniqueAddresses = [...new Set(addresses)];
  uniqueAddresses.forEach((wallet) => address(wallet));
  const entries: Array<readonly [string, string]> = [];

  // Solana RPC permits up to 100 addresses per getMultipleAccounts request. A single batch
  // replaces the previous one-request-per-wallet burst for every valid v0 transaction.
  for (let offset = 0; offset < uniqueAddresses.length; offset += 100) {
    const batch = uniqueAddresses.slice(offset, offset + 100);
    const response = await rpcCall<MultipleAccountsResult>(rpcUrl, "getMultipleAccounts", [
      batch,
      { commitment: "confirmed", encoding: "base64", dataSlice: { offset: 0, length: 0 } },
    ]);
    if (response.value.length !== batch.length) {
      throw new Error("RPC returned an incomplete balance batch");
    }
    response.value.forEach((account, index) => {
      entries.push([batch[index]!, String(account?.lamports ?? 0)] as const);
    });
  }
  return Object.fromEntries(entries);
}

async function estimateComputeUnits(rpcUrl: string, wireTransaction: string): Promise<number> {
  try {
    const simulation = await rpcCall<SimulationResult>(rpcUrl, "simulateTransaction", [
      wireTransaction,
      {
        encoding: "base64",
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: "confirmed",
      },
    ]);
    if (simulation.value.err) throw new Error(JSON.stringify(simulation.value.err));
    return simulation.value.unitsConsumed ?? 1_000;
  } catch {
    return 1_000;
  }
}

async function fetchPriorityFee(rpcUrl: string, accountKeys: string[]): Promise<number> {
  const result = await rpcCall<PriorityFeeResult>(rpcUrl, "getPriorityFeeEstimate", [
    { accountKeys, options: { recommended: true } },
  ]);
  return Math.max(0, Math.floor(result.priorityFeeEstimate ?? 0));
}

function validateBalances(plan: TransferPlan, preparation: Preparation): void {
  const required = new Map<string, bigint>();
  if (plan.type === "share") {
    required.set(plan.senders[0].address, getTransferTotal(plan));
  } else {
    for (const sender of plan.senders) required.set(sender.address, solToLamports(sender.amountSol));
  }

  const feeTotal = BigInt(preparation.quote.totalFeeLamports);
  required.set(preparation.feePayer, (required.get(preparation.feePayer) ?? 0n) + feeTotal);

  for (const [wallet, needed] of required) {
    const available = BigInt(preparation.balances[wallet] ?? "0");
    if (available < needed) {
      throw new Error(
        `Insufficient balance for ${wallet}: requires ${needed} lamports, has ${available}`,
      );
    }
  }
}
