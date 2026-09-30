import { useEffect, useMemo, useState } from "react";
import type { Network } from "../../../shared/contracts";
import type { AirshipCompressedBalanceReport, AirshipDecompressionResult, AirshipDropJob, AirshipToken, TokenCollectionJob, TokenCollectionPreview } from "../../../shared/airship";
import { createAirshipDrop, createTokenCollection, decompressAirshipTokens, fetchAirshipCompressedBalances, fetchAirshipDrop, fetchAirshipTokens, fetchTokenCollection, previewTokenCollection, type VaultKeyMetadata } from "../../api";
import {
  airshipJobLabel,
  explorerTransaction,
  formatSol,
  formatTokenUnits,
  normalizeTokenAmount,
  shortAddress,
} from "./presentation";

const RECIPIENT_SAMPLE = `D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ
9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta`;
type DeliveryMethod = "airship" | "standard";

export function AirshipTab({ network, keypairs, recipientAddresses = [] }: { network: Network; keypairs: VaultKeyMetadata[]; recipientAddresses?: string[] }) {
  const [delivery, setDelivery] = useState<DeliveryMethod>("airship");
  const [sender, setSender] = useState("");
  const [tokens, setTokens] = useState<AirshipToken[]>([]);
  const [mint, setMint] = useState("");
  const [recipientsText, setRecipientsText] = useState(() => recipientAddresses.length > 0
    ? recipientAddresses.join("\n")
    : RECIPIENT_SAMPLE);
  const [amount, setAmount] = useState("1");
  const [loadingTokens, setLoadingTokens] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<AirshipDropJob | null>(null);
  const [balanceOwner, setBalanceOwner] = useState("");
  const [balanceReport, setBalanceReport] = useState<AirshipCompressedBalanceReport | null>(null);
  const [loadingBalances, setLoadingBalances] = useState(false);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [decompressMint, setDecompressMint] = useState("");
  const [decompressAmount, setDecompressAmount] = useState("1");
  const [decompressing, setDecompressing] = useState(false);
  const [decompressError, setDecompressError] = useState<string | null>(null);
  const [decompression, setDecompression] = useState<AirshipDecompressionResult | null>(null);
  const [collectionDestination, setCollectionDestination] = useState("");
  const [collectionMint, setCollectionMint] = useState("");
  const [collectionSources, setCollectionSources] = useState<string[]>([]);
  const [collectionAmounts, setCollectionAmounts] = useState<Record<string, string>>({});
  const [collectionPreview, setCollectionPreview] = useState<TokenCollectionPreview | null>(null);
  const [collectionJob, setCollectionJob] = useState<TokenCollectionJob | null>(null);
  const [collectionBusy, setCollectionBusy] = useState(false);
  const [collectionError, setCollectionError] = useState<string | null>(null);
  const [copiedTransactions, setCopiedTransactions] = useState<"airdrop" | "collection" | null>(null);

  useEffect(() => {
    if (!sender || !keypairs.some((keypair) => keypair.address === sender)) {
      setSender(keypairs[0]?.address ?? "");
    }
  }, [keypairs, sender]);

  useEffect(() => {
    if (!collectionDestination || !keypairs.some((keypair) => keypair.address === collectionDestination)) {
      setCollectionDestination(keypairs[0]?.address ?? "");
    }
  }, [collectionDestination, keypairs]);

  useEffect(() => { if (!collectionMint && mint) setCollectionMint(mint); }, [collectionMint, mint]);

  useEffect(() => {
    if (!sender) { setTokens([]); setMint(""); return; }
    let active = true;
    setLoadingTokens(true);
    setError(null);
    fetchAirshipTokens(network, sender)
      .then((items) => {
        if (!active) return;
        setTokens(items);
        setMint((current) => items.some((token) => token.mint === current && token.supported)
          ? current
          : items.find((token) => token.supported)?.mint ?? "");
      })
      .catch((reason: unknown) => active && setError(reason instanceof Error ? reason.message : "Could not load AirShip tokens"))
      .finally(() => active && setLoadingTokens(false));
    return () => { active = false; };
  }, [network, sender]);

  useEffect(() => {
    if (!job || job.state === "confirmed" || job.state === "failed") return;
    const timer = window.setInterval(() => {
      fetchAirshipDrop(job.id)
        .then(setJob)
        .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not refresh AirShip progress"));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [job?.id, job?.state]);

  useEffect(() => {
    if (!collectionJob || collectionJob.state === "confirmed" || collectionJob.state === "failed") return;
    const timer = window.setInterval(() => fetchTokenCollection(collectionJob.id).then(setCollectionJob).catch((reason: unknown) => setCollectionError(reason instanceof Error ? reason.message : "Could not refresh collection progress")), 1_000);
    return () => window.clearInterval(timer);
  }, [collectionJob?.id, collectionJob?.state]);

  useEffect(() => {
    setBalanceReport(null);
    setBalanceError(null);
  }, [network]);

  const recipientLines = useMemo(() => recipientsText.split(/\r?\n/).map((value) => value.trim()).filter(Boolean), [recipientsText]);
  const duplicateCount = recipientLines.length - new Set(recipientLines).size;
  const selectedToken = tokens.find((token) => token.mint === mint) ?? null;
  const managedBalanceOwner = Boolean(balanceReport && keypairs.some((keypair) => keypair.address === balanceReport.owner));
  const decompressionBalance = balanceReport?.balances.find((balance) => balance.mint === decompressMint) ?? null;
  const recipientsPerTransaction = delivery === "airship" ? 15 : 10;
  const estimatedTransactions = Math.ceil(recipientLines.length / recipientsPerTransaction);
  const progress = job && job.totalTransactions > 0
    ? Math.round((job.confirmedTransactions / job.totalTransactions) * 100)
    : 0;
  const selectedCollectionSources = collectionPreview?.sources.filter(
    (source) => source.eligible && collectionSources.includes(source.owner),
  ) ?? [];
  const selectedCollectionClosures = selectedCollectionSources.filter(
    (source) => normalizeTokenAmount(collectionAmounts[source.owner] ?? source.amount) === normalizeTokenAmount(source.balance),
  );
  const selectedCollectionRent = selectedCollectionClosures.reduce(
    (total, source) => total + BigInt(source.rentLamports),
    0n,
  ).toString();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!sender || !mint) { setError("Choose a managed wallet and token"); return; }
    if (duplicateCount > 0) { setError("Remove duplicate recipient addresses before sending"); return; }
    const mainnetConfirmed = network !== "mainnet" || window.confirm(
      `${delivery === "airship" ? "AirShip" : "Standard airdrop"} ${amount} ${selectedToken?.symbol ?? "tokens"} to ${recipientLines.length.toLocaleString()} recipients on mainnet? This spends real tokens and SOL and cannot be undone.`,
    );
    if (!mainnetConfirmed) return;
    setSubmitting(true);
    setError(null);
    setJob(null);
    setCopiedTransactions(null);
    try {
      setJob(await createAirshipDrop({
        network,
        delivery,
        sender,
        mint,
        recipients: recipientLines,
        amountPerRecipient: amount,
        mainnetConfirmed,
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not start airdrop");
    } finally {
      setSubmitting(false);
    }
  }

  async function scanBalances(event: React.FormEvent) {
    event.preventDefault();
    setLoadingBalances(true);
    setBalanceError(null);
    setBalanceReport(null);
    setDecompression(null);
    setDecompressError(null);
    try {
      const report = await fetchAirshipCompressedBalances(network, balanceOwner);
      setBalanceReport(report);
      setDecompressMint((current) => report.balances.some((balance) => balance.mint === current)
        ? current
        : report.balances[0]?.mint ?? "");
    } catch (reason) {
      setBalanceError(reason instanceof Error ? reason.message : "Could not load compressed balances");
    } finally {
      setLoadingBalances(false);
    }
  }

  async function submitDecompression(event: React.FormEvent) {
    event.preventDefault();
    if (!balanceReport || !managedBalanceOwner || !decompressMint) {
      setDecompressError("Choose compressed tokens owned by a managed wallet");
      return;
    }
    const mainnetConfirmed = network !== "mainnet" || window.confirm(
      `Decompress ${decompressAmount} tokens into ${shortAddress(balanceReport.owner)} on mainnet? This submits an irreversible transaction.`,
    );
    if (!mainnetConfirmed) return;
    setDecompressing(true);
    setDecompressError(null);
    setDecompression(null);
    try {
      const result = await decompressAirshipTokens({
        network,
        owner: balanceReport.owner,
        mint: decompressMint,
        amount: decompressAmount,
        mainnetConfirmed,
      });
      setDecompression(result);
      const refreshed = await fetchAirshipCompressedBalances(network, balanceReport.owner);
      setBalanceReport(refreshed);
      if (balanceReport.owner === sender) setTokens(await fetchAirshipTokens(network, sender));
    } catch (reason) {
      setDecompressError(reason instanceof Error ? reason.message : "Could not decompress tokens");
    } finally {
      setDecompressing(false);
    }
  }

  async function loadCollectionPreview(event: React.FormEvent) {
    event.preventDefault();
    setCollectionBusy(true); setCollectionError(null); setCollectionPreview(null); setCollectionJob(null);
    try {
      const report = await previewTokenCollection({ network, destination: collectionDestination, mint: collectionMint });
      setCollectionPreview(report);
      setCollectionSources(report.sources.filter((source) => source.eligible).map((source) => source.owner));
      setCollectionAmounts(Object.fromEntries(report.sources.filter((source) => source.eligible).map((source) => [source.owner, collectionAmounts[source.owner] ?? source.amount])));
    } catch (reason) { setCollectionError(reason instanceof Error ? reason.message : "Could not preview token collection"); }
    finally { setCollectionBusy(false); }
  }

  async function launchCollection() {
    if (!collectionPreview) return;
    if (collectionSources.length === 0) { setCollectionError("Select at least one discovered token account"); return; }
    const mainnetConfirmed = network !== "mainnet" || window.confirm(`Collect tokens from ${collectionSources.length} wallets and close ${selectedCollectionClosures.length} emptied accounts on mainnet?`);
    if (!mainnetConfirmed) return;
    setCollectionBusy(true); setCollectionError(null);
    setCopiedTransactions(null);
    try {
      setCollectionJob(await createTokenCollection({ network, destination: collectionDestination, mint: collectionMint, sources: collectionPreview.sources.filter((source) => source.eligible && collectionSources.includes(source.owner)).map((source) => ({ owner: source.owner, amount: collectionAmounts[source.owner] ?? source.amount })), mainnetConfirmed }));
    } catch (reason) { setCollectionError(reason instanceof Error ? reason.message : "Could not start token collection"); }
    finally { setCollectionBusy(false); }
  }

  async function copyTransactions(kind: "airdrop" | "collection", signatures: string[]) {
    try {
      await navigator.clipboard.writeText(signatures.join("\n"));
      setCopiedTransactions(kind);
    } catch {
      const setErrorForKind = kind === "airdrop" ? setError : setCollectionError;
      setErrorForKind("Could not access the clipboard");
    }
  }

  return (
    <section className="airship-workspace">
      <div className="airship-hero">
        <div>
          <span className="airship-kicker">TOKEN DISTRIBUTION</span>
          <h2>Airdrop tokens at any scale</h2>
          <p>Choose compressed AirShip delivery for scale and lower account costs, or send standard SPL tokens directly to recipients’ associated token accounts.</p>
        </div>
        <div className="airship-route"><small>SELECTED ROUTE</small><strong>{recipientsPerTransaction} recipients / tx</strong><span>{delivery === "airship" ? "ZK compression · DAS + Photon" : "Standard SPL token accounts"}</span></div>
      </div>

      <div className="airdrop-methods" role="radiogroup" aria-label="Airdrop method">
        <button type="button" role="radio" aria-checked={delivery === "airship"} className={delivery === "airship" ? "selected" : ""} onClick={() => { setDelivery("airship"); setJob(null); setError(null); }}>
          <span className="airdrop-method-icon">✦</span>
          <span><small>COMPRESSED</small><strong>AirShip</strong><p>Efficient bulk delivery into compressed token accounts. Best for large recipient lists.</p></span>
          <i aria-hidden="true" />
        </button>
        <button type="button" role="radio" aria-checked={delivery === "standard"} className={delivery === "standard" ? "selected" : ""} onClick={() => { setDelivery("standard"); setJob(null); setError(null); }}>
          <span className="airdrop-method-icon">→</span>
          <span><small>STANDARD SPL</small><strong>Normal airdrop</strong><p>Creates regular associated token accounts and transfers tokens directly to each wallet.</p></span>
          <i aria-hidden="true" />
        </button>
      </div>

      <div className="airship-layout">
        <form className="airship-form" onSubmit={submit}>
          <div className="airship-section-title"><div><small>01 / PAYLOAD</small><h3>Configure distribution</h3></div><span>{network}</span></div>
          {keypairs.length === 0 ? <div className="airship-empty-wallet">Create a managed wallet in Keygen before starting an airdrop.</div> : <>
            <label>Sender and fee payer
              <select value={sender} onChange={(event) => setSender(event.target.value)}>
                {keypairs.map((keypair) => <option key={keypair.address} value={keypair.address}>{keypair.address}</option>)}
              </select>
            </label>
            <label>Token
              <select value={mint} onChange={(event) => setMint(event.target.value)} disabled={loadingTokens || tokens.length === 0}>
                {loadingTokens ? <option>Loading wallet tokens…</option> : tokens.length === 0 ? <option>No fungible tokens found</option> : tokens.map((token) => (
                  <option key={token.mint} value={token.mint} disabled={!token.supported}>
                  {token.symbol} · {formatTokenUnits(token.balanceBaseUnits, token.decimals)} available{token.supported ? "" : " · unsupported extension"}
                  </option>
                ))}
              </select>
            </label>
            <label>Amount per recipient
              <div className="airship-amount"><input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="1" /><span>{selectedToken?.symbol ?? "TOKEN"}</span></div>
            </label>
            <label>Recipient addresses <small>one base58 address per line</small>
              <textarea aria-label="Recipient addresses" value={recipientsText} onChange={(event) => setRecipientsText(event.target.value)} spellCheck={false} rows={11} />
            </label>
          </>}
          {error && <div className="alert error-alert" role="alert"><strong>Action stopped</strong><span>{error}</span></div>}
          <button className="primary airship-submit" disabled={submitting || Boolean(job && job.state !== "confirmed" && job.state !== "failed") || !mint || recipientLines.length === 0}>
            {submitting ? "Starting airdrop…" : `Launch ${delivery === "airship" ? "AirShip" : "standard airdrop"} on ${network}`}
          </button>
        </form>

        <section className="airship-manifest" aria-label="Airdrop manifest">
          <div className="airship-section-title"><div><small>02 / MANIFEST</small><h3>Flight check</h3></div><b>{recipientLines.length.toLocaleString()} destinations</b></div>
          <dl className="airship-stats">
            <div><dt>Recipients</dt><dd>{recipientLines.length.toLocaleString()}</dd></div>
            <div><dt>Transactions</dt><dd>{estimatedTransactions.toLocaleString()}</dd></div>
            <div><dt>Duplicate lines</dt><dd className={duplicateCount ? "bad" : "good"}>{duplicateCount}</dd></div>
            <div><dt>Token standard</dt><dd>{selectedToken?.tokenProgram === "token2022" ? "Token-2022" : selectedToken ? "Classic SPL" : "—"}</dd></div>
          </dl>
          <div className={`airship-compression-note ${delivery === "standard" ? "standard" : ""}`}><span>{delivery === "airship" ? "✦" : "→"}</span><div><strong>{delivery === "airship" ? "Recipients receive compressed tokens" : "Recipients receive standard SPL tokens"}</strong><p>{delivery === "airship" ? "They can hold and transfer them in compatible wallets, or decompress them to standard token accounts when needed." : "An associated token account is created when needed. The sender covers its rent and transaction fees."}</p></div></div>

          {delivery === "airship" && <div className="airship-balance-viewer">
            <div className="airship-balance-heading">
              <div><small>COMPRESSED HOLDINGS</small><strong>Recipient cargo scan</strong></div>
              {balanceReport && <b>{balanceReport.accountCount} account{balanceReport.accountCount === 1 ? "" : "s"}</b>}
            </div>
            <form onSubmit={scanBalances}>
              <label htmlFor="airship-balance-owner">Recipient address</label>
              <div className="airship-balance-controls">
                <input
                  id="airship-balance-owner"
                  value={balanceOwner}
                  onChange={(event) => {
                    setBalanceOwner(event.target.value);
                    setBalanceReport(null);
                    setBalanceError(null);
                    setDecompression(null);
                    setDecompressError(null);
                  }}
                  placeholder="Paste a wallet address"
                  spellCheck={false}
                />
                <button className="secondary" disabled={loadingBalances || !balanceOwner.trim()}>
                  {loadingBalances ? "Scanning…" : "Scan balance"}
                </button>
              </div>
              <div className="airship-balance-shortcuts">
                {sender && balanceOwner !== sender && <button type="button" onClick={() => setBalanceOwner(sender)}>Use managed sender</button>}
                {recipientLines[0] && balanceOwner !== recipientLines[0] && (
                  <button type="button" onClick={() => setBalanceOwner(recipientLines[0] ?? "")}>Use first recipient</button>
                )}
              </div>
            </form>
            {balanceError && <p className="airship-balance-error" role="alert">{balanceError}</p>}
            {balanceReport && balanceReport.balances.length === 0 && (
              <div className="airship-balance-empty"><strong>No compressed tokens found</strong><span>This address has no indexed compressed-token accounts on {network}.</span></div>
            )}
            {balanceReport && balanceReport.balances.length > 0 && (
              <ul className="airship-balance-list">
                {balanceReport.balances.map((balance) => {
                  const knownToken = tokens.find((token) => token.mint === balance.mint);
                  return <li key={balance.mint}>
                    <div><strong>{knownToken?.symbol ?? shortAddress(balance.mint)}</strong><code title={balance.mint}>{balance.mint}</code></div>
                    <div><b>{formatTokenUnits(balance.balanceBaseUnits, balance.decimals)}</b><small>{balance.accountCount} compressed account{balance.accountCount === 1 ? "" : "s"}</small></div>
                  </li>;
                })}
              </ul>
            )}
            {balanceReport && balanceReport.balances.length > 0 && !managedBalanceOwner && (
              <p className="airship-decompress-readonly">Balance viewing is read-only. Decompression requires this address to be available in the managed key vault.</p>
            )}
            {balanceReport && balanceReport.balances.length > 0 && managedBalanceOwner && (
              <form className="airship-decompress" onSubmit={submitDecompression}>
                <div><small>RETURN TO SPL</small><strong>Decompress into this wallet</strong></div>
                <label>Compressed token
                  <select value={decompressMint} onChange={(event) => setDecompressMint(event.target.value)}>
                    {balanceReport.balances.map((balance) => <option key={balance.mint} value={balance.mint}>
                      {tokens.find((token) => token.mint === balance.mint)?.symbol ?? shortAddress(balance.mint)} · {formatTokenUnits(balance.balanceBaseUnits, balance.decimals)} available
                    </option>)}
                  </select>
                </label>
                <label>Amount
                  <div className="airship-decompress-amount">
                    <input inputMode="decimal" value={decompressAmount} onChange={(event) => setDecompressAmount(event.target.value)} />
                    <button type="button" onClick={() => decompressionBalance && setDecompressAmount(formatTokenUnits(decompressionBalance.balanceBaseUnits, decompressionBalance.decimals))}>Max</button>
                  </div>
                </label>
                <button className="primary" disabled={decompressing || !decompressMint}>
                  {decompressing ? "Decompressing…" : "Decompress to token account"}
                </button>
                {decompressError && <p className="airship-balance-error" role="alert">{decompressError}</p>}
                {decompression && <p className="airship-decompress-success">
                  Confirmed into <code>{shortAddress(decompression.destinationTokenAccount)}</code>. <a href={explorerTransaction(decompression.signature, decompression.network)} target="_blank" rel="noreferrer">View transaction ↗</a>
                </p>}
              </form>
            )}
          </div>}

          {job ? <div className={`airship-progress ${job.state}`}>
            <div className="airship-progress-heading"><div><small>FLIGHT {job.id.slice(0, 8).toUpperCase()}</small><strong>{airshipJobLabel(job)}</strong></div><b>{progress}%</b></div>
            <div className="airship-progress-track"><i style={{ width: `${progress}%` }} /></div>
            <div className="airship-progress-counts"><span>{job.sentTransactions} sent</span><span>{job.confirmedTransactions} confirmed</span><span>{job.totalTransactions} total</span></div>
            {job.error && <p className="airship-job-error">{job.error}</p>}
            {job.signatures.length > 0 && <><button className="secondary airship-copy-transactions" type="button" onClick={() => void copyTransactions("airdrop", job.signatures)}>{copiedTransactions === "airdrop" ? "Copied" : "Copy all transactions"}</button><details><summary>{job.signatures.length} transaction signature{job.signatures.length === 1 ? "" : "s"}</summary><ol>{job.signatures.map((signature) => <li key={signature}><a href={explorerTransaction(signature, job.network)} target="_blank" rel="noreferrer">{shortAddress(signature)} ↗</a></li>)}</ol></details></>}
          </div> : <div className="airship-idle"><span>↗</span><strong>Ready for departure</strong><p>{delivery === "airship" ? "AirShip creates a compression pool when needed, then sends groups of 15 recipients per transaction." : "Standard delivery creates recipient token accounts when needed, then sends groups of 4 recipients per transaction."}</p></div>}
        </section>
      </div>

      <section className="token-collection" aria-labelledby="token-collection-title">
        <div className="token-collection-heading"><div><small>ACCOUNT RECOVERY</small><h3 id="token-collection-title">Collect tokens</h3><p>Move one mint from managed wallets into a single wallet. Emptied token accounts close atomically and return their SOL rent to the destination wallet.</p></div>{collectionJob && <b>{collectionJob.state}</b>}</div>
        <form className="token-collection-config" onSubmit={loadCollectionPreview}>
          <label>Destination wallet<select value={collectionDestination} onChange={(event) => { setCollectionDestination(event.target.value); setCollectionPreview(null); }}>{keypairs.map((keypair) => <option key={keypair.address} value={keypair.address}>{keypair.address}</option>)}</select></label>
          <label>Token mint<input value={collectionMint} onChange={(event) => { setCollectionMint(event.target.value); setCollectionPreview(null); }} placeholder="Mint address" spellCheck={false} /></label>
          <p className="token-collection-query-note">The scan queries the token program by mint, then keeps managed canonical accounts—including empty ATAs that can return their rent.</p>
          <div className="token-collection-actions"><button className="primary" disabled={collectionBusy || !collectionDestination || !collectionMint}>{collectionBusy ? "Scanning…" : "Find token accounts"}</button></div>
        </form>
        {collectionError && <div className="alert error-alert" role="alert"><strong>Collection stopped</strong><span>{collectionError}</span></div>}
        {collectionPreview && <div className="token-collection-review">
          <dl><div><dt>Selected</dt><dd>{selectedCollectionSources.length}</dd></div><div><dt>Accounts closing</dt><dd>{selectedCollectionClosures.length}</dd></div><div><dt>Rent reclaimed</dt><dd>{formatSol(selectedCollectionRent)} SOL</dd></div><div><dt>Transactions</dt><dd>{Math.ceil(selectedCollectionSources.length / 10)}</dd></div></dl>
          <div className="token-collection-selection-actions"><button type="button" className="secondary" onClick={() => setCollectionSources(collectionPreview.sources.filter((source) => source.eligible).map((source) => source.owner))}>Select all</button><button type="button" className="secondary" onClick={() => setCollectionSources([])}>Clear</button></div>
          {collectionPreview.sources.length === 0 ? <p className="token-collection-empty">No managed canonical token accounts were found for this mint.</p> : <ul>{collectionPreview.sources.map((source) => <li key={source.tokenAccount} className={source.eligible ? "eligible" : "excluded"}>{source.eligible && <input type="checkbox" aria-label={`Select ${source.owner}`} checked={collectionSources.includes(source.owner)} onChange={(event) => setCollectionSources((current) => event.target.checked ? [...new Set([...current, source.owner])] : current.filter((owner) => owner !== source.owner))} />}<div><strong>{shortAddress(source.owner)}</strong><small>{source.eligible ? source.balanceBaseUnits === "0" ? `Empty ATA · closes and reclaims rent · ${shortAddress(source.tokenAccount)}` : `${source.balance} available${source.willClose ? " · closes account" : ""} · ${shortAddress(source.tokenAccount)}` : source.reason}</small></div>{source.eligible && <input aria-label={`Collection amount for ${source.owner}`} disabled={!collectionSources.includes(source.owner) || source.balanceBaseUnits === "0"} value={collectionAmounts[source.owner] ?? source.amount} onChange={(event) => setCollectionAmounts((current) => ({ ...current, [source.owner]: event.target.value }))} />}</li>)}</ul>}
          <button className="primary" type="button" disabled={collectionBusy || selectedCollectionSources.length === 0} onClick={() => void launchCollection()}>{collectionBusy ? "Starting…" : `Collect ${selectedCollectionSources.length} account${selectedCollectionSources.length === 1 ? "" : "s"} on ${network}`}</button>
        </div>}
        {collectionJob && <div className={`token-collection-progress ${collectionJob.state}`}><strong>{collectionJob.confirmedTransactions} / {collectionJob.totalTransactions} transactions confirmed</strong><span>{collectionJob.closedAccounts} accounts closed · {formatSol(collectionJob.reclaimedRentLamports)} SOL reclaimed</span>{collectionJob.error && <p>{collectionJob.error}</p>}{collectionJob.signatures.length > 0 && <button className="secondary airship-copy-transactions" type="button" onClick={() => void copyTransactions("collection", collectionJob.signatures)}>{copiedTransactions === "collection" ? "Copied" : "Copy all transactions"}</button>}{collectionJob.signatures.map((signature) => <a key={signature} href={explorerTransaction(signature, collectionJob.network)} target="_blank" rel="noreferrer">{shortAddress(signature)} ↗</a>)}</div>}
      </section>
    </section>
  );
}
