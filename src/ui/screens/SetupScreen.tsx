/**
 * SetupScreen — Onboarding: create new wallet or restore from mnemonic.
 * After seed is confirmed (or restored), prompts the user to set a PIN
 * which encrypts the mnemonic in localStorage for fast future unlocks.
 */
import { useState } from 'react';
import { useWalletStore, useSettingsStore } from '../../store/wallet';
import { generateMnemonic, mnemonicToSeed, xmrSeedFromMaster, ethSeedFromMaster } from '../../wallet/seed';
import { deriveXmrKeys } from '../../wallet/xmr';
import { deriveEthWallet } from '../../wallet/eth';
import { getChainHeight, initWallet } from '../../backend/lws';
import { saveKeystore, addWallet, getWalletList } from '../../wallet/keystore';
import { setActiveSessionWallet } from '../../backend/lighter';
import { PinPad } from '../components/PinPad';
import type { XmrKeys } from '../../wallet/xmr';
import type { EthWallet } from '../../wallet/eth';

type SetupMode = 'welcome' | 'create-show' | 'restore' | 'pin-set' | 'pin-confirm';

interface DerivedWallet {
  mnemonic: string;
  xmrKeys: XmrKeys;
  ethWallet: EthWallet;
}

export function SetupScreen() {
  const { setKeys, setWalletCreatedHeight, setError, setActiveWalletId, setWalletList } = useWalletStore();
  const { updateSettings } = useSettingsStore();

  const [mode, setMode]               = useState<SetupMode>('welcome');
  const [mnemonic, setMnemonic]       = useState('');
  const [createdHeight, setCreatedHeight] = useState<number | null>(null);
  const [inputMnemonic, setInputMnemonic] = useState('');
  const [inputHeight, setInputHeight]     = useState('');
  const [isLoading, setIsLoading]     = useState(false);
  const [confirmed, setConfirmed]     = useState(false);
  const [copiedPhrase, setCopiedPhrase] = useState(false);

  // Derived wallet held in state while we set up the PIN
  const [pendingWallet, setPendingWallet] = useState<DerivedWallet | null>(null);
  const [firstPin, setFirstPin]           = useState('');
  const [pinError, setPinError]           = useState<string | null>(null);

  // ── Key derivation ────────────────────────────────────────────────────────────

  async function deriveWallet(phrase: string, restoreHeight?: number): Promise<DerivedWallet> {
    const seed      = await mnemonicToSeed(phrase);
    const xmrKeys   = deriveXmrKeys(xmrSeedFromMaster(seed));
    const ethWallet = deriveEthWallet(ethSeedFromMaster(seed));

    await initWallet(xmrKeys.primaryAddress, xmrKeys.viewKeyPrivate, restoreHeight)
      .catch(() => {});

    if (restoreHeight !== undefined) {
      setWalletCreatedHeight(restoreHeight);
      updateSettings({ walletRestoreHeight: restoreHeight });
    } else if (createdHeight !== null) {
      setWalletCreatedHeight(createdHeight);
      updateSettings({ walletRestoreHeight: createdHeight });
    }

    return { mnemonic: phrase, xmrKeys, ethWallet };
  }

  // ── Handlers ─────────────────────────────────────────────────────────────────

  async function handleCreate() {
    setIsLoading(true);
    try {
      const [phrase, height] = await Promise.all([
        Promise.resolve(generateMnemonic()),
        getChainHeight().catch(() => null),
      ]);
      setMnemonic(phrase);
      setCreatedHeight(height);
      setMode('create-show');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate wallet');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleConfirmBackup() {
    setIsLoading(true);
    try {
      const wallet = await deriveWallet(mnemonic, createdHeight ?? undefined);
      setPendingWallet(wallet);
      setMode('pin-set');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to derive wallet keys');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleRestore() {
    setIsLoading(true);
    setError(null);
    try {
      const height = inputHeight.trim() ? parseInt(inputHeight.trim(), 10) : undefined;
      const wallet = await deriveWallet(inputMnemonic.trim(), height);
      setPendingWallet(wallet);
      setMode('pin-set');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to restore wallet');
    } finally {
      setIsLoading(false);
    }
  }

  // PIN setup: first entry
  function handlePinFirst(pin: string) {
    setFirstPin(pin);
    setPinError(null);
    setMode('pin-confirm');
  }

  // PIN setup: confirmation entry
  async function handlePinConfirm(pin: string) {
    if (pin !== firstPin) {
      setPinError('PINs do not match — try again');
      setMode('pin-set');
      setFirstPin('');
      return;
    }
    if (!pendingWallet) return;
    setIsLoading(true);
    try {
      // Derive walletId from XMR address
      const walletId = pendingWallet.xmrKeys.primaryAddress.slice(0, 8);

      // Cache PIN for wallet switching
      (window as unknown as { __nerodolla_pin?: string }).__nerodolla_pin = pin;

      // Save encrypted keystore with walletId
      await saveKeystore(pendingWallet.mnemonic, pin, walletId);

      // Create wallet list entry
      addWallet({
        id: walletId,
        label: 'Wallet 1',
        createdAt: Date.now(),
        restoreHeight: createdHeight,
        hedgeCurrency: 'USD',
      });

      // Set up multi-wallet state
      setWalletList(getWalletList());
      setActiveWalletId(walletId);
      setActiveSessionWallet(walletId);
      updateSettings({ lastActiveWalletId: walletId });

      setKeys(pendingWallet.mnemonic, pendingWallet.xmrKeys, pendingWallet.ethWallet);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save keystore');
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

  // ── Welcome ───────────────────────────────────────────────────────────────────

  if (mode === 'welcome') {
    return (
      <div className="screen setup-screen setup-screen--welcome">
        <div className="setup-screen__logo">
          <h1 className="setup-screen__wordmark">NeroHedge</h1>
          <p className="setup-screen__tagline">Self-custody XMR · hedged savings</p>
        </div>
        <div className="setup-screen__actions">
          <button
            className="btn btn--primary btn--large"
            onClick={handleCreate}
            disabled={isLoading}
          >
            {isLoading ? 'Generating…' : 'Create New Wallet'}
          </button>
          <button
            className="btn btn--ghost btn--large"
            onClick={() => setMode('restore')}
          >
            Restore from Recovery Phrase
          </button>
        </div>
        <p className="setup-screen__note">
          Your keys never leave this device. No accounts, no email.
        </p>
      </div>
    );
  }

  // ── Show mnemonic + restore height ────────────────────────────────────────────

  if (mode === 'create-show') {
    const words = mnemonic.split(' ');
    return (
      <div className="screen setup-screen">
        <div className="screen__header">
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
              : <span className="setup-screen__height-unknown">unavailable — write down today's date instead</span>
            }
          </div>
          <p className="setup-screen__height-note">
            Required when restoring your wallet. Without it, the wallet must scan
            the entire Monero blockchain from genesis, which takes many hours.
          </p>
        </div>

        <div className="setup-screen__copy-row">
          <button className="btn btn--ghost btn--small" onClick={handleCopyPhrase}>
            {copiedPhrase ? '✓ Copied' : 'Copy phrase + height'}
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
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          I have saved my recovery phrase and restore height in a secure location
        </label>

        <button
          className="btn btn--primary"
          onClick={handleConfirmBackup}
          disabled={!confirmed || isLoading}
        >
          {isLoading ? 'Loading wallet…' : 'Continue'}
        </button>
      </div>
    );
  }

  // ── Restore ───────────────────────────────────────────────────────────────────

  if (mode === 'restore') {
    const wordCount   = inputMnemonic.trim() ? inputMnemonic.trim().split(/\s+/).length : 0;
    const heightNum   = inputHeight.trim() ? parseInt(inputHeight.trim(), 10) : NaN;
    const heightValid = !inputHeight.trim() || (!isNaN(heightNum) && heightNum >= 0);
    const canRestore  = wordCount >= 12 && heightValid && !isLoading;

    return (
      <div className="screen setup-screen">
        <div className="screen__header">
          <button className="back-btn" onClick={() => setMode('welcome')}>
            ← Back
          </button>
          <h1>Restore Wallet</h1>
        </div>

        <label className="setup-screen__field-label">Recovery phrase (24 words)</label>
        <textarea
          className="setup-screen__mnemonic-input"
          placeholder="word1 word2 word3 … word24"
          value={inputMnemonic}
          onChange={(e) => setInputMnemonic(e.target.value)}
          rows={6}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
        {wordCount > 0 && wordCount < 12 && (
          <p className="setup-screen__field-error">{wordCount} words — need at least 12</p>
        )}

        <label className="setup-screen__field-label">
          Restore height <span className="setup-screen__field-optional">(recommended)</span>
        </label>
        <input
          type="number"
          className={`setup-screen__height-input${!heightValid ? ' setup-screen__height-input--error' : ''}`}
          placeholder="e.g. 3241567"
          value={inputHeight}
          onChange={(e) => setInputHeight(e.target.value)}
          min="0"
        />
        {!heightValid && (
          <p className="setup-screen__field-error">Enter a valid block number</p>
        )}
        <p className="setup-screen__height-restore-note">
          {inputHeight.trim()
            ? `Wallet will scan from block ${parseInt(inputHeight).toLocaleString()}.`
            : 'Without a restore height, the full blockchain must be scanned from genesis — this takes many hours.'}
        </p>

        <button
          className="btn btn--primary"
          onClick={handleRestore}
          disabled={!canRestore}
        >
          {isLoading ? 'Restoring…' : 'Restore Wallet'}
        </button>
      </div>
    );
  }

  // ── PIN setup ─────────────────────────────────────────────────────────────────

  if (mode === 'pin-set' || mode === 'pin-confirm') {
    if (isLoading) {
      return (
        <div className="screen setup-screen setup-screen--pin">
          <div className="pin-screen__logo">
            <h1 className="setup-screen__wordmark">NeroHedge</h1>
          </div>
          <div className="pin-screen__verifying">
            <div className="swap-flow__spinner" />
            <p>Encrypting wallet…</p>
          </div>
        </div>
      );
    }

    return (
      <div className="screen setup-screen setup-screen--pin">
        <div className="pin-screen__logo">
          <h1 className="setup-screen__wordmark">NeroHedge</h1>
        </div>
        <PinPad
          label={mode === 'pin-set' ? 'Set a PIN to unlock your wallet' : 'Confirm PIN'}
          onComplete={mode === 'pin-set' ? handlePinFirst : handlePinConfirm}
          error={pinError}
        />
        <p className="setup-screen__pin-note">
          {mode === 'pin-set'
            ? 'You can always recover your wallet with your 24-word phrase.'
            : 'Enter the same PIN again to confirm.'}
        </p>
      </div>
    );
  }

  return null;
}
