/**
 * CollateralAdjust — bidirectional slider for adding or removing Lighter collateral.
 *
 * Drag right → swap more XMR → USDC → deposit to Lighter.
 * Drag left  → withdraw excess USDC from Lighter (lands on ETH L1 after 1–4h ZK proof;
 *              existing ethUsdcRecovery flow auto-detects and offers USDC→XMR swap).
 */
import { useState, useRef, useEffect } from 'react';
import { useWalletStore } from '../../store/wallet';
import { getDepositIntentAddress } from '../../backend/deposit';
import { withdrawExcessCollateral } from '../../backend/lighter';
import { atomicToUsdc, MIN_SWAP_XMR } from '../../backend/wagyu';
import {
  getHedgeBestQuote,
  createHedgeOrder,
  pollSwapOrder,
  type SwapQuote,
  type SwapOrder,
} from '../../backend/swapProvider';
import { transferXmr, formatXmr } from '../../backend/lws';

type Step =
  | 'idle' | 'form' | 'confirming'
  | 'creating_order' | 'sending_xmr' | 'bridging'
  | 'withdrawing'
  | 'complete' | 'error';

interface CollateralAdjustProps {
  onComplete: () => void;
  lighterUsdc: number;
  marginUsed: number;
  markPrice: number;
  positionSize: number;
}

/** Minimum collateral ratio (fraction) — don't let user withdraw below this. */
const MIN_MARGIN_RATIO = 0.20;
/** Warn when withdrawal would push margin below this ratio. */
const WARN_MARGIN_RATIO = 0.30;

