import { useEffect } from 'react';
import { useWalletStore } from './store/wallet';
import { keystoreExists } from './wallet/keystore';
import { SetupScreen }   from './ui/screens/SetupScreen';
import { PinScreen }     from './ui/screens/PinScreen';
import { HomeScreen }    from './ui/screens/HomeScreen';
import { SendScreen }    from './ui/screens/SendScreen';
import { ReceiveScreen } from './ui/screens/ReceiveScreen';
import { SwapScreen }    from './ui/screens/SwapScreen';
import { HedgeScreen }   from './ui/screens/HedgeScreen';
import { SettingsScreen } from './ui/screens/SettingsScreen';
import { DepositScreen } from './ui/screens/DepositScreen';
import { WalletConnectModal } from './ui/components/WalletConnectModal';

const AUTO_LOCK_MS = 5 * 60 * 1000; // 5 minutes

export default function App() {
  const {
    activeScreen, isUnlocked, error, setError, navigate, lock,
    wcPendingProposal, wcPendingRequest,
  } = useWalletStore();

  // ── Auto-lock on inactivity ───────────────────────────────────────────────────
  useEffect(() => {
    if (!isUnlocked) return;

    let timer: ReturnType<typeof setTimeout>;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(lock, AUTO_LOCK_MS);
    };

    const events = ['click', 'keydown', 'touchstart', 'mousemove'] as const;
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset(); // start timer immediately

    return () => {
      events.forEach((e) => window.removeEventListener(e, reset));
      clearTimeout(timer);
    };
  }, [isUnlocked, lock]);

  // ── Screen routing ────────────────────────────────────────────────────────────
  function renderScreen() {
    if (!isUnlocked) {
      return keystoreExists() ? <PinScreen /> : <SetupScreen />;
    }
    switch (activeScreen) {
      case 'home':     return <HomeScreen />;
      case 'send':     return <SendScreen />;
      case 'receive':  return <ReceiveScreen />;
      case 'swap':     return <SwapScreen />;
      case 'hedge':    return <HedgeScreen />;
      case 'settings': return <SettingsScreen />;
      case 'deposit':  return <DepositScreen />;
      default:         return <HomeScreen />;
    }
  }

  return (
    <div className="app">
      {error && (
        <div className="app__error-banner" role="alert">
          <span>{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss">✕</button>
        </div>
      )}

      <main className="app__main">{renderScreen()}</main>

      {/* WalletConnect overlay — shown above everything when a proposal/request is pending */}
      {isUnlocked && (wcPendingProposal || wcPendingRequest) && (
        <WalletConnectModal />
      )}

      {isUnlocked && (
        <nav className="app__nav">
          <button
            className={`nav-item ${activeScreen === 'home' ? 'nav-item--active' : ''}`}
            onClick={() => navigate('home')}
          >
            <span className="nav-item__icon">⌂</span>
            <span className="nav-item__label">Home</span>
          </button>
          <button
            className={`nav-item ${activeScreen === 'swap' ? 'nav-item--active' : ''}`}
            onClick={() => navigate('swap')}
          >
            <span className="nav-item__icon">⇄</span>
            <span className="nav-item__label">Swap</span>
          </button>
          <button
            className={`nav-item ${activeScreen === 'hedge' ? 'nav-item--active' : ''}`}
            onClick={() => navigate('hedge')}
          >
            <span className="nav-item__icon">🔒</span>
            <span className="nav-item__label">Hedge</span>
          </button>
          <button
            className={`nav-item ${activeScreen === 'settings' ? 'nav-item--active' : ''}`}
            onClick={() => navigate('settings')}
          >
            <span className="nav-item__icon">⚙</span>
            <span className="nav-item__label">Settings</span>
          </button>
        </nav>
      )}
    </div>
  );
}
