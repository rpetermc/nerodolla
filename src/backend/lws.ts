/**
 * lws.ts — monero-lws (light wallet server) REST client
 *
 * monero-lws is the backend that scans the Monero blockchain for outputs
 * belonging to a given view key, providing balance and transaction history
 * without running a full node on the device.
 *
 * Public endpoints (fallback order):
 *   1. https://monero-lws.mymonero.com  (MyMonero hosted)
 *   2. https://lws.cake.tech           (Cake Wallet hosted)
 *
 * The user can configure a custom endpoint in Settings.
 *
 * API reference: https://github.com/vtnerd/monero-lws/blob/master/docs/api.md
 */

export const DEFAULT_LWS_ENDPOINTS = [
  'https://monero-lws.mymonero.com',
  'https://lws.cake.tech',
];

/**
 * Returns the proxy base URL when running as a native Capacitor app, otherwise
 * empty string so that existing relative-path fetch calls work unchanged in browser.
 *
 * On Android the WebView serves from capacitor://localhost so there is no dev
 * proxy — all calls to the lighter_proxy.py backend must use the full server URL.
 *
 * Reads lighterProxyUrl directly from the Zustand-persisted localStorage entry
 * to avoid a circular import (store/wallet.ts already imports from lws.ts for types).
 */
function proxyBase(): string {
  try {
    const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
    if (!cap?.isNativePlatform?.()) return '';
    const raw = localStorage.getItem('nerodolla-settings');
    const url: string = (JSON.parse(raw ?? '{}') as { state?: { lighterProxyUrl?: string } }).state?.lighterProxyUrl ?? (import.meta.env.VITE_PROXY_URL || 'http://localhost:8000');
    return url.replace(/\/$/, '');
  } catch {
    return '';
  }
}

export interface LwsConfig {
  baseUrl: string;
  timeoutMs?: number;
}

export interface LwsAddressInfo {
  totalReceived: bigint;    // picoXMR — sum of confirmed incoming transfers
  totalSent: bigint;        // picoXMR — sum of confirmed outgoing transfers + fees
  lockedFunds: bigint;      // confirmed but not yet spendable (1–9 confs, Monero 10-block lock)
  pendingBalance: bigint;   // unconfirmed incoming (0-conf, mempool/pool)
  spendableBalance: bigint; // immediately usable = totalReceived - totalSent - lockedFunds
  blockchainHeight: number;
  scanHeight: number;       // how far the LWS server has scanned for this account
}

export interface LwsTransaction {
  id: string;               // transaction hash
  timestamp: number;        // unix seconds
  height: number;           // block height (0 = mempool)
  totalReceived: bigint;    // picoXMR
  totalSent: bigint;
  fee: bigint;
  isIncoming: boolean;
  subaddress: string;       // subaddress that received the output (empty for outgoing)
  memo: string;
  paymentId: string;
  spentOutputs: Array<{ amount: bigint; txPubKey: string; keyImage: string }>;
}

export interface LwsRawTxInfo {
  txHash: string;
  txKey: string;
}

// ── Internal helpers ────────────────────────────────────────────────────────

