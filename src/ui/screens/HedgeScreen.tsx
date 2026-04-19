import { useEffect, useState, memo } from 'react';
import { useWalletStore } from '../../store/wallet';
import { HedgeOrchestrator } from '../components/HedgeOrchestrator';
import { UnhedgeOrchestrator, hasUnhedgeInProgress } from '../components/UnhedgeOrchestrator';
import { BotToggle } from '../components/BotToggle';
import { CollateralAdjust } from '../components/CollateralAdjust';
import { getHedgeStatus, getXmrMarketInfo, getMarketInfo, fetchEthUsdcBalanceProxy, rebalanceHedge, switchHedge, AVAILABLE_MARKETS, CURRENCY_TO_MARKET_ID } from '../../backend/lighter';
import type { LighterMarketInfo, LighterPosition, HedgeCurrency } from '../../backend/lighter';

const WARN_MARGIN_PCT = 20;
const CRIT_MARGIN_PCT = 12;

const MarginWarning = memo(function MarginWarning({
  lighterUsdc,
  positionSize,
  markPrice,
  eurPosition,
}: { lighterUsdc: number; positionSize: number; markPrice: number; eurPosition?: LighterPosition }) {
  // For EUR hedges, collateral covers both the XMR short and the EUR long.
  // Sum both notionals so margin% reflects true exposure.
  const xmrUsdValue = positionSize * markPrice;
  const eurUsdValue = eurPosition ? eurPosition.size * eurPosition.markPrice : 0;
  const posUsdValue = xmrUsdValue + eurUsdValue;
  if (posUsdValue <= 0 || lighterUsdc <= 0) return null;
  const marginPct = (lighterUsdc / posUsdValue) * 100;
  if (marginPct >= WARN_MARGIN_PCT) return null;
  const isCritical = marginPct < CRIT_MARGIN_PCT;
  return (
    <div className={`hedge-margin-warning hedge-margin-warning--${isCritical ? 'critical' : 'warn'}`}>
      <strong>{isCritical ? 'Liquidation risk!' : 'Low margin'}</strong>
      {' '}Collateral is <strong>{marginPct.toFixed(1)}%</strong> of position value
      {isCritical ? ' — liquidation imminent. ' : '. '}
      Swap XMR → USDC and top up to add a safety buffer.
    </div>
  );
});

