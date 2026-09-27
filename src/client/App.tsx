import { useEffect, useMemo, useState } from "react";
import type {
  DeliveryPreset,
  Network,
  Preparation,
  SubmissionResult,
  TransactionQuote,
  TransactionVersion,
  TransferPlan,
  PluginCatalog,
  LookupTableSharePlanInput,
} from "../shared/contracts";
import { lamportsToSol, parseTransferPlanInput, PlanValidationError } from "../shared/schema";
import {
  buildPreparedTransaction,
  encodeSignedTransaction,
  signPreparedTransaction,
  transactionSize,
} from "../shared/transaction";
import {
  fetchPlugins,
  fetchAddressLookupTables,
  fetchVaultKeys,
  createAddressLookupTable,
  generateVaultKeys,
  prepareTransfer,
  registerAddressLookupTable,
  submitTransfer,
  type VaultKeyMetadata,
  type CreatedAddressLookupTable,
  type StoredAddressLookupTable,
} from "./api";
import { getSignerProvider } from "./signer-provider";
import { createVaultSignerProvider } from "./vault-signer";

const SHARE_SAMPLE = `{
  "type": "share",
  "senders": [
    { "address": "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE" }
  ],
  "receivers": [
    { "address": "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ", "amountSol": "0.001" },
    { "address": "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta", "amountSol": "0.001" }
  ],
  "plugin": "native-sol-transfer"
}`;

const CONSOLIDATION_SAMPLE = `{
  "type": "consolidation",
  "senders": [
    { "address": "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE", "amountSol": "0.001" },
    { "address": "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ", "amountSol": "0.001" }
  ],
  "receivers": [
    { "address": "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta" }
  ],
  "plugin": "native-sol-transfer"
}`;

const ALT_EXPLICIT_SAMPLE = `{
  "type": "share",
  "senders": [
    { "address": "DzcSBpVniutt6w5pyuytxLUqJcWMh3mMawMmxaquLsbZ" }
  ],
  "receivers": [
    { "address": "BApRNbirCZhPJ2uHAcesJNJCEwCz98p9o6W4f6bc4yr1", "amountSol": "0.001" },
    { "address": "8rb5FTPT3A8HBaYtDAbzduBZsYi18sRy7cyJmuD5AUT4", "amountSol": "0.001" }
  ],
  "addressLookupTables": [
    "Cas5qTBtAr6kPFt1LRW431JkYzqXm2Z49XMD5xAa3wuQ"
  ],
  "plugin": "native-sol-transfer"
}`;

const ALT_SELECTION_SAMPLE = `{
  "type": "share",
  "senders": [
    { "address": "DzcSBpVniutt6w5pyuytxLUqJcWMh3mMawMmxaquLsbZ" }
  ],
  "receivers": [],
  "receiversFromLookupTables": [
    {
      "address": "Cas5qTBtAr6kPFt1LRW431JkYzqXm2Z49XMD5xAa3wuQ",
      "amountSol": "0.001",
      "indexes": [0, 4, 9],
      "ranges": [
        { "start": 20, "end": 29 }
      ]
    }
  ],
  "plugin": "native-sol-transfer"
}`;

const PRESETS: Array<{
  id: DeliveryPreset;
  name: string;
  description: string;
  speed: string;
  tip: string;
}> = [
  {
    id: "economy",
    name: "Economy",
    description: "Normal RPC with preflight",
    speed: "Standard",
    tip: "No Sender tip",
  },
  {
    id: "custom",
    name: "Custom",
    speed: "Standard",
    tip: "No Sender tip",
    description: "Custom normal-RPC route",
  },
  {
    id: "fast",
    name: "Fast",
    description: "Helius SWQOS route",
    speed: "Fast",
    tip: "0.000005 SOL minimum",
  },
  {
    id: "max",
    name: "Sender Max",
    description: "All high-speed pathways",
    speed: "Fastest",
    tip: "0.001 SOL minimum",
  },
];

type Stage = "idle" | "preparing" | "ready" | "signing" | "submitting" | "confirmed" | "failed";
type SignerUiStatus = "waiting" | "signing" | "signed" | "failed";
type AppTab = "workbench" | "keygen";

const FALLBACK_SOURCE = "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE";
const FALLBACK_DESTINATION = "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ";

