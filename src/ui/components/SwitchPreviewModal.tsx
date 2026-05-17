/**
 * SwitchPreviewModal — shows a cost preview before switching hedge currency.
 *
 * Props:
 *   fromCurrency: current HedgeCurrency
 *   toCurrency: target HedgeCurrency
 *   hedgeStatus: current position data
 *   onConfirm: () => void
 *   onCancel: () => void
 *   busy: boolean
 */
import type { HedgeCurrency, HedgeStatus } from '../../backend/lighter';

const CURRENCY_LABELS: Record<string, string> = {
  USD: '$ USD', EUR: '€ EUR', GBP: '£ GBP', XAU: 'Au GOLD', XAG: 'Ag SILVER',
};

interface SwitchPreviewModalProps {
  fromCurrency: HedgeCurrency;
  toCurrency: HedgeCurrency;
  hedgeStatus: HedgeStatus | null;
  xmrBalance: number;
  toCurrencyMarkPrice?: number;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}

export function SwitchPreviewModal({
  fromCurrency,
  toCurrency,
  hedgeStatus,
  xmrBalance,
  toCurrencyMarkPrice,
  onConfirm,
  onCancel,
  busy,
}: SwitchPreviewModalProps) {
  const xmrPosition = hedgeStatus?.position;
  const currencyPosition = hedgeStatus?.eurPosition;

  // IMPORTANT: use CURRENT wallet-driven values, not stale position data.
  // The new hedge must be sized to the current portfolio value:
  //   xmr_wallet_balance * current_xmr_price + lighter_equity(collateral + total_upnl)
  const xmrMark = xmrPosition?.markPrice ?? 0;
  const xmrWalletValue = xmrBalance * xmrMark;

  const currSize = currencyPosition?.size ?? 0;
  const currMark = currencyPosition?.markPrice ?? 0;
  const currNotional = currSize * currMark;

  const lighterUsdc = hedgeStatus?.lighterUsdc ?? 0;
  const xmrPnL = xmrPosition?.unrealizedPnl ?? 0;
  const currPnL = currencyPosition?.unrealizedPnl ?? 0;
  const lighterEquity = lighterUsdc + xmrPnL + currPnL;

  const totalPortfolioValue = xmrWalletValue + lighterEquity;

  const toLabel = CURRENCY_LABELS[toCurrency] ?? toCurrency;
  const fromLabel = CURRENCY_LABELS[fromCurrency] ?? fromCurrency;

  return (
    <div className="switch-preview-overlay">
      <div className="switch-preview-modal">
        <div className="switch-preview-modal__header">
          <h3>Switch hedge currency</h3>
          <button className="switch-preview-modal__close" onClick={onCancel} disabled={busy}>×</button>
        </div>

        <div className="switch-preview-modal__subtitle">
          {fromLabel} → {toLabel}
        </div>

        <div className="switch-preview-modal__review">
          {/* Current portfolio — drives new position size */}
          <div className="switch-preview-modal__row">
            <span>XMR wallet</span>
            <span>{xmrBalance.toFixed(4)} XMR @ ${xmrMark.toFixed(2)}</span>
          </div>
          <div className="switch-preview-modal__row switch-preview-modal__row--muted">
            <span>XMR value</span>
            <span>${xmrWalletValue.toFixed(2)}</span>
          </div>
          <div className="switch-preview-modal__row switch-preview-modal__row--muted">
            <span>Lighter equity</span>
            <span>${lighterEquity.toFixed(2)} (collateral + PnL)</span>
          </div>
          <div className="switch-preview-modal__row">
            <span>Total portfolio value</span>
            <span>${totalPortfolioValue.toFixed(2)}</span>
          </div>

          {/* Close old currency LONG */}
          {fromCurrency !== 'USD' && currSize > 0 && (
            <>
              <div className="switch-preview-modal__row switch-preview-modal__row--warn">
                <span>Close {fromCurrency} long</span>
                <span>{currSize.toFixed(4)} {fromCurrency} @ {currMark.toFixed(4)}</span>
              </div>
              <div className="switch-preview-modal__row switch-preview-modal__row--muted">
                <span>Notional</span>
                <span>${currNotional.toFixed(2)}</span>
              </div>
            </>
          )}

          {/* Open new currency LONG */}
          {toCurrency !== 'USD' && (
            <div className="switch-preview-modal__row switch-preview-modal__row--green">
              <span>Open {toCurrency} long</span>
              <span>
                {(() => {
                  const notional = totalPortfolioValue;
                  if (toCurrency === 'XAU' || toCurrency === 'XAG') {
                    const mark = toCurrencyMarkPrice || 0;
                    if (mark > 0) {
                      const oz = notional / mark;
                      if (oz < 1) {
                        return `≈ ${(oz * 31.1035).toFixed(3)} g (${notional.toFixed(2)} USD)`;
                      }
                      return `≈ ${oz.toFixed(4)} oz (${notional.toFixed(2)} USD)`;
                    }
                  }
                  return `≈ $${notional.toFixed(2)} notional`;
                })()}
              </span>
            </div>
          )}

          {toCurrency === 'USD' && fromCurrency !== 'USD' && (
            <div className="switch-preview-modal__row switch-preview-modal__row--info">
              <span>Result</span>
              <span>USD-only hedge (no currency long)</span>
            </div>
          )}
        </div>

        <div className="switch-preview-modal__note">
          {totalPortfolioValue > 500
            ? `Large order: will be executed as 3 slices with 10s delays to reduce market impact. `
            : `Slippage tolerance: 50 bps (0.5%). `}
          The bot will restart automatically after the switch completes.
        </div>

        <div className="switch-preview-modal__actions">
          <button className="btn btn--primary" onClick={onConfirm} disabled={busy}>
            {busy ? 'Switching…' : 'Confirm switch'}
          </button>
          <button className="btn btn--ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
