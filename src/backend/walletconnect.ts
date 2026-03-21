/**
 * walletconnect.ts — WalletConnect v2 wallet-side singleton
 *
 * Nerodolla acts as the "wallet" in the WC protocol — DApps (Lighter.xyz, etc.)
 * connect to it. The user pastes a WC URI from the DApp; the singleton pairs,
 * then the session proposal / request flows through Zustand to the React UI.
 *
 * Events fire outside React, so they're bridged via useWalletStore.getState().
 */

import { Core } from '@walletconnect/core';
import { Web3Wallet } from '@walletconnect/web3wallet';
import { buildApprovedNamespaces } from '@walletconnect/utils';
import { ethers } from 'ethers';
import type { SignClientTypes } from '@walletconnect/types';
import { createEthSigner } from '../wallet/eth';
import { useWalletStore, useSettingsStore } from '../store/wallet';

// ── Per-chain RPC URLs ────────────────────────────────────────────────────────

const CHAIN_RPCS: Record<number, string> = {
  42161: 'https://arb1.arbitrum.io/rpc',
  8453: 'https://mainnet.base.org',
};

function getRpcUrl(chainId: number): string {
  return CHAIN_RPCS[chainId] ?? useSettingsStore.getState().ethRpcUrl;
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _wallet: InstanceType<typeof Web3Wallet> | null = null;
let _initPromise: Promise<void> | null = null;

/**
 * Initialise the Web3Wallet once. Safe to call multiple times.
 * Must be called before pair() / approveSession() etc.
 */
export async function initWalletConnect(projectId: string): Promise<void> {
  if (_wallet) return;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const core = new Core({ projectId });
    _wallet = await Web3Wallet.init({
      core,
      metadata: {
        name: 'NeroHedge',
        description: 'XMR wallet with delta-neutral hedge',
        url: 'https://nerohedge.app',
        icons: [],
      },
    });

    _wallet.on('session_proposal', (proposal) => {
      useWalletStore.getState().setWcPendingProposal(proposal);
    });

    _wallet.on('session_request', (request) => {
      useWalletStore.getState().setWcPendingRequest(request);
    });

    _wallet.on('session_delete', () => {
      useWalletStore.getState().setWcSession(null);
    });
  })();

  return _initPromise;
}

export function isInitialised(): boolean {
  return _wallet !== null;
}

// ── Pairing ───────────────────────────────────────────────────────────────────

export async function pair(uri: string): Promise<void> {
  if (!_wallet) throw new Error('WalletConnect not initialised');
  await _wallet.pair({ uri });
}

// ── Session lifecycle ─────────────────────────────────────────────────────────

export async function approveSession(
  proposal: SignClientTypes.EventArguments['session_proposal']
): Promise<void> {
  if (!_wallet) throw new Error('WalletConnect not initialised');
  const { ethWallet } = useWalletStore.getState();
  if (!ethWallet) throw new Error('Wallet not unlocked');

  const address = ethWallet.address;
  const chains = ['eip155:1', 'eip155:42161', 'eip155:8453'];
  const accounts = chains.map((c) => `${c}:${address}`);

  const approvedNamespaces = buildApprovedNamespaces({
    proposal: proposal.params,
    supportedNamespaces: {
      eip155: {
        chains,
        methods: [
          'eth_sendTransaction',
          'eth_signTransaction',
          'eth_sign',
          'personal_sign',
          'eth_signTypedData',
          'eth_signTypedData_v4',
        ],
        events: ['accountsChanged', 'chainChanged'],
        accounts,
      },
    },
  });

  const session = await _wallet.approveSession({
    id: proposal.id,
    namespaces: approvedNamespaces,
  });

  useWalletStore.getState().setWcSession(session);
  useWalletStore.getState().setWcPendingProposal(null);
}

export async function rejectSession(
  proposal: SignClientTypes.EventArguments['session_proposal']
): Promise<void> {
  if (!_wallet) throw new Error('WalletConnect not initialised');
  await _wallet.rejectSession({
    id: proposal.id,
    reason: { code: 4001, message: 'User rejected' },
  });
  useWalletStore.getState().setWcPendingProposal(null);
}

