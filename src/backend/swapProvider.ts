/**
 * swapProvider.ts — Unified swap provider abstraction
 *
 * Fetches quotes from wagyu.xyz and trocador.app in parallel, auto-selects
 * the best rate, and provides a unified interface for order creation and polling.
 */

import {
  getSwapQuote,
  createSwapOrder as wagyuCreateSwapOrder,
  getOrder,
  getQuote as wagyuHedgeQuote,
  createOrder as wagyuHedgeCreateOrder,
  toAtomicStr,
  formatTokenAmount,
  xmrToAtomic,
  XMR_TOKEN,
  ARBITRUM_CHAIN_ID,
  USDC_ARB_ADDRESS,
  type SwapToken,
  type WagyuQuote,
  type WagyuOrder,
  type WagyuOrderDetail,
} from './wagyu';

import {
  getRate,
  createTrade,
  getTrade,
  type TrocadorRate,
  type TrocadorTrade,
} from './trocador';

// ── Unified types ─────────────────────────────────────────────────────────────

export type SwapProvider = 'wagyu' | 'trocador';

export interface SwapQuote {
  provider: SwapProvider;
  providerDetail?: string;        // e.g. "via ChangeNow" for trocador
  fromAmount: string;             // human-readable
  fromAmountUsd: string;
  toAmount: string;               // atomic units (same as wagyu)
  toAmountUsd: string;
  gasCostUsd: string;
  minReceived: string;
  estimatedTime: number;
  effectiveCostPct: number;       // (1 - toUsd/fromUsd) * 100
  integratorFee: {
    feePercent: number;
    feeUsd: string;
    willCollect: boolean;
  } | null;
  _providerData: unknown;         // opaque data for order creation
}

export type SwapOrderStatus =
  | 'awaiting_deposit'
  | 'confirming'
  | 'swapping'
  | 'complete'
  | 'failed'
  | 'refunded'
  | 'expired';

export interface SwapOrder {
  provider: SwapProvider;
  orderId: string;
  depositAddress: string;
  depositAmount: string;
  depositAmountFormatted: string;
  expectedOutput: string;
  expectedOutputUsd: string;
  status: SwapOrderStatus;
  confirmations?: number;
  requiredConfirmations?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const QUOTE_TIMEOUT_MS = 10_000;

/**
 * Wrap a promise with an AbortController-based timeout.
 * Rejects with an AbortError if the timeout fires first.
 */
function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  return fn(ac.signal).finally(() => clearTimeout(timer));
}

/**
 * Compute effective cost percentage.  Returns NaN if either USD value is
 * missing or zero (trocador may not provide USD amounts).
 */
function computeEffectiveCost(fromUsd: string, toUsd: string): number {
  const from = parseFloat(fromUsd);
  const to = parseFloat(toUsd);
  if (!from || !to) return NaN;
  return (1 - to / from) * 100;
}

// ── Normalization: wagyu → SwapQuote ──────────────────────────────────────────

function normalizeWagyuQuote(wq: WagyuQuote, fromAmount: string): SwapQuote {
  return {
    provider: 'wagyu',
    fromAmount,
    fromAmountUsd: wq.fromAmountUsd,
    toAmount: wq.toAmount,
    toAmountUsd: wq.toAmountUsd,
    gasCostUsd: wq.gasCostUsd,
    minReceived: wq.minReceived,
    estimatedTime: wq.estimatedTime,
    effectiveCostPct: computeEffectiveCost(wq.fromAmountUsd, wq.toAmountUsd),
    integratorFee: wq.integratorFee
      ? {
          feePercent: wq.integratorFee.feePercent,
          feeUsd: wq.integratorFee.feeUsd,
          willCollect: wq.integratorFee.willCollect,
        }
      : null,
    _providerData: wq,
  };
}

// ── Normalization: trocador → SwapQuote ───────────────────────────────────────

function normalizeTrocadorQuote(
  rate: TrocadorRate,
  fromAmount: string,
  toToken: SwapToken,
): SwapQuote {
  // trocador returns amounts in human-readable form — convert to atomic for
  // consistent comparison with wagyu's atomic toAmount.
  const toAmountStr = String(rate.amount_to);
  const toAmountAtomic = toAtomicStr(toAmountStr, toToken.decimals);

  const fromUsd = rate.amount_from_usd ?? '';
  const toUsd = rate.amount_to_usd ?? '';

  return {
    provider: 'trocador',
    providerDetail: rate.provider ? `via ${rate.provider}` : undefined,
    fromAmount,
    fromAmountUsd: fromUsd,
    toAmount: toAmountAtomic,
    toAmountUsd: toUsd,
    gasCostUsd: rate.network_fee_usd ?? '0',
    minReceived: rate.min_amount_to ?? toAmountStr,
    estimatedTime: rate.estimated_time ?? 1800,
    effectiveCostPct: computeEffectiveCost(fromUsd, toUsd),
    integratorFee: rate.referral_fee
      ? {
          feePercent: parseFloat(rate.referral_fee),
          feeUsd: rate.referral_fee_usd ?? '0',
          willCollect: parseFloat(rate.referral_fee) > 0,
        }
      : null,
    _providerData: rate,
  };
}

