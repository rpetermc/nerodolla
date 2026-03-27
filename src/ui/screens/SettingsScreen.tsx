import { useState } from 'react';
import { useWalletStore, useSettingsStore } from '../../store/wallet';
import type { XmrSyncMode } from '../../store/wallet';
import { pingLws } from '../../backend/lws';
import { initWalletConnect, pair, disconnectSession } from '../../backend/walletconnect';
import {
  getWalletList, updateWalletLabel, removeWallet as removeWalletFromStorage,
  loadKeystore, changePinAllWallets,
} from '../../wallet/keystore';
import { PinPad } from '../components/PinPad';

const DEFAULT_LWS_URL = '/lws';

const LWS_OPTIONS = [
  { label: 'NeroHedge Server', value: DEFAULT_LWS_URL },
  { label: 'Custom…', value: 'custom' },
];

const PFN_OPTIONS = [
  { label: 'node.sethforprivacy.com', value: 'https://node.sethforprivacy.com' },
  { label: 'xmr-node.cakewallet.com', value: 'https://xmr-node.cakewallet.com:18081' },
  { label: 'nodes.hashvault.pro', value: 'https://nodes.hashvault.pro:18081' },
  { label: 'monero.stackwallet.com', value: 'https://monero.stackwallet.com:18081' },
  { label: 'Custom…', value: 'custom' },
];

