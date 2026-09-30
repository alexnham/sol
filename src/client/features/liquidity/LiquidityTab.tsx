import { useEffect, useMemo, useState } from "react";
import type { Network, TransactionVersion } from "../../../shared/contracts";
import type { TrackedLiquidityPool } from "../../../shared/liquidity";
import { formatBaseUnits, type TrackedTokenMint } from "../../../shared/token-mints";
import { createLiquidityPool, fetchLiquidityPools, fetchTokenMints, manageLiquidityPool, type VaultKeyMetadata } from "../../api";

export function LiquidityTab({ network, transactionVersion, keypairs }: {
  network: Network;
  transactionVersion: TransactionVersion;
  keypairs: VaultKeyMetadata[];
}) {
  const [tokens, setTokens] = useState<TrackedTokenMint[]>([]);
  const [pools, setPools] = useState<TrackedLiquidityPool[]>([]);
  const [mintX, setMintX] = useState("");
  const [mintY, setMintY] = useState("");
  const [provider, setProvider] = useState("");
  const [amountX, setAmountX] = useState("");
  const [amountY, setAmountY] = useState("");
  const [feeBps, setFeeBps] = useState("30");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);

  async function refresh() {
    try {
      const [nextTokens, nextPools] = await Promise.all([fetchTokenMints(network), fetchLiquidityPools(network)]);
      setTokens(nextTokens.filter((token) => token.liveStatus === "available"));
      setPools(nextPools);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load liquidity data");
    }
  }

  useEffect(() => { refresh().catch(() => undefined); }, [network]);
  useEffect(() => {
    if (!provider && keypairs[0]) setProvider(keypairs[0].address);
  }, [keypairs, provider]);
  useEffect(() => {
    if (!mintX && tokens[0]) setMintX(tokens[0].mint);
    if ((!mintY || mintY === mintX) && tokens.find((token) => token.mint !== mintX)) setMintY(tokens.find((token) => token.mint !== mintX)!.mint);
  }, [tokens, mintX, mintY]);

  async function createPool(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError(null); setSignature(null);
    try {
      const result = await createLiquidityPool({ network, transactionVersion, provider, mintX, mintY, amountX, amountY, feeBps: Number(feeBps) });
      setPools((current) => [result.pool, ...current]);
      setSignature(result.signature);
      setAmountX(""); setAmountY("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Pool creation failed");
    } finally { setBusy(false); }
  }

  const tokenX = tokens.find((token) => token.mint === mintX);
  const tokenY = tokens.find((token) => token.mint === mintY);
  const enabled = network === "devnet" && tokens.length >= 2 && keypairs.length > 0;

  return <section className="liquidity-workspace">
    <div className="liquidity-hero">
      <div><span className="liquidity-kicker">CUSTOM CONSTANT PRODUCT AMM</span><h2>Liquidity desk</h2><p>Create a two-token market, seed its first reserves, then add, remove, or swap against the pool. Every trade enforces a minimum output on-chain.</p></div>
      <div className="liquidity-formula"><small>PRICING CURVE</small><strong>x × y = k</strong><span>Program-owned vaults · {feeBps || "0"} bps fee</span></div>
    </div>
    {network !== "devnet" && <div className="liquidity-warning"><strong>Mainnet locked</strong><span>Deploy and audit the AMM program before enabling real-value pools.</span></div>}
    {error && <div className="banner error">{error}</div>}
    {signature && <div className="banner success">Confirmed · <a href={`https://explorer.solana.com/tx/${signature}?cluster=devnet`} target="_blank" rel="noreferrer">view transaction</a></div>}
    <div className="liquidity-layout">
      <form className="liquidity-create" onSubmit={createPool}>
        <div className="liquidity-section-title"><div><small>01 / INITIALIZE</small><h3>Open a market</h3></div><span>v{transactionVersion}</span></div>
        <div className="mint-fields">
          <label>Token X<select value={mintX} onChange={(event) => setMintX(event.target.value)} disabled={!enabled}>{tokens.map(tokenOption)}</select></label>
          <label>Token Y<select value={mintY} onChange={(event) => setMintY(event.target.value)} disabled={!enabled}>{tokens.filter((token) => token.mint !== mintX).map(tokenOption)}</select></label>
          <div className="liquidity-seed-grid">
            <label>{tokenX?.symbol ?? "Token X"} deposit<input value={amountX} onChange={(event) => setAmountX(event.target.value)} inputMode="decimal" placeholder="1000" required /></label>
            <label>{tokenY?.symbol ?? "Token Y"} deposit<input value={amountY} onChange={(event) => setAmountY(event.target.value)} inputMode="decimal" placeholder="10" required /></label>
          </div>
          <label>Swap fee · basis points<input value={feeBps} onChange={(event) => setFeeBps(event.target.value)} type="number" min="0" max="1000" required /></label>
          <label>Managed provider<select value={provider} onChange={(event) => setProvider(event.target.value)} disabled={!enabled}>{keypairs.map((key) => <option key={key.address} value={key.address}>{key.address}</option>)}</select></label>
        </div>
        <div className="liquidity-note">The first deposit fixes the opening price. Both tokens must already be in this wallet’s associated token accounts.</div>
        <button className="primary liquidity-submit" type="submit" disabled={!enabled || busy || !mintX || !mintY || mintX === mintY}>{busy ? "Building and simulating…" : "Create pool + seed reserves"}</button>
        {!enabled && network === "devnet" && <p className="liquidity-help">Create at least two tracked tokens and one managed wallet first.</p>}
      </form>
      <div className="liquidity-book">
        <div className="liquidity-book-heading"><div><small>02 / LIVE RESERVES</small><h3>Pool book</h3></div><button className="secondary" type="button" onClick={() => refresh()} disabled={busy}>Refresh</button></div>
        {pools.length === 0 ? <div className="liquidity-empty"><span>∅</span><strong>No tracked pools</strong><p>Your initialized markets will appear here.</p></div> : <div className="pool-list">{pools.map((pool) => <PoolCard key={pool.pool} pool={pool} keypairs={keypairs} transactionVersion={transactionVersion} onResult={(result) => { setPools((current) => current.map((item) => item.pool === result.pool.pool ? result.pool : item)); setSignature(result.signature); }} />)}</div>}
      </div>
    </div>
  </section>;
}

