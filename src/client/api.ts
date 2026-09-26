import type {
  DeliveryPreset,
  Network,
  PluginCatalog,
  Preparation,
  SubmissionResult,
} from "../shared/contracts";

export interface VaultKeyMetadata {
  address: string;
  file: string;
  createdAt: string;
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
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
): Promise<Preparation> {
  return request("/api/prepare", {
    method: "POST",
    body: JSON.stringify({ plan, network, preset, pluginId }),
  });
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
