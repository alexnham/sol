import {
  priorityQuote,
  sendRpc,
  submissionResult,
  waitForConfirmation,
  type DeliveryAdapter,
} from "@solana-workbench/delivery-sdk";

export const economyAdapter: DeliveryAdapter = {
  id: "economy",
  label: "Economy",
  speed: "standard",
  supports: () => true,
  quote: async (context) =>
    priorityQuote({ ...context, recommendedMicroLamports: 0 }, 0n, "standard"),
  submit: async (context) => {
    const started = Date.now();
    const signature = await sendRpc(context.rpcUrl, context.wireTransaction, false);
    const status = await waitForConfirmation(
      context.rpcUrl,
      signature,
      context.lastValidBlockHeight,
    );
    return submissionResult(signature, status, Date.now() - started, context.network);
  },
};
