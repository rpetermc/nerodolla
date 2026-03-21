import { useEffect, useCallback, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { useWalletStore, useSettingsStore } from '../../store/wallet';
import { BalanceCard } from '../components/BalanceCard';
import { HedgeToggle } from '../components/HedgeToggle';
import { TxList } from '../components/TxList';
import { loginLws, getAddressInfo, getAddressTxs, createSubaddress } from '../../backend/lws';
import { getHedgeStatus, getXmrMarketInfo, closeHedgeAndWithdraw } from '../../backend/lighter';
import { fetchArbUsdcBalance } from '../../backend/wagyu';
import { initWasmWallet, syncWasmWallet, getWasmAddressInfo, getWasmTxs } from '../../backend/wasm-wallet';

export function HomeScreen() {
  const {
    xmrKeys,
    xmrInfo,
    ethWallet,
    swapStep,
    hedgeStatus,
    syncProgress,
    walletCreatedHeight,
    setSyncing,
    setSyncProgress,
    setXmrInfo,
    setTransactions,
    setLastSyncAt,
    setUsdcBalance,
    setHedgeStatus,
    setLighterMarket,
    setHedgeLoading,
    navigate,
  } = useWalletStore();

  const { xmrSyncMode, remoteLwsUrl, nodeUrl, walletRestoreHeight, lighterProxyUrl } = useSettingsStore();
  // On Android there is no Vite proxy — use the configured proxy server directly.
  const effectiveLwsUrl = Capacitor.isNativePlatform()
    ? `${lighterProxyUrl.replace(/\/$/, '')}/lws`
    : remoteLwsUrl;
  const [syncError, setSyncError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [isClosingHedge, setIsClosingHedge] = useState(false);

  const sync = useCallback(async () => {
    if (!xmrKeys) return;
    setSyncing(true);
    setSyncError(null);
    try {
      let info, txData;
      if (xmrSyncMode === 'wasm-node') {
        await initWasmWallet(
          xmrKeys.primaryAddress,
          xmrKeys.viewKeyPrivate,
          xmrKeys.spendKeyPrivate,
          walletCreatedHeight ?? walletRestoreHeight ?? 0,
          nodeUrl,
          (p) => setSyncProgress(p),
        );
        await syncWasmWallet();
        setSyncProgress(null);
        [info, txData] = await Promise.all([getWasmAddressInfo(), getWasmTxs()]);
      } else {
        const lwsCfg = { baseUrl: effectiveLwsUrl };
        await loginLws(lwsCfg, xmrKeys.primaryAddress, xmrKeys.viewKeyPrivate).catch(() => {});
        [info, txData] = await Promise.all([
          getAddressInfo(lwsCfg, xmrKeys.primaryAddress, xmrKeys.viewKeyPrivate),
          getAddressTxs(lwsCfg, xmrKeys.primaryAddress, xmrKeys.viewKeyPrivate),
        ]);
      }

      const [hedgeStatusResult, market] = await Promise.all([
        getHedgeStatus(ethWallet?.address).catch(() => null),
        getXmrMarketInfo().catch(() => null),
      ]);

      // Fetch Arbitrum USDC balance in the background (non-blocking)
      if (ethWallet) {
        fetchArbUsdcBalance(ethWallet.address)
          .then((bal) => setUsdcBalance(bal))
          .catch(() => {});
      }
      setXmrInfo(info);
      setTransactions(txData.transactions);
      setLastSyncAt(Date.now());
      if (hedgeStatusResult) setHedgeStatus(hedgeStatusResult);
      if (market) setLighterMarket(market);

      // Auto-rotate receive subaddress if it has been used.
      // Read current receive state directly from the store (not the closure) so
      // this check always uses the latest value without adding to deps.
      const { receiveAddress, receiveAddressIndex, setReceiveAddress } =
        useWalletStore.getState();
      if (receiveAddress && receiveAddressIndex > 0) {
        const usedAddresses = new Set(
          txData.transactions
            .filter((t) => t.isIncoming && t.subaddress)
            .map((t) => t.subaddress)
        );
        if (usedAddresses.has(receiveAddress)) {
          // Silently generate the next subaddress in the background
          createSubaddress(xmrKeys.primaryAddress, xmrKeys.viewKeyPrivate)
            .then(({ address, index }) => setReceiveAddress(address, index))
            .catch(() => {}); // best-effort; user can tap "New Address" manually
        }
      }
    } catch (err) {
      setSyncProgress(null);
      setSyncError(err instanceof Error ? err.message : 'Sync unavailable');
    } finally {
      setSyncing(false);
    }
  }, [xmrKeys, ethWallet, xmrSyncMode, effectiveLwsUrl, nodeUrl, walletRestoreHeight, setSyncing, setSyncProgress, setXmrInfo, setTransactions, setLastSyncAt, setUsdcBalance, setHedgeStatus, setLighterMarket]);

  // Initial sync + periodic refresh every 60 seconds
  useEffect(() => {
    sync();
    const interval = setInterval(sync, 60_000);
    return () => clearInterval(interval);
  }, [sync]);

  async function handleCloseHedge() {
    setIsClosingHedge(true);
    setConfirmClose(false);
    setHedgeLoading(true);
    try {
      const result = await closeHedgeAndWithdraw();
      if (!result.success) throw new Error(result.error ?? 'Close hedge failed');
      await sync();
    } catch (err) {
      console.error('Close hedge error:', err);
    } finally {
      setIsClosingHedge(false);
      setHedgeLoading(false);
    }
  }

  const isHedged = hedgeStatus?.isHedged ?? false;

  // Only show XMR balance once synced. While xmrInfo is null we're still loading.
  const xmrBalance = xmrInfo
    ? Number(xmrInfo.totalReceived - xmrInfo.totalSent) / 1e12
    : null;
  const hasXmr = xmrBalance !== null && xmrBalance > 0;
  const synced  = xmrInfo !== null;

  return (
    <div className="screen home-screen">
      {syncProgress && (
        <div className="wasm-sync-bar">
          <div className="wasm-sync-bar__label">
            Scanning blockchain… {syncProgress.percent}%
            <span className="wasm-sync-bar__heights">
              {syncProgress.current.toLocaleString()} / {syncProgress.target.toLocaleString()}
            </span>
          </div>
          <div className="wasm-sync-bar__track">
            <div className="wasm-sync-bar__fill" style={{ width: `${syncProgress.percent}%` }} />
          </div>
        </div>
      )}
      {syncError && (
        <div className="sync-error-bar" title={syncError}>
          ⚠ {syncError}
        </div>
      )}

      {swapStep === 'monitoring' && (
        <button className="swap-progress-banner" onClick={() => navigate('swap')}>
          ⇄ Swap in progress — tap to check status
        </button>
      )}

      <div className="home-screen__top">
        <BalanceCard onRefresh={sync} />

        {/* Hedge status takes priority — user may have 0 XMR after hedging */}
        {isHedged ? (
          <div className="hedge-status-bar">
            <div className="hedge-status-bar__left">
              <span className="hedge-status-bar__icon">&#x1F512;</span>
              <div>
                <div className="hedge-status-bar__title">
                  {hedgeStatus?.hedgeCurrency === 'EUR' ? 'EUR' : 'USD'} Value Locked
                </div>
                {hedgeStatus?.position && (
                  <div className="hedge-status-bar__detail">
                    {hedgeStatus.position.size.toFixed(4)} XMR short
                    &nbsp;&middot;&nbsp;
                    {hedgeStatus.position.annualizedFundingPct.toFixed(1)}% APY
                  </div>
                )}
              </div>
            </div>
            <div className="hedge-status-bar__right">
              {!confirmClose ? (
                <button
                  className="btn btn--ghost btn--sm"
                  onClick={() => navigate('hedge')}
                >
                  Manage
                </button>
              ) : (
                <div className="hedge-status-bar__confirm">
                  <button
                    className="btn btn--danger btn--sm"
                    onClick={handleCloseHedge}
                    disabled={isClosingHedge}
                  >
                    {isClosingHedge ? 'Closing…' : 'Confirm close'}
                  </button>
                  <button
                    className="btn btn--ghost btn--sm"
                    onClick={() => setConfirmClose(false)}
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          </div>
        ) : hasXmr ? (
          <HedgeToggle />
        ) : synced ? (
          <div className="home-screen__fund-prompt">
            <p>Add XMR to get started</p>
            <div className="home-screen__fund-actions">
              <button className="btn btn--primary" onClick={() => navigate('receive')}>
                Receive XMR
              </button>
              <button className="btn btn--ghost" onClick={() => navigate('swap')}>
                Swap crypto → XMR
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="home-screen__actions">
        <button className="action-btn" onClick={() => navigate('receive')}>
          <span className="action-btn__icon">↓</span>
          <span>Receive</span>
        </button>
        <button className="action-btn" onClick={() => navigate('send')}>
          <span className="action-btn__icon">↑</span>
          <span>Send</span>
        </button>
        <button className="action-btn" onClick={() => navigate('swap')}>
          <span className="action-btn__icon">⇄</span>
          <span>Swap</span>
        </button>
      </div>

      <TxList />
    </div>
  );
}
