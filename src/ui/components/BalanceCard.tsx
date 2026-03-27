import { useWalletStore } from '../../store/wallet';
import { formatXmr } from '../../backend/lws';

interface BalanceCardProps {
  onRefresh?: () => void;
}

export function BalanceCard({ onRefresh }: BalanceCardProps) {
  const { xmrInfo, usdcBalance, isSyncing, lastSyncAt, hedgeStatus, lighterMarket } =
    useWalletStore();

  // Total = everything we own: spendable + locked + pending (unconfirmed)
  const totalBalance = xmrInfo
    ? xmrInfo.spendableBalance + xmrInfo.lockedFunds + xmrInfo.pendingBalance
    : null;

  const xmrBalanceStr = totalBalance !== null ? formatXmr(totalBalance) : '—';
  const xmrNumeric = totalBalance !== null ? Number(formatXmr(totalBalance)) : null;

  const xmrUsdValue = xmrNumeric !== null && lighterMarket
    ? xmrNumeric * lighterMarket.markPrice
    : null;

  const lighterUsdc = hedgeStatus?.lighterUsdc ?? 0;
  const isHedged = hedgeStatus?.isHedged ?? false;
  // Net equity = deposited collateral + unrealized PnL from the short.
  // This decreases as XMR rises (short loses), keeping totalUsdValue flat.
  const lighterNetEquity = lighterUsdc + (hedgeStatus?.position?.unrealizedPnl ?? 0);

  // When hedged, show combined total
  const totalUsdValue = isHedged && xmrUsdValue !== null
    ? xmrUsdValue + lighterNetEquity
    : xmrUsdValue;

  const hedgeCurrency = hedgeStatus?.hedgeCurrency ?? 'USD';
  const isNonUsdHedge = hedgeCurrency !== 'USD';
  const currencyMarkPrice = hedgeStatus?.eurPosition?.markPrice ?? 0;
  const totalCurrencyValue = totalUsdValue !== null && currencyMarkPrice > 0
    ? totalUsdValue / currencyMarkPrice
    : null;

  const hasLocked  = xmrInfo && xmrInfo.lockedFunds > 0n;
  const hasPending = xmrInfo && xmrInfo.pendingBalance > 0n;
  const allSpendable = xmrInfo &&
    xmrInfo.lockedFunds === 0n && xmrInfo.pendingBalance === 0n;

  const syncAge = lastSyncAt
    ? Math.floor((Date.now() - lastSyncAt) / 60_000)
    : null;

  return (
    <div className="balance-card">
      <div className="balance-card__header">
        <span className="balance-card__label">
          {isHedged
            ? `Total Value (${hedgeCurrency})`
            : 'XMR Balance'}
        </span>
        <button
          className="balance-card__refresh"
          onClick={onRefresh}
          disabled={isSyncing}
          aria-label="Refresh balance"
        >
          {isSyncing ? '⟳' : '↻'}
        </button>
      </div>

      {isHedged ? (
        <>
          {/* Hedged: prominent total value in hedge currency + USD subtitle */}
          <div className="balance-card__amount">
            <span className="balance-card__xmr">
              {isNonUsdHedge && totalCurrencyValue !== null
                ? `${hedgeCurrency === 'EUR' ? '€' : hedgeCurrency === 'GBP' ? '£' : ''}${totalCurrencyValue.toFixed(hedgeCurrency === 'XAU' ? 4 : hedgeCurrency === 'XAG' ? 2 : 2)}${hedgeCurrency === 'XAU' || hedgeCurrency === 'XAG' ? ' oz' : ''}`
                : (totalUsdValue !== null ? `$${totalUsdValue.toFixed(2)}` : '—')}
            </span>
            {isNonUsdHedge && totalUsdValue !== null && (
              <span className="balance-card__usd">≈ ${totalUsdValue.toFixed(2)}</span>
            )}
          </div>

          {/* Breakdown: XMR component + USDC on Lighter */}
          <div className="balance-card__breakdown balance-card__breakdown--hedged">
            <div className="balance-card__breakdown-row">
              <span>{xmrBalanceStr} XMR</span>
              <span>{xmrUsdValue !== null ? `$${xmrUsdValue.toFixed(2)}` : '—'}</span>
            </div>
            <div className="balance-card__breakdown-row balance-card__breakdown-row--usdc">
              <span>Lighter net equity</span>
              <span>${lighterNetEquity.toFixed(2)}</span>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="balance-card__amount">
            <span className="balance-card__xmr">{xmrBalanceStr} XMR</span>
            {xmrUsdValue !== null && (
              <span className="balance-card__usd">≈ ${xmrUsdValue.toFixed(2)}</span>
            )}
          </div>

          {usdcBalance && parseFloat(usdcBalance) > 0 && (
            <div className="balance-card__usdc-row">
              <span className="balance-card__usdc-label">USDC (Arbitrum)</span>
              <span className="balance-card__usdc-value">${usdcBalance}</span>
            </div>
          )}
        </>
      )}

      {/* Breakdown when not all funds are immediately spendable */}
      {xmrInfo && !allSpendable && !isHedged && (
        <div className="balance-card__breakdown">
          {hasPending && (
            <span className="balance-card__breakdown-row balance-card__breakdown-row--pending">
              {formatXmr(xmrInfo.pendingBalance)} XMR unconfirmed
            </span>
          )}
          {hasLocked && (
            <span className="balance-card__breakdown-row balance-card__breakdown-row--locked">
              {formatXmr(xmrInfo.lockedFunds)} XMR locked
              <span className="balance-card__breakdown-hint"> · awaiting 10 confirmations</span>
            </span>
          )}
          <span className="balance-card__breakdown-row balance-card__breakdown-row--available">
            {formatXmr(xmrInfo.spendableBalance)} XMR available
          </span>
        </div>
      )}

      {syncAge !== null && (
        <div className="balance-card__sync-status">
          {isSyncing
            ? 'Syncing…'
            : syncAge === 0
            ? 'Synced just now'
            : `Synced ${syncAge}m ago`}
        </div>
      )}

      {xmrInfo && (
        <div className="balance-card__scan-progress">
          Scanned to block {xmrInfo.scanHeight.toLocaleString()} /{' '}
          {xmrInfo.blockchainHeight.toLocaleString()}
        </div>
      )}
    </div>
  );
}
// force hmr Wed Mar  4 11:17:02 AM +08 2026
