/**
 * WalletConnectModal.tsx — Full-screen overlay for WC session proposals
 * and signing / transaction requests.
 *
 * Rendered by App.tsx when wcPendingProposal or wcPendingRequest is non-null.
 */

import { useState } from 'react';
import { useWalletStore, type WcProposalEvent, type WcRequestEvent } from '../../store/wallet';
import {
  approveSession,
  rejectSession,
  approveRequest,
  rejectRequest,
} from '../../backend/walletconnect';

export function WalletConnectModal() {
  const { wcPendingProposal, wcPendingRequest } = useWalletStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAction(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (wcPendingProposal) {
    return <SessionProposalOverlay
      proposal={wcPendingProposal}
      busy={busy}
      error={error}
      onApprove={() => handleAction(() => approveSession(wcPendingProposal))}
      onReject={() => handleAction(() => rejectSession(wcPendingProposal))}
    />;
  }

  if (wcPendingRequest) {
    return <RequestApprovalOverlay
      request={wcPendingRequest}
      busy={busy}
      error={error}
      onApprove={() => handleAction(() => approveRequest(wcPendingRequest))}
      onReject={() => handleAction(() => rejectRequest(wcPendingRequest))}
    />;
  }

  return null;
}

// ── Session proposal ──────────────────────────────────────────────────────────

type ProposalProps = {
  proposal: WcProposalEvent;
  busy: boolean;
  error: string | null;
  onApprove: () => void;
  onReject: () => void;
};

function SessionProposalOverlay({ proposal, busy, error, onApprove, onReject }: ProposalProps) {
  const meta = proposal.params.proposer.metadata;
  const reqNamespaces = proposal.params.requiredNamespaces;

  // Collect chain IDs requested
  const chains = Object.values(reqNamespaces as Record<string, { chains?: string[]; methods: string[]; events: string[] }>)
    .flatMap((ns) => ns.chains ?? [])
    .map((c) => {
      const num = parseInt(c.split(':')[1] ?? '', 10);
      return CHAIN_NAME[num] ?? c;
    });

  return (
    <div className="wc-overlay">
      <div className="wc-modal">
        <div className="wc-modal__header">
          {meta.icons?.[0] && (
            <img src={meta.icons[0]} alt="" className="wc-modal__icon" />
          )}
          <h2 className="wc-modal__title">Connect to DApp</h2>
        </div>

        <div className="wc-modal__dapp">
          <span className="wc-modal__dapp-name">{meta.name}</span>
          <span className="wc-modal__dapp-url">{meta.url}</span>
        </div>

        {chains.length > 0 && (
          <div className="wc-modal__section">
            <span className="wc-modal__label">Requested chains</span>
            <span className="wc-modal__value">{chains.join(', ')}</span>
          </div>
        )}

        {error && <p className="wc-modal__error">{error}</p>}

        <div className="wc-modal__actions">
          <button
            className="btn btn--ghost"
            onClick={onReject}
            disabled={busy}
          >
            Reject
          </button>
          <button
            className="btn btn--primary"
            onClick={onApprove}
            disabled={busy}
          >
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Request approval ──────────────────────────────────────────────────────────

type RequestProps = {
  request: WcRequestEvent;
  busy: boolean;
  error: string | null;
  onApprove: () => void;
  onReject: () => void;
};

function RequestApprovalOverlay({ request, busy, error, onApprove, onReject }: RequestProps) {
  const { method, params } = request.params.request;
  const rawChainId = request.params.chainId;
  const chainNum = parseInt(rawChainId.split(':')[1] ?? '1', 10);
  const chainName = CHAIN_NAME[chainNum] ?? rawChainId;

  return (
    <div className="wc-overlay">
      <div className="wc-modal">
        <div className="wc-modal__header">
          <h2 className="wc-modal__title">{methodLabel(method)}</h2>
          <span className="wc-modal__chain-badge">{chainName}</span>
        </div>

        <RequestDetails method={method} params={params} />

        {error && <p className="wc-modal__error">{error}</p>}

        <div className="wc-modal__actions">
          <button
            className="btn btn--ghost"
            onClick={onReject}
            disabled={busy}
          >
            Reject
          </button>
          <button
            className="btn btn--primary"
            onClick={onApprove}
            disabled={busy}
          >
            {busy ? 'Signing…' : 'Approve'}
          </button>
        </div>
      </div>
    </div>
  );
}

function RequestDetails({ method, params }: { method: string; params: unknown[] }) {
  if (method === 'eth_sendTransaction') {
    const tx = (params as Array<{ to?: string; value?: string; data?: string }>)[0];
    const valueEth = tx.value
      ? (BigInt(tx.value) * 100n / 10n ** 18n).toString().replace(/(\d{2})$/, '.$1')
      : '0';
    return (
      <div className="wc-modal__details">
        {tx.to && (
          <div className="wc-modal__row">
            <span className="wc-modal__label">To</span>
            <span className="wc-modal__mono">{shortAddr(tx.to)}</span>
          </div>
        )}
        <div className="wc-modal__row">
          <span className="wc-modal__label">Value</span>
          <span className="wc-modal__value">{valueEth} ETH</span>
        </div>
        {tx.data && tx.data !== '0x' && (
          <div className="wc-modal__row">
            <span className="wc-modal__label">Data</span>
            <span className="wc-modal__mono">{truncate(tx.data, 40)}</span>
          </div>
        )}
      </div>
    );
  }

  if (method === 'personal_sign' || method === 'eth_sign') {
    const msgHex = method === 'personal_sign' ? (params as string[])[0] : (params as string[])[1];
    let preview: string;
    try {
      const bytes = hexToBytes(msgHex);
      preview = new TextDecoder().decode(bytes);
    } catch {
      preview = truncate(msgHex, 80);
    }
    return (
      <div className="wc-modal__details">
        <div className="wc-modal__row">
          <span className="wc-modal__label">Message</span>
          <span className="wc-modal__message-preview">{truncate(preview, 200)}</span>
        </div>
      </div>
    );
  }

  if (method === 'eth_signTypedData_v4' || method === 'eth_signTypedData') {
    let primaryType = 'Typed Data';
    try {
      const td = JSON.parse((params as string[])[1]) as { primaryType?: string };
      primaryType = td.primaryType ?? primaryType;
    } catch { /* ignore */ }
    return (
      <div className="wc-modal__details">
        <div className="wc-modal__row">
          <span className="wc-modal__label">Type</span>
          <span className="wc-modal__value">{primaryType}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="wc-modal__details">
      <span className="wc-modal__mono">{method}</span>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const CHAIN_NAME: Record<number, string> = {
  1: 'Ethereum',
  42161: 'Arbitrum',
  8453: 'Base',
  43114: 'Avalanche',
};

function methodLabel(method: string): string {
  const labels: Record<string, string> = {
    'personal_sign': 'Sign Message',
    'eth_sign': 'Sign Message',
    'eth_signTypedData_v4': 'Sign Typed Data',
    'eth_signTypedData': 'Sign Typed Data',
    'eth_sendTransaction': 'Send Transaction',
    'eth_signTransaction': 'Sign Transaction',
  };
  return labels[method] ?? method;
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const arr = new Uint8Array(h.length / 2);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return arr;
}
