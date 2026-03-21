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
      // Falls back to migrating the key from the proxy when none is found locally
      // (covers browser users who first set up on Android, or cross-device access).
      // The session renewer also handles stale keys so 401s auto-recover mid-session.
      loadZkKey(ethWallet.privateKey).then(async (zkPrivKey) => {
        let key = zkPrivKey;

        // No key in localStorage — try pulling it from the proxy's legacy setup file.
        // This is the normal path for browser users whose Lighter was set up on Android.
        if (!key) {
          try {
            key = await migrateLegacyZkKey(ethWallet.address, ethWallet.privateKey);
            if (key) await saveZkKey(ethWallet.privateKey, key);
          } catch { /* proxy may not have a key yet — will be set up on first hedge */ }
        }

        if (!key) return;

        // applySession stores the token and registers an auto-renewer.
        // The renewer handles zk_key_rejected by pulling the latest key from the proxy,
        // so cross-device key rotation (e.g. Android re-registers the key) is transparent.
        const applySession = (token: string, currentKey: string) => {
          setSessionToken(token);
          setProxySessionToken(token);
          setSessionRenewer(async () => {
            try {
              const newToken = await initLighterSession(ethWallet.address, ethWallet.privateKey, currentKey);
              setSessionToken(newToken);
              setProxySessionToken(newToken);
            } catch (renewErr) {
              if (renewErr instanceof Error && renewErr.message.includes('zk_key_rejected')) {
                // Key was rotated on another device — migrate the current key from the proxy
                const freshKey = await migrateLegacyZkKey(ethWallet.address, ethWallet.privateKey);
                await saveZkKey(ethWallet.privateKey, freshKey);
                const newToken = await initLighterSession(ethWallet.address, ethWallet.privateKey, freshKey);
                applySession(newToken, freshKey); // updates token + re-registers renewer with fresh key
              } else {
                throw renewErr;
              }
            }
          });
        };

        try {
          const token = await initLighterSession(ethWallet.address, ethWallet.privateKey, key);
          applySession(token, key);
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
          <h1 className="setup-screen__wordmark">NeroHedge</h1>
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
        <svg className="pin-screen__n-logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="72" height="72">
          <defs><clipPath id="pinlogo"><circle cx="32" cy="32" r="32"/></clipPath></defs>
          <circle cx="32" cy="32" r="31" fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="2"/>
          <circle cx="32" cy="32" r="31" fill="#ff6600"/>
          <g clipPath="url(#pinlogo)">
            <polygon points="22,10 52,54 52,10 64,10 64,64 0,64 0,46 22,46" fill="#2d2d2d"/>
            <rect x="12" y="10" width="10" height="44" fill="white"/>
            <polygon points="12,10 22,10 52,54 42,54" fill="white"/>
            <rect x="42" y="10" width="10" height="44" fill="white"/>
            <rect x="0" y="46" width="22" height="8" fill="white"/>
            <rect x="42" y="10" width="22" height="8" fill="white"/>
          </g>
        </svg>
        <h1 className="setup-screen__wordmark">NeroHedge</h1>
        <p className="pin-screen__tagline"><em>On a long enough timeline, the survival rate for stablecoins drops to zero</em></p>
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
