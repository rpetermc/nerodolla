/**
 * UnhedgeOrchestrator — close hedge and convert USDC back to XMR
 *
 * Flow:
 *   idle → quoting → confirming → closing → awaiting_usdc
 *        → swapping → bridging → complete | error
 *
 * State is persisted to localStorage so the flow survives PIN timeouts / app
 * backgrounding. On remount after PIN re-entry, polling resumes automatically.
 */
import { useState, useRef, useEffect } from 'react';
import { useWalletStore } from '../../store/wallet';
import { closeHedgeAndWithdraw, withdrawUsdc, relayUsdcTransfer, getRelayTaskStatus, stopBot, fetchEthUsdcBalanceProxy } from '../../backend/lighter';
import { getReverseQuote, createReverseOrder, getOrder } from '../../backend/wagyu';
import type { WagyuQuote, WagyuOrderDetail } from '../../backend/wagyu';
import { signTransferAuthorization } from '../../wallet/eth';
import { createSubaddress } from '../../backend/lws';

type UnhedgeStep =
  | 'idle' | 'quoting' | 'confirming'
  | 'closing' | 'retrying_withdraw' | 'awaiting_usdc'
  | 'swapping' | 'bridging'
  | 'complete' | 'error';

/** Persisted across PIN timeouts / app restarts */
interface UnhedgePersist {
  step: 'awaiting_usdc' | 'swapping' | 'bridging';
  xmrAddr: string;
  balanceBefore: number;
  // wagyu order details — only set once USDC lands on ETH mainnet
  wagOrderId?: string;
  wagDepositAddr?: string;
  relayTaskId?: string;
  relayChain?: 'arbitrum' | 'ethereum'; // which chain the relay tx is on
  withdrawInitiatedAt?: number; // unix ms — when the Lighter withdrawal was first sent
}

const PERSIST_KEY = 'nerodolla_unhedge';

/** Returns true if a previous unhedge flow is still in progress (survives across renders). */
export function hasUnhedgeInProgress(): boolean {
  return !!localStorage.getItem(PERSIST_KEY);
}

