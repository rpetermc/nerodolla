import { useWalletStore } from '../../store/wallet';
import { SwapFlow } from '../components/SwapFlow';

export function SwapScreen() {
  const { navigate } = useWalletStore();

  return (
    <div className="screen swap-screen">
      <div className="screen__header">
        <button className="back-btn" onClick={() => navigate('home')}>
          ← Back
        </button>
        <h1>Swap</h1>
      </div>

      <div className="swap-screen__info">
        <div className="swap-screen__providers">
          <a href="https://wagyu.xyz" target="_blank" rel="noopener noreferrer" className="swap-screen__wagyu-badge">
            <img src="/wagyu-logo.avif" alt="wagyu.xyz" className="swap-screen__wagyu-logo" />
            <span>wagyu.xyz</span>
          </a>
          <span className="swap-screen__provider-sep">+</span>
          <a href="https://trocador.app" target="_blank" rel="noopener noreferrer" className="swap-screen__wagyu-badge">
            <span>trocador.app</span>
          </a>
        </div>
        <p>
          Swap BTC, ETH, SOL and other coins directly into XMR. Best rate auto-selected from multiple providers. No exchange account, no KYC.
        </p>
        <div className="swap-screen__fee-note">
          NeroHedge fee: 0% · provider fees shown in quote
        </div>
      </div>

      <SwapFlow />
    </div>
  );
}
