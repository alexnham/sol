import type { Application } from "express";
import type { CreateLiquidityPoolRequest, ManageLiquidityPoolRequest } from "../../../shared/liquidity";
import { getRpcUrl } from "../../config";
import { createLiquidityPool, listLiquidityPools, manageLiquidityPool } from "../../features/liquidity";
import { getVaultSigner } from "../../infrastructure/key-vault";

export function registerLiquidityRoutes(app: Application): void {
  app.get("/api/liquidity-pools", async (request, response, next) => {
    try {
      const network = request.query.network;
      if (network !== "devnet" && network !== "mainnet") throw new Error("Network must be devnet or mainnet");
      response.json({ liquidityPools: await listLiquidityPools(getRpcUrl(network), network) });
    } catch (error) { next(error); }
  });

  app.post("/api/liquidity-pools", async (request, response, next) => {
    try {
      const body = request.body as CreateLiquidityPoolRequest;
      response.status(201).json(await createLiquidityPool(getRpcUrl(body.network), body, await getVaultSigner(body.provider)));
    } catch (error) { next(error); }
  });

  app.post("/api/liquidity-pools/manage", async (request, response, next) => {
    try {
      const body = request.body as ManageLiquidityPoolRequest;
      response.json(await manageLiquidityPool(getRpcUrl(body.network), body, await getVaultSigner(body.provider)));
    } catch (error) { next(error); }
  });
}