function loadPersist(): UnhedgePersist | null {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function savePersist(s: UnhedgePersist) {
  localStorage.setItem(PERSIST_KEY, JSON.stringify(s));
}
function clearPersist() {
  localStorage.removeItem(PERSIST_KEY);
}

interface UnhedgeOrchestratorProps {
  onUnhedged: () => void;
  /** Recovery mode: position already closed, USDC still in Lighter. Skip close step. */
  recoveryMode?: boolean;
  /** How much USDC is in Lighter (used when recoveryMode=true and hedgeStatus is stale/empty). */
  availableUsdc?: number;
  /**
   * ETH mainnet recovery: position closed, Lighter withdrawal done, USDC already on
   * Ethereum mainnet. Skip close+withdraw entirely — just relay to wagyu directly.
   * Value is the ETH mainnet USDC balance in USD (used for quoting).
   */
  ethUsdcRecovery?: number;
  /** Called when "Start fresh" detects ETH USDC via proxy — passes amount to parent. */
  onForceEthRecovery?: (amount: number) => void;
}

export function UnhedgeOrchestrator({ onUnhedged, recoveryMode, availableUsdc, ethUsdcRecovery, onForceEthRecovery }: UnhedgeOrchestratorProps) {
  const { ethWallet, xmrKeys, hedgeStatus } = useWalletStore();

  const [step, setStep]                 = useState<UnhedgeStep>('idle');
  const [quote, setQuote]               = useState<WagyuQuote | null>(null);
  const [bridgeDetail, setBridgeDetail] = useState<WagyuOrderDetail | null>(null);
  const [errorMsg, setErrorMsg]         = useState<string | null>(null);
  const [elapsedMin, setElapsedMin]     = useState(0);

  const pollRef        = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickerRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const withdrawAtRef  = useRef<number>(0); // ms timestamp when withdrawal was initiated
  const xmrAddrRef     = useRef<string | null>(null);
  const wagOrderRef    = useRef<string | null>(null);
  const wagDepRef      = useRef<string | null>(null);

  // Cleanup on unmount
  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (tickerRef.current) clearInterval(tickerRef.current);
  }, []);

  function startElapsedTicker(initiatedAt: number) {
    if (tickerRef.current) clearInterval(tickerRef.current);
    const update = () => setElapsedMin(Math.floor((Date.now() - initiatedAt) / 60_000));
    update();
    tickerRef.current = setInterval(update, 60_000);
  }

  // Resume in-progress unhedge after PIN re-entry
  useEffect(() => {
    if (!ethWallet) return;
    const saved = loadPersist();
    if (!saved) return;

    wagOrderRef.current = saved.wagOrderId ?? null;
    wagDepRef.current   = saved.wagDepositAddr ?? null;
    xmrAddrRef.current  = saved.xmrAddr;
    setStep(saved.step);

    if (saved.step === 'awaiting_usdc') {
      const initiatedAt = saved.withdrawInitiatedAt ?? Date.now();
      withdrawAtRef.current = initiatedAt;
      startElapsedTicker(initiatedAt);
      startUsdcPolling(saved.balanceBefore, saved.xmrAddr);
    } else if (saved.step === 'swapping') {
      if (saved.relayTaskId) {
        // Relay was submitted — poll the tx
        pollRelayTask(saved.relayTaskId, saved.wagOrderId!, saved.relayChain ?? 'ethereum');
      } else if (saved.wagDepositAddr && saved.wagOrderId) {
        // App locked between wagyu order creation and relay submission.
        // wagyu order was just created so it's still within the 30min window.
        fetchEthUsdcBalanceProxy(ethWallet.address).then(balance => {
          if (balance > 0.01) {
            // USDC still there — re-sign and relay to the existing order
            const valueMicro = BigInt(Math.floor(balance * 1e6));
            signAndRelay(saved.wagDepositAddr!, valueMicro, saved.wagOrderId!);
          } else {
            // USDC already sent — assume relay succeeded, jump to bridge polling
            setStep('bridging');
            savePersist({ ...saved, step: 'bridging' });
            startBridgePolling(saved.wagOrderId!);
          }
        }).catch(() => {
          // Can't determine — restart polling (will create a fresh wagyu order on arrival)
          startUsdcPolling(0, saved.xmrAddr);
        });
      } else {
        // No wagyu order yet — restart polling
        startUsdcPolling(0, saved.xmrAddr);
      }
    } else if (saved.step === 'bridging') {
      startBridgePolling(saved.wagOrderId!);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ethWallet?.address]);

  // ── USDC amount — prefer prop in recovery modes (hedgeStatus may be stale/empty) ──
  const usdcCollateral = ethUsdcRecovery != null
    ? ethUsdcRecovery
    : recoveryMode
      ? (availableUsdc ?? hedgeStatus?.lighterUsdc ?? 0)
      : (hedgeStatus?.lighterUsdc ?? 0);
  const usdcMicro = BigInt(Math.floor(usdcCollateral * 1e6));

  // ── Step: idle → quoting → confirming ───────────────────────────────────────

  async function startQuote() {
    if (!recoveryMode && ethUsdcRecovery == null && !hedgeStatus?.isHedged) return;
    setStep('quoting');
    try {
      const q = await getReverseQuote(usdcMicro.toString());
      setQuote(q);
      setStep('confirming');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Quote failed');
      setStep('error');
    }
  }

  // ── Step: confirming → closing → awaiting_usdc ───────────────────────────────

  async function handleConfirm() {
    if (!ethWallet || !xmrKeys) return;
    setStep('closing');
    try {
      // 1. Create fresh XMR receive subaddress
      const { address: xmrAddr } = await createSubaddress(
        xmrKeys.primaryAddress, xmrKeys.viewKeyPrivate,
      );
      xmrAddrRef.current = xmrAddr;

      if (ethUsdcRecovery != null) {
        // 2a. ETH mainnet recovery: USDC already on Ethereum mainnet — create wagyu order
        // and relay immediately. Use ethUsdcRecovery prop directly (already fetched via proxy).
        const valueMicro = BigInt(Math.floor(ethUsdcRecovery * 1e6));
        const order = await createReverseOrder(valueMicro.toString(), xmrAddr);
        wagOrderRef.current = order.orderId;
        wagDepRef.current   = order.depositAddress;
        savePersist({
          step: 'swapping',
          xmrAddr,
          balanceBefore: ethUsdcRecovery,
          wagOrderId:     order.orderId,
          wagDepositAddr: order.depositAddress,
        });
        await signAndRelay(order.depositAddress, valueMicro, order.orderId);
      } else if (recoveryMode) {
        // 2b. Position already closed — just withdraw whatever is left in Lighter.
        // Wagyu order created later, when USDC actually lands on ETH mainnet.
        const withdrawResult = await withdrawUsdc();
        if (!withdrawResult.success) throw new Error(withdrawResult.error ?? 'Withdrawal failed');

        const balanceBefore = await fetchEthUsdcBalanceProxy(ethWallet.address).catch(() => 0);
        const now = Date.now();
        withdrawAtRef.current = now;
        startElapsedTicker(now);
        savePersist({ step: 'awaiting_usdc', xmrAddr, balanceBefore, withdrawInitiatedAt: now });
        setStep('awaiting_usdc');
        startUsdcPolling(balanceBefore, xmrAddr);
      } else {
        // 2c. Normal flow — stop bot, close short + initiate Lighter withdrawal.
        // Wagyu order created later, when USDC actually lands on ETH mainnet (avoids
        // the wagyu 30-min deposit window expiring during the 1–4h Lighter withdrawal).
        await stopBot().catch(() => {});
        const closeResult = await closeHedgeAndWithdraw();
        if (!closeResult.success) throw new Error(closeResult.error ?? 'Close failed');

        const balanceBefore = await fetchEthUsdcBalanceProxy(ethWallet.address).catch(() => 0);
        const now = Date.now();
        withdrawAtRef.current = now;
        startElapsedTicker(now);
        savePersist({ step: 'awaiting_usdc', xmrAddr, balanceBefore, withdrawInitiatedAt: now });
        setStep('awaiting_usdc');
        startUsdcPolling(balanceBefore, xmrAddr);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Close failed');
      setStep('error');
    }
  }

  // ── Retry standalone withdrawal (position already closed) ────────────────────

  /**
   * Resume waiting for USDC to arrive on Ethereum mainnet.
   * Tries to re-initiate the Lighter withdrawal first; if that fails (e.g. one
   * is already in flight), silently ignores the error and just restarts polling.
   */
  async function retryWithdraw() {
    const saved = loadPersist();
    if (!saved) return;
    setStep('retrying_withdraw');
    try {
      // Attempt to (re-)initiate withdrawal — ignore errors; withdrawal may already be in flight.
      await withdrawUsdc().catch(() => {});
      const balanceBefore = await fetchEthUsdcBalanceProxy(ethWallet!.address).catch(() => 0);
      // Preserve original withdrawInitiatedAt so elapsed time counts from the real start
      const initiatedAt = saved.withdrawInitiatedAt ?? Date.now();
      withdrawAtRef.current = initiatedAt;
      startElapsedTicker(initiatedAt);
      savePersist({ ...saved, step: 'awaiting_usdc', balanceBefore, withdrawInitiatedAt: initiatedAt });
      setStep('awaiting_usdc');
      startUsdcPolling(balanceBefore, saved.xmrAddr);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Resume failed');
      setStep('error');
    }
  }

  // ── Poll Ethereum mainnet USDC balance until it increases ────────────────────

  function startUsdcPolling(balanceBefore: number, xmrAddr: string) {
    if (!ethWallet) return;
    const MAX_POLLS = 1440; // 4h @ 10s — Lighter ZK withdrawals can take up to 4h
    let polls = 0;
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      polls++;
      if (polls > MAX_POLLS) {
        clearInterval(pollRef.current!);
        setErrorMsg('USDC did not arrive within 4 hours — check your Lighter account and try again');
        setStep('error');
        return;
      }
      try {
        const balance = await fetchEthUsdcBalanceProxy(ethWallet!.address);
        if (balance > balanceBefore + 0.01) {
          clearInterval(pollRef.current!);
          pollRef.current = null;
          // Create wagyu order now — fresh 30-min window, rate reflects current market
          const valueMicro = BigInt(Math.floor(balance * 1e6));
          const order = await createReverseOrder(valueMicro.toString(), xmrAddr);
          wagOrderRef.current = order.orderId;
          wagDepRef.current   = order.depositAddress;
          // Persist wagyu details so resume works if app locks between here and relay
          const saved = loadPersist();
          if (saved) savePersist({ ...saved, wagOrderId: order.orderId, wagDepositAddr: order.depositAddress });
          await signAndRelay(order.depositAddress, valueMicro, order.orderId);
        }
      } catch (e) {
        console.warn('startUsdcPolling: fetch error', e instanceof Error ? e.message : e);
      }
    }, 10_000);
  }

  // ── Sign EIP-3009 + relay via proxy wallet ───────────────────────────────────

  async function signAndRelay(depositAddr: string, valueMicro: bigint, orderId: string) {
    if (!ethWallet) return;
    setStep('swapping');
    // Update persist: we're now in swapping but don't have a relay task ID yet
    const existing = loadPersist();
    if (existing) savePersist({ ...existing, step: 'swapping' });
    try {
      // Lighter withdrawals land on Ethereum mainnet — sign and relay on mainnet
      const auth = await signTransferAuthorization(ethWallet, depositAddr, valueMicro, 'ethereum');
      const taskId = await relayUsdcTransfer(auth, 'ethereum');

      // Persist the relay task ID so we can resume if app locks between here and confirmation
      const saved = loadPersist();
      if (saved) savePersist({ ...saved, step: 'swapping', relayTaskId: taskId, relayChain: 'ethereum' });

      await pollRelayTask(taskId, orderId, 'ethereum');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Relay failed');
      setStep('error');
    }
  }

  // ── Poll relay tx until confirmed ────────────────────────────────────────────

  async function pollRelayTask(taskId: string, orderId: string, chain: 'arbitrum' | 'ethereum' = 'ethereum') {
    const MAX_POLLS = 60; // 5 min @ 5s
    let polls = 0;
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      polls++;
      if (polls > MAX_POLLS) {
        clearInterval(pollRef.current!);
        setErrorMsg('Relay timed out — USDC may still arrive; check wagyu.xyz');
        setStep('error');
        return;
      }
      try {
        const status = await getRelayTaskStatus(taskId, chain);
        if (status.taskState === 'ExecSuccess') {
          clearInterval(pollRef.current!);
          pollRef.current = null;
          const saved = loadPersist();
          if (saved) savePersist({ ...saved, step: 'bridging' });
          setStep('bridging');
          startBridgePolling(orderId);
        } else if (status.taskState === 'ExecReverted' || status.taskState === 'Cancelled') {
          clearInterval(pollRef.current!);
          setErrorMsg(`Relay failed (${status.taskState}): ${status.error ?? ''}`);
          setStep('error');
        }
      } catch { /* keep polling */ }
    }, 5_000);
  }

  // ── Poll wagyu order until XMR delivered ─────────────────────────────────────

  function startBridgePolling(orderId: string) {
    const MAX_POLLS = 120; // 20 min @ 10s
    let polls = 0;
    if (pollRef.current) clearInterval(pollRef.current);

    const tick = async () => {
      polls++;
      if (polls > MAX_POLLS) {
        if (pollRef.current) clearInterval(pollRef.current);
        setErrorMsg('wagyu bridge timed out — XMR may still arrive; check wagyu.xyz');
        setStep('error');
        return;
      }
      try {
        const detail = await getOrder(orderId);
        setBridgeDetail(detail);
        if (detail.status === 'complete') {
          if (pollRef.current) clearInterval(pollRef.current);
          clearPersist();
          setStep('complete');
          // Don't call onUnhedged() here — let the Done button do it to avoid
          // a parent re-render racing with the complete step becoming visible.
        } else if (['failed', 'refunded', 'expired'].includes(detail.status)) {
          if (pollRef.current) clearInterval(pollRef.current);
          clearPersist();
          setErrorMsg(`Bridge ${detail.status}${detail.errorMessage ? `: ${detail.errorMessage}` : ''}`);
          setStep('error');
        }
      } catch (e) {
        // Keep polling, but surface repeated failures after 5 consecutive errors
        const err = e instanceof Error ? e.message : String(e);
        console.warn('startBridgePolling: getOrder error', err);
      }
    };

    // Fire immediately so resume after app-kill shows completion without a 10s wait,
    // then continue polling every 10s until complete/terminal.
    tick();
    pollRef.current = setInterval(tick, 10_000);
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  if (step === 'idle') {
    if (ethUsdcRecovery != null) {
      return (
        <div className="hedge-orch">
          <div className="hedge-orch__error" style={{ background: 'rgba(255,170,0,0.1)', borderColor: 'var(--color-orange, #f90)', color: 'var(--color-text)' }}>
            ${usdcCollateral.toFixed(2)} USDC is on Ethereum mainnet waiting to be swapped to XMR.
          </div>
          <button className="btn btn--secondary hedge-orch__cta" style={{ marginTop: 8 }} onClick={startQuote}>
            Swap ${usdcCollateral.toFixed(2)} USDC → XMR
          </button>
        </div>
      );
    }
    return recoveryMode ? (
      <div className="hedge-orch">
        <div className="hedge-orch__error" style={{ background: 'rgba(255,170,0,0.1)', borderColor: 'var(--color-orange, #f90)', color: 'var(--color-text)' }}>
          Position closed but ${usdcCollateral.toFixed(2)} USDC is still in Lighter. Withdraw and swap back to XMR.
        </div>
        <button className="btn btn--secondary hedge-orch__cta" style={{ marginTop: 8 }} onClick={startQuote}>
          Recover ${usdcCollateral.toFixed(2)} USDC → XMR
        </button>
      </div>
    ) : (
      <button className="btn btn--danger hedge-orch__cta" onClick={startQuote}>
        Unhedge — convert USDC back to XMR
      </button>
    );
  }

  if (step === 'quoting') {
    return (
      <div className="hedge-orch__spinner-row">
        <div className="swap-flow__spinner" style={{ margin: 0, width: 20, height: 20, borderWidth: 2 }} />
        <span>Fetching swap quote…</span>
      </div>
    );
  }

  if (step === 'confirming') {
    const xmrOut = quote ? parseFloat(quote.minReceived).toFixed(4) : '—';
    return (
      <div className="hedge-orch">
        <div className="hedge-orch__review">
          {!recoveryMode && ethUsdcRecovery == null && (
            <div className="hedge-orch__review-row">
              <span>Close position</span>
              <span>{hedgeStatus?.position?.size.toFixed(4) ?? '—'} XMR short</span>
            </div>
          )}
          {ethUsdcRecovery == null && (
            <div className="hedge-orch__review-row">
              <span>Withdraw USDC</span>
              <span>${usdcCollateral.toFixed(2)}</span>
            </div>
          )}
          {ethUsdcRecovery != null && (
            <div className="hedge-orch__review-row">
              <span>USDC on Ethereum</span>
              <span>${usdcCollateral.toFixed(2)}</span>
            </div>
          )}
          <div className="hedge-orch__review-row">
            <span>You receive (approx)</span>
            <span style={{ color: 'var(--color-green)' }}>~{xmrOut} XMR</span>
          </div>
          <div className="hedge-orch__review-row">
            <span>Bridge</span>
            <span>wagyu.xyz (USDC → XMR)</span>
          </div>
        </div>
        <p className="hedge-orch__progress">
          {ethUsdcRecovery != null
            ? 'USDC will be relayed from Ethereum mainnet to wagyu and swapped to XMR. No ETH gas required — the proxy wallet pays gas on your behalf.'
            : recoveryMode
              ? 'USDC will be withdrawn from Lighter, then swapped to XMR via wagyu. No ETH gas required.'
              : 'USDC will be withdrawn from Lighter (1–4h), then swapped to XMR via wagyu. The swap rate is locked when USDC arrives. No ETH gas required — the proxy wallet pays Ethereum mainnet gas on your behalf.'}
        </p>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn btn--danger" onClick={handleConfirm}>
            {ethUsdcRecovery != null ? 'Confirm swap' : recoveryMode ? 'Confirm recovery' : 'Confirm unhedge'}
          </button>
          <button className="btn btn--ghost" onClick={() => setStep('idle')}>Cancel</button>
        </div>
      </div>
    );
  }

  if (step === 'closing') {
    const closingMsg = ethUsdcRecovery != null
      ? 'Preparing swap…'
      : recoveryMode
        ? 'Initiating USDC withdrawal…'
        : 'Closing position & initiating withdrawal…';
    return (
      <div className="hedge-orch__spinner-row">
        <div className="swap-flow__spinner" style={{ margin: 0, width: 20, height: 20, borderWidth: 2 }} />
        <span>{closingMsg}</span>
      </div>
    );
  }

  if (step === 'retrying_withdraw') {
    return (
      <div className="hedge-orch__spinner-row">
        <div className="swap-flow__spinner" style={{ margin: 0, width: 20, height: 20, borderWidth: 2 }} />
        <span>Retrying USDC withdrawal from Lighter…</span>
      </div>
    );
  }

  if (step === 'awaiting_usdc') {
    const elapsedLabel = elapsedMin < 60
      ? `${elapsedMin} min elapsed`
      : `${Math.floor(elapsedMin / 60)}h ${elapsedMin % 60}m elapsed`;
    return (
      <div className="hedge-orch">
        <div className="hedge-orch__spinner-row">
          <div className="swap-flow__spinner" style={{ margin: 0, width: 20, height: 20, borderWidth: 2 }} />
          <span>Waiting for USDC to arrive on Ethereum mainnet…</span>
        </div>
        {elapsedMin > 0 && (
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--color-muted, #888)' }}>
            {elapsedLabel} · polling every 10s
          </p>
        )}
        <p className="hedge-orch__progress">
          Lighter ZK withdrawal typically takes 1–4h.
          You can close the app — progress will resume when you return.
        </p>
        {ethWallet && (
          <a
            href={`https://etherscan.io/address/${ethWallet.address}#tokentxns`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 13, marginTop: 4, display: 'inline-block' }}
          >
            Check receiving address on Etherscan
          </a>
        )}
        <button
          className="btn btn--ghost"
          style={{ marginTop: 8, fontSize: 13 }}
          onClick={retryWithdraw}
        >
          Resume waiting
        </button>
        <button
          className="btn btn--ghost"
          style={{ marginTop: 8, fontSize: 12, opacity: 0.6 }}
          onClick={async () => {
            if (pollRef.current) clearInterval(pollRef.current);
            try {
              const balance = await fetchEthUsdcBalanceProxy(ethWallet!.address);
              if (balance > 0.01) {
                // USDC landed — use force recovery path with a fresh wagyu order
                clearPersist();
                if (onForceEthRecovery) onForceEthRecovery(balance);
                else onUnhedged();
                return;
              }
            } catch { /* ignore */ }
            // USDC not yet arrived. If a withdrawal is in transit, keep waiting
            // rather than dumping the user on a confusing empty screen.
            const saved = loadPersist();
            if (saved?.withdrawInitiatedAt) {
              // Reset any stale wagyu order details and resume polling
              wagOrderRef.current = null;
              wagDepRef.current   = null;
              savePersist({ ...saved, wagOrderId: undefined, wagDepositAddr: undefined });
              startUsdcPolling(saved.balanceBefore, saved.xmrAddr);
              // Stay in awaiting_usdc — nothing to do
            } else {
              clearPersist();
              onUnhedged();
            }
          }}
        >
          USDC already arrived? Start fresh
        </button>
      </div>
    );
  }

  if (step === 'swapping') {
    return (
      <div className="hedge-orch__spinner-row">
        <div className="swap-flow__spinner" style={{ margin: 0, width: 20, height: 20, borderWidth: 2 }} />
        <span>Sending USDC to wagyu…</span>
      </div>
    );
  }

  if (step === 'bridging') {
    let label = 'Swapping USDC → XMR via wagyu…';
    if (bridgeDetail?.status === 'confirming') {
      label = `Confirming: ${bridgeDetail.confirmations}/${bridgeDetail.requiredConfirmations}`;
    }
    return (
      <div className="hedge-orch">
        <div className="hedge-orch__spinner-row">
          <div className="swap-flow__spinner" style={{ margin: 0, width: 20, height: 20, borderWidth: 2 }} />
          <span>{label}</span>
        </div>
        <p className="hedge-orch__progress">
          You can close the app — progress will resume when you return.
        </p>
        <button
          className="btn btn--ghost"
          style={{ marginTop: 8, fontSize: 12, opacity: 0.6 }}
          onClick={() => {
            if (pollRef.current) clearInterval(pollRef.current);
            clearPersist();
            setStep('idle');
            setErrorMsg(null);
            onUnhedged();
          }}
        >
          XMR received? Dismiss
        </button>
      </div>
    );
  }

  if (step === 'complete') {
    return (
      <div className="hedge-orch">
        <div style={{ color: 'var(--color-green)', fontWeight: 600, fontSize: 15 }}>
          ✓ Unhedge complete — XMR on its way to your wallet
        </div>
        <button
          className="btn btn--ghost hedge-orch__cta"
          style={{ marginTop: 10, fontSize: 13 }}
          onClick={onUnhedged}
        >
          Done
        </button>
      </div>
    );
  }

  // error
  const persistedState = loadPersist();
  const canRetryWithdraw = !!persistedState && persistedState.step === 'awaiting_usdc';
  return (
    <div className="hedge-orch">
      <div className="hedge-orch__error">{errorMsg ?? 'An unexpected error occurred.'}</div>
      {canRetryWithdraw && (
        <button
          className="btn btn--secondary hedge-orch__cta"
          onClick={() => { setErrorMsg(null); retryWithdraw(); }}
        >
          Resume — keep waiting for USDC
        </button>
      )}
      <button
        className="btn btn--ghost hedge-orch__cta"
        onClick={() => { clearPersist(); setStep('idle'); setErrorMsg(null); }}
      >
        Dismiss
      </button>
    </div>
  );
}
