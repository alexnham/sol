import { address, createSolanaRpc, fetchAddressesForLookupTables, getTransactionDecoder } from "@solana/kit";
import type { Application } from "express";
import { getRpcUrl } from "../../config";
import {
  createAddressLookupTable,
  listStoredAddressLookupTables,
  recordAddressLookupTable,
} from "../../features/address-lookup-tables";
import {
  generateVaultKeys,
  getVaultSigner,
  listVaultKeys,
  signWithVaultKey,
} from "../../infrastructure/key-vault";
import type { StoredPreparation } from "../../features/transfers";
import { parseWalletPortfolioNetwork, scanManagedWalletPortfolio } from "../../features/wallets/portfolio";

const altCreationLocks = new Set<string>();

export function registerWalletRoutes(
  app: Application,
  preparations: ReadonlyMap<string, StoredPreparation>,
): void {
  app.get("/api/wallets/portfolio", async (request, response, next) => {
    try {
      const network = parseWalletPortfolioNetwork(request.query.network);
      const keys = await listVaultKeys();
      response.json(await scanManagedWalletPortfolio(
        getRpcUrl(network),
        network,
        keys.map((key) => key.address),
      ));
    } catch (error) { next(error); }
  });

  app.get("/api/keypairs", async (_request, response, next) => {
    try { response.json({ keypairs: await listVaultKeys() }); }
    catch (error) { next(error); }
  });

  app.post("/api/keypairs/generate", async (request, response, next) => {
    try {
      const count = Number((request.body as { count?: unknown }).count);
      response.status(201).json({ keypairs: await generateVaultKeys(count) });
    } catch (error) { next(error); }
  });

  app.get("/api/address-lookup-tables", async (_request, response, next) => {
    try { response.json({ addressLookupTables: await listStoredAddressLookupTables() }); }
    catch (error) { next(error); }
  });

  app.post("/api/address-lookup-tables/register", async (request, response, next) => {
    try {
      const body = request.body as { network?: unknown; address?: unknown };
      if (body.network !== "devnet" && body.network !== "mainnet") throw new Error("Network must be devnet or mainnet");
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
    } catch (error) { next(error); }
  });

  app.post("/api/address-lookup-tables", async (request, response, next) => {
    const body = request.body as { network?: unknown; authority?: unknown; addresses?: unknown };
    const lockKey = `${body.network}:${body.authority}`;
    let ownsLock = false;
    try {
      if (body.network !== "devnet" && body.network !== "mainnet") throw new Error("Network must be devnet or mainnet");
      if (typeof body.authority !== "string") throw new Error("A managed ALT authority is required");
      if (!Array.isArray(body.addresses)) throw new Error("ALT addresses must be an array");
      if (altCreationLocks.has(lockKey)) throw new Error("An ALT is already being created by this authority");

      const tableAddresses = body.addresses.map((value) => {
        if (typeof value !== "string") throw new Error("Every ALT entry must be an address");
        return address(value);
      });
      altCreationLocks.add(lockKey);
      ownsLock = true;

      const result = await createAddressLookupTable(
        getRpcUrl(body.network),
        body.network,
        await getVaultSigner(body.authority),
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
      const body = request.body as { preparationId?: unknown; address?: unknown; transaction?: unknown };
      if (typeof body.preparationId !== "string" || typeof body.address !== "string" || typeof body.transaction !== "string") {
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
    } catch (error) { next(error); }
  });
}
