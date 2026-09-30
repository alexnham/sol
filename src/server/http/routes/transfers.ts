import { assertIsFullySignedTransaction, getTransactionDecoder } from "@solana/kit";
import type { Application } from "express";
import type { PrepareRequest, SubmitRequest } from "../../../shared/contracts";
import { deliveryAdapters, transferPlugins } from "../../../shared/plugin-registry";
import { getDistributorProgramId, getRpcUrl } from "../../config";
import { prepareTransactions, type StoredPreparation } from "../../features/transfers";
import { rpcCall } from "../../infrastructure/rpc";

const preparations = new Map<string, StoredPreparation>();
const blockHeightReads = new Map<string, { expiresAt: number; promise: Promise<number> }>();

export function getPreparationStore(): ReadonlyMap<string, StoredPreparation> {
  return preparations;
}

export function registerTransferRoutes(app: Application): void {
  app.get("/api/plugins", (_request, response) => {
    response.json({
      transfer: transferPlugins.list().map(({ id, label }) => ({ id, label })),
      delivery: deliveryAdapters.list().map(({ id, label, speed, supports }) => ({
        id,
        label,
        speed,
        supportsDevnet: supports("devnet"),
        supportsMainnet: supports("mainnet"),
      })),
    });
  });

  app.post("/api/prepare", async (request, response, next) => {
    try {
      const body = request.body as PrepareRequest;
      const stored = await prepareTransactions(body, getRpcUrl(body.network), getDistributorProgramId(body.network));
      for (const item of stored) preparations.set(item.preparation.preparationId, item);
      prunePreparations();
      response.json({ preparations: stored.map(({ preparation }) => preparation) });
    } catch (error) { next(error); }
  });

  app.post("/api/submit", async (request, response, next) => {
    try {
      const body = request.body as SubmitRequest;
      const stored = preparations.get(body.preparationId);
      if (!stored) throw new Error("Preparation not found or expired; prepare the transaction again");
      if (typeof body.transaction !== "string" || body.transaction.length === 0) {
        throw new Error("A signed base64 transaction is required");
      }

      const transaction = getTransactionDecoder().decode(Buffer.from(body.transaction, "base64"));
      assertIsFullySignedTransaction(transaction);
      if (Buffer.from(transaction.messageBytes).toString("base64") !== stored.messageBase64) {
        throw new Error("Signed transaction does not match the prepared immutable message");
      }

      const rpcUrl = getRpcUrl(stored.preparation.network);
      const blockHeight = await getSharedBlockHeight(rpcUrl);
      if (BigInt(blockHeight) > BigInt(stored.preparation.lastValidBlockHeight)) {
        preparations.delete(body.preparationId);
        throw new Error("The prepared blockhash expired; prepare and sign again");
      }

      const adapter = deliveryAdapters.get(stored.preparation.preset);
      const result = await adapter.submit({
        network: stored.preparation.network,
        rpcUrl,
        wireTransaction: body.transaction,
        lastValidBlockHeight: BigInt(stored.preparation.lastValidBlockHeight),
      });
      preparations.delete(body.preparationId);
      response.json(result);
    } catch (error) { next(error); }
  });
}

function getSharedBlockHeight(rpcUrl: string): Promise<number> {
  const now = Date.now();
  const current = blockHeightReads.get(rpcUrl);
  if (current && current.expiresAt > now) return current.promise;

  const promise = rpcCall<number>(rpcUrl, "getBlockHeight", [{ commitment: "confirmed" }]);
  const entry = { expiresAt: now + 500, promise };
  blockHeightReads.set(rpcUrl, entry);
  void promise.catch(() => {
    if (blockHeightReads.get(rpcUrl) === entry) blockHeightReads.delete(rpcUrl);
  });
  return promise;
}

function prunePreparations(): void {
  if (preparations.size <= 100) return;
  const oldest = preparations.keys().next().value as string | undefined;
  if (oldest) preparations.delete(oldest);
}
