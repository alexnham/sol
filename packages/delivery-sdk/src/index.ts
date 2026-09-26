export type Network = "devnet" | "mainnet";
export type DeliveryPreset = "economy" | "fast" | "max";
export type DeliverySpeed = "standard" | "fast" | "fastest";

export interface TransactionQuote {
  transactionCount: 1;
  transferLamports: string;
  baseFeeLamports: string;
  priorityFeeLamports: string;
  senderTipLamports: string;
  totalFeeLamports: string;
  speed: DeliverySpeed;
}

export interface SubmissionResult {
  signature: string;
  status: "confirmed" | "pending";
  confirmationMs: number;
  explorerUrl: string;
}

export interface DeliveryQuoteContext {
  network: Network;
  preset: DeliveryPreset;
  computeUnitLimit: number;
  recommendedMicroLamports: number;
  signerCount: number;
  transferLamports: bigint;
}

export interface DeliverySubmitContext {
  network: Network;
  wireTransaction: string;
  rpcUrl: string;
  lastValidBlockHeight: bigint;
}

export interface DeliveryAdapter {
  id: DeliveryPreset | string;
  label: string;
  speed: DeliverySpeed;
  requiresTipAccount?: boolean;
  supports(network: Network): boolean;
  quote(context: DeliveryQuoteContext): Promise<Omit<TransactionQuote, "transactionCount">>;
  submit(context: DeliverySubmitContext): Promise<SubmissionResult>;
}

interface RpcEnvelope<T> {
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

export async function rpcCall<T>(rpcUrl: string, method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
  if (!response.ok) throw new Error(`RPC ${response.status}: ${await response.text()}`);
  const body = (await response.json()) as RpcEnvelope<T>;
  if (body.error) throw new Error(`${body.error.message} (${body.error.code})`);
  if (body.result === undefined) throw new Error(`RPC ${method} returned no result`);
  return body.result;
}

export async function waitForConfirmation(
  rpcUrl: string,
  signature: string,
  lastValidBlockHeight: bigint,
  timeoutMs = 60_000,
): Promise<"confirmed" | "pending"> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const statuses = await rpcCall<{
      value: Array<null | { err: unknown; confirmationStatus?: string }>;
    }>(rpcUrl, "getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
    const status = statuses.value[0];
    if (status?.err) throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      return "confirmed";
    }
    const height = await rpcCall<number>(rpcUrl, "getBlockHeight", [{ commitment: "confirmed" }]);
    if (BigInt(height) > lastValidBlockHeight) {
      throw new Error("The transaction blockhash expired before confirmation");
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return "pending";
}

export function priorityQuote(
  context: DeliveryQuoteContext,
  tipLamports: bigint,
  speed: DeliverySpeed,
  priorityFeeCapLamports = 100_000n,
): Omit<TransactionQuote, "transactionCount"> {
  const capRate = Math.floor(Number(priorityFeeCapLamports * 1_000_000n) / context.computeUnitLimit);
  const rate = Math.max(0, Math.min(context.recommendedMicroLamports, capRate));
  const priority = BigInt(Math.ceil((rate * context.computeUnitLimit) / 1_000_000));
  const base = BigInt(context.signerCount) * 5_000n;
  return {
    transferLamports: context.transferLamports.toString(),
    baseFeeLamports: base.toString(),
    priorityFeeLamports: priority.toString(),
    senderTipLamports: tipLamports.toString(),
    totalFeeLamports: (base + priority + tipLamports).toString(),
    speed,
  };
}

export async function sendRpc(
  rpcUrl: string,
  wireTransaction: string,
  skipPreflight: boolean,
): Promise<string> {
  return rpcCall<string>(rpcUrl, "sendTransaction", [
    wireTransaction,
    { encoding: "base64", skipPreflight, maxRetries: skipPreflight ? 0 : 3 },
  ]);
}

export async function sendViaHeliusSender(
  wireTransaction: string,
  swqosOnly: boolean,
): Promise<string> {
  const endpoint = `https://sender.helius-rpc.com/fast${swqosOnly ? "?swqos_only=true" : ""}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now().toString(),
      method: "sendTransaction",
      params: [wireTransaction, { encoding: "base64", skipPreflight: true, maxRetries: 0 }],
    }),
  });
  if (!response.ok) throw new Error(`Sender ${response.status}: ${await response.text()}`);
  const body = (await response.json()) as { result?: string; error?: unknown };
  if (body.error) throw new Error(`Sender rejected transaction: ${JSON.stringify(body.error)}`);
  if (!body.result) throw new Error("Sender returned no transaction signature");
  return body.result;
}

export function submissionResult(
  signature: string,
  status: "confirmed" | "pending",
  confirmationMs: number,
  network: Network,
): SubmissionResult {
  const cluster = network === "mainnet" ? "mainnet-beta" : "devnet";
  return {
    signature,
    status,
    confirmationMs,
    explorerUrl: `https://orb.helius.dev/tx/${signature}?cluster=${cluster}`,
  };
}

export function quoteRate(
  quote: Omit<TransactionQuote, "transactionCount">,
  computeUnitLimit: number,
): number {
  if (computeUnitLimit === 0) return 0;
  return Math.floor((Number(quote.priorityFeeLamports) * 1_000_000) / computeUnitLimit);
}
