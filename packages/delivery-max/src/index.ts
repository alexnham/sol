import {
  priorityQuote,
  sendViaHeliusSender,
  submissionResult,
  waitForConfirmation,
  type DeliveryAdapter,
} from "@solana-workbench/delivery-sdk";

export const MAX_TIP_LAMPORTS = 1_000_000n;

export const maxAdapter: DeliveryAdapter = {
  id: "max",
  label: "Sender Max",
  speed: "fastest",
  requiresTipAccount: true,
  supports: (network) => network === "mainnet",
  quote: async (context) => priorityQuote(context, MAX_TIP_LAMPORTS, "fastest"),
  submit: async (context) => {
    const started = Date.now();
    const signature = await sendViaHeliusSender(context.wireTransaction, false);
    const status = await waitForConfirmation(
      context.rpcUrl,
      signature,
      context.lastValidBlockHeight,
    );
    return submissionResult(signature, status, Date.now() - started, context.network);
  },
};
