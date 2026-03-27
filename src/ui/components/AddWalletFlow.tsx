/**
 * AddWalletFlow — Create or import an additional wallet.
 * Reuses the key derivation from SetupScreen but skips PIN setup
 * (all wallets share the existing PIN).
 */
import { useState } from 'react';
import { useWalletStore, useSettingsStore } from '../../store/wallet';
import { generateMnemonic, mnemonicToSeed, xmrSeedFromMaster, ethSeedFromMaster } from '../../wallet/seed';
import { deriveXmrKeys } from '../../wallet/xmr';
import { deriveEthWallet } from '../../wallet/eth';
import { getChainHeight, initWallet } from '../../backend/lws';
import { saveKeystore, addWallet, getWalletList, getNextWalletLabel } from '../../wallet/keystore';
import { setActiveSessionWallet } from '../../backend/lighter';

interface AddWalletFlowProps {
  /** The existing PIN (already verified from unlock) — needed to encrypt the new wallet. */
  pin: string;
  onComplete: (walletId: string) => void;
  onCancel: () => void;
}

type FlowStep = 'choose' | 'create-show' | 'restore';

export function AddWalletFlow({ pin, onComplete, onCancel }: AddWalletFlowProps) {
  const { setKeys, setWalletCreatedHeight, setError, setActiveWalletId, setWalletList } = useWalletStore();
  const { updateSettings } = useSettingsStore();

  const [step, setStep] = useState<FlowStep>('choose');
  const [mnemonic, setMnemonic] = useState('');
  const [createdHeight, setCreatedHeight] = useState<number | null>(null);
  const [inputMnemonic, setInputMnemonic] = useState('');
  const [inputHeight, setInputHeight] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [copiedPhrase, setCopiedPhrase] = useState(false);

  async function finalizeWallet(phrase: string, restoreHeight?: number) {
    setIsLoading(true);
    try {
      const seed = await mnemonicToSeed(phrase);
      const xmrKeys = deriveXmrKeys(xmrSeedFromMaster(seed));
      const ethWallet = deriveEthWallet(ethSeedFromMaster(seed));

      // Derive walletId: first 8 chars of XMR primary address
      const walletId = xmrKeys.primaryAddress.slice(0, 8);

      // Check for duplicate
      const existing = getWalletList();
      if (existing.some(w => w.id === walletId)) {
        setError('This wallet has already been added');
        setIsLoading(false);
        return;
      }

      // Register with LWS
      await initWallet(xmrKeys.primaryAddress, xmrKeys.viewKeyPrivate, restoreHeight).catch(() => {});

      // Save encrypted keystore
      await saveKeystore(phrase, pin, walletId);

      // Add to wallet list
      addWallet({
        id: walletId,
        label: getNextWalletLabel(),
        createdAt: Date.now(),
        restoreHeight: restoreHeight ?? null,
        hedgeCurrency: 'USD',
      });

      // Update store
      const updatedList = getWalletList();
      setWalletList(updatedList);
      setActiveWalletId(walletId);
      setActiveSessionWallet(walletId);
      updateSettings({ lastActiveWalletId: walletId });

      if (restoreHeight !== undefined) {
        setWalletCreatedHeight(restoreHeight);
      } else if (createdHeight !== null) {
        setWalletCreatedHeight(createdHeight);
      }

      // Clear stale state from any previous wallet so the UI never shows
      // old balance/tx data while the first sync is in progress.
      const store = useWalletStore.getState();
      store.setXmrInfo(null);
      store.setTransactions([]);
      store.setHedgeStatus(null);
      store.setLighterMarket(null);
      store.setSessionToken(null);
      store.setUsdcBalance(null);
      store.setReceiveAddress(null, 0);
      store.setLastSyncAt(null);

      // Activate the new wallet's keys
      setKeys(phrase, xmrKeys, ethWallet);
      onComplete(walletId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add wallet');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleCreate() {
    setIsLoading(true);
    try {
      const [phrase, height] = await Promise.all([
        Promise.resolve(generateMnemonic()),
        getChainHeight().catch(() => null),
      ]);
      setMnemonic(phrase);
      setCreatedHeight(height);
      setStep('create-show');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate wallet');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleCopyPhrase() {
    const heightStr = createdHeight !== null ? `\n\nRestore Height: ${createdHeight}` : '';
    await navigator.clipboard.writeText(mnemonic + heightStr);
    setCopiedPhrase(true);
    setTimeout(() => setCopiedPhrase(false), 2000);
  }

  // ── Choose ──────────────────────────────────────────────────────────────────

  if (step === 'choose') {
    return (
      <div className="screen setup-screen setup-screen--welcome">
        <div className="screen__header">
          <button className="back-btn" onClick={onCancel}>← Back</button>
          <h1>Add Wallet</h1>
        </div>
        <div className="setup-screen__actions">
          <button
            className="btn btn--primary btn--large"
            onClick={handleCreate}
            disabled={isLoading}
          >
            {isLoading ? 'Generating...' : 'Create New Wallet'}
          </button>
          <button
            className="btn btn--ghost btn--large"
            onClick={() => setStep('restore')}
          >
            Import Recovery Phrase
          </button>
        </div>
      </div>
    );
  }

  // ── Create: show mnemonic ───────────────────────────────────────────────────

  if (step === 'create-show') {
    const words = mnemonic.split(' ');
    return (
      <div className="screen setup-screen">
        <div className="screen__header">
          <button className="back-btn" onClick={() => setStep('choose')}>← Back</button>
          <h1>Recovery Phrase</h1>
        </div>

        <div className="setup-screen__warning">
          Write these 24 words <strong>and the restore height</strong> down and store
          them somewhere safe. Never share them with anyone.
        </div>

        <div className="mnemonic-grid">
          {words.map((word, i) => (
            <div key={i} className="mnemonic-word">
              <span className="mnemonic-word__num">{i + 1}</span>
              <span className="mnemonic-word__text">{word}</span>
            </div>
          ))}
        </div>

        <div className="setup-screen__height-box">
          <div className="setup-screen__height-label">Restore Height</div>
          <div className="setup-screen__height-value">
            {createdHeight !== null
              ? createdHeight.toLocaleString()
              : <span className="setup-screen__height-unknown">unavailable</span>
            }
          </div>
        </div>

        <div className="setup-screen__copy-row">
          <button className="btn btn--ghost btn--small" onClick={handleCopyPhrase}>
            {copiedPhrase ? 'Copied' : 'Copy phrase + height'}
          </button>
        </div>

        <div className="setup-screen__seed-warning">
          If you lose this recovery phrase, your funds are permanently unrecoverable.
          No one — including NeroHedge — can restore access without it.
          Write it down on paper and store it securely. Never share it with anyone.
        </div>
        <label className="setup-screen__confirm-label">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={e => setConfirmed(e.target.checked)}
          />
          I have saved my recovery phrase and restore height in a secure location
        </label>

        <button
          className="btn btn--primary"
          onClick={() => finalizeWallet(mnemonic, createdHeight ?? undefined)}
          disabled={!confirmed || isLoading}
        >
          {isLoading ? 'Adding wallet...' : 'Add Wallet'}
        </button>
      </div>
    );
  }

  // ── Restore ─────────────────────────────────────────────────────────────────

  if (step === 'restore') {
    const wordCount = inputMnemonic.trim() ? inputMnemonic.trim().split(/\s+/).length : 0;
    const heightNum = inputHeight.trim() ? parseInt(inputHeight.trim(), 10) : NaN;
    const heightValid = !inputHeight.trim() || (!isNaN(heightNum) && heightNum >= 0);
    const canRestore = wordCount >= 12 && heightValid && !isLoading;

    return (
      <div className="screen setup-screen">
        <div className="screen__header">
          <button className="back-btn" onClick={() => setStep('choose')}>← Back</button>
          <h1>Import Wallet</h1>
        </div>

        <label className="setup-screen__field-label">Recovery phrase (24 words)</label>
        <textarea
          className="setup-screen__mnemonic-input"
          placeholder="word1 word2 word3 ... word24"
          value={inputMnemonic}
          onChange={e => setInputMnemonic(e.target.value)}
          rows={6}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
        {wordCount > 0 && wordCount < 12 && (
          <p className="setup-screen__field-error">{wordCount} words - need at least 12</p>
        )}

        <label className="setup-screen__field-label">
          Restore height <span className="setup-screen__field-optional">(recommended)</span>
        </label>
        <input
          type="number"
          className={`setup-screen__height-input${!heightValid ? ' setup-screen__height-input--error' : ''}`}
          placeholder="e.g. 3241567"
          value={inputHeight}
          onChange={e => setInputHeight(e.target.value)}
          min="0"
        />

        <button
          className="btn btn--primary"
          onClick={() => {
            const height = inputHeight.trim() ? parseInt(inputHeight.trim(), 10) : undefined;
            finalizeWallet(inputMnemonic.trim(), height);
          }}
          disabled={!canRestore}
        >
          {isLoading ? 'Importing...' : 'Import Wallet'}
        </button>
      </div>
    );
  }

  return null;
}
