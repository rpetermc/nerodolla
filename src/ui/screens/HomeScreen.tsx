import { useEffect, useCallback, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { useWalletStore, useSettingsStore, saveWalletCache, loadWalletCache } from '../../store/wallet';
import { BalanceCard } from '../components/BalanceCard';
import { HedgeToggle } from '../components/HedgeToggle';
import { TxList } from '../components/TxList';
import { WalletSwitcher } from '../components/WalletSwitcher';
import { loginLws, getAddressInfo, getAddressTxs, createSubaddress } from '../../backend/lws';
import { getHedgeStatus, getXmrMarketInfo, closeHedgeAndWithdraw, setActiveSessionWallet, setProxySessionToken } from '../../backend/lighter';
import { fetchArbUsdcBalance } from '../../backend/wagyu';
import { initWasmWallet, syncWasmWallet, getWasmAddressInfo, getWasmTxs } from '../../backend/wasm-wallet';
import { AddWalletFlow } from '../components/AddWalletFlow';
import { loadKeystore, getWalletList } from '../../wallet/keystore';
import { mnemonicToSeed, xmrSeedFromMaster, ethSeedFromMaster } from '../../wallet/seed';
import { deriveXmrKeys } from '../../wallet/xmr';
import { deriveEthWallet } from '../../wallet/eth';

export function HomeScreen() {
  const {
    xmrKeys,
    xmrInfo,
    ethWallet,
    swapStep,
    hedgeStatus,
    syncProgress,
    walletCreatedHeight,
    activeWalletId,
    walletList,
    setSyncing,
    setSyncProgress,
    setXmrInfo,
    setTransactions,
    setLastSyncAt,
    setUsdcBalance,
    setHedgeStatus,
    setLighterMarket,
    setHedgeLoading,
    setKeys,
    setActiveWalletId,
    setWalletList,
    setSessionToken,
    navigate,
  } = useWalletStore();

  const { xmrSyncMode, remoteLwsUrl, nodeUrl, walletRestoreHeight, lighterProxyUrl, updateSettings } = useSettingsStore();
  // On Android there is no Vite proxy — use the configured proxy server directly.
  const effectiveLwsUrl = Capacitor.isNativePlatform()
    ? `${lighterProxyUrl.replace(/\/$/, '')}/lws`
    : remoteLwsUrl;
  const [syncError, setSyncError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [isClosingHedge, setIsClosingHedge] = useState(false);
  const [showSwitcher, setShowSwitcher] = useState(false);
  const [showAddWallet, setShowAddWallet] = useState(false);

  // Find active wallet label
  const activeWallet = walletList.find(w => w.id === activeWalletId);
  const walletLabel = activeWallet?.label ?? 'Wallet';
  const hasMultipleWallets = walletList.length > 1 || walletList.length === 1;

  const sync = useCallback(async () => {
    // Read keys and wallet ID from the store at call time (not closure) to
    // avoid stale-closure races when switching wallets.  The closure values
    // (xmrKeys, ethWallet) are still used as useCallback deps so the
    // interval resets on wallet change, but the *actual* data used inside
    // the function always comes from the store snapshot.
    const snap = useWalletStore.getState();
    const syncXmrKeys = snap.xmrKeys;
    const syncEthWallet = snap.ethWallet;
    const syncWalletId = snap.activeWalletId;
    if (!syncXmrKeys) return;
    setSyncing(true);
    setSyncError(null);
    try {
      let info, txData;
      if (xmrSyncMode === 'wasm-node') {
        await initWasmWallet(
          syncXmrKeys.primaryAddress,
          syncXmrKeys.viewKeyPrivate,
          syncXmrKeys.spendKeyPrivate,
          walletCreatedHeight ?? walletRestoreHeight ?? 0,
          nodeUrl,
          (p) => setSyncProgress(p),
        );
        await syncWasmWallet();
        setSyncProgress(null);
        [info, txData] = await Promise.all([getWasmAddressInfo(), getWasmTxs()]);
      } else {
        const lwsCfg = { baseUrl: effectiveLwsUrl };
        await loginLws(lwsCfg, syncXmrKeys.primaryAddress, syncXmrKeys.viewKeyPrivate).catch(() => {});
        [info, txData] = await Promise.all([
          getAddressInfo(lwsCfg, syncXmrKeys.primaryAddress, syncXmrKeys.viewKeyPrivate),
          getAddressTxs(lwsCfg, syncXmrKeys.primaryAddress, syncXmrKeys.viewKeyPrivate),
        ]);
      }

      const [hedgeStatusResult, market] = await Promise.all([
        getHedgeStatus(syncEthWallet?.address).catch((err) => {
          console.warn('[sync] getHedgeStatus failed:', err?.message ?? err);
          return null;
        }),
        getXmrMarketInfo().catch(() => null),
      ]);

      // Discard results if the user switched wallets while we were fetching
      const currentWalletId = useWalletStore.getState().activeWalletId;
      if (currentWalletId !== syncWalletId) {
        console.warn('[sync] wallet changed during sync, discarding results',
          { syncWalletId, currentWalletId });
        return;
      }

      console.log('[sync] writing results for wallet', syncWalletId?.slice(0, 8),
        'hedgeStatus:', hedgeStatusResult ? {
          isHedged: hedgeStatusResult.isHedged,
          lighterUsdc: hedgeStatusResult.lighterUsdc,
        } : null,
        'ethAddr:', syncEthWallet?.address?.slice(0, 10));

      // Fetch Arbitrum USDC balance in the background (non-blocking)
      if (syncEthWallet) {
        fetchArbUsdcBalance(syncEthWallet.address)
          .then((bal) => {
            // Guard against stale async result
            if (useWalletStore.getState().activeWalletId === syncWalletId) setUsdcBalance(bal);
          })
          .catch(() => {});
      }
      setXmrInfo(info);
      setTransactions(txData.transactions);
      setLastSyncAt(Date.now());
      setHedgeStatus(hedgeStatusResult ?? null);
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
          createSubaddress(syncXmrKeys.primaryAddress, syncXmrKeys.viewKeyPrivate)
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

  // ── Wallet switching ───────────────────────────────────────────────────────
  async function handleSwitchWallet(walletId: string) {
    if (walletId === activeWalletId) {
      setShowSwitcher(false);
      return;
    }

    // Save current wallet's cached state.
    // Do NOT cache hedgeStatus or lighterMarket — these are fetched fresh
    // from the proxy on sync and caching them risks cross-contamination
    // between wallets (the store may still hold data from a previous wallet).
    if (activeWalletId) {
      const state = useWalletStore.getState();
      saveWalletCache(activeWalletId, {
        xmrInfo: state.xmrInfo,
        transactions: state.transactions,
        lastSyncAt: state.lastSyncAt,
        ethBalanceEth: state.ethBalanceEth,
        usdcBalance: state.usdcBalance,
        hedgeStatus: null,
        lighterMarket: null,
        sessionToken: state.sessionToken,
        receiveAddress: state.receiveAddress,
        receiveAddressIndex: state.receiveAddressIndex,
      });
    }

    // Load new wallet's keys from in-memory cache
    // The PIN is already verified and all wallets were decrypted on unlock.
    // For now, we re-derive from the stored mnemonic using the cached PIN.
    try {
      const cachedPin = (window as unknown as { __nerodolla_pin?: string }).__nerodolla_pin;
      if (!cachedPin) throw new Error('PIN not cached');

      const mnemonic = await loadKeystore(cachedPin, walletId);
      const seed = await mnemonicToSeed(mnemonic);
      const xmrKeys = deriveXmrKeys(xmrSeedFromMaster(seed));
      const ethWallet = deriveEthWallet(ethSeedFromMaster(seed));

      // Set active wallet
      setActiveWalletId(walletId);
      setActiveSessionWallet(walletId);
      updateSettings({ lastActiveWalletId: walletId });

      // Clear stale state from previous wallet before restoring new one
      console.log('[switch] clearing state, switching from', activeWalletId?.slice(0, 8), 'to', walletId.slice(0, 8));
      const store = useWalletStore.getState();
      store.setHedgeStatus(null);
      store.setXmrInfo(null);
      store.setLighterMarket(null);
      store.setSessionToken(null);
      store.setReceiveAddress(null, 0);

      // Restore cached state if available
      const cached = loadWalletCache(walletId);
      console.log('[switch] cached state:', cached ? {
        hasXmrInfo: !!cached.xmrInfo,
        hasHedgeStatus: !!cached.hedgeStatus,
        hasLighterMarket: !!cached.lighterMarket,
        usdcBalance: cached.usdcBalance,
        hasSessionToken: !!cached.sessionToken,
        sessionTokenPrefix: cached.sessionToken?.slice(0, 8),
      } : null);
      if (cached) {
        if (cached.xmrInfo) store.setXmrInfo(cached.xmrInfo);
        if (cached.hedgeStatus) store.setHedgeStatus(cached.hedgeStatus);
        if (cached.lighterMarket) store.setLighterMarket(cached.lighterMarket);
        if (cached.usdcBalance) store.setUsdcBalance(cached.usdcBalance);
        if (cached.sessionToken) {
          store.setSessionToken(cached.sessionToken);
          setProxySessionToken(cached.sessionToken, walletId);
        }
      }

      // Activate keys (triggers balance sync via useEffect)
      setKeys(mnemonic, xmrKeys, ethWallet);
      setShowSwitcher(false);
    } catch (err) {
      console.error('Wallet switch failed:', err);
    }
  }

  const isHedged = hedgeStatus?.isHedged ?? false;

  // Only show XMR balance once synced. While xmrInfo is null we're still loading.
  const xmrBalance = xmrInfo
    ? Number(xmrInfo.totalReceived - xmrInfo.totalSent) / 1e12
    : null;
  const hasXmr = xmrBalance !== null && xmrBalance > 0;
  const synced  = xmrInfo !== null;

  if (showAddWallet) {
    const cachedPin = (window as unknown as { __nerodolla_pin?: string }).__nerodolla_pin;
    return (
      <AddWalletFlow
        pin={cachedPin ?? ''}
        onComplete={() => setShowAddWallet(false)}
        onCancel={() => setShowAddWallet(false)}
      />
    );
  }

  return (
    <div className="screen home-screen">
      {/* Wallet header — tap to open switcher */}
      {walletList.length > 0 && (
        <button
          className="wallet-header-btn"
          onClick={() => setShowSwitcher(true)}
        >
          <span className="wallet-header-btn__label">{walletLabel}</span>
          <span className="wallet-header-btn__chevron">▾</span>
        </button>
      )}

      {showSwitcher && (
        <WalletSwitcher
          onClose={() => setShowSwitcher(false)}
          onSwitch={handleSwitchWallet}
          onAddWallet={() => { setShowSwitcher(false); setShowAddWallet(true); }}
        />
      )}

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
                  {hedgeStatus?.hedgeCurrency ?? 'USD'} Value Locked
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