// ── Normalization: wagyu order → SwapOrder ────────────────────────────────────

function normalizeWagyuOrder(wo: WagyuOrder | WagyuOrderDetail): SwapOrder {
  return {
    provider: 'wagyu',
    orderId: wo.orderId,
    depositAddress: wo.depositAddress,
    depositAmount: wo.depositAmount,
    depositAmountFormatted: wo.depositAmountFormatted,
    expectedOutput: wo.expectedOutput,
    expectedOutputUsd: wo.expectedOutputUsd,
    status: wo.status as SwapOrderStatus,
    ...('confirmations' in wo
      ? {
          confirmations: (wo as WagyuOrderDetail).confirmations,
          requiredConfirmations: (wo as WagyuOrderDetail).requiredConfirmations,
        }
      : {}),
  };
}

// ── Normalization: trocador trade → SwapOrder ─────────────────────────────────

/** Map trocador trade status strings to unified SwapOrderStatus. */
function mapTrocadorStatus(status: string): SwapOrderStatus {
  switch (status) {
    case 'waiting':
    case 'new':
      return 'awaiting_deposit';
    case 'confirming':
      return 'confirming';
    case 'sending':
    case 'exchanging':
    case 'processing':
      return 'swapping';
    case 'finished':
    case 'completed':
    case 'complete':
      return 'complete';
    case 'failed':
    case 'error':
      return 'failed';
    case 'refunded':
      return 'refunded';
    case 'expired':
    case 'overdue':
      return 'expired';
    default:
      return 'swapping';
  }
}

