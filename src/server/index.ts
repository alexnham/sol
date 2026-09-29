import "./delivery";
import express, { type NextFunction, type Request, type Response } from "express";
import * as dotenv from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  address,
  assertIsFullySignedTransaction,
  createSolanaRpc,
  fetchAddressesForLookupTables,
  getTransactionDecoder,
} from "@solana/kit";
import { CUSTOM_DISTRIBUTOR_PROGRAM_ID_DEVNET } from "@solana-workbench/delivery-custom";
import type { PrepareRequest, SubmitRequest } from "../shared/contracts";
import { deliveryAdapters, transferPlugins } from "../shared/plugin-registry";
import { prepareTransactions, type StoredPreparation } from "./prepare";
import { rpcCall } from "./rpc";
import { generateVaultKeys, getVaultSigner, listVaultKeys, signWithVaultKey } from "./key-vault";
import { createAddressLookupTable } from "./create-address-lookup-table";
import { listStoredAddressLookupTables, recordAddressLookupTable } from "./alt-registry";
import { createTokenMint, listTokenMints, manageTokenMint, validateTokenMintRequest } from "./token-mints";
import type { CreateTokenMintRequest, ManageTokenMintRequest } from "../shared/token-mints";
import { createLiquidityPool, listLiquidityPools, manageLiquidityPool } from "./liquidity";
import type { CreateLiquidityPoolRequest, ManageLiquidityPoolRequest } from "../shared/liquidity";
import { createAirshipDrop, createTokenCollection, decompressAirshipTokens, getAirshipCompressedBalances, getAirshipDrop, getTokenCollection, listAirshipTokens, previewTokenCollection } from "./airship";
import type { CreateAirshipDropRequest, CreateTokenCollectionRequest, DecompressAirshipTokensRequest, PreviewTokenCollectionRequest } from "../shared/airship";

const directory = fileURLToPath(new URL(".", import.meta.url));
dotenv.config({ path: resolve(directory, "../.env") });

const app = express();
const preparations = new Map<string, StoredPreparation>();
const altCreationLocks = new Set<string>();
const blockHeightReads = new Map<string, { expiresAt: number; promise: Promise<number> }>();
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

