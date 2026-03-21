/**
 * wasm-wallet.ts — Client-side Monero wallet scanning via monero-ts WASM
 *
 * Used when xmrSyncMode === 'wasm-node'. The view key never leaves the browser;
 * scanning happens entirely in WASM against a remote full node.
 *
 * Spending still goes through the proxy (lighter_proxy.py → wallet-rpc) since
 * that requires the spend key and a separate signing flow.
 *
 * Wallet state is cached in IndexedDB so subsequent syncs start from the last
 * scanned height rather than the restore height.
 */

import type { LwsAddressInfo, LwsTransaction } from './lws';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SyncProgress {
  current: number;
  target: number;
  percent: number;
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _wallet: unknown = null;
let _nodeUrl = '';
const IDB_DB = 'nerodolla-wasm';
const IDB_STORE = 'wallet-cache';
const IDB_KEY_KEYS = 'keys-v3';   // wallet key data (address, view/spend keys)
const IDB_KEY_CACHE = 'cache-v3'; // blockchain scan cache (sync position + outputs)

// ── IndexedDB helpers ─────────────────────────────────────────────────────────

async function idbSave(key: string, data: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => {
      const tx = req.result.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(data, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

async function idbLoad(key: string): Promise<Uint8Array | null> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => {
      const tx = req.result.transaction(IDB_STORE, 'readonly');
      const get = tx.objectStore(IDB_STORE).get(key);
      get.onsuccess = () => resolve(get.result ?? null);
      get.onerror = () => reject(get.error);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function clearWasmCache(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => {
      const tx = req.result.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

// ── Core API ──────────────────────────────────────────────────────────────────

/**
 * Initialise (or re-use) the WASM wallet. On first call creates a view-only
 * wallet from the user's keys. On subsequent calls with the same nodeUrl the
 * existing instance is returned immediately (no re-sync needed).
 *
 * Lazy-imports monero-ts so the ~15 MB WASM is only loaded when this mode
 * is actually selected.
 */
export async function initWasmWallet(
  address: string,
  viewKey: string,
  spendKey: string,
  restoreHeight: number,
  nodeUrl: string,
  onProgress?: (p: SyncProgress) => void
): Promise<void> {
  // Re-use existing wallet if already initialised for this node
  if (_wallet && _nodeUrl === nodeUrl) return;

  // Close any previous wallet
  if (_wallet) {
    await (_wallet as { close: () => Promise<void> }).close();
    _wallet = null;
  }

  // Lazy-load monero-ts (~15 MB WASM)
  const moneroTs = await import('monero-ts');

  const server = { uri: nodeUrl, rejectUnauthorized: false };

  // Try to restore from cached wallet data (keys + blockchain cache) for faster sync
  const [cachedKeys, cachedCache] = await Promise.all([
    idbLoad(IDB_KEY_KEYS),
    idbLoad(IDB_KEY_CACHE),
  ]);

  let wallet: unknown;
  if (cachedKeys) {
    try {
      wallet = await moneroTs.openWalletFull({
        networkType: moneroTs.MoneroNetworkType.MAINNET,
        password: '',
        keysData: cachedKeys,
        cacheData: cachedCache ?? undefined,
        server,
      });
    } catch {
      // Cache corrupt or incompatible — fall through to fresh creation
      wallet = null;
    }
  }

  if (!wallet) {
    wallet = await moneroTs.createWalletFull({
      networkType: moneroTs.MoneroNetworkType.MAINNET,
      primaryAddress: address,
      privateViewKey: viewKey,
      privateSpendKey: spendKey,
      restoreHeight,
      server,
    });
  }

  // Attach sync progress listener
  if (onProgress) {
    const listener = new moneroTs.MoneroWalletListener();
    listener.onSyncProgress = async (
      height: number,
      _startHeight: number,
      endHeight: number,
      percentDone: number,
      _message: string
    ) => {
      onProgress({ current: height, target: endHeight, percent: Math.round(percentDone * 100) });
    };
    await (wallet as { addListener: (l: unknown) => Promise<void> }).addListener(listener);
  }

  _wallet = wallet;
  _nodeUrl = nodeUrl;
}

/**
 * Sync to chain tip. Saves wallet data to IndexedDB on completion so the next
 * sync starts from the current height rather than the restore height.
 */
export async function syncWasmWallet(): Promise<void> {
  if (!_wallet) throw new Error('WASM wallet not initialised');
  const w = _wallet as {
    sync: () => Promise<void>;
    getKeysData: () => Promise<Uint8Array>;
    getCacheData: () => Promise<Uint8Array>;
  };
  await w.sync();
  try {
    const [keysData, cacheData] = await Promise.all([
      w.getKeysData(),
      w.getCacheData(),
    ]);
    await Promise.all([
      idbSave(IDB_KEY_KEYS, keysData),
      idbSave(IDB_KEY_CACHE, cacheData),
    ]);
  } catch {
    // Non-fatal — cache write failure just means slower next sync
  }
}

/**
 * Get balance info in LwsAddressInfo format.
 */
export async function getWasmAddressInfo(): Promise<LwsAddressInfo> {
  if (!_wallet) throw new Error('WASM wallet not initialised');
  const w = _wallet as {
    getBalance: (account: number) => Promise<bigint>;
    getUnlockedBalance: (account: number) => Promise<bigint>;
    getHeight: () => Promise<number>;
    getDaemonHeight: () => Promise<number>;
  };

  const [balance, unlocked, scanHeight, chainHeight] = await Promise.all([
    w.getBalance(0),
    w.getUnlockedBalance(0),
    w.getHeight(),
    w.getDaemonHeight(),
  ]);

  // getBalance() already returns the net balance (received - spent).
  // Summing tx amounts overcounts because change outputs inflate totalReceived.
  return {
    totalReceived: balance,
    totalSent: 0n,
    lockedFunds: balance - unlocked,
    pendingBalance: 0n,
    spendableBalance: unlocked,
    blockchainHeight: chainHeight,
    scanHeight,
  };
}

/**
 * Get transaction history in LwsTransaction format.
 */
export async function getWasmTxs(): Promise<{ transactions: LwsTransaction[]; blockchainHeight: number }> {
  if (!_wallet) throw new Error('WASM wallet not initialised');
  const w = _wallet as {
    getTxs: () => Promise<unknown[]>;
    getDaemonHeight: () => Promise<number>;
  };

  const [rawTxs, chainHeight] = await Promise.all([w.getTxs(), w.getDaemonHeight()]);

  const transactions: LwsTransaction[] = (rawTxs as Array<{
    getHash?: () => string;
    getBlock?: () => { getTimestamp?: () => number; getHeight?: () => number } | undefined;
    getHeight?: () => number | undefined;
    getIncomingTransfers?: () => Array<{ getAmount?: () => bigint; getAddress?: () => string }> | undefined;
    getOutgoingTransfer?: () => { getAmount?: () => bigint } | undefined;
    getFee?: () => bigint | undefined;
    isIncoming?: boolean | (() => boolean);
    getPaymentId?: () => string | undefined;
  }>).map((tx) => {
    const inTransfers = tx.getIncomingTransfers?.() ?? [];
    const incoming = inTransfers.reduce((sum, t) => sum + (t.getAmount?.() ?? 0n), 0n);
    const outgoing = tx.getOutgoingTransfer?.()?.getAmount?.() ?? 0n;
    const fee = tx.getFee?.() ?? 0n;
    const isIncoming = tx.isIncoming == null
      ? incoming > 0n
      : typeof tx.isIncoming === 'function'
        ? tx.isIncoming()
        : Boolean(tx.isIncoming);
    const subaddress = inTransfers[0]?.getAddress?.() ?? '';
    // Timestamp lives on the block in monero-ts, not directly on the tx
    const timestamp = tx.getBlock?.()?.getTimestamp?.() ?? 0;
    const height = tx.getBlock?.()?.getHeight?.() ?? tx.getHeight?.() ?? 0;

    return {
      id: tx.getHash?.() ?? '',
      timestamp,
      height,
      totalReceived: incoming,
      totalSent: outgoing + fee,
      fee,
      isIncoming,
      subaddress,
      memo: '',
      paymentId: tx.getPaymentId?.() ?? '',
      spentOutputs: [],
    };
  });

  return { transactions, blockchainHeight: chainHeight };
}

/**
 * Close the wallet and release WASM resources.
 */
export async function closeWasmWallet(): Promise<void> {
  if (_wallet) {
    await (_wallet as { close: () => Promise<void> }).close();
    _wallet = null;
    _nodeUrl = '';
  }
}
