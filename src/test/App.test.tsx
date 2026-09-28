import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import App from "../client/App";

describe("workbench UI", () => {
  it("shows one transaction and disables Sender routes on devnet", () => {
    render(<App />);
    expect(document.querySelector(".one-tx")).toHaveTextContent("1 transaction");
    expect(screen.getByRole("button", { name: "Fast delivery route" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sender Max delivery route" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Prepare live quote" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Prepare & send on devnet" })).toBeEnabled();
  });

  it("switches between v0 and v1 transaction formats", () => {
    render(<App />);
    const v0 = screen.getByRole("button", { name: "v0" });
    const v1 = screen.getByRole("button", { name: "v1" });
    expect(v0).toHaveClass("active");
    fireEvent.click(v1);
    expect(v1).toHaveClass("active");
    expect(screen.getByText("Larger v1 transactions with direct System transfers.")).toBeInTheDocument();
  });

  it("shows a plain-language transaction breakdown for the current plan", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "Transaction breakdown" })).toBeInTheDocument();
    expect(screen.getByText("v0 message")).toBeInTheDocument();
    expect(screen.getByText("Distribute SOL")).toBeInTheDocument();
    expect(screen.getByText("0.002 SOL")).toBeInTheDocument();
    expect(screen.getByText("One program call fans out to 2 recipients")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "v1" }));
    expect(screen.getByText("v1 message")).toBeInTheDocument();
    expect(screen.getByText("2 SOL transfers")).toBeInTheDocument();
    expect(screen.getByText("SystemProgram")).toBeInTheDocument();
  });

  it("loads valid share and consolidation demo templates", () => {
    render(<App />);
    const picker = screen.getByLabelText("Demo template");
    const editor = screen.getByLabelText("Transfer plan JSON") as HTMLTextAreaElement;

    fireEvent.change(picker, { target: { value: "consolidation" } });
    expect(JSON.parse(editor.value)).toMatchObject({
      type: "consolidation",
      plugin: "native-sol-transfer",
    });
    expect(screen.getByRole("heading", { name: "Consolidation flow" })).toBeInTheDocument();

    fireEvent.change(picker, { target: { value: "share" } });
    expect(JSON.parse(editor.value)).toMatchObject({
      type: "share",
      plugin: "native-sol-transfer",
    });
    expect(screen.getByRole("heading", { name: "Share flow" })).toBeInTheDocument();
  });

  it("flips senders and receivers while preserving wallet amounts and plan options", () => {
    render(<App />);
    const editor = screen.getByLabelText("Transfer plan JSON") as HTMLTextAreaElement;
    const original = JSON.parse(editor.value);

    fireEvent.click(screen.getByRole("button", { name: "Flip senders and receivers" }));

    expect(JSON.parse(editor.value)).toEqual({
      type: "consolidation",
      senders: original.receivers,
      receivers: [{ address: original.senders[0].address }],
      plugin: original.plugin,
    });
    expect(screen.getByRole("heading", { name: "Consolidation flow" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Flip senders and receivers" }));
    expect(JSON.parse(editor.value)).toEqual(original);
    expect(screen.getByRole("heading", { name: "Share flow" })).toBeInTheDocument();
  });

  it("disables flipping when ALT recipients have not been resolved", () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText("Demo template"), { target: { value: "alt-selection" } });
    expect(screen.getByRole("button", { name: "Flip senders and receivers" })).toBeDisabled();
  });

  it("loads both ALT demo styles", () => {
    render(<App />);
    const picker = screen.getByLabelText("Demo template");
    const editor = screen.getByLabelText("Transfer plan JSON") as HTMLTextAreaElement;

    fireEvent.change(picker, { target: { value: "alt-explicit" } });
    expect(JSON.parse(editor.value)).toMatchObject({
      type: "share",
      receivers: expect.any(Array),
      addressLookupTables: ["Cas5qTBtAr6kPFt1LRW431JkYzqXm2Z49XMD5xAa3wuQ"],
    });
    expect(screen.getByText("The plan is ready for a live quote.")).toBeInTheDocument();

    fireEvent.change(picker, { target: { value: "alt-selection" } });
    expect(JSON.parse(editor.value)).toMatchObject({
      type: "share",
      receiversFromLookupTables: [{
        indexes: [0, 4, 9],
        ranges: [{ start: 20, end: 29 }],
      }],
    });
    expect(screen.getByText(/ALT recipient indexes will be resolved/)).toBeInTheDocument();
  });

  it("collapses large wallet groups in the Workbench preview", () => {
    const receivers = [
      "BApRNbirCZhPJ2uHAcesJNJCEwCz98p9o6W4f6bc4yr1",
      "8rb5FTPT3A8HBaYtDAbzduBZsYi18sRy7cyJmuD5AUT4",
      "4yPAtNZ4GRPaFf183evdnKBgL8GRd4vno32P3P8LHUh1",
      "ABWfHvVKf9t41bwJC3zQAjvsJUweFQb9pQXR8gCroXDR",
      "9Bxc8u6f5pBo4gWTC5kTaM9LAALdfSHP14Rnw9NW1E4w",
      "7SWDVnCKxA5LChCZZN9egCMdx63Fqnryw5XpeM4TXFSg",
      "AXJdkT885fYVFkPA7mVmgbh2GU6CNfAcKWZrarFngnFf",
      "5KCDtrz4GJbQ2rh5XRGPuD7DgAxKiSXu1G75EQERokuK",
      "Ksxj2wdNSJadLLqHhJtXt9ygSrLwuvGL6Li9fGGKV1C",
    ];
    const plan = {
      type: "share",
      senders: [{ address: "DzcSBpVniutt6w5pyuytxLUqJcWMh3mMawMmxaquLsbZ" }],
      receivers: receivers.map((address) => ({ address, amountSol: "0.00001" })),
    };

    render(<App />);
    fireEvent.change(screen.getByLabelText("Transfer plan JSON"), {
      target: { value: JSON.stringify(plan) },
    });

    const showDestinations = screen.getByRole("button", { name: "Show 9 destinations" });
    expect(showDestinations).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("9 wallets")).toBeInTheDocument();
    expect(document.querySelectorAll(".wallet")).toHaveLength(1);

    fireEvent.click(showDestinations);
    expect(screen.getByRole("button", { name: "Hide 9 destinations" })).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelectorAll(".wallet")).toHaveLength(10);
  });

  it("collapses a large Workbench JSON editor without losing its contents", () => {
    render(<App />);
    const editor = screen.getByLabelText("Transfer plan JSON") as HTMLTextAreaElement;
    const largeJson = `${editor.value}${"\n".repeat(45)}`;

    fireEvent.change(editor, { target: { value: largeJson } });

    const showJson = screen.getByRole("button", { name: /Show JSON \(/ });
    expect(showJson).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("Transfer plan JSON")).not.toBeInTheDocument();
    expect(screen.getByText("Transfer JSON hidden")).toBeInTheDocument();

    fireEvent.click(showJson);
    expect(screen.getByRole("button", { name: "Hide JSON" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Transfer plan JSON")).toHaveValue(largeJson);
  });

  it("opens the Keygen wallet manager without exposing secret inputs", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Keygen/ }));
    expect(screen.getByRole("heading", { name: "Managed wallets" })).toBeInTheDocument();
    expect(screen.getByLabelText("New keypairs")).toHaveValue(1);
    expect(screen.queryByLabelText(/private|secret/i)).not.toBeInTheDocument();
  });

  it("opens the Minting tab and requires confirmation before a mainnet mint", async () => {
    const authority = "DzcSBpVniutt6w5pyuytxLUqJcWMh3mMawMmxaquLsbZ";
    const requests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = String(input);
      requests.push(path);
      const body = path.endsWith("/api/keypairs")
        ? { keypairs: [{ address: authority, file: "wallets.txt", createdAt: "2026-09-27T00:00:00.000Z" }] }
        : path.startsWith("/api/token-mints?")
          ? { tokenMints: [] }
          : path.endsWith("/api/address-lookup-tables")
            ? { addressLookupTables: [] }
            : { transfer: [{ id: "native-sol-transfer", label: "Native SOL transfer" }], delivery: [] };
      return { ok: true, json: async () => body } as Response;
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Minting" }));
    expect(screen.getByRole("heading", { name: "Create and track token mints" })).toBeInTheDocument();
    await screen.findByRole("option", { name: authority });
    fireEvent.click(screen.getByRole("button", { name: "mainnet" }));
    fireEvent.change(screen.getByLabelText("Local name"), { target: { value: "Test Token" } });
    fireEvent.change(screen.getByLabelText("Local symbol"), { target: { value: "TEST" } });
    fireEvent.click(screen.getByRole("button", { name: "Create SPL token on mainnet" }));

    expect(confirm).toHaveBeenCalledOnce();
    expect(requests.filter((path) => path === "/api/token-mints")).toHaveLength(0);
  });

  it("shows Token-2022 metadata and token management actions", async () => {
    const authority = "DzcSBpVniutt6w5pyuytxLUqJcWMh3mMawMmxaquLsbZ";
    const mint = "Cas5qTBtAr6kPFt1LRW431JkYzqXm2Z49XMD5xAa3wuQ";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = String(input);
      const body = path.endsWith("/api/keypairs")
        ? { keypairs: [{ address: authority, file: "wallets.txt", createdAt: "2026-09-27T00:00:00.000Z" }] }
        : path.startsWith("/api/token-mints?")
          ? { tokenMints: [{ mint, name: "Chain Token", symbol: "CHAIN", decimals: 6, initialSupplyBaseUnits: "1000000", supplyBaseUnits: "1000000", network: "devnet", transactionVersion: 1, mintAuthorityAtCreation: authority, freezeAuthorityAtCreation: authority, mintAuthorityRevoked: false, freezeAuthorityRevoked: false, creationSignature: "sig", createdAt: "2026-09-27T00:00:00.000Z", tokenProgram: "token2022", metadataUri: "https://example.com/token.json", imageUrl: "https://example.com/token.png", liveStatus: "available", mintAuthority: authority, freezeAuthority: authority, metadataUpdateAuthority: authority }] }
          : path.endsWith("/api/address-lookup-tables")
            ? { addressLookupTables: [] }
            : { transfer: [{ id: "native-sol-transfer", label: "Native SOL transfer" }], delivery: [] };
      return { ok: true, json: async () => body } as Response;
    });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Minting" }));
    expect(await screen.findByText("Chain Token")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Manage token" }));
    const actions = screen.getByLabelText("Manage CHAIN");
    expect(actions).toHaveTextContent("Update on-chain metadata");
    expect(actions).toHaveTextContent("Mint additional supply");
    expect(actions).toHaveTextContent("Transfer tokens");
    expect(actions).toHaveTextContent("Burn tokens");
    expect(actions).toHaveTextContent("Freeze owner ATA");
    expect(actions).toHaveTextContent("Change/revoke metadata authority");
  });

  it("opens the devnet Liquidity desk with tracked token choices", async () => {
    const authority = "DzcSBpVniutt6w5pyuytxLUqJcWMh3mMawMmxaquLsbZ";
    const mints = ["Cas5qTBtAr6kPFt1LRW431JkYzqXm2Z49XMD5xAa3wuQ", "BApRNbirCZhPJ2uHAcesJNJCEwCz98p9o6W4f6bc4yr1"];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = String(input);
      const body = path.endsWith("/api/keypairs")
        ? { keypairs: [{ address: authority, file: "wallets.txt", createdAt: "2026-09-27T00:00:00.000Z" }] }
        : path.startsWith("/api/token-mints?")
          ? { tokenMints: mints.map((mint, index) => ({ mint, name: `Token ${index}`, symbol: `T${index}`, decimals: 6, initialSupplyBaseUnits: "1000000", supplyBaseUnits: "1000000", network: "devnet", transactionVersion: 0, mintAuthorityAtCreation: authority, freezeAuthorityAtCreation: null, mintAuthorityRevoked: false, freezeAuthorityRevoked: false, creationSignature: "sig", createdAt: "2026-09-27T00:00:00.000Z", tokenProgram: "classic", liveStatus: "available" })) }
          : path.startsWith("/api/liquidity-pools?")
            ? { liquidityPools: [] }
            : path.endsWith("/api/address-lookup-tables")
              ? { addressLookupTables: [] }
              : { transfer: [{ id: "native-sol-transfer", label: "Native SOL transfer" }], delivery: [] };
      return { ok: true, json: async () => body } as Response;
    });

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Liquidity" }));
    expect(screen.getByRole("heading", { name: "Liquidity desk" })).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: /T0/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create pool + seed reserves" })).toBeEnabled();
    expect(screen.getByText("No tracked pools")).toBeInTheDocument();
  });

  it("presents CLI how-to recipes and links back to the visual tools", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Tokens" }));

    expect(screen.getByRole("heading", { name: "How to work with tokens from the command line." })).toBeInTheDocument();
    expect(screen.getByText(/spl-token --program-2022 initialize-metadata/)).toBeInTheDocument();
    expect(screen.getByText(/npm run measure:v1/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open Workbench" }));
    expect(screen.getByRole("heading", { name: "Transfer JSON" })).toBeInTheDocument();
  });

  it("shows saved ALTs in a section separate from managed wallets", async () => {
    const tableAddress = "Cas5qTBtAr6kPFt1LRW431JkYzqXm2Z49XMD5xAa3wuQ";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = String(input);
      const body = path.endsWith("/api/address-lookup-tables")
        ? {
            addressLookupTables: [{
              address: tableAddress,
              authority: "DzcSBpVniutt6w5pyuytxLUqJcWMh3mMawMmxaquLsbZ",
              addressCount: 30,
              signatures: ["signature"],
              network: "devnet",
              createdAt: "2026-09-26T00:00:00.000Z",
            }],
          }
        : path.endsWith("/api/keypairs")
          ? { keypairs: [] }
          : { transfer: [{ id: "native-sol-transfer", label: "Native SOL transfer" }], delivery: [] };
      return { ok: true, json: async () => body } as Response;
    });

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Keygen/ }));

    expect(await screen.findByRole("heading", { name: "Address lookup tables" })).toBeInTheDocument();
    expect(screen.getByText(tableAddress)).toBeInTheDocument();
    expect(screen.getByText("30", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add to transfer JSON" })).toBeEnabled();
  });

  it("paginates managed wallets while random selection spans every page", async () => {
    const keypairs = Array.from({ length: 30 }, (_, index) => ({
      address: `wallet-${index}`,
      file: "many-wallets.txt",
      createdAt: "2026-09-26T00:00:00.000Z",
    }));
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = String(input);
      return {
        ok: true,
        json: async () => path.endsWith("/api/keypairs")
          ? { keypairs }
          : { transfer: [{ id: "native-sol-transfer", label: "Native SOL transfer" }], delivery: [] },
      } as Response;
    });

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Keygen/ }));

    const showWallets = await screen.findByRole("button", { name: "Show wallets (30)" });
    expect(showWallets).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("30 managed wallets hidden")).toBeInTheDocument();
    expect(document.querySelector(".key-ledger")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Random wallet count"), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    expect(screen.getByText("7 selected")).toBeInTheDocument();

    fireEvent.click(showWallets);
    expect(screen.getByRole("button", { name: "Hide wallets" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
    expect(screen.getByText("wallet-24", { selector: "code" })).toBeInTheDocument();
    expect(screen.queryByText("wallet-29", { selector: "code" })).not.toBeInTheDocument();
    const firstPageSelected = document.querySelectorAll(".key-ledger input:checked").length;

    fireEvent.click(screen.getByRole("button", { name: "Next wallet page" }));
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
    expect(screen.getByText("wallet-29", { selector: "code" })).toBeInTheDocument();
    const secondPageSelected = document.querySelectorAll(".key-ledger input:checked").length;
    expect(firstPageSelected + secondPageSelected).toBe(7);
    expect(screen.getByText(/7 selected total/)).toBeInTheDocument();
  });

  it("creates an ALT from selected managed wallets and adds it to the transfer JSON", async () => {
    const keypairs = [
      "BApRNbirCZhPJ2uHAcesJNJCEwCz98p9o6W4f6bc4yr1",
      "8rb5FTPT3A8HBaYtDAbzduBZsYi18sRy7cyJmuD5AUT4",
      "4yPAtNZ4GRPaFf183evdnKBgL8GRd4vno32P3P8LHUh1",
    ].map((address) => ({ address, file: "wallets.txt", createdAt: "2026-09-26T00:00:00.000Z" }));
    const tableAddress = "ABWfHvVKf9t41bwJC3zQAjvsJUweFQb9pQXR8gCroXDR";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = String(input);
      const body = path.endsWith("/api/keypairs")
        ? { keypairs }
        : path.endsWith("/api/address-lookup-tables")
          ? { address: tableAddress, authority: keypairs[0]!.address, addressCount: 2, signatures: ["one", "two"], network: "devnet" }
          : { transfer: [{ id: "native-sol-transfer", label: "Native SOL transfer" }], delivery: [] };
      return { ok: true, json: async () => body } as Response;
    });

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Keygen/ }));
    await screen.findByLabelText("Authority / fee payer");
    const walletCheckboxes = document.querySelectorAll<HTMLInputElement>(".key-ledger input");
    fireEvent.click(walletCheckboxes[0]!);
    fireEvent.click(walletCheckboxes[1]!);
    fireEvent.click(screen.getByRole("button", { name: "Create ALT from 2 selected" }));

    expect(await screen.findByText("ALT ready on devnet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add ALT to transfer JSON" }));
    await waitFor(() => {
      const editor = screen.getByLabelText("Transfer plan JSON") as HTMLTextAreaElement;
      expect(editor.value).toContain(tableAddress);
    });
  });
});
