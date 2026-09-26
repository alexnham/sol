import { describe, expect, it } from "vitest";
import type { TransferPlugin } from "../shared/contracts";
import { registerTransferPlugin } from "../shared/plugin-registry";

describe("plugin registry", () => {
  it("rejects duplicate plugin identifiers", () => {
    const plugin: TransferPlugin = {
      id: "test-plugin",
      label: "Test",
      supports: () => true,
      validate: () => ({ ok: true, errors: [] }),
      requiredSigners: () => [],
      buildInstructions: async () => [],
    };
    registerTransferPlugin(plugin);
    expect(() => registerTransferPlugin(plugin)).toThrow("already registered");
  });
});
