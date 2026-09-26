import type { SignerProvider } from "../shared/contracts";

let activeProvider: SignerProvider | null = null;

export function setSignerProvider(provider: SignerProvider): void {
  activeProvider = provider;
}

export function clearSignerProvider(): void {
  activeProvider = null;
}

export function getSignerProvider(): SignerProvider | null {
  return activeProvider;
}

declare global {
  interface Window {
    solanaWorkbench?: {
      setSignerProvider: typeof setSignerProvider;
      clearSignerProvider: typeof clearSignerProvider;
    };
  }
}

if (typeof window !== "undefined") {
  window.solanaWorkbench = { setSignerProvider, clearSignerProvider };
}
