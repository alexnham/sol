import { address, createNoopSigner, lamports } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import type {
  DeliveryAdapter,
  TransferContext,
  TransferPlugin,
  ValidationResult,
} from "./contracts";
import { getDistributeSolInstruction } from "@solana-workbench/delivery-custom";
import { solToLamports } from "./schema";

class Registry<T extends { id: string }> {
  private readonly entries = new Map<string, T>();

  register(entry: T): void {
    if (this.entries.has(entry.id)) throw new Error(`Plugin id already registered: ${entry.id}`);
    this.entries.set(entry.id, entry);
  }

  get(id: string): T {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown plugin: ${id}`);
    return entry;
  }

  list(): T[] {
    return [...this.entries.values()];
  }
}

export const transferPlugins = new Registry<TransferPlugin>();
export const deliveryAdapters = new Registry<DeliveryAdapter>();

const valid = (): ValidationResult => ({ ok: true, errors: [] });

export const nativeSolTransferPlugin: TransferPlugin = {
  id: "native-sol-transfer",
  label: "Native SOL transfer",
  supports: () => true,
  validate: (_context: TransferContext) => valid(),
  requiredSigners: ({ plan }) => {
    const values = [
      ...plan.senders.map((sender) => sender.address),
      ...(plan.feePayer ? [plan.feePayer] : []),
    ];
    return [...new Set(values)].map((value) => address(value));
  },
  buildInstructions: async ({
    plan,
    transactionVersion,
    feePayer,
    distributorProgramId,
    tipAccount,
    tipLamports,
  }) => {
    if (transactionVersion === 0 && plan.type === "share" && !distributorProgramId) {
      throw new Error("A distributor Program ID is required for share transfers");
    }
    const transfers =
      plan.type === "share"
        ? plan.receivers.map((receiver) => ({
            source: plan.senders[0].address,
            destination: receiver.address,
            amount: receiver.amountSol,
          }))
        : plan.senders.map((sender) => ({
            source: sender.address,
            destination: plan.receivers[0].address,
            amount: sender.amountSol,
          }));

    const instructions = transactionVersion === 0 && plan.type === "share"
      ? [getDistributeSolInstruction(
          createNoopSigner(address(plan.senders[0].address)),
          plan.receivers.map((receiver) => address(receiver.address)),
          plan.receivers.map((receiver) => solToLamports(receiver.amountSol)),
          distributorProgramId!,
        )]
      : transfers.map((transfer) =>
          getTransferSolInstruction({
            source: createNoopSigner(address(transfer.source)),
            destination: address(transfer.destination),
            amount: lamports(solToLamports(transfer.amount)),
          }),
        );

    if (tipAccount && tipLamports > 0n) {
      instructions.push(
        getTransferSolInstruction({
          source: createNoopSigner(feePayer),
          destination: tipAccount,
          amount: lamports(tipLamports),
        }),
      );
    }

    return instructions;
  },
};

transferPlugins.register(nativeSolTransferPlugin);

export function registerTransferPlugin(plugin: TransferPlugin): void {
  transferPlugins.register(plugin);
}

export function registerDeliveryAdapter(adapter: DeliveryAdapter): void {
  deliveryAdapters.register(adapter);
}
