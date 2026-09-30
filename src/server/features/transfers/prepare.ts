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
  SharePlan,
  ConsolidationPlan,
} from "../../../shared/contracts";
import { CONSOLIDATION_SIGNATURE_LIMITS } from "../../../shared/contracts";
import { deliveryAdapters, transferPlugins } from "../../../shared/plugin-registry";
import {
  getFeePayer,
  getTransferTotal,
  parseTransferPlanInput,
  solToLamports,
} from "../../../shared/schema";
import { buildPreparedTransaction } from "../../../shared/transaction";
import { quoteRate } from "./delivery";
import { rpcCall } from "../../infrastructure/rpc";
import {
  fetchUsefulLookupTables,
  resolveLookupTableReceivers,
  selectUsefulLookupTables,
} from "../address-lookup-tables/selection";

const TIP_ACCOUNTS = [
  "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE",
  "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
  "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta",
  "5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn",
];
const SIMULATION_BLOCKHASH = "11111111111111111111111111111111";

interface LatestBlockhash {
  value: { blockhash: string; lastValidBlockHeight: number };
}

interface MultipleAccountsResult {
  value: Array<{ lamports: number } | null>;
}

interface SimulationResult {
  value: {
    err: unknown;
    logs?: string[] | null;
    unitsConsumed?: number;
    loadedAccountsDataSize?: number;
  };
}

interface PriorityFeeResult {
  priorityFeeEstimate?: number;
}

export interface StoredPreparation {
  preparation: Preparation;
  messageBase64: string;
}

