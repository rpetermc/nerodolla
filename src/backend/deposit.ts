/**
 * deposit.ts — Native USDC deposit client
 *
 * Calls the lighter_proxy.py deposit endpoints to get a per-user intent
 * address, then the frontend builds and broadcasts the ERC-20 transfer
 * directly on-chain (no browser redirect needed).
 */

import { getLighterProxyBase } from './lighter';

export interface DepositChain {
  id: number;
  name: string;
  rpcUrl: string;
  usdcAddress: string;
  label: string;
}

export const DEPOSIT_CHAINS: DepositChain[] = [
  {
    id: 42161,
    name: 'arbitrum',
    rpcUrl: 'https://arb1.arbitrum.io/rpc',
    usdcAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    label: 'Arbitrum',
  },
  {
    id: 8453,
    name: 'base',
    rpcUrl: 'https://mainnet.base.org',
    usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    label: 'Base',
  },
  {
    id: 43114,
    name: 'avalanche',
    rpcUrl: 'https://api.avax.network/ext/bc/C/rpc',
    usdcAddress: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
    label: 'Avalanche',
  },
];

export interface IntentAddressResult {
  intent_address: string;
  chain_id: number;
  usdc_address: string;
}

export interface DepositStatusResult {
  status: 'pending' | 'confirmed' | 'not_found';
  amount_usdc?: number;
  tx_hash?: string;
}

/**
 * Fetch the per-user intent address for a deposit on the given chain.
 * The frontend should transfer USDC to this address to credit the Lighter account.
 */
export async function getDepositIntentAddress(
  ethAddress: string,
  chainId: number
): Promise<IntentAddressResult> {
  const url = `${getLighterProxyBase()}/deposit/intent-address?eth_address=${encodeURIComponent(ethAddress)}&chain_id=${chainId}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`deposit/intent-address HTTP ${res.status}: ${body}`);
  }
  return res.json() as Promise<IntentAddressResult>;
}

/**
 * Poll the latest deposit status for this ETH address.
 */
export async function getDepositStatus(ethAddress: string): Promise<DepositStatusResult> {
  const url = `${getLighterProxyBase()}/deposit/status?eth_address=${encodeURIComponent(ethAddress)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`deposit/status HTTP ${res.status}: ${body}`);
  }
  return res.json() as Promise<DepositStatusResult>;
}
