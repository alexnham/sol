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
  ConsolidationPlan,
} from "../shared/contracts";
import { CONSOLIDATION_SIGNATURE_LIMITS } from "../shared/contracts";
import { getTransferTotal, lamportsToSol, parseTransferPlanInput, PlanValidationError } from "../shared/schema";
import {
  buildPreparedTransaction,
  encodeSignedTransaction,
  signPreparedTransaction,
  signPreparedTransactionInParallel,
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
import { AirshipTab } from "./features/airship";
import { GuideTab } from "./features/guide";
import { LiquidityTab } from "./features/liquidity";
import { MintingTab } from "./features/minting";

const SHARE_SAMPLE = `{
  "type": "share",
  "senders": [
    { "address": "DzcSBpVniutt6w5pyuytxLUqJcWMh3mMawMmxaquLsbZ" }
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
    { "address": "DzcSBpVniutt6w5pyuytxLUqJcWMh3mMawMmxaquLsbZ", "amountSol": "0.001" },
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
type AppTab = "workbench" | "keygen" | "minting" | "airship" | "liquidity" | "guide";

const FALLBACK_SOURCE = "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE";
const FALLBACK_DESTINATION = "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ";
const KEYGEN_PAGE_SIZE = 25;
const MAX_BLOCKHASH_RETRIES = 2;

export default function App() {
  const [activeTab, setActiveTab] = useState<AppTab>("workbench");
  const [json, setJson] = useState(SHARE_SAMPLE);
  const [network, setNetwork] = useState<Network>("devnet");
  const [preset, setPreset] = useState<DeliveryPreset>("economy");
  const [transactionVersion, setTransactionVersion] = useState<TransactionVersion>(1);
  const [consolidationSignatures, setConsolidationSignatures] = useState(CONSOLIDATION_SIGNATURE_LIMITS[1]);
  const [preparations, setPreparations] = useState<Preparation[]>([]);
  const [results, setResults] = useState<SubmissionResult[]>([]);
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
  const [copiedWorkbenchTransactions, setCopiedWorkbenchTransactions] = useState(false);
  const [airdropRecipients, setAirdropRecipients] = useState<string[]>([]);

  const parsed = useMemo(() => parseEditor(json), [json]);
  const preparation = preparations[0] ?? null;
  const plan = parsed.plan ?? preparation?.normalizedPlan ?? null;
  const jsonLineCount = json.split("\n").length;
  const jsonIsLarge = jsonLineCount > 40 || json.length > 4_000;
  const editorExpanded = editorExpandedOverride ?? !jsonIsLarge;
  const consolidationSignatureLimit = Math.min(
    consolidationSignatures,
    CONSOLIDATION_SIGNATURE_LIMITS[transactionVersion],
  );
  const consolidationTransactionEstimate = plan?.type === "consolidation"
    ? estimateConsolidationTransactions(plan, consolidationSignatureLimit)
    : 0;

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
        senders: selected.map((walletAddress) => ({ address: walletAddress, amountSol: "0.001" })),
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
          : [{ address: FALLBACK_DESTINATION, amountSol: "0.001" }],
      };
    } else {
      const currentSource = plan?.senders.find(
        (sender) => !selected.includes(sender.address),
      )?.address ?? FALLBACK_SOURCE;
      nextPlan = {
        type: "share",
        senders: [{ address: currentSource }],
        receivers: selected.map((walletAddress) => ({ address: walletAddress, amountSol: "0.001" })),
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

  function useVaultKeysForAirdrop(addresses: string[]) {
    const selected = [...new Set(addresses)];
    if (selected.length === 0) return;
    setAirdropRecipients(selected);
    setActiveTab("airship");
  }

  function flipTransferDirection() {
    if (!plan) return;
    invalidate(JSON.stringify(flipTransferPlan(plan), null, 2));
  }

  function invalidate(nextJson?: string) {
    if (nextJson !== undefined) setJson(nextJson);
    setPreparations([]);
    setResults([]);
    setCopiedWorkbenchTransactions(false);
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

  async function prepare(): Promise<Preparation[] | null> {
    if (!parsed.raw) return null;
    setStage("preparing");
    setError(null);
    setResults([]);
    setCopiedWorkbenchTransactions(false);
    try {
      const next = await prepareTransfer(
        parsed.raw,
        network,
        preset,
        parsed.plan?.plugin ?? parsed.lookupPlan?.plugin ?? pluginId,
        transactionVersion,
        parsed.plan?.type === "consolidation"
          ? consolidationSignatureLimit
          : undefined,
      );
      setPreparations(next);
      setSignerStatuses(
        Object.fromEntries(
          [...new Set(next.flatMap((item) => item.requiredSigners))]
            .map((signer) => [signer, "waiting"]),
        ),
      );
      setStage("ready");
      return next;
    } catch (reason) {
      fail(reason);
      return null;
    }
  }

  async function prepareAndSend() {
    const next = await prepare();
    if (!next) return;
    if (network === "mainnet") {
      setShowReview(true);
      return;
    }
    await signAndSend(next);
  }

  async function requestSend() {
    if (preparations.length === 0) return;
    if (network === "mainnet") {
      setShowReview(true);
      return;
    }
    await signAndSend(preparations);
  }

  async function signAndSend(activePreparations: Preparation[]) {
    if (activePreparations.length === 0) return;
    setShowReview(false);
    const managedAddresses = new Set(vaultKeys.map((keypair) => keypair.address));
    const requiredSigners = [...new Set(activePreparations.flatMap((item) => item.requiredSigners))];
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
      setSignerStatuses(
        Object.fromEntries(requiredSigners.map((signer) => [signer, "waiting"])),
      );
      let pending = activePreparations;
      let blockhashRetry = 0;
      const completed: SubmissionResult[] = [];

      while (pending.length > 0) {
        setStage("signing");
        const signedTransactions = await Promise.all(pending.map(async (item) => {
          const vaultProvider = createVaultSignerProvider(item.preparationId);
          const transaction = await buildPreparedTransaction(item);
          const managedSigners = item.requiredSigners.filter((signer) => managedAddresses.has(signer));
          const externalSigners = item.requiredSigners.filter((signer) => !managedAddresses.has(signer));
          let signed = await signPreparedTransactionInParallel(
            transaction,
            managedSigners,
            vaultProvider,
            (signerAddress, status) => {
              setSignerStatuses((current) => ({ ...current, [signerAddress]: status }));
            },
          );
          if (externalSigners.length > 0) {
            signed = await signPreparedTransaction(
              signed,
              externalSigners,
              externalProvider!,
              (signerAddress, status) => {
                setSignerStatuses((current) => ({ ...current, [signerAddress]: status }));
              },
            );
          }
          return encodeSignedTransaction(signed);
        }));

        setStage("submitting");
        const settled = await Promise.allSettled(
          pending.map((item, index) => submitTransfer(item.preparationId, signedTransactions[index]!)),
        );
        const retryPlans: Preparation[] = [];
        const terminalFailures: unknown[] = [];
        settled.forEach((submission, index) => {
          if (submission.status === "fulfilled") completed.push(submission.value);
          else if (isBlockhashFailure(submission.reason)) retryPlans.push(pending[index]!);
          else terminalFailures.push(submission.reason);
        });
        setResults([...completed]);

        if (terminalFailures.length > 0) {
          const detail = errorMessage(terminalFailures[0]);
          throw new Error(`${terminalFailures.length} transaction${terminalFailures.length === 1 ? "" : "s"} failed: ${detail}`);
        }
        if (retryPlans.length === 0) break;
        if (blockhashRetry >= MAX_BLOCKHASH_RETRIES) {
          throw new Error(`${retryPlans.length} transaction${retryPlans.length === 1 ? "" : "s"} still failed after ${MAX_BLOCKHASH_RETRIES} fresh-blockhash retries`);
        }

        blockhashRetry += 1;
        setStage("preparing");
        const refreshed = await Promise.all(retryPlans.map((item) => prepareTransfer(
          item.normalizedPlan,
          item.network,
          item.preset,
          item.pluginId,
          item.transactionVersion,
          item.requiredSigners.length,
        )));
        pending = refreshed.flat();
        if (pending.length === 0) throw new Error("Fresh-blockhash preparation returned no transactions");
      }
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
            <h1>Solana workbench</h1>
            <p>{activeTab === "guide" ? "Practical recipes for tokens, keys, and transactions." : activeTab === "minting" ? "Create and manage SPL Token mints." : activeTab === "airship" ? "Distribute tokens with AirShip or a standard SPL airdrop." : activeTab === "liquidity" ? "Open markets and manage custom AMM liquidity." : transactionVersion === 0
              ? "ALT-compressed distributor transactions."
              : "Larger v1 transactions with direct System transfers."}</p>
          </div>
        </div>
        <div className="topbar-controls">
          <nav className="app-tabs" aria-label="Workbench sections">
            <button type="button" className={activeTab === "workbench" ? "active" : ""} onClick={() => setActiveTab("workbench")}>Workbench</button>
            <button type="button" className={activeTab === "keygen" ? "active" : ""} onClick={() => setActiveTab("keygen")}>Keygen <span>{vaultKeys.length}</span></button>
            <button type="button" className={activeTab === "minting" ? "active" : ""} onClick={() => setActiveTab("minting")}>Minting</button>
            <button type="button" className={activeTab === "airship" ? "active" : ""} onClick={() => setActiveTab("airship")}>Airdrop</button>
            <button type="button" className={activeTab === "liquidity" ? "active" : ""} onClick={() => setActiveTab("liquidity")}>Liquidity</button>
            <button type="button" className={activeTab === "guide" ? "active" : ""} onClick={() => setActiveTab("guide")}>Tokens</button>
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
                  setConsolidationSignatures((current) => Math.min(current, CONSOLIDATION_SIGNATURE_LIMITS[value]));
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
            <div className="review-heading-actions">
              <button
                className="flip-transfer-button"
                type="button"
                disabled={!plan}
                onClick={flipTransferDirection}
                aria-label="Flip senders and receivers"
                title={plan ? "Reverse the transfer direction" : "Enter a valid plan with explicit receivers to flip it"}
              >
                <span aria-hidden="true">⇄</span>
                Flip
              </button>
              <span className="one-tx"><strong>{preparation?.quote.transactionCount ?? 1}</strong> transaction{(preparation?.quote.transactionCount ?? 1) === 1 ? "" : "s"}</span>
            </div>
          </div>

          <WalletRail plan={plan} lookupPlan={preparation ? null : parsed.lookupPlan} />

          <TransactionBreakdown
            plan={plan}
            lookupPlan={preparation ? null : parsed.lookupPlan}
            preparations={preparations}
            transactionVersion={transactionVersion}
            pluginId={plan?.plugin ?? parsed.lookupPlan?.plugin ?? pluginId}
          />

          <div className="route-section">
            <div className="section-title">
              <h3>Delivery route</h3>
              <span>Priority fee capped at 0.0001 SOL</span>
            </div>
            {plan?.type === "consolidation" && (
              <div className="consolidation-batch-config">
                <div>
                  <strong>Signatures per transaction</strong>
                  <small>
                    {consolidationTransactionEstimate} transaction{consolidationTransactionEstimate === 1 ? "" : "s"} estimated · v{transactionVersion} allows up to {CONSOLIDATION_SIGNATURE_LIMITS[transactionVersion]}
                  </small>
                </div>
                <label>
                  <span className="sr-only">Signatures per transaction</span>
                  <input
                    aria-label="Signatures per transaction"
                    type="number"
                    min={1}
                    max={CONSOLIDATION_SIGNATURE_LIMITS[transactionVersion]}
                    value={consolidationSignatureLimit}
                    onChange={(event) => {
                      const next = Math.max(1, Math.min(CONSOLIDATION_SIGNATURE_LIMITS[transactionVersion], Number(event.target.value) || 1));
                      setConsolidationSignatures(next);
                      invalidate();
                    }}
                  />
                  <span>/ {CONSOLIDATION_SIGNATURE_LIMITS[transactionVersion]}</span>
                </label>
              </div>
            )}
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
          {results.length > 0 && (
            <section className="submission-results" role="status" aria-labelledby="submission-results-title">
              <div className="submission-results-header">
                <strong id="submission-results-title">
                  {results.length} transaction{results.length === 1 ? "" : "s"} submitted
                </strong>
                <div><span>{results.filter((result) => result.status === "confirmed").length} confirmed</span><button className="secondary" type="button" onClick={() => { void copyLines(results.map((result) => result.signature)).then(() => setCopiedWorkbenchTransactions(true)).catch(() => setError("Could not access the clipboard")); }}>{copiedWorkbenchTransactions ? "Copied" : "Copy all transactions"}</button></div>
              </div>
              <ol>
                {results.map((result, index) => (
                  <li key={result.signature}>
                    <span className={`submission-status ${result.status}`}>
                      Transaction {index + 1} · {result.status}
                    </span>
                    <code title={result.signature}>{result.signature}</code>
                    <span>{(result.confirmationMs / 1000).toFixed(1)}s</span>
                    <a href={result.explorerUrl} target="_blank" rel="noreferrer">Open in Orb</a>
                  </li>
                ))}
              </ol>
            </section>
          )}

          <div className="action-bar">
            <div className="action-status">
              <span className={`pulse ${stage}`} />
              <span>{stageLabel(stage)}</span>
            </div>
            {!preparation ? (
              <div className="action-buttons">
                <button className="secondary" disabled={!parsed.raw || stage === "preparing"} onClick={() => void prepare()} type="button">
                  {stage === "preparing" ? "Preparing live quote…" : "Prepare live quote"}
                </button>
                <button className="primary" disabled={!parsed.raw || stage === "preparing"} onClick={() => void prepareAndSend()} type="button">
                  {stage === "preparing" ? "Preparing…" : `Prepare & send on ${network}`}
                </button>
              </div>
            ) : stage === "confirmed" || stage === "failed" || stage === "preparing" ? (
              <button className="primary" disabled={stage === "preparing"} onClick={() => void prepare()} type="button">
                {stage === "preparing" ? "Preparing again…" : "Prepare again"}
              </button>
            ) : (
              <button className="primary" disabled={stage === "signing" || stage === "submitting"} onClick={() => void requestSend()} type="button">
                {stage === "signing" ? "Collecting signatures…" : stage === "submitting" ? "Submitting…" : `Sign and send on ${network}`}
              </button>
            )}
          </div>
        </section>
      </section>
      ) : activeTab === "keygen" ? (
        <KeygenPanel
          keypairs={vaultKeys}
          lookupTables={vaultLookupTables}
          network={network}
          busy={vaultBusy}
          error={vaultError}
          onGenerate={generateKeys}
          onRefresh={refreshVault}
          onUse={useVaultKeys}
          onUseForAirdrop={useVaultKeysForAirdrop}
          onUseLookupTable={useLookupTable}
        />
      ) : activeTab === "minting" ? (
        <MintingTab
          network={network}
          transactionVersion={transactionVersion}
          keypairs={vaultKeys}
        />
      ) : activeTab === "airship" ? (
        <AirshipTab network={network} keypairs={vaultKeys} recipientAddresses={airdropRecipients} />
      ) : activeTab === "liquidity" ? (
        <LiquidityTab network={network} transactionVersion={transactionVersion} keypairs={vaultKeys} />
      ) : (
        <GuideTab onNavigate={setActiveTab} />
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
              <button className="danger" onClick={() => void signAndSend(preparations)} type="button">Sign mainnet transaction</button>
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
  onUseForAirdrop,
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
  onUseForAirdrop(addresses: string[]): void;
  onUseLookupTable(address: string): void;
}) {
  const [count, setCount] = useState(1);
  const [randomCount, setRandomCount] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [requestedWalletPage, setWalletPage] = useState(1);
  const [ledgerExpandedOverride, setLedgerExpandedOverride] = useState<boolean | null>(null);
  const [altAuthority, setAltAuthority] = useState("");
  const [altBusy, setAltBusy] = useState(false);
  const [altError, setAltError] = useState<string | null>(null);
  const [createdAlt, setCreatedAlt] = useState<CreatedAddressLookupTable | null>(null);
  const [existingAltAddress, setExistingAltAddress] = useState("");
  const [registeringAlt, setRegisteringAlt] = useState(false);
  const selectedSet = new Set(selected);
  const ledgerExpanded = ledgerExpandedOverride ?? keypairs.length <= 25;
  const walletPageCount = Math.max(1, Math.ceil(keypairs.length / KEYGEN_PAGE_SIZE));
  const walletPage = Math.min(requestedWalletPage, walletPageCount);
  const walletPageStart = (walletPage - 1) * KEYGEN_PAGE_SIZE;
  const visibleKeypairs = keypairs.slice(walletPageStart, walletPageStart + KEYGEN_PAGE_SIZE);
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
          <button className="secondary airdrop-recipient-action" type="button" disabled={selected.length === 0} onClick={() => onUseForAirdrop(selected)}>Use as airdrop recipients</button>
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
        <div className="key-ledger-page">
          <ol className="key-ledger" id="managed-wallet-list">
            {visibleKeypairs.map((keypair, index) => (
              <li key={keypair.address} className={selectedSet.has(keypair.address) ? "selected" : ""}>
                <label>
                  <input type="checkbox" checked={selectedSet.has(keypair.address)} onChange={() => toggle(keypair.address)} />
                  <span className={`wallet-ident ident-${(walletPageStart + index) % 4}`} />
                  <span className="ledger-address"><strong>{shortAddress(keypair.address)}</strong><code>{keypair.address}</code></span>
                  <span className="ledger-file"><strong>{keypair.file}</strong><small>{formatVaultDate(keypair.createdAt)}</small></span>
                  <span className="custody-badge">Ready to sign</span>
                </label>
              </li>
            ))}
          </ol>
          <nav className="key-ledger-pagination" aria-label="Managed wallet pages">
            <span>
              Showing {(walletPageStart + 1).toLocaleString()}–{Math.min(walletPageStart + KEYGEN_PAGE_SIZE, keypairs.length).toLocaleString()} of {keypairs.length.toLocaleString()}
              {selected.length > 0 ? ` · ${selected.length.toLocaleString()} selected total` : ""}
            </span>
            <div>
              <button
                className="secondary"
                type="button"
                aria-label="Previous wallet page"
                disabled={walletPage === 1}
                onClick={() => setWalletPage(walletPage - 1)}
              >Previous</button>
              <strong aria-live="polite">Page {walletPage} of {walletPageCount}</strong>
              <button
                className="secondary"
                type="button"
                aria-label="Next wallet page"
                disabled={walletPage === walletPageCount}
                onClick={() => setWalletPage(walletPage + 1)}
              >Next</button>
            </div>
          </nav>
        </div>
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

function TransactionBreakdown({
  plan,
  lookupPlan,
  preparations,
  transactionVersion,
  pluginId,
}: {
  plan: TransferPlan | null;
  lookupPlan: LookupTableSharePlanInput | null;
  preparations: Preparation[];
  transactionVersion: TransactionVersion;
  pluginId: string;
}) {
  const preparation = preparations[0] ?? null;
  const previewPlan = plan ?? lookupPlan;
  if (!previewPlan) {
    return (
      <section className="transaction-breakdown" aria-labelledby="transaction-breakdown-title">
        <div className="section-title">
          <h3 id="transaction-breakdown-title">Transaction breakdown</h3>
          <span>Waiting for a valid plan</span>
        </div>
        <p className="breakdown-empty">The message format, instructions, and signing requirements will appear here.</p>
      </section>
    );
  }

  const transferCount = previewPlan.type === "share"
    ? previewPlan.receivers.length + lookupRecipientCount(lookupPlan)
    : previewPlan.senders.length;
  const feePayer = preparation?.feePayer ?? previewPlan.feePayer ?? previewPlan.senders[0]?.address;
  const nativeTransfer = pluginId === "native-sol-transfer";
  const distributorCall = nativeTransfer && transactionVersion === 0 && previewPlan.type === "share";
  const hasTip = preparation
    ? BigInt(preparation.quote.senderTipLamports) > 0n
    : false;
  const altCount = preparation
    ? Object.keys(preparation.addressLookupTables ?? {}).length
    : previewPlan.addressLookupTables?.length ?? lookupPlan?.receiversFromLookupTables.length ?? 0;
  const signerCount = preparation?.requiredSigners.length
    ?? new Set([...previewPlan.senders.map((sender) => sender.address), ...(previewPlan.feePayer ? [previewPlan.feePayer] : [])]).size;
  const total = plan ? `${lamportsToSol(getTransferTotal(plan))} SOL` : "Resolved with quote";
  const stepCount = nativeTransfer
    ? (distributorCall ? 1 : transferCount) + 1 + (hasTip ? 1 : 0)
    : null;

  return (
    <section className="transaction-breakdown" aria-labelledby="transaction-breakdown-title">
      <div className="section-title">
        <h3 id="transaction-breakdown-title">Transaction breakdown</h3>
        <span>{preparation ? "Live message shape" : "Plan preview"}</span>
      </div>
      <div className="breakdown-shell">
        <dl className="breakdown-summary">
          <div><dt>Format</dt><dd>v{transactionVersion} message</dd></div>
          <div><dt>Fee payer</dt><dd title={feePayer}>{feePayer ? shortAddress(feePayer) : "Pending"}</dd></div>
          <div><dt>SOL moved</dt><dd>{total}</dd></div>
          <div><dt>Signatures</dt><dd>{signerCount}</dd></div>
        </dl>

        <ol className="instruction-stack" aria-label="Transaction instruction outline">
          <li>
            <span className="instruction-index">1</span>
            <span className="instruction-copy">
              <strong>{transactionVersion === 0 ? "Compute budget" : "Resource budget"}</strong>
              <small>{preparation
                ? `${preparation.computeUnitLimit.toLocaleString()} CU${preparation.microLamportsPerComputeUnit > 0 ? ` at ${preparation.microLamportsPerComputeUnit.toLocaleString()} μ-lamports/CU` : ""}`
                : "Limit and priority price are set by the live quote"}</small>
            </span>
            <code>{transactionVersion === 0 ? "ComputeBudget" : "v1 config"}</code>
          </li>
          <li>
            <span className="instruction-index">2</span>
            <span className="instruction-copy">
              <strong>{distributorCall
                ? "Distribute SOL"
                : nativeTransfer
                  ? `${transferCount.toLocaleString()} SOL transfer${transferCount === 1 ? "" : "s"}`
                  : "Transfer strategy"}</strong>
              <small>{distributorCall
                ? `One program call fans out to ${transferCount.toLocaleString()} recipient${transferCount === 1 ? "" : "s"}${preparations.length > 1 ? " per prepared batch" : ""}`
                : nativeTransfer
                  ? previewPlan.type === "share" ? "Source wallets pay the listed destinations" : "Each source pays the shared destination"
                  : `Instructions are supplied by ${pluginId}`}</small>
            </span>
            <code>{distributorCall ? "Distributor" : nativeTransfer ? "SystemProgram" : "Plugin"}</code>
          </li>
          {hasTip && (
            <li>
              <span className="instruction-index">3</span>
              <span className="instruction-copy"><strong>Sender tip</strong><small>{formatLamports(preparation!.quote.senderTipLamports)} SOL from the fee payer</small></span>
              <code>SystemProgram</code>
            </li>
          )}
        </ol>

        <div className="breakdown-footer">
          <span><i className={preparation ? "resolved" : ""} />Recent blockhash {preparation ? "attached" : "added at quote time"}</span>
          <span>{altCount > 0 ? `${altCount} address lookup table${altCount === 1 ? "" : "s"}` : "Inline account addresses"}</span>
          <span>{stepCount === null ? "Plugin-defined instructions" : `${stepCount} message step${stepCount === 1 ? "" : "s"} summarized`}</span>
        </div>
      </div>
    </section>
  );
}

function lookupRecipientCount(plan: LookupTableSharePlanInput | null): number {
  if (!plan) return 0;
  return plan.receiversFromLookupTables.reduce((total, selection) => {
    const indexes = new Set(selection.indexes ?? []);
    for (const range of selection.ranges ?? []) {
      for (let index = range.start; index <= range.end; index += 1) indexes.add(index);
    }
    return total + indexes.size;
  }, 0);
}

function estimateConsolidationTransactions(plan: ConsolidationPlan, signatureLimit: number): number {
  let batches = 0;
  for (let offset = 0; offset < plan.senders.length;) {
    const candidate = plan.senders.slice(offset, offset + signatureLimit);
    const separateFeePayer = Boolean(plan.feePayer) && !candidate.some((sender) => sender.address === plan.feePayer);
    const senderCount = Math.max(1, signatureLimit - (separateFeePayer ? 1 : 0));
    offset += Math.min(senderCount, plan.senders.length - offset);
    batches += 1;
  }
  return batches;
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

export function flipTransferPlan(plan: TransferPlan): TransferPlan {
  const sharedFields = {
    ...(plan.feePayer ? { feePayer: plan.feePayer } : {}),
    ...(plan.plugin ? { plugin: plan.plugin } : {}),
    ...(plan.addressLookupTables ? { addressLookupTables: plan.addressLookupTables } : {}),
  };

  if (plan.type === "share") {
    return {
      type: "consolidation",
      senders: plan.receivers.map(({ address, amountSol }) => ({ address, amountSol })),
      receivers: [{ address: plan.senders[0].address }],
      ...sharedFields,
    };
  }

  return {
    type: "share",
    senders: [{ address: plan.receivers[0].address }],
    receivers: plan.senders.map(({ address, amountSol }) => ({ address, amountSol })),
    ...sharedFields,
  };
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

export function isBlockhashFailure(reason: unknown): boolean {
  const message = errorMessage(reason);
  return /blockhash[^\n]*not found/i.test(message) || /prepared blockhash expired/i.test(message);
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
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

async function copyLines(values: readonly string[]): Promise<void> {
  await navigator.clipboard.writeText(values.join("\n"));
}
