import { useState, useEffect, useRef } from 'react';
import { useWalletStore } from '../../store/wallet';
import {
  getSwapQuote,
  createSwapOrder,
  getOrder,
  formatTokenAmount,
  groupByChain,
  tokenKey,
  findToken,
  SWAP_TOKENS,
  XMR_TOKEN,
  MONERO_CHAIN_ID,
  type SwapToken,
  type WagyuQuote,
  type WagyuOrderDetail,
} from '../../backend/wagyu';
import { transferXmr, formatXmr, createSubaddress } from '../../backend/lws';

// Default pair: BTC → XMR
const DEFAULT_FROM = SWAP_TOKENS.find((t) => t.symbol === 'BTC')!;
const DEFAULT_TO   = XMR_TOKEN;

export function SwapFlow() {
  const {
    xmrKeys,
    ethWallet,
    xmrInfo,
    walletCreatedHeight,
    receiveAddress,
    setReceiveAddress,
    swapStep,
    swapOrders,
    swapError,
    setSwapStep,
    setSwapOrders,
    setSwapError,
    clearSwap,
  } = useWalletStore();

  const [fromToken, setFromToken] = useState<SwapToken>(DEFAULT_FROM);
  const [toToken,   setToToken]   = useState<SwapToken>(DEFAULT_TO);
  const [fromAmount, setFromAmount] = useState('');
  const [destAddress, setDestAddress] = useState('');
  const [quote, setQuote] = useState<WagyuQuote | null>(null);
  const [orderDetails, setOrderDetails] = useState<WagyuOrderDetail[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Generate XMR receive address if needed (used as destination when to=XMR)
  useEffect(() => {
    if (toToken.chainId === MONERO_CHAIN_ID && xmrKeys && !receiveAddress) {
      createSubaddress(xmrKeys.primaryAddress, xmrKeys.viewKeyPrivate)
        .then(({ address, index }) => setReceiveAddress(address, index))
        .catch(() => { /* use primary address as fallback */ });
    }
  }, [toToken.chainId, xmrKeys, receiveAddress, setReceiveAddress]);

  // Stop polling on unmount
  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // Poll order status while monitoring
  useEffect(() => {
    if (swapStep !== 'monitoring' || swapOrders.length === 0) return;
    if (pollRef.current) clearInterval(pollRef.current);

    async function poll() {
      if (swapOrders.length === 0) return;
      try {
        const details = await Promise.all(swapOrders.map((o) => getOrder(o.orderId)));
        setOrderDetails(details);
        const allComplete = details.every((d) => d.status === 'complete');
        const anyTerminal = details.some(
          (d) => d.status === 'failed' || d.status === 'refunded' || d.status === 'expired'
        );
        if (allComplete) {
          setSwapStep('complete');
          if (pollRef.current) clearInterval(pollRef.current);
        } else if (anyTerminal) {
          const failed = details.find(
            (d) => d.status === 'failed' || d.status === 'refunded' || d.status === 'expired'
          );
          setSwapError(`Order ${failed?.status}: ${failed?.errorMessage ?? 'no details'}`);
          setSwapStep('error');
          if (pollRef.current) clearInterval(pollRef.current);
        }
      } catch { /* transient network error — keep polling */ }
    }

    poll();
    pollRef.current = setInterval(poll, 10_000);
  }, [swapStep, swapOrders, setSwapStep, setSwapError]);

  // ── Handlers ──────────────────────────────────────────────────────────────────

  function handleReverse() {
    const prev = fromToken;
    setFromToken(toToken);
    setToToken(prev);
    setFromAmount('');
    setDestAddress('');
    setQuote(null);
  }

  async function handleGetQuote() {
    if (!fromAmount) return;
    setIsLoading(true);
    setSwapError(null);
    setSwapStep('quoting');
    try {
      const q = await getSwapQuote(fromToken, toToken, fromAmount);
      setQuote(q);
      setSwapStep('confirm');
    } catch (err) {
      setSwapError(err instanceof Error ? err.message : 'Quote failed');
      setSwapStep('error');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleConfirm() {
    if (!quote || !xmrKeys) return;
    setIsLoading(true);
    setSwapStep('sending');
    try {
      const destination = toToken.symbol === 'XMR'
        ? (receiveAddress ?? xmrKeys.primaryAddress)
        : destAddress;

      const order = await createSwapOrder(fromToken, toToken, fromAmount, destination);
      setSwapOrders([order]);

      if (fromToken.symbol === 'XMR') {
        // App sends XMR from the wallet
        await transferXmr(
          xmrKeys.primaryAddress,
          xmrKeys.viewKeyPrivate,
          xmrKeys.spendKeyPrivate,
          order.depositAddress,
          order.depositAmount,
          walletCreatedHeight ?? undefined,
        );
      }
      // For non-XMR "from": order is created, deposit address shown in monitoring step
      setSwapStep('monitoring');
    } catch (err) {
      setSwapError(err instanceof Error ? err.message : 'Order failed');
      setSwapStep('error');
    } finally {
      setIsLoading(false);
    }
  }

  function handleReset() {
    clearSwap();
    setFromToken(DEFAULT_FROM);
    setToToken(DEFAULT_TO);
    setFromAmount('');
    setDestAddress('');
    setQuote(null);
    setOrderDetails([]);
    if (pollRef.current) clearInterval(pollRef.current);
  }

  // ── Guards ────────────────────────────────────────────────────────────────────

  if (!xmrKeys || !ethWallet) {
    return <div className="swap-flow swap-flow--locked">Wallet not unlocked.</div>;
  }

  // ── Validation ────────────────────────────────────────────────────────────────

  const spendable    = xmrInfo?.spendableBalance ?? 0n;
  const spendableXmr = formatXmr(spendable);

  // For XMR "from", validate against wallet balance
  const fromIsXmr = fromToken.chainId === MONERO_CHAIN_ID;
  const toIsXmr   = toToken.chainId   === MONERO_CHAIN_ID;

  let exceedsBalance = false;
  if (fromIsXmr && fromAmount) {
    try {
      const atomicIn = BigInt(
        fromAmount.includes('.')
          ? (() => {
              const [w, f = ''] = fromAmount.split('.');
              return (BigInt(w || '0') * 1_000_000_000_000n + BigInt(f.padEnd(12, '0').slice(0, 12))).toString();
            })()
          : (BigInt(fromAmount) * 1_000_000_000_000n).toString()
      );
      exceedsBalance = atomicIn > spendable && spendable > 0n;
    } catch { /* ignore */ }
  }

  const destMissing  = !toIsXmr && !destAddress.trim();
  const canGetQuote  = !!fromAmount && parseFloat(fromAmount) > 0 && !exceedsBalance && !destMissing && !isLoading;

  const xmrDestAddr  = receiveAddress ?? xmrKeys.primaryAddress;
  const order  = swapOrders[0] ?? null;
  const detail = orderDetails[0] ?? null;

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="swap-flow">

      {/* ── Step: idle / quoting — token pair + amount input ─────────────────── */}
      {(swapStep === 'idle' || swapStep === 'quoting') && (
        <div className="swap-flow__input">

          {/* From row */}
          <div className="swap-flow__pair-row">
            <div className="swap-flow__pair-label">You pay</div>
            <div className="swap-flow__pair-inputs">
              <select
                className="swap-flow__token-select"
                value={tokenKey(fromToken)}
                onChange={(e) => {
                  const t = findToken(e.target.value);
                  if (!t || tokenKey(t) === tokenKey(toToken)) return;
                  setFromToken(t);
                  setFromAmount('');
                  setQuote(null);
                }}
              >
                {groupByChain(SWAP_TOKENS.filter((t) => tokenKey(t) !== tokenKey(toToken))).map(({ chainName, tokens }) => (
                  <optgroup key={chainName} label={chainName}>
                    {tokens.map((t) => (
                      <option key={tokenKey(t)} value={tokenKey(t)}>{t.symbol} — {t.name}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <input
                type="number"
                className={`swap-flow__amount-input${exceedsBalance ? ' swap-flow__amount-input--error' : ''}`}
                placeholder="0.00"
                value={fromAmount}
                onChange={(e) => { setFromAmount(e.target.value); setQuote(null); }}
                min="0"
                disabled={isLoading}
              />
            </div>
            {fromIsXmr && (
              <div className="swap-flow__balance">
                {spendableXmr} XMR available
                {xmrInfo && xmrInfo.lockedFunds > 0n && (
                  <span className="swap-flow__locked"> · {formatXmr(xmrInfo.lockedFunds)} locked</span>
                )}
              </div>
            )}
            {exceedsBalance && (
              <p className="swap-flow__field-error">Exceeds spendable balance</p>
            )}
          </div>

          {/* Reverse button */}
          <button className="swap-flow__reverse-btn" onClick={handleReverse} title="Reverse pair">
            ⇅
          </button>

          {/* To row */}
          <div className="swap-flow__pair-row">
            <div className="swap-flow__pair-label">You receive</div>
            <div className="swap-flow__pair-inputs">
              <select
                className="swap-flow__token-select"
                value={tokenKey(toToken)}
                onChange={(e) => {
                  const t = findToken(e.target.value);
                  if (!t || tokenKey(t) === tokenKey(fromToken)) return;
                  setToToken(t);
                  setDestAddress('');
                  setQuote(null);
                }}
              >
                {groupByChain(SWAP_TOKENS.filter((t) => tokenKey(t) !== tokenKey(fromToken))).map(({ chainName, tokens }) => (
                  <optgroup key={chainName} label={chainName}>
                    {tokens.map((t) => (
                      <option key={tokenKey(t)} value={tokenKey(t)}>{t.symbol} — {t.name}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <div className="swap-flow__receive-amount">
                {quote ? formatTokenAmount(quote.toAmount, toToken) : '—'}
              </div>
            </div>
          </div>

          {/* Destination address */}
          <div className="swap-flow__destination">
            {toIsXmr ? (
              <>
                <span className="swap-flow__dest-label">XMR deposit address (your wallet)</span>
                <span className="swap-flow__dest-addr">
                  {xmrDestAddr.slice(0, 10)}…{xmrDestAddr.slice(-8)}
                </span>
              </>
            ) : (
              <>
                <label className="swap-flow__dest-label" htmlFor="dest-addr">
                  Destination {toToken.symbol} address
                </label>
                <input
                  id="dest-addr"
                  type="text"
                  className="swap-flow__dest-input"
                  placeholder={`Enter ${toToken.symbol} address`}
                  value={destAddress}
                  onChange={(e) => setDestAddress(e.target.value)}
                  disabled={isLoading}
                />
                {destMissing && fromAmount && (
                  <p className="swap-flow__field-error">Destination address required</p>
                )}
              </>
            )}
          </div>

          <button className="btn btn--primary" onClick={handleGetQuote} disabled={!canGetQuote}>
            {isLoading ? 'Getting quote…' : 'Get Quote'}
          </button>
        </div>
      )}

      {/* ── Step: confirm — show quote details ────────────────────────────────── */}
      {swapStep === 'confirm' && quote && (
        <div className="swap-flow__confirm">
          <h3 className="swap-flow__section-title">Confirm Swap</h3>

          <div className="quote-card">
            <div className="quote-row quote-row--highlight">
              <span>You send</span>
              <span className="quote-row__value">
                {fromAmount} {fromToken.symbol}
                {quote.fromAmountUsd && (
                  <span className="quote-row__usd"> (~${parseFloat(quote.fromAmountUsd).toFixed(2)})</span>
                )}
              </span>
            </div>
            <div className="quote-row quote-row--highlight">
              <span>You receive</span>
              <span className="quote-row__value">
                {formatTokenAmount(quote.toAmount, toToken)}
                {quote.toAmountUsd && (
                  <span className="quote-row__usd"> (~${parseFloat(quote.toAmountUsd).toFixed(2)})</span>
                )}
              </span>
            </div>

            <div className="quote-row quote-row--separator" />

            <div className="quote-row quote-row--muted">
              <span>Min. received</span>
              <span>{quote.minReceived} {toToken.symbol}</span>
            </div>
            <div className="quote-row quote-row--muted">
              <span>Rate</span>
              <span>
                {fromToken.symbol === 'XMR'
                  ? `1 XMR ≈ $${(parseFloat(quote.fromAmountUsd) / parseFloat(quote.fromAmount)).toFixed(2)}`
                  : `≈ $${(parseFloat(quote.toAmountUsd ?? '0') / (Number(quote.toAmount) / 10 ** toToken.decimals)).toFixed(2)} / ${toToken.symbol}`
                }
              </span>
            </div>
            <div className="quote-row quote-row--muted">
              <span>Est. time</span>
              <span>~30–60 min</span>
            </div>
            {fromToken.symbol === 'XMR' && (
              <div className="quote-row quote-row--muted">
                <span></span>
                <span className="quote-row__note">includes ~20 min Monero confirmations</span>
              </div>
            )}
            <div className="quote-row quote-row--muted">
              <span>Network fee</span>
              <span>~${quote.gasCostUsd}</span>
            </div>
            {quote.integratorFee?.willCollect && (
              <div className="quote-row quote-row--muted">
                <span>Integrator fee</span>
                <span>${quote.integratorFee.feeUsd}</span>
              </div>
            )}
          </div>

          <div className="swap-flow__dest-note">
            → {toIsXmr
              ? `${xmrDestAddr.slice(0, 10)}…${xmrDestAddr.slice(-8)} (your XMR wallet)`
              : `${destAddress.slice(0, 10)}…${destAddress.slice(-6)}`
            }
          </div>

          {!fromIsXmr && (
            <p className="swap-flow__sending-sub--note">
              After confirming, you'll receive a {fromToken.symbol} deposit address to send from your external wallet.
            </p>
          )}

          <div className="swap-flow__actions">
            <button className="btn btn--primary" onClick={handleConfirm} disabled={isLoading}>
              {isLoading ? (fromIsXmr ? 'Sending…' : 'Creating order…') : 'Confirm'}
            </button>
            <button className="btn btn--ghost" onClick={handleReset} disabled={isLoading}>Cancel</button>
          </div>
        </div>
      )}

      {/* ── Step: sending (XMR from wallet being broadcast) ───────────────────── */}
      {swapStep === 'sending' && (
        <div className="swap-flow__sending">
          <div className="swap-flow__spinner" />
          <p>{fromIsXmr ? 'Broadcasting transaction…' : 'Creating order…'}</p>
          {fromIsXmr && (
            <p className="swap-flow__sending-sub">Sending {fromAmount} XMR to bridge</p>
          )}
        </div>
      )}

      {/* ── Step: monitoring — bridge progress ────────────────────────────────── */}
      {swapStep === 'monitoring' && order && (
        <div className="swap-flow__monitoring">
          <h3 className="swap-flow__section-title">Swap in Progress</h3>

          {/* Non-XMR "from": show deposit address for user to send */}
          {!fromIsXmr && detail?.status === 'awaiting_deposit' && (
            <div className="swap-flow__deposit-box">
              <div className="swap-flow__deposit-label">Send exactly:</div>
              <div className="swap-flow__deposit-amount">
                {order.depositAmountFormatted} {fromToken.symbol}
              </div>
              <div className="swap-flow__deposit-label">To this {fromToken.symbol} address:</div>
              <div className="swap-flow__deposit-addr">{order.depositAddress}</div>
              <button
                className="btn btn--ghost swap-flow__copy-btn"
                onClick={() => navigator.clipboard.writeText(order.depositAddress)}
              >
                Copy address
              </button>
            </div>
          )}

          <div className="bridge-status">
            {fromToken.symbol !== 'XMR' && (
              <div className="bridge-status__step">
                <span className={`bridge-status__dot bridge-status__dot--${
                  detail?.status === 'awaiting_deposit' ? 'active' :
                  detail?.status ? 'done' : 'pending'
                }`} />
                <span>Awaiting {fromToken.symbol} deposit</span>
                {detail?.status === 'awaiting_deposit' && (
                  <span className="bridge-status__count">pending</span>
                )}
              </div>
            )}

            <div className="bridge-status__step">
              <span className={`bridge-status__dot bridge-status__dot--${
                detail?.status === 'confirming' ? 'active' :
                (detail?.status === 'swapping' || detail?.status === 'complete') ? 'done' :
                'pending'
              }`} />
              <span>{fromToken.symbol === 'XMR' ? 'Monero' : fromToken.symbol} confirmations</span>
              {detail && detail.requiredConfirmations > 0 && (
                <span className="bridge-status__count">
                  {detail.confirmations} / {detail.requiredConfirmations}
                </span>
              )}
            </div>

            {detail && detail.requiredConfirmations > 0 && (
              <div className="bridge-status__progress-bar">
                <div
                  className="bridge-status__progress-fill"
                  style={{
                    width: `${Math.min(100, (detail.confirmations / detail.requiredConfirmations) * 100)}%`,
                  }}
                />
              </div>
            )}

            <div className="bridge-status__step">
              <span className={`bridge-status__dot bridge-status__dot--${
                detail?.status === 'swapping' ? 'active' :
                detail?.status === 'complete' ? 'done' : 'pending'
              }`} />
              <span>{fromToken.symbol} → {toToken.symbol} swap</span>
              {detail?.status === 'complete' && (
                <span className="bridge-status__done-mark">✓</span>
              )}
            </div>

            {detail?.depositTxHash && (
              <div className="bridge-status__detail">
                <span className="bridge-status__label">{fromToken.symbol} TX</span>
                <span className="bridge-status__value bridge-status__value--mono">
                  {detail.depositTxHash.slice(0, 12)}…
                </span>
              </div>
            )}
          </div>

          <div className="bridge-status__order-id">Order: {order.orderId}</div>
        </div>
      )}

      {/* ── Step: complete ────────────────────────────────────────────────────── */}
      {swapStep === 'complete' && (
        <div className="swap-flow__complete">
          <div className="swap-flow__success-icon">✓</div>
          <h3>Swap Complete</h3>
          <p>
            Received{' '}
            <strong>
              {detail?.actualOutput
                ? formatTokenAmount(detail.actualOutput, toToken)
                : order
                  ? formatTokenAmount(order.expectedOutput, toToken)
                  : ''}
            </strong>
          </p>
          {toIsXmr ? (
            <p className="swap-flow__complete-dest">
              → {xmrDestAddr.slice(0, 10)}…{xmrDestAddr.slice(-8)} (your wallet)
            </p>
          ) : (
            <p className="swap-flow__complete-dest">
              → {destAddress.slice(0, 10)}…{destAddress.slice(-6)}
            </p>
          )}
          <button className="btn btn--primary" onClick={handleReset}>Done</button>
        </div>
      )}

      {/* ── Step: error ───────────────────────────────────────────────────────── */}
      {swapStep === 'error' && (
        <div className="swap-flow__error">
          <p className="swap-flow__error-msg">{swapError ?? 'An error occurred'}</p>
          <button className="btn btn--ghost" onClick={handleReset}>Try Again</button>
        </div>
      )}
    </div>
  );
}
