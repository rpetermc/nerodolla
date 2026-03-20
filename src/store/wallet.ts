/**
 * wallet.ts — Zustand global store
 *
 * Centralises all app state: wallet keys, balances, swap state, hedge state.
 * Sensitive key material is held in-memory only; persisted fields (settings)
 * use localStorage via Zustand's persist middleware.
 *
 * Structure:
 *   WalletStore  — key material + runtime state (NOT persisted)
 *   SettingsStore — user preferences (persisted to localStorage)
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { XmrKeys } from '../wallet/xmr';
import type { EthWallet } from '../wallet/eth';
import type { LwsAddressInfo, LwsTransaction } from '../backend/lws';
import type { WagyuOrder } from '../backend/wagyu';
import type { HedgeStatus, LighterMarketInfo } from '../backend/lighter';
import type { SyncProgress } from '../backend/wasm-wallet';
import type { SignClientTypes, SessionTypes } from '@walletconnect/types';

// ── Swap persistence ───────────────────────────────────────────────────────────
// Swap order IDs are safe to persist (no sensitive data).
// Orders expire after ~2h on wagyu; we keep for 8h in case of slow bridging.

const SWAP_PERSIST_KEY = 'nerodolla_pending_swap';
const SWAP_PERSIST_TTL = 8 * 60 * 60 * 1000; // 8 hours

function saveSwapState(orders: WagyuOrder[]) {
  try {
    localStorage.setItem(SWAP_PERSIST_KEY, JSON.stringify({ orders, savedAt: Date.now() }));
  } catch { /* ignore */ }
}

function loadSwapState(): { swapOrders: WagyuOrder[]; swapStep: SwapStep } | null {
  try {
    const raw = localStorage.getItem(SWAP_PERSIST_KEY);
    if (!raw) return null;
    const { orders, savedAt } = JSON.parse(raw) as { orders: WagyuOrder[]; savedAt: number };
    if (!orders?.length || Date.now() - savedAt > SWAP_PERSIST_TTL) {
      localStorage.removeItem(SWAP_PERSIST_KEY);
      return null;
    }
    return { swapOrders: orders, swapStep: 'monitoring' };
  } catch { return null; }
}