export async function prepareTransactions(
  input: PrepareRequest,
  rpcUrl: string,
  distributorProgramId?: string,
): Promise<StoredPreparation[]> {
  validateNetwork(input.network);
  validateTransactionVersion(input.transactionVersion);
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
  const usesDistributor = input.transactionVersion === 0 &&
    pluginId === "native-sol-transfer" && plan.type === "share";
  const usesV1SystemShare = input.transactionVersion === 1 &&
    pluginId === "native-sol-transfer" && plan.type === "share";
  if (usesDistributor) {
    if (!distributorProgramId) {
      throw new Error(`DISTRIBUTOR_PROGRAM_ID_${input.network.toUpperCase()} is not configured`);
    }
    address(distributorProgramId);
  }

  const delivery = deliveryAdapters.get(input.preset);
  if (!delivery.supports(input.network)) {
    throw new Error(`${delivery.label} is only available on mainnet`);
  }

  const feePayer = getFeePayer(plan);
  const declaredSigners = plugin.requiredSigners({ plan, network: input.network }).map(String);
  const requiredSigners = [...new Set([...declaredSigners, feePayer])];
  const tipAccount = delivery.requiresTipAccount ? selectTipAccount() : undefined;
  const [balances, allAddressLookupTables] = await Promise.all([
    fetchBalances(rpcUrl, [...new Set([...requiredSigners, ...wallets(plan)])]),
    input.transactionVersion === 0
      ? fetchUsefulLookupTables(
          rpcUrl,
          plan.addressLookupTables ?? [],
          [...wallets(plan), ...(tipAccount ? [tipAccount] : [])].filter(
            (wallet) => !requiredSigners.includes(wallet),
          ),
        )
      : Promise.resolve({}),
  ]);
  validateTransferBalances(plan, feePayer, balances);
  const requestedSignatures = validateConsolidationSignatureLimit(input, plan);
  const inputPlans = plan.type === "consolidation"
    ? splitConsolidationPlan(plan, requestedSignatures)
    : [plan];

  const makeSimulationCommon = (candidatePlan: TransferPlan): PreparationCommon => {
    const candidateFeePayer = getFeePayer(candidatePlan);
    const candidateSigners = plugin.requiredSigners({ plan: candidatePlan, network: input.network }).map(String);
    return {
      network: input.network,
      preset: input.preset,
      transactionVersion: input.transactionVersion,
      pluginId,
      normalizedAlias,
      feePayer: candidateFeePayer,
      requiredSigners: [...new Set([...candidateSigners, candidateFeePayer])],
      recentBlockhash: SIMULATION_BLOCKHASH,
      lastValidBlockHeight: "0",
      tipAccount,
      balances,
      expiresAtBlockHeight: "0",
      distributorProgramId,
    };
  };

  const simulationCommon = makeSimulationCommon(plan);
  const provisionalQuote = await delivery.quote({
    network: input.network,
    preset: input.preset,
    transactionVersion: input.transactionVersion,
    computeUnitLimit: 1_000,
    recommendedMicroLamports: 0,
    signerCount: simulationCommon.requiredSigners.length,
    transferLamports: getTransferTotal(plan),
  });
  const plans = usesDistributor || usesV1SystemShare
    ? (await findLargestValidShareBatches(
        plan as SharePlan,
        simulationCommon,
        allAddressLookupTables,
        provisionalQuote,
        rpcUrl,
      )).map((item) => ({ ...item, common: simulationCommon }))
    : await Promise.all(inputPlans.map(async (candidatePlan) => {
        const common = makeSimulationCommon(candidatePlan);
        const candidateQuote = await delivery.quote({
          network: input.network,
          preset: input.preset,
          transactionVersion: input.transactionVersion,
          computeUnitLimit: 1_000,
          recommendedMicroLamports: 0,
          signerCount: common.requiredSigners.length,
          transferLamports: getTransferTotal(candidatePlan),
        });
        return {
          plan: candidatePlan,
          common,
          ...(await simulatePlan(candidatePlan, common, allAddressLookupTables, candidateQuote, rpcUrl)),
        };
      }));

  // Candidate simulations replace their blockhash at the RPC. Fetch the real
  // shared blockhash only after the slow batch search has completed.
  const latest = await rpcCall<LatestBlockhash>(rpcUrl, "getLatestBlockhash", [
    { commitment: "confirmed" },
  ]);
  const stored = await Promise.all(plans.map(async (item): Promise<StoredPreparation> => {
    const common: PreparationCommon = {
      ...item.common,
      recentBlockhash: latest.value.blockhash,
      lastValidBlockHeight: latest.value.lastValidBlockHeight.toString(),
      expiresAtBlockHeight: latest.value.lastValidBlockHeight.toString(),
    };
    const recommendedMicroLamports = input.preset === "economy" || input.preset === "custom"
      ? 0
      : await fetchPriorityFee(rpcUrl, wallets(item.plan));
    const computeUnitLimit = Math.min(1_400_000, Math.max(1_000, Math.ceil(item.units * 1.1)));
    const loadedAccountsDataSizeLimit = input.transactionVersion === 1
      ? Math.min(64 * 1024 * 1024, Math.max(1, Math.ceil((item.loadedAccountsDataSize ?? 1) * 1.1)))
      : undefined;
    const quoteWithoutCount = await delivery.quote({
      network: input.network,
      preset: input.preset,
      transactionVersion: input.transactionVersion,
      computeUnitLimit,
      recommendedMicroLamports,
      signerCount: common.requiredSigners.length,
      transferLamports: getTransferTotal(item.plan),
    });
    const quote: TransactionQuote = {
      transactionCount: plans.length,
      ...quoteWithoutCount,
    };
    const preparation = makePreparation(
      item.plan,
      common,
      selectBatchLookupTables(allAddressLookupTables, item.plan, common.requiredSigners, tipAccount),
      quote,
      computeUnitLimit,
      quoteRate(quoteWithoutCount, computeUnitLimit),
      loadedAccountsDataSizeLimit,
    );
    const transaction = await buildPreparedTransaction(preparation);
    assertIsTransactionWithinSizeLimit(transaction);
    if (input.transactionVersion === 1) {
      await estimateComputeUnits(rpcUrl, getBase64EncodedWireTransaction(transaction));
    }
    const finalPreparation = {
      ...preparation,
      transactionSizeBytes: getTransactionSize(transaction),
    };
    return {
      preparation: finalPreparation,
      messageBase64: Buffer.from(transaction.messageBytes).toString("base64"),
    };
  }));

  validateAggregateBalances(plan, balances, stored.map(({ preparation }) => preparation));
  return stored;
}

type PreparationCommon = Omit<Preparation,
  "preparationId" | "normalizedPlan" | "computeUnitLimit" |
  "microLamportsPerComputeUnit" | "transactionSizeBytes" | "quote" |
  "addressLookupTables" | "loadedAccountsDataSizeLimit"
>;

function makePreparation(
  plan: TransferPlan,
  common: PreparationCommon,
  addressLookupTables: Record<string, string[]>,
  quote: TransactionQuote,
  computeUnitLimit: number,
  microLamportsPerComputeUnit: number,
  loadedAccountsDataSizeLimit?: number,
): Preparation {
  return {
    ...common,
    preparationId: crypto.randomUUID(),
    normalizedPlan: plan,
    computeUnitLimit,
    microLamportsPerComputeUnit,
    ...(loadedAccountsDataSizeLimit === undefined ? {} : { loadedAccountsDataSizeLimit }),
    transactionSizeBytes: 0,
    quote,
    addressLookupTables,
  };
}

