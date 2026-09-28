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
  const maxAttempts = 8;
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
  const baseDelay = Math.min(4_000, 250 * (2 ** attempt));
  const jitter = Math.floor(Math.random() * baseDelay);
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(5_000, seconds * 1_000) + jitter;
    }
  }
  return baseDelay + jitter;
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
  return new Promise((resolve, reject) => {
    const key = `${rpcUrl}\n${lastValidBlockHeight}`;
    let group = confirmationGroups.get(key);
    if (!group) {
      group = { rpcUrl, lastValidBlockHeight, waiters: new Map() };
      confirmationGroups.set(key, group);
      // Allow concurrently broadcast transactions to join the same first poll.
      setTimeout(() => void pollConfirmationGroup(key, group!), 25);
    }
    const waiter: ConfirmationWaiter = {
      startedAt: Date.now(),
      timeoutMs,
      resolve,
      reject,
    };
    const current = group.waiters.get(signature) ?? [];
    current.push(waiter);
    group.waiters.set(signature, current);
  });
}

interface ConfirmationWaiter {
  startedAt: number;
  timeoutMs: number;
  resolve(status: "confirmed" | "pending"): void;
  reject(reason: unknown): void;
}

interface ConfirmationGroup {
  rpcUrl: string;
  lastValidBlockHeight: bigint;
  waiters: Map<string, ConfirmationWaiter[]>;
}

const confirmationGroups = new Map<string, ConfirmationGroup>();

async function pollConfirmationGroup(key: string, group: ConfirmationGroup): Promise<void> {
  try {
    while (group.waiters.size > 0) {
      const signatures = [...group.waiters.keys()];
      try {
        const statuses = await rpcCall<{
          value: Array<null | { err: unknown; confirmationStatus?: string }>;
        }>(group.rpcUrl, "getSignatureStatuses", [signatures, { searchTransactionHistory: true }]);

        statuses.value.forEach((status, index) => {
          const signature = signatures[index];
          if (!signature || !status) return;
          if (status.err) {
            settleConfirmation(group, signature, "reject", new Error(
              `Transaction ${signature} failed: ${JSON.stringify(status.err)}`,
            ));
          } else if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
            settleConfirmation(group, signature, "resolve", "confirmed");
          }
        });

        if (group.waiters.size > 0) {
          const height = await rpcCall<number>(group.rpcUrl, "getBlockHeight", [{ commitment: "confirmed" }]);
          if (BigInt(height) > group.lastValidBlockHeight) {
            for (const pendingSignature of [...group.waiters.keys()]) {
              settleConfirmation(group, pendingSignature, "reject", new Error(
                `Transaction ${pendingSignature} blockhash expired before confirmation`,
              ));
            }
          }
        }
      } catch {
        // A submitted transaction must not be reported as failed merely because
        // the confirmation RPC was temporarily rate limited. Keep polling until
        // its timeout and report it as pending if status remains unavailable.
      }

      const now = Date.now();
      for (const [pendingSignature, waiters] of group.waiters) {
        const active = waiters.filter((waiter) => {
          if (now - waiter.startedAt < waiter.timeoutMs) return true;
          waiter.resolve("pending");
          return false;
        });
        if (active.length > 0) group.waiters.set(pendingSignature, active);
        else group.waiters.delete(pendingSignature);
      }
      if (group.waiters.size > 0) await delay(2_000);
    }
  } finally {
    confirmationGroups.delete(key);
  }
}

function settleConfirmation(
  group: ConfirmationGroup,
  signature: string,
  action: "resolve" | "reject",
  value: "confirmed" | Error,
): void {
  const waiters = group.waiters.get(signature) ?? [];
  group.waiters.delete(signature);
  for (const waiter of waiters) {
    if (action === "resolve") waiter.resolve(value as "confirmed");
    else waiter.reject(value);
  }
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
