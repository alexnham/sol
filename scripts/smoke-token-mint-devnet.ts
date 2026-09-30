import * as dotenv from "dotenv";
import { resolve } from "node:path";
import { getVaultSigner } from "../src/server/infrastructure/key-vault";
import { createTokenMint } from "../src/server/features/token-mints";

dotenv.config({ path: resolve(process.cwd(), "src/.env") });

if (process.env.RUN_DEVNET_SMOKE !== "1") {
  throw new Error("Set RUN_DEVNET_SMOKE=1 to acknowledge that this creates a real devnet mint");
}
const authorityAddress = process.env.SMOKE_TOKEN_MINT_AUTHORITY;
if (!authorityAddress) throw new Error("SMOKE_TOKEN_MINT_AUTHORITY must name a managed Keygen wallet");
const apiKey = process.env.HELIUS_API_KEY;
if (!apiKey) throw new Error("HELIUS_API_KEY is missing from src/.env");

const authority = await getVaultSigner(authorityAddress);
const result = await createTokenMint(
  `https://devnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`,
  {
    network: "devnet",
    transactionVersion: 0,
    name: "Workbench smoke token",
    symbol: "SMOKE",
    decimals: 9,
    initialSupply: "1",
    mintAuthority: authorityAddress,
    freezeAuthority: authorityAddress,
    revokeMintAuthority: false,
    revokeFreezeAuthority: false,
    tokenProgram: "token2022",
    metadataUri: "",
    imageUrl: "",
  },
  authority,
  authority,
);

console.log(JSON.stringify(result, null, 2));
