import "../features/transfers/delivery";
import express, { type Application, type NextFunction, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import { registerAirshipRoutes } from "./routes/airship";
import { registerLiquidityRoutes } from "./routes/liquidity";
import { registerTokenMintRoutes } from "./routes/token-mints";
import { getPreparationStore, registerTransferRoutes } from "./routes/transfers";
import { registerWalletRoutes } from "./routes/wallets";

export function createApp(staticDirectory?: string): Application {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/health", (_request, response) => response.json({ ok: true }));

  registerTransferRoutes(app);
  registerWalletRoutes(app, getPreparationStore());
  registerTokenMintRoutes(app);
  registerLiquidityRoutes(app);
  registerAirshipRoutes(app);

  if (staticDirectory && existsSync(staticDirectory)) app.use(express.static(staticDirectory));

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : "Unexpected server error";
    response.status(400).json({ error: message });
  });

  return app;
}
