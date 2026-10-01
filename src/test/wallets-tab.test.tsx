import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WalletsTab, formatPortfolioAmount } from "../client/features/wallets/WalletsTab";

describe("wallet portfolio presentation", () => {
  it("shows the no-wallet invitation without enabling a scan", () => {
    render(<WalletsTab
      network="devnet"
      managedWalletCount={0}
      report={null}
      stale={false}
      loading={false}
      error={null}
      onScan={vi.fn()}
    />);

    expect(screen.getByRole("heading", { name: "No managed wallets" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Scan all wallets" })).toBeDisabled();
  });

  it("shows an all-zero result and exposes partial wallet failures", () => {
    render(<WalletsTab
      network="mainnet"
      managedWalletCount={2}
      report={{
        network: "mainnet",
        scannedAt: "2026-09-30T12:30:00.000Z",
        managedWalletCount: 2,
        scannedWalletCount: 1,
        assets: [],
        failedWallets: [{ address: "failed-wallet", error: "rate limited" }],
      }}
      stale={false}
      loading={false}
      error={null}
      onScan={vi.fn()}
    />);

    expect(screen.getByRole("heading", { name: "No balances found" })).toBeInTheDocument();
    expect(screen.getByText("1 wallet could not be scanned")).toBeInTheDocument();
    expect(screen.getByText("rate limited")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh balances" })).toBeEnabled();
  });

  it("formats exact base-unit strings without floating-point conversion", () => {
    expect(formatPortfolioAmount("9007199254740993123456789", 9)).toBe("9,007,199,254,740,993.123456789");
    expect(formatPortfolioAmount("1250000000", 9)).toBe("1.25");
  });
});
