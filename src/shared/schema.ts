import { address } from "@solana/kit";
import { z } from "zod";
import type { TransferPlan } from "./contracts";

const SOL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/;

const addressSchema = z.string().trim().min(1).superRefine((value, ctx) => {
  try {
    address(value);
  } catch {
    ctx.addIssue({ code: "custom", message: "Invalid Solana address" });
  }
});

const amountSchema = z
  .string()
  .trim()
  .regex(SOL_PATTERN, "Use a positive SOL decimal with at most 9 places")
  .refine((value) => solToLamports(value) > 0n, "Amount must be greater than zero");

const walletSchema = z.object({ address: addressSchema }).strict();
const walletAmountSchema = walletSchema.extend({ amountSol: amountSchema }).strict();

const shareSchema = z
  .object({
    type: z.literal("share"),
    senders: z.tuple([walletSchema]),
    receivers: z.array(walletAmountSchema).min(1),
    feePayer: addressSchema.optional(),
    plugin: z.string().min(1).optional(),
  })
  .strict();

const consolidationSchema = z
  .object({
    type: z.literal("consolidation"),
    senders: z.array(walletAmountSchema).min(1),
    receivers: z.tuple([walletSchema]),
    feePayer: addressSchema.optional(),
    plugin: z.string().min(1).optional(),
  })
  .strict();

const planSchema = z.discriminatedUnion("type", [shareSchema, consolidationSchema]);

export class PlanValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(issues.join("; "));
    this.name = "PlanValidationError";
  }
}

export function solToLamports(value: string): bigint {
  if (!SOL_PATTERN.test(value)) throw new Error("Invalid SOL amount");
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0"));
}

export function lamportsToSol(value: bigint): string {
  const whole = value / 1_000_000_000n;
  const fraction = (value % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function parseTransferPlan(input: unknown): {
  plan: TransferPlan;
  normalizedAlias: boolean;
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new PlanValidationError(["The JSON root must be an object"]);
  }

  const source = { ...(input as Record<string, unknown>) };
  const hasAlias = "recievers" in source;
  if (hasAlias && "receivers" in source) {
    throw new PlanValidationError(["Use either receivers or recievers, not both"]);
  }
  if (hasAlias) {
    source.receivers = source.recievers;
    delete source.recievers;
  }

  const result = planSchema.safeParse(source);
  if (!result.success) {
    throw new PlanValidationError(
      result.error.issues.map((issue) => {
        const location = issue.path.length ? issue.path.join(".") : "plan";
        return `${location}: ${issue.message}`;
      }),
    );
  }

  const plan = result.data as TransferPlan;
  const senderAddresses = plan.senders.map((entry) => entry.address);
  const receiverAddresses = plan.receivers.map((entry) => entry.address);
  const duplicate = [...senderAddresses, ...receiverAddresses].find(
    (item, index, all) => all.indexOf(item) !== index,
  );
  if (duplicate) {
    throw new PlanValidationError([`Wallet ${duplicate} is duplicated or used on both sides`]);
  }

  return { plan, normalizedAlias: hasAlias };
}

export function getFeePayer(plan: TransferPlan): string {
  return plan.feePayer ?? plan.senders[0].address;
}

export function getTransferTotal(plan: TransferPlan): bigint {
  const amounts = plan.type === "share" ? plan.receivers : plan.senders;
  return amounts.reduce((total, entry) => total + solToLamports(entry.amountSol), 0n);
}