async function lwsFetch<T>(
  config: LwsConfig,
  path: string,
  body: unknown
): Promise<T> {
  const url = `${config.baseUrl.replace(/\/$/, '')}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    config.timeoutMs ?? 15_000
  );

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LWS ${path} HTTP ${res.status}: ${text}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Register (or re-login) an account with the LWS server.
 * Must be called before get_address_info / get_address_txs.
 * The server stores only the view key — spend key never leaves the device.
 */
export async function loginLws(
  config: LwsConfig,
  address: string,
  viewKeyPrivate: string,
  createAccount = true
): Promise<{ newAccount: boolean }> {
  const data = await lwsFetch<{ new_account: boolean }>(
    config,
    '/login',
    { address, view_key: viewKeyPrivate, create_account: createAccount, generated_locally: true }
  );
  return { newAccount: data.new_account };
}

/**
 * Get balance and sync status for an address.
 */
export async function getAddressInfo(
  config: LwsConfig,
  address: string,
  viewKeyPrivate: string
): Promise<LwsAddressInfo> {
  const data = await lwsFetch<{
    total_received: string;
    total_sent: string;
    locked_funds: string;
    pending_balance?: string;
    blockchain_height: number;
    scanned_height: number;
    spent_outputs?: Array<{ amount: string; tx_pub_key: string; out_index: number; key_image: string }>;
  }>(config, '/get_address_info', { address, view_key: viewKeyPrivate });

  const totalReceived  = BigInt(data.total_received  ?? '0');
  const lockedFunds    = BigInt(data.locked_funds    ?? '0');
  const pendingBalance = BigInt(data.pending_balance ?? '0');

  // monero-lws can return duplicate spent_outputs (same tx_pub_key+out_index,
  // different key_image) when an account is re-registered. De-duplicate to get
  // the correct total_sent.
  let totalSent: bigint;
  if (data.spent_outputs?.length) {
    const seen = new Set<string>();
    let deduped = 0n;
    for (const so of data.spent_outputs) {
      const key = `${so.tx_pub_key}:${so.out_index}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped += BigInt(so.amount ?? '0');
      }
    }
    totalSent = deduped;
  } else {
    totalSent = BigInt(data.total_sent ?? '0');
  }

  return {
    totalReceived,
    totalSent,
    lockedFunds,
    pendingBalance,
    spendableBalance: totalReceived - totalSent - lockedFunds,
    blockchainHeight: data.blockchain_height,
    scanHeight: data.scanned_height,
  };
}

/**
 * Get transaction history for an address.
 */
export async function getAddressTxs(
  config: LwsConfig,
  address: string,
  viewKeyPrivate: string
): Promise<{ transactions: LwsTransaction[]; blockchainHeight: number }> {
  const data = await lwsFetch<{
    transactions?: Array<{
      id: string;
      timestamp: string | number;
      height: number;
      total_received: string;
      total_sent: string;
      fee: string;
      payment_id: string;
      address?: string;   // subaddress that received the output (wallet-rpc backend only)
      spent_outputs?: Array<{ amount: string; tx_pub_key: string; key_image: string }>;
    }>;
    blockchain_height: number;
  }>(config, '/get_address_txs', { address, view_key: viewKeyPrivate });

  const transactions: LwsTransaction[] = (data.transactions ?? []).map((tx) => ({
    id: tx.id,
    timestamp: typeof tx.timestamp === 'number'
      ? tx.timestamp
      : Math.floor(new Date(tx.timestamp).getTime() / 1000) || 0,
    height: tx.height,
    totalReceived: BigInt(tx.total_received ?? '0'),
    totalSent: BigInt(tx.total_sent ?? '0'),
    fee: BigInt(tx.fee ?? '0'),
    isIncoming: BigInt(tx.total_received ?? '0') > BigInt(tx.total_sent ?? '0'),
    subaddress: tx.address ?? '',
    memo: '',
    paymentId: tx.payment_id ?? '',
    spentOutputs: (tx.spent_outputs ?? []).map((o) => ({
      amount: BigInt(o.amount ?? '0'),
      txPubKey: o.tx_pub_key,
      keyImage: o.key_image,
    })),
  }));

  return { transactions, blockchainHeight: data.blockchain_height };
}

/**
 * Submit a signed raw transaction to the network via LWS.
 */
export async function submitRawTx(
  config: LwsConfig,
  tx: LwsRawTxInfo
): Promise<void> {
  await lwsFetch<void>(config, '/submit_raw_tx', {
    tx: tx.txHash,
    tx_key: tx.txKey,
  });
}

/**
 * Attempt to reach an LWS endpoint. Returns true if responsive.
 */
export async function pingLws(baseUrl: string, timeoutMs = 5_000): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/get_unspent_outs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: '', view_key: '', amount: '0', mixin: 0, use_dust: false, dust_threshold: '0' }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Any HTTP response means the server is up (monero-lws returns 500 for invalid test data)
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch the current Monero blockchain height from the local daemon via the proxy.
 * Used to record the wallet creation block for seed phrase backups.
 */
export async function getChainHeight(): Promise<number> {
  const res = await fetch(`${proxyBase()}/lws/height`);
  if (!res.ok) throw new Error(`getChainHeight failed: ${res.status}`);
  const data = await res.json();
  return data.height as number;
}

