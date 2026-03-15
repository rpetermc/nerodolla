import { useState } from 'react';
import { useWalletStore, useSettingsStore } from '../../store/wallet';
import { pingLws } from '../../backend/lws';
import { initWalletConnect, pair, disconnectSession } from '../../backend/walletconnect';

export function SettingsScreen() {
  const { navigate, lock, wcSession, setWcSession } = useWalletStore();
  const { lwsEndpoint, lighterProxyUrl, network, ethRpcUrl, updateSettings } =
    useSettingsStore();

  const [lwsInput, setLwsInput] = useState(lwsEndpoint);
  const [proxyInput, setProxyInput] = useState(lighterProxyUrl);
  const [lwsPingResult, setLwsPingResult] = useState<boolean | null>(null);
  const [isPinging, setIsPinging] = useState(false);
  const [saved, setSaved] = useState(false);

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
      // Session proposal will appear via the WalletConnectModal overlay
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

  async function handlePingLws() {
    setIsPinging(true);
    setLwsPingResult(null);
    const ok = await pingLws(lwsInput);
    setLwsPingResult(ok);
    setIsPinging(false);
  }

  function handleSave() {
    updateSettings({ lwsEndpoint: lwsInput, lighterProxyUrl: proxyInput });
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
          <label className="settings-label">monero-lws Endpoint</label>
          <input
            className="settings-input"
            value={lwsInput}
            onChange={(e) => setLwsInput(e.target.value)}
            placeholder="/lws"
          />
          <div className="settings-row__actions">
            <button className="btn btn--ghost btn--sm" onClick={handlePingLws} disabled={isPinging}>
              {isPinging ? 'Testing…' : 'Test'}
            </button>
            {lwsPingResult === true && <span className="settings-ping settings-ping--ok">✓ OK</span>}
            {lwsPingResult === false && <span className="settings-ping settings-ping--err">✗ Unreachable</span>}
          </div>
          <span className="settings-hint">
            Self-hosted via proxy — leave as <code>/lws</code> unless overriding.
          </span>
        </div>

        <div className="settings-row">
          <label className="settings-label">Proxy Server URL</label>
          <input
            className="settings-input"
            value={proxyInput}
            onChange={(e) => setProxyInput(e.target.value)}
            placeholder={import.meta.env.VITE_PROXY_URL || "https://proxy.example.com"}
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
            onChange={(e) =>
              updateSettings({ network: e.target.value as 'mainnet' | 'stagenet' })
            }
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
