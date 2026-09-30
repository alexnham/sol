import * as dotenv from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./http/app";

const directory = fileURLToPath(new URL(".", import.meta.url));
dotenv.config({ path: resolve(directory, "../.env") });

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const app = createApp(resolve(directory, "../../dist"));

app.listen(port, host, () => {
  console.log(`Solana workbench API listening on http://${host}:${port}`);
});