export default function App() {
  const [activeTab, setActiveTab] = useState<AppTab>("workbench");
  const [json, setJson] = useState(SHARE_SAMPLE);
  const [network, setNetwork] = useState<Network>("devnet");
  const [preset, setPreset] = useState<DeliveryPreset>("economy");
  const [transactionVersion, setTransactionVersion] = useState<TransactionVersion>(0);
  const [preparations, setPreparations] = useState<Preparation[]>([]);
  const [result, setResult] = useState<SubmissionResult | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [showReview, setShowReview] = useState(false);
  const [signerStatuses, setSignerStatuses] = useState<Record<string, SignerUiStatus>>({});
  const [pluginId, setPluginId] = useState("native-sol-transfer");
  const [plugins, setPlugins] = useState<PluginCatalog["transfer"]>([
    { id: "native-sol-transfer", label: "Native SOL transfer" },
  ]);
  const [vaultKeys, setVaultKeys] = useState<VaultKeyMetadata[]>([]);
  const [vaultLookupTables, setVaultLookupTables] = useState<StoredAddressLookupTable[]>([]);
  const [vaultBusy, setVaultBusy] = useState(false);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [editorExpandedOverride, setEditorExpandedOverride] = useState<boolean | null>(null);

  const parsed = useMemo(() => parseEditor(json), [json]);
  const preparation = preparations[0] ?? null;
  const plan = parsed.plan ?? preparation?.normalizedPlan ?? null;
  const jsonLineCount = json.split("\n").length;
  const jsonIsLarge = jsonLineCount > 40 || json.length > 4_000;
  const editorExpanded = editorExpandedOverride ?? !jsonIsLarge;

  useEffect(() => {
    let active = true;
    fetchPlugins()
      .then((catalog) => {
        if (!active || catalog.transfer.length === 0) return;
        setPlugins(catalog.transfer);
        setPluginId((current) =>
          catalog.transfer.some((plugin) => plugin.id === current)
            ? current
            : catalog.transfer[0]!.id,
        );
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    refreshVault().catch(() => undefined);
  }, []);

  async function refreshVault() {
    try {
      const [keys, lookupTables] = await Promise.all([
        fetchVaultKeys(),
        fetchAddressLookupTables(),
      ]);
      setVaultKeys(keys);
      setVaultLookupTables(lookupTables);
      setVaultError(null);
    } catch (reason) {
      setVaultError(reason instanceof Error ? reason.message : "Could not load managed wallets");
    }
  }

  async function generateKeys(count: number) {
    setVaultBusy(true);
    setVaultError(null);
    try {
      await generateVaultKeys(count);
      await refreshVault();
    } catch (reason) {
      setVaultError(reason instanceof Error ? reason.message : "Key generation failed");
    } finally {
      setVaultBusy(false);
    }
  }

  function useVaultKeys(addresses: string[], role: "sources" | "destinations") {
    const selected = [...new Set(addresses)];
    if (selected.length === 0) return;
    let nextPlan: TransferPlan;
    if (role === "sources" && selected.length > 1) {
      const currentDestination = plan?.receivers.find(
        (receiver) => !selected.includes(receiver.address),
      )?.address ?? FALLBACK_DESTINATION;
      nextPlan = {
        type: "consolidation",
        senders: selected.map((walletAddress) => ({ address: walletAddress, amountSol: "0.01" })),
        receivers: [{ address: currentDestination }],
      };
    } else if (role === "sources") {
      const receivers = plan?.type === "share"
        ? plan.receivers.filter((receiver) => receiver.address !== selected[0])
        : [];
      nextPlan = {
        type: "share",
        senders: [{ address: selected[0]! }],
        receivers: receivers.length > 0
          ? receivers
          : [{ address: FALLBACK_DESTINATION, amountSol: "0.01" }],
      };
    } else {
      const currentSource = plan?.senders.find(
        (sender) => !selected.includes(sender.address),
      )?.address ?? FALLBACK_SOURCE;
      nextPlan = {
        type: "share",
        senders: [{ address: currentSource }],
        receivers: selected.map((walletAddress) => ({ address: walletAddress, amountSol: "0.01" })),
      };
    }
    invalidate(JSON.stringify(nextPlan, null, 2));
    setActiveTab("workbench");
  }

  function useLookupTable(tableAddress: string) {
    if (!plan) return;
    const nextPlan: TransferPlan = {
      ...plan,
      addressLookupTables: [...new Set([...(plan.addressLookupTables ?? []), tableAddress])],
    };
    invalidate(JSON.stringify(nextPlan, null, 2));
    setActiveTab("workbench");
  }

  function invalidate(nextJson?: string) {
    if (nextJson !== undefined) setJson(nextJson);
    setPreparations([]);
    setResult(null);
    setError(null);
    setStage("idle");
    setSignerStatuses({});
  }

  function changeNetwork(value: Network) {
    setNetwork(value);
    if (value === "devnet" && preset !== "economy" && preset !== "custom") setPreset("economy");
    if (value === "mainnet" && preset === "custom") setPreset("economy");
    invalidate();
  }

  async function prepare() {
    if (!parsed.raw) return;
    setStage("preparing");
    setError(null);
    setResult(null);
    try {
      const next = await prepareTransfer(
        parsed.raw,
        network,
        preset,
        parsed.plan?.plugin ?? parsed.lookupPlan?.plugin ?? pluginId,
        transactionVersion,
      );
      setPreparations(next);
      setSignerStatuses(
        Object.fromEntries(
          [...new Set(next.flatMap((item) => item.requiredSigners))]
            .map((signer) => [signer, "waiting"]),
        ),
      );
      setStage("ready");
    } catch (reason) {
      fail(reason);
    }
  }

  async function requestSend() {
    if (preparations.length === 0) return;
    if (network === "mainnet") {
      setShowReview(true);
      return;
    }
    await signAndSend();
  }

  async function signAndSend() {
    if (preparations.length === 0) return;
    setShowReview(false);
    const managedAddresses = new Set(vaultKeys.map((keypair) => keypair.address));
    const requiredSigners = [...new Set(preparations.flatMap((item) => item.requiredSigners))];
    const canUseVault = requiredSigners.every((signer) => managedAddresses.has(signer));
    const externalProvider = getSignerProvider();
    if (!externalProvider && !canUseVault) {
      const missing = requiredSigners.filter((signer) => !managedAddresses.has(signer));
      setError(
        missing.length > 0
          ? `Missing signer access for ${missing.map(shortAddress).join(", ")}. Add those keys in Keygen or attach a signer provider.`
          : "No signer provider is attached. Use window.solanaWorkbench.setSignerProvider(provider).",
      );
      setStage("failed");
      return;
    }
    try {
      setStage("signing");
      setSignerStatuses(
        Object.fromEntries(requiredSigners.map((signer) => [signer, "waiting"])),
      );
      let submission: SubmissionResult | null = null;
      for (const item of preparations) {
        const vaultProvider = createVaultSignerProvider(item.preparationId);
        const provider = externalProvider
          ? {
              id: "managed-and-external-signers",
              getSigner: (signerAddress: Parameters<typeof externalProvider.getSigner>[0]) =>
                managedAddresses.has(String(signerAddress))
                  ? vaultProvider.getSigner(signerAddress)
                  : externalProvider.getSigner(signerAddress),
            }
          : vaultProvider;
        const transaction = await buildPreparedTransaction(item);
        const signed = await signPreparedTransaction(
          transaction,
          item.requiredSigners,
          provider,
          (signerAddress, status) => {
            setSignerStatuses((current) => ({ ...current, [signerAddress]: status }));
          },
        );
        setStage("submitting");
        submission = await submitTransfer(item.preparationId, encodeSignedTransaction(signed));
        setStage("signing");
      }
      setResult(submission);
      setStage("confirmed");
    } catch (reason) {
      fail(reason);
    }
  }

  function fail(reason: unknown) {
    setError(reason instanceof Error ? reason.message : "Unexpected operation failure");
    setStage("failed");
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="identity">
          <span className="mark" aria-hidden="true"><i /><i /><i /></span>
          <div>
            <h1>Transfer workbench</h1>
            <p>{transactionVersion === 0
              ? "ALT-compressed distributor transactions."
              : "Larger v1 transactions with direct System transfers."}</p>
          </div>
        </div>
        <div className="topbar-controls">
          <nav className="app-tabs" aria-label="Workbench sections">
            <button type="button" className={activeTab === "workbench" ? "active" : ""} onClick={() => setActiveTab("workbench")}>Workbench</button>
            <button type="button" className={activeTab === "keygen" ? "active" : ""} onClick={() => setActiveTab("keygen")}>Keygen <span>{vaultKeys.length}</span></button>
          </nav>
          <div className="network-switch" aria-label="Solana network">
          {(["devnet", "mainnet"] as Network[]).map((value) => (
            <button
              key={value}
              className={network === value ? "active" : ""}
              onClick={() => changeNetwork(value)}
              type="button"
            >
              <span className="network-dot" />{value}
            </button>
          ))}
          </div>
          <div className="network-switch" aria-label="Transaction version">
            {([0, 1] as TransactionVersion[]).map((value) => (
              <button
                key={value}
                className={transactionVersion === value ? "active" : ""}
                onClick={() => {
                  setTransactionVersion(value);
                  invalidate();
                }}
                type="button"
              >
                v{value}
              </button>
            ))}
          </div>
        </div>
      </header>

      {activeTab === "workbench" ? (
      <section className="workspace">
        <section className="editor-pane" aria-labelledby="json-heading">
          <div className="pane-heading">
            <div>
              <h2 id="json-heading">Transfer JSON</h2>
              <p>Addresses and explicit SOL amounts only. Never paste private keys.</p>
            </div>
            <div className="editor-heading-actions">
              <select
                className="demo-template-select"
                aria-label="Demo template"
                value=""
                onChange={(event) => {
                  const template = event.target.value;
                  if (template === "share") invalidate(SHARE_SAMPLE);
                  if (template === "consolidation") invalidate(CONSOLIDATION_SAMPLE);
                  if (template === "alt-explicit") invalidate(ALT_EXPLICIT_SAMPLE);
                  if (template === "alt-selection") invalidate(ALT_SELECTION_SAMPLE);
                  event.target.value = "";
                }}
              >
                <option value="" disabled>Demo template</option>
                <option value="share">Share example</option>
                <option value="consolidation">Consolidation example</option>
                <option value="alt-explicit">ALT · explicit receivers</option>
                <option value="alt-selection">ALT · indexes and ranges</option>
              </select>
              {jsonIsLarge && (
                <button
                  className="editor-collapse-button"
                  type="button"
                  aria-controls="json-editor-region"
                  aria-expanded={editorExpanded}
                  onClick={() => setEditorExpandedOverride(!editorExpanded)}
                >
                  {editorExpanded ? "Hide JSON" : `Show JSON (${jsonLineCount.toLocaleString()} lines)`}
                </button>
              )}
              <span className={`status-chip ${parsed.error ? "invalid" : "valid"}`}>
                {parsed.error ? "Needs attention" : "Valid structure"}
              </span>
            </div>
          </div>
          {editorExpanded ? (
            <div className="code-frame" id="json-editor-region">
              <div className="code-gutter" aria-hidden="true">
                {json.split("\n").map((_, index) => <span key={index}>{index + 1}</span>)}
              </div>
              <textarea
                aria-label="Transfer plan JSON"
                spellCheck={false}
                value={json}
                onChange={(event) => invalidate(event.target.value)}
              />
            </div>
          ) : (
            <button
              className="code-frame-summary"
              id="json-editor-region"
              type="button"
              onClick={() => setEditorExpandedOverride(true)}
            >
              <span className="code-summary-braces" aria-hidden="true">{"{…}"}</span>
              <span>
                <strong>Transfer JSON hidden</strong>
                <small>{jsonSummary(jsonLineCount, plan)}</small>
              </span>
              <span className="code-summary-action">Show JSON</span>
            </button>
          )}
          <div className="editor-message" role="status">
            {parsed.error ? (
              <><span className="message-icon">!</span><span>{parsed.error}</span></>
            ) : parsed.normalizedAlias ? (
              <><span className="message-icon info">i</span><span>“recievers” is supported and will be normalized to “receivers”.</span></>
            ) : parsed.lookupPlan ? (
              <><span className="message-icon info">i</span><span>ALT recipient indexes will be resolved when the live quote is prepared.</span></>
            ) : (
              <><span className="message-icon ok">✓</span><span>The plan is ready for a live quote.</span></>
            )}
          </div>
          <details className="plugin-note">
            <summary>Plugin integration</summary>
            <p>
              Register a <code>TransferPlugin</code>, <code>DeliveryAdapter</code>, or attach a
              <code>SignerProvider</code>. Plugins must preserve one immutable transaction.
            </p>
            <label className="plugin-select">
              Transfer strategy
              <select
                aria-label="Transfer strategy"
                disabled={Boolean(plan?.plugin)}
                value={plan?.plugin ?? pluginId}
                onChange={(event) => {
                  setPluginId(event.target.value);
                  invalidate();
                }}
              >
                {plugins.map((plugin) => (
                  <option key={plugin.id} value={plugin.id}>{plugin.label}</option>
                ))}
                {plan?.plugin && !plugins.some((plugin) => plugin.id === plan.plugin) && (
                  <option value={plan.plugin}>{plan.plugin}</option>
                )}
              </select>
              {plan?.plugin && <small>Selected by the JSON <code>plugin</code> field.</small>}
            </label>
          </details>
        </section>

        <section className="review-pane" aria-label="Transaction review">
          <div className="pane-heading review-heading">
            <div>
              <h2>{plan?.type === "consolidation" ? "Consolidation flow" : "Share flow"}</h2>
              <p>{flowDescription(plan)}</p>
            </div>
            <span className="one-tx"><strong>{preparation?.quote.transactionCount ?? 1}</strong> transaction{preparation?.quote.transactionCount === 1 ? "" : "s"}</span>
          </div>

          <WalletRail plan={plan} lookupPlan={preparation ? null : parsed.lookupPlan} />

          <div className="route-section">
            <div className="section-title">
              <h3>Delivery route</h3>
              <span>Priority fee capped at 0.0001 SOL</span>
            </div>
            <div className="routes">
              {PRESETS.map((item) => {
                const disabled = network === "devnet"
                  ? item.id !== "economy" && item.id !== "custom"
                  : item.id === "custom";
                return (
                  <button
                    key={item.id}
                    aria-label={`${item.name} delivery route`}
                    type="button"
                    disabled={disabled}
                    className={`route ${preset === item.id ? "selected" : ""}`}
                    onClick={() => {
                      setPreset(item.id);
                      invalidate();
                    }}
                  >
                    <span className="radio" />
                    <span className="route-copy">
                      <strong>{item.name}</strong>
                      <small>{disabled ? "Mainnet only" : item.description}</small>
                    </span>
                    <span className="route-data"><strong>{item.speed}</strong><small>{item.tip}</small></span>
                    <span className="route-count">dynamic</span>
                  </button>
                );
              })}
            </div>
          </div>

          <QuotePanel preparations={preparations} />

          {preparation && (
            <SignerProgress
              signers={preparation.requiredSigners}
              statuses={signerStatuses}
            />
          )}

          {error && <div className="alert error-alert" role="alert"><strong>Action stopped</strong><span>{error}</span></div>}
          {result && (
            <div className="alert success-alert" role="status">
              <strong>{result.status === "confirmed" ? "Transaction confirmed" : "Transaction submitted"}</strong>
              <span>{(result.confirmationMs / 1000).toFixed(1)} seconds</span>
              <a href={result.explorerUrl} target="_blank" rel="noreferrer">Open in Orb</a>
            </div>
          )}

          <div className="action-bar">
            <div className="action-status">
              <span className={`pulse ${stage}`} />
              <span>{stageLabel(stage)}</span>
            </div>
            {!preparation ? (
              <button className="primary" disabled={!parsed.raw || stage === "preparing"} onClick={prepare} type="button">
                {stage === "preparing" ? "Preparing live quote…" : "Prepare live quote"}
              </button>
            ) : (
              <button className="primary" disabled={stage === "signing" || stage === "submitting"} onClick={requestSend} type="button">
                {stage === "signing" ? "Collecting signatures…" : stage === "submitting" ? "Submitting…" : `Sign and send on ${network}`}
              </button>
            )}
          </div>
        </section>
      </section>
      ) : (
        <KeygenPanel
          keypairs={vaultKeys}
          lookupTables={vaultLookupTables}
          network={network}
          busy={vaultBusy}
          error={vaultError}
          onGenerate={generateKeys}
          onRefresh={refreshVault}
          onUse={useVaultKeys}
          onUseLookupTable={useLookupTable}
        />
      )}

      {showReview && preparation && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowReview(false)}>
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onMouseDown={(event) => event.stopPropagation()}>
            <span className="mainnet-badge">Mainnet transfer</span>
            <h2 id="confirm-title">Review real-fund submission</h2>
            <p>This action requests {preparation.requiredSigners.length} signature{preparation.requiredSigners.length === 1 ? "" : "s"} per batch and submits {preparations.length} irreversible transaction{preparations.length === 1 ? "" : "s"}.</p>
            <QuoteRows quote={aggregateQuote(preparations)} />
            <div className="modal-actions">
              <button className="secondary" onClick={() => setShowReview(false)} type="button">Cancel</button>
              <button className="danger" onClick={signAndSend} type="button">Sign mainnet transaction</button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function KeygenPanel({
  keypairs,
  lookupTables,
  network,
  busy,
  error,
  onGenerate,
  onRefresh,
  onUse,
  onUseLookupTable,
}: {
  keypairs: VaultKeyMetadata[];
  lookupTables: StoredAddressLookupTable[];
  network: Network;
  busy: boolean;
  error: string | null;
  onGenerate(count: number): Promise<void>;
  onRefresh(): Promise<void>;
  onUse(addresses: string[], role: "sources" | "destinations"): void;
  onUseLookupTable(address: string): void;
}) {
  const [count, setCount] = useState(1);
  const [randomCount, setRandomCount] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [ledgerExpandedOverride, setLedgerExpandedOverride] = useState<boolean | null>(null);
  const [altAuthority, setAltAuthority] = useState("");
  const [altBusy, setAltBusy] = useState(false);
  const [altError, setAltError] = useState<string | null>(null);
  const [createdAlt, setCreatedAlt] = useState<CreatedAddressLookupTable | null>(null);
  const [existingAltAddress, setExistingAltAddress] = useState("");
  const [registeringAlt, setRegisteringAlt] = useState(false);
  const selectedSet = new Set(selected);
  const ledgerExpanded = ledgerExpandedOverride ?? keypairs.length <= 25;
  const canSelectRandom = Number.isSafeInteger(randomCount) && randomCount >= 1 && randomCount <= keypairs.length;
  const resolvedAltAuthority = keypairs.some((keypair) => keypair.address === altAuthority)
    ? altAuthority
    : keypairs[0]?.address ?? "";

  async function createSelectedAlt() {
    if (!resolvedAltAuthority || selected.length < 2 || selected.length > 256) return;
    if (network === "mainnet" && !window.confirm(
      `Create and fund a mainnet address lookup table containing ${selected.length} addresses?`,
    )) return;
    setAltBusy(true);
    setAltError(null);
    setCreatedAlt(null);
    try {
      setCreatedAlt(await createAddressLookupTable(network, resolvedAltAuthority, selected));
      await onRefresh();
    } catch (reason) {
      setAltError(reason instanceof Error ? reason.message : "ALT creation failed");
    } finally {
      setAltBusy(false);
    }
  }

  async function saveExistingAlt() {
    if (!existingAltAddress.trim()) return;
    setRegisteringAlt(true);
    setAltError(null);
    try {
      await registerAddressLookupTable(network, existingAltAddress.trim());
      setExistingAltAddress("");
      await onRefresh();
    } catch (reason) {
      setAltError(reason instanceof Error ? reason.message : "Could not save the ALT");
    } finally {
      setRegisteringAlt(false);
    }
  }

  function toggle(walletAddress: string) {
    setSelected((current) => current.includes(walletAddress)
      ? current.filter((value) => value !== walletAddress)
      : [...current, walletAddress]);
  }

  return (
    <section className="keygen-workspace" aria-labelledby="keygen-title">
      <header className="keygen-hero">
        <div>
          <span className="vault-kicker">Local key cabinet</span>
          <h2 id="keygen-title">Managed wallets</h2>
          <p>Keys stay in permission-restricted files on this machine. The browser receives public addresses only.</p>
        </div>
        <form className="generate-control" onSubmit={(event) => {
          event.preventDefault();
          void onGenerate(count);
        }}>
          <label htmlFor="key-count">New keypairs</label>
          <div>
            <input id="key-count" type="number" min="1" max="1000" value={count} onChange={(event) => setCount(Number(event.target.value))} />
            <button className="primary" type="submit" disabled={busy}>{busy ? "Generating…" : "Generate"}</button>
          </div>
        </form>
      </header>

      <div className="vault-warning" role="note">
        <strong>Local plaintext custody</strong>
        <span>These files can control funds. Keep them out of Git, backups you do not trust, and shared folders.</span>
      </div>

      <section className="alt-builder" aria-labelledby="alt-builder-title">
        <div>
          <span className="vault-kicker">Address compression</span>
          <h3 id="alt-builder-title">Create address lookup table</h3>
          <p>Select 2–256 wallets below. The authority pays rent and transaction fees from its managed balance.</p>
        </div>
        <div className="alt-builder-controls">
          <label htmlFor="alt-authority">Authority / fee payer</label>
          <select
            id="alt-authority"
            value={resolvedAltAuthority}
            onChange={(event) => setAltAuthority(event.target.value)}
            disabled={keypairs.length === 0 || altBusy}
          >
            {keypairs.map((keypair) => (
              <option key={keypair.address} value={keypair.address}>{keypair.address}</option>
            ))}
          </select>
          <button
            className="secondary"
            type="button"
            disabled={altBusy || selected.length < 2 || selected.length > 256 || !resolvedAltAuthority}
            onClick={() => void createSelectedAlt()}
          >
            {altBusy ? "Creating and extending…" : `Create ALT from ${selected.length} selected`}
          </button>
        </div>
      </section>

      {altError && <div className="alert error-alert" role="alert"><strong>ALT creation failed</strong><span>{altError}</span></div>}
      {createdAlt && (
        <div className="alt-created" role="status">
          <div><strong>ALT ready on {createdAlt.network}</strong><code>{createdAlt.address}</code><span>{createdAlt.addressCount} addresses · {createdAlt.signatures.length} setup transactions</span></div>
          <button className="primary" type="button" onClick={() => onUseLookupTable(createdAlt.address)}>Add ALT to transfer JSON</button>
        </div>
      )}

      <section className="alt-library" aria-labelledby="alt-library-title">
        <div className="alt-library-heading">
          <div>
            <span className="vault-kicker">Saved metadata</span>
            <h3 id="alt-library-title">Address lookup tables</h3>
          </div>
          <span>{lookupTables.length.toLocaleString()} saved</span>
        </div>
        <form className="alt-register" onSubmit={(event) => {
          event.preventDefault();
          void saveExistingAlt();
        }}>
          <label htmlFor="existing-alt-address">Save existing {network} ALT</label>
          <div>
            <input
              id="existing-alt-address"
              value={existingAltAddress}
              placeholder="Lookup table account address"
              onChange={(event) => setExistingAltAddress(event.target.value)}
              disabled={registeringAlt}
            />
            <button className="secondary" type="submit" disabled={registeringAlt || !existingAltAddress.trim()}>
              {registeringAlt ? "Checking…" : "Save ALT"}
            </button>
          </div>
        </form>
        {lookupTables.length === 0 ? (
          <div className="alt-library-empty">Tables created here will be stored and listed separately from managed wallets.</div>
        ) : (
          <ol className="alt-library-list">
            {lookupTables.map((table) => (
              <li key={`${table.network}:${table.address}`}>
                <div className="alt-library-address">
                  <span className={`alt-network ${table.network}`}>{table.network}</span>
                  <code title={table.address}>{table.address}</code>
                </div>
                <div className="alt-library-meta">
                  <span><strong>{table.addressCount}</strong> addresses</span>
                  <span><strong>{table.signatures.length}</strong> setup tx</span>
                  <span title={table.authority}>{table.authority ? `Authority ${shortAddress(table.authority)}` : "Imported table"}</span>
                  <span>{formatVaultDate(table.createdAt)}</span>
                </div>
                <button
                  className="secondary"
                  type="button"
                  disabled={table.network !== network}
                  title={table.network !== network ? `Switch to ${table.network} to use this table` : undefined}
                  onClick={() => onUseLookupTable(table.address)}
                >
                  {table.network === network ? "Add to transfer JSON" : `Use on ${table.network}`}
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>

      <div className="vault-toolbar">
        <div className="vault-selection-tools">
          <label className="select-all">
            <input
              type="checkbox"
              checked={keypairs.length > 0 && selected.length === keypairs.length}
              onChange={() => setSelected(selected.length === keypairs.length ? [] : keypairs.map((keypair) => keypair.address))}
            />
            {selected.length > 0 ? `${selected.length} selected` : `${keypairs.length} managed`}
          </label>
          <form className="random-select-control" onSubmit={(event) => {
            event.preventDefault();
            if (!canSelectRandom) return;
            setSelected(sampleWithoutReplacement(
              keypairs.map((keypair) => keypair.address),
              randomCount,
            ));
          }}>
            <label htmlFor="random-wallet-count">Random</label>
            <input
              id="random-wallet-count"
              aria-label="Random wallet count"
              type="number"
              min="1"
              max={Math.max(1, keypairs.length)}
              value={randomCount}
              onChange={(event) => setRandomCount(Number(event.target.value))}
            />
            <button className="secondary random-select-button" type="submit" disabled={!canSelectRandom}>Select</button>
          </form>
        </div>
        <div className="vault-actions">
          {keypairs.length > 0 && (
            <button
              className="secondary vault-collapse"
              type="button"
              aria-controls="managed-wallet-list"
              aria-expanded={ledgerExpanded}
              onClick={() => setLedgerExpandedOverride(!ledgerExpanded)}
            >
              <span aria-hidden="true">{ledgerExpanded ? "▴" : "▾"}</span>
              {ledgerExpanded ? "Hide wallets" : `Show wallets (${keypairs.length.toLocaleString()})`}
            </button>
          )}
          <button className="secondary" type="button" onClick={() => void onRefresh()}>Refresh files</button>
          <button className="secondary" type="button" disabled={selected.length === 0} onClick={() => onUse(selected, "destinations")}>Use as destinations</button>
          <button className="primary" type="button" disabled={selected.length === 0} onClick={() => onUse(selected, "sources")}>Use as sources</button>
        </div>
      </div>

      {error && <div className="alert error-alert" role="alert"><strong>Key vault unavailable</strong><span>{error}</span></div>}

      {keypairs.length === 0 ? (
        <div className="vault-empty">
          <span className="vault-empty-mark">＋</span>
          <h3>No managed wallets yet</h3>
          <p>Generate a keypair here or place a compatible key file in <code>generated-keys/</code>, then refresh.</p>
        </div>
      ) : ledgerExpanded ? (
        <ol className="key-ledger" id="managed-wallet-list">
          {keypairs.map((keypair, index) => (
            <li key={keypair.address} className={selectedSet.has(keypair.address) ? "selected" : ""}>
              <label>
                <input type="checkbox" checked={selectedSet.has(keypair.address)} onChange={() => toggle(keypair.address)} />
                <span className={`wallet-ident ident-${index % 4}`} />
                <span className="ledger-address"><strong>{shortAddress(keypair.address)}</strong><code>{keypair.address}</code></span>
                <span className="ledger-file"><strong>{keypair.file}</strong><small>{formatVaultDate(keypair.createdAt)}</small></span>
                <span className="custody-badge">Ready to sign</span>
              </label>
            </li>
          ))}
        </ol>
      ) : (
        <button
          className="vault-collapsed"
          id="managed-wallet-list"
          type="button"
          onClick={() => setLedgerExpandedOverride(true)}
        >
          <strong>{keypairs.length.toLocaleString()} managed wallets hidden</strong>
          <span>{selected.length > 0 ? `${selected.length.toLocaleString()} selected · ` : ""}Click to show the list</span>
        </button>
      )}
    </section>
  );
}

function WalletRail({
  plan,
  lookupPlan,
}: {
  plan: TransferPlan | null;
  lookupPlan: LookupTableSharePlanInput | null;
}) {
  if (!plan && lookupPlan) {
    const selectedPositions = lookupPlan.receiversFromLookupTables.reduce((total, selection) => {
      const indexes = new Set(selection.indexes ?? []);
      for (const range of selection.ranges ?? []) {
        for (let index = range.start; index <= range.end; index += 1) indexes.add(index);
      }
      return total + indexes.size;
    }, lookupPlan.receivers.length);
    return (
      <div className="empty-flow">
        {selectedPositions.toLocaleString()} recipient position{selectedPositions === 1 ? "" : "s"} will be resolved from the ALT.
      </div>
    );
  }
  if (!plan) return <div className="empty-flow">Enter a valid plan to map the wallet flow.</div>;
  const sources = plan.senders;
  const destinations = plan.receivers;
  return (
    <div className={`wallet-flow ${plan.type}`}>
      <WalletGroup id="source-wallets" label="source" wallets={sources} />
      <div className="rail" aria-hidden="true"><span /><b>→</b></div>
      <WalletGroup id="destination-wallets" label="destination" wallets={destinations} />
    </div>
  );
}

function WalletGroup({
  id,
  label,
  wallets,
}: {
  id: string;
  label: "source" | "destination";
  wallets: readonly { address: string; amountSol?: string }[];
}) {
  const [expandedOverride, setExpandedOverride] = useState<boolean | null>(null);
  const canCollapse = wallets.length > 8;
  const expanded = expandedOverride ?? !canCollapse;
  const pluralLabel = `${label}s`;

  return (
    <div className={`wallet-group ${pluralLabel}`}>
      <div className="wallet-group-heading">
        <span className="group-label">
          {wallets.length === 1 ? capitalize(label) : `${wallets.length.toLocaleString()} ${pluralLabel}`}
        </span>
        {canCollapse && (
          <button
            className="wallet-group-toggle"
            type="button"
            aria-controls={id}
            aria-expanded={expanded}
            aria-label={`${expanded ? "Hide" : "Show"} ${wallets.length.toLocaleString()} ${pluralLabel}`}
            onClick={() => setExpandedOverride(!expanded)}
          >
            {expanded ? "Hide" : "Show"} <span aria-hidden="true">{expanded ? "▴" : "▾"}</span>
          </button>
        )}
      </div>
      {expanded ? (
        <div className="wallet-stack" id={id}>
          {wallets.map((wallet, index) => (
            <Wallet key={wallet.address} address={wallet.address} amount={wallet.amountSol} index={index} />
          ))}
        </div>
      ) : (
        <button
          className="wallet-stack-summary"
          id={id}
          type="button"
          onClick={() => setExpandedOverride(true)}
        >
          <span className="wallet-stack-glyph" aria-hidden="true"><i /><i /><i /></span>
          <span><strong>{wallets.length.toLocaleString()} wallets</strong><small>Hidden from preview</small></span>
        </button>
      )}
    </div>
  );
}

function Wallet({ address, amount, index }: { address: string; amount?: string; index: number }) {
  return (
    <div className="wallet">
      <span className={`wallet-ident ident-${index % 4}`} />
      <span className="wallet-address">{shortAddress(address)}</span>
      {amount && <strong>{amount} SOL</strong>}
    </div>
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function jsonSummary(lineCount: number, plan: TransferPlan | null): string {
  const lines = `${lineCount.toLocaleString()} lines`;
  if (!plan) return lines;
  const senders = `${plan.senders.length.toLocaleString()} sender${plan.senders.length === 1 ? "" : "s"}`;
  const receivers = `${plan.receivers.length.toLocaleString()} receiver${plan.receivers.length === 1 ? "" : "s"}`;
  return `${lines}; ${senders}, ${receivers}`;
}

function sampleWithoutReplacement<T>(values: readonly T[], count: number): T[] {
  const pool = [...values];
  for (let index = 0; index < count; index += 1) {
    const swapIndex = index + secureRandomIndex(pool.length - index);
    [pool[index], pool[swapIndex]] = [pool[swapIndex]!, pool[index]!];
  }
  return pool.slice(0, count);
}

function secureRandomIndex(maxExclusive: number): number {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive < 1) {
    throw new Error("Random selection requires at least one available wallet");
  }
  const range = 0x1_0000_0000;
  const unbiasedLimit = Math.floor(range / maxExclusive) * maxExclusive;
  const random = new Uint32Array(1);
  do {
    crypto.getRandomValues(random);
  } while (random[0]! >= unbiasedLimit);
  return random[0]! % maxExclusive;
}

function QuotePanel({ preparations }: { preparations: Preparation[] }) {
  const preparation = preparations[0] ?? null;
  const quote = preparation ? aggregateQuote(preparations) : null;
  const largestSize = Math.max(...preparations.map((item) => item.transactionSizeBytes), 0);
  const sizeLimit = preparation?.transactionVersion === 1 ? 4_096 : 1_232;
  return (
    <div className={`quote-panel ${preparation ? "quoted" : ""}`}>
      <div className="section-title"><h3>Transaction data</h3><span>{preparation ? "Live estimate" : "Awaiting quote"}</span></div>
      {preparation ? (
        <>
          <QuoteRows quote={quote!} />
          <div className="quote-meta">
            <span><strong>{preparation.requiredSigners.length}</strong> signer{preparation.requiredSigners.length === 1 ? "" : "s"}</span>
            <span><strong>{preparations.reduce((sum, item) => sum + item.computeUnitLimit, 0).toLocaleString()}</strong> total CU limit</span>
            <span><strong>{Object.keys(preparation.addressLookupTables ?? {}).length}</strong> ALT{Object.keys(preparation.addressLookupTables ?? {}).length === 1 ? "" : "s"}</span>
            <span title={`${sizeLimit - largestSize} bytes remaining in the largest batch`}>
              <strong>{largestSize.toLocaleString()} / {sizeLimit.toLocaleString()}</strong> max bytes
            </span>
          </div>
        </>
      ) : (
        <div className="quote-placeholder">
          <span>Fees</span><span>Speed</span><span>Signers</span><span>Size</span>
        </div>
      )}
    </div>
  );
}

function aggregateQuote(preparations: readonly Preparation[]): TransactionQuote {
  const first = preparations[0];
  if (!first) throw new Error("No prepared transaction quote is available");
  const sum = (field: "transferLamports" | "baseFeeLamports" | "priorityFeeLamports" | "senderTipLamports" | "totalFeeLamports") =>
    preparations.reduce((total, item) => total + BigInt(item.quote[field]), 0n).toString();
  return {
    transactionCount: preparations.length,
    transferLamports: sum("transferLamports"),
    baseFeeLamports: sum("baseFeeLamports"),
    priorityFeeLamports: sum("priorityFeeLamports"),
    senderTipLamports: sum("senderTipLamports"),
    totalFeeLamports: sum("totalFeeLamports"),
    speed: first.quote.speed,
  };
}

function SignerProgress({
  signers,
  statuses,
}: {
  signers: string[];
  statuses: Record<string, SignerUiStatus>;
}) {
  const missing = signers.filter((signer) => statuses[signer] !== "signed").length;
  return (
    <section className="signer-panel" aria-labelledby="signer-progress-title">
      <div className="section-title">
        <h3 id="signer-progress-title">Required signatures</h3>
        <span>{missing === 0 ? "All signatures collected" : `${missing} missing`}</span>
      </div>
      <ol className="signer-list">
        {signers.map((signer, index) => {
          const status = statuses[signer] ?? "waiting";
          return (
            <li key={signer} className={`signer-row ${status}`}>
              <span className="signer-number">{index + 1}</span>
              <span className="signer-address" title={signer}>{shortAddress(signer)}</span>
              <span className="signer-status">
                <i aria-hidden="true" />{signerStatusLabel(status)}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function QuoteRows({ quote }: { quote: TransactionQuote }) {
  return (
    <dl className="quote-rows">
      <div><dt>Base fee</dt><dd>{formatLamports(quote.baseFeeLamports)} SOL</dd></div>
      <div><dt>Priority fee</dt><dd>{formatLamports(quote.priorityFeeLamports)} SOL</dd></div>
      <div><dt>Sender tip</dt><dd>{formatLamports(quote.senderTipLamports)} SOL</dd></div>
      <div className="quote-total"><dt>Total estimated fees</dt><dd>{formatLamports(quote.totalFeeLamports)} SOL</dd></div>
    </dl>
  );
}

function parseEditor(value: string): {
  raw: unknown | null;
  plan: TransferPlan | null;
  lookupPlan: LookupTableSharePlanInput | null;
  error: string | null;
  normalizedAlias: boolean;
} {
  try {
    const raw: unknown = JSON.parse(value);
    const result = parseTransferPlanInput(raw);
    return {
      raw,
      plan: result.plan,
      lookupPlan: result.lookupPlan,
      error: null,
      normalizedAlias: result.normalizedAlias,
    };
  } catch (reason) {
    if (reason instanceof PlanValidationError) return { raw: null, plan: null, lookupPlan: null, error: reason.issues[0] ?? reason.message, normalizedAlias: false };
    return { raw: null, plan: null, lookupPlan: null, error: reason instanceof Error ? reason.message : "Invalid JSON", normalizedAlias: false };
  }
}

function shortAddress(value: string): string {
  return `${value.slice(0, 5)}…${value.slice(-5)}`;
}

function formatLamports(value: string): string {
  return lamportsToSol(BigInt(value));
}

function flowDescription(plan: TransferPlan | null): string {
  if (!plan) return "The decoded flow will appear here.";
  if (plan.type === "share") return `One source distributes SOL to ${plan.receivers.length} wallet${plan.receivers.length === 1 ? "" : "s"}.`;
  return `${plan.senders.length} wallets consolidate SOL into one destination.`;
}

function stageLabel(stage: Stage): string {
  const labels: Record<Stage, string> = {
    idle: "Plan not prepared",
    preparing: "Fetching balances and fees",
    ready: "Prepared and ready to sign",
    signing: "Collecting partial signatures",
    submitting: "Submitting transaction batch",
    confirmed: "On-chain confirmation received",
    failed: "Review the issue above",
  };
  return labels[stage];
}

function signerStatusLabel(status: SignerUiStatus): string {
  const labels: Record<SignerUiStatus, string> = {
    waiting: "Waiting",
    signing: "Signing…",
    signed: "Signed",
    failed: "Failed",
  };
  return labels[status];
}

function formatVaultDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Imported file" : date.toLocaleString();
}
