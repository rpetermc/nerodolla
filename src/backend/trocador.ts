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

export const TROCADOR_API_BASE = 'https://api.trocador.app';
export const TROCADOR_API_KEY: string = import.meta.env.VITE_TROCADOR_API_KEY ?? '';

// ── Token mapping ───────────────────────────────────────────────────────────────

/** Map wagyu chain IDs to Trocador network strings.
 *  Values must match Trocador's /api/coins `network` field exactly. */
const CHAIN_TO_NETWORK: Record<number, string> = {
  [MONERO_CHAIN_ID]:    'Mainnet',
  [BITCOIN_CHAIN_ID]:   'Mainnet',
  [ETHEREUM_CHAIN_ID]:  'ERC20',
  [OPTIMISM_CHAIN_ID]:  'Optimism',
  [BSC_CHAIN_ID]:       'BEP20',
  [BASE_CHAIN_ID]:      'base',
  [ARBITRUM_CHAIN_ID]:  'Arbitrum',
  [AVALANCHE_CHAIN_ID]: 'AVAXC',
  [SOLANA_CHAIN_ID]:    'Mainnet',
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

/** A single provider quote inside the new_rate response. */
export interface TrocadorQuote {
  provider: string;
  amount_to: string;
  eta: number;
  kycrating: string;
  logpolicy: string;
  insurance: number;
  fixed: string;
  amount_from_USD?: string;
  amount_to_USD?: string;
  USD_total_cost_percentage?: string;
}

/** Top-level response from GET /api/new_rate. */
export interface TrocadorRate {
  trade_id: string;
  provider: string;
  amount_from: number;
  amount_to: number;
  fixed: boolean;
  payment: boolean;
  status: string;
  quotes?: { quotes: TrocadorQuote[] };
  // USD amounts come from the best quote
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
  // Always route via proxy — trocador.app has no CORS headers, so direct
  // browser requests are blocked.  The proxy injects the API key server-side.
  const { getProxyBase } = await import('./lighter');
  const proxyBase = getProxyBase();
  const qs = new URLSearchParams(params).toString();
  const url: string = `${proxyBase}/trocador${path}${qs ? `?${qs}` : ''}`;

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
): Promise<TrocadorRate> {
  const fromParams = toTrocadorParams(from);
  const toParams = toTrocadorParams(to);
  if (!fromParams || !toParams) {
    throw new Error(`Unsupported token pair for Trocador: ${from.symbol} → ${to.symbol}`);
  }

  const resp = await trocadorFetch<TrocadorRate>('/api/new_rate', {
    ticker_from:  fromParams.ticker,
    ticker_to:    toParams.ticker,
    network_from: fromParams.network,
    network_to:   toParams.network,
    amount_from:  amountFrom,
  });

  // Enrich top-level with USD amounts from the best quote if available
  const bestQuote = resp.quotes?.quotes?.[0];
  if (bestQuote && !resp.amount_from_usd) {
    resp.amount_from_usd = bestQuote.amount_from_USD;
    resp.amount_to_usd = bestQuote.amount_to_USD;
    resp.estimated_time = bestQuote.eta;
  }

  return resp;
}

/**
 * Create a trade using a trade_id from getRate.
 * Returns deposit details — send funds to address_provider.
 *
 * @param tradeId       The trade_id from a TrocadorRate
 * @param from          Source token (needed for ticker_from/network_from)
 * @param to            Destination token (needed for ticker_to/network_to)
 * @param address       Destination address for the output token
 * @param amountFrom   Human-readable amount (e.g. "24.41")
 * @param refundAddress Address for refunds if the trade fails
 */
export async function createTrade(
  tradeId: string,
  from: SwapToken,
  to: SwapToken,
  address: string,
  amountFrom: string,
  refundAddress?: string,
): Promise<TrocadorTrade> {
  const fromParams = toTrocadorParams(from);
  const toParams = toTrocadorParams(to);
  if (!fromParams || !toParams) {
    throw new Error(`Unsupported token pair for Trocador: ${from.symbol} → ${to.symbol}`);
  }
  const params: Record<string, string> = {
    trade_id: tradeId,
    ticker_from:  fromParams.ticker,
    ticker_to:    toParams.ticker,
    network_from: fromParams.network,
    network_to:   toParams.network,
    amount_from:  amountFrom,
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
