import "./delivery";
import express, { type NextFunction, type Request, type Response } from "express";
import * as dotenv from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertIsFullySignedTransaction,
  getTransactionDecoder,
} from "@solana/kit";
import type { PrepareRequest, SubmitRequest } from "../shared/contracts";
import { deliveryAdapters, transferPlugins } from "../shared/plugin-registry";
import { prepareTransaction, type StoredPreparation } from "./prepare";
import { rpcCall } from "./rpc";
import { generateVaultKeys, listVaultKeys, signWithVaultKey } from "./key-vault";

const directory = fileURLToPath(new URL(".", import.meta.url));
dotenv.config({ path: resolve(directory, "../.env") });

const app = express();
const preparations = new Map<string, StoredPreparation>();
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";

app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

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

app.get("/api/keypairs", async (_request, response, next) => {
  try {
    response.json({ keypairs: await listVaultKeys() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/keypairs/generate", async (request, response, next) => {
  try {
    const count = Number((request.body as { count?: unknown }).count);
    response.status(201).json({ keypairs: await generateVaultKeys(count) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/keypairs/sign", async (request, response, next) => {
  try {
    const body = request.body as {
      preparationId?: unknown;
      address?: unknown;
      transaction?: unknown;
    };
    if (
      typeof body.preparationId !== "string" ||
      typeof body.address !== "string" ||
      typeof body.transaction !== "string"
    ) {
      throw new Error("Preparation, signer address, and transaction are required");
    }
    const stored = preparations.get(body.preparationId);
    if (!stored) throw new Error("Preparation not found or expired");
    if (!stored.preparation.requiredSigners.includes(body.address)) {
      throw new Error("This wallet is not a required signer for the prepared transaction");
    }
    const transaction = getTransactionDecoder().decode(Buffer.from(body.transaction, "base64"));
    if (Buffer.from(transaction.messageBytes).toString("base64") !== stored.messageBase64) {
      throw new Error("The signing request does not match the prepared immutable message");
    }
    response.json({ signature: await signWithVaultKey(body.address, body.transaction) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/prepare", async (request: Request, response: Response, next: NextFunction) => {
  try {
    const body = request.body as PrepareRequest;
    const rpcUrl = getRpcUrl(body.network);
    const stored = await prepareTransaction(body, rpcUrl);
    preparations.set(stored.preparation.preparationId, stored);
    prunePreparations();
    response.json(stored.preparation);
  } catch (error) {
    next(error);
  }
});

app.post("/api/submit", async (request: Request, response: Response, next: NextFunction) => {
  try {
    const body = request.body as SubmitRequest;
    const stored = preparations.get(body.preparationId);
    if (!stored) throw new Error("Preparation not found or expired; prepare the transaction again");
    if (typeof body.transaction !== "string" || body.transaction.length === 0) {
      throw new Error("A signed base64 transaction is required");
    }

    const transaction = getTransactionDecoder().decode(Buffer.from(body.transaction, "base64"));
    assertIsFullySignedTransaction(transaction);
    const submittedMessage = Buffer.from(transaction.messageBytes).toString("base64");
    if (submittedMessage !== stored.messageBase64) {
      throw new Error("Signed transaction does not match the prepared immutable message");
    }

    const rpcUrl = getRpcUrl(stored.preparation.network);
    const blockHeight = await rpcCall<number>(rpcUrl, "getBlockHeight", [{ commitment: "confirmed" }]);
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
  } catch (error) {
    next(error);
  }
});

const dist = resolve(directory, "../../dist");
if (existsSync(dist)) app.use(express.static(dist));

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : "Unexpected server error";
  response.status(400).json({ error: message });
});

app.listen(port, host, () => {
  console.log(`Solana workbench API listening on http://${host}:${port}`);
});

function getRpcUrl(network: string): string {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) throw new Error("HELIUS_API_KEY is missing from src/.env");
  const host = network === "devnet" ? "devnet" : network === "mainnet" ? "mainnet" : null;
  if (!host) throw new Error("Network must be devnet or mainnet");
  return `https://${host}.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;
}

function prunePreparations(): void {
  if (preparations.size <= 100) return;
  const oldest = preparations.keys().next().value as string | undefined;
  if (oldest) preparations.delete(oldest);
}
