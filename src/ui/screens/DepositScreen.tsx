/**
 * DepositScreen.tsx — Native USDC deposit to Lighter
 *
 * Flow:
 *   chain → amount → review (fetch intent address) → sending → pending → done
 *
 * The frontend builds a standard ERC-20 transfer(intentAddress, amount) and
 * broadcasts it — no browser redirect or DApp connection needed.
 */

import { useState, useEffect, useRef } from 'react';
import { ethers } from 'ethers';
import { useWalletStore } from '../../store/wallet';
import { createEthSigner } from '../../wallet/eth';
import {
  DEPOSIT_CHAINS,
  getDepositIntentAddress,
  getDepositStatus,
  type DepositChain,
  type IntentAddressResult,
  type DepositStatusResult,
} from '../../backend/deposit';

type Step = 'chain' | 'amount' | 'review' | 'sending' | 'pending' | 'done';

const USDC_ABI = ['function transfer(address to, uint256 amount) returns (bool)'];
const POLL_INTERVAL_MS = 10_000;

export function DepositScreen() {
  const { navigate, ethWallet } = useWalletStore();

  const [step, setStep] = useState<Step>('chain');
  const [selectedChain, setSelectedChain] = useState<DepositChain>(DEPOSIT_CHAINS[0]);
  const [amount, setAmount] = useState('');
  const [intentResult, setIntentResult] = useState<IntentAddressResult | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [depositStatus, setDepositStatus] = useState<DepositStatusResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Clean up polling on unmount
  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  async function handleReview() {
    if (!ethWallet) return;
    setBusy(true);
    setError(null);
    try {
      const result = await getDepositIntentAddress(ethWallet.address, selectedChain.id);
      setIntentResult(result);
      setStep('review');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleSend() {
    if (!ethWallet || !intentResult) return;
    setBusy(true);
    setError(null);
    setStep('sending');
    try {
      const provider = new ethers.JsonRpcProvider(selectedChain.rpcUrl);
      const signer = createEthSigner(ethWallet, provider);
      const usdc = new ethers.Contract(selectedChain.usdcAddress, USDC_ABI, signer);
      const amountUnits = ethers.parseUnits(amount, 6); // USDC has 6 decimals
      const tx = await usdc.transfer(intentResult.intent_address, amountUnits);
      setTxHash((tx as { hash: string }).hash);
      setStep('pending');
      startPolling(ethWallet.address);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep('review');
    } finally {
      setBusy(false);
    }
  }

  function startPolling(ethAddress: string) {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const status = await getDepositStatus(ethAddress);
        setDepositStatus(status);
        if (status.status === 'confirmed') {
          clearInterval(pollRef.current!);
          pollRef.current = null;
          setStep('done');
        }
      } catch { /* ignore polling errors */ }
    }, POLL_INTERVAL_MS);
  }

  return (
    <div className="screen deposit-screen">
      <div className="screen__header">
        <button className="back-btn" onClick={() => navigate('hedge')}>
          ← Back
        </button>
        <h1>Deposit USDC</h1>
      </div>

      {error && (
        <div className="deposit-error">
          <span>{error}</span>
          <button onClick={() => setError(null)}>✕</button>
        </div>
      )}

      {step === 'chain' && (
        <ChainStep
          chains={DEPOSIT_CHAINS}
          selected={selectedChain}
          onSelect={setSelectedChain}
          onNext={() => setStep('amount')}
        />
      )}

      {step === 'amount' && (
        <AmountStep
          chain={selectedChain}
          amount={amount}
          onAmountChange={setAmount}
          onBack={() => setStep('chain')}
          onNext={handleReview}
          busy={busy}
        />
      )}

      {step === 'review' && intentResult && (
        <ReviewStep
          chain={selectedChain}
          amount={amount}
          intentAddress={intentResult.intent_address}
          onBack={() => setStep('amount')}
          onConfirm={handleSend}
          busy={busy}
        />
      )}

      {step === 'sending' && (
        <div className="deposit-step deposit-step--centered">
          <div className="deposit-spinner" />
          <p>Broadcasting transaction…</p>
        </div>
      )}

      {step === 'pending' && (
        <PendingStep
          txHash={txHash}
          chain={selectedChain}
          depositStatus={depositStatus}
        />
      )}

      {step === 'done' && (
        <DoneStep
          amount={depositStatus?.amount_usdc?.toString() ?? amount}
          onBack={() => navigate('hedge')}
        />
      )}
    </div>
  );
}

// ── Sub-steps ─────────────────────────────────────────────────────────────────

