import {
  priorityQuote,
  sendViaHeliusSender,
  submissionResult,
  waitForConfirmation,
  type DeliveryAdapter,
} from "@solana-workbench/delivery-sdk";

export const FAST_TIP_LAMPORTS = 5_000n;

export const fastAdapter: DeliveryAdapter = {
  id: "fast",
  label: "Fast",
  speed: "fast",
  requiresTipAccount: true,
  supports: (network) => network === "mainnet",
  quote: async (context) => priorityQuote(context, FAST_TIP_LAMPORTS, "fast"),
  submit: async (context) => {
    const started = Date.now();
    const signature = await sendViaHeliusSender(context.wireTransaction, true);
    const status = await waitForConfirmation(
      context.rpcUrl,
      signature,
      context.lastValidBlockHeight,
    );
    return submissionResult(signature, status, Date.now() - started, context.network);
  },
};
