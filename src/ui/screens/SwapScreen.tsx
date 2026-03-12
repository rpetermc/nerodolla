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
        <p>
          Swap BTC, ETH, SOL and other coins directly into XMR. Powered by{' '}
          <a href="https://wagyu.xyz" target="_blank" rel="noopener noreferrer">
            wagyu.xyz
          </a>
          .
        </p>
        <div className="swap-screen__fee-note">
          Nerodolla fee: 0.0% · wagyu protocol fee: ~0.1%
        </div>
      </div>

      <SwapFlow />
    </div>
  );
}