function normalizeTrocadorOrder(trade: TrocadorTrade): SwapOrder {
  return {
    provider: 'trocador',
    orderId: trade.trade_id,
    depositAddress: trade.address_provider,
    depositAmount: String(trade.amount_from),
    depositAmountFormatted: String(trade.amount_from),
    expectedOutput: String(trade.amount_to),
    expectedOutputUsd: trade.amount_to_usd ?? '',
    status: mapTrocadorStatus(trade.status),
    confirmations: trade.confirmations,
    requiredConfirmations: trade.required_confirmations,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch quotes from wagyu and trocador in parallel, return the best one
 * (highest toAmount).  If one provider fails or times out, returns the other.
 * If both fail, throws the first error.
 */
export interface QuoteOptions {
  enableWagyu?: boolean;
  enableTrocador?: boolean;
}

export async function getBestQuote(
  from: SwapToken,
  to: SwapToken,
  fromAmount: string,
  opts: QuoteOptions = {},
): Promise<SwapQuote> {
  const useWagyu = opts.enableWagyu !== false;
  const useTrocador = opts.enableTrocador !== false;

  const [wagyuResult, trocadorResult] = await Promise.allSettled([
    useWagyu
      ? withTimeout((_signal) => getSwapQuote(from, to, fromAmount), QUOTE_TIMEOUT_MS)
      : Promise.reject(new Error('disabled')),
    useTrocador
      ? withTimeout((_signal) => getRate(from, to, fromAmount), QUOTE_TIMEOUT_MS)
      : Promise.reject(new Error('disabled')),
  ]);

  let wagyuQuote: SwapQuote | null = null;
  let trocadorQuote: SwapQuote | null = null;

  if (wagyuResult.status === 'fulfilled') {
    wagyuQuote = normalizeWagyuQuote(wagyuResult.value, fromAmount);
  }

  if (trocadorResult.status === 'fulfilled') {
    const rate = trocadorResult.value;
    if (rate && rate.amount_to > 0) {
      trocadorQuote = normalizeTrocadorQuote(rate, fromAmount, to);
    }
  }

  // Both available — pick highest toAmount (compare as BigInt for precision)
  if (wagyuQuote && trocadorQuote) {
    const wAmt = BigInt(wagyuQuote.toAmount);
    const tAmt = BigInt(trocadorQuote.toAmount);
    return tAmt > wAmt ? trocadorQuote : wagyuQuote;
  }

  // Only one available
  if (wagyuQuote) return wagyuQuote;
  if (trocadorQuote) return trocadorQuote;

  // Both failed — throw whichever error we have
  const err =
    wagyuResult.status === 'rejected'
      ? wagyuResult.reason
      : trocadorResult.status === 'rejected'
        ? trocadorResult.reason
        : new Error('No quotes available');
  throw err;
}

/**
 * Create a swap order from a previously obtained SwapQuote.
 * Routes to the correct provider based on quote.provider.
 */
export async function createOrder(
  quote: SwapQuote,
  from: SwapToken,
  to: SwapToken,
  toAddress: string,
  refundAddress?: string,
): Promise<SwapOrder> {
  if (quote.provider === 'wagyu') {
    const wo = await wagyuCreateSwapOrder(from, to, quote.fromAmount, toAddress);
    return normalizeWagyuOrder(wo);
  }

  // trocador — fetch a fresh rate immediately before creating the trade,
  // because Trocador trade_ids expire within seconds of issuance.
  const freshRate = await getRate(from, to, quote.fromAmount);
  const trade = await createTrade(
    freshRate.trade_id,
    from,
    to,
    toAddress,
    quote.fromAmount,
    refundAddress,
  );
  return normalizeTrocadorOrder(trade);
}

/**
 * Poll the current status of a swap order.
 * Routes to the correct provider based on order.provider.
 */
export async function pollSwapOrder(order: SwapOrder): Promise<SwapOrder> {
  if (order.provider === 'wagyu') {
    const detail = await getOrder(order.orderId);
    return normalizeWagyuOrder(detail);
  }

  // trocador
  const trade = await getTrade(order.orderId);
  return normalizeTrocadorOrder(trade);
}

// ── Hedge-specific API (XMR → USDC on Arbitrum) ─────────────────────────────
// Uses wagyu's hedge API key (0.5% integrator fee) and compares with trocador.

const USDC_ARB_TOKEN: SwapToken = {
  symbol: 'USDC', name: 'USD Coin', chainId: ARBITRUM_CHAIN_ID,
  chainName: 'Arbitrum', tokenId: USDC_ARB_ADDRESS, decimals: 6,
};

/**
 * Get the best hedge quote (XMR → USDC on Arbitrum) from wagyu and trocador.
 * Wagyu uses the hedge API key with 0.5% integrator fee.
 */
export async function getHedgeBestQuote(xmrAmount: string): Promise<SwapQuote> {
  const [wagyuResult, trocadorResult] = await Promise.allSettled([
    withTimeout(() => wagyuHedgeQuote(xmrAmount), QUOTE_TIMEOUT_MS),
    withTimeout(() => getRate(XMR_TOKEN, USDC_ARB_TOKEN, xmrAmount), QUOTE_TIMEOUT_MS),
  ]);

  let wagyuQuote: SwapQuote | null = null;
  let trocadorQuote: SwapQuote | null = null;

  if (wagyuResult.status === 'fulfilled') {
    wagyuQuote = normalizeWagyuQuote(wagyuResult.value, xmrAmount);
  }
  if (trocadorResult.status === 'fulfilled') {
    const rate = trocadorResult.value;
    if (rate && rate.amount_to > 0) {
      trocadorQuote = normalizeTrocadorQuote(rate, xmrAmount, USDC_ARB_TOKEN);
    }
  }

  if (wagyuQuote && trocadorQuote) {
    const wAmt = BigInt(wagyuQuote.toAmount);
    const tAmt = BigInt(trocadorQuote.toAmount);
    return tAmt > wAmt ? trocadorQuote : wagyuQuote;
  }
  if (wagyuQuote) return wagyuQuote;
  if (trocadorQuote) return trocadorQuote;

  throw wagyuResult.status === 'rejected'
    ? wagyuResult.reason
    : trocadorResult.status === 'rejected'
      ? trocadorResult.reason
      : new Error('No hedge quotes available');
}

/**
 * Create a hedge order from a SwapQuote. Routes to wagyu or trocador.
 * For trocador, converts depositAmount to picoXMR for transferXmr compatibility.
 *
 * @param quote       Quote from getHedgeBestQuote
 * @param toAddress   Lighter intent address (Arbitrum) for USDC deposit
 * @param refundAddress  XMR address for refunds (trocador only)
 */
export async function createHedgeOrder(
  quote: SwapQuote,
  toAddress: string,
  refundAddress?: string,
): Promise<SwapOrder> {
  if (quote.provider === 'wagyu') {
    const wo = await wagyuHedgeCreateOrder(quote.fromAmount, toAddress);
    return normalizeWagyuOrder(wo);
  }

  // trocador — fetch a fresh rate (trade_ids expire within seconds)
  const freshRate = await getRate(XMR_TOKEN, USDC_ARB_TOKEN, quote.fromAmount);
  const trade = await createTrade(freshRate.trade_id, XMR_TOKEN, USDC_ARB_TOKEN, toAddress, quote.fromAmount, refundAddress);
  const order = normalizeTrocadorOrder(trade);
  // Convert human-readable XMR to picoXMR for transferXmr compatibility
  order.depositAmount = xmrToAtomic(order.depositAmount);
  return order;
}

// Re-export token utilities for convenience
export { formatTokenAmount, type SwapToken } from './wagyu';