function RebalanceBanner({ drift, xmrBalance, onDone }: {
  drift: number;
  xmrBalance: number;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRebalance() {
    setBusy(true);
    setError(null);
    try {
      const result = await rebalanceHedge(xmrBalance);
      if (!result.success) throw new Error(result.error ?? 'Rebalance failed');
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rebalance failed');
    } finally {
      setBusy(false);
    }
  }

  const isUnder = drift > 0;
  return (
    <div className="hedge-rebalance">
      <div className="hedge-rebalance__text">
        Position {isUnder ? 'under' : 'over'}-hedged by{' '}
        <strong>{Math.abs(drift).toFixed(4)} XMR</strong>
        {' '}— {isUnder ? 'short more to match your balance' : 'close excess short'}.
      </div>
      {error && <div className="hedge-rebalance__error">{error}</div>}
      <button className="btn btn--secondary btn--sm hedge-rebalance__btn" onClick={handleRebalance} disabled={busy}>
        {busy ? 'Rebalancing…' : 'Rebalance position'}
      </button>
    </div>
  );
}

function SecondaryMarkets({ primaryMarketId, xmrBalance }: {
  primaryMarketId: number;
  xmrBalance: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const secondaryMarkets = AVAILABLE_MARKETS.filter(m => m.marketId !== primaryMarketId);

  return (
    <div className="bot-toggle-extra">
      <button
        className="btn btn--ghost btn--sm bot-toggle-extra__trigger"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? 'Hide extra markets' : `More markets (${secondaryMarkets.length})`}
      </button>
      {expanded && secondaryMarkets.map(m => (
        <div key={m.marketId} className="bot-toggle-extra__card">
          {m.warning && (
            <div className="bot-toggle__warning">{m.warning}</div>
          )}
          <BotToggle
            marketId={m.marketId}
            xmrBalance={xmrBalance}
            hedgeCurrency={m.currency}
          />
        </div>
      ))}
    </div>
  );
}

export function HedgeScreen() {
  const {
    navigate,
    lighterMarket,
    hedgeStatus,
    ethWallet,
    xmrInfo,
    activeWalletId,
    walletList,
    setLighterMarket,
    setHedgeStatus,
  } = useWalletStore();

  // Effective hedge currency: prefer live position-derived, fall back to wallet preference
  const walletEntry = walletList.find(w => w.id === activeWalletId);
  const effectiveHedgeCurrency = hedgeStatus?.hedgeCurrency ?? walletEntry?.hedgeCurrency ?? 'USD';

  const xmrBalance = xmrInfo
    ? Number(xmrInfo.totalReceived - xmrInfo.totalSent) / 1e12
    : 0;

  const isHedged = hedgeStatus?.isHedged ?? false;
  const [botActive, setBotActive] = useState(false);
  const [realisedApy, setRealisedApy] = useState<number | null>(null);
  const [ethUsdcBalance, setEthUsdcBalance] = useState<number>(0);
  const [forcedEthRecovery, setForcedEthRecovery] = useState<number>(0);
  const [recoverInstead, setRecoverInstead] = useState(false);
  const [currencyMarket, setCurrencyMarket] = useState<LighterMarketInfo | null>(null);
  const [switching, setSwitching] = useState(false);
  const [switchTarget, setSwitchTarget] = useState<HedgeCurrency | null>(null);

  useEffect(() => {
    getXmrMarketInfo().then(setLighterMarket).catch(() => {});
    // Fetch currency market for the active hedge currency
    if (effectiveHedgeCurrency !== 'USD') {
      getMarketInfo(`${effectiveHedgeCurrency}-USD`).then(setCurrencyMarket).catch(() => {});
    }
  }, [setLighterMarket, effectiveHedgeCurrency]);

  // Poll Ethereum mainnet USDC balance every 30s when not hedged and Lighter is empty.
  // Catches the withdrawal-in-transit window: Lighter withdrawal done but USDC not yet
  // arrived on ETH mainnet. Without polling the user would see a confusing empty screen.
  useEffect(() => {
    if (isHedged || !ethWallet) return;
    const lighterUsdc = hedgeStatus?.lighterUsdc ?? 0;
    if (lighterUsdc > 0.01) return; // stuckUsdc case handled separately
    const check = () =>
      fetchEthUsdcBalanceProxy(ethWallet!.address)
        .then(b => setEthUsdcBalance(b))
        .catch(() => {});
    check();
    const id = setInterval(check, 30_000);
    return () => clearInterval(id);
  }, [isHedged, ethWallet?.address, hedgeStatus?.lighterUsdc]);

  async function refreshHedgeStatus() {
    try {
      const [status, market] = await Promise.all([
        getHedgeStatus(ethWallet?.address),
        getXmrMarketInfo(),
      ]);
      setHedgeStatus(status);
      setLighterMarket(market);
      if (status.hedgeCurrency && status.hedgeCurrency !== 'USD') {
        getMarketInfo(`${status.hedgeCurrency}-USD`).then(setCurrencyMarket).catch(() => {});
      } else {
        setCurrencyMarket(null);
      }
    } catch { /* ignore */ }
  }

  async function handleSwitchHedge(toCurrency: HedgeCurrency) {
    setSwitching(true);
    setSwitchTarget(null);
    try {
      const result = await switchHedge(toCurrency);
      if (!result.success) throw new Error(result.error ?? 'Switch failed');
      await refreshHedgeStatus();
    } catch (err) {
      console.error('Switch hedge failed:', err);
    } finally {
      setSwitching(false);
    }
  }

  return (
    <div className="screen hedge-screen">
      <div className="screen__header">
        <button className="back-btn" onClick={() => navigate('home')}>
          ← Back
        </button>
        <h1>Lock {effectiveHedgeCurrency ?? 'USD'} Value</h1>
      </div>

      {/* Description — only shown when not yet hedged */}
      {!isHedged && (
        <div className="hedge-screen__explainer">
          <p>
            <strong>How it works:</strong> NeroHedge opens a short XMR/USD
            position on Lighter.xyz equal to your XMR balance, making your
            portfolio delta-neutral. If XMR drops 20%, you gain 20% on the
            short — your USD value is preserved.
          </p>
          <p>
            You also earn funding payments from long traders.
            Historical rate: ~19% annualised.
          </p>
        </div>
      )}

      {/* Market stats bar */}
      {lighterMarket && (
        <div className="hedge-screen__market">
          {effectiveHedgeCurrency && effectiveHedgeCurrency !== 'USD' && currencyMarket && currencyMarket.markPrice > 0 ? (
            <div className="market-stat">
              <span className="market-stat__label">XMR/{effectiveHedgeCurrency}</span>
              <span className="market-stat__value">
                {(() => {
                  const xmrInCurrency = lighterMarket.markPrice / currencyMarket.markPrice;
                  const hc = effectiveHedgeCurrency;
                  const sym = hc === 'EUR' ? '€' : hc === 'GBP' ? '£' : '';
                  if (hc === 'XAU' || hc === 'XAG') {
                    const grams = xmrInCurrency * 31.1035;
                    return xmrInCurrency < 1 ? `${grams.toFixed(3)} g` : `${xmrInCurrency.toFixed(2)} oz`;
                  }
                  return `${sym}${xmrInCurrency.toFixed(2)}`;
                })()}
              </span>
            </div>
          ) : (
            <div className="market-stat">
              <span className="market-stat__label">XMR/USD</span>
              <span className="market-stat__value">${lighterMarket.markPrice.toFixed(2)}</span>
            </div>
          )}
          {/* When bot is active show APY; otherwise show current funding rate */}
          {botActive ? (
            <div className="market-stat market-stat--green">
              <span className="market-stat__label">APY</span>
              <span className="market-stat__value">
                {realisedApy !== null ? `${realisedApy.toFixed(1)}%` : '…'}
              </span>
            </div>
          ) : (
            <div className="market-stat market-stat--green">
              <span className="market-stat__label">Funding (ann.)</span>
              <span className="market-stat__value">
                {lighterMarket.annualizedFundingPct.toFixed(1)}%
              </span>
            </div>
          )}
        </div>
      )}

      {(() => {
        // Case 1: USDC in Lighter without an open position.
        // Could be from a bridge that completed but failed to open a short,
        // or from a position that was closed externally via the Lighter UI.
        // Default: offer to open the hedge (HedgeOrchestrator handles usdc_ready).
        // Escape hatch: user can tap "Recover as XMR" to swap back instead.
        const primaryMarketId = CURRENCY_TO_MARKET_ID[effectiveHedgeCurrency] ?? 77;
        // Check both new per-market key and legacy key for backward compat
        const botActiveKeyNew = activeWalletId ? `nerodolla_bot_active_${activeWalletId}_m${primaryMarketId}` : `nerodolla_bot_active_m${primaryMarketId}`;
        const botActiveKeyLegacy = activeWalletId ? `nerodolla_bot_active_${activeWalletId}` : 'nerodolla_bot_active';
        const botLaunched = localStorage.getItem(botActiveKeyNew) === 'true' || localStorage.getItem(botActiveKeyLegacy) === 'true';
        const stuckUsdc = !isHedged && !botLaunched && (hedgeStatus?.lighterUsdc ?? 0) > 0.01;
        if (stuckUsdc && recoverInstead) {
          return (
            <UnhedgeOrchestrator
              onUnhedged={() => { setRecoverInstead(false); refreshHedgeStatus(); }}
              walletId={activeWalletId}
              recoveryMode
              availableUsdc={hedgeStatus!.lighterUsdc}
            />
          );
        }
        if (stuckUsdc) {
          return (
            <>
              <HedgeOrchestrator preCheck onHedgeOpened={refreshHedgeStatus} />
              <button
                className="btn btn--ghost"
                style={{ marginTop: 8, fontSize: 13, width: '100%' }}
                onClick={() => setRecoverInstead(true)}
              >
                Recover USDC as XMR instead →
              </button>
            </>
          );
        }

        // Case 1b: "Start fresh" forced us here — USDC confirmed on ETH mainnet by proxy
        if (forcedEthRecovery > 0.01) {
          return (
            <UnhedgeOrchestrator
              onUnhedged={() => { setForcedEthRecovery(0); refreshHedgeStatus(); }}
              walletId={activeWalletId}
              ethUsdcRecovery={forcedEthRecovery}
            />
          );
        }

        // Case 1c: Lighter withdrawal completed, USDC on Ethereum mainnet detected automatically
        const ethUsdcStuck = !isHedged && ethUsdcBalance > 0.01 && !hasUnhedgeInProgress(activeWalletId);
        if (ethUsdcStuck) {
          return (
            <UnhedgeOrchestrator
              onUnhedged={() => { setEthUsdcBalance(0); refreshHedgeStatus(); }}
              walletId={activeWalletId}
              ethUsdcRecovery={ethUsdcBalance}
            />
          );
        }

        // Case 2: Fully hedged, or unhedge in progress (persisted localStorage state)
        if (isHedged || hasUnhedgeInProgress(activeWalletId)) {
          return (
            <>
              {/* Static position panel — hidden when bot is active */}
              {isHedged && !botActive && hedgeStatus?.position && (
                <div className="hedge-screen__active-pos">
                  <div className="hedge-pos__row">
                    <span>Short size</span>
                    <span>{hedgeStatus.position.size.toFixed(4)} XMR</span>
                  </div>
                  <div className="hedge-pos__row">
                    <span>Locked value</span>
                    <span>
                      {effectiveHedgeCurrency === 'EUR'
                        ? `€${hedgeStatus.lockedEurValue?.toFixed(2) ?? '—'}`
                        : effectiveHedgeCurrency === 'GBP'
                          ? `£${hedgeStatus.lockedEurValue?.toFixed(2) ?? '—'}`
                          : effectiveHedgeCurrency === 'XAU' || effectiveHedgeCurrency === 'XAG'
                            ? `${(() => { const sz = hedgeStatus.eurPosition?.size ?? 0; return sz < 1 ? `${(sz * 31.1035).toFixed(3)} g` : `${sz.toFixed(2)} oz`; })()} ($${hedgeStatus.lockedUsdValue?.toFixed(2) ?? '—'})`
                            : `$${hedgeStatus.lockedUsdValue?.toFixed(2) ?? '—'}`}
                    </span>
                  </div>
                  <div className="hedge-pos__row">
                    <span>USDC</span>
                    <span>
                      ${hedgeStatus.lighterUsdc?.toFixed(2) ?? '—'}
                      {hedgeStatus.position && (
                        <span className="hedge-pos__muted">
                          {' '}(Avail ${(hedgeStatus.lighterUsdc ?? 0 - hedgeStatus.position.marginUsed).toFixed(2)})
                        </span>
                      )}
                    </span>
                  </div>
                </div>
              )}

              {isHedged && !botActive && hedgeStatus?.position && (() => {
                const drift = xmrBalance - hedgeStatus.position.size;
                if (Math.abs(drift) < 0.05) return null;
                return <RebalanceBanner drift={drift} xmrBalance={xmrBalance} onDone={refreshHedgeStatus} />;
              })()}

              {isHedged && hedgeStatus && (
                <MarginWarning
                  lighterUsdc={hedgeStatus.lighterUsdc ?? 0}
                  positionSize={hedgeStatus.position?.size ?? 0}
                  markPrice={hedgeStatus.position?.markPrice ?? 0}
                  eurPosition={hedgeStatus.eurPosition}
                />
              )}

              {isHedged && hedgeStatus?.position && (
                <CollateralAdjust
                  onComplete={refreshHedgeStatus}
                  lighterUsdc={hedgeStatus.lighterUsdc ?? 0}
                  marginUsed={hedgeStatus.position.marginUsed}
                  markPrice={hedgeStatus.position.markPrice}
                  positionSize={hedgeStatus.position.size}
                />
              )}

              {/* Hedge switch */}
              {isHedged && !botActive && (
                <div className="hedge-switch">
                  {switchTarget ? (
                    <div className="hedge-switch__panel">
                      <div className="hedge-switch__title">Switch hedge to:</div>
                      <div className="hedge-switch__grid">
                        {(['USD', 'EUR', 'GBP', 'XAU', 'XAG'] as HedgeCurrency[])
                          .filter(c => c !== effectiveHedgeCurrency)
                          .map(c => (
                            <button
                              key={c}
                              className="btn btn--secondary btn--sm"
                              disabled={switching}
                              onClick={() => handleSwitchHedge(c)}
                            >
                              {c === 'USD' ? '$ USD' : c === 'EUR' ? '€ EUR' : c === 'GBP' ? '£ GBP' : c === 'XAU' ? 'Au GOLD' : 'Ag SILVER'}
                            </button>
                          ))}
                      </div>
                      {switching && <div className="hedge-switch__status">Switching…</div>}
                      <button className="btn btn--ghost btn--sm" onClick={() => setSwitchTarget(null)} disabled={switching}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button className="btn btn--ghost btn--sm" onClick={() => setSwitchTarget(effectiveHedgeCurrency ?? 'USD')}>
                      Switch currency
                    </button>
                  )}
                </div>
              )}

              {isHedged && (
                <BotToggle
                  marketId={primaryMarketId}
                  xmrBalance={xmrBalance}
                  hedgePosition={hedgeStatus?.position}
                  lighterUsdc={hedgeStatus?.lighterUsdc}
                  hedgeCurrency={effectiveHedgeCurrency}
                  currencyMarkPrice={hedgeStatus?.eurPosition?.markPrice}
                  currencyEntryPrice={hedgeStatus?.eurPosition?.entryPrice}
                  onActiveChange={setBotActive}
                  onApyChange={setRealisedApy}
                />
              )}

              {isHedged && (
                <SecondaryMarkets
                  primaryMarketId={primaryMarketId}
                  xmrBalance={xmrBalance}
                />
              )}

              <UnhedgeOrchestrator
                onUnhedged={refreshHedgeStatus}
                walletId={activeWalletId}
                onForceEthRecovery={(amount) => setForcedEthRecovery(amount)}
              />
            </>
          );
        }

        // Case 3: Not hedged, no in-progress flow — offer to open hedge.
        // If the bot was started but hasn't built a position yet, show bot status instead.
        if (botLaunched) {
          return (
            <>
              <div className="hedge-screen__bot-pending">
                Bot is establishing your short position via limit orders.
                Your position will appear here once the first trade fills.
              </div>
              <BotToggle
                marketId={primaryMarketId}
                xmrBalance={xmrBalance}
                lighterUsdc={hedgeStatus?.lighterUsdc}
                hedgeCurrency={effectiveHedgeCurrency}
                currencyMarkPrice={hedgeStatus?.eurPosition?.markPrice}
                currencyEntryPrice={hedgeStatus?.eurPosition?.entryPrice}
                onActiveChange={setBotActive}
                onApyChange={setRealisedApy}
              />
            </>
          );
        }
        return <HedgeOrchestrator onHedgeOpened={refreshHedgeStatus} />;
      })()}

      <div className="hedge-screen__risks">
        <h3>Risks</h3>
        <ul>
          <li>Funding rate can go negative (you pay instead of earn)</li>
          <li>Lighter smart contract risk</li>
          <li>Liquidation risk if collateral falls below maintenance margin</li>
          <li>Withdrawal delay from Lighter (up to ~4h; longer during high Arbitrum load)</li>
        </ul>
      </div>
    </div>
  );
}
