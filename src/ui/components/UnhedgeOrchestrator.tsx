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
import { SWAP_TOKENS, XMR_TOKEN, ETHEREUM_CHAIN_ID, USDC_ETH_ADDRESS } from '../../backend/wagyu';
import {
  getBestQuote,
  createOrder as providerCreateOrder,
  pollSwapOrder,
  type SwapQuote,
  type SwapOrder,
  type SwapProvider,
} from '../../backend/swapProvider';
import { signTransferAuthorization } from '../../wallet/eth';
import { createSubaddress } from '../../backend/lws';

const USDC_ETH_TOKEN = SWAP_TOKENS.find(
  (t) => t.chainId === ETHEREUM_CHAIN_ID && t.tokenId === USDC_ETH_ADDRESS,
)!;

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
  // swap order details — only set once USDC lands on ETH mainnet
  provider?: SwapProvider;
  orderId?: string;
  depositAddr?: string;
  relayTaskId?: string;
  relayChain?: 'arbitrum' | 'ethereum'; // which chain the relay tx is on
  withdrawInitiatedAt?: number; // unix ms — when the Lighter withdrawal was first sent
  trackingUrl?: string;
}

function persistKey(walletId?: string): string {
  return walletId ? `nerodolla_unhedge_${walletId}` : 'nerodolla_unhedge';
}

/** Migrate legacy global key → per-wallet key (one-time, idempotent). */
function migrateLegacyPersist(walletId?: string) {
  if (!walletId) return;
  const LEGACY_KEY = 'nerodolla_unhedge';
  const legacy = localStorage.getItem(LEGACY_KEY);
  if (!legacy) return;
  // Only migrate if the wallet-specific key doesn't already exist
  if (!localStorage.getItem(persistKey(walletId))) {
    localStorage.setItem(persistKey(walletId), legacy);
  }
  localStorage.removeItem(LEGACY_KEY);
}

/** Returns true if a previous unhedge flow is still in progress for this wallet. */
export function hasUnhedgeInProgress(walletId?: string): boolean {
  migrateLegacyPersist(walletId);
  return !!localStorage.getItem(persistKey(walletId));
}

