import type {
  DeliveryPreset,
  Network,
  PluginCatalog,
  Preparation,
  SubmissionResult,
  TransactionVersion,
} from "../shared/contracts";
import type { CreateTokenMintRequest, ManageTokenMintRequest, TokenMintActionResult, TrackedTokenMint } from "../shared/token-mints";
import type { CreateLiquidityPoolRequest, LiquidityActionResult, ManageLiquidityPoolRequest, TrackedLiquidityPool } from "../shared/liquidity";

export interface VaultKeyMetadata {
  address: string;
  file: string;
  createdAt: string;
}

export interface CreatedAddressLookupTable {
  address: string;
  authority: string;
  addressCount: number;
  signatures: string[];
  network: Network;
  createdAt: string;
}

export interface StoredAddressLookupTable {
  address: string;
  authority?: string;
  addressCount: number;
  signatures: string[];
  network: Network;
  createdAt: string;
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  console.log("test: ", path)
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

export function prepareTransfer(
  plan: unknown,
  network: Network,
  preset: DeliveryPreset,
  pluginId: string,
  transactionVersion: TransactionVersion,
): Promise<Preparation[]> {
  return request<{ preparations: Preparation[] }>("/api/prepare", {
    method: "POST",
    body: JSON.stringify({ plan, network, preset, pluginId, transactionVersion }),
  }).then((result) => result.preparations);
}

export function fetchPlugins(): Promise<PluginCatalog> {
  return request("/api/plugins", { method: "GET" });
}

export function submitTransfer(
  preparationId: string,
  transaction: string,
): Promise<SubmissionResult> {
  return request("/api/submit", {
    method: "POST",
    body: JSON.stringify({ preparationId, transaction }),
  });
}

export async function fetchVaultKeys(): Promise<VaultKeyMetadata[]> {
  const result = await request<{ keypairs: VaultKeyMetadata[] }>("/api/keypairs", { method: "GET" });
  return result.keypairs;
}

export async function generateVaultKeys(count: number): Promise<VaultKeyMetadata[]> {
  const result = await request<{ keypairs: VaultKeyMetadata[] }>("/api/keypairs/generate", {
    method: "POST",
    body: JSON.stringify({ count }),
  });
  return result.keypairs;
}

export function createAddressLookupTable(
  network: Network,
  authority: string,
  addresses: string[],
): Promise<CreatedAddressLookupTable> {
  return request("/api/address-lookup-tables", {
    method: "POST",
    body: JSON.stringify({ network, authority, addresses }),
  });
}

export async function fetchAddressLookupTables(): Promise<StoredAddressLookupTable[]> {
  const result = await request<{ addressLookupTables: StoredAddressLookupTable[] }>(
    "/api/address-lookup-tables",
    { method: "GET" },
  );
  return result.addressLookupTables ?? [];
}

export function registerAddressLookupTable(
  network: Network,
  tableAddress: string,
): Promise<StoredAddressLookupTable> {
  return request("/api/address-lookup-tables/register", {
    method: "POST",
    body: JSON.stringify({ network, address: tableAddress }),
  });
}

export function requestVaultSignature(
  preparationId: string,
  signerAddress: string,
  transaction: string,
): Promise<{ signature: string }> {
  return request("/api/keypairs/sign", {
    method: "POST",
    body: JSON.stringify({ preparationId, address: signerAddress, transaction }),
  });
}

export function createTokenMint(input: CreateTokenMintRequest): Promise<TrackedTokenMint> {
  return request("/api/token-mints", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchTokenMints(network: Network): Promise<TrackedTokenMint[]> {
  const result = await request<{ tokenMints: TrackedTokenMint[] }>(
    `/api/token-mints?network=${encodeURIComponent(network)}`,
    { method: "GET" },
  );
  return result.tokenMints;
}

export function manageTokenMint(input: ManageTokenMintRequest): Promise<TokenMintActionResult> {
  return request("/api/token-mints/manage", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchLiquidityPools(network: Network): Promise<TrackedLiquidityPool[]> {
  const result = await request<{ liquidityPools: TrackedLiquidityPool[] }>(
    `/api/liquidity-pools?network=${encodeURIComponent(network)}`,
    { method: "GET" },
  );
  return result.liquidityPools;
}

export function createLiquidityPool(input: CreateLiquidityPoolRequest): Promise<LiquidityActionResult> {
  return request("/api/liquidity-pools", { method: "POST", body: JSON.stringify(input) });
}

export function manageLiquidityPool(input: ManageLiquidityPoolRequest): Promise<LiquidityActionResult> {
  return request("/api/liquidity-pools/manage", { method: "POST", body: JSON.stringify(input) });
}
