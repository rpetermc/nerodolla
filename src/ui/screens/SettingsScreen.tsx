import { useState } from 'react';
import { useWalletStore, useSettingsStore } from '../../store/wallet';
import type { XmrSyncMode } from '../../store/wallet';
import { pingLws } from '../../backend/lws';
import { initWalletConnect, pair, disconnectSession } from '../../backend/walletconnect';

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
  const { navigate, lock, wcSession, setWcSession } = useWalletStore();
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

      <section className="settings-section settings-section--danger">
        <h2 className="settings-section__title">Security</h2>
        <button className="btn btn--danger" onClick={lock}>
          Lock Wallet
        </button>
        <p className="settings-hint">
          Clears keys from memory. You will need your recovery phrase to re-access.
        </p>
      </section>
    </div>
  );
}
