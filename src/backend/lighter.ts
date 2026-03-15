/**
 * lighter.ts — Lighter.xyz position client
 *
 * Lighter is a ZK order book exchange. This client communicates with
 * the lightweight Python proxy (lighter_proxy.py) which handles Lighter
 * SDK calls server-side (the SDK uses ZK signing that may not be
 * straightforward in a browser context).
 *
 * Open question: If Lighter exposes secp256k1 API keys, signing can move
 * to ethers.js in-browser, eliminating the proxy. Check lighter_proxy.py
 * comments for details.
 *
 * Proxy base (local dev): http://localhost:8000/lighter
 * In production the proxy runs on the same origin via Vite's /lighter proxy.
 */

import { ethers } from 'ethers';

/** Returns the proxy root URL, absolute on Android, empty string in browser (uses relative URLs). */
export function getProxyBase(): string {
  try {
    const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
    if (!cap?.isNativePlatform?.()) return '';
    const raw = localStorage.getItem('nerodolla-settings');
    const url: string = (JSON.parse(raw ?? '{}') as { state?: { lighterProxyUrl?: string } }).state?.lighterProxyUrl ?? (import.meta.env.VITE_PROXY_URL || 'https://proxy.example.com');
    return url.replace(/\/$/, '');
  } catch {
    return '';
  }
}

/** Returns the proxy base for /lighter endpoints, absolute on Android, relative in browser. */
export function getLighterProxyBase(): string {
  return `${getProxyBase()}/lighter`;
}

/** @deprecated use getLighterProxyBase() for dynamic resolution */
export const LIGHTER_PROXY_BASE = '/lighter';

// ── Session token ─────────────────────────────────────────────────────────────

let _sessionToken: string | null = null;
let _sessionRenewer: (() => Promise<void>) | null = null;
let _renewingSession = false;

export function setProxySessionToken(token: string | null): void {
  _sessionToken = token;
  // Clear the auto-renewer when the session is revoked (e.g. on wallet lock).
  if (!token) _sessionRenewer = null;
}

/**
 * Register a callback that proxyFetch will invoke to transparently renew an
 * expired session on HTTP 401, then retry the original request once.
 * Pass null to deregister (called automatically by setProxySessionToken(null)).
 */
export function setSessionRenewer(fn: (() => Promise<void>) | null): void {
  _sessionRenewer = fn;
}

export interface LighterPosition {
  symbol: string;          // e.g. 'XMR-USD'
  side: 'LONG' | 'SHORT';
  size: number;            // in XMR
  entryPrice: number;      // USD per XMR
  markPrice: number;       // current mark price
  unrealizedPnl: number;   // USD
  marginUsed: number;      // USDC collateral in use
  fundingRate: number;     // current 8h funding rate (decimal, e.g. 0.0004)
  annualizedFundingPct: number; // funding * 3 * 365 * 100
  lockedUsdValue: number;  // entryPrice * size — effective USD lock value
}

export interface LighterAccount {
  address: string;
  usdcBalance: number;     // free USDC margin
  totalCollateral: number;
  positions: LighterPosition[];
}

export interface HedgeStatus {
  isHedged: boolean;
  position?: LighterPosition;
  lockedUsdValue?: number;
  fundingEarnedToday?: number; // USD
  lighterUsdc?: number;        // total USDC collateral on Lighter
}

// ── Internal ─────────────────────────────────────────────────────────────────