function loadPersist(walletId?: string): UnhedgePersist | null {
  try {
    migrateLegacyPersist(walletId);
    const raw = localStorage.getItem(persistKey(walletId));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function savePersist(s: UnhedgePersist, walletId?: string) {
  localStorage.setItem(persistKey(walletId), JSON.stringify(s));
}
function clearPersist(walletId?: string) {
  localStorage.removeItem(persistKey(walletId));
}

interface UnhedgeOrchestratorProps {
  onUnhedged: () => void;
  /** Active wallet ID — used to isolate persist state per wallet. */
  walletId?: string;
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

export function UnhedgeOrchestrator({ onUnhedged, walletId, recoveryMode, availableUsdc, ethUsdcRecovery, onForceEthRecovery }: UnhedgeOrchestratorProps) {
  const { ethWallet, xmrKeys, hedgeStatus } = useWalletStore();

  const [step, setStep]                 = useState<UnhedgeStep>('idle');
  const [quote, setQuote]               = useState<SwapQuote | null>(null);
  const [bridgeDetail, setBridgeDetail] = useState<SwapOrder | null>(null);
  const [errorMsg, setErrorMsg]         = useState<string | null>(null);
  const [elapsedMin, setElapsedMin]     = useState(0);

  // Per-wallet persist wrappers (avoids cross-wallet state leakage)
  const _load  = () => loadPersist(walletId);
  const _save  = (s: UnhedgePersist) => savePersist(s, walletId);
  const _clear = () => clearPersist(walletId);

  const pollRef        = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickerRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const withdrawAtRef  = useRef<number>(0); // ms timestamp when withdrawal was initiated
  const xmrAddrRef     = useRef<string | null>(null);
  const orderIdRef     = useRef<string | null>(null);
  const depositAddrRef = useRef<string | null>(null);
  const providerRef    = useRef<SwapProvider | null>(null);
  const trackingUrlRef = useRef<string | null>(null);

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
    const saved = _load();
    if (!saved) return;

    orderIdRef.current     = saved.orderId ?? null;
    depositAddrRef.current = saved.depositAddr ?? null;
    providerRef.current    = saved.provider ?? null;
    trackingUrlRef.current = saved.trackingUrl ?? null;
    xmrAddrRef.current     = saved.xmrAddr;
    setStep(saved.step);

    if (saved.step === 'awaiting_usdc') {
      const initiatedAt = saved.withdrawInitiatedAt ?? Date.now();
      withdrawAtRef.current = initiatedAt;
      startElapsedTicker(initiatedAt);
      startUsdcPolling(saved.balanceBefore, saved.xmrAddr);
    } else if (saved.step === 'swapping') {
      if (saved.relayTaskId) {
        // Relay was submitted — poll the tx
        pollRelayTask(saved.relayTaskId, saved.orderId!, saved.provider ?? 'wagyu', saved.relayChain ?? 'ethereum');
      } else if (saved.depositAddr && saved.orderId) {
        // App locked between order creation and relay submission.
        fetchEthUsdcBalanceProxy(ethWallet.address).then(balance => {
          if (balance > 0.01) {
            // USDC still there — re-sign and relay to the existing order
            const valueMicro = BigInt(Math.floor(balance * 1e6));
            signAndRelay(saved.depositAddr!, valueMicro, saved.orderId!, saved.provider ?? 'wagyu');
          } else {
            // USDC already sent — assume relay succeeded, jump to bridge polling
            setStep('bridging');
            _save({ ...saved, step: 'bridging' });
            startBridgePolling(saved.orderId!, saved.provider ?? 'wagyu');
          }
        }).catch(() => {
          // Can't determine — restart polling
          startUsdcPolling(0, saved.xmrAddr);
        });
      } else {
        // No order yet — restart polling
        startUsdcPolling(0, saved.xmrAddr);
      }
    } else if (saved.step === 'bridging') {
      startBridgePolling(saved.orderId!, saved.provider ?? 'wagyu');
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
      const humanUsdc = usdcCollateral.toFixed(2);
      const q = await getBestQuote(USDC_ETH_TOKEN, XMR_TOKEN, humanUsdc);
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
        // 2a. ETH mainnet recovery: USDC already on Ethereum mainnet — get best rate
        // and relay immediately. Use ethUsdcRecovery prop directly (already fetched via proxy).
        // Persist early so switching wallets mid-flow resumes instead of showing idle.
        _save({ step: 'swapping', xmrAddr, balanceBefore: ethUsdcRecovery });
        const humanUsdc = ethUsdcRecovery.toFixed(2);
        const freshQuote = await getBestQuote(USDC_ETH_TOKEN, XMR_TOKEN, humanUsdc);
        const order = await providerCreateOrder(freshQuote, USDC_ETH_TOKEN, XMR_TOKEN, xmrAddr, ethWallet.address);
        orderIdRef.current     = order.orderId;
        depositAddrRef.current = order.depositAddress;
        providerRef.current    = order.provider;
        trackingUrlRef.current = order.trackingUrl ?? null;
        const valueMicro = BigInt(Math.floor(ethUsdcRecovery * 1e6));
        _save({
          step: 'swapping',
          xmrAddr,
          balanceBefore: ethUsdcRecovery,
          provider:    order.provider,
          orderId:     order.orderId,
          depositAddr: order.depositAddress,
          trackingUrl: order.trackingUrl,
        });
        await signAndRelay(order.depositAddress, valueMicro, order.orderId, order.provider);
      } else if (recoveryMode) {
        // 2b. Position already closed — just withdraw whatever is left in Lighter.
        // Wagyu order created later, when USDC actually lands on ETH mainnet.
        const withdrawResult = await withdrawUsdc();
        if (!withdrawResult.success) throw new Error(withdrawResult.error ?? 'Withdrawal failed');

        const balanceBefore = await fetchEthUsdcBalanceProxy(ethWallet.address).catch(() => 0);
        const now = Date.now();
        withdrawAtRef.current = now;
        startElapsedTicker(now);
        _save({ step: 'awaiting_usdc', xmrAddr, balanceBefore, withdrawInitiatedAt: now });
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
        _save({ step: 'awaiting_usdc', xmrAddr, balanceBefore, withdrawInitiatedAt: now });
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
    const saved = _load();
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
      _save({ ...saved, step: 'awaiting_usdc', balanceBefore, withdrawInitiatedAt: initiatedAt });
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
          // Get best rate now — fresh quote, rate reflects current market
          const humanUsdc = balance.toFixed(2);
          const freshQuote = await getBestQuote(USDC_ETH_TOKEN, XMR_TOKEN, humanUsdc);
          const order = await providerCreateOrder(freshQuote, USDC_ETH_TOKEN, XMR_TOKEN, xmrAddr, ethWallet!.address);
          orderIdRef.current     = order.orderId;
          depositAddrRef.current = order.depositAddress;
          providerRef.current    = order.provider;
          trackingUrlRef.current = order.trackingUrl ?? null;
          // Persist order details so resume works if app locks between here and relay
          const saved = _load();
          if (saved) _save({ ...saved, provider: order.provider, orderId: order.orderId, depositAddr: order.depositAddress, trackingUrl: order.trackingUrl });
          const valueMicro = BigInt(Math.floor(balance * 1e6));
          await signAndRelay(order.depositAddress, valueMicro, order.orderId, order.provider);
        }
      } catch (e) {
        console.warn('startUsdcPolling: fetch error', e instanceof Error ? e.message : e);
      }
    }, 10_000);
  }

  // ── Sign EIP-3009 + relay via proxy wallet ───────────────────────────────────

  async function signAndRelay(depositAddr: string, valueMicro: bigint, orderId: string, provider: SwapProvider) {
    if (!ethWallet) return;
    setStep('swapping');
    // Update persist: we're now in swapping but don't have a relay task ID yet
    const existing = _load();
    if (existing) _save({ ...existing, step: 'swapping' });
    try {
      // Lighter withdrawals land on Ethereum mainnet — sign and relay on mainnet
      const auth = await signTransferAuthorization(ethWallet, depositAddr, valueMicro, 'ethereum');
      const taskId = await relayUsdcTransfer(auth, 'ethereum');

      // Persist the relay task ID so we can resume if app locks between here and confirmation
      const saved = _load();
      if (saved) _save({ ...saved, step: 'swapping', relayTaskId: taskId, relayChain: 'ethereum' });

      await pollRelayTask(taskId, orderId, provider, 'ethereum');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Relay failed');
      setStep('error');
    }
  }

  // ── Poll relay tx until confirmed ────────────────────────────────────────────

  async function pollRelayTask(taskId: string, orderId: string, provider: SwapProvider, chain: 'arbitrum' | 'ethereum' = 'ethereum') {
    const MAX_POLLS = 60; // 5 min @ 5s
    let polls = 0;
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      polls++;
      if (polls > MAX_POLLS) {
        clearInterval(pollRef.current!);
        setErrorMsg('Relay timed out — USDC may still arrive');
        setStep('error');
        return;
      }
      try {
        const status = await getRelayTaskStatus(taskId, chain);
        if (status.taskState === 'ExecSuccess') {
          clearInterval(pollRef.current!);
          pollRef.current = null;
          const saved = _load();
          if (saved) _save({ ...saved, step: 'bridging' });
          setStep('bridging');
          startBridgePolling(orderId, provider);
        } else if (status.taskState === 'ExecReverted' || status.taskState === 'Cancelled') {
          clearInterval(pollRef.current!);
          setErrorMsg(`Relay failed (${status.taskState}): ${status.error ?? ''}`);
          setStep('error');
        }
      } catch { /* keep polling */ }
    }, 5_000);
  }

  // ── Poll wagyu order until XMR delivered ─────────────────────────────────────

  function startBridgePolling(orderId: string, provider: SwapProvider) {
    const MAX_POLLS = 120; // 20 min @ 10s
    let polls = 0;
    if (pollRef.current) clearInterval(pollRef.current);

    // Build a minimal SwapOrder for pollSwapOrder (only needs provider + orderId)
    const orderStub: SwapOrder = {
      provider,
      orderId,
      depositAddress: '',
      depositAmount: '',
      depositAmountFormatted: '',
      expectedOutput: '',
      expectedOutputUsd: '',
      status: 'swapping',
    };

    const tick = async () => {
      polls++;
      if (polls > MAX_POLLS) {
        if (pollRef.current) clearInterval(pollRef.current);
        setErrorMsg('Bridge timed out — XMR may still arrive');
        setStep('error');
        return;
      }
      try {
        const detail = await pollSwapOrder(orderStub);
        setBridgeDetail(detail);
        if (detail.status === 'complete') {
          if (pollRef.current) clearInterval(pollRef.current);
          _clear();
          setStep('complete');
        } else if (['failed', 'refunded', 'expired'].includes(detail.status)) {
          if (pollRef.current) clearInterval(pollRef.current);
          _clear();
          setErrorMsg(`Bridge ${detail.status}`);
          setStep('error');
        }
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        console.warn('startBridgePolling: poll error', err);
      }
    };

    tick();
    const intervalMs = provider === 'trocador' ? 60_000 : 10_000;
    pollRef.current = setInterval(tick, intervalMs);
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
    const providerLabel = quote?.provider === 'trocador'
      ? `Trocador${quote.providerDetail ? ` ${quote.providerDetail}` : ''}`
      : 'wagyu.xyz';
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
            <span>Provider</span>
            <span>{providerLabel} (USDC → XMR)</span>
          </div>
          {quote && !isNaN(quote.effectiveCostPct) && (
            <div className="hedge-orch__review-row">
              <span>Effective cost</span>
              <span>{quote.effectiveCostPct.toFixed(1)}%</span>
            </div>
          )}
        </div>
        <p className="hedge-orch__progress">
          {ethUsdcRecovery != null
            ? `USDC will be relayed from Ethereum mainnet to ${providerLabel} and swapped to XMR. No ETH gas required — the proxy wallet pays gas on your behalf.`
            : recoveryMode
              ? `USDC will be withdrawn from Lighter, then swapped to XMR via ${providerLabel}. No ETH gas required.`
              : `USDC will be withdrawn from Lighter (1–4h), then swapped to XMR. Best rate auto-selected when USDC arrives. No ETH gas required — the proxy wallet pays Ethereum mainnet gas on your behalf.`}
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
                _clear();
                if (onForceEthRecovery) onForceEthRecovery(balance);
                else onUnhedged();
                return;
              }
            } catch { /* ignore */ }
            // USDC not yet arrived. If a withdrawal is in transit, keep waiting
            // rather than dumping the user on a confusing empty screen.
            const saved = _load();
            if (saved?.withdrawInitiatedAt) {
              // Reset any stale order details and resume polling
              orderIdRef.current      = null;
              depositAddrRef.current  = null;
              providerRef.current     = null;
              trackingUrlRef.current  = null;
              _save({ ...saved, orderId: undefined, depositAddr: undefined, provider: undefined, trackingUrl: undefined });
              startUsdcPolling(saved.balanceBefore, saved.xmrAddr);
              // Stay in awaiting_usdc — nothing to do
            } else {
              _clear();
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
      <div className="hedge-orch">
        <div className="hedge-orch__spinner-row">
          <div className="swap-flow__spinner" style={{ margin: 0, width: 20, height: 20, borderWidth: 2 }} />
          <span>Sending USDC to swap provider…</span>
        </div>
        {providerRef.current === 'trocador' && trackingUrlRef.current && (
          <a
            href={trackingUrlRef.current}
            target="_blank"
            rel="noopener noreferrer"
            className="hedge-orch__track-link"
          >
            Track swap on Trocador →
          </a>
        )}
        <button
          className="btn btn--ghost"
          style={{ marginTop: 8, fontSize: 12, opacity: 0.6 }}
          onClick={async () => {
            if (pollRef.current) clearInterval(pollRef.current);
            _clear();
            setErrorMsg(null);
            try {
              const balance = await fetchEthUsdcBalanceProxy(ethWallet!.address);
              if (balance > 0.01 && onForceEthRecovery) {
                onForceEthRecovery(balance);
                return;
              }
            } catch { /* ignore */ }
            setStep('idle');
            onUnhedged();
          }}
        >
          Stuck? Dismiss &amp; retry
        </button>
      </div>
    );
  }

  if (step === 'bridging') {
    let label = 'Swapping USDC → XMR…';
    if (bridgeDetail?.status === 'confirming' && bridgeDetail.confirmations != null && bridgeDetail.requiredConfirmations != null) {
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
        {providerRef.current === 'trocador' && trackingUrlRef.current && (
          <a
            href={trackingUrlRef.current}
            target="_blank"
            rel="noopener noreferrer"
            className="hedge-orch__track-link"
          >
            Track swap on Trocador →
          </a>
        )}
        <button
          className="btn btn--ghost"
          style={{ marginTop: 8, fontSize: 12, opacity: 0.6 }}
          onClick={() => {
            if (pollRef.current) clearInterval(pollRef.current);
            _clear();
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
  const persistedState = _load();
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
        onClick={() => { _clear(); setStep('idle'); setErrorMsg(null); }}
      >
        Dismiss
      </button>
    </div>
  );
}
