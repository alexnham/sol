import { useEffect, useMemo, useState } from "react";
import type {
  DeliveryPreset,
  Network,
  Preparation,
  SubmissionResult,
  TransactionQuote,
  TransferPlan,
  PluginCatalog,
} from "../shared/contracts";
import { lamportsToSol, parseTransferPlan, PlanValidationError } from "../shared/schema";
import {
  buildPreparedTransaction,
  encodeSignedTransaction,
  signPreparedTransaction,
  transactionSize,
} from "../shared/transaction";
import {
  fetchPlugins,
  fetchVaultKeys,
  generateVaultKeys,
  prepareTransfer,
  submitTransfer,
  type VaultKeyMetadata,
} from "./api";
import { getSignerProvider } from "./signer-provider";
import { createVaultSignerProvider } from "./vault-signer";

const SAMPLE = `{
  "type": "share",
  "senders": [
    { "address": "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE" }
  ],
  "receivers": [
    { "address": "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ", "amountSol": "0.10" },
    { "address": "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta", "amountSol": "0.25" }
  ]
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
  const [json, setJson] = useState(SAMPLE);
  const [network, setNetwork] = useState<Network>("devnet");
  const [preset, setPreset] = useState<DeliveryPreset>("economy");
  const [preparation, setPreparation] = useState<Preparation | null>(null);
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
  const [vaultBusy, setVaultBusy] = useState(false);
  const [vaultError, setVaultError] = useState<string | null>(null);

  const parsed = useMemo(() => parseEditor(json), [json]);
  const plan = parsed.plan;

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
      setVaultKeys(await fetchVaultKeys());
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

  function invalidate(nextJson?: string) {
    if (nextJson !== undefined) setJson(nextJson);
    setPreparation(null);
    setResult(null);
    setError(null);
    setStage("idle");
    setSignerStatuses({});
  }

  function changeNetwork(value: Network) {
    setNetwork(value);
    if (value === "devnet" && preset !== "economy") setPreset("economy");
    invalidate();
  }

  async function prepare() {
    if (!parsed.raw || !plan) return;
    setStage("preparing");
    setError(null);
    setResult(null);
    try {
      const next = await prepareTransfer(parsed.raw, network, preset, plan.plugin ?? pluginId);
      setPreparation(next);
      setSignerStatuses(
        Object.fromEntries(next.requiredSigners.map((signer) => [signer, "waiting"])),
      );
      setStage("ready");
    } catch (reason) {
      fail(reason);
    }
  }

  async function requestSend() {
    if (!preparation) return;
    if (network === "mainnet") {
      setShowReview(true);
      return;
    }
    await signAndSend();
  }

  async function signAndSend() {
    if (!preparation) return;
    setShowReview(false);
    const managedAddresses = new Set(vaultKeys.map((keypair) => keypair.address));
    const canUseVault = preparation.requiredSigners.every((signer) => managedAddresses.has(signer));
    const externalProvider = getSignerProvider();
    const vaultProvider = createVaultSignerProvider(preparation.preparationId);
    const provider = externalProvider
      ? {
          id: "managed-and-external-signers",
          getSigner: (signerAddress: Parameters<typeof externalProvider.getSigner>[0]) =>
            managedAddresses.has(String(signerAddress))
              ? vaultProvider.getSigner(signerAddress)
              : externalProvider.getSigner(signerAddress),
        }
      : canUseVault
        ? vaultProvider
        : null;
    if (!provider) {
      const missing = preparation.requiredSigners.filter((signer) => !managedAddresses.has(signer));
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
        Object.fromEntries(preparation.requiredSigners.map((signer) => [signer, "waiting"])),
      );
      const transaction = await buildPreparedTransaction(preparation);
      const signed = await signPreparedTransaction(
        transaction,
        preparation.requiredSigners,
        provider,
        (signerAddress, status) => {
          setSignerStatuses((current) => ({ ...current, [signerAddress]: status }));
        },
      );
      setStage("submitting");
      const submission = await submitTransfer(
        preparation.preparationId,
        encodeSignedTransaction(signed),
      );
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
            <p>One message. Every wallet. One on-chain transaction.</p>
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
            <span className={`status-chip ${parsed.error ? "invalid" : "valid"}`}>
              {parsed.error ? "Needs attention" : "Valid structure"}
            </span>
          </div>
          <div className="code-frame">
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
          <div className="editor-message" role="status">
            {parsed.error ? (
              <><span className="message-icon">!</span><span>{parsed.error}</span></>
            ) : parsed.normalizedAlias ? (
              <><span className="message-icon info">i</span><span>“recievers” is supported and will be normalized to “receivers”.</span></>
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
            <span className="one-tx"><strong>1</strong> transaction</span>
          </div>

          <WalletRail plan={plan} />

          <div className="route-section">
            <div className="section-title">
              <h3>Delivery route</h3>
              <span>Priority fee capped at 0.0001 SOL</span>
            </div>
            <div className="routes">
              {PRESETS.map((item) => {
                const disabled = network === "devnet" && item.id !== "economy";
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
                    <span className="route-count">1 tx</span>
                  </button>
                );
              })}
            </div>
          </div>

          <QuotePanel preparation={preparation} />

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
              <button className="primary" disabled={!plan || stage === "preparing"} onClick={prepare} type="button">
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
          busy={vaultBusy}
          error={vaultError}
          onGenerate={generateKeys}
          onRefresh={refreshVault}
          onUse={useVaultKeys}
        />
      )}

      {showReview && preparation && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowReview(false)}>
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onMouseDown={(event) => event.stopPropagation()}>
            <span className="mainnet-badge">Mainnet transfer</span>
            <h2 id="confirm-title">Review real-fund submission</h2>
            <p>This action requests {preparation.requiredSigners.length} signature{preparation.requiredSigners.length === 1 ? "" : "s"} and submits one irreversible transaction.</p>
            <QuoteRows quote={preparation.quote} />
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
  busy,
  error,
  onGenerate,
  onRefresh,
  onUse,
}: {
  keypairs: VaultKeyMetadata[];
  busy: boolean;
  error: string | null;
  onGenerate(count: number): Promise<void>;
  onRefresh(): Promise<void>;
  onUse(addresses: string[], role: "sources" | "destinations"): void;
}) {
  const [count, setCount] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const selectedSet = new Set(selected);

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

      <div className="vault-toolbar">
        <label className="select-all">
          <input
            type="checkbox"
            checked={keypairs.length > 0 && selected.length === keypairs.length}
            onChange={() => setSelected(selected.length === keypairs.length ? [] : keypairs.map((keypair) => keypair.address))}
          />
          {selected.length > 0 ? `${selected.length} selected` : `${keypairs.length} managed`}
        </label>
        <div>
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
      ) : (
        <ol className="key-ledger">
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
      )}
    </section>
  );
}

function WalletRail({ plan }: { plan: TransferPlan | null }) {
  if (!plan) return <div className="empty-flow">Enter a valid plan to map the wallet flow.</div>;
  const sources = plan.senders;
  const destinations = plan.receivers;
  return (
    <div className={`wallet-flow ${plan.type}`}>
      <div className="wallet-group">
        <span className="group-label">{sources.length === 1 ? "Source" : `${sources.length} sources`}</span>
        {sources.map((wallet, index) => (
          <Wallet key={wallet.address} address={wallet.address} amount={"amountSol" in wallet ? wallet.amountSol : undefined} index={index} />
        ))}
      </div>
      <div className="rail" aria-hidden="true"><span /><b>→</b></div>
      <div className="wallet-group destinations">
        <span className="group-label">{destinations.length === 1 ? "Destination" : `${destinations.length} destinations`}</span>
        {destinations.map((wallet, index) => (
          <Wallet key={wallet.address} address={wallet.address} amount={"amountSol" in wallet ? wallet.amountSol : undefined} index={index} />
        ))}
      </div>
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

function QuotePanel({ preparation }: { preparation: Preparation | null }) {
  return (
    <div className={`quote-panel ${preparation ? "quoted" : ""}`}>
      <div className="section-title"><h3>Transaction data</h3><span>{preparation ? "Live estimate" : "Awaiting quote"}</span></div>
      {preparation ? (
        <>
          <QuoteRows quote={preparation.quote} />
          <div className="quote-meta">
            <span><strong>{preparation.requiredSigners.length}</strong> signer{preparation.requiredSigners.length === 1 ? "" : "s"}</span>
            <span><strong>{preparation.computeUnitLimit.toLocaleString()}</strong> CU limit</span>
            <span><strong>≤ 1,232</strong> bytes</span>
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

function parseEditor(value: string): { raw: unknown | null; plan: TransferPlan | null; error: string | null; normalizedAlias: boolean } {
  try {
    const raw: unknown = JSON.parse(value);
    const result = parseTransferPlan(raw);
    return { raw, plan: result.plan, error: null, normalizedAlias: result.normalizedAlias };
  } catch (reason) {
    if (reason instanceof PlanValidationError) return { raw: null, plan: null, error: reason.issues[0] ?? reason.message, normalizedAlias: false };
    return { raw: null, plan: null, error: reason instanceof Error ? reason.message : "Invalid JSON", normalizedAlias: false };
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
    submitting: "Submitting one transaction",
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
