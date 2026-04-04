import { useState } from 'react';
import { useWalletStore } from '../../store/wallet';
import { SwapFlow } from '../components/SwapFlow';

export function SwapScreen() {
  const { navigate } = useWalletStore();
  const [enableWagyu, setEnableWagyu] = useState(true);
  const [enableTrocador, setEnableTrocador] = useState(true);

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
          <span className="swap-screen__powered-by">Powered by</span>
          <div className="swap-screen__provider-badges">
            <label className={`swap-screen__provider-badge${enableWagyu ? '' : ' swap-screen__provider-badge--off'}`}>
              <input
                type="checkbox"
                checked={enableWagyu}
                onChange={() => { if (enableWagyu && !enableTrocador) return; setEnableWagyu(!enableWagyu); }}
              />
              <img src="/wagyu-logo.avif" alt="wagyu.xyz" className="swap-screen__provider-logo" />
              <span>wagyu.xyz</span>
            </label>
            <label className={`swap-screen__provider-badge${enableTrocador ? '' : ' swap-screen__provider-badge--off'}`}>
              <input
                type="checkbox"
                checked={enableTrocador}
                onChange={() => { if (enableTrocador && !enableWagyu) return; setEnableTrocador(!enableTrocador); }}
              />
              <img src="/trocador-logo.png" alt="trocador.app" className="swap-screen__provider-logo" />
              <span>trocador.app</span>
            </label>
          </div>
        </div>
        <p>
          Best rate auto-selected. Untick a provider to exclude it.
        </p>
        <div className="swap-screen__fee-note">
          NeroHedge fee: 0% · provider fees shown in quote
        </div>
      </div>

      <SwapFlow enableWagyu={enableWagyu} enableTrocador={enableTrocador} />
    </div>
  );
}
