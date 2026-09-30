import { CUSTOM_DISTRIBUTOR_PROGRAM_ID_DEVNET } from "@solana-workbench/delivery-custom";

export function getRpcUrl(network: string): string {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) throw new Error("HELIUS_API_KEY is missing from src/.env");

  const cluster = network === "devnet" ? "devnet" : network === "mainnet" ? "mainnet" : null;
  if (!cluster) throw new Error("Network must be devnet or mainnet");

  return `https://${cluster}.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;
}

export function getDistributorProgramId(network: string): string | undefined {
  if (network === "devnet") {
    return process.env.DISTRIBUTOR_PROGRAM_ID_DEVNET ?? CUSTOM_DISTRIBUTOR_PROGRAM_ID_DEVNET;
  }
  return network === "mainnet" ? process.env.DISTRIBUTOR_PROGRAM_ID_MAINNET : undefined;
}
