/**
 * HedgeOrchestrator — unified XMR → bridge → hedge state machine.
 *
 * Flow:
 *   idle → checking → slider → confirming → creating_order → sending_xmr
 *        → bridging → awaiting_account (new accounts) → signing (new only)
 *        → opening → live | error
 */
import { useState, useRef, useEffect } from 'react';
import { useWalletStore } from '../../store/wallet';
import { getDepositIntentAddress } from '../../backend/deposit';
import { MIN_SWAP_XMR } from '../../backend/wagyu';
import {
  getHedgeBestQuote,
  createHedgeOrder,
  pollSwapOrder,
  type SwapQuote,
  type SwapOrder,
} from '../../backend/swapProvider';
import { transferXmr, presyncWallet } from '../../backend/lws';
import {
  checkLighterSetup,
  generateLighterZkKey,
  getLighterSigningMessage,
  completeLighterSetup,
  depositAndOpenHedge,
  getLighterAccount,
  getDepositStatus,
  reRegisterZkKey,
  startBot,
  getMarketInfo,
} from '../../backend/lighter';
import type { LighterSigningData, HedgeCurrency } from '../../backend/lighter';
import { signMessage } from '../../wallet/eth';
import { saveZkKey } from '../../wallet/keystore';
import { setProxySessionToken, renewSession } from '../../backend/lighter';

// ── Persistence helpers (resume after PIN lock) ────────────────────────────

interface PersistedHedgeState {
  bridgeOrder: SwapOrder;
  isNewAccount: boolean;
  savedAt: number;
}

const HEDGE_PERSIST_PREFIX = 'nerodolla_pending_hedge';
const HEDGE_PERSIST_TTL = 2 * 60 * 60 * 1000; // 2h — wagyu order lifetime

function hedgeKey(walletId?: string | null): string {
  return walletId ? `${HEDGE_PERSIST_PREFIX}_${walletId}` : HEDGE_PERSIST_PREFIX;
}

function saveHedgeState(state: Omit<PersistedHedgeState, 'savedAt'>, walletId?: string | null) {
  try {
    localStorage.setItem(hedgeKey(walletId), JSON.stringify({ ...state, savedAt: Date.now() }));
  } catch { /* ignore */ }
}

function loadHedgeState(walletId?: string | null): PersistedHedgeState | null {
  try {
    const raw = localStorage.getItem(hedgeKey(walletId));
    if (!raw) return null;
    const data = JSON.parse(raw) as PersistedHedgeState;
    if (Date.now() - data.savedAt > HEDGE_PERSIST_TTL) {
      localStorage.removeItem(hedgeKey(walletId));
      return null;
    }
    return data;
  } catch { return null; }
}

function clearHedgeState(walletId?: string | null) {
  try { localStorage.removeItem(hedgeKey(walletId)); } catch { /* ignore */ }
}

// ── Types ────────────────────────────────────────────────────────────────────

type OrchestratorStep =
  | 'idle' | 'checking' | 'mode_select' | 'usdc_ready' | 'deposit_pending' | 'slider' | 'confirming'
  | 'creating_order' | 'sending_xmr' | 'bridging'
  | 'awaiting_account' | 'signing' | 'opening' | 'confirming_position' | 'live' | 'error';

interface HedgeOrchestratorProps {
  onHedgeOpened: () => void;
  /** When true, automatically call runCheck() on mount (skip the idle CTA). */
  preCheck?: boolean;
}

// Lighter XMR-USD perp: 10x max leverage → 10% initial margin requirement.
// We target 13% to leave a meaningful buffer above the maintenance margin.
const LIGHTER_INITIAL_MARGIN_RATE = 0.13;

const CURRENCY_LABELS: Record<string, string> = {
  USD: '$ USD', EUR: '€ EUR', GBP: '£ GBP', XAU: 'Au GOLD', XAG: 'Ag SILVER',
};
const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$', EUR: '€', GBP: '£', XAU: 'g', XAG: 'g',
};

/**
 * Given available USDC and current mark price, return the largest XMR short
 * that can be safely opened without immediately hitting a margin warning.
 * Floored to 3 decimal places to match Lighter's SIZE_DECIMALS.
 */
function maxHedgeableXmr(usdcAvailable: number, markPrice: number): number {
  if (markPrice <= 0) return 0;
  return Math.floor((usdcAvailable / (markPrice * LIGHTER_INITIAL_MARGIN_RATE)) * 1e3) / 1e3;
}