function PoolCard({ pool, keypairs, transactionVersion, onResult }: {
  pool: TrackedLiquidityPool;
  keypairs: VaultKeyMetadata[];
  transactionVersion: TransactionVersion;
  onResult(result: Awaited<ReturnType<typeof manageLiquidityPool>>): void;
}) {
  const [action, setAction] = useState<"swap" | "add" | "remove">("swap");
  const [provider, setProvider] = useState(pool.initializer);
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  const [inputMint, setInputMint] = useState(pool.mintA);
  const [slippage, setSlippage] = useState("50");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reserveA = pool.reserveA ? Number(formatBaseUnits(pool.reserveA, pool.tokenADecimals)) : 0;
  const reserveB = pool.reserveB ? Number(formatBaseUnits(pool.reserveB, pool.tokenBDecimals)) : 0;
  const split = reserveA + reserveB > 0 ? Math.max(8, Math.min(92, reserveA / (reserveA + reserveB) * 100)) : 50;
  const price = reserveA > 0 ? reserveB / reserveA : 0;

  async function execute(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      const common = { network: pool.network, transactionVersion, pool: pool.pool, provider, slippageBps: Number(slippage) };
      const result = action === "add"
        ? await manageLiquidityPool({ ...common, action, amountA: first, amountB: second })
        : action === "remove"
          ? await manageLiquidityPool({ ...common, action, lpAmount: first })
          : await manageLiquidityPool({ ...common, action, inputMint, amountIn: first });
      setFirst(""); setSecond(""); onResult(result);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Liquidity action failed"); }
    finally { setBusy(false); }
  }

  return <article className="pool-card">
    <div className="pool-title"><div className="pool-pair"><span>{pool.tokenASymbol}</span><i>⇄</i><span>{pool.tokenBSymbol}</span></div><div><strong>{pool.tokenASymbol} / {pool.tokenBSymbol}</strong><small>{pool.feeBps / 100}% fee · {pool.liveStatus === "available" ? "live" : "unavailable"}</small></div><a href={`https://explorer.solana.com/address/${pool.pool}?cluster=devnet`} target="_blank" rel="noreferrer">Pool ↗</a></div>
    <div className="reserve-strip" aria-label={`${pool.tokenASymbol} and ${pool.tokenBSymbol} reserve balance`}><span style={{ width: `${split}%` }} /><i /></div>
    <div className="reserve-values"><div><small>{pool.tokenASymbol} RESERVE</small><strong>{pool.reserveA ? formatBaseUnits(pool.reserveA, pool.tokenADecimals) : "—"}</strong></div><div><small>{pool.tokenBSymbol} RESERVE</small><strong>{pool.reserveB ? formatBaseUnits(pool.reserveB, pool.tokenBDecimals) : "—"}</strong></div></div>
    <div className="pool-metrics"><span>Price <b>{Number.isFinite(price) ? price.toLocaleString(undefined, { maximumSignificantDigits: 6 }) : "—"} {pool.tokenBSymbol}/{pool.tokenASymbol}</b></span><span>LP supply <b>{pool.lpSupply ? formatBaseUnits(pool.lpSupply, 9) : "—"}</b></span></div>
    <form className="pool-action" onSubmit={execute}>
      <div className="pool-action-tabs">{(["swap", "add", "remove"] as const).map((value) => <button type="button" className={action === value ? "active" : ""} key={value} onClick={() => { setAction(value); setFirst(""); setSecond(""); }}>{value}</button>)}</div>
      <div className="pool-action-fields">
        {action === "swap" && <select value={inputMint} onChange={(event) => setInputMint(event.target.value)}><option value={pool.mintA}>Spend {pool.tokenASymbol}</option><option value={pool.mintB}>Spend {pool.tokenBSymbol}</option></select>}
        <input value={first} onChange={(event) => setFirst(event.target.value)} placeholder={action === "remove" ? "LP tokens" : action === "swap" ? "Amount in" : `${pool.tokenASymbol} amount`} inputMode="decimal" required />
        {action === "add" && <input value={second} onChange={(event) => setSecond(event.target.value)} placeholder={`${pool.tokenBSymbol} amount`} inputMode="decimal" required />}
        <select value={provider} onChange={(event) => setProvider(event.target.value)}>{keypairs.map((key) => <option value={key.address} key={key.address}>{short(key.address)}</option>)}</select>
        <label>Slippage<input value={slippage} onChange={(event) => setSlippage(event.target.value)} type="number" min="0" max="5000" /><span>bps</span></label>
        <button className="primary" disabled={busy || pool.liveStatus !== "available"}>{busy ? "Simulating…" : action === "swap" ? "Swap" : action === "add" ? "Add liquidity" : "Remove liquidity"}</button>
      </div>
      {error && <p className="pool-error">{error}</p>}
    </form>
  </article>;
}

function tokenOption(token: TrackedTokenMint) { return <option key={token.mint} value={token.mint}>{token.symbol} · {short(token.mint)} · {token.tokenProgram === "token2022" ? "2022" : "SPL"}</option>; }
function short(value: string) { return `${value.slice(0, 5)}…${value.slice(-5)}`; }
