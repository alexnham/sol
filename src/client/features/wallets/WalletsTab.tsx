import type { Network } from "../../../shared/contracts";
import type { WalletPortfolioReport } from "../../../shared/wallet-portfolio";

export interface WalletsTabProps {
  network: Network;
  managedWalletCount: number;
  report: WalletPortfolioReport | null;
  stale: boolean;
  loading: boolean;
  error: string | null;
  onScan: () => void;
}

export function WalletsTab({
  network,
  managedWalletCount,
  report,
  stale,
  loading,
  error,
  onScan,
}: WalletsTabProps) {
  const emptyVault = managedWalletCount === 0;
  return (
    <section className="portfolio-workspace" aria-labelledby="portfolio-title">
      <header className="portfolio-hero">
        <div>
          <span className="portfolio-kicker">Managed balance ledger</span>
          <h2 id="portfolio-title">Wallet portfolio</h2>
          <p>Sum native SOL and fungible token balances across every locally managed wallet.</p>
        </div>
        <div className="portfolio-scan-control">
          <span><i className={`network-dot ${network}`} />{network}</span>
          <button className="primary" type="button" disabled={loading || emptyVault} onClick={onScan}>
            {loading ? "Scanning wallets…" : report ? "Refresh balances" : "Scan all wallets"}
          </button>
        </div>
      </header>

      {report && (
        <div className={`portfolio-coverage ${stale ? "stale" : ""}`} role="status">
          <div>
            <strong>{report.scannedWalletCount.toLocaleString()} / {report.managedWalletCount.toLocaleString()}</strong>
            <span>wallets scanned</span>
          </div>
          <div>
            <strong>{report.assets.length.toLocaleString()}</strong>
            <span>nonzero assets</span>
          </div>
          <div>
            <strong>{formatScanDate(report.scannedAt)}</strong>
            <span>last scan</span>
          </div>
          <div className="portfolio-freshness">
            <strong>{stale ? "Wallet list changed" : "Current wallet set"}</strong>
            <span>{stale ? "Refresh to include the latest managed wallets" : `Cached in memory for ${report.network}`}</span>
          </div>
        </div>
      )}

      {error && <div className="alert error-alert portfolio-alert" role="alert"><strong>Scan stopped</strong><span>{error}</span></div>}
      {report && report.failedWallets.length > 0 && (
        <details className="portfolio-failures">
          <summary>{report.failedWallets.length.toLocaleString()} wallet{report.failedWallets.length === 1 ? "" : "s"} could not be scanned</summary>
          <ul>{report.failedWallets.map((failure) => <li key={failure.address}><code>{failure.address}</code><span>{failure.error}</span></li>)}</ul>
        </details>
      )}

      {emptyVault ? (
        <div className="portfolio-empty">
          <span aria-hidden="true">◇</span>
          <h3>No managed wallets</h3>
          <p>Create or import keys in Keygen before scanning balances.</p>
        </div>
      ) : !report ? (
        <div className="portfolio-empty portfolio-unscanned">
          <span aria-hidden="true">◎</span>
          <h3>{managedWalletCount.toLocaleString()} wallet{managedWalletCount === 1 ? " is" : "s are"} ready to scan</h3>
          <p>The scan runs only when requested and stays cached in memory while this app is open.</p>
        </div>
      ) : report.assets.length === 0 ? (
        <div className="portfolio-empty">
          <span aria-hidden="true">0</span>
          <h3>No balances found</h3>
          <p>The successfully scanned wallets hold no native SOL or standard fungible tokens on {report.network}.</p>
        </div>
      ) : (
        <ol className="portfolio-assets" aria-label="Aggregated wallet assets">
          {report.assets.map((asset, index) => (
            <li key={asset.kind === "native" ? "native-sol" : asset.mint}>
              <details>
                <summary>
                  <span className={`portfolio-asset-mark mark-${index % 4}`} aria-hidden="true">{asset.symbol.slice(0, 3)}</span>
                  <span className="portfolio-asset-name">
                    <strong>{asset.name}</strong>
                    <small>{asset.kind === "native" ? "Native SOL" : asset.mint}</small>
                  </span>
                  <span className="portfolio-asset-program">{asset.kind === "native" ? "system" : asset.tokenProgram === "token2022" ? "Token-2022" : asset.tokenProgram === "classic" ? "SPL Token" : "fungible"}</span>
                  <span className="portfolio-asset-total">
                    <strong>{formatPortfolioAmount(asset.totalBaseUnits, asset.decimals)}</strong>
                    <small>{asset.symbol} across {asset.wallets.length.toLocaleString()} wallet{asset.wallets.length === 1 ? "" : "s"}</small>
                  </span>
                  <span className="portfolio-disclosure" aria-hidden="true">⌄</span>
                </summary>
                <ol className="portfolio-contributors">
                  {asset.wallets.map((wallet) => (
                    <li key={wallet.address}>
                      <code title={wallet.address}>{wallet.address}</code>
                      <strong>{formatPortfolioAmount(wallet.balanceBaseUnits, asset.decimals)} {asset.symbol}</strong>
                    </li>
                  ))}
                </ol>
              </details>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function formatPortfolioAmount(baseUnits: string, decimals: number): string {
  const negative = baseUnits.startsWith("-");
  const digits = negative ? baseUnits.slice(1) : baseUnits;
  if (decimals === 0) return `${negative ? "-" : ""}${groupDigits(digits)}`;
  const padded = digits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${groupDigits(whole)}${fraction ? `.${fraction}` : ""}`;
}

function groupDigits(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatScanDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}