async function findLargestValidShareBatches(
  plan: SharePlan,
  common: PreparationCommon,
  lookupTables: Record<string, string[]>,
  provisionalQuote: Omit<TransactionQuote, "transactionCount">,
  rpcUrl: string,
): Promise<Array<{ plan: SharePlan; units: number; loadedAccountsDataSize?: number }>> {
  const first = await findLargestValidShareBatch(
    plan,
    common,
    lookupTables,
    provisionalQuote,
    rpcUrl,
  );
  const batchSize = first.plan.receivers.length;
  if (batchSize === plan.receivers.length) return [first];

  const remainingPlans: SharePlan[] = [];
  for (let offset = batchSize; offset < plan.receivers.length; offset += batchSize) {
    remainingPlans.push({
      ...plan,
      receivers: plan.receivers.slice(offset, offset + batchSize),
    });
  }

  const remainingBatches = await Promise.all(remainingPlans.map(async (candidate) => {
    try {
      return [{
        plan: candidate,
        ...(await simulatePlan(candidate, common, lookupTables, provisionalQuote, rpcUrl)),
      }];
    } catch {
      // A different ALT/account layout can make a later chunk larger than the
      // first one. Repartition only that chunk while other chunks continue.
      return findLargestValidShareBatches(
        candidate,
        common,
        lookupTables,
        provisionalQuote,
        rpcUrl,
      );
    }
  }));

  return [first, ...remainingBatches.flat()];
}

async function findLargestValidShareBatch(
  plan: SharePlan,
  common: PreparationCommon,
  lookupTables: Record<string, string[]>,
  provisionalQuote: Omit<TransactionQuote, "transactionCount">,
  rpcUrl: string,
): Promise<{ plan: SharePlan; units: number; loadedAccountsDataSize?: number }> {
  let low = 1;
  let high = plan.receivers.length;
  let best: { plan: SharePlan; units: number; loadedAccountsDataSize?: number } | null = null;
  let firstFailure: Error | null = null;

  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const candidate = { ...plan, receivers: plan.receivers.slice(0, count) };
    try {
      const estimate = await simulatePlan(candidate, common, lookupTables, provisionalQuote, rpcUrl);
      best = { plan: candidate, ...estimate };
      low = count + 1;
    } catch (reason) {
      firstFailure = reason instanceof Error ? reason : new Error(String(reason));
      high = count - 1;
    }
  }

  if (!best) throw firstFailure ?? new Error("One recipient cannot fit in a transaction");
  return best;
}

async function simulatePlan(
  plan: TransferPlan,
  common: PreparationCommon,
  lookupTables: Record<string, string[]>,
  provisionalQuote: Omit<TransactionQuote, "transactionCount">,
  rpcUrl: string,
): Promise<{ units: number; loadedAccountsDataSize?: number }> {
  const preparation = makePreparation(
    plan,
    common,
    selectBatchLookupTables(lookupTables, plan, common.requiredSigners, common.tipAccount),
    { transactionCount: 1, ...provisionalQuote },
    1_400_000,
    common.preset === "economy" || common.preset === "custom" ? 0 : 1,
    common.transactionVersion === 1 ? 64 * 1024 * 1024 : undefined,
  );
  const transaction = await buildPreparedTransaction(preparation);
  assertIsTransactionWithinSizeLimit(transaction);
  const estimate = await estimateComputeUnits(rpcUrl, getBase64EncodedWireTransaction(transaction));
  if (common.transactionVersion === 1 && estimate.loadedAccountsDataSize === undefined) {
    throw new Error("RPC simulation did not return loadedAccountsDataSize required by v1");
  }
  return estimate;
}

function selectBatchLookupTables(
  lookupTables: Record<string, string[]>,
  plan: TransferPlan,
  requiredSigners: readonly string[],
  tipAccount?: string,
): Record<string, string[]> {
  return selectUsefulLookupTables(
    lookupTables,
    [...wallets(plan), ...(tipAccount ? [tipAccount] : [])]
      .filter((wallet) => !requiredSigners.includes(wallet)),
  );
}

function validateNetwork(value: string): asserts value is Network {
  if (value !== "devnet" && value !== "mainnet") throw new Error("Invalid network");
}

function validateTransactionVersion(value: unknown): asserts value is 0 | 1 {
  if (value !== 0 && value !== 1) throw new Error("Transaction version must be 0 or 1");
}

function validateConsolidationSignatureLimit(input: PrepareRequest, plan: TransferPlan): number {
  const maximum = CONSOLIDATION_SIGNATURE_LIMITS[input.transactionVersion];
  if (plan.type !== "consolidation") return maximum;
  const value = input.signaturesPerTransaction ?? maximum;
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`Signatures per transaction must be an integer from 1 to ${maximum} for v${input.transactionVersion}`);
  }
  return value;
}

