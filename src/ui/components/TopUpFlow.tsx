/**
 * TopUpFlow — swap XMR → USDC and deposit directly to Lighter as additional margin.
 *
 * Displayed on the HedgeScreen when the user already has a hedged position.
 * Uses the same wagyu bridge + Lighter intent address pipeline as HedgeOrchestrator
 * but skips account setup and position-opening — the USDC lands at the intent address
 * and Lighter automatically credits it as collateral on the existing account.
 */
import { useState, useEffect, useRef } from 'react';
import { useWalletStore } from '../../store/wallet';
import { getDepositIntentAddress } from '../../backend/deposit';
import {
  getQuote,
  createOrder,
  getOrder,
  atomicToUsdc,
  MIN_SWAP_XMR,
} from '../../backend/wagyu';
import type { WagyuQuote, WagyuOrder, WagyuOrderDetail } from '../../backend/wagyu';
import { transferXmr, formatXmr } from '../../backend/lws';

type Step =
  | 'idle' | 'form' | 'confirming'
  | 'creating_order' | 'sending_xmr' | 'bridging'
  | 'complete' | 'error';

interface TopUpFlowProps {
  onTopUpComplete: () => void;
}

export function TopUpFlow({ onTopUpComplete }: TopUpFlowProps) {
  const { xmrKeys, ethWallet, xmrInfo, walletCreatedHeight } = useWalletStore();

  const [step, setStep]             = useState<Step>('idle');
  const [pct, setPct]               = useState(10);
  const [quote, setQuote]           = useState<WagyuQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteErr, setQuoteErr]     = useState<string | null>(null);
  const [bridgeDetail, setBridgeDetail] = useState<WagyuOrderDetail | null>(null);
  const [errorMsg, setErrorMsg]     = useState<string | null>(null);

  const pollRef       = useRef<ReturnType<typeof setInterval> | null>(null);
  const quoteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const orderRef      = useRef<WagyuOrder | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current)       clearInterval(pollRef.current);
      if (quoteTimerRef.current) clearTimeout(quoteTimerRef.current);
    };
  }, []);

  // Floor to 6 d.p. so amount never exceeds spendable
  const maxXmr    = xmrInfo ? Math.floor(Number(xmrInfo.spendableBalance) / 1e6) / 1e6 : 0;
  const xmrAmount = maxXmr > 0 ? Math.floor(maxXmr * pct / 100 * 1e6) / 1e6 : 0;
  const spendableXmr = xmrInfo ? formatXmr(xmrInfo.spendableBalance) : '0';

  // ── Quote (debounced) ────────────────────────────────────────────────────────

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
        const q = await getQuote(xmr.toFixed(6));
        setQuote(q);
        setQuoteErr(null);
      } catch (err) {
        setQuoteErr(err instanceof Error ? err.message : 'Quote unavailable');
      } finally {
        setQuoteLoading(false);
      }
    }, 500);
  }

  function handlePctChange(val: number) {
    setPct(val);
    fetchQuote(maxXmr > 0 ? Math.floor(maxXmr * val / 100 * 1e6) / 1e6 : 0);
  }

  function handleExpand() {
    setPct(10);
    setStep('form');
    fetchQuote(maxXmr > 0 ? Math.floor(maxXmr * 10 / 100 * 1e6) / 1e6 : 0);
  }

  // ── Confirm → bridge ─────────────────────────────────────────────────────────

  async function handleConfirm() {
    if (!ethWallet || !xmrKeys) return;
    setStep('creating_order');
    try {
      const intentResult = await getDepositIntentAddress(ethWallet.address, 42161);
      const order = await createOrder(xmrAmount.toFixed(6), intentResult.intent_address);
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
      startBridgePolling(order.orderId);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Transaction failed');
      setStep('error');
    }
  }

  // ── Bridge polling ───────────────────────────────────────────────────────────

  function startBridgePolling(orderId: string) {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const detail = await getOrder(orderId);
        setBridgeDetail(detail);
        if (detail.status === 'complete') {
          clearInterval(pollRef.current!);
          pollRef.current = null;
          setStep('complete');
          onTopUpComplete();
        } else if (['failed', 'refunded', 'expired'].includes(detail.status)) {
          clearInterval(pollRef.current!);
          pollRef.current = null;
          setErrorMsg(`Bridge ${detail.status}${detail.errorMessage ? `: ${detail.errorMessage}` : ''}`);
          setStep('error');
        }
      } catch { /* transient — keep polling */ }
    }, 10_000);
  }

  function handleReset() {
    if (pollRef.current) clearInterval(pollRef.current);
    orderRef.current = null;
    setBridgeDetail(null);
    setErrorMsg(null);
    setPct(10);
    setQuote(null);
    setStep('idle');
  }

  const amountValid = maxXmr > 0 && xmrAmount >= parseFloat(MIN_SWAP_XMR);

  // ── Render ───────────────────────────────────────────────────────────────────

  if (step === 'idle') {
    return (
      <div className="top-up-flow">
        <button className="btn btn--ghost btn--sm top-up-flow__trigger" onClick={handleExpand}>
          + Add margin to Lighter
        </button>
      </div>
    );
  }

  if (step === 'form') {
    return (
      <div className="top-up-flow top-up-flow--open">
        <div className="top-up-flow__header">
          <span className="top-up-flow__title">Add margin</span>
          <button className="top-up-flow__close" onClick={handleReset}>✕</button>
        </div>
        <div className="top-up-flow__hint">
          Swap XMR → USDC and deposit directly to Lighter as additional collateral.
        </div>
        <div className="top-up-flow__balance">{spendableXmr} XMR available</div>

        <div className="hedge-orch__slider-row">
          <input
            className="hedge-orch__slider"
            type="range"
            min={1} max={100} step={1}
            value={pct}
            onChange={(e) => handlePctChange(Number(e.target.value))}
          />
          <input
            className="hedge-orch__amount-input"
            type="number"
            min={1} max={100} step={1}
            value={pct}
            onChange={(e) => handlePctChange(Math.min(100, Math.max(1, Number(e.target.value))))}
          />
          <span style={{ color: 'var(--color-text-muted)', fontWeight: 600 }}>%</span>
        </div>

        {maxXmr > 0 && (
          <div className="hedge-orch__quote">
            {xmrAmount.toFixed(4)} XMR
            {xmrAmount < parseFloat(MIN_SWAP_XMR)
              ? <span className="top-up-flow__quote-warn"> — min swap ~{MIN_SWAP_XMR} XMR</span>
              : quoteErr
              ? <span className="top-up-flow__quote-err"> — {quoteErr}</span>
              : quoteLoading
              ? <> — fetching quote…</>
              : quote
              ? <> → <strong>{quote.minReceived} USDC</strong> min to Lighter</>
              : null}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button
            className="btn btn--primary btn--sm"
            onClick={() => setStep('confirming')}
            disabled={!amountValid}
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
    return (
      <div className="top-up-flow top-up-flow--open">
        <div className="top-up-flow__header">
          <span className="top-up-flow__title">Confirm top-up</span>
        </div>
        <div className="hedge-orch__review">
          <div className="hedge-orch__review-row">
            <span>You send</span>
            <span>{pct}% ({xmrAmount.toFixed(4)} XMR)</span>
          </div>
          <div className="hedge-orch__review-row">
            <span>Min USDC received</span>
            <span>{quote ? `${quote.minReceived} USDC` : '—'}</span>
          </div>
          <div className="hedge-orch__review-row">
            <span>Destination</span>
            <span>Lighter collateral (Arbitrum)</span>
          </div>
          <div className="hedge-orch__review-row">
            <span>Bridge</span>
            <span>wagyu.xyz</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn btn--primary btn--sm" onClick={handleConfirm}>
            Confirm &amp; send
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
      step === 'sending_xmr'    ? `Sending ${xmrAmount.toFixed(4)} XMR…` :
      bridgeDetail
        ? `XMR confirming: ${bridgeDetail.confirmations}/${bridgeDetail.requiredConfirmations} blocks`
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

  if (step === 'complete') {
    const order  = orderRef.current;
    const usdc   = atomicToUsdc(bridgeDetail?.actualOutput ?? order?.expectedOutput ?? '0');
    return (
      <div className="top-up-flow top-up-flow--open">
        <div style={{ color: 'var(--color-green)', fontWeight: 600 }}>
          ✓ {usdc} USDC added to Lighter collateral
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
