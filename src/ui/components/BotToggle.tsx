/**
 * BotToggle — start/stop the per-session market-making bot
 *
 * Shown on the HedgeScreen when the user has an active hedge and a valid
 * proxy session. Polls /bot/status every 15 s while the bot is running,
 * and /bot/earnings every 60 s.
 */
import { useState, useEffect, useRef } from 'react';
import { useWalletStore } from '../../store/wallet';
import {
  startBot, stopBot, getBotStatus, getBotEarnings,
  initLighterSession, setProxySessionToken,
  migrateLegacyZkKey, reRegisterZkKey,
} from '../../backend/lighter';
import type { BotStatus, BotEarnings, LighterPosition } from '../../backend/lighter';
import { loadZkKey, saveZkKey, clearZkKey } from '../../wallet/keystore';

interface BotToggleProps {
  xmrBalance: number;
  hedgePosition?: LighterPosition;
  lighterUsdc?: number;
  onActiveChange?: (active: boolean) => void;
  onApyChange?: (apy: number | null) => void;
}

function fmt(n: number, decimals = 2): string {
  return (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(decimals);
}

function EarningsTable({ earnings }: { earnings: BotEarnings }) {
  const rows: Array<{ label: string; spread: number; funding: number }> = [
    { label: '24h',   spread: earnings.spread1d,    funding: earnings.funding1d },
    { label: '7d',    spread: earnings.spread7d,    funding: earnings.funding7d },
    { label: '30d',   spread: earnings.spread30d,   funding: earnings.funding30d },
    { label: 'Total', spread: earnings.spreadTotal, funding: earnings.fundingTotal },
  ];

  return (
    <div className="bot-earnings">
      <div className="bot-earnings__header">
        <span />
        <span>Spread</span>
        <span>Funding</span>
        <span>Total</span>
      </div>
      {rows.map(({ label, spread, funding }) => {
        const total = spread + funding;
        return (
          <div key={label} className="bot-earnings__row">
            <span className="bot-earnings__period">{label}</span>
            <span style={{ color: spread >= 0 ? 'var(--color-green)' : 'var(--color-red)' }}>
              {fmt(spread, 2)}
            </span>
            <span style={{ color: funding >= 0 ? 'var(--color-green)' : 'var(--color-red)' }}>
              {fmt(funding, 2)}
            </span>
            <span className="bot-earnings__total"
              style={{ color: total >= 0 ? 'var(--color-green)' : 'var(--color-red)' }}>
              {fmt(total, 2)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function BotToggle({ xmrBalance, hedgePosition, lighterUsdc, onActiveChange, onApyChange }: BotToggleProps) {
  const { xmrKeys, ethWallet, sessionToken, setSessionToken, lighterMarket } = useWalletStore();

  const [botStatus, setBotStatus] = useState<BotStatus | null>(null);
  const [earnings, setEarnings] = useState<BotEarnings | null>(null);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const earningsPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function stopPolling() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (earningsPollRef.current) { clearInterval(earningsPollRef.current); earningsPollRef.current = null; }
  }

  async function fetchStatus(): Promise<BotStatus | null> {
    try {
      const s = await getBotStatus();
      setBotStatus(s);
      if (s.status === 'stopped') stopPolling();
      return s;
    } catch (err) {
      if (err instanceof Error && err.message.includes('HTTP 401')) {
        setSessionToken(null);
        setProxySessionToken(null);
        setBotStatus(null);
        stopPolling();
      }
      return null;
    }
  }

  async function fetchEarnings() {
    try {
      const e = await getBotEarnings();
      setEarnings(e);
      // Compute realised APY: total earnings / days since first fill, annualised.
      // Denominator = total wallet value (XMR in USD + Lighter collateral).
      const markPrice = lighterMarket?.markPrice ?? 0;
      const totalWalletUsd = xmrBalance * markPrice + (lighterUsdc ?? 0);
      if (totalWalletUsd > 0 && e.firstFillAt > 0) {
        const daysActive = Math.max((Date.now() / 1000 - e.firstFillAt) / 86400, 1 / 1440);
        const totalEarned = e.spreadTotal + e.fundingTotal;
        const apy = (totalEarned / daysActive) * 365 / totalWalletUsd * 100;
        onApyChange?.(apy);
      }
    } catch { /* non-critical */ }
  }

  function startPolling() {
    stopPolling();
    pollRef.current = setInterval(fetchStatus, 15_000);
    fetchEarnings();
    earningsPollRef.current = setInterval(fetchEarnings, 60_000);
  }

  useEffect(() => {
    if (sessionToken) {
      if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
      setReconnecting(false);
      (async () => {
        const s = await fetchStatus();
        if (!s) return;
        if (s.status === 'running' || s.status === 'paused') {
          startPolling();
        } else if (s.status === 'stopped' &&
            (s.targetXmr !== 0 || localStorage.getItem('nerodolla_bot_active') === 'true')) {
          handleStart();
        }
      })();
    } else if (ethWallet && !botStatus) {
      setReconnecting(true);
      reconnectTimerRef.current = setTimeout(() => setReconnecting(false), 8_000);
    }
    return () => {
      stopPolling();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionToken]);

  const isActive = (botStatus?.status ?? 'stopped') === 'running' || (botStatus?.status ?? 'stopped') === 'paused';
  useEffect(() => { onActiveChange?.(isActive); }, [isActive]); // eslint-disable-line

  // ── Actions ───────────────────────────────────────────────────────────────

  async function handleStart() {
    if (!xmrKeys || !ethWallet) return;
    setBusy(true);
    setLocalError(null);
    try {
      const ensureSession = async () => {
        let zkPrivKey = await loadZkKey(ethWallet.privateKey);
        if (!zkPrivKey) {
          zkPrivKey = await migrateLegacyZkKey(ethWallet.address, ethWallet.privateKey);
          await saveZkKey(ethWallet.privateKey, zkPrivKey);
        }
        try {
          const token = await initLighterSession(ethWallet.address, ethWallet.privateKey, zkPrivKey);
          setSessionToken(token);
          setProxySessionToken(token);
        } catch (err) {
          if (err instanceof Error && err.message.includes('zk_key_rejected')) {
            clearZkKey();
            zkPrivKey = await migrateLegacyZkKey(ethWallet.address, ethWallet.privateKey);
            await saveZkKey(ethWallet.privateKey, zkPrivKey);
            const token = await initLighterSession(ethWallet.address, ethWallet.privateKey, zkPrivKey);
            setSessionToken(token);
            setProxySessionToken(token);
          } else {
            throw err;
          }
        }
      };

      if (!sessionToken) await ensureSession();
      try {
        await startBot(xmrKeys.primaryAddress, xmrKeys.viewKeyPrivate, xmrBalance);
      } catch (err) {
        if (err instanceof Error && err.message.includes('HTTP 401')) {
          await ensureSession();
          await startBot(xmrKeys.primaryAddress, xmrKeys.viewKeyPrivate, xmrBalance);
        } else {
          throw err;
        }
      }
      localStorage.setItem('nerodolla_bot_active', 'true');
      await fetchStatus();
      startPolling();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to start bot');
    } finally {
      setBusy(false);
    }
  }

  async function handleStop() {
    setBusy(true);
    setLocalError(null);
    try {
      await stopBot();
      localStorage.removeItem('nerodolla_bot_active');
      stopPolling();
      setBotStatus(prev => prev ? { ...prev, status: 'stopped', openOrderCount: 0 } : null);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to stop bot');
    } finally {
      setBusy(false);
    }
  }

  async function handleReRegisterKey() {
    if (!xmrKeys || !ethWallet) return;
    setBusy(true);
    setLocalError(null);
    try {
      const { newZkPrivKey, sessionToken } = await reRegisterZkKey(ethWallet.address, ethWallet.privateKey);
      await saveZkKey(ethWallet.privateKey, newZkPrivKey);
      setSessionToken(sessionToken);
      setProxySessionToken(sessionToken);
      await startBot(xmrKeys.primaryAddress, xmrKeys.viewKeyPrivate, xmrBalance);
      localStorage.setItem('nerodolla_bot_active', 'true');
      await fetchStatus();
      startPolling();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Key re-registration failed');
    } finally {
      setBusy(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const status = botStatus?.status ?? 'stopped';

  const badgeClass =
    reconnecting         ? 'bot-toggle__badge--reconnecting' :
    status === 'running' ? 'bot-toggle__badge--running' :
    status === 'paused'  ? 'bot-toggle__badge--paused' :
    status === 'error'   ? 'bot-toggle__badge--error' :
    'bot-toggle__badge--stopped';

  const badgeLabel =
    reconnecting         ? '◌ Reconnecting…' :
    status === 'running' ? '● LIVE' :
    status === 'paused'  ? '⏸ PAUSED' :
    status === 'error'   ? '✕ ERROR' :
    '○ Stopped';

  return (
    <div className="bot-toggle">
      <div className="bot-toggle__header">
        <span className="bot-toggle__title">Market Making Bot</span>
        <span className={`bot-toggle__badge ${badgeClass}`}>{badgeLabel}</span>
      </div>

      {isActive && botStatus && (
        <div className="bot-toggle__stats">
          {/* Position + Target on one line */}
          <div className="bot-toggle__stat-row">
            <span>Position</span>
            <span>
              {botStatus.currentPosition.toFixed(4)} XMR
              <span className="bot-toggle__target">
                {' '}(Target {botStatus.targetXmr.toFixed(4)})
              </span>
            </span>
          </div>

          {/* USDC collateral + Available on one line */}
          {hedgePosition && (
            <div className="bot-toggle__stat-row">
              <span>USDC</span>
              <span>
                ${(lighterUsdc ?? 0).toFixed(2)}
                <span className="bot-toggle__target">
                  {' '}(Avail ${botStatus.availableBalance.toFixed(2)})
                </span>
              </span>
            </div>
          )}

          {/* Earnings table */}
          {earnings && <EarningsTable earnings={earnings} />}
          {!earnings && (
            <div className="bot-toggle__earnings-loading">Loading earnings…</div>
          )}
        </div>
      )}

      {(status === 'error' || status === 'paused') && botStatus?.errorMsg && (
        <div className="bot-toggle__error">{botStatus.errorMsg}</div>
      )}

      {!isActive && status !== 'error' && (
        <p className="bot-toggle__desc">
          Place limit orders on both sides of the XMR/USD perp to earn spread
          income on top of funding payments.
        </p>
      )}

      {localError && (
        <div className="bot-toggle__error">{localError}</div>
      )}

      {isActive ? (
        <button className="btn btn--ghost bot-toggle__cta" onClick={handleStop} disabled={busy}>
          {busy ? 'Stopping…' : 'Stop Bot'}
        </button>
      ) : status === 'error' && botStatus?.errorMsg?.includes('21120') ? (
        <button className="btn btn--secondary bot-toggle__cta" onClick={handleReRegisterKey} disabled={busy}>
          {busy ? 'Re-registering…' : 'Re-register Key'}
        </button>
      ) : (
        <button className="btn btn--secondary bot-toggle__cta" onClick={handleStart} disabled={busy || reconnecting}>
          {busy ? 'Starting…' : 'Enable Bot'}
        </button>
      )}
    </div>
  );
}
