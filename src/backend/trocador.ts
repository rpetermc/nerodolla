/**
 * trocador.ts — Trocador.app swap API client
 *
 * Trocador aggregates exchange providers for non-custodial swaps.
 * All endpoints are GET requests with query params, authenticated via api_key.
 *
 *   1. GET /api/new_rate  — get provider rates for a pair/amount
 *   2. GET /api/new_trade — create trade using a rate_id, returns deposit address
 *   3. GET /api/trade     — poll trade status until terminal
 *
 * On native (Android/iOS), requests route through the proxy at /trocador/api/*
 * to keep the API key server-side.
 */

import type { SwapToken } from './wagyu';
import {
  MONERO_CHAIN_ID,
  BITCOIN_CHAIN_ID,
  ETHEREUM_CHAIN_ID,
  OPTIMISM_CHAIN_ID,
  BSC_CHAIN_ID,
  BASE_CHAIN_ID,
  ARBITRUM_CHAIN_ID,
  AVALANCHE_CHAIN_ID,
  SOLANA_CHAIN_ID,
} from './wagyu';

export const TROCADOR_API_BASE = 'https://trocador.app';
export const TROCADOR_API_KEY: string = import.meta.env.VITE_TROCADOR_API_KEY ?? '';

// ── Token mapping ───────────────────────────────────────────────────────────────

/** Map wagyu chain IDs to Trocador network strings. */
const CHAIN_TO_NETWORK: Record<number, string> = {
  [MONERO_CHAIN_ID]:    'Mainnet',
  [BITCOIN_CHAIN_ID]:   'Mainnet',
  [ETHEREUM_CHAIN_ID]:  'Mainnet',
  [OPTIMISM_CHAIN_ID]:  'Optimism',
  [BSC_CHAIN_ID]:       'BSC',
  [BASE_CHAIN_ID]:      'Base',
  [ARBITRUM_CHAIN_ID]:  'Arbitrum',
  [AVALANCHE_CHAIN_ID]: 'Avalanche',
  [SOLANA_CHAIN_ID]:    'Solana',
};

/**
 * Map a SwapToken to Trocador's ticker + network.
 * Returns null for tokens Trocador doesn't support (wrapped/bridged variants, etc.).
 */
export function toTrocadorParams(
  token: SwapToken,
): { ticker: string; network: string } | null {
  const network = CHAIN_TO_NETWORK[token.chainId];
  if (!network) return null;

  // Trocador uses lowercase tickers for major coins.
  // Skip chain-specific wrapped/bridged tokens that Trocador won't recognise.
  const sym = token.symbol;
  const supported = [
    'XMR', 'BTC', 'ETH', 'USDC', 'USDT', 'DAI', 'BNB', 'AVAX', 'SOL',
    'LINK', 'UNI', 'AAVE', 'ARB', 'OP', 'MATIC', 'DOT', 'ADA',
    'SHIB', 'PEPE', 'LDO', 'MKR', 'CRV', 'SNX', 'GRT', 'ENS',
    'DYDX', 'APE', 'BAL', 'GMX', 'PENDLE', 'HYPE', 'FRAX',
    'WBTC', 'WETH',
  ];
  if (!supported.includes(sym)) return null;

  return { ticker: sym.toLowerCase(), network };
}

// ── Types ───────────────────────────────────────────────────────────────────────

export type TrocadorStatus =
  | 'waiting'
  | 'confirming'
  | 'sending'
  | 'finished'
  | 'failed'
  | 'expired'
  | 'halted'
  | 'refunded';

export interface TrocadorRate {
  trade_id: string;
  rate_id: string;
  provider: string;
  amount_from: number;
  amount_to: number;
  min: number;
  max: number;
  fixed: boolean;
  payment: boolean;
  /** Estimated time in minutes. */
  eta: number;
  // Optional fields returned by some providers
  amount_from_usd?: string;
  amount_to_usd?: string;
  network_fee_usd?: string;
  min_amount_to?: string;
  estimated_time?: number;
  referral_fee?: string;
  referral_fee_usd?: string;
}

export interface TrocadorTrade {
  trade_id: string;
  status: TrocadorStatus;
  ticker_from: string;
  ticker_to: string;
  amount_from: string;
  amount_to: string;
  /** Deposit address — send funds here. */
  address_provider: string;
  /** Address for refunds if trade fails. */
  address_provider_memo?: string;
  address_user: string;
  refund_address: string;
  date: string;
  password: string;
  // Optional fields
  amount_to_usd?: string;
  confirmations?: number;
  required_confirmations?: number;
}

// ── Fetch helper ────────────────────────────────────────────────────────────────

async function trocadorFetch<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  const isNative = !!cap?.isNativePlatform?.();

  let url: string;

  if (isNative) {
    // Route via proxy: /trocador/api/new_rate, /trocador/api/trade, etc.
    const { getProxyBase } = await import('./lighter');
    const proxyBase = getProxyBase();
    const qs = new URLSearchParams(params).toString();
    url = `${proxyBase}/trocador${path}${qs ? `?${qs}` : ''}`;
  } else {
    const allParams = { api_key: TROCADOR_API_KEY, ...params };
    const qs = new URLSearchParams(allParams).toString();
    url = `${TROCADOR_API_BASE}${path}${qs ? `?${qs}` : ''}`;
  }

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`trocador ${path} ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

// ── Public API ──────────────────────────────────────────────────────────────────

/**
 * Get rates from available providers for a token pair.
 * Returns an array of provider offers, each with a rate_id to use in createTrade.
 *
 * @param from       Source token
 * @param to         Destination token
 * @param amountFrom Human-readable amount (e.g. "1.5")
 */
export async function getRate(
  from: SwapToken,
  to: SwapToken,
  amountFrom: string,
): Promise<TrocadorRate[]> {
  const fromParams = toTrocadorParams(from);
  const toParams = toTrocadorParams(to);
  if (!fromParams || !toParams) {
    throw new Error(`Unsupported token pair for Trocador: ${from.symbol} → ${to.symbol}`);
  }

  return trocadorFetch<TrocadorRate[]>('/api/new_rate', {
    ticker_from:  fromParams.ticker,
    ticker_to:    toParams.ticker,
    network_from: fromParams.network,
    network_to:   toParams.network,
    amount_from:  amountFrom,
  });
}

/**
 * Create a trade using a rate_id from getRate.
 * Returns deposit details — send funds to address_provider.
 *
 * @param rateId        The rate_id from a TrocadorRate
 * @param address       Destination address for the output token
 * @param refundAddress Address for refunds if the trade fails
 */
export async function createTrade(
  rateId: string,
  address: string,
  refundAddress?: string,
): Promise<TrocadorTrade> {
  const params: Record<string, string> = {
    rate_id: rateId,
    address: address,
  };
  if (refundAddress) params.refund_address = refundAddress;
  return trocadorFetch<TrocadorTrade>('/api/new_trade', params);
}

/**
 * Poll trade status. Call until status is 'finished', 'failed', 'expired',
 * 'halted', or 'refunded'.
 *
 * @param tradeId The trade_id from createTrade
 */
export async function getTrade(tradeId: string): Promise<TrocadorTrade> {
  return trocadorFetch<TrocadorTrade>('/api/trade', {
    trade_id: tradeId,
  });
}
