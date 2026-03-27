/**
 * WalletSwitcher — bottom-sheet overlay for switching between wallets.
 * Triggered from the HomeScreen header. Shows wallet list with labels,
 * address prefixes, and an "Add Wallet" button.
 */
import { useState } from 'react';
import { useWalletStore, useSettingsStore } from '../../store/wallet';
import { getWalletList, updateWalletLabel, removeWallet as removeWalletFromStorage, type WalletEntry } from '../../wallet/keystore';
import { setProxySessionToken } from '../../backend/lighter';

interface WalletSwitcherProps {
  onClose: () => void;
  onSwitch: (walletId: string) => void;
  onAddWallet: () => void;
}

export function WalletSwitcher({ onClose, onSwitch, onAddWallet }: WalletSwitcherProps) {
  const { activeWalletId, walletList, setWalletList } = useWalletStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  function handleSelect(walletId: string) {
    if (walletId === activeWalletId) {
      onClose();
      return;
    }
    onSwitch(walletId);
  }

  function handleStartRename(wallet: WalletEntry) {
    setEditingId(wallet.id);
    setEditLabel(wallet.label);
    setConfirmDeleteId(null);
  }

  function handleSaveRename(walletId: string) {
    const trimmed = editLabel.trim();
    if (trimmed && trimmed !== walletList.find(w => w.id === walletId)?.label) {
      updateWalletLabel(walletId, trimmed);
      setWalletList(getWalletList());
    }
    setEditingId(null);
  }

  function handleDelete(walletId: string) {
    // Clear in-memory session for deleted wallet
    setProxySessionToken(null, walletId);

    removeWalletFromStorage(walletId);
    const updated = getWalletList();
    setWalletList(updated);
    setConfirmDeleteId(null);

    // If we deleted the active wallet, clear stale state and switch to another
    if (walletId === activeWalletId) {
      const store = useWalletStore.getState();
      store.setHedgeStatus(null);
      store.setXmrInfo(null);
      store.setLighterMarket(null);
      store.setSessionToken(null);

      if (updated.length > 0) {
        onSwitch(updated[0].id);
      } else {
        window.location.reload();
      }
    }
  }

  return (
    <div className="ws-overlay" onClick={onClose}>
      <div className="ws-sheet" onClick={e => e.stopPropagation()}>
        <div className="ws-sheet__header">
          <h2 className="ws-sheet__title">Wallets</h2>
          <button className="ws-sheet__close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="ws-sheet__list">
          {walletList.map(wallet => (
            <div
              key={wallet.id}
              className={`ws-wallet ${wallet.id === activeWalletId ? 'ws-wallet--active' : ''}`}
            >
              {editingId === wallet.id ? (
                <div className="ws-wallet__edit-row">
                  <input
                    className="ws-wallet__edit-input"
                    value={editLabel}
                    onChange={e => setEditLabel(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') handleSaveRename(wallet.id);
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                    autoFocus
                    maxLength={24}
                  />
                  <button className="btn btn--xs btn--primary" onClick={() => handleSaveRename(wallet.id)}>
                    Save
                  </button>
                  <button className="btn btn--xs btn--ghost" onClick={() => setEditingId(null)}>
                    Cancel
                  </button>
                </div>
              ) : confirmDeleteId === wallet.id ? (
                <div className="ws-wallet__delete-confirm">
                  <span className="ws-wallet__delete-warn">
                    Delete "{wallet.label}"? Back up your seed phrase first!
                  </span>
                  <div className="ws-wallet__delete-actions">
                    <button className="btn btn--xs btn--danger" onClick={() => handleDelete(wallet.id)}>
                      Delete
                    </button>
                    <button className="btn btn--xs btn--ghost" onClick={() => setConfirmDeleteId(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="ws-wallet__row" onClick={() => handleSelect(wallet.id)}>
                  <div className="ws-wallet__info">
                    <span className="ws-wallet__label">{wallet.label}</span>
                    <span className="ws-wallet__id">{wallet.id}...</span>
                  </div>
                  <div className="ws-wallet__actions" onClick={e => e.stopPropagation()}>
                    <button
                      className="ws-wallet__action-btn"
                      onClick={() => handleStartRename(wallet)}
                      title="Rename"
                    >
                      ✎
                    </button>
                    <button
                      className="ws-wallet__action-btn ws-wallet__action-btn--danger"
                      onClick={() => { setConfirmDeleteId(wallet.id); setEditingId(null); }}
                      title="Delete wallet"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>

        <button className="btn btn--primary ws-sheet__add-btn" onClick={onAddWallet}>
          + Add Wallet
        </button>
      </div>
    </div>
  );
}
