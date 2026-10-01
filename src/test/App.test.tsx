import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import App, { isBlockhashFailure } from "../client/App";
import type { Preparation } from "../shared/contracts";

describe("workbench UI", () => {
  it("only retries failures caused by a missing or expired blockhash", () => {
    expect(isBlockhashFailure(new Error("Blockhash not found"))).toBe(true);
    expect(isBlockhashFailure(new Error("The prepared blockhash expired; prepare and sign again"))).toBe(true);
    expect(isBlockhashFailure(new Error("Transaction abc blockhash expired before confirmation"))).toBe(false);
    expect(isBlockhashFailure(new Error("Insufficient funds"))).toBe(false);
  });

  it("shows one transaction and disables Sender routes on devnet", () => {
    render(<App />);
    expect(document.querySelector(".one-tx")).toHaveTextContent("1 transaction");
    expect(screen.getByRole("button", { name: "Fast delivery route" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sender Max delivery route" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Prepare live quote" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Prepare & send on devnet" })).toBeEnabled();
  });

  it("switches a failed prepared transaction to Prepare again", async () => {
    const sender = "DzcSBpVniutt6w5pyuytxLUqJcWMh3mMawMmxaquLsbZ";
    let prepareCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const path = String(input);
      if (path.endsWith("/api/prepare")) {
        prepareCalls += 1;
        const request = JSON.parse(String(init?.body)) as { plan: Preparation["normalizedPlan"] };
        return { ok: true, json: async () => ({ preparations: [{
          preparationId: `prepared-${prepareCalls}`,
          network: "devnet",
          preset: "economy",
          transactionVersion: 1,
          pluginId: "native-sol-transfer",
          normalizedPlan: request.plan,
          normalizedAlias: false,
          feePayer: sender,
          requiredSigners: [sender],
          recentBlockhash: "11111111111111111111111111111111",
          lastValidBlockHeight: "100",
          computeUnitLimit: 1_000,
          loadedAccountsDataSizeLimit: 1_000,
          microLamportsPerComputeUnit: 0,
          transactionSizeBytes: 300,
          quote: { transactionCount: 1, transferLamports: "2000000", baseFeeLamports: "5000", priorityFeeLamports: "0", senderTipLamports: "0", totalFeeLamports: "5000", speed: "standard" },
          balances: { [sender]: "1000000000" },
          expiresAtBlockHeight: "100",
        }] }) } as Response;
      }
      const body = path.endsWith("/api/keypairs")
        ? { keypairs: [] }
        : path.endsWith("/api/address-lookup-tables")
          ? { addressLookupTables: [] }
          : { transfer: [{ id: "native-sol-transfer", label: "Native SOL transfer" }], delivery: [] };
      return { ok: true, json: async () => body } as Response;
    });

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Prepare live quote" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sign and send on devnet" }));

    const prepareAgain = await screen.findByRole("button", { name: "Prepare again" });
    fireEvent.click(prepareAgain);
    expect(await screen.findByRole("button", { name: "Sign and send on devnet" })).toBeEnabled();
    expect(prepareCalls).toBe(2);
  });

  it("switches between v0 and v1 transaction formats", () => {
    render(<App />);
    const v0 = screen.getByRole("button", { name: "v0" });
    const v1 = screen.getByRole("button", { name: "v1" });
    expect(v1).toHaveClass("active");
    expect(screen.getByText("Larger v1 transactions with direct System transfers.")).toBeInTheDocument();
    fireEvent.click(v0);
    expect(v0).toHaveClass("active");
    expect(screen.getByText("ALT-compressed distributor transactions.")).toBeInTheDocument();
  });

  it("shows a plain-language transaction breakdown for the current plan", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "Transaction breakdown" })).toBeInTheDocument();
    expect(screen.getByText("v1 message")).toBeInTheDocument();
    expect(screen.getByText("2 SOL transfers")).toBeInTheDocument();
    expect(screen.getByText("0.002 SOL")).toBeInTheDocument();
    expect(screen.getByText("SystemProgram")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "v0" }));
    expect(screen.getByText("v0 message")).toBeInTheDocument();
    expect(screen.getByText("Distribute SOL")).toBeInTheDocument();
    expect(screen.getByText("One program call fans out to 2 recipients")).toBeInTheDocument();
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

  it("configures consolidation signatures per transaction up to the format limit", () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText("Demo template"), { target: { value: "consolidation" } });

    const input = screen.getByLabelText("Signatures per transaction") as HTMLInputElement;
    expect(input).toHaveValue(12);
    expect(input).toHaveAttribute("max", "12");
    expect(screen.getByText(/v1 allows up to 12/)).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "1" } });
    expect(input).toHaveValue(1);
    expect(screen.getByText("2 transactions estimated · v1 allows up to 12")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "v0" }));
    expect(input).toHaveAttribute("max", "9");
    expect(screen.getByText(/v0 allows up to 9/)).toBeInTheDocument();
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
    await waitFor(() => expect(screen.getByRole("button", { name: "Create pool + seed reserves" })).toBeEnabled());
    expect(screen.getByText("No tracked pools")).toBeInTheDocument();
  });

  it("opens Airdrop with AirShip and standard delivery choices", async () => {
    const authority = "DzcSBpVniutt6w5pyuytxLUqJcWMh3mMawMmxaquLsbZ";
    const mint = "Cas5qTBtAr6kPFt1LRW431JkYzqXm2Z49XMD5xAa3wuQ";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = String(input);
      const body = path.endsWith("/api/keypairs")
        ? { keypairs: [{ address: authority, file: "wallets.txt", createdAt: "2026-09-27T00:00:00.000Z" }] }
        : path.startsWith("/api/airship/tokens?")
          ? { tokens: [{ mint, name: "Fleet Token", symbol: "FLEET", decimals: 6, balanceBaseUnits: "25000000", tokenProgram: "classic", supported: true }] }
          : path.endsWith("/api/address-lookup-tables")
            ? { addressLookupTables: [] }
            : { transfer: [{ id: "native-sol-transfer", label: "Native SOL transfer" }], delivery: [] };
      return { ok: true, json: async () => body } as Response;
    });

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Airdrop" }));

    expect(screen.getByRole("heading", { name: "Airdrop tokens at any scale" })).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: /FLEET · 25 available/ })).toBeInTheDocument();
    expect(screen.getByText("2 destinations")).toBeInTheDocument();
    expect(screen.getByText("Recipients receive compressed tokens")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /Normal airdrop/ }));
    expect(screen.getByText("Recipients receive standard SPL tokens")).toBeInTheDocument();
    expect(screen.queryByLabelText("Recipient address")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Launch standard airdrop on devnet" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/private|secret/i)).not.toBeInTheDocument();
  });

  it("copies selected Keygen wallets into the airdrop recipient list", async () => {
    const addresses = [
      "DzcSBpVniutt6w5pyuytxLUqJcWMh3mMawMmxaquLsbZ",
      "Cas5qTBtAr6kPFt1LRW431JkYzqXm2Z49XMD5xAa3wuQ",
      "BApRNbirCZhPJ2uHAcesJNJCEwCz98p9o6W4f6bc4yr1",
    ];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = String(input);
      const body = path.endsWith("/api/keypairs")
        ? { keypairs: addresses.map((address) => ({ address, file: "wallets.txt", createdAt: "2026-09-27T00:00:00.000Z" })) }
        : path.startsWith("/api/airship/tokens?")
          ? { tokens: [] }
          : path.endsWith("/api/address-lookup-tables")
            ? { addressLookupTables: [] }
            : { transfer: [{ id: "native-sol-transfer", label: "Native SOL transfer" }], delivery: [] };
      return { ok: true, json: async () => body } as Response;
    });

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Keygen/ }));
    await screen.findByLabelText("Authority / fee payer");
    const walletCheckboxes = document.querySelectorAll<HTMLInputElement>(".key-ledger input");
    fireEvent.click(walletCheckboxes[1]!);
    fireEvent.click(walletCheckboxes[2]!);
    fireEvent.click(screen.getByRole("button", { name: "Use as airdrop recipients" }));

    expect(screen.getByRole("heading", { name: "Airdrop tokens at any scale" })).toBeInTheDocument();
    expect(screen.getByLabelText("Recipient addresses")).toHaveValue(`${addresses[1]}\n${addresses[2]}`);
    expect(screen.getByText("2 destinations")).toBeInTheDocument();
  });

  it("scans and displays a recipient's compressed token balances", async () => {
    const authority = "DzcSBpVniutt6w5pyuytxLUqJcWMh3mMawMmxaquLsbZ";
    const recipient = "D1xjHUW4no9Yazh41nGcg5LLjupFXdFQnxer5ggWbcMA";
    const mint = "EcC5EofwYE8Rc2Xx9ireNMRCRTRVF8JvpQZBtQNxbA4f";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = String(input);
      const body = path.endsWith("/api/keypairs")
        ? { keypairs: [{ address: authority, file: "wallets.txt", createdAt: "2026-09-27T00:00:00.000Z" }] }
        : path.startsWith("/api/airship/tokens?")
          ? { tokens: [{ mint, name: "Fleet Token", symbol: "FLEET", decimals: 6, balanceBaseUnits: "25000000", tokenProgram: "classic", supported: true }] }
          : path.startsWith("/api/airship/compressed-balances?")
            ? { owner: recipient, accountCount: 2, balances: [{ mint, decimals: 6, balanceBaseUnits: "2000000", accountCount: 2 }] }
            : path.endsWith("/api/address-lookup-tables")
              ? { addressLookupTables: [] }
              : { transfer: [{ id: "native-sol-transfer", label: "Native SOL transfer" }], delivery: [] };
      return { ok: true, json: async () => body } as Response;
    });

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Airdrop" }));
    await screen.findByRole("option", { name: /FLEET/ });
    fireEvent.change(screen.getByLabelText("Recipient address"), { target: { value: recipient } });
    fireEvent.click(screen.getByRole("button", { name: "Scan balance" }));

    expect(await screen.findByText("2 compressed accounts")).toBeInTheDocument();
    expect(screen.getByText("2", { selector: ".airship-balance-list b" })).toBeInTheDocument();
    expect(screen.getByText("FLEET", { selector: ".airship-balance-list strong" })).toBeInTheDocument();
  });

  it("decompresses a managed wallet's compressed tokens into its token account", async () => {
    const authority = "DzcSBpVniutt6w5pyuytxLUqJcWMh3mMawMmxaquLsbZ";
    const mint = "EcC5EofwYE8Rc2Xx9ireNMRCRTRVF8JvpQZBtQNxbA4f";
    const destination = "Cas5qTBtAr6kPFt1LRW431JkYzqXm2Z49XMD5xAa3wuQ";
    let submittedBody: Record<string, unknown> | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const path = String(input);
      const body = path.endsWith("/api/keypairs")
        ? { keypairs: [{ address: authority, file: "wallets.txt", createdAt: "2026-09-27T00:00:00.000Z" }] }
        : path.startsWith("/api/airship/tokens?")
          ? { tokens: [{ mint, name: "Fleet Token", symbol: "FLEET", decimals: 6, balanceBaseUnits: "0", tokenProgram: "classic", supported: true }] }
          : path.startsWith("/api/airship/compressed-balances?")
            ? { owner: authority, accountCount: 2, balances: [{ mint, decimals: 6, balanceBaseUnits: "2000000", accountCount: 2 }] }
            : path === "/api/airship/decompress"
              ? (() => {
                  submittedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
                  return { network: "devnet", owner: authority, mint, amountBaseUnits: "1000000", destinationTokenAccount: destination, signature: "decompress-signature" };
                })()
              : path.endsWith("/api/address-lookup-tables")
                ? { addressLookupTables: [] }
                : { transfer: [{ id: "native-sol-transfer", label: "Native SOL transfer" }], delivery: [] };
      return { ok: true, json: async () => body } as Response;
    });

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Airdrop" }));
    await screen.findByRole("option", { name: /FLEET/ });
    fireEvent.click(screen.getByRole("button", { name: "Use managed sender" }));
    fireEvent.click(screen.getByRole("button", { name: "Scan balance" }));
    fireEvent.click(await screen.findByRole("button", { name: "Decompress to token account" }));

    expect(await screen.findByRole("link", { name: "View transaction ↗" })).toHaveAttribute("href", expect.stringContaining("decompress-signature"));
    expect(submittedBody).toMatchObject({ network: "devnet", owner: authority, mint, amount: "1", mainnetConfirmed: true });
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

  it("manually scans and caches wallet portfolios by network, then marks changed wallet sets stale", async () => {
    const firstWallet = { address: "DzcSBpVniutt6w5pyuytxLUqJcWMh3mMawMmxaquLsbZ", file: "wallets.txt", createdAt: "2026-09-30T12:00:00.000Z" };
    const secondWallet = { address: "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ", file: "wallets.txt", createdAt: "2026-09-30T12:00:00.000Z" };
    let keyLoads = 0;
    let portfolioLoads = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = String(input);
      let body: unknown;
      if (path.endsWith("/api/keypairs")) {
        keyLoads += 1;
        body = { keypairs: keyLoads === 1 ? [firstWallet] : [firstWallet, secondWallet] };
      } else if (path.includes("/api/wallets/portfolio")) {
        portfolioLoads += 1;
        body = {
          network: "devnet",
          scannedAt: "2026-09-30T12:30:00.000Z",
          managedWalletCount: 1,
          scannedWalletCount: 1,
          failedWallets: [],
          assets: [{
            kind: "native",
            name: "Solana",
            symbol: "SOL",
            decimals: 9,
            totalBaseUnits: "1250000000",
            wallets: [{ address: firstWallet.address, balanceBaseUnits: "1250000000" }],
          }],
        };
      } else if (path.endsWith("/api/address-lookup-tables")) {
        body = { addressLookupTables: [] };
      } else {
        body = { transfer: [{ id: "native-sol-transfer", label: "Native SOL transfer" }], delivery: [] };
      }
      return { ok: true, json: async () => body } as Response;
    });

    render(<App />);
    await screen.findByRole("button", { name: "Keygen 1" });
    fireEvent.click(screen.getByRole("button", { name: "Wallets" }));

    expect(screen.getByRole("button", { name: "Scan all wallets" })).toBeEnabled();
    expect(portfolioLoads).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Scan all wallets" }));

    expect(await screen.findByText("1.25", { selector: ".portfolio-asset-total strong" })).toBeInTheDocument();
    expect(portfolioLoads).toBe(1);
    fireEvent.click(screen.getByText("Solana").closest("summary")!);
    expect(screen.getByText(firstWallet.address, { selector: "code" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Workbench" }));
    fireEvent.click(screen.getByRole("button", { name: "Wallets" }));
    expect(screen.getByText("1.25", { selector: ".portfolio-asset-total strong" })).toBeInTheDocument();
    expect(portfolioLoads).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "mainnet" }));
    expect(screen.getByRole("button", { name: "Scan all wallets" })).toBeInTheDocument();
    expect(screen.queryByText("1.25", { selector: ".portfolio-asset-total strong" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "devnet" }));
    expect(screen.getByText("1.25", { selector: ".portfolio-asset-total strong" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Keygen 1" }));
    fireEvent.click(await screen.findByRole("button", { name: "Refresh files" }));
    await screen.findByText("2 managed");
    fireEvent.click(screen.getByRole("button", { name: "Wallets" }));
    expect(screen.getByText("Wallet list changed")).toBeInTheDocument();
    expect(screen.getByText("1.25", { selector: ".portfolio-asset-total strong" })).toBeInTheDocument();
  });
});