export function HedgeOrchestrator({ onHedgeOpened, preCheck }: HedgeOrchestratorProps) {
  const { xmrKeys, ethWallet, xmrInfo, walletCreatedHeight, setSessionToken, lighterMarket, activeWalletId } = useWalletStore();
  // Per-wallet currency preference (stored in localStorage, not the global settings store)
  const walletCurrencyKey = activeWalletId ? `nerodolla_hedge_currency_${activeWalletId}` : null;
  const savedCurrency = walletCurrencyKey
    ? (localStorage.getItem(walletCurrencyKey) as HedgeCurrency | null)
    : null;

  const [step, setStep]                   = useState<OrchestratorStep>('idle');
  const [pct, setPct]                     = useState(20);   // % of spendable balance
  const [usdcReady, setUsdcReady]         = useState(0);    // USDC already in Lighter
  const [depositPendingAmt, setDepositPendingAmt] = useState<number | null>(null);
  const [quote, setQuote]                 = useState<SwapQuote | null>(null);
  // bridgeOrder is stored only in ref (not needed in JSX);
  const [bridgeDetail, setBridgeDetail]   = useState<SwapOrder | null>(null);
  const [signingData, setSigningData]     = useState<LighterSigningData | null>(null);
  // isNewAccount is stored only in ref (not needed in JSX);
  const [errorMsg, setErrorMsg]           = useState<string | null>(null);
  const [isResumed, setIsResumed]         = useState(false); // true when restored from localStorage
  const [mode, setMode]                   = useState<'simple' | 'bot'>('simple');
  const [pendingRecoveryStep, setPendingRecoveryStep] = useState<'usdc_ready' | 'deposit_pending' | null>(null);
  const [currency, setCurrencyState]      = useState<HedgeCurrency>(savedCurrency ?? 'USD');
  const [currencyRate, setCurrencyRate]   = useState<number | null>(null); // currency/USD mark price

  // Currency-aware collateral defaults
  const CURRENCY_DEFAULTS: Record<HedgeCurrency, number> = {
    USD: 20, EUR: 30, GBP: 30, XAU: 35, XAG: 40,
  };

  function setCurrency(c: HedgeCurrency) {
    setCurrencyState(c);
    currencyRef.current = c;
    if (walletCurrencyKey) localStorage.setItem(walletCurrencyKey, c);
    setQuote(null);
    // Apply currency-aware default collateral %
    const newPct = CURRENCY_DEFAULTS[c];
    setPct(newPct);
    const xmr = maxXmr > 0 ? Math.floor(maxXmr * newPct / 100 * 1e6) / 1e6 : 0;
    if (xmr >= parseFloat(MIN_SWAP_XMR)) fetchQuote(xmr.toFixed(6));
    // Fetch currency rate for non-USD
    if (c !== 'USD') {
      setCurrencyRate(null);
      getMarketInfo(`${c}-USD`)
        .then(m => setCurrencyRate(m.markPrice))
        .catch(() => {
          setErrorMsg(`Could not fetch ${c}/USD rate — switching back to USD.`);
          setCurrencyState('USD');
          currencyRef.current = 'USD';
          setPct(CURRENCY_DEFAULTS.USD);
        });
    }
  }

  // Refs for values accessed inside interval callbacks
  const pollRef          = useRef<ReturnType<typeof setInterval> | null>(null);
  const quoteTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bridgeOrderRef   = useRef<SwapOrder | null>(null);
  const bridgeDetailRef  = useRef<SwapOrder | null>(null);
  const isNewAccountRef  = useRef(false);
  const signingDataRef   = useRef<LighterSigningData | null>(null);
  const modeRef          = useRef<'simple' | 'bot'>('simple');
  const currencyRef      = useRef<HedgeCurrency>(savedCurrency ?? 'USD');

  // Resume in-flight bridge if the app was locked mid-flow, or auto-check when
  // we already know USDC is waiting in Lighter (preCheck prop).
  useEffect(() => {
    const saved = loadHedgeState(activeWalletId);
    if (saved) {
      bridgeOrderRef.current = saved.bridgeOrder;
      isNewAccountRef.current = saved.isNewAccount;
      setIsResumed(true);
      setStep('bridging');
      startBridgePolling(saved.bridgeOrder);
    } else if (preCheck) {
      // Skip the idle CTA — the caller knows USDC is already in Lighter.
      runCheck();
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (quoteTimerRef.current) clearTimeout(quoteTimerRef.current);
    };
  }, [activeWalletId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Floor to 6 d.p. so computed amounts never exceed spendable balance (toFixed rounds up)
  const maxXmr = xmrInfo ? Math.floor(Number(xmrInfo.spendableBalance) / 1e6) / 1e6 : 0;
  // XMR amount derived from slider percentage — also floored to 6 d.p.
  const xmrFromPct = maxXmr > 0 ? Math.floor(maxXmr * pct / 100 * 1e6) / 1e6 : 0;

  // ── Step: idle → checking → slider ─────────────────────────────────────────

  async function runCheck() {
    if (!ethWallet) return;
    setStep('checking');
    try {
      // Check setup status first — generate a new ZK key only if one isn't registered yet.
      // Generating a key overwrites localStorage, so we must not do it for existing accounts
      // (the new unregistered key would break signing).
      // Start wallet sync early so it's ready by the time user confirms
      if (xmrKeys) {
        presyncWallet(xmrKeys.primaryAddress, xmrKeys.viewKeyPrivate, walletCreatedHeight ?? undefined);
      }

      const status = await checkLighterSetup(ethWallet.address);
      const isNew = !status.accountExists || !status.hasApiKey;
      isNewAccountRef.current = isNew;

      if (!status.hasApiKey) {
        // No key registered yet — generate one and prepare signing step
        const { zkPrivateKey } = await generateLighterZkKey(ethWallet.address);
        if (zkPrivateKey) {
          await saveZkKey(ethWallet.privateKey, zkPrivateKey);
        }
        if (status.accountExists) {
          const sd = await getLighterSigningMessage(ethWallet.address);
          setSigningData(sd);
          signingDataRef.current = sd;
        }
      }

      // Check current Lighter account state
      try {
        const account = await getLighterAccount(ethWallet.address);
        const hasShort = account.positions.some(
          (p) => p.symbol === 'XMR-USD' && p.side === 'SHORT'
        );

        // Already hedged — nothing to do
        if (hasShort) {
          setStep('live');
          return;
        }

        // USDC landed but no short yet — offer to open position.
        // Use a $1 floor to ignore dust / withdrawal-in-transit collateral artifacts.
        if (account.usdcBalance >= 1.0) {
          setUsdcReady(account.usdcBalance);
          setPendingRecoveryStep('usdc_ready');
          setStep('mode_select');
          return;
        }

        // Balance is 0 — check if a deposit is in flight on Lighter's side.
        // Only trust a "confirmed" deposit if it was created recently (within 4h);
        // older confirmed deposits have already been credited and potentially withdrawn.
        const DEPOSIT_FRESH_WINDOW_S = 4 * 60 * 60; // 4 hours
        try {
          const depStatus = await getDepositStatus(ethWallet.address);
          const nowS = Math.floor(Date.now() / 1000);
          const isFresh = depStatus.createdAt != null
            && (nowS - depStatus.createdAt) < DEPOSIT_FRESH_WINDOW_S;
          if (depStatus.status === 'confirmed' && isFresh) {
            // Recent confirmed deposit — USDC is on its way, not yet credited
            const amt = depStatus.amountUsdc ?? 0;
            setUsdcReady(amt);
            setPendingRecoveryStep('usdc_ready');
            setStep('mode_select');
            return;
          }
          if (depStatus.status === 'pending' && depStatus.amountUsdc && depStatus.amountUsdc > 0) {
            setDepositPendingAmt(depStatus.amountUsdc);
            setPendingRecoveryStep('deposit_pending');
            setStep('mode_select');
            return;
          }
        } catch (depErr) {
          console.warn('[HedgeOrchestrator] Deposit status check failed:', depErr);
        }
      } catch (acctErr) {
        console.warn('[HedgeOrchestrator] getLighterAccount failed:', acctErr);
        // Non-fatal — proxy may not be running; fall through to slider
      }

      setPct(20);
      // Fetch initial quote for the default 20% amount (uses maxXmr captured in closure)
      const defaultXmr = maxXmr > 0 ? Math.floor(maxXmr * 20 / 100 * 1e6) / 1e6 : 0;
      if (defaultXmr >= parseFloat(MIN_SWAP_XMR)) fetchQuote(defaultXmr.toFixed(6));
      setStep('slider');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Setup check failed');
      setStep('error');
    }
  }

  // ── Quote (debounced) ───────────────────────────────────────────────────────

  function fetchQuote(amt: string) {
    if (quoteTimerRef.current) clearTimeout(quoteTimerRef.current);
    const num = parseFloat(amt);
    if (isNaN(num) || num < parseFloat(MIN_SWAP_XMR)) {
      setQuote(null);
      return;
    }
    quoteTimerRef.current = setTimeout(async () => {
      try {
        const q = await getHedgeBestQuote(amt);
        setQuote(q);
      } catch (err) {
        console.warn('[HedgeOrchestrator] quote fetch failed:', err);
        setQuote(null);
      }
    }, 500);
  }

  function handlePctChange(val: number) {
    setPct(val);
    setQuote(null);
    const xmr = maxXmr > 0 ? Math.floor(maxXmr * val / 100 * 1e6) / 1e6 : 0;
    if (xmr >= parseFloat(MIN_SWAP_XMR)) fetchQuote(xmr.toFixed(6));
    else setQuote(null);
  }

  // ── Bot mode: start bot after USDC lands ───────────────────────────────────

  async function doStartBot() {
    if (!xmrKeys) return;
    try {
      await startBot(xmrKeys.primaryAddress, xmrKeys.viewKeyPrivate, maxXmr, currencyRef.current);
      const botKey = activeWalletId ? `nerodolla_bot_active_${activeWalletId}` : 'nerodolla_bot_active';
      localStorage.setItem(botKey, 'true');
      clearHedgeState(activeWalletId);
      setStep('live');
      onHedgeOpened();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('401')) {
        const renewed = await renewSession();
        if (renewed) { setStep('usdc_ready'); return; }
        setErrorMsg('Session expired — please lock the app and re-enter your PIN.');
      } else {
        setErrorMsg(msg || 'Failed to start bot');
      }
      setStep('error');
    }
  }

  async function handleModeSelect() {
    modeRef.current = mode;
    if (pendingRecoveryStep === 'usdc_ready') {
      setPendingRecoveryStep(null);
      if (mode === 'bot') {
        if (isNewAccountRef.current && (signingDataRef.current ?? signingData)) {
          setStep('signing');
        } else {
          setStep('opening');
          await doStartBot();
        }
      } else {
        setStep('usdc_ready');
      }
    } else if (pendingRecoveryStep === 'deposit_pending') {
      setPendingRecoveryStep(null);
      setStep('deposit_pending');
    } else {
      setStep('slider');
    }
  }

  // ── Step: usdc_ready → opening (recovery path) ─────────────────────────────

  // XMR size to open in the usdc_ready path — capped by what the USDC can safely margin.
  const markPrice = lighterMarket?.markPrice ?? 0;
  const usdcReadyHedgeXmr = Math.min(maxXmr, maxHedgeableXmr(usdcReady, markPrice));
  const isPartialHedge = usdcReadyHedgeXmr < maxXmr - 0.001;

  async function handleOpenExistingUsdc() {
    // If the ZK key isn't registered yet, must sign first before the proxy can trade
    if (isNewAccountRef.current && (signingDataRef.current ?? signingData)) {
      setStep('signing');
      return;
    }
    if (modeRef.current === 'bot') {
      setStep('opening');
      await doStartBot();
      return;
    }
    setStep('opening');
    try {
      const xmrSize = usdcReadyHedgeXmr > 0 ? usdcReadyHedgeXmr : maxXmr;
      const result = await depositAndOpenHedge({ usdcAmount: usdcReady.toFixed(2), xmrSize: xmrSize.toFixed(6), currency: currencyRef.current });
      if (!result.success) throw new Error(result.error ?? 'Open hedge failed');
      await waitForPositionThenComplete();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('401')) {
        const renewed = await renewSession();
        if (renewed) {
          // Retry automatically after successful session renewal
          try {
            const xmrRetry = usdcReadyHedgeXmr > 0 ? usdcReadyHedgeXmr : maxXmr;
            const retryResult = await depositAndOpenHedge({ usdcAmount: usdcReady.toFixed(2), xmrSize: xmrRetry.toFixed(6), currency: currencyRef.current });
            if (!retryResult.success) throw new Error(retryResult.error ?? 'Open hedge failed');
            await waitForPositionThenComplete();
            return;
          } catch {
            setErrorMsg('Retry after session renewal failed — please try again.');
          }
        } else {
          setErrorMsg('Session expired — please lock the app and re-enter your PIN.');
        }
      } else {
        setErrorMsg(msg || 'Open hedge failed');
      }
      setStep('error');
    }
  }

  // ── Step: confirming → creating_order → sending_xmr → bridging ─────────────

  async function handleConfirm() {
    if (!ethWallet || !xmrKeys) return;
    setStep('creating_order');
    try {
      const intentResult = await getDepositIntentAddress(ethWallet.address, 42161);
      const intentAddr = intentResult.intent_address;

      const hedgeQuote = quote ?? await getHedgeBestQuote(xmrFromPct.toFixed(6));
      const order = await createHedgeOrder(hedgeQuote, intentAddr, xmrKeys.primaryAddress);
      bridgeOrderRef.current = order;

      setStep('sending_xmr');
      try {
        await transferXmr(
          xmrKeys.primaryAddress,
          xmrKeys.viewKeyPrivate,
          xmrKeys.spendKeyPrivate,
          order.depositAddress,
          order.depositAmount,
          walletCreatedHeight ?? undefined,
        );
      } catch (txErr) {
        const msg = txErr instanceof Error ? txErr.message : '';
        if (msg.includes('syncing') || msg.includes('503')) {
          setErrorMsg('Wallet is still syncing with the network. This is normal on first use — please wait a moment and try again.');
        } else {
          setErrorMsg(msg || 'XMR transfer failed');
        }
        setStep('error');
        return;
      }

      setStep('bridging');
      saveHedgeState({ bridgeOrder: order, isNewAccount: isNewAccountRef.current }, activeWalletId);
      startBridgePolling(order);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Transaction failed');
      setStep('error');
    }
  }

  // ── Bridge polling ──────────────────────────────────────────────────────────

  function startBridgePolling(order: SwapOrder) {
    if (pollRef.current) clearInterval(pollRef.current);
    const pollInterval = order.provider === 'trocador' ? 60_000 : 10_000;
    const tick = async () => {
      try {
        const detail = await pollSwapOrder(order);
        setBridgeDetail(detail);
        bridgeDetailRef.current = detail;

        if (detail.status === 'complete') {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          clearHedgeState(activeWalletId);
          // USDC should now be in Lighter — run account check which handles
          // session readiness and transitions to mode_select.
          runCheck();
        } else if (['failed', 'refunded', 'expired'].includes(detail.status)) {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          clearHedgeState(activeWalletId);
          setErrorMsg(`Bridge ${detail.status}. Your XMR balance was not affected.`);
          setStep('error');
        }
      } catch {
        // Transient network error or provider API issue — keep polling.
        // Do NOT clear state on 404 — Trocador's API sometimes 302-redirects
        // to a broken /en/ path that returns 404 even for valid trades.
      }
    };
    tick(); // immediate first check (especially important on resume)
    pollRef.current = setInterval(tick, pollInterval);
  }

  // ── Account polling (new accounts only) ────────────────────────────────────

  function startAccountPolling() {
    if (!ethWallet) return;
    const MAX_POLLS = 144; // 12 min @ 5s
    let polls = 0;
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      polls++;
      if (polls > MAX_POLLS) {
        clearInterval(pollRef.current!);
        pollRef.current = null;
        setErrorMsg('Lighter account not found after 12 minutes');
        setStep('error');
        return;
      }
      try {
        const status = await checkLighterSetup(ethWallet.address);
        if (status.accountExists) {
          clearInterval(pollRef.current!);
          pollRef.current = null;
          if (!signingDataRef.current) {
            const sd = await getLighterSigningMessage(ethWallet.address);
            setSigningData(sd);
            signingDataRef.current = sd;
          }
          setStep('signing');
        }
      } catch {
        // Keep polling
      }
    }, 5_000);
  }

  // ── Step: signing → opening ─────────────────────────────────────────────────

  async function handleSign() {
    if (!ethWallet) return;
    const sd = signingDataRef.current ?? signingData;
    if (!sd) {
      setErrorMsg('Signing data unavailable');
      setStep('error');
      return;
    }
    try {
      const l1Sig = await signMessage(ethWallet, sd.messageToSign);
      const result = await completeLighterSetup({
        ethAddress: ethWallet.address,
        l1Signature: l1Sig,
        txType: sd.txType,
        txInfo: sd.txInfo,
        accountIndex: sd.accountIndex,
      });
      if (!result.success) throw new Error(result.error ?? 'Lighter setup failed');
      // Use the session token returned directly by complete_setup (no second round-trip needed)
      if (result.sessionToken) {
        setSessionToken(result.sessionToken);
        setProxySessionToken(result.sessionToken);
      }
      setStep('opening');
      const order = bridgeOrderRef.current;
      const detail = bridgeDetailRef.current;
      if (modeRef.current === 'bot') {
        await doStartBot();
      } else if (order) {
        doOpenHedge(order, detail);
      } else {
        // Recovery path: USDC already in Lighter, open hedge directly
        const result2 = await depositAndOpenHedge({ usdcAmount: usdcReady.toFixed(2), xmrSize: maxXmr.toFixed(6), currency: currencyRef.current });
        if (!result2.success) throw new Error(result2.error ?? 'Open hedge failed');
        await waitForPositionThenComplete();
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Sign failed');
      setStep('error');
    }
  }

  // ── Step: opening → confirming_position → live ──────────────────────────────

  async function doOpenHedge(order: SwapOrder, detail: SwapOrder | null) {
    if (modeRef.current === 'bot') {
      setStep('opening');
      await doStartBot();
      return;
    }
    try {
      const rawOutput = detail?.expectedOutput ?? order.expectedOutput;
      const usdcFloat = Number(rawOutput) / 1e6;
      const usdcAmount = usdcFloat.toFixed(2);
      // Cap position size to what the USDC can safely margin at 10x leverage
      const safeXmr = Math.min(maxXmr, maxHedgeableXmr(usdcFloat, markPrice));
      const xmrSize = (safeXmr > 0 ? safeXmr : maxXmr).toFixed(6);
      const result = await depositAndOpenHedge({ usdcAmount, xmrSize, currency: currencyRef.current });
      if (!result.success) throw new Error(result.error ?? 'Open hedge failed');
      await waitForPositionThenComplete();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Open hedge failed');
      setStep('error');
    }
  }

  // ── Auto-retry quote if slider is visible but quote is null ────────────────
  useEffect(() => {
    if (step === 'slider' && !quote && xmrFromPct >= parseFloat(MIN_SWAP_XMR)) {
      fetchQuote(xmrFromPct.toFixed(6));
    }
  }, [step, quote, xmrFromPct]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Validation ──────────────────────────────────────────────────────────────

  const amountValid = maxXmr > 0 && xmrFromPct >= parseFloat(MIN_SWAP_XMR);

  // ── Wait for Lighter to reflect the new short position ─────────────────────
  // After create_market_order succeeds, Lighter's account API may take several
  // seconds to propagate the position. We poll here so onHedgeOpened() is only
  // called once isHedged is actually true — preventing the "loop" bug where
  // refreshHedgeStatus() fires too early and rewrites the store with isHedged=false.

  async function waitForPositionThenComplete() {
    setStep('confirming_position');
    const MAX_POLLS = 15; // up to 45s
    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise(r => setTimeout(r, 3_000));
      try {
        const account = await getLighterAccount(ethWallet!.address);
        const hasShort = account.positions.some(p => p.symbol === 'XMR-USD' && p.side === 'SHORT');
        if (hasShort) {
          clearHedgeState(activeWalletId);
          setStep('live');
          onHedgeOpened();
          return;
        }
      } catch { /* keep polling */ }
    }
    // Timed out — still call onHedgeOpened so the parent can refresh; it should
    // appear shortly and the home screen sync will pick it up.
    clearHedgeState(activeWalletId);
    setStep('live');
    onHedgeOpened();
  }

  // ── Re-register ZK key then retry open ─────────────────────────────────────

  async function handleReRegisterAndOpen() {
    if (!ethWallet) return;
    setStep('opening');
    setErrorMsg(null);
    try {
      const { newZkPrivKey, sessionToken } = await reRegisterZkKey(ethWallet.address, ethWallet.privateKey);
      await saveZkKey(ethWallet.privateKey, newZkPrivKey);
      setSessionToken(sessionToken);
      setProxySessionToken(sessionToken);
      // Retry the open using whatever USDC is in the Lighter account
      const account = await getLighterAccount(ethWallet.address);
      const usdc = account.usdcBalance > 0 ? account.usdcBalance : usdcReady;
      if (usdc <= 0) throw new Error('No USDC in Lighter account to open hedge with');
      const safeXmr = Math.min(maxXmr, maxHedgeableXmr(usdc, markPrice));
      const result = await depositAndOpenHedge({
        usdcAmount: usdc.toFixed(2),
        xmrSize: (safeXmr > 0 ? safeXmr : maxXmr).toFixed(6),
        currency: currencyRef.current,
      });
      if (!result.success) throw new Error(result.error ?? 'Open hedge failed');
      await waitForPositionThenComplete();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Re-registration failed');
      setStep('error');
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  if (step === 'idle') {
    return (
      <div className="hedge-orch">
        <button className="btn btn--primary hedge-orch__cta" onClick={runCheck}>
          Swap XMR → lock USD value
        </button>
      </div>
    );
  }

  if (step === 'checking') {
    return (
      <div className="hedge-orch">
        <div className="hedge-orch__spinner-row">
          <div className="swap-flow__spinner" style={{ margin: 0, width: 20, height: 20, borderWidth: 2 }} />
          <span>Checking Lighter account…</span>
        </div>
      </div>
    );
  }

  if (step === 'usdc_ready') {
    return (
      <div className="hedge-orch">
        <div className="hedge-orch__review">
          <div className="hedge-orch__review-row">
            <span>USDC in Lighter</span>
            <span style={{ color: 'var(--color-green)' }}>{usdcReady.toFixed(2)} USDC</span>
          </div>
          <div className="hedge-orch__review-row">
            <span>Short size</span>
            <span>{usdcReadyHedgeXmr > 0 ? `${usdcReadyHedgeXmr.toFixed(3)} XMR` : `${maxXmr.toFixed(4)} XMR`}</span>
          </div>
          <div className="hedge-orch__review-row">
            <span>Your XMR balance</span>
            <span>{maxXmr.toFixed(4)} XMR</span>
          </div>
        </div>
        {isPartialHedge && (
          <div className="hedge-orch__error" style={{ background: 'rgba(255,150,0,0.12)', color: '#f90', borderColor: '#f90', marginTop: 10 }}>
            Your USDC covers a partial hedge only ({usdcReadyHedgeXmr.toFixed(3)} of {maxXmr.toFixed(4)} XMR).
            To hedge your full balance, swap more XMR and top up via the "Top up collateral" button after opening.
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn btn--primary" onClick={handleOpenExistingUsdc}>
            {mode === 'bot' ? 'Start bot' : 'Open hedge'}
          </button>
          <button className="btn btn--ghost" onClick={() => setStep('mode_select')}>
            Back
          </button>
        </div>
      </div>
    );
  }

  if (step === 'deposit_pending') {
    async function tryOpenFromPending() {
      // Re-check account — deposit may have been credited since we last checked
      setStep('checking');
      try {
        const account = await getLighterAccount(ethWallet!.address);
        if (account.usdcBalance >= 1.0) {
          setUsdcReady(account.usdcBalance);
          setStep('usdc_ready');
          return;
        }
        // Still 0 on account — fall back to using the known deposit amount
        if (depositPendingAmt && depositPendingAmt > 0) {
          setUsdcReady(depositPendingAmt);
          setStep('usdc_ready');
          return;
        }
      } catch {
        // proxy down — use known deposit amount as fallback
        if (depositPendingAmt && depositPendingAmt > 0) {
          setUsdcReady(depositPendingAmt);
          setStep('usdc_ready');
          return;
        }
      }
      setStep('deposit_pending');
    }

    return (
      <div className="hedge-orch">
        <div className="hedge-orch__spinner-row">
          <span>⏳</span>
          <span>
            Deposit processing on Lighter
            {depositPendingAmt !== null && depositPendingAmt > 0 ? ` (${depositPendingAmt.toFixed(2)} USDC)` : ''}…
          </span>
        </div>
        <div className="hedge-orch__progress">
          Your USDC arrived at the intent address and Lighter is crediting it to your account.
          This usually takes 1–5 minutes.
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn btn--secondary" onClick={runCheck}>
            Check again
          </button>
          <button className="btn btn--primary" onClick={tryOpenFromPending}>
            Open hedge anyway
          </button>
        </div>
      </div>
    );
  }

  if (step === 'mode_select') {
    const annPct = lighterMarket?.annualizedFundingPct ?? 19;
    const options: Array<{
      id: 'simple' | 'bot';
      title: string;
      tagline: string;
      body: string;
      apy: string;
      apyNote: string;
    }> = [
      {
        id: 'simple',
        title: 'Simple Hedge',
        tagline: 'Instant protection, collect funding',
        body: 'Opens a market order short equal to your XMR balance. Your USD value is locked immediately.',
        apy: `~${annPct.toFixed(0)}% APY`,
        apyNote: 'funding rate only',
      },
      {
        id: 'bot',
        title: 'Run the Bot',
        tagline: 'No slippage, earn spread + funding',
        body: 'Places limit orders to build the short gradually. Avoids market-order slippage on thin books. Position establishes over time — typically minutes to hours.',
        apy: `~${(annPct + 5).toFixed(0)}%+ APY`,
        apyNote: 'funding + spread income',
      },
    ];
    return (
      <div className="hedge-orch">
        <div className="hedge-mode-select">
          {options.map(opt => (
            <div
              key={opt.id}
              className={`hedge-mode-card${mode === opt.id ? ' hedge-mode-card--selected' : ''}`}
              onClick={() => setMode(opt.id)}
              role="button"
              aria-pressed={mode === opt.id}
            >
              <div className="hedge-mode-card__title">{opt.title}</div>
              <div className="hedge-mode-card__tagline">{opt.tagline}</div>
              <div className="hedge-mode-card__body">{opt.body}</div>
              <div>
                <span className="hedge-mode-card__apy">{opt.apy}</span>
                <span className="hedge-mode-card__apy-note"> · {opt.apyNote}</span>
              </div>
            </div>
          ))}
        </div>
        <button
          className="btn btn--primary hedge-orch__cta"
          onClick={handleModeSelect}
        >
          Continue →
        </button>
      </div>
    );
  }

  if (step === 'slider') {
    const currencyLockOz = currency !== 'USD' && currencyRate && quote
      ? Number(quote.minReceived) / currencyRate
      : null;
    const currencyLockValue = currencyLockOz !== null
      ? (currency === 'XAU' || currency === 'XAG')
        ? currencyLockOz < 1
          ? `${(currencyLockOz * 31.1035).toFixed(3)}`
          : `${currencyLockOz.toFixed(2)}`
        : currencyLockOz.toFixed(2)
      : null;
    const currencyLockUnit = (currency === 'XAU' || currency === 'XAG') && currencyLockOz !== null
      ? currencyLockOz < 1 ? 'g' : 'oz'
      : null;
    const warnThreshold = currency === 'USD' ? 15 : 20;
    return (
      <div className="hedge-orch">
        <div className="hedge-orch__currency-grid">
          {(Object.keys(CURRENCY_LABELS) as HedgeCurrency[]).map(c => (
            <button
              key={c}
              className={`hedge-orch__currency-btn${currency === c ? ' hedge-orch__currency-btn--active' : ''}`}
              onClick={() => setCurrency(c)}
            >
              {CURRENCY_LABELS[c]}
            </button>
          ))}
        </div>
        {pct < warnThreshold && (
          <div className="hedge-orch__collateral-warn">
            Low collateral ({pct}%) — risk of liquidation
            {currency !== 'USD' ? '. Multi-position hedges need more margin.' : '.'}
          </div>
        )}
        <div className="hedge-orch__slider-row">
          <input
            className="hedge-orch__slider"
            type="range"
            min={1}
            max={100}
            step={1}
            value={pct}
            onChange={(e) => handlePctChange(Number(e.target.value))}
          />
          <input
            className="hedge-orch__amount-input"
            type="number"
            min={1}
            max={100}
            step={1}
            value={pct}
            onChange={(e) => handlePctChange(Math.min(100, Math.max(1, Number(e.target.value))))}
          />
          <span style={{ color: 'var(--color-text-muted)', fontWeight: 600 }}>%</span>
        </div>
        {maxXmr > 0 && (
          <div className="hedge-orch__quote">
            {xmrFromPct.toFixed(4)} XMR
            {quote
              ? <> → <strong>{quote.minReceived} USDC</strong> min
                  {currencyLockValue && <> ≈ <strong>{currencyLockUnit ? `${currencyLockValue} ${currencyLockUnit}` : `${CURRENCY_SYMBOLS[currency]}${currencyLockValue}`}</strong> locked</>}
                </>
              : <> — fetching quote…</>}
          </div>
        )}
        <button
          className="btn btn--primary hedge-orch__cta"
          onClick={() => setStep('confirming')}
          disabled={!amountValid || !quote}
        >
          {!quote && amountValid ? 'Fetching quote…' : 'Review & confirm'}
        </button>
      </div>
    );
  }

  if (step === 'confirming') {
    return (
      <div className="hedge-orch">
        <div className="hedge-orch__review">
          <div className="hedge-orch__review-row">
            <span>You send</span>
            <span>{pct}% ({xmrFromPct.toFixed(4)} XMR)</span>
          </div>
          <div className="hedge-orch__review-row">
            <span>Min USDC received</span>
            <span>{quote ? `${quote.minReceived} USDC` : '—'}</span>
          </div>
          <div className="hedge-orch__review-row">
            <span>Destination</span>
            <span>Lighter (via Arbitrum)</span>
          </div>
          <div className="hedge-orch__review-row">
            <span>Bridge</span>
            <span>{quote?.provider === 'trocador' ? 'Trocador' : 'wagyu.xyz'}</span>
          </div>
          <div className="hedge-orch__review-row">
            <span>Lock value in</span>
            <span>{CURRENCY_LABELS[currency] ?? currency}</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn btn--primary" onClick={handleConfirm}>
            Confirm &amp; send
          </button>
          <button className="btn btn--ghost" onClick={() => setStep('slider')}>
            Back
          </button>
        </div>
      </div>
    );
  }

  if (
    step === 'creating_order' ||
    step === 'sending_xmr' ||
    step === 'bridging' ||
    step === 'opening' ||
    step === 'confirming_position'
  ) {
    let bridgingLabel = 'Waiting for XMR to appear on-chain…';
    let bridgingNote: string | null = null;
    if (bridgeDetail) {
      const { confirmations, requiredConfirmations, status, provider } = bridgeDetail;
      const providerName = provider === 'trocador' ? 'Trocador' : 'wagyu';
      const hasConfs = confirmations !== null && confirmations !== undefined
        && requiredConfirmations !== null && requiredConfirmations !== undefined;
      if (status === 'awaiting_deposit') {
        bridgingLabel = isResumed
          ? `${providerName} order awaiting XMR deposit — XMR may not have been sent`
          : 'Waiting for XMR deposit…';
        bridgingNote = isResumed
          ? `No XMR has reached the ${providerName} deposit address. If your balance is unchanged, tap "Check account" or "Start fresh" to begin a new hedge.`
          : 'Transaction broadcast — waiting for first block confirmation.';
      } else if (!hasConfs || status === 'complete') {
        bridgingLabel = 'Swap complete — checking your Lighter account…';
        bridgingNote = null;
      } else if (status === 'swapping') {
        bridgingLabel = 'Confirmations received — swapping…';
        bridgingNote = null;
      } else {
        const minsLeft = Math.ceil((requiredConfirmations! - confirmations!) * 2);
        bridgingLabel = `XMR confirming: ${confirmations}/${requiredConfirmations} blocks`;
        bridgingNote = confirmations! < requiredConfirmations!
          ? `~${minsLeft} min remaining`
          : 'All confirmations received — swapping…';
      }
    }
    const labelMap: Record<string, string> = {
      creating_order: 'Creating swap order…',
      sending_xmr: 'Sending XMR…',
      bridging: bridgingLabel,
      opening: mode === 'bot' ? 'Starting bot…' : 'Opening hedge position…',
      confirming_position: 'Confirming position on Lighter…',
    };
    return (
      <div className="hedge-orch">
        <div className="hedge-orch__spinner-row">
          <div className="swap-flow__spinner" style={{ margin: 0, width: 20, height: 20, borderWidth: 2 }} />
          <span>{labelMap[step]}</span>
        </div>
        {step === 'bridging' && bridgingNote && (
          <div className="hedge-orch__progress">{bridgingNote}</div>
        )}
        {step === 'bridging' && bridgeOrderRef.current?.trackingUrl && (
          <a
            href={bridgeOrderRef.current.trackingUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="hedge-orch__track-link"
          >
            Track swap on Trocador →
          </a>
        )}
        {step === 'bridging' && isResumed && (
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button
              className="btn btn--primary"
              style={{ fontSize: 13 }}
              onClick={() => { clearHedgeState(activeWalletId); if (pollRef.current) clearInterval(pollRef.current); setIsResumed(false); setBridgeDetail(null); runCheck(); }}
            >
              Check account
            </button>
            <button
              className="btn btn--ghost"
              style={{ fontSize: 13 }}
              onClick={() => { clearHedgeState(activeWalletId); if (pollRef.current) clearInterval(pollRef.current); setStep('idle'); setIsResumed(false); setBridgeDetail(null); }}
            >
              Start fresh
            </button>
          </div>
        )}
        {step === 'bridging' && !isResumed && (
          <button
            className="btn btn--ghost hedge-orch__cta"
            style={{ marginTop: 12, fontSize: 13 }}
            onClick={() => { clearHedgeState(activeWalletId); if (pollRef.current) clearInterval(pollRef.current); setStep('idle'); setIsResumed(false); setBridgeDetail(null); }}
          >
            Start fresh
          </button>
        )}
        {step === 'confirming_position' && (
          <div className="hedge-orch__progress" style={{ marginTop: 8, fontSize: 13 }}>
            Position submitted — waiting for Lighter to confirm. Please wait.
          </div>
        )}
      </div>
    );
  }

  if (step === 'awaiting_account') {
    return (
      <div className="hedge-orch">
        <div className="hedge-orch__spinner-row">
          <div className="swap-flow__spinner" style={{ margin: 0, width: 20, height: 20, borderWidth: 2 }} />
          <span>Waiting for Lighter account to activate…</span>
        </div>
        <div className="hedge-orch__progress">
          Bridge complete. Your Lighter account is being created on-chain (may take a few minutes).
        </div>
      </div>
    );
  }

  if (step === 'signing') {
    return (
      <div className="hedge-orch">
        <p style={{ fontSize: 14, color: 'var(--color-text-muted)', marginBottom: 12 }}>
          Sign once to register your ZK API key with Lighter. This is required to open the hedge.
        </p>
        <button className="btn btn--primary hedge-orch__cta" onClick={handleSign}>
          Sign &amp; activate
        </button>
      </div>
    );
  }

  if (step === 'live') {
    return (
      <div className="hedge-orch">
        <div style={{ color: 'var(--color-green)', fontWeight: 600, fontSize: 15 }}>
          {mode === 'bot'
            ? '✓ Bot started — building short position via limit orders'
            : `✓ Hedge active — ${currency} value locked`}
        </div>
      </div>
    );
  }

  if (step === 'error') {
    const isKeyError = errorMsg?.includes('21120') || errorMsg?.includes('21109') || errorMsg?.includes('invalid signature') || errorMsg?.includes('api key not found');
    return (
      <div className="hedge-orch">
        <div className="hedge-orch__error">{errorMsg ?? 'An unexpected error occurred.'}</div>
        {isKeyError ? (
          <button className="btn btn--primary hedge-orch__cta" onClick={handleReRegisterAndOpen}>
            Register key &amp; retry
          </button>
        ) : (
          <button
            className="btn btn--ghost hedge-orch__cta"
            onClick={() => { clearHedgeState(activeWalletId); setStep('idle'); setErrorMsg(null); }}
          >
            Try again
          </button>
        )}
      </div>
    );
  }

  return null;
}
