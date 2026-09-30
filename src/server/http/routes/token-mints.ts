import type { Application } from "express";
import type { CreateTokenMintRequest, ManageTokenMintRequest } from "../../../shared/token-mints";
import { getRpcUrl } from "../../config";
import { createTokenMint, listTokenMints, manageTokenMint, validateTokenMintRequest } from "../../features/token-mints";
import { getVaultSigner } from "../../infrastructure/key-vault";

export function registerTokenMintRoutes(app: Application): void {
  app.get("/api/token-mints", async (request, response, next) => {
    try {
      const network = request.query.network;
      if (network !== "devnet" && network !== "mainnet") throw new Error("Network must be devnet or mainnet");
      response.json({ tokenMints: await listTokenMints(getRpcUrl(network), network) });
    } catch (error) { next(error); }
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
          : await getVaultSigner(input.freezeAuthority);
      response.status(201).json(await createTokenMint(getRpcUrl(input.network), body, mintAuthority, freezeAuthority));
    } catch (error) { next(error); }
  });

  app.post("/api/token-mints/manage", async (request, response, next) => {
    try {
      const body = request.body as ManageTokenMintRequest;
      response.json(await manageTokenMint(getRpcUrl(body.network), body, getVaultSigner));
    } catch (error) { next(error); }
  });
}
