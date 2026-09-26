import type {
  DeliveryPreset,
  Network,
  PluginCatalog,
  Preparation,
  SubmissionResult,
} from "../shared/contracts";

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
