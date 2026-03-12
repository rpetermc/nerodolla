/**
 * LighterSetupFlow — one-time wizard to connect the wallet to a Lighter account.
 *
 * Steps:
 *   1. checking   — probe /setup/status
 *   2. needed     — no account yet; native USDC deposit (chain → amount → review → send)
 *   3. depositing — tx broadcast; polling every 5 s until account appears
 *   4. activating — account found; user signs ChangePubKey message
 *   5. ready      — calls onReady()
 *
 * The 'needed' step runs the deposit entirely in-app — no browser redirect.
 */
import { useState, useEffect, useRef } from 'react';
import { ethers } from 'ethers';
import { useWalletStore } from '../../store/wallet';
import { signMessage, createEthSigner } from '../../wallet/eth';
import { saveZkKey } from '../../wallet/keystore';
import {
  checkLighterSetup,
  generateLighterZkKey,
  getLighterSigningMessage,
  completeLighterSetup,
  setProxySessionToken,
} from '../../backend/lighter';
import type { LighterSigningData } from '../../backend/lighter';
import {
  DEPOSIT_CHAINS,
  getDepositIntentAddress,
  type DepositChain,
  type IntentAddressResult,
} from '../../backend/deposit';

// ── Types ─────────────────────────────────────────────────────────────────────

type SetupStep =
  | 'checking'
  | 'needed'
  | 'depositing'
  | 'activating'
  | 'signing'
  | 'ready'
  | 'error';

/** Sub-steps of the inline deposit within 'needed' */
type DepositSubStep =
  | 'intro'         // "You need a Lighter account" CTA
  | 'choose-chain'  // pick Arbitrum / Base / Avalanche
  | 'enter-amount'  // USDC amount input
  | 'review'        // show intent address, confirm
  | 'sending';      // broadcasting ERC-20 tx

interface Props {
  /** Called when setup completes successfully so parent can re-render. */
  onReady: () => void;
}

const USDC_ABI = ['function transfer(address to, uint256 amount) returns (bool)'];

// ── Component ─────────────────────────────────────────────────────────────────

