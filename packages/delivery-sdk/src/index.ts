export type Network = "devnet" | "mainnet";
export type DeliveryPreset = "economy" | "custom" | "fast" | "max";
export type DeliverySpeed = "standard" | "fast" | "fastest";

export interface TransactionQuote {
  transactionCount: number;
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
  transactionVersion: 0 | 1;
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
  const maxAttempts = 4;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
    });
    if (!response.ok) {
      const responseText = await response.text();
      if (response.status === 429 && attempt + 1 < maxAttempts) {
        await delay(retryDelayMs(response.headers.get("retry-after"), attempt));
        continue;
      }
      throw new Error(`RPC ${response.status}: ${responseText}`);
    }

    const body = (await response.json()) as RpcEnvelope<T>;
    if (body.error) {
      if (body.error.code === -32429 && attempt + 1 < maxAttempts) {
        await delay(retryDelayMs(null, attempt));
        continue;
      }
      throw new Error(`${body.error.message} (${body.error.code})`);
    }
    if (body.result === undefined) throw new Error(`RPC ${method} returned no result`);
    return body.result;
  }
  throw new Error(`RPC ${method} exhausted its retry limit`);
}

function retryDelayMs(retryAfter: string | null, attempt: number): number {
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(5_000, seconds * 1_000);
  }
  return Math.min(2_000, 250 * (2 ** attempt));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