export function SettingsScreen() {
  const { navigate, lock, wcSession, setWcSession, activeWalletId, walletList, setWalletList, xmrKeys } = useWalletStore();
  const {
    xmrSyncMode, remoteLwsUrl, nodeUrl, lighterProxyUrl, network, ethRpcUrl, updateSettings,
  } = useSettingsStore();

  const [syncMode, setSyncMode] = useState<XmrSyncMode>(xmrSyncMode);
  const [lwsUrl, setLwsUrl] = useState(remoteLwsUrl);
  const [pfnUrl, setPfnUrl] = useState(nodeUrl);
  const [proxyInput, setProxyInput] = useState(lighterProxyUrl);
  const [saved, setSaved] = useState(false);

  // LWS dropdown selection
  const [lwsSelected, setLwsSelected] = useState<string>(() =>
    LWS_OPTIONS.find(o => o.value === remoteLwsUrl && o.value !== 'custom')
      ? remoteLwsUrl
      : 'custom'
  );
  // PFN dropdown selection
  const [pfnSelected, setPfnSelected] = useState<string>(() =>
    PFN_OPTIONS.find(o => o.value === nodeUrl && o.value !== 'custom')
      ? nodeUrl
      : 'custom'
  );

  const [lwsPingResult, setLwsPingResult] = useState<boolean | null>(null);
  const [isPinging, setIsPinging] = useState(false);

  const [wcUri, setWcUri] = useState('');
  const [wcConnecting, setWcConnecting] = useState(false);
  const [wcError, setWcError] = useState<string | null>(null);

  // Wallet management
  const activeWallet = walletList.find(w => w.id === activeWalletId);
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelInput, setLabelInput] = useState(activeWallet?.label ?? '');
  const [showMnemonic, setShowMnemonic] = useState(false);
  const [mnemonicRevealed, setMnemonicRevealed] = useState<string | null>(null);
  const [pinPrompt, setPinPrompt] = useState<'reveal' | 'change-old' | null>(null);
  const [changePinOld, setChangePinOld] = useState('');
  const [changePinStep, setChangePinStep] = useState<'old' | 'new' | 'confirm' | null>(null);
  const [changePinNew, setChangePinNew] = useState('');
  const [pinChangeError, setPinChangeError] = useState<string | null>(null);
  const [pinChangeSuccess, setPinChangeSuccess] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [walletActionBusy, setWalletActionBusy] = useState(false);

  async function handleWcConnect() {
    const trimmed = wcUri.trim();
    if (!trimmed.startsWith('wc:')) {
      setWcError('Invalid URI — must start with wc:');
      return;
    }
    setWcConnecting(true);
    setWcError(null);
    try {
      const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string;
      if (!projectId) throw new Error('VITE_WALLETCONNECT_PROJECT_ID not set in .env');
      await initWalletConnect(projectId);
      await pair(trimmed);
      setWcUri('');
    } catch (err) {
      setWcError(err instanceof Error ? err.message : String(err));
    } finally {
      setWcConnecting(false);
    }
  }

  async function handleWcDisconnect() {
    if (wcSession) {
      await disconnectSession(wcSession.topic);
      setWcSession(null);
    }
  }

  async function handleTestLws() {
    setIsPinging(true);
    setLwsPingResult(null);
    const url = lwsSelected !== 'custom' ? lwsSelected : lwsUrl;
    const ok = await pingLws(url);
    setLwsPingResult(ok);
    setIsPinging(false);
  }

  // ── Wallet management handlers ──────────────────────────────────────────────

  function handleSaveLabel() {
    if (!activeWalletId || !labelInput.trim()) return;
    updateWalletLabel(activeWalletId, labelInput.trim());
    setWalletList(getWalletList());
    setEditingLabel(false);
  }

  async function handleRevealMnemonic(pin: string) {
    setWalletActionBusy(true);
    try {
      const mnemonic = await loadKeystore(pin, activeWalletId ?? undefined);
      setMnemonicRevealed(mnemonic);
      setShowMnemonic(true);
      setPinPrompt(null);
    } catch {
      setPinChangeError('Incorrect PIN');
    } finally {
      setWalletActionBusy(false);
    }
  }

  async function handleChangePinOld(pin: string) {
    setWalletActionBusy(true);
    setPinChangeError(null);
    try {
      // Verify old PIN by trying to decrypt
      await loadKeystore(pin, activeWalletId ?? undefined);
      setChangePinOld(pin);
      setChangePinStep('new');
    } catch {
      setPinChangeError('Incorrect PIN');
    } finally {
      setWalletActionBusy(false);
    }
  }

  function handleChangePinNew(pin: string) {
    setChangePinNew(pin);
    setChangePinStep('confirm');
    setPinChangeError(null);
  }

  async function handleChangePinConfirm(pin: string) {
    if (pin !== changePinNew) {
      setPinChangeError('PINs do not match');
      setChangePinStep('new');
      setChangePinNew('');
      return;
    }
    setWalletActionBusy(true);
    setPinChangeError(null);
    try {
      await changePinAllWallets(changePinOld, pin);
      // Update cached PIN
      (window as unknown as { __nerodolla_pin?: string }).__nerodolla_pin = pin;
      setPinChangeSuccess(true);
      setChangePinStep(null);
      setTimeout(() => setPinChangeSuccess(false), 3000);
    } catch (err) {
      setPinChangeError(err instanceof Error ? err.message : 'Failed to change PIN');
    } finally {
      setWalletActionBusy(false);
    }
  }

  function handleDeleteWallet() {
    if (!activeWalletId) return;
    removeWalletFromStorage(activeWalletId);
    const updated = getWalletList();
    setWalletList(updated);
    setConfirmDelete(false);
    if (updated.length === 0) {
      // Last wallet deleted — go to setup
      window.location.reload();
    } else {
      // Switch to first remaining wallet — requires full reload to re-derive keys
      window.location.reload();
    }
  }

  // ── Settings handlers ─────────────────────────────────────────────────────

  function handleSave() {
    const effectiveLws = lwsSelected !== 'custom' ? lwsSelected : lwsUrl;
    const effectivePfn = pfnSelected !== 'custom' ? pfnSelected : pfnUrl;
    updateSettings({
      xmrSyncMode: syncMode,
      remoteLwsUrl: effectiveLws,
      lwsEndpoint: effectiveLws,
      nodeUrl: effectivePfn,
      lighterProxyUrl: proxyInput,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="screen settings-screen">
      <div className="screen__header">
        <button className="back-btn" onClick={() => navigate('home')}>
          ← Back
        </button>
        <h1>Settings</h1>
      </div>

      <section className="settings-section">
        <h2 className="settings-section__title">Network</h2>

        <div className="settings-row">
          <label className="settings-label">XMR Sync Mode</label>
          <div className="settings-mode-options">
            <label className={`settings-mode-option${syncMode === 'remote-lws' ? ' settings-mode-option--active' : ''}`}>
              <input
                type="radio"
                name="xmrSyncMode"
                checked={syncMode === 'remote-lws'}
                onChange={() => { setSyncMode('remote-lws'); setLwsPingResult(null); }}
              />
              <div className="settings-mode-option__body">
                <span className="settings-mode-option__title">
                  LWS Server <span className="settings-mode-option__badge">Fastest</span>
                </span>
                <span className="settings-hint">
                  Syncs via a Light Wallet Server. Fast and battery-friendly. Your view key is
                  shared with the server — they can see your balance but cannot spend.
                </span>
              </div>
            </label>

            <label className={`settings-mode-option${syncMode === 'wasm-node' ? ' settings-mode-option--active' : ''}`}>
              <input
                type="radio"
                name="xmrSyncMode"
                checked={syncMode === 'wasm-node'}
                onChange={() => { setSyncMode('wasm-node'); setLwsPingResult(null); }}
              />
              <div className="settings-mode-option__body">
                <span className="settings-mode-option__title">
                  Public Full Node{' '}
                  <span className="settings-mode-option__badge settings-mode-option__badge--privacy">
                    Best Privacy
                  </span>
                </span>
                <span className="settings-hint">
                  Your view key never leaves your browser — scanning happens locally in WASM.
                  Slower initial sync. Similar to Cake Wallet's remote node mode.
                </span>
              </div>
            </label>
          </div>

          {syncMode === 'remote-lws' && (
            <div className="settings-remote-lws">
              <select
                className="settings-select"
                value={lwsSelected}
                onChange={e => {
                  const v = e.target.value;
                  setLwsSelected(v);
                  if (v !== 'custom') { setLwsUrl(v); setLwsPingResult(null); }
                }}
              >
                {LWS_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              {lwsSelected === 'custom' && (
                <input
                  className="settings-input"
                  value={lwsUrl}
                  onChange={e => { setLwsUrl(e.target.value); setLwsPingResult(null); }}
                  placeholder="https://your-lws-server.example.com"
                  autoCapitalize="none"
                  autoCorrect="off"
                />
              )}
              <div className="settings-row__actions">
                <button className="btn btn--ghost btn--sm" onClick={handleTestLws} disabled={isPinging}>
                  {isPinging ? 'Testing…' : 'Test'}
                </button>
                {lwsPingResult === true && <span className="settings-ping settings-ping--ok">✓ OK</span>}
                {lwsPingResult === false && <span className="settings-ping settings-ping--err">✗ Unreachable</span>}
              </div>
            </div>
          )}

          {syncMode === 'wasm-node' && (
            <div className="settings-remote-lws">
              <select
                className="settings-select"
                value={pfnSelected}
                onChange={e => {
                  const v = e.target.value;
                  setPfnSelected(v);
                  if (v !== 'custom') setPfnUrl(v);
                }}
              >
                {PFN_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              {pfnSelected === 'custom' && (
                <input
                  className="settings-input"
                  value={pfnUrl}
                  onChange={e => setPfnUrl(e.target.value)}
                  placeholder="https://your-node.example.com:18081"
                  autoCapitalize="none"
                  autoCorrect="off"
                />
              )}
              <span className="settings-hint">
                All listed nodes have CORS enabled and are community-trusted.
              </span>
            </div>
          )}
        </div>

        <div className="settings-row">
          <label className="settings-label">Proxy Server URL</label>
          <input
            className="settings-input"
            value={proxyInput}
            onChange={(e) => setProxyInput(e.target.value)}
            placeholder={import.meta.env.VITE_PROXY_URL || 'https://proxy.example.com'}
            autoCapitalize="none"
            autoCorrect="off"
          />
          <span className="settings-hint">
            lighter_proxy.py address. Required on Android — set to your server's IP and port.
          </span>
        </div>

        <div className="settings-row">
          <label className="settings-label">Network</label>
          <select
            className="settings-select"
            value={network}
            onChange={(e) => updateSettings({ network: e.target.value as 'mainnet' | 'stagenet' })}
          >
            <option value="mainnet">Mainnet</option>
            <option value="stagenet">Stagenet (testing)</option>
          </select>
        </div>

        <div className="settings-row">
          <label className="settings-label">ETH JSON-RPC URL</label>
          <input
            className="settings-input"
            value={ethRpcUrl}
            onChange={(e) => updateSettings({ ethRpcUrl: e.target.value })}
            placeholder="https://rpc.ankr.com/eth"
          />
        </div>

        <button className="btn btn--primary" onClick={handleSave}>
          {saved ? '✓ Saved' : 'Save'}
        </button>
      </section>

      <section className="settings-section">
        <h2 className="settings-section__title">DApp Connection</h2>

        {wcSession ? (
          <div className="settings-wc-session">
            <div className="settings-wc-session__info">
              <span className="settings-wc-session__name">
                {wcSession.peer.metadata.name}
              </span>
              <span className="settings-wc-session__url">
                {wcSession.peer.metadata.url}
              </span>
            </div>
            <button className="btn btn--ghost btn--sm" onClick={handleWcDisconnect}>
              Disconnect
            </button>
          </div>
        ) : (
          <>
            <div className="settings-row">
              <label className="settings-label">WalletConnect URI</label>
              <input
                className="settings-input"
                value={wcUri}
                onChange={(e) => setWcUri(e.target.value)}
                placeholder="wc:…"
              />
            </div>
            {wcError && <p className="settings-ping settings-ping--err">{wcError}</p>}
            <button
              className="btn btn--primary"
              onClick={handleWcConnect}
              disabled={wcConnecting || !wcUri.trim()}
            >
              {wcConnecting ? 'Connecting…' : 'Connect to DApp'}
            </button>
            <p className="settings-hint">
              Copy the WalletConnect URI from a DApp (e.g. Lighter.xyz) and paste it here.
            </p>
          </>
        )}
      </section>

      {/* ── Wallet management ──────────────────────────────────────────────── */}
      {activeWallet && (
        <section className="settings-section">
          <h2 className="settings-section__title">Active Wallet</h2>

          {/* Rename */}
          <div className="settings-row">
            <label className="settings-label">Wallet Name</label>
            {editingLabel ? (
              <div className="settings-wallet-rename">
                <input
                  className="settings-input"
                  value={labelInput}
                  onChange={e => setLabelInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleSaveLabel(); }}
                  maxLength={24}
                  autoFocus
                />
                <button className="btn btn--xs btn--primary" onClick={handleSaveLabel}>Save</button>
                <button className="btn btn--xs btn--ghost" onClick={() => setEditingLabel(false)}>Cancel</button>
              </div>
            ) : (
              <div className="settings-wallet-rename">
                <span className="settings-wallet-name">{activeWallet.label}</span>
                <button
                  className="btn btn--xs btn--ghost"
                  onClick={() => { setLabelInput(activeWallet.label); setEditingLabel(true); }}
                >
                  Rename
                </button>
              </div>
            )}
          </div>

          {/* Wallet ID (address prefix) */}
          <div className="settings-row">
            <label className="settings-label">Address Prefix</label>
            <span className="settings-mono">{activeWalletId}...</span>
          </div>

          {/* Show mnemonic */}
          {pinPrompt === 'reveal' ? (
            <div className="settings-row">
              {walletActionBusy ? (
                <div className="pin-screen__verifying"><div className="swap-flow__spinner" /><p>Decrypting...</p></div>
              ) : (
                <PinPad
                  label="Enter PIN to reveal recovery phrase"
                  onComplete={handleRevealMnemonic}
                  error={pinChangeError}
                />
              )}
              <button className="btn btn--ghost btn--sm" onClick={() => { setPinPrompt(null); setPinChangeError(null); }}>Cancel</button>
            </div>
          ) : showMnemonic && mnemonicRevealed ? (
            <div className="settings-row">
              <label className="settings-label">Recovery Phrase</label>
              <div className="settings-mnemonic-reveal">
                <div className="mnemonic-grid mnemonic-grid--small">
                  {mnemonicRevealed.split(' ').map((w, i) => (
                    <div key={i} className="mnemonic-word mnemonic-word--small">
                      <span className="mnemonic-word__num">{i + 1}</span>
                      <span className="mnemonic-word__text">{w}</span>
                    </div>
                  ))}
                </div>
                <button className="btn btn--ghost btn--sm" onClick={() => { setShowMnemonic(false); setMnemonicRevealed(null); }}>
                  Hide
                </button>
              </div>
            </div>
          ) : (
            <div className="settings-row">
              <button className="btn btn--ghost" onClick={() => setPinPrompt('reveal')}>
                Show Recovery Phrase
              </button>
            </div>
          )}

          {/* Delete wallet */}
          <div className="settings-row">
            {confirmDelete ? (
              <div className="settings-delete-confirm">
                <p className="settings-delete-warn">
                  This will remove "{activeWallet.label}" from this device.
                  Make sure you have backed up your recovery phrase!
                </p>
                <div className="settings-delete-actions">
                  <button className="btn btn--danger btn--sm" onClick={handleDeleteWallet}>
                    Delete Wallet
                  </button>
                  <button className="btn btn--ghost btn--sm" onClick={() => setConfirmDelete(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button className="btn btn--ghost" onClick={() => setConfirmDelete(true)}>
                Delete This Wallet
              </button>
            )}
          </div>
        </section>
      )}

      {/* ── Change PIN ──────────────────────────────────────────────────────── */}
      <section className="settings-section">
        <h2 className="settings-section__title">Security</h2>

        {changePinStep ? (
          <div className="settings-row">
            {walletActionBusy ? (
              <div className="pin-screen__verifying"><div className="swap-flow__spinner" /><p>Updating PIN...</p></div>
            ) : (
              <PinPad
                label={
                  changePinStep === 'old' ? 'Enter current PIN' :
                  changePinStep === 'new' ? 'Enter new PIN' :
                  'Confirm new PIN'
                }
                onComplete={
                  changePinStep === 'old' ? handleChangePinOld :
                  changePinStep === 'new' ? handleChangePinNew :
                  handleChangePinConfirm
                }
                error={pinChangeError}
              />
            )}
            <button className="btn btn--ghost btn--sm" onClick={() => { setChangePinStep(null); setPinChangeError(null); }}>Cancel</button>
          </div>
        ) : (
          <>
            <button className="btn btn--ghost" onClick={() => setChangePinStep('old')}>
              {pinChangeSuccess ? 'PIN Changed' : 'Change PIN'}
            </button>
            <p className="settings-hint">
              Changes the PIN for all wallets.
            </p>
          </>
        )}

        <button className="btn btn--danger" onClick={lock}>
          Lock Wallet
        </button>
        <p className="settings-hint">
          Clears keys from memory. You will need your PIN to re-access.
        </p>
      </section>
    </div>
  );
}