export function LighterSetupFlow({ onReady }: Props) {
  const { ethWallet, setSessionToken } = useWalletStore();

  // ── Setup wizard state ────────────────────────────────────────────────────
  const [step, setStep]                   = useState<SetupStep>('checking');
  const [accountIndex, setAccountIndex]   = useState<number | null>(null);
  const [signingData, setSigningData]     = useState<LighterSigningData | null>(null);
  const [setupError, setSetupError]       = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Inline deposit state ──────────────────────────────────────────────────
  const [depositSubStep, setDepositSubStep] = useState<DepositSubStep>('intro');
  const [selectedChain, setSelectedChain]   = useState<DepositChain>(DEPOSIT_CHAINS[0]);
  const [depositAmount, setDepositAmount]   = useState('');
  const [intentResult, setIntentResult]     = useState<IntentAddressResult | null>(null);
  const [depositBusy, setDepositBusy]       = useState(false);
  const [depositError, setDepositError]     = useState<string | null>(null);

  useEffect(() => {
    runCheck();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // ── Setup wizard logic ────────────────────────────────────────────────────

  async function runCheck() {
    if (!ethWallet) return;
    setStep('checking');
    setSetupError(null);
    try {
      // Check status first — only generate a new ZK key if one isn't registered.
      // Generating unconditionally would overwrite a valid key with an unregistered one.
      const status = await checkLighterSetup(ethWallet.address);

      if (status.accountExists && status.hasApiKey) {
        setStep('ready');
        onReady();
        return;
      }

      if (!status.hasApiKey) {
        const { zkPrivateKey } = await generateLighterZkKey(ethWallet.address);
        if (zkPrivateKey) {
          await saveZkKey(ethWallet.privateKey, zkPrivateKey);
        }
      }

      if (status.accountExists && status.accountIndex !== null) {
        setAccountIndex(status.accountIndex);
        await prepareSigningMessage(ethWallet.address);
        setStep('activating');
        return;
      }

      setStep('needed');
      setDepositSubStep('intro');
    } catch (e) {
      setSetupError(e instanceof Error ? e.message : 'Setup check failed');
      setStep('error');
    }
  }

  async function prepareSigningMessage(ethAddress: string) {
    const data = await getLighterSigningMessage(ethAddress);
    setSigningData(data);
    setAccountIndex(data.accountIndex);
  }

  /** Start polling Lighter for account creation. Call after deposit TX sent. */
  function startPolling() {
    if (!ethWallet) return;
    if (pollRef.current) clearInterval(pollRef.current);
    setStep('depositing');
    let attempts = 0;
    pollRef.current = setInterval(async () => {
      attempts++;
      try {
        const status = await checkLighterSetup(ethWallet.address);
        if (status.accountExists && status.accountIndex !== null) {
          clearInterval(pollRef.current!);
          setAccountIndex(status.accountIndex);
          await prepareSigningMessage(ethWallet.address);
          setStep('activating');
        }
      } catch { /* keep polling */ }
      if (attempts >= 120) { // 10 min
        clearInterval(pollRef.current!);
        setSetupError('Account not detected after 10 minutes. Check your deposit and try again.');
        setStep('error');
      }
    }, 5000);
  }

  async function handleSign() {
    if (!ethWallet || !signingData || accountIndex === null) return;
    setStep('signing');
    setSetupError(null);
    try {
      const l1Sig = await signMessage(ethWallet, signingData.messageToSign);
      const result = await completeLighterSetup({
        ethAddress:  ethWallet.address,
        l1Signature: l1Sig,
        txType:      signingData.txType,
        txInfo:      signingData.txInfo,
        accountIndex,
      });
      if (result.success) {
        if (result.sessionToken) {
          setSessionToken(result.sessionToken);
          setProxySessionToken(result.sessionToken);
        }
        setStep('ready');
        onReady();
      } else {
        throw new Error(result.error ?? 'Key registration failed');
      }
    } catch (e) {
      setSetupError(e instanceof Error ? e.message : 'Activation failed');
      setStep('activating');
    }
  }

  // ── Inline deposit logic ──────────────────────────────────────────────────

  async function handleFetchIntentAddress() {
    if (!ethWallet) return;
    setDepositBusy(true);
    setDepositError(null);
    try {
      const result = await getDepositIntentAddress(ethWallet.address, selectedChain.id);
      setIntentResult(result);
      setDepositSubStep('review');
    } catch (e) {
      setDepositError(e instanceof Error ? e.message : 'Could not fetch deposit address');
    } finally {
      setDepositBusy(false);
    }
  }

  async function handleSendDeposit() {
    if (!ethWallet || !intentResult) return;
    setDepositBusy(true);
    setDepositError(null);
    setDepositSubStep('sending');
    try {
      const provider = new ethers.JsonRpcProvider(selectedChain.rpcUrl);
      const signer = createEthSigner(ethWallet, provider);
      const usdc = new ethers.Contract(selectedChain.usdcAddress, USDC_ABI, signer);
      const amountUnits = ethers.parseUnits(depositAmount, 6);
      await usdc.transfer(intentResult.intent_address, amountUnits);
      // TX sent — start polling for account creation
      startPolling();
    } catch (e) {
      setDepositError(e instanceof Error ? e.message : 'Transaction failed');
      setDepositSubStep('review');
    } finally {
      setDepositBusy(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (step === 'checking') {
    return (
      <Card title="Lock USD Value">
        <div className="lighter-setup__spinner-row">
          <div className="swap-flow__spinner" />
          <span>Checking Lighter account…</span>
        </div>
      </Card>
    );
  }

  if (step === 'needed') {
    return (
      <Card title="Set up Lighter account">
        <DepositSubFlow
          subStep={depositSubStep}
          chains={DEPOSIT_CHAINS}
          selectedChain={selectedChain}
          amount={depositAmount}
          intentResult={intentResult}
          busy={depositBusy}
          error={depositError}
          onSelectChain={setSelectedChain}
          onSubStep={setDepositSubStep}
          onAmountChange={setDepositAmount}
          onFetchIntent={handleFetchIntentAddress}
          onSend={handleSendDeposit}
          onClearError={() => setDepositError(null)}
        />
      </Card>
    );
  }

  if (step === 'depositing') {
    return (
      <Card title="Waiting for account…">
        <div className="lighter-setup__spinner-row">
          <div className="swap-flow__spinner" />
          <span>Checking every 5 seconds…</span>
        </div>
        <p className="lighter-setup__hint">
          This usually takes under a minute after your deposit confirms on-chain.
        </p>
      </Card>
    );
  }

  if (step === 'activating' || step === 'signing') {
    return (
      <Card title="Activate hedge">
        <p className="lighter-setup__hint">
          Sign once to link your trading key to your Lighter account.
          No funds move — this is just a cryptographic signature.
        </p>
        {setupError && <p className="lighter-setup__error">{setupError}</p>}
        <button
          className="btn btn--primary lighter-setup__cta"
          onClick={handleSign}
          disabled={step === 'signing'}
        >
          {step === 'signing' ? 'Signing…' : 'Sign to activate'}
        </button>
      </Card>
    );
  }

  if (step === 'error') {
    return (
      <Card title="Setup error">
        <p className="lighter-setup__error">{setupError}</p>
        <button className="btn btn--ghost" onClick={runCheck}>Try again</button>
      </Card>
    );
  }

  return null; // 'ready' — parent handles
}

// ── Inline deposit sub-flow ───────────────────────────────────────────────────

interface DepositSubFlowProps {
  subStep: DepositSubStep;
  chains: DepositChain[];
  selectedChain: DepositChain;
  amount: string;
  intentResult: IntentAddressResult | null;
  busy: boolean;
  error: string | null;
  onSelectChain: (c: DepositChain) => void;
  onSubStep: (s: DepositSubStep) => void;
  onAmountChange: (v: string) => void;
  onFetchIntent: () => void;
  onSend: () => void;
  onClearError: () => void;
}

function DepositSubFlow({
  subStep, chains, selectedChain, amount, intentResult,
  busy, error, onSelectChain, onSubStep, onAmountChange,
  onFetchIntent, onSend, onClearError,
}: DepositSubFlowProps) {

  if (subStep === 'intro') {
    return (
      <>
        <p className="lighter-setup__hint">
          To enable hedging you need a Lighter account. Deposit USDC directly
          from your wallet — Lighter will create your account automatically.
        </p>
        <button
          className="btn btn--primary lighter-setup__cta"
          onClick={() => onSubStep('choose-chain')}
        >
          Deposit USDC from wallet
        </button>
      </>
    );
  }

  if (subStep === 'choose-chain') {
    return (
      <>
        <p className="lighter-setup__hint">Choose the network to send USDC from.</p>
        <div className="lighter-setup__chain-list">
          {chains.map((c) => (
            <button
              key={c.id}
              className={`lighter-setup__chain-btn ${selectedChain.id === c.id ? 'lighter-setup__chain-btn--active' : ''}`}
              onClick={() => onSelectChain(c)}
            >
              <span className="lighter-setup__chain-name">{c.label}</span>
              <span className="lighter-setup__chain-id">Chain {c.id}</span>
            </button>
          ))}
        </div>
        <div className="lighter-setup__row-actions">
          <button className="btn btn--ghost" onClick={() => onSubStep('intro')}>Back</button>
          <button className="btn btn--primary" onClick={() => onSubStep('enter-amount')}>Next</button>
        </div>
      </>
    );
  }

  if (subStep === 'enter-amount') {
    const valid = amount !== '' && !isNaN(parseFloat(amount)) && parseFloat(amount) > 0;
    return (
      <>
        <p className="lighter-setup__hint">
          Enter the USDC amount to deposit from <strong>{selectedChain.label}</strong>.
          Any amount works — even $1 to create the account.
        </p>
        <div className="lighter-setup__amount-row">
          <input
            className="lighter-setup__amount-input"
            type="number"
            min="0.01"
            step="0.01"
            placeholder="0.00"
            value={amount}
            onChange={(e) => onAmountChange(e.target.value)}
          />
          <span className="lighter-setup__amount-unit">USDC</span>
        </div>
        {error && <p className="lighter-setup__error">{error} <button onClick={onClearError}>✕</button></p>}
        <div className="lighter-setup__row-actions">
          <button className="btn btn--ghost" onClick={() => onSubStep('choose-chain')}>Back</button>
          <button
            className="btn btn--primary"
            onClick={onFetchIntent}
            disabled={!valid || busy}
          >
            {busy ? 'Fetching…' : 'Review'}
          </button>
        </div>
      </>
    );
  }

  if (subStep === 'review' && intentResult) {
    return (
      <>
        <p className="lighter-setup__hint">
          Confirm the transfer. Lighter will credit your account once the transaction confirms.
        </p>
        <div className="lighter-setup__review">
          <div className="lighter-setup__review-row">
            <span>Network</span>
            <span>{selectedChain.label}</span>
          </div>
          <div className="lighter-setup__review-row">
            <span>Amount</span>
            <span><strong>{amount} USDC</strong></span>
          </div>
          <div className="lighter-setup__review-row">
            <span>To (intent)</span>
            <code className="lighter-setup__code">{shortAddr(intentResult.intent_address)}</code>
          </div>
        </div>
        {error && <p className="lighter-setup__error">{error} <button onClick={onClearError}>✕</button></p>}
        <div className="lighter-setup__row-actions">
          <button className="btn btn--ghost" onClick={() => onSubStep('enter-amount')} disabled={busy}>
            Back
          </button>
          <button className="btn btn--primary" onClick={onSend} disabled={busy}>
            {busy ? 'Sending…' : 'Confirm & Send'}
          </button>
        </div>
      </>
    );
  }

  if (subStep === 'sending') {
    return (
      <div className="lighter-setup__spinner-row">
        <div className="swap-flow__spinner" />
        <span>Broadcasting transaction…</span>
      </div>
    );
  }

  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="lighter-setup">
      <div className="lighter-setup__title">{title}</div>
      {children}
    </div>
  );
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 10)}…${addr.slice(-8)}`;
}