/**
 * Explicitly initialise the wallet-rpc wallet file for this address.
 *
 * Must be called immediately after key derivation during setup with the correct
 * restore_height so future syncs scan from the right block:
 *   - New wallet:  omit restoreHeight → records current chain height
 *   - Restore:     pass the height from the user's backup → scans from there
 */
export async function initWallet(
  address: string,
  viewKey: string,
  restoreHeight?: number,
): Promise<void> {
  const res = await fetch(`${proxyBase()}/lws/init_wallet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      address,
      view_key: viewKey,
      restore_height: restoreHeight ?? null,
    }),
  });
  if (!res.ok) throw new Error(`initWallet failed: ${await res.text()}`);
}

/**
 * Generate the next unused subaddress for this wallet via wallet-rpc.
 *
 * Monero subaddresses are derived deterministically from the view key.
 * They are unlinkable to the primary address and to each other from an
 * outside observer's perspective. All received outputs at any subaddress
 * are included in the primary address balance scan.
 *
 * Use a fresh subaddress for each incoming payment (Cake Wallet does this).
 */
export async function createSubaddress(
  address: string,
  viewKey: string
): Promise<{ address: string; index: number }> {
  const res = await fetch(`${proxyBase()}/lws/create_address`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, view_key: viewKey }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`create_address failed: ${body}`);
  }
  const data = await res.json();
  return { address: data.address, index: data.address_index };
}

/** Format picoXMR as a human-readable XMR string (12 decimal places). */
export function formatXmr(picoXmr: bigint): string {
  const xmr = Number(picoXmr) / 1e12;
  return xmr.toFixed(6);
}

/** Convert human-readable XMR string (e.g. "0.5") to picoXMR string. */
export function xmrToAtomic(xmrStr: string): string {
  const [whole, frac = ''] = xmrStr.split('.');
  const fracPadded = frac.padEnd(12, '0').slice(0, 12);
  return (BigInt(whole || '0') * 1_000_000_000_000n + BigInt(fracPadded || '0')).toString();
}

/**
 * Trigger a background wallet sync so it's ready when the user confirms a transfer.
 * Returns immediately — the sync runs asynchronously on the server.
 * Safe to call multiple times; idempotent.
 */
export async function presyncWallet(
  address: string,
  viewKey: string,
  restoreHeight?: number,
): Promise<void> {
  try {
    await fetch(`${proxyBase()}/lws/presync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        address,
        view_key: viewKey,
        ...(restoreHeight != null ? { restore_height: restoreHeight } : {}),
      }),
    });
  } catch {
    // Non-fatal — if this fails, the transfer will still trigger a sync
  }
}

/** Estimate network fee for a standard XMR transfer (no spend key required). */
export async function estimateFee(
  address: string,
  viewKey: string,
  destAddress: string,
  restoreHeight?: number,
): Promise<string> {
  const res = await fetch(`${proxyBase()}/lws/estimate_fee`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      address,
      view_key: viewKey,
      dest_address: destAddress,
      ...(restoreHeight != null ? { restore_height: restoreHeight } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Fee estimate failed: ${await res.text()}`);
  const { fee } = await res.json();
  return fee as string;
}

/**
 * Send XMR from the user's wallet to destAddress via the local wallet-rpc proxy.
 *
 * @param address     User's XMR primary address
 * @param viewKey     View-only private key (hex)
 * @param spendKey    Spend private key (hex) — required to sign the tx
 * @param destAddress XMR address to send to
 * @param amount      Exact amount in picoXMR (atomic string, e.g. "1000000000000")
 */
export async function transferXmr(
  address: string,
  viewKey: string,
  spendKey: string,
  destAddress: string,
  amount: string,
  restoreHeight?: number,
): Promise<{ txHash: string; amount: string; fee: string }> {
  const res = await fetch(`${proxyBase()}/lws/transfer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      address,
      view_key: viewKey,
      spend_key: spendKey,
      dest_address: destAddress,
      amount,
      ...(restoreHeight != null ? { restore_height: restoreHeight } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`XMR transfer failed: ${body}`);
  }
  return res.json();
}