function clearSwapState() {
  try { localStorage.removeItem(SWAP_PERSIST_KEY); } catch { /* ignore */ }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type AppScreen = 'home' | 'send' | 'receive' | 'swap' | 'hedge' | 'settings' | 'setup' | 'deposit';

// WalletConnect event types (re-exported for convenience)
export type WcProposalEvent = SignClientTypes.EventArguments['session_proposal'];
export type WcRequestEvent  = SignClientTypes.EventArguments['session_request'];

export type SwapStep =
  | 'idle'        // amount input
  | 'quoting'     // fetching quote
  | 'confirm'     // showing quote, waiting for user to confirm
  | 'sending'     // broadcasting XMR tx via wallet-rpc
  | 'monitoring'  // XMR sent, polling wagyu order status
  | 'complete'
  | 'error';

export interface WalletState {
  // ── Wallet keys (in-memory only, never serialised) ──
  isUnlocked: boolean;
  mnemonic: string | null;
  xmrKeys: XmrKeys | null;
  ethWallet: EthWallet | null;

  // ── XMR balance ──
  xmrInfo: LwsAddressInfo | null;
  transactions: LwsTransaction[];
  lastSyncAt: number | null;
  isSyncing: boolean;

  // ── ETH / HL balance ──
  ethBalanceEth: string | null;
  usdcBalance: string | null;

  // ── Wallet creation metadata ──
  walletCreatedHeight: number | null;  // chain height recorded at wallet creation time

  // ── Receive subaddress ──
  receiveAddress: string | null;   // current subaddress shown on the Receive screen
  receiveAddressIndex: number;     // 0 = primary address, 1+ = subaddress

  // ── Swap state ──
  swapStep: SwapStep;
  // swapOrders[0] = main USDC order; swapOrders[1] = ETH gas order (first swap only)
  swapOrders: WagyuOrder[];
  swapError: string | null;

  // ── WASM sync progress ──
  syncProgress: SyncProgress | null;

  // ── Hedge state ──
  hedgeStatus: HedgeStatus | null;
  lighterMarket: LighterMarketInfo | null;
  isHedgeLoading: boolean;

  // ── Lighter session ──
  sessionToken: string | null;

  // ── WalletConnect ──
  wcSession: SessionTypes.Struct | null;
  wcPendingProposal: WcProposalEvent | null;
  wcPendingRequest: WcRequestEvent | null;

  // ── UI ──
  activeScreen: AppScreen;
  error: string | null;
}

export interface WalletActions {
  // Wallet lifecycle
  setKeys: (mnemonic: string, xmrKeys: XmrKeys, ethWallet: EthWallet) => void;
  lock: () => void;

  // Balances
  setSyncProgress: (progress: SyncProgress | null) => void;
  setXmrInfo: (info: LwsAddressInfo) => void;
  setTransactions: (txs: LwsTransaction[]) => void;
  setSyncing: (syncing: boolean) => void;
  setLastSyncAt: (ts: number) => void;
  setEthBalance: (eth: string) => void;
  setUsdcBalance: (usdc: string) => void;

  // Wallet creation metadata
  setWalletCreatedHeight: (height: number) => void;

  // Receive
  setReceiveAddress: (address: string, index: number) => void;

  // Swap
  setSwapStep: (step: SwapStep) => void;
  setSwapOrders: (orders: WagyuOrder[]) => void;
  setSwapError: (err: string | null) => void;
  clearSwap: () => void;

  // Hedge
  setHedgeStatus: (status: HedgeStatus | null) => void;
  setLighterMarket: (market: LighterMarketInfo | null) => void;
  setHedgeLoading: (loading: boolean) => void;

  // Lighter session
  setSessionToken: (token: string | null) => void;

  // WalletConnect
  setWcSession: (session: SessionTypes.Struct | null) => void;
  setWcPendingProposal: (proposal: WcProposalEvent | null) => void;
  setWcPendingRequest: (request: WcRequestEvent | null) => void;

  // UI
  navigate: (screen: AppScreen) => void;
  setError: (err: string | null) => void;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useWalletStore = create<WalletState & WalletActions>()((set) => ({
  // Initial state
  isUnlocked: false,
  mnemonic: null,
  xmrKeys: null,
  ethWallet: null,

  xmrInfo: null,
  transactions: [],
  lastSyncAt: null,
  isSyncing: false,

  ethBalanceEth: null,
  usdcBalance: null,

  walletCreatedHeight: null,

  receiveAddress: null,
  receiveAddressIndex: 0,

  swapStep: 'idle',
  swapOrders: [],
  swapError: null,

  syncProgress: null,

  hedgeStatus: null,
  lighterMarket: null,
  isHedgeLoading: false,

  sessionToken: null,

  wcSession: null,
  wcPendingProposal: null,
  wcPendingRequest: null,

  activeScreen: 'setup',
  error: null,

  // Actions
  setKeys: (mnemonic, xmrKeys, ethWallet) => {
    // Restore any in-flight swap so monitoring resumes after re-login
    const restored = loadSwapState();
    set({ isUnlocked: true, mnemonic, xmrKeys, ethWallet, activeScreen: 'home', ...restored });
  },

  lock: () =>
    set({
      isUnlocked: false,
      mnemonic: null,
      xmrKeys: null,
      ethWallet: null,
      xmrInfo: null,
      transactions: [],
      lastSyncAt: null,
      ethBalanceEth: null,
      usdcBalance: null,
      walletCreatedHeight: null,
      receiveAddress: null,
      receiveAddressIndex: 0,
      syncProgress: null,
      hedgeStatus: null,
      lighterMarket: null,
      sessionToken: null,
      activeScreen: 'setup',
    }),

  setSyncProgress: (progress) => set({ syncProgress: progress }),
  setXmrInfo: (info) => set({ xmrInfo: info }),
  setTransactions: (txs) => set({ transactions: txs }),
  setSyncing: (syncing) => set({ isSyncing: syncing }),
  setLastSyncAt: (ts) => set({ lastSyncAt: ts }),
  setEthBalance: (eth) => set({ ethBalanceEth: eth }),
  setUsdcBalance: (usdc) => set({ usdcBalance: usdc }),

  setWalletCreatedHeight: (height) => set({ walletCreatedHeight: height }),

  setReceiveAddress: (address, index) => set({ receiveAddress: address, receiveAddressIndex: index }),

  setSwapStep: (step) => set({ swapStep: step }),
  setSwapOrders: (orders) => {
    if (orders.length > 0) saveSwapState(orders);
    set({ swapOrders: orders });
  },
  setSwapError: (err) => set({ swapError: err }),
  clearSwap: () => {
    clearSwapState();
    set({ swapStep: 'idle', swapOrders: [], swapError: null });
  },

  setHedgeStatus: (status) => set({ hedgeStatus: status }),
  setLighterMarket: (market) => set({ lighterMarket: market }),
  setHedgeLoading: (loading) => set({ isHedgeLoading: loading }),

  setSessionToken: (token) => set({ sessionToken: token }),

  setWcSession: (session) => set({ wcSession: session }),
  setWcPendingProposal: (proposal) => set({ wcPendingProposal: proposal }),
  setWcPendingRequest: (request) => set({ wcPendingRequest: request }),

  navigate: (screen) => set({ activeScreen: screen }),
  setError: (err) => set({ error: err }),
}));

// ── Settings store (persisted) ────────────────────────────────────────────────

export type XmrSyncMode = 'remote-lws' | 'wasm-node';

export interface SettingsState {
  lwsEndpoint: string;           // kept for migration compat
  xmrSyncMode: XmrSyncMode;
  remoteLwsUrl: string;
  nodeUrl: string;               // public full node URL for wasm-node mode
  walletRestoreHeight: number | null;
  network: 'mainnet' | 'stagenet';
  ethRpcUrl: string;
  lighterProxyUrl: string;
  currency: 'USD' | 'EUR' | 'BTC';
  /** Preferred hedge currency for new hedges — 'USD' or 'EUR'. Source of truth for open flow;
   *  live hedgeCurrency is derived from actual positions in getHedgeStatus(). */
  hedgeCurrency: 'USD' | 'EUR';
}

export interface SettingsActions {
  updateSettings: (patch: Partial<SettingsState>) => void;
}

export const useSettingsStore = create<SettingsState & SettingsActions>()(
  persist(
    (set) => ({
      lwsEndpoint: '/lws',
      xmrSyncMode: 'remote-lws' as XmrSyncMode,
      remoteLwsUrl: '/lws',
      nodeUrl: 'https://node.sethforprivacy.com',
      walletRestoreHeight: null,
      network: 'mainnet',
      ethRpcUrl: 'https://rpc.ankr.com/eth',
      lighterProxyUrl: import.meta.env.VITE_PROXY_URL || 'https://proxy.example.com',
      currency: 'USD',
      hedgeCurrency: 'USD',

      updateSettings: (patch) => set((s) => ({ ...s, ...patch })),
    }),
    {
      name: 'nerodolla-settings',
      version: 7,
      migrate(stored: unknown) {
        const s = stored as Record<string, unknown>;
        // v1→v2: revert dead public LWS URLs back to proxy routing
        if (
          s.lwsEndpoint === 'https://monero-lws.mymonero.com' ||
          s.lwsEndpoint === 'https://lws.cake.tech'
        ) {
          s.lwsEndpoint = '/lws';
        }
        // v2→v3: remove dead integrator fee fields
        delete s.integratorAddress;
        delete s.integratorFeeBps;
        // v3→v4: add hedgeCurrency preference (default USD)
        if (!s.hedgeCurrency) s.hedgeCurrency = 'USD';
        // v4→v5: add xmrSyncMode and related fields
        const defaultLws = import.meta.env.VITE_PROXY_URL
          ? `${import.meta.env.VITE_PROXY_URL}/lws`
          : '/lws';
        if (!s.xmrSyncMode) {
          const lws = s.lwsEndpoint as string | undefined;
          s.xmrSyncMode = 'remote-lws';
          s.remoteLwsUrl = lws && lws !== '/lws' ? lws : defaultLws;
        }
        if (s.xmrSyncMode === 'local') s.xmrSyncMode = 'remote-lws';
        if (!s.remoteLwsUrl) s.remoteLwsUrl = defaultLws;
        if (!s.nodeUrl) s.nodeUrl = 'https://node.sethforprivacy.com';
        // v5→v6: add walletRestoreHeight
        if (s.walletRestoreHeight === undefined) s.walletRestoreHeight = null;
        // v6→v7: ensure remoteLwsUrl is relative (web-compatible); Android overrides anyway
        if (!s.remoteLwsUrl || (s.remoteLwsUrl as string).startsWith('http')) {
          s.remoteLwsUrl = '/lws';
        }
        return s;
      },
    }
  )
);