export async function disconnectSession(topic: string): Promise<void> {
  if (!_wallet) return;
  try {
    await _wallet.disconnectSession({
      topic,
      reason: { code: 6000, message: 'User disconnected' },
    });
  } catch {
    // ignore — session may already be gone
  }
  useWalletStore.getState().setWcSession(null);
}

// ── Request handling ──────────────────────────────────────────────────────────

export async function approveRequest(
  request: SignClientTypes.EventArguments['session_request']
): Promise<void> {
  if (!_wallet) throw new Error('WalletConnect not initialised');
  const { ethWallet } = useWalletStore.getState();
  if (!ethWallet) throw new Error('Wallet not unlocked');

  const { topic, id } = request;
  const { method, params } = request.params.request;
  const rawChainId = request.params.chainId; // e.g. "eip155:42161"
  const chainId = parseInt(rawChainId.split(':')[1] ?? '1', 10);

  let result: unknown;
  try {
    if (method === 'personal_sign') {
      // params[0] = hex-encoded message, params[1] = address
      const signer = new ethers.Wallet(ethWallet.privateKey);
      result = await signer.signMessage(ethers.getBytes(params[0] as string));

    } else if (method === 'eth_sign') {
      // Legacy: params[0] = address, params[1] = message
      const signer = new ethers.Wallet(ethWallet.privateKey);
      result = await signer.signMessage(ethers.getBytes(params[1] as string));

    } else if (method === 'eth_signTypedData_v4' || method === 'eth_signTypedData') {
      // params[0] = address, params[1] = JSON-encoded EIP-712 typed data
      const typedData = JSON.parse(params[1] as string) as {
        domain: ethers.TypedDataDomain;
        types: Record<string, ethers.TypedDataField[]> & { EIP712Domain?: unknown };
        message: Record<string, unknown>;
        primaryType?: string;
      };
      const { domain, types, message } = typedData;
      // ethers v6 adds EIP712Domain automatically — remove it to avoid duplicate
      const { EIP712Domain: _eip712, ...filteredTypes } = types;
      const signer = new ethers.Wallet(ethWallet.privateKey);
      result = await signer.signTypedData(domain, filteredTypes, message);

    } else if (method === 'eth_sendTransaction') {
      const txParam = (params as Array<{
        from: string;
        to: string;
        data?: string;
        value?: string;
        gas?: string;
      }>)[0];

      const rpcUrl = getRpcUrl(chainId);
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const signer = createEthSigner(ethWallet, provider);

      // Estimate gas with 20% headroom, fallback to 200k
      let gasLimit: bigint;
      try {
        const estimated = await provider.estimateGas({
          from: txParam.from,
          to: txParam.to,
          data: txParam.data,
          value: txParam.value,
        });
        gasLimit = (estimated * 120n) / 100n;
      } catch {
        gasLimit = 200000n;
      }

      const txResponse = await signer.sendTransaction({
        to: txParam.to,
        data: txParam.data,
        value: txParam.value,
        gasLimit,
      });
      result = txResponse.hash;

    } else {
      throw new Error(`Unsupported method: ${method}`);
    }

    await _wallet.respondSessionRequest({
      topic,
      response: { id, jsonrpc: '2.0', result },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await _wallet.respondSessionRequest({
      topic,
      response: { id, jsonrpc: '2.0', error: { code: 4001, message: msg } },
    });
  }

  useWalletStore.getState().setWcPendingRequest(null);
}

export async function rejectRequest(
  request: SignClientTypes.EventArguments['session_request']
): Promise<void> {
  if (!_wallet) return;
  await _wallet.respondSessionRequest({
    topic: request.topic,
    response: {
      id: request.id,
      jsonrpc: '2.0',
      error: { code: 4001, message: 'User rejected' },
    },
  });
  useWalletStore.getState().setWcPendingRequest(null);
}