app.get("/api/address-lookup-tables", async (_request, response, next) => {
  try {
    response.json({ addressLookupTables: await listStoredAddressLookupTables() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/address-lookup-tables/register", async (request, response, next) => {
  try {
    const body = request.body as { network?: unknown; address?: unknown };
    if (body.network !== "devnet" && body.network !== "mainnet") {
      throw new Error("Network must be devnet or mainnet");
    }
    if (typeof body.address !== "string") throw new Error("An ALT address is required");
    const tableAddress = address(body.address);
    const fetched = await fetchAddressesForLookupTables(
      [tableAddress],
      createSolanaRpc(getRpcUrl(body.network)),
      { commitment: "confirmed" },
    );
    const addresses = fetched[tableAddress]?.map(String);
    if (!addresses) throw new Error(`Address lookup table ${tableAddress} was not found`);
    const stored = await recordAddressLookupTable({
      address: tableAddress,
      addressCount: addresses.length,
      addresses,
      signatures: [],
      network: body.network,
      createdAt: new Date().toISOString(),
    });
    response.status(201).json(stored);
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

app.get("/api/token-mints", async (request, response, next) => {
  try {
    const network = request.query.network;
    if (network !== "devnet" && network !== "mainnet") throw new Error("Network must be devnet or mainnet");
    response.json({ tokenMints: await listTokenMints(getRpcUrl(network), network) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/token-mints", async (request, response, next) => {
  try {
    const body = request.body as CreateTokenMintRequest;
    const input = validateTokenMintRequest(body);
    const mintAuthority = await getVaultSigner(input.mintAuthority);
    const freezeAuthority = input.freezeAuthority === null
      ? null
      : input.freezeAuthority === input.mintAuthority
        ? mintAuthority
        : await getVaultSigner(input.freezeAuthority!);
    response.status(201).json(await createTokenMint(
      getRpcUrl(input.network),
      body,
      mintAuthority,
      freezeAuthority,
    ));
  } catch (error) {
    next(error);
  }
});

app.post("/api/token-mints/manage", async (request, response, next) => {
  try {
    response.json(await manageTokenMint(
      getRpcUrl((request.body as ManageTokenMintRequest).network),
      request.body as ManageTokenMintRequest,
      getVaultSigner,
    ));
  } catch (error) {
    next(error);
  }
});

app.get("/api/liquidity-pools", async (request, response, next) => {
  try {
    const network = request.query.network;
    if (network !== "devnet" && network !== "mainnet") throw new Error("Network must be devnet or mainnet");
    response.json({ liquidityPools: await listLiquidityPools(getRpcUrl(network), network) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/liquidity-pools", async (request, response, next) => {
  try {
    const body = request.body as CreateLiquidityPoolRequest;
    response.status(201).json(await createLiquidityPool(getRpcUrl(body.network), body, await getVaultSigner(body.provider)));
  } catch (error) {
    next(error);
  }
});

app.post("/api/liquidity-pools/manage", async (request, response, next) => {
  try {
    const body = request.body as ManageLiquidityPoolRequest;
    response.json(await manageLiquidityPool(getRpcUrl(body.network), body, await getVaultSigner(body.provider)));
  } catch (error) {
    next(error);
  }
});

app.get("/api/airship/tokens", async (request, response, next) => {
  try {
    const network = request.query.network;
    const owner = request.query.owner;
    if (network !== "devnet" && network !== "mainnet") throw new Error("Network must be devnet or mainnet");
    if (typeof owner !== "string") throw new Error("A managed wallet is required");
    await getVaultSigner(owner);
    response.json({ tokens: await listAirshipTokens(getRpcUrl(network), owner) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/airship/compressed-balances", async (request, response, next) => {
  try {
    const network = request.query.network;
    const owner = request.query.owner;
    if (network !== "devnet" && network !== "mainnet") throw new Error("Network must be devnet or mainnet");
    if (typeof owner !== "string") throw new Error("A recipient address is required");
    response.json(await getAirshipCompressedBalances(getRpcUrl(network), owner));
  } catch (error) {
    next(error);
  }
});

app.post("/api/airship/drops", async (request, response, next) => {
  try {
    const body = request.body as CreateAirshipDropRequest;
    if (body.network !== "devnet" && body.network !== "mainnet") throw new Error("Network must be devnet or mainnet");
    if (typeof body.sender !== "string" || typeof body.mint !== "string") throw new Error("Sender and mint are required");
    if (typeof body.amountPerRecipient !== "string") throw new Error("Amount per recipient is required");
    response.status(202).json(await createAirshipDrop(
      getRpcUrl(body.network),
      body,
      await getVaultSigner(body.sender),
    ));
  } catch (error) {
    next(error);
  }
});

app.post("/api/airship/decompress", async (request, response, next) => {
  try {
    const body = request.body as DecompressAirshipTokensRequest;
    if (body.network !== "devnet" && body.network !== "mainnet") throw new Error("Network must be devnet or mainnet");
    if (typeof body.owner !== "string" || typeof body.mint !== "string") throw new Error("Owner and mint are required");
    if (typeof body.amount !== "string") throw new Error("Decompression amount is required");
    response.json(await decompressAirshipTokens(
      getRpcUrl(body.network),
      body,
      await getVaultSigner(body.owner),
    ));
  } catch (error) {
    next(error);
  }
});

app.get("/api/airship/drops/:id", (request, response, next) => {
  try {
    response.json(getAirshipDrop(request.params.id));
  } catch (error) {
    next(error);
  }
});

app.post("/api/airship/collections/preview", async (request, response, next) => {
  try {
    const body = request.body as PreviewTokenCollectionRequest;
    if (body.network !== "devnet" && body.network !== "mainnet") throw new Error("Network must be devnet or mainnet");
    if (typeof body.destination !== "string" || typeof body.mint !== "string" || !Array.isArray(body.sources)) throw new Error("Destination, mint, and sources are required");
    await Promise.all([getVaultSigner(body.destination), ...body.sources.map((source) => getVaultSigner(source.owner))]);
    response.json(await previewTokenCollection(getRpcUrl(body.network), body));
  } catch (error) { next(error); }
});

app.post("/api/airship/collections", async (request, response, next) => {
  try {
    const body = request.body as CreateTokenCollectionRequest;
    if (body.network !== "devnet" && body.network !== "mainnet") throw new Error("Network must be devnet or mainnet");
    response.status(202).json(await createTokenCollection(getRpcUrl(body.network), body, getVaultSigner));
  } catch (error) { next(error); }
});

app.get("/api/airship/collections/:id", (request, response, next) => {
  try { response.json(getTokenCollection(request.params.id)); }
  catch (error) { next(error); }
});

app.post("/api/address-lookup-tables", async (request, response, next) => {
  const body = request.body as { network?: unknown; authority?: unknown; addresses?: unknown };
  const lockKey = `${body.network}:${body.authority}`;
  let ownsLock = false;
  try {
    if (body.network !== "devnet" && body.network !== "mainnet") {
      throw new Error("Network must be devnet or mainnet");
    }
    if (typeof body.authority !== "string") throw new Error("A managed ALT authority is required");
    if (!Array.isArray(body.addresses)) throw new Error("ALT addresses must be an array");
    if (altCreationLocks.has(lockKey)) {
      throw new Error("An ALT is already being created by this authority");
    }
    const tableAddresses = body.addresses.map((value) => {
      if (typeof value !== "string") throw new Error("Every ALT entry must be an address");
      return address(value);
    });
    altCreationLocks.add(lockKey);
    ownsLock = true;
    const rpcUrl = getRpcUrl(body.network);
    const authority = await getVaultSigner(body.authority);
    const result = await createAddressLookupTable(
      rpcUrl,
      body.network,
      authority,
      tableAddresses,
    );
    const stored = await recordAddressLookupTable({
      ...result,
      addresses: [...new Set(tableAddresses.map(String))],
      createdAt: new Date().toISOString(),
    });
    response.status(201).json(stored);
  } catch (error) {
    next(error);
  } finally {
    if (ownsLock) altCreationLocks.delete(lockKey);
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
    const stored = await prepareTransactions(body, rpcUrl, getDistributorProgramId(body.network));
    for (const item of stored) preparations.set(item.preparation.preparationId, item);
    prunePreparations();
    response.json({ preparations: stored.map(({ preparation }) => preparation) });
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
  } catch (error) {
    next(error);
  }
});

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

function getDistributorProgramId(network: string): string | undefined {
  return network === "devnet"
    ? process.env.DISTRIBUTOR_PROGRAM_ID_DEVNET ?? CUSTOM_DISTRIBUTOR_PROGRAM_ID_DEVNET
    : network === "mainnet"
      ? process.env.DISTRIBUTOR_PROGRAM_ID_MAINNET
      : undefined;
}

function prunePreparations(): void {
  if (preparations.size <= 100) return;
  const oldest = preparations.keys().next().value as string | undefined;
  if (oldest) preparations.delete(oldest);
}
