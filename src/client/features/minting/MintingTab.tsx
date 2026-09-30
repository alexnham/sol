import { useEffect, useMemo, useState } from "react";
import type { Network, TransactionVersion } from "../../../shared/contracts";
import { formatBaseUnits } from "../../../shared/token-mints";
import { createTokenMint, fetchTokenMints, manageTokenMint, type VaultKeyMetadata } from "../../api";
import type { ManageTokenMintRequest, TrackedTokenMint } from "../../../shared/token-mints";

const SAME_AUTHORITY = "__same__";
const NO_AUTHORITY = "__none__";

export function MintingTab({
  network,
  transactionVersion,
  keypairs,
}: {
  network: Network;
  transactionVersion: TransactionVersion;
  keypairs: VaultKeyMetadata[];
}) {
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [decimals, setDecimals] = useState(9);
  const [initialSupply, setInitialSupply] = useState("0");
  const [mintAuthority, setMintAuthority] = useState("");
  const [freezeAuthority, setFreezeAuthority] = useState(SAME_AUTHORITY);
  const [revokeMintAuthority, setRevokeMintAuthority] = useState(false);
  const [revokeFreezeAuthority, setRevokeFreezeAuthority] = useState(false);
  const [tokenProgram, setTokenProgram] = useState<"classic" | "token2022">("token2022");
  const [metadataUri, setMetadataUri] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [tokens, setTokens] = useState<TrackedTokenMint[]>([]);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<TrackedTokenMint | null>(null);

  useEffect(() => {
    if (!mintAuthority && keypairs[0]) setMintAuthority(keypairs[0].address);
    if (mintAuthority && !keypairs.some((key) => key.address === mintAuthority)) {
      setMintAuthority(keypairs[0]?.address ?? "");
    }
  }, [keypairs, mintAuthority]);

  useEffect(() => {
    void refresh();
  }, [network]);

  const resolvedFreezeAuthority = useMemo(() => {
    if (freezeAuthority === SAME_AUTHORITY) return mintAuthority;
    if (freezeAuthority === NO_AUTHORITY) return null;
    return freezeAuthority;
  }, [freezeAuthority, mintAuthority]);

  async function refresh() {
    setRefreshing(true);
    try {
      setTokens(await fetchTokenMints(network));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not refresh token mints");
    } finally {
      setRefreshing(false);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!mintAuthority) {
      setError("Generate or import a managed wallet before creating a mint");
      return;
    }
    const mainnetConfirmed = network !== "mainnet" || window.confirm(
      `Create ${symbol.trim() || "this token"} on mainnet? This spends real SOL for rent and fees and cannot be undone.`,
    );
    if (!mainnetConfirmed) return;
    setBusy(true);
    setError(null);
    setCreated(null);
    try {
      const result = await createTokenMint({
        network,
        transactionVersion,
        name,
        symbol,
        decimals,
        initialSupply,
        mintAuthority,
        freezeAuthority: resolvedFreezeAuthority,
        revokeMintAuthority,
        revokeFreezeAuthority,
        mainnetConfirmed,
        tokenProgram,
        ...(tokenProgram === "token2022" ? { metadataUri, imageUrl } : {}),
      });
      setCreated(result);
      setTokens((current) => [result, ...current.filter((token) => token.mint !== result.mint)]);
      setName("");
      setSymbol("");
      setInitialSupply("0");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Token mint creation failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mint-workspace">
      <div className="mint-hero">
        <div>
          <span className="vault-kicker">Classic SPL Token Program</span>
          <h2>Create and track token mints</h2>
          <p>Name and symbol are local workbench labels. They are not embedded as wallet-visible on-chain metadata.</p>
        </div>
        <span className="mint-format">v{transactionVersion} · {transactionVersion === 0 ? "1,232" : "4,096"} byte limit</span>
      </div>

      <div className="mint-layout">
        <form className="mint-form" onSubmit={submit}>
          <div className="mint-section-heading">
            <div><small>New mint</small><h3>Token configuration</h3></div>
            <span>{network}</span>
          </div>
          <div className="mint-fields two-column">
            <label>Token program
              <select aria-label="Token program" value={tokenProgram} onChange={(event) => setTokenProgram(event.target.value as "classic" | "token2022")}>
                <option value="token2022">Token-2022 with metadata</option>
                <option value="classic">Classic SPL Token</option>
              </select>
            </label>
            <label>Local name<input aria-label="Local name" required minLength={1} maxLength={64} value={name} onChange={(event) => setName(event.target.value)} placeholder="Workbench Token" /></label>
            <label>Local symbol<input aria-label="Local symbol" required minLength={1} maxLength={12} value={symbol} onChange={(event) => setSymbol(event.target.value)} placeholder="WRK" /></label>
            <label>Decimals<input aria-label="Decimals" required type="number" min={0} max={9} step={1} value={decimals} onChange={(event) => setDecimals(Number(event.target.value))} /></label>
            <label>Initial supply<input aria-label="Initial supply" required inputMode="decimal" value={initialSupply} onChange={(event) => setInitialSupply(event.target.value)} placeholder="0" /></label>
          </div>
          {tokenProgram === "token2022" && (
            <div className="mint-fields metadata-fields">
              <label>Metadata JSON URI<input aria-label="Metadata JSON URI" maxLength={500} value={metadataUri} onChange={(event) => setMetadataUri(event.target.value)} placeholder="https://example.com/token.json or ipfs://…" /></label>
              <label>Image URL<input aria-label="Image URL" maxLength={500} value={imageUrl} onChange={(event) => setImageUrl(event.target.value)} placeholder="https://example.com/token.png or ipfs://…" /></label>
              <small>The URI should resolve to standard token metadata JSON. The image URL is also stored in the mint’s on-chain metadata fields.</small>
            </div>
          )}

          <div className="mint-divider" />
          <div className="mint-section-heading"><div><small>Custody</small><h3>Managed authorities</h3></div></div>
          {keypairs.length === 0 ? (
            <div className="mint-empty-wallets">No managed wallets are available. Create one in Keygen first.</div>
          ) : (
            <div className="mint-fields">
              <label>Mint authority and fee payer
                <select aria-label="Mint authority and fee payer" value={mintAuthority} onChange={(event) => setMintAuthority(event.target.value)}>
                  {keypairs.map((key) => <option key={key.address} value={key.address}>{key.address}</option>)}
                </select>
              </label>
              <label>Freeze authority
                <select aria-label="Freeze authority" value={freezeAuthority} onChange={(event) => {
                  setFreezeAuthority(event.target.value);
                  if (event.target.value === NO_AUTHORITY) setRevokeFreezeAuthority(false);
                }}>
                  <option value={SAME_AUTHORITY}>Same as mint authority</option>
                  <option value={NO_AUTHORITY}>None</option>
                  {keypairs.filter((key) => key.address !== mintAuthority).map((key) => <option key={key.address} value={key.address}>{key.address}</option>)}
                </select>
              </label>
            </div>
          )}
          <div className="authority-options">
            <label><input type="checkbox" checked={revokeMintAuthority} onChange={(event) => setRevokeMintAuthority(event.target.checked)} />Revoke mint authority after initial mint</label>
            <label><input type="checkbox" disabled={resolvedFreezeAuthority === null} checked={revokeFreezeAuthority} onChange={(event) => setRevokeFreezeAuthority(event.target.checked)} />Revoke freeze authority after creation</label>
          </div>
          <p className="authority-warning">Authority revocation is permanent. Initial supply, ATA creation, and revocation are submitted atomically.</p>
          {error && <div className="alert error-alert" role="alert"><strong>Action stopped</strong><span>{error}</span></div>}
          {created && <div className="alert success-alert" role="status"><strong>Mint confirmed</strong><span>{shortAddress(created.mint)}</span><a href={explorerAddress(created.mint, network)} target="_blank" rel="noreferrer">Open in Orb</a></div>}
          <button className="primary mint-submit" type="submit" disabled={busy || keypairs.length === 0}>{busy ? "Creating and confirming…" : `Create SPL token on ${network}`}</button>
        </form>

        <section className="mint-library" aria-label="Created token mints">
          <div className="mint-library-heading">
            <div><small>Current network</small><h3>Created tokens</h3></div>
            <button className="secondary" type="button" onClick={() => void refresh()} disabled={refreshing}>{refreshing ? "Refreshing…" : "Refresh chain state"}</button>
          </div>
          {tokens.length === 0 ? (
            <div className="mint-library-empty"><span>◎</span><strong>No {network} mints yet</strong><p>Tokens created through this workbench will appear here.</p></div>
          ) : (
            <ul className="mint-cards">
              {tokens.map((token) => <MintCard key={token.mint} token={token} keypairs={keypairs} transactionVersion={transactionVersion} onUpdated={(updated) => setTokens((current) => current.map((item) => item.mint === updated.mint ? updated : item))} />)}
            </ul>
          )}
        </section>
      </div>
    </section>
  );
}

function MintCard({ token, keypairs, transactionVersion, onUpdated }: { token: TrackedTokenMint; keypairs: VaultKeyMetadata[]; transactionVersion: TransactionVersion; onUpdated(token: TrackedTokenMint): void }) {
  const [managing, setManaging] = useState(false);
  const [copied, setCopied] = useState(false);
  const supply = token.supplyBaseUnits ?? token.initialSupplyBaseUnits;
  return (
    <li>
      <div className="mint-card-title">{token.imageUrl && httpImageUrl(token.imageUrl) ? <img src={httpImageUrl(token.imageUrl)} alt="" /> : <span>{token.symbol}</span>}<div><strong>{token.name}</strong><small>{token.tokenProgram === "token2022" ? "Token-2022" : "Classic SPL"} · {token.liveStatus === "available" ? "Live state" : "Stored state · RPC unavailable"}</small></div><b>v{token.transactionVersion}</b></div>
      <div className="mint-supply"><small>Supply</small><strong>{formatBaseUnits(supply, token.decimals)}</strong><code>{supply} raw · {token.decimals} decimals</code></div>
      <dl>
        <div className="mint-address-row"><dt>Token address</dt><dd><code>{token.mint}</code><span><button type="button" onClick={() => { void navigator.clipboard?.writeText(token.mint); setCopied(true); }}>{copied ? "Copied" : "Copy"}</button><a href={explorerAddress(token.mint, token.network)} target="_blank" rel="noreferrer">Explorer ↗</a></span></dd></div>
        {token.associatedTokenAccount && <div><dt>Authority ATA</dt><dd><a href={explorerAddress(token.associatedTokenAccount, token.network)} target="_blank" rel="noreferrer">{shortAddress(token.associatedTokenAccount)}</a></dd></div>}
        <div><dt>Mint authority</dt><dd>{token.liveStatus === "available" ? token.mintAuthority ? shortAddress(token.mintAuthority) : "Revoked" : token.mintAuthorityRevoked ? "Revoked at creation" : "Unavailable"}</dd></div>
        <div><dt>Freeze authority</dt><dd>{token.liveStatus === "available" ? token.freezeAuthority ? shortAddress(token.freezeAuthority) : "None / revoked" : token.freezeAuthorityRevoked ? "Revoked at creation" : "Unavailable"}</dd></div>
      </dl>
      <div className="mint-card-footer"><time>{new Date(token.createdAt).toLocaleString()}</time><a href={explorerTransaction(token.creationSignature, token.network)} target="_blank" rel="noreferrer">Creation transaction ↗</a></div>
      <button className="secondary mint-manage-toggle" type="button" onClick={() => setManaging((value) => !value)}>{managing ? "Close management" : "Manage token"}</button>
      {managing && <TokenManager token={token} keypairs={keypairs} transactionVersion={transactionVersion} onUpdated={onUpdated} />}
    </li>
  );
}

type ManagementAction = ManageTokenMintRequest["action"];

function TokenManager({ token, keypairs, transactionVersion, onUpdated }: { token: TrackedTokenMint; keypairs: VaultKeyMetadata[]; transactionVersion: TransactionVersion; onUpdated(token: TrackedTokenMint): void }) {
  const [action, setAction] = useState<ManagementAction>("mint");
  const [amount, setAmount] = useState("0");
  const [owner, setOwner] = useState(keypairs[0]?.address ?? "");
  const [recipient, setRecipient] = useState("");
  const [newAuthority, setNewAuthority] = useState("");
  const [name, setName] = useState(token.name);
  const [symbol, setSymbol] = useState(token.symbol);
  const [metadataUri, setMetadataUri] = useState(token.metadataUri ?? "");
  const [imageUrl, setImageUrl] = useState(token.imageUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const authorityAction = action.startsWith("set-");
  const supplyAction = action === "mint" || action === "transfer" || action === "burn";
  const ownerAction = action === "transfer" || action === "burn" || action === "freeze" || action === "thaw";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const mainnetConfirmed = token.network !== "mainnet" || window.confirm(`Apply ${action} to ${token.symbol} on mainnet? This on-chain action may be irreversible.`);
    if (!mainnetConfirmed) return;
    const base = { network: token.network, transactionVersion, mint: token.mint, mainnetConfirmed };
    let request: ManageTokenMintRequest;
    if (action === "update-local") request = { ...base, action, name, symbol, metadataUri, imageUrl };
    else if (action === "update-metadata") request = { ...base, action, name, symbol, metadataUri, imageUrl };
    else if (action === "mint") request = { ...base, action, amount, recipient };
    else if (action === "transfer") request = { ...base, action, amount, owner, recipient };
    else if (action === "burn") request = { ...base, action, amount, owner };
    else if (action === "freeze" || action === "thaw") request = { ...base, action, owner };
    else request = { ...base, action, newAuthority: newAuthority || null };
    setBusy(true); setError(null); setSignature(null);
    try {
      const result = await manageTokenMint(request);
      onUpdated(result.token);
      setSignature(result.signature ?? "local");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Token management failed");
    } finally { setBusy(false); }
  }

  return (
    <form className="token-manager" onSubmit={submit}>
      <label>Action<select aria-label={`Manage ${token.symbol}`} value={action} onChange={(event) => setAction(event.target.value as ManagementAction)}>
        {token.tokenProgram === "token2022" ? <option value="update-metadata">Update on-chain metadata</option> : <option value="update-local">Edit local labels</option>}
        <option value="mint">Mint additional supply</option>
        <option value="transfer">Transfer tokens</option>
        <option value="burn">Burn tokens</option>
        <option value="set-mint-authority">Change/revoke mint authority</option>
        <option value="set-freeze-authority">Change/revoke freeze authority</option>
        {token.tokenProgram === "token2022" && <option value="set-metadata-authority">Change/revoke metadata authority</option>}
        <option value="freeze">Freeze owner ATA</option>
        <option value="thaw">Thaw owner ATA</option>
      </select></label>
      {(action === "update-local" || action === "update-metadata") && <div className="manager-grid"><label>Name<input value={name} onChange={(event) => setName(event.target.value)} /></label><label>Symbol<input value={symbol} onChange={(event) => setSymbol(event.target.value)} /></label><label>Metadata URI<input value={metadataUri} onChange={(event) => setMetadataUri(event.target.value)} /></label><label>Image URL<input value={imageUrl} onChange={(event) => setImageUrl(event.target.value)} /></label></div>}
      {supplyAction && <label>Amount<input aria-label="Token amount" value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" /></label>}
      {ownerAction && <label>Managed token owner<select value={owner} onChange={(event) => setOwner(event.target.value)}>{keypairs.map((key) => <option key={key.address} value={key.address}>{key.address}</option>)}</select></label>}
      {(action === "mint" || action === "transfer") && <label>Recipient wallet<input aria-label="Recipient wallet" value={recipient} onChange={(event) => setRecipient(event.target.value)} /></label>}
      {authorityAction && <label>New managed authority<select value={newAuthority} onChange={(event) => setNewAuthority(event.target.value)}><option value="">Revoke permanently</option>{keypairs.map((key) => <option key={key.address} value={key.address}>{key.address}</option>)}</select></label>}
      {authorityAction && !newAuthority && <p className="manager-danger">Revocation is permanent and cannot be undone.</p>}
      {error && <div className="manager-message error-alert">{error}</div>}
      {signature && <div className="manager-message success-alert">{signature === "local" ? "Local labels updated" : "Transaction confirmed"}</div>}
      <button className="primary" disabled={busy} type="submit">{busy ? "Applying…" : actionLabel(action)}</button>
    </form>
  );
}

function actionLabel(action: ManagementAction): string {
  return ({ "update-local": "Save local labels", "update-metadata": "Update metadata", mint: "Mint tokens", transfer: "Transfer tokens", burn: "Burn tokens", "set-mint-authority": "Update mint authority", "set-freeze-authority": "Update freeze authority", "set-metadata-authority": "Update metadata authority", freeze: "Freeze account", thaw: "Thaw account" })[action];
}

function httpImageUrl(value: string): string | undefined {
  return /^https?:\/\//.test(value) ? value : undefined;
}

function shortAddress(value: string): string {
  return `${value.slice(0, 5)}…${value.slice(-5)}`;
}

function explorerAddress(value: string, network: Network): string {
  return `https://orb.helius.dev/address/${value}?cluster=${network === "mainnet" ? "mainnet-beta" : "devnet"}`;
}

function explorerTransaction(value: string, network: Network): string {
  return `https://orb.helius.dev/tx/${value}?cluster=${network === "mainnet" ? "mainnet-beta" : "devnet"}`;
}
