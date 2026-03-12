/**
 * PinScreen — shown on app load when a keystore exists but wallet is locked.
 * Decrypts the mnemonic with the entered PIN and calls setKeys.
 */
import { useState } from 'react';
import { useWalletStore } from '../../store/wallet';
import { loadKeystore, clearKeystore, loadZkKey, saveZkKey, clearZkKey } from '../../wallet/keystore';
import { mnemonicToSeed, xmrSeedFromMaster, ethSeedFromMaster } from '../../wallet/seed';
import { deriveXmrKeys } from '../../wallet/xmr';
import { deriveEthWallet } from '../../wallet/eth';
import { initLighterSession, setProxySessionToken, setSessionRenewer, migrateLegacyZkKey } from '../../backend/lighter';
import { PinPad } from '../components/PinPad';

export function PinScreen() {
  const { setKeys, setSessionToken } = useWalletStore();
  type PinStatus = 'idle' | 'verifying' | 'wrong';
  const [status, setStatus]   = useState<PinStatus>('idle');
  const [errMsg, setErrMsg]   = useState<string | null>(null);
  const [forgotMode, setForgotMode] = useState(false);

  async function handlePin(pin: string) {
    setStatus('verifying');
    setErrMsg(null);
    try {
      const mnemonic  = await loadKeystore(pin);
      const seed      = await mnemonicToSeed(mnemonic);
      const xmrKeys   = deriveXmrKeys(xmrSeedFromMaster(seed));
      const ethWallet = deriveEthWallet(ethSeedFromMaster(seed));
      setKeys(mnemonic, xmrKeys, ethWallet);
      // Fire-and-forget: initialise Lighter session if a ZK key is stored.
      // If the server rejects the key (stale cached key on secondary device),
      // clear it, re-migrate from the server, and retry once.
      loadZkKey(ethWallet.privateKey).then(async (zkPrivKey) => {
        if (!zkPrivKey) return;
        const applySession = (token: string, key: string) => {
          setSessionToken(token);
          setProxySessionToken(token);
          // Register auto-renewer so proxyFetch can silently recover from 401s.
          setSessionRenewer(async () => {
            const newToken = await initLighterSession(ethWallet.address, ethWallet.privateKey, key);
            setSessionToken(newToken);
            setProxySessionToken(newToken);
          });
        };
        try {
          const token = await initLighterSession(ethWallet.address, ethWallet.privateKey, zkPrivKey);
          applySession(token, zkPrivKey);
        } catch (err) {
          if (err instanceof Error && err.message.includes('zk_key_rejected')) {
            try {
              clearZkKey();
              const freshKey = await migrateLegacyZkKey(ethWallet.address, ethWallet.privateKey);
              await saveZkKey(ethWallet.privateKey, freshKey);
              const token = await initLighterSession(ethWallet.address, ethWallet.privateKey, freshKey);
              applySession(token, freshKey);
            } catch { /* non-fatal */ }
          }
          // other errors: non-fatal — hedge features will show error when needed
        }
      }).catch(() => { /* ignore */ });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to unlock';
      setErrMsg(msg);
      setStatus('wrong');
    }
  }

  function handleForgotConfirm() {
    clearKeystore();
    // Reload to show SetupScreen
    window.location.reload();
  }

  if (forgotMode) {
    return (
      <div className="screen pin-screen pin-screen--forgot">
        <div className="pin-screen__logo">
          <h1 className="setup-screen__wordmark">Nerodolla</h1>
        </div>
        <div className="pin-screen__forgot-body">
          <h2>Forgot PIN?</h2>
          <p>
            Your encrypted wallet data will be removed from this device.
            You can restore your wallet using your 24-word recovery phrase.
          </p>
          <button
            className="btn btn--danger"
            onClick={handleForgotConfirm}
          >
            Clear data &amp; restore from seed phrase
          </button>
          <button
            className="btn btn--ghost"
            onClick={() => setForgotMode(false)}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="screen pin-screen">
      <div className="pin-screen__logo">
        <h1 className="setup-screen__wordmark">Nerodolla</h1>
      </div>

      {status === 'verifying' ? (
        <div className="pin-screen__verifying">
          <div className="swap-flow__spinner" />
          <p>Unlocking…</p>
        </div>
      ) : (
        <PinPad
          label="Enter PIN"
          onComplete={handlePin}
          error={status === 'wrong' ? errMsg : null}
        />
      )}

      <button
        className="pin-screen__forgot-link"
        onClick={() => setForgotMode(true)}
      >
        Forgot PIN?
      </button>
    </div>
  );
}