export function CollateralAdjust({
  onComplete,
  lighterUsdc,
  marginUsed,
  markPrice,
  positionSize,
}: CollateralAdjustProps) {
  const { xmrKeys, ethWallet, xmrInfo, walletCreatedHeight } = useWalletStore();

  const [step, setStep]                 = useState<Step>('idle');
  const [targetUsdc, setTargetUsdc]     = useState(lighterUsdc);
  const [quote, setQuote]               = useState<SwapQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteErr, setQuoteErr]         = useState<string | null>(null);
  const [bridgeDetail, setBridgeDetail] = useState<SwapOrder | null>(null);
  const [errorMsg, setErrorMsg]         = useState<string | null>(null);
  const [withdrawnUsdc, setWithdrawnUsdc] = useState(0);

  const pollRef       = useRef<ReturnType<typeof setInterval> | null>(null);
  const quoteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const orderRef      = useRef<SwapOrder | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current)       clearInterval(pollRef.current);
      if (quoteTimerRef.current) clearTimeout(quoteTimerRef.current);
    };
  }, []);

  // Reset target when external collateral changes (e.g. after a top-up completes elsewhere)
  useEffect(() => {
    if (step === 'idle') setTargetUsdc(lighterUsdc);
  }, [lighterUsdc, step]);

  // ── Derived values ─────────────────────────────────────────────────────────

  const maxXmr = xmrInfo ? Math.floor(Number(xmrInfo.spendableBalance) / 1e6) / 1e6 : 0;
  const notional = positionSize * markPrice;

  // Slider bounds (in USDC)
  const minUsdc = Math.max(marginUsed * 1.01, notional * MIN_MARGIN_RATIO); // can't go below min margin
  const maxAddableUsdc = maxXmr * markPrice; // rough estimate of max XMR→USDC
  const maxUsdc = lighterUsdc + maxAddableUsdc;

  const delta = targetUsdc - lighterUsdc;
  const isAdding = delta > 0;
  const isRemoving = delta < 0;
  const absDelta = Math.abs(delta);

  // XMR equivalent for add direction
  const xmrNeeded = isAdding ? absDelta / markPrice : 0;
  const xmrNeededFloored = Math.floor(xmrNeeded * 1e6) / 1e6;

  // Margin ratio at target
  const targetMarginRatio = notional > 0 ? targetUsdc / notional : 1;
  const currentMarginRatio = notional > 0 ? lighterUsdc / notional : 1;

  // Validation
  const minSwapUsdc = parseFloat(MIN_SWAP_XMR) * markPrice;
  const tooSmall = absDelta > 0 && absDelta < minSwapUsdc && isAdding;
  const tooSmallWithdraw = absDelta > 0 && absDelta < 1 && isRemoving;
  const belowMinMargin = isRemoving && targetUsdc < minUsdc;
  const noChange = absDelta < 0.50;

  // ── Quote (debounced, add direction only) ──────────────────────────────────

  function fetchQuote(xmr: number) {
    if (quoteTimerRef.current) clearTimeout(quoteTimerRef.current);
    setQuote(null);
    setQuoteErr(null);
    if (xmr < parseFloat(MIN_SWAP_XMR)) {
      setQuoteLoading(false);
      return;
    }
    setQuoteLoading(true);
    quoteTimerRef.current = setTimeout(async () => {
      try {
        const q = await getHedgeBestQuote(xmr.toFixed(6));
        setQuote(q);
        setQuoteErr(null);
      } catch (err) {
        setQuoteErr(err instanceof Error ? err.message : 'Quote unavailable');
      } finally {
        setQuoteLoading(false);
      }
    }, 500);
  }

  function handleSliderChange(val: number) {
    setTargetUsdc(val);
    const d = val - lighterUsdc;
    if (d > 0) {
      const xmr = Math.floor((d / markPrice) * 1e6) / 1e6;
      fetchQuote(xmr);
    } else {
      // Remove direction — no quote needed, just a withdrawal
      setQuote(null);
      setQuoteLoading(false);
      setQuoteErr(null);
    }
  }

  function handleExpand() {
    setTargetUsdc(lighterUsdc);
    setStep('form');
  }

  // ── Confirm: add collateral ────────────────────────────────────────────────

  async function handleConfirmAdd() {
    if (!ethWallet || !xmrKeys) return;
    setStep('creating_order');
    try {
      const intentResult = await getDepositIntentAddress(ethWallet.address, 42161);
      const hedgeQuote = quote ?? await getHedgeBestQuote(xmrNeededFloored.toFixed(6));
      const order = await createHedgeOrder(hedgeQuote, intentResult.intent_address, xmrKeys.primaryAddress);
      orderRef.current = order;

      setStep('sending_xmr');
      await transferXmr(
        xmrKeys.primaryAddress,
        xmrKeys.viewKeyPrivate,
        xmrKeys.spendKeyPrivate,
        order.depositAddress,
        order.depositAmount,
        walletCreatedHeight ?? undefined,
      );

      setStep('bridging');
      startBridgePolling(order);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Transaction failed');
      setStep('error');
    }
  }

  // ── Confirm: remove collateral ─────────────────────────────────────────────

  async function handleConfirmRemove() {
    setStep('withdrawing');
    try {
      const result = await withdrawExcessCollateral(absDelta);
      if (!result.success) throw new Error(result.error ?? 'Withdrawal failed');
      setWithdrawnUsdc(absDelta);
      setStep('complete');
      onComplete();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Withdrawal failed');
      setStep('error');
    }
  }

  // ── Bridge polling (add direction) ─────────────────────────────────────────

  function startBridgePolling(order: SwapOrder) {
    if (pollRef.current) clearInterval(pollRef.current);
    const pollInterval = order.provider === 'trocador' ? 60_000 : 10_000;
    pollRef.current = setInterval(async () => {
      try {
        const detail = await pollSwapOrder(order);
        setBridgeDetail(detail);
        if (detail.status === 'complete') {
          clearInterval(pollRef.current!);
          pollRef.current = null;
          setStep('complete');
          onComplete();
        } else if (['failed', 'refunded', 'expired'].includes(detail.status)) {
          clearInterval(pollRef.current!);
          pollRef.current = null;
          setErrorMsg(`Bridge ${detail.status}`);
          setStep('error');
        }
      } catch { /* transient — keep polling */ }
    }, pollInterval);
  }

  function handleReset() {
    if (pollRef.current) clearInterval(pollRef.current);
    orderRef.current = null;
    setBridgeDetail(null);
    setErrorMsg(null);
    setQuote(null);
    setTargetUsdc(lighterUsdc);
    setStep('idle');
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (step === 'idle') {
    return (
      <div className="top-up-flow">
        <button className="btn btn--ghost btn--sm top-up-flow__trigger" onClick={handleExpand}>
          Adjust collateral
        </button>
      </div>
    );
  }

  if (step === 'form') {
    const pctLabel = ((targetMarginRatio) * 100).toFixed(0);
    return (
      <div className="top-up-flow top-up-flow--open">
        <div className="top-up-flow__header">
          <span className="top-up-flow__title">Adjust collateral</span>
          <button className="top-up-flow__close" onClick={handleReset}>✕</button>
        </div>
        <div className="top-up-flow__hint">
          Drag to set target collateral. Current: ${lighterUsdc.toFixed(2)} ({(currentMarginRatio * 100).toFixed(0)}% of exposure)
        </div>

        <div className="hedge-orch__slider-row">
          <input
            className="hedge-orch__slider"
            type="range"
            min={Math.floor(minUsdc)}
            max={Math.ceil(Math.max(maxUsdc, lighterUsdc + 1))}
            step={1}
            value={Math.round(targetUsdc)}
            onChange={(e) => handleSliderChange(Number(e.target.value))}
            style={{
              accentColor: isRemoving ? 'var(--color-red, #e55)' : 'var(--color-primary)',
            }}
          />
          <span style={{ fontSize: 13, color: 'var(--color-text-muted)', minWidth: 48, textAlign: 'right' }}>
            {pctLabel}%
          </span>
        </div>

        {/* Delta display */}
        <div className="hedge-orch__quote">
          {noChange ? (
            <span style={{ color: 'var(--color-text-muted)' }}>No change</span>
          ) : isAdding ? (
            <>
              <span style={{ color: 'var(--color-green)' }}>+${absDelta.toFixed(2)}</span>
              {' '}({xmrNeededFloored.toFixed(4)} XMR)
              {tooSmall
                ? <span className="top-up-flow__quote-warn"> — min swap ~{MIN_SWAP_XMR} XMR</span>
                : quoteErr
                ? <span className="top-up-flow__quote-err"> — {quoteErr}</span>
                : quoteLoading
                ? <> — fetching quote…</>
                : quote
                ? <> → <strong>{quote.minReceived} USDC</strong> to Lighter</>
                : null}
            </>
          ) : (
            <>
              <span style={{ color: 'var(--color-red, #e55)' }}>−${absDelta.toFixed(2)}</span>
              {' '}withdraw from Lighter
              {tooSmallWithdraw && <span className="top-up-flow__quote-warn"> — amount too small</span>}
            </>
          )}
        </div>

        {/* Margin warnings */}
        {isRemoving && targetMarginRatio < WARN_MARGIN_RATIO && !belowMinMargin && (
          <div className="hedge-orch__collateral-warn">
            Margin will drop to {pctLabel}% — increased liquidation risk.
          </div>
        )}
        {belowMinMargin && (
          <div className="hedge-orch__collateral-warn" style={{ borderColor: 'var(--color-red, #e55)' }}>
            Cannot withdraw below {(MIN_MARGIN_RATIO * 100).toFixed(0)}% margin ({notional > 0 ? `$${minUsdc.toFixed(2)}` : '—'}).
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button
            className={`btn btn--sm ${isRemoving ? 'btn--danger' : 'btn--primary'}`}
            onClick={() => setStep('confirming')}
            disabled={noChange || belowMinMargin || tooSmall || tooSmallWithdraw || (isAdding && !quote && !quoteLoading)}
          >
            Review
          </button>
          <button className="btn btn--ghost btn--sm" onClick={handleReset}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (step === 'confirming') {
    const providerName = quote?.provider === 'trocador' ? 'Trocador' : 'wagyu.xyz';
    return (
      <div className="top-up-flow top-up-flow--open">
        <div className="top-up-flow__header">
          <span className="top-up-flow__title">
            {isAdding ? 'Confirm deposit' : 'Confirm withdrawal'}
          </span>
        </div>
        <div className="hedge-orch__review">
          {isAdding ? (
            <>
              <div className="hedge-orch__review-row">
                <span>You send</span>
                <span>{xmrNeededFloored.toFixed(4)} XMR</span>
              </div>
              <div className="hedge-orch__review-row">
                <span>Min USDC received</span>
                <span>{quote ? `${quote.minReceived} USDC` : '—'}</span>
              </div>
              <div className="hedge-orch__review-row">
                <span>Destination</span>
                <span>Lighter collateral</span>
              </div>
              <div className="hedge-orch__review-row">
                <span>Bridge</span>
                <span>{providerName}</span>
              </div>
            </>
          ) : (
            <>
              <div className="hedge-orch__review-row">
                <span>Withdraw</span>
                <span>${absDelta.toFixed(2)} USDC</span>
              </div>
              <div className="hedge-orch__review-row">
                <span>Destination</span>
                <span>Ethereum mainnet (1–4h)</span>
              </div>
              <div className="hedge-orch__review-row">
                <span>Collateral after</span>
                <span>${targetUsdc.toFixed(2)} ({(targetMarginRatio * 100).toFixed(0)}%)</span>
              </div>
            </>
          )}
        </div>
        {isRemoving && (
          <p style={{ fontSize: 12, color: 'var(--color-text-muted)', margin: '4px 0 0' }}>
            USDC will arrive on Ethereum mainnet in 1–4h. You can then swap it back to XMR.
          </p>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button
            className={`btn btn--sm ${isRemoving ? 'btn--danger' : 'btn--primary'}`}
            onClick={isAdding ? handleConfirmAdd : handleConfirmRemove}
          >
            {isAdding ? 'Confirm & send' : 'Confirm withdrawal'}
          </button>
          <button className="btn btn--ghost btn--sm" onClick={() => setStep('form')}>
            Back
          </button>
        </div>
      </div>
    );
  }

  if (step === 'creating_order' || step === 'sending_xmr' || step === 'bridging') {
    const label =
      step === 'creating_order' ? 'Creating swap order…' :
      step === 'sending_xmr'    ? `Sending ${xmrNeededFloored.toFixed(4)} XMR…` :
      bridgeDetail
        ? bridgeDetail.status === 'swapping'
          ? 'Confirmations received — swapping…'
          : `XMR confirming: ${bridgeDetail.confirmations ?? '?'}/${bridgeDetail.requiredConfirmations ?? '?'} blocks`
        : 'Waiting for XMR deposit…';
    return (
      <div className="top-up-flow top-up-flow--open">
        <div className="hedge-orch__spinner-row">
          <div className="swap-flow__spinner" style={{ margin: 0, width: 20, height: 20, borderWidth: 2 }} />
          <span>{label}</span>
        </div>
        {step === 'bridging' && (
          <div className="hedge-orch__progress">
            USDC will be deposited directly to your Lighter collateral (~30–60 min total).
          </div>
        )}
      </div>
    );
  }

  if (step === 'withdrawing') {
    return (
      <div className="top-up-flow top-up-flow--open">
        <div className="hedge-orch__spinner-row">
          <div className="swap-flow__spinner" style={{ margin: 0, width: 20, height: 20, borderWidth: 2 }} />
          <span>Withdrawing ${absDelta.toFixed(2)} USDC from Lighter…</span>
        </div>
      </div>
    );
  }

  if (step === 'complete') {
    const isWithdrawal = withdrawnUsdc > 0;
    const order = orderRef.current;
    const usdc = isWithdrawal
      ? withdrawnUsdc.toFixed(2)
      : atomicToUsdc(bridgeDetail?.expectedOutput ?? order?.expectedOutput ?? '0');
    return (
      <div className="top-up-flow top-up-flow--open">
        <div style={{ color: 'var(--color-green)', fontWeight: 600 }}>
          {isWithdrawal
            ? `Withdrawal of $${usdc} initiated — USDC will arrive on Ethereum in 1–4h`
            : `${usdc} USDC added to Lighter collateral`
          }
        </div>
        <button className="btn btn--ghost btn--sm" style={{ marginTop: 8 }} onClick={handleReset}>
          Done
        </button>
      </div>
    );
  }

  if (step === 'error') {
    return (
      <div className="top-up-flow top-up-flow--open">
        <div className="hedge-orch__error">{errorMsg ?? 'An unexpected error occurred.'}</div>
        <button className="btn btn--ghost btn--sm" style={{ marginTop: 8 }} onClick={handleReset}>
          Try again
        </button>
      </div>
    );
  }

  return null;
}
