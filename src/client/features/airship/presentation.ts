import type { AirshipDropJob } from "../../../shared/airship";
import type { Network } from "../../../shared/contracts";

export function formatTokenUnits(value: string, decimals: number): string {
  const padded = value.padStart(decimals + 1, "0");
  const whole = decimals === 0 ? padded : padded.slice(0, -decimals);
  const fraction = decimals === 0 ? "" : padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

export function formatSol(lamports: string): string {
  const value = BigInt(lamports);
  const whole = value / 1_000_000_000n;
  const fraction = (value % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function normalizeTokenAmount(value: string): string {
  const [whole = "0", fraction = ""] = value.trim().split(".");
  const normalizedWhole = whole.replace(/^0+(?=\d)/, "") || "0";
  const normalizedFraction = fraction.replace(/0+$/, "");
  return normalizedFraction ? `${normalizedWhole}.${normalizedFraction}` : normalizedWhole;
}

export function airshipJobLabel(job: AirshipDropJob): string {
  if (job.state === "queued") return "Queued";
  if (job.state === "preparing") {
    return job.delivery === "airship" ? "Preparing compression pool" : "Preparing token accounts";
  }
  if (job.state === "sending") {
    return job.delivery === "airship" ? "Sending compressed tokens" : "Sending standard tokens";
  }
  if (job.state === "confirmed") return "Distribution confirmed";
  return "Distribution stopped";
}

export function explorerTransaction(signature: string, network: Network): string {
  const cluster = network === "devnet" ? "?cluster=devnet" : "";
  return `https://explorer.solana.com/tx/${signature}${cluster}`;
}

export function shortAddress(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-8)}`;
}
