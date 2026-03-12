import { useWalletStore } from '../../store/wallet';
import { estimateDailyFunding } from '../../backend/lighter';
import { formatXmr } from '../../backend/lws';

/**
 * HedgeToggle — home-screen preview card shown when the wallet has XMR but is
 * not yet hedged.  Tapping "Lock USD Value" navigates to HedgeScreen where
 * HedgeOrchestrator handles the full flow (Lighter account creation, XMR→USDC
 * bridge, position open).  No inline hedge logic lives here.
 */
export function HedgeToggle() {
  const {
    lighterMarket,
    xmrInfo,
    navigate,
  } = useWalletStore();

  const xmrBalance = xmrInfo
    ? Number(formatXmr(xmrInfo.spendableBalance))
    : 0;
  const markPrice = lighterMarket?.markPrice ?? 0;
  const estimatedUsdLock = (xmrBalance * markPrice).toFixed(2);
  const dailyFunding = lighterMarket
    ? estimateDailyFunding(xmrBalance * markPrice, lighterMarket.fundingRate8h)
    : 0;

  return (
    <div className="hedge-toggle">
      <div className="hedge-toggle__header">
        <div className="hedge-toggle__title">
          <span className="hedge-toggle__icon">🔓</span>
          <div>
            <div className="hedge-toggle__name">Lock USD Value</div>
            <div className="hedge-toggle__subtitle">
              Hedge XMR price risk, earn funding
            </div>
          </div>
        </div>
      </div>

      {lighterMarket && (
        <div className="hedge-toggle__preview">
          <div className="hedge-preview__label">If enabled:</div>
          <div className="hedge-preview__row">
            <span>Value locked</span>
            <span>${estimatedUsdLock}</span>
          </div>
          <div className="hedge-preview__row hedge-preview__row--green">
            <span>Est. daily funding</span>
            <span>+${dailyFunding.toFixed(4)}</span>
          </div>
          <div className="hedge-preview__row">
            <span>Annualised rate</span>
            <span>{lighterMarket.annualizedFundingPct.toFixed(1)}% APY</span>
          </div>
          <div className="hedge-preview__note">
            Delta-neutral: XMR price moves cancel out.
            You earn funding paid by longs.
          </div>
        </div>
      )}

      <button
        className="btn btn--primary hedge-toggle__cta"
        onClick={() => navigate('hedge')}
      >
        Lock USD Value →
      </button>
    </div>
  );
}