function ChainStep({
  chains, selected, onSelect, onNext,
}: {
  chains: DepositChain[];
  selected: DepositChain;
  onSelect: (c: DepositChain) => void;
  onNext: () => void;
}) {
  return (
    <div className="deposit-step">
      <p className="deposit-hint">Choose the network to send USDC from.</p>
      <div className="deposit-chain-list">
        {chains.map((c) => (
          <button
            key={c.id}
            className={`deposit-chain-btn ${selected.id === c.id ? 'deposit-chain-btn--active' : ''}`}
            onClick={() => onSelect(c)}
          >
            <span className="deposit-chain-btn__name">{c.label}</span>
            <span className="deposit-chain-btn__id">Chain ID {c.id}</span>
          </button>
        ))}
      </div>
      <button className="btn btn--primary btn--full" onClick={onNext}>
        Next
      </button>
    </div>
  );
}

function AmountStep({
  chain, amount, onAmountChange, onBack, onNext, busy,
}: {
  chain: DepositChain;
  amount: string;
  onAmountChange: (v: string) => void;
  onBack: () => void;
  onNext: () => void;
  busy: boolean;
}) {
  const valid = amount !== '' && !isNaN(parseFloat(amount)) && parseFloat(amount) > 0;
  return (
    <div className="deposit-step">
      <p className="deposit-hint">
        Enter the USDC amount to deposit from <strong>{chain.label}</strong>.
      </p>
      <div className="deposit-amount-row">
        <input
          className="deposit-amount-input"
          type="number"
          min="1"
          step="0.01"
          placeholder="0.00"
          value={amount}
          onChange={(e) => onAmountChange(e.target.value)}
        />
        <span className="deposit-amount-unit">USDC</span>
      </div>
      <div className="deposit-step__actions">
        <button className="btn btn--ghost" onClick={onBack}>Back</button>
        <button
          className="btn btn--primary"
          onClick={onNext}
          disabled={!valid || busy}
        >
          {busy ? 'Fetching address…' : 'Review'}
        </button>
      </div>
    </div>
  );
}

function ReviewStep({
  chain, amount, intentAddress, onBack, onConfirm, busy,
}: {
  chain: DepositChain;
  amount: string;
  intentAddress: string;
  onBack: () => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  return (
    <div className="deposit-step">
      <p className="deposit-hint">
        This will send USDC from your wallet to the Lighter deposit address.
        The transfer is irreversible — confirm the details.
      </p>
      <div className="deposit-review">
        <div className="deposit-review__row">
          <span>Network</span>
          <span>{chain.label}</span>
        </div>
        <div className="deposit-review__row">
          <span>Amount</span>
          <span><strong>{amount} USDC</strong></span>
        </div>
        <div className="deposit-review__row">
          <span>To (intent)</span>
          <span className="deposit-mono">{shortAddr(intentAddress)}</span>
        </div>
        <div className="deposit-review__row">
          <span>USDC contract</span>
          <span className="deposit-mono">{shortAddr(chain.usdcAddress)}</span>
        </div>
      </div>
      <div className="deposit-step__actions">
        <button className="btn btn--ghost" onClick={onBack} disabled={busy}>Back</button>
        <button className="btn btn--primary" onClick={onConfirm} disabled={busy}>
          {busy ? 'Sending…' : 'Confirm & Send'}
        </button>
      </div>
    </div>
  );
}

function PendingStep({
  txHash, chain, depositStatus,
}: {
  txHash: string | null;
  chain: DepositChain;
  depositStatus: DepositStatusResult | null;
}) {
  const explorerBase = chain.id === 42161
    ? 'https://arbiscan.io/tx/'
    : chain.id === 8453
    ? 'https://basescan.org/tx/'
    : 'https://snowtrace.io/tx/';

  return (
    <div className="deposit-step deposit-step--centered">
      <div className="deposit-spinner" />
      <p className="deposit-pending-title">Waiting for Lighter confirmation…</p>
      {txHash && (
        <p className="deposit-hint">
          <a
            href={`${explorerBase}${txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="deposit-link"
          >
            View on explorer ↗
          </a>
        </p>
      )}
      <p className="deposit-hint deposit-hint--muted">
        {depositStatus?.status === 'pending'
          ? 'Transaction received, awaiting Lighter credit…'
          : 'Polling every 10 seconds…'}
      </p>
    </div>
  );
}

function DoneStep({ amount, onBack }: { amount: string; onBack: () => void }) {
  return (
    <div className="deposit-step deposit-step--centered">
      <div className="deposit-done-icon">✓</div>
      <h2 className="deposit-done-title">Deposit Confirmed!</h2>
      <p className="deposit-hint">
        {amount} USDC credited to your Lighter account.
      </p>
      <button className="btn btn--primary btn--full" onClick={onBack}>
        Back to Hedge
      </button>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function shortAddr(addr: string): string {
  return `${addr.slice(0, 10)}…${addr.slice(-8)}`;
}
