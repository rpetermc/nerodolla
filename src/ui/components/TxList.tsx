import { useState } from 'react';
import { useWalletStore } from '../../store/wallet';
import { formatXmr } from '../../backend/lws';

const UNLOCK_CONFS = 10;

function formatDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit',
  });
}

export function TxList() {
  const { transactions, xmrInfo, isSyncing } = useWalletStore();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (isSyncing && transactions.length === 0) {
    return (
      <div className="tx-list tx-list--empty">
        <div className="tx-list__spinner">Scanning blockchain…</div>
      </div>
    );
  }

  if (transactions.length === 0) {
    return (
      <div className="tx-list tx-list--empty">
        <p>No transactions yet</p>
      </div>
    );
  }

  const chainHeight = xmrInfo?.blockchainHeight ?? 0;
  const sorted = [...transactions].sort((a, b) => b.timestamp - a.timestamp);

  return (
    <div className="tx-list">
      <div className="tx-list__header">Transactions</div>
      <ul className="tx-list__items">
        {sorted.map((tx) => {
          const net        = tx.totalReceived - tx.totalSent;
          const isIncoming = net > 0n;
          const amountStr  = formatXmr(isIncoming ? net : -net);
          const isPending  = tx.height === 0;
          const isExpanded = expandedId === tx.id;

          // Confirmation count (capped at UNLOCK_CONFS for the progress bar)
          const confs = isPending
            ? 0
            : chainHeight > 0 && tx.height > 0
              ? Math.max(0, chainHeight - tx.height + 1)
              : null;
          const isUnlocked  = confs !== null && confs >= UNLOCK_CONFS;
          const confDisplay = isPending
            ? 'Pending'
            : confs !== null
              ? isUnlocked ? 'Confirmed' : `${confs} / ${UNLOCK_CONFS}`
              : '—';
          const progressPct = confs !== null && !isUnlocked
            ? Math.min(100, (confs / UNLOCK_CONFS) * 100)
            : null;

          return (
            <li key={tx.id} className={`tx-item tx-item--${isIncoming ? 'in' : 'out'}${isExpanded ? ' tx-item--expanded' : ''}`}>

              {/* ── Summary row (always visible) ── */}
              <button
                className="tx-item__row"
                onClick={() => setExpandedId(isExpanded ? null : tx.id)}
                aria-expanded={isExpanded}
              >
                <div className="tx-item__icon">
                  {isIncoming ? '↓' : '↑'}
                </div>
                <div className="tx-item__details">
                  <div className="tx-item__label">
                    {isIncoming ? 'Received' : 'Sent'}
                    {isPending && <span className="tx-item__pending"> · pending</span>}
                    {!isPending && !isUnlocked && confs !== null && (
                      <span className="tx-item__locking"> · confirming ({confs}/{UNLOCK_CONFS})</span>
                    )}
                  </div>
                  <div className="tx-item__date">
                    {formatDate(tx.timestamp)}{tx.timestamp > 0 ? `, ${formatTime(tx.timestamp)}` : ''}
                  </div>
                </div>
                <div className="tx-item__amount">
                  <span className={`tx-item__amount-value tx-item__amount--${isIncoming ? 'pos' : 'neg'}`}>
                    {isIncoming ? '+' : '−'}{amountStr} XMR
                  </span>
                  <span className="tx-item__chevron">{isExpanded ? '▲' : '▼'}</span>
                </div>
              </button>

              {/* ── Expanded detail panel ── */}
              {isExpanded && (
                <div className="tx-item__detail">

                  {/* Confirmations */}
                  <div className="tx-detail__row">
                    <span className="tx-detail__label">Confirmations</span>
                    <span className={`tx-detail__value${isUnlocked ? ' tx-detail__value--ok' : ''}`}>
                      {confDisplay}
                    </span>
                  </div>

                  {/* Progress bar during lock window */}
                  {progressPct !== null && (
                    <div className="tx-detail__conf-bar">
                      <div
                        className="tx-detail__conf-fill"
                        style={{ width: `${progressPct}%` }}
                      />
                    </div>
                  )}

                  {/* Block height */}
                  <div className="tx-detail__row">
                    <span className="tx-detail__label">Block</span>
                    <span className="tx-detail__value">
                      {isPending ? 'Unconfirmed' : tx.height.toLocaleString()}
                    </span>
                  </div>

                  {/* Fee (outgoing) */}
                  {!isIncoming && tx.fee > 0n && (
                    <div className="tx-detail__row">
                      <span className="tx-detail__label">Fee</span>
                      <span className="tx-detail__value">{formatXmr(tx.fee)} XMR</span>
                    </div>
                  )}

                  {/* Subaddress (incoming) */}
                  {isIncoming && tx.subaddress && (
                    <div className="tx-detail__row">
                      <span className="tx-detail__label">To subaddress</span>
                      <span className="tx-detail__value tx-detail__value--mono">
                        {tx.subaddress.slice(0, 10)}…{tx.subaddress.slice(-6)}
                      </span>
                    </div>
                  )}

                  {/* TX ID */}
                  <div className="tx-detail__row">
                    <span className="tx-detail__label">TX ID</span>
                    <span className="tx-detail__value tx-detail__value--mono">
                      {tx.id.slice(0, 10)}…{tx.id.slice(-6)}
                    </span>
                  </div>

                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
