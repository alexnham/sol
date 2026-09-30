import type { Application } from "express";
import type {
  CreateAirshipDropRequest,
  CreateTokenCollectionRequest,
  DecompressAirshipTokensRequest,
  PreviewTokenCollectionRequest,
} from "../../../shared/airship";
import { getRpcUrl } from "../../config";
import {
  createAirshipDrop,
  createTokenCollection,
  decompressAirshipTokens,
  getAirshipCompressedBalances,
  getAirshipDrop,
  getTokenCollection,
  listAirshipTokens,
  previewTokenCollection,
} from "../../features/airship";
import { getVaultSigner, listVaultKeys } from "../../infrastructure/key-vault";

export function registerAirshipRoutes(app: Application): void {
  app.get("/api/airship/tokens", async (request, response, next) => {
    try {
      const network = request.query.network;
      const owner = request.query.owner;
      if (network !== "devnet" && network !== "mainnet") throw new Error("Network must be devnet or mainnet");
      if (typeof owner !== "string") throw new Error("A managed wallet is required");
      await getVaultSigner(owner);
      response.json({ tokens: await listAirshipTokens(getRpcUrl(network), owner) });
    } catch (error) { next(error); }
  });

  app.get("/api/airship/compressed-balances", async (request, response, next) => {
    try {
      const network = request.query.network;
      const owner = request.query.owner;
      if (network !== "devnet" && network !== "mainnet") throw new Error("Network must be devnet or mainnet");
      if (typeof owner !== "string") throw new Error("A recipient address is required");
      response.json(await getAirshipCompressedBalances(getRpcUrl(network), owner));
    } catch (error) { next(error); }
  });

  app.post("/api/airship/drops", async (request, response, next) => {
    try {
      const body = request.body as CreateAirshipDropRequest;
      if (body.network !== "devnet" && body.network !== "mainnet") throw new Error("Network must be devnet or mainnet");
      if (typeof body.sender !== "string" || typeof body.mint !== "string") throw new Error("Sender and mint are required");
      if (typeof body.amountPerRecipient !== "string") throw new Error("Amount per recipient is required");
      response.status(202).json(await createAirshipDrop(getRpcUrl(body.network), body, await getVaultSigner(body.sender)));
    } catch (error) { next(error); }
  });

  app.post("/api/airship/decompress", async (request, response, next) => {
    try {
      const body = request.body as DecompressAirshipTokensRequest;
      if (body.network !== "devnet" && body.network !== "mainnet") throw new Error("Network must be devnet or mainnet");
      if (typeof body.owner !== "string" || typeof body.mint !== "string") throw new Error("Owner and mint are required");
      if (typeof body.amount !== "string") throw new Error("Decompression amount is required");
      response.json(await decompressAirshipTokens(getRpcUrl(body.network), body, await getVaultSigner(body.owner)));
    } catch (error) { next(error); }
  });

  app.get("/api/airship/drops/:id", (request, response, next) => {
    try { response.json(getAirshipDrop(request.params.id)); }
    catch (error) { next(error); }
  });

  app.post("/api/airship/collections/preview", async (request, response, next) => {
    try {
      const body = request.body as PreviewTokenCollectionRequest;
      if (body.network !== "devnet" && body.network !== "mainnet") throw new Error("Network must be devnet or mainnet");
      if (typeof body.destination !== "string" || typeof body.mint !== "string" || (body.sources !== undefined && !Array.isArray(body.sources))) {
        throw new Error("Destination and mint are required");
      }
      const managedKeys = await listVaultKeys();
      await getVaultSigner(body.destination);
      response.json(await previewTokenCollection(getRpcUrl(body.network), body, managedKeys.map((key) => key.address)));
    } catch (error) { next(error); }
  });

  app.post("/api/airship/collections", async (request, response, next) => {
    try {
      const body = request.body as CreateTokenCollectionRequest;
      if (body.network !== "devnet" && body.network !== "mainnet") throw new Error("Network must be devnet or mainnet");
      if (!Array.isArray(body.sources)) throw new Error("Select at least one source wallet");
      const managedKeys = await listVaultKeys();
      response.status(202).json(await createTokenCollection(getRpcUrl(body.network), body, getVaultSigner, managedKeys.map((key) => key.address)));
    } catch (error) { next(error); }
  });

  app.get("/api/airship/collections/:id", (request, response, next) => {
    try { response.json(getTokenCollection(request.params.id)); }
    catch (error) { next(error); }
  });
}