async function proxyFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${getLighterProxyBase()}${path}`;
  const makeHeaders = (): Record<string, string> => ({
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> ?? {}),
    ...(_sessionToken ? { 'X-Session-Token': _sessionToken } : {}),
  });

  let res = await fetch(url, { ...options, headers: makeHeaders() });

  // Auto-renew expired session (HTTP 401) and retry once.
  if (res.status === 401 && _sessionRenewer && !_renewingSession) {
    _renewingSession = true;
    try {
      await _sessionRenewer();
    } catch {
      // Renewal failed — fall through and throw the original 401 below.
    } finally {
      _renewingSession = false;
    }
    res = await fetch(url, { ...options, headers: makeHeaders() });
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Lighter proxy ${path} HTTP ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

// ── Account ───────────────────────────────────────────────────────────────────

/**
 * Get current Lighter account state (balances + open positions).
 */
export async function getLighterAccount(ethAddress?: string): Promise<LighterAccount> {
  const path = ethAddress
    ? `/account?eth_address=${encodeURIComponent(ethAddress)}`
    : '/account';
  return proxyFetch<LighterAccount>(path);
}

/**
 * Get the current hedge status — is a short open for XMR-USD?
 * Pass ethAddress to look up the user's own Lighter account.
 */
export async function getHedgeStatus(ethAddress?: string): Promise<HedgeStatus> {
  const account = await getLighterAccount(ethAddress);
  const xmrPos = account.positions.find(
    (p) => p.symbol === 'XMR-USD' && p.side === 'SHORT'
  );

  if (!xmrPos) {
    return { isHedged: false, lighterUsdc: account.totalCollateral };
  }

  return {
    isHedged: true,
    position: xmrPos,
    lockedUsdValue: xmrPos.lockedUsdValue,
    lighterUsdc: account.totalCollateral,
    fundingEarnedToday: undefined,
  };
}

// ── Hedge operations ──────────────────────────────────────────────────────────

export interface DepositAndHedgeParams {
  /** USDC amount to deposit (human-readable, e.g. "100.00") */
  usdcAmount: string;
  /** XMR amount to hedge (position size) — derived from usdcAmount / markPrice */
  xmrSize?: string;
  /** Slippage tolerance in bps (default 50 = 0.5%) */
  slippageBps?: number;
}

export interface HedgeResult {
  success: boolean;
  depositTxHash?: string;
  orderId?: string;
  filledSize?: number;
  avgPrice?: number;
  error?: string;
}

/**
 * Deposit USDC to Lighter and open a short XMR-USD position.
 * This is the "Lock USD Value" action.
 *
 * The proxy handles: deposit approval → Lighter deposit tx → open short order.
 */
export async function depositAndOpenHedge(
  params: DepositAndHedgeParams
): Promise<HedgeResult> {
  return proxyFetch<HedgeResult>('/hedge/open', {
    method: 'POST',
    body: JSON.stringify({
      usdc_amount: params.usdcAmount,
      xmr_size: params.xmrSize,
      slippage_bps: params.slippageBps ?? 50,
    }),
  });
}

/**
 * Close the XMR-USD short and withdraw USDC from Lighter.
 * This is the "Unlock USD Value" action.
 */
export async function closeHedgeAndWithdraw(): Promise<HedgeResult> {
  return proxyFetch<HedgeResult>('/hedge/close', { method: 'POST' });
}

export interface RebalanceResult {
  success: boolean;
  action: 'shorted_more' | 'closed_partial' | 'no_op' | '';
  deltaXmr: number;
  error?: string;
}

/** Adjust the short position to match xmrTarget (= current XMR wallet balance). */
export async function rebalanceHedge(xmrTarget: number): Promise<RebalanceResult> {
  const res = await proxyFetch<{
    success: boolean; action: string; delta_xmr: number; error?: string;
  }>('/hedge/rebalance', {
    method: 'POST',
    body: JSON.stringify({ xmr_target: xmrTarget }),
  });
  return { success: res.success, action: res.action as RebalanceResult['action'], deltaXmr: res.delta_xmr, error: res.error };
}

/**
 * Standalone withdrawal — use when position is already closed but USDC is
 * still sitting in Lighter (e.g. after a failed withdraw in a previous run).
 */
export async function withdrawUsdc(): Promise<HedgeResult> {
  return proxyFetch<HedgeResult>('/hedge/withdraw', { method: 'POST' });
}

// ── EIP-3009 relay (proxy wallet pays gas) ────────────────────────────────────

interface RelayAuth {
  from: string; to: string; value: string;
  validAfter: string; validBefore: string;
  nonce: string; v: number; r: string; s: string;
}

/** Submit a signed EIP-3009 USDC transfer via the proxy relay wallet. Returns task_id (tx hash). */
export async function relayUsdcTransfer(auth: RelayAuth, chain: 'arbitrum' | 'ethereum' = 'arbitrum'): Promise<string> {
  const res = await proxyFetch<{ task_id: string }>('/relay/usdc-transfer', {
    method: 'POST',
    body: JSON.stringify({
      from_addr:    auth.from,
      to_addr:      auth.to,
      value:        auth.value,
      valid_after:  auth.validAfter,
      valid_before: auth.validBefore,
      nonce:        auth.nonce,
      v:            auth.v,
      r:            auth.r,
      s:            auth.s,
      chain,
    }),
  });
  return res.task_id;
}

/** Poll relay task status by tx hash. */
export async function getRelayTaskStatus(
  taskId: string,
  chain: 'arbitrum' | 'ethereum' = 'arbitrum',
): Promise<{ taskState: string; txHash?: string; error?: string }> {
  const res = await proxyFetch<{ task_state: string; tx_hash?: string; error?: string }>(
    `/relay/task/${taskId}?chain=${chain}`,
  );
  return { taskState: res.task_state, txHash: res.tx_hash, error: res.error };
}

// ── Market data ───────────────────────────────────────────────────────────────

export interface LighterMarketInfo {
  symbol: string;
  markPrice: number;
  fundingRate8h: number;     // 8-hour funding rate
  annualizedFundingPct: number;
  openInterest: number;
  indexPrice: number;
}

/**
 * Get current XMR-USD market data from Lighter (via proxy).
 */
export async function getXmrMarketInfo(): Promise<LighterMarketInfo> {
  return proxyFetch<LighterMarketInfo>('/market/XMR-USD');
}

// ── Account setup ─────────────────────────────────────────────────────────────

export interface LighterSetupStatus {
  accountExists: boolean;
  accountIndex: number | null;
  hasApiKey: boolean;
  lighterAppUrl: string;
}

export interface LighterSigningData {
  messageToSign: string;
  txType: number;
  txInfo: string;
  accountIndex: number;
}

export interface LighterSetupResult {
  success: boolean;
  accountIndex: number;
  sessionToken?: string;
  error?: string;
}

/** Check whether a Lighter account exists for the given ETH address. */
export async function checkLighterSetup(ethAddress: string): Promise<LighterSetupStatus> {
  const res = await proxyFetch<{
    account_exists: boolean;
    account_index: number | null;
    has_api_key: boolean;
    lighter_app_url: string;
  }>(`/setup/status?eth_address=${encodeURIComponent(ethAddress)}`);
  return {
    accountExists: res.account_exists,
    accountIndex: res.account_index,
    hasApiKey: res.has_api_key,
    lighterAppUrl: res.lighter_app_url,
  };
}

/** Generate (or retrieve) the ZK API keypair. Returns the private key once — store it encrypted. */
export async function generateLighterZkKey(ethAddress: string): Promise<{ zkPublicKey: string; zkPrivateKey: string; alreadyExists: boolean }> {
  const res = await proxyFetch<{ zk_public_key: string; zk_private_key: string; already_exists: boolean }>(
    '/setup/generate-key',
    { method: 'POST', body: JSON.stringify({ eth_address: ethAddress }) }
  );
  return { zkPublicKey: res.zk_public_key, zkPrivateKey: res.zk_private_key, alreadyExists: res.already_exists };
}

/** Get the message the user must sign to register their ZK key. */
export async function getLighterSigningMessage(ethAddress: string): Promise<LighterSigningData> {
  const res = await proxyFetch<{
    message_to_sign: string;
    tx_type: number;
    tx_info: string;
    account_index: number;
  }>('/setup/signing-message', {
    method: 'POST',
    body: JSON.stringify({ eth_address: ethAddress }),
  });
  return {
    messageToSign: res.message_to_sign,
    txType: res.tx_type,
    txInfo: res.tx_info,
    accountIndex: res.account_index,
  };
}

/** Submit the ETH signature to complete ZK key registration. */
export async function completeLighterSetup(params: {
  ethAddress: string;
  l1Signature: string;
  txType: number;
  txInfo: string;
  accountIndex: number;
}): Promise<LighterSetupResult> {
  const res = await proxyFetch<{ success: boolean; account_index: number; session_token?: string; error?: string }>(
    '/setup/complete',
    {
      method: 'POST',
      body: JSON.stringify({
        eth_address: params.ethAddress,
        l1_signature: params.l1Signature,
        tx_type: params.txType,
        tx_info: params.txInfo,
        account_index: params.accountIndex,
      }),
    }
  );
  return { success: res.success, accountIndex: res.account_index, sessionToken: res.session_token, error: res.error };
}

// ── Session management ────────────────────────────────────────────────────────

/** Fetch a one-time nonce for session authentication. */
/**
 * One-time migration: reads the ZK key from the legacy .lighter_setup.json on
 * the proxy server and returns it so the browser can save it to localStorage.
 * After this succeeds, future sessions use the stored key and this is never needed again.
 */
export async function migrateLegacyZkKey(ethAddress: string, ethPrivKey: string): Promise<string> {
  const nonce = await getSessionNonce(ethAddress);
  const signer = new ethers.Wallet(ethPrivKey);
  const signature = await signer.signMessage(`Nerodolla session\n${nonce}`);
  const res = await proxyFetch<{ zk_private_key: string }>(
    '/setup/migrate-legacy-key',
    {
      method: 'POST',
      body: JSON.stringify({ eth_address: ethAddress, signature }),
    }
  );
  return res.zk_private_key;
}

export async function getSessionNonce(ethAddress: string): Promise<string> {
  const res = await proxyFetch<{ nonce: string }>(
    `/session/nonce?eth_address=${encodeURIComponent(ethAddress)}`
  );
  return res.nonce;
}

/**
 * Initialise a server-side session by proving ownership of the ETH address and
 * supplying the ZK private key for this session.
 * Returns the session token to include in subsequent requests.
 */
export async function initLighterSession(
  ethAddress: string,
  ethPrivKey: string,
  zkPrivKey: string,
): Promise<string> {
  const nonce = await getSessionNonce(ethAddress);
  const signer = new ethers.Wallet(ethPrivKey);
  const signature = await signer.signMessage(`Nerodolla session\n${nonce}`);
  const res = await proxyFetch<{ session_token: string; expires_at: number }>(
    '/session/init',
    {
      method: 'POST',
      body: JSON.stringify({ eth_address: ethAddress, signature, zk_private_key: zkPrivKey }),
    }
  );
  return res.session_token;
}

// ── Deposit status ────────────────────────────────────────────────────────────

export interface LighterDepositStatus {
  status: 'pending' | 'confirmed' | 'not_found';
  amountUsdc: number | null;
  txHash: string | null;
  createdAt: number | null; // Unix timestamp seconds
}

/** Check the latest deposit status for an ETH address. */
export async function getDepositStatus(ethAddress: string): Promise<LighterDepositStatus> {
  const res = await proxyFetch<{
    status: string;
    amount_usdc: number | null;
    tx_hash: string | null;
    created_at: number | null;
  }>(`/deposit/status?eth_address=${encodeURIComponent(ethAddress)}`);
  return {
    status: res.status as LighterDepositStatus['status'],
    amountUsdc: res.amount_usdc,
    txHash: res.tx_hash,
    createdAt: res.created_at ?? null,
  };
}

/** Annualize an 8-hour funding rate. */
export function annualizeFundingRate(rate8h: number): number {
  return rate8h * 3 * 365 * 100; // percent
}

/**
 * Estimate daily funding income for a given USD position size and funding rate.
 */
export function estimateDailyFunding(
  usdPositionSize: number,
  rate8h: number
): number {
  return usdPositionSize * rate8h * 3; // 3 funding periods per day
}

// ── MM-Bot API ────────────────────────────────────────────────────────────────

export interface BotStatus {
  status: 'running' | 'paused' | 'stopped' | 'error';
  targetXmr: number;
  currentPosition: number;
  availableBalance: number;
  collateral: number;
  /** FIFO-matched spread income since bot start — directional PnL stripped out */
  realizedSpread: number;
  /** FIFO-matched spread income for yesterday UTC (midnight → midnight) */
  spread24h: number;
  openOrderCount: number;
  lastMarkPrice: number;
  lastUpdate: number;
  errorMsg: string | null;
  iteration: number;
  startedAt: number;
}

/** Start the market-making bot for the current session. */
export async function startBot(
  xmrAddress: string,
  viewKey: string,
  xmrBalance: number,
): Promise<{ started: boolean; targetXmr: number }> {
  const res = await proxyFetch<{ started: boolean; target_xmr: number }>('/bot/start', {
    method: 'POST',
    body: JSON.stringify({ xmr_address: xmrAddress, view_key: viewKey, xmr_balance: xmrBalance }),
  });
  return { started: res.started, targetXmr: res.target_xmr };
}

/** Stop the market-making bot and cancel all open orders. */
export async function stopBot(): Promise<{ stopped: boolean }> {
  const res = await proxyFetch<{ stopped: boolean }>('/bot/stop', { method: 'POST' });
  return { stopped: res.stopped };
}

/**
 * Re-register the ZK API key for the given ETH address.
 * Generates a new key pair, submits a ChangePubKey tx to replace the current
 * registered key, and creates a fresh session.
 * Call this when the bot reports a signing error (code 21120).
 */
export async function reRegisterZkKey(
  ethAddress: string,
  ethPrivKey: string,
): Promise<{ newZkPrivKey: string; sessionToken: string }> {
  // 1. Generate a new ZK key pair (stored in proxy's _pending_setups)
  const { zkPrivateKey: newZkPrivKey } = await generateLighterZkKey(ethAddress);
  if (!newZkPrivKey) throw new Error('ZK key generation failed');

  // 2. Get the signing message (ChangePubKey tx) for the new key
  const sd = await getLighterSigningMessage(ethAddress);

  // 3. Sign with the ETH private key
  const signer = new ethers.Wallet(ethPrivKey);
  const l1Sig = await signer.signMessage(sd.messageToSign);

  // 4. Complete setup — registers the new key on Lighter and creates a session
  const result = await completeLighterSetup({
    ethAddress,
    l1Signature: l1Sig,
    txType: sd.txType,
    txInfo: sd.txInfo,
    accountIndex: sd.accountIndex,
  });
  if (!result.success) throw new Error(result.error ?? 'Key re-registration failed');
  if (!result.sessionToken) throw new Error('No session token returned after re-registration');

  return { newZkPrivKey, sessionToken: result.sessionToken };
}

export interface BotEarnings {
  spread1d: number;
  spread7d: number;
  spread30d: number;
  spreadTotal: number;
  funding1d: number;
  funding7d: number;
  funding30d: number;
  fundingTotal: number;
  firstFillAt: number; // Unix seconds of first recorded fill (0 = no fills yet)
}

export async function getBotEarnings(): Promise<BotEarnings> {
  const res = await proxyFetch<{
    spread_1d: number; spread_7d: number; spread_30d: number; spread_total: number;
    funding_1d: number; funding_7d: number; funding_30d: number; funding_total: number;
    first_fill_at: number;
  }>('/bot/earnings');
  return {
    spread1d: res.spread_1d, spread7d: res.spread_7d,
    spread30d: res.spread_30d, spreadTotal: res.spread_total,
    funding1d: res.funding_1d, funding7d: res.funding_7d,
    funding30d: res.funding_30d, fundingTotal: res.funding_total,
    firstFillAt: res.first_fill_at,
  };
}

/** Get current bot state. */
export async function getBotStatus(): Promise<BotStatus> {
  const res = await proxyFetch<{
    status: string; target_xmr: number; current_position: number;
    available_balance: number; collateral: number; realized_spread: number;
    spread_24h: number;
    open_order_count: number; last_mark_price: number; last_update: number;
    error_msg: string | null; iteration: number; started_at: number;
  }>('/bot/status');
  return {
    status: res.status as BotStatus['status'],
    targetXmr: res.target_xmr,
    currentPosition: res.current_position,
    availableBalance: res.available_balance,
    collateral: res.collateral,
    realizedSpread: res.realized_spread,
    spread24h: res.spread_24h,
    openOrderCount: res.open_order_count,
    lastMarkPrice: res.last_mark_price,
    lastUpdate: res.last_update,
    errorMsg: res.error_msg,
    iteration: res.iteration,
    startedAt: res.started_at,
  };
}

// ── Chain balance helpers (routed through proxy for Android reliability) ───────

/**
 * Fetch Ethereum mainnet USDC balance via the proxy.
 * More reliable on Android than a direct Ankr RPC call from the WebView.
 */
export async function fetchEthUsdcBalanceProxy(address: string): Promise<number> {
  const url = `${getProxyBase()}/eth/usdc-balance?eth_address=${encodeURIComponent(address)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`eth/usdc-balance ${res.status}`);
  const data = await res.json() as { balance_usdc: number };
  return data.balance_usdc;
}