export function splitConsolidationPlan(plan: ConsolidationPlan, signatureLimit: number): ConsolidationPlan[] {
  const batches: ConsolidationPlan[] = [];
  for (let offset = 0; offset < plan.senders.length;) {
    let senderCount = signatureLimit;
    if (plan.feePayer) {
      const fullCandidate = plan.senders.slice(offset, offset + signatureLimit);
      if (!fullCandidate.some((sender) => sender.address === plan.feePayer)) senderCount -= 1;
    }
    if (senderCount < 1) {
      throw new Error("At least 2 signatures per transaction are required when a separate fee payer signs each batch");
    }
    const senders = plan.senders.slice(offset, offset + senderCount);
    batches.push({ ...plan, senders });
    offset += senders.length;
  }
  return batches;
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
  const batches: string[][] = [];

  // Solana RPC permits up to 100 addresses per getMultipleAccounts request. A single batch
  // replaces the previous one-request-per-wallet burst for every valid v0 transaction.
  for (let offset = 0; offset < uniqueAddresses.length; offset += 100) {
    batches.push(uniqueAddresses.slice(offset, offset + 100));
  }

  const entries = (await Promise.all(batches.map(async (batch) => {
    const response = await rpcCall<MultipleAccountsResult>(rpcUrl, "getMultipleAccounts", [
      batch,
      { commitment: "confirmed", encoding: "base64", dataSlice: { offset: 0, length: 0 } },
    ]);
    if (response.value.length !== batch.length) {
      throw new Error("RPC returned an incomplete balance batch");
    }
    return response.value.map(
      (account, index) => [batch[index]!, String(account?.lamports ?? 0)] as const,
    );
  }))).flat();
  return Object.fromEntries(entries);
}

async function estimateComputeUnits(
  rpcUrl: string,
  wireTransaction: string,
): Promise<{ units: number; loadedAccountsDataSize?: number }> {
  const simulation = await rpcCall<SimulationResult>(rpcUrl, "simulateTransaction", [
    wireTransaction,
    {
      encoding: "base64",
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "confirmed",
    },
  ]);
  if (simulation.value.err) {
    const logs = simulation.value.logs?.join("\n") ?? "no program logs";
    throw new Error(`Transaction candidate simulation failed: ${JSON.stringify(simulation.value.err)}\n${logs}`);
  }
  return {
    units: simulation.value.unitsConsumed ?? 1_000,
    ...(simulation.value.loadedAccountsDataSize === undefined
      ? {}
      : { loadedAccountsDataSize: simulation.value.loadedAccountsDataSize }),
  };
}

async function fetchPriorityFee(rpcUrl: string, accountKeys: string[]): Promise<number> {
  const result = await rpcCall<PriorityFeeResult>(rpcUrl, "getPriorityFeeEstimate", [
    { accountKeys, options: { recommended: true } },
  ]);
  return Math.max(0, Math.floor(result.priorityFeeEstimate ?? 0));
}

function validateTransferBalances(
  plan: TransferPlan,
  feePayer: string,
  balances: Record<string, string>,
): void {
  const required = new Map<string, bigint>();
  if (plan.type === "share") {
    required.set(plan.senders[0].address, getTransferTotal(plan));
  } else {
    for (const sender of plan.senders) required.set(sender.address, solToLamports(sender.amountSol));
  }

  required.set(feePayer, required.get(feePayer) ?? 0n);

  for (const [wallet, needed] of required) {
    const available = BigInt(balances[wallet] ?? "0");
    if (available < needed) {
      throw new Error(
        `Insufficient balance for ${wallet}: requires ${needed} lamports, has ${available}`,
      );
    }
  }
}

function validateAggregateBalances(
  plan: TransferPlan,
  balances: Record<string, string>,
  preparations: readonly Preparation[],
): void {
  const required = new Map<string, bigint>();
  if (plan.type === "share") {
    required.set(plan.senders[0].address, getTransferTotal(plan));
  } else {
    for (const sender of plan.senders) required.set(sender.address, solToLamports(sender.amountSol));
  }
  for (const preparation of preparations) {
    required.set(
      preparation.feePayer,
      (required.get(preparation.feePayer) ?? 0n) + BigInt(preparation.quote.totalFeeLamports),
    );
  }

  for (const [wallet, needed] of required) {
    const available = BigInt(balances[wallet] ?? "0");
    if (available < needed) {
      throw new Error(
        `Insufficient balance for ${wallet}: requires ${needed} lamports, has ${available}`,
      );
    }
  }
}
