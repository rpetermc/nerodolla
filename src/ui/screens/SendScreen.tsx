import { useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { BarcodeScanner, BarcodeFormat } from '@capacitor-mlkit/barcode-scanning';
import { useWalletStore } from '../../store/wallet';
import { formatXmr, estimateFee, xmrToAtomic, transferXmr } from '../../backend/lws';
import { loadKeystore } from '../../wallet/keystore';

type Step = 'input' | 'confirm' | 'sending' | 'success' | 'error';

export function SendScreen() {
  const { xmrInfo, xmrKeys, walletCreatedHeight, navigate } = useWalletStore();

  // ── Input state ──────────────────────────────────────────────────────────────
  const [destAddress, setDestAddress] = useState('');
  const [amountXmr, setAmountXmr] = useState('');
  const [addressError, setAddressError] = useState('');
  const [showWebNote, setShowWebNote] = useState(false);
  const [scanError, setScanError] = useState('');

  // ── Flow state ───────────────────────────────────────────────────────────────
  const [step, setStep] = useState<Step>('input');
  const [estimatedFee, setEstimatedFee] = useState('');  // picoXMR string
  const [isFetching, setIsFetching] = useState(false);
  const [fetchError, setFetchError] = useState('');

  // ── Confirm state ────────────────────────────────────────────────────────────
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState('');
  const [isSending, setIsSending] = useState(false);

  // ── Success state ────────────────────────────────────────────────────────────
  const [txHash, setTxHash] = useState('');
  const [actualFee, setActualFee] = useState('');
  const [actualAmount, setActualAmount] = useState('');

  // ── Error state ──────────────────────────────────────────────────────────────
  const [errorMsg, setErrorMsg] = useState('');

  // ── Helpers ───────────────────────────────────────────────────────────────────
  const spendableBalance = xmrInfo?.spendableBalance ?? 0n;
  const spendableXmr = formatXmr(spendableBalance);

  function formatFeeXmr(picoStr: string): string {
    if (!picoStr) return '0.000000';
    return formatXmr(BigInt(picoStr));
  }

  function totalXmr(): string {
    try {
      const amt = BigInt(xmrToAtomic(amountXmr));
      const fee = BigInt(estimatedFee || '0');
      return formatXmr(amt + fee);
    } catch {
      return '—';
    }
  }

  // ── QR / URI parsing ─────────────────────────────────────────────────────────
  function parseMoneroUri(raw: string) {
    if (raw.startsWith('monero:')) {
      const [addr, query = ''] = raw.slice(7).split('?');
      setDestAddress(addr.trim());
      const params = new URLSearchParams(query);
      const amt = params.get('tx_amount');
      if (amt) setAmountXmr(amt);
    } else {
      setDestAddress(raw.trim());
    }
  }

  async function handleScan() {
    setScanError('');
    setShowWebNote(false);
    if (!Capacitor.isNativePlatform()) {
      setShowWebNote(true);
      return;
    }
    try {
      const { camera } = await BarcodeScanner.requestPermissions();
      if (camera !== 'granted' && camera !== 'limited') {
        setScanError('Camera permission denied. Enable in device settings.');
        return;
      }
      const { barcodes } = await BarcodeScanner.scan({ formats: [BarcodeFormat.QrCode] });
      if (barcodes[0]?.rawValue) parseMoneroUri(barcodes[0].rawValue);
    } catch (err) {
      setScanError(err instanceof Error ? err.message : 'Scan failed');
    }
  }

  // ── MAX button ────────────────────────────────────────────────────────────────
  function handleMax() {
    setAmountXmr(spendableXmr);
  }

  // ── Validate + fetch fee → confirm ────────────────────────────────────────────
  async function handleGetFeeEstimate() {
    if (!xmrKeys || !destAddress || !amountXmr) return;
    setFetchError('');
    setIsFetching(true);
    try {
      const fee = await estimateFee(
        xmrKeys.primaryAddress,
        xmrKeys.viewKeyPrivate,
        destAddress,
        walletCreatedHeight ?? undefined,
      );
      setEstimatedFee(fee);
      setStep('confirm');
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'Fee estimate failed');
    } finally {
      setIsFetching(false);
    }
  }

  // ── PIN auto-submit ───────────────────────────────────────────────────────────
  async function handlePinChange(value: string) {
    setPin(value);
    setPinError('');
    if (value.length === 6) {
      await handleConfirmSend(value);
    }
  }

  // ── Broadcast ─────────────────────────────────────────────────────────────────
  async function handleConfirmSend(enteredPin: string) {
    if (!xmrKeys) return;
    setPinError('');
    setIsSending(true);

    let spendKey: string;
    try {
      // loadKeystore returns mnemonic; we need the spend key from xmrKeys (already derived).
      // We use loadKeystore purely to verify the PIN — if it doesn't throw, PIN is correct.
      await loadKeystore(enteredPin);
      spendKey = xmrKeys.spendKeyPrivate;
    } catch {
      setPinError('Incorrect PIN');
      setPin('');
      setIsSending(false);
      return;
    }

    setStep('sending');

    try {
      const amountAtomic = xmrToAtomic(amountXmr);
      const result = await transferXmr(
        xmrKeys.primaryAddress,
        xmrKeys.viewKeyPrivate,
        spendKey,
        destAddress,
        amountAtomic,
        walletCreatedHeight ?? undefined,
      );
      setTxHash(result.txHash);
      setActualFee(result.fee);
      setActualAmount(result.amount);
      setStep('success');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Send failed');
      setStep('error');
    } finally {
      setIsSending(false);
    }
  }

  // ── Truncate long address for display ─────────────────────────────────────────
  function truncateAddr(addr: string, keep = 8): string {
    if (addr.length <= keep * 2 + 3) return addr;
    return `${addr.slice(0, keep)}…${addr.slice(-keep)}`;
  }

  // ── Copy helper ───────────────────────────────────────────────────────────────
  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text).catch(() => {});
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────────

  if (step === 'success') {
    return (
      <div className="screen send-screen">
        <div className="screen__header">
          <h1>Send XMR</h1>
        </div>
        <div className="send-screen__result">
          <div className="send-screen__success-icon">✓</div>
          <p style={{ marginTop: 12, fontSize: 18, fontWeight: 700 }}>Sent!</p>
          <p style={{ marginTop: 4, fontSize: 15, color: 'var(--color-text-muted)' }}>
            {formatXmr(BigInt(actualAmount))} XMR
          </p>
          {actualFee && (
            <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginTop: 4 }}>
              Fee paid: {formatFeeXmr(actualFee)} XMR
            </p>
          )}
          <div className="send-screen__tx-row">
            <span className="send-screen__tx-hash">{txHash}</span>
            <button
              className="btn btn--ghost btn--xs"
              onClick={() => copyToClipboard(txHash)}
            >
              Copy
            </button>
          </div>
        </div>
        <button className="btn btn--primary" onClick={() => navigate('home')}>
          Done
        </button>
      </div>
    );
  }

  if (step === 'error') {
    return (
      <div className="screen send-screen">
        <div className="screen__header">
          <h1>Send XMR</h1>
        </div>
        <div className="send-screen__result">
          <div style={{ fontSize: 48, color: 'var(--color-red)', textAlign: 'center' }}>✗</div>
          <p style={{ marginTop: 12, fontSize: 15, color: 'var(--color-red)', wordBreak: 'break-word' }}>
            {errorMsg}
          </p>
        </div>
        <button
          className="btn btn--ghost"
          onClick={() => { setStep('input'); setErrorMsg(''); }}
        >
          Try Again
        </button>
      </div>
    );
  }

  if (step === 'sending') {
    return (
      <div className="screen send-screen">
        <div className="screen__header">
          <h1>Send XMR</h1>
        </div>
        <div className="send-screen__result">
          <div className="swap-flow__spinner" style={{ margin: '0 auto 16px' }} />
          <p style={{ color: 'var(--color-text-muted)', textAlign: 'center' }}>
            Broadcasting transaction…
          </p>
        </div>
      </div>
    );
  }

  if (step === 'confirm') {
    return (
      <div className="screen send-screen">
        <div className="screen__header">
          <button className="back-btn" onClick={() => { setStep('input'); setPin(''); setPinError(''); }}>
            ← Back
          </button>
          <h1>Confirm Send</h1>
        </div>

        <div className="send-screen__summary">
          <div className="send-screen__summary-row">
            <span style={{ color: 'var(--color-text-muted)' }}>To</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{truncateAddr(destAddress)}</span>
          </div>
          <div className="send-screen__summary-row">
            <span style={{ color: 'var(--color-text-muted)' }}>Amount</span>
            <span>{amountXmr} XMR</span>
          </div>
          <div className="send-screen__summary-row">
            <span style={{ color: 'var(--color-text-muted)' }}>Est. fee</span>
            <span>~{formatFeeXmr(estimatedFee)} XMR</span>
          </div>
          <div className="send-screen__summary-row">
            <span style={{ color: 'var(--color-text-muted)' }}>Total</span>
            <span className="send-screen__summary-total">~{totalXmr()} XMR</span>
          </div>
        </div>

        <div className="send-screen__pin-wrap">
          <label className="send-screen__pin-label">Enter PIN to confirm</label>
          <input
            className="send-screen__pin-input"
            type="password"
            inputMode="numeric"
            maxLength={6}
            value={pin}
            onChange={(e) => handlePinChange(e.target.value.replace(/\D/g, ''))}
            autoFocus
            disabled={isSending}
            placeholder="••••••"
          />
          {pinError && <p className="form-error">{pinError}</p>}
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn btn--primary"
            onClick={() => handleConfirmSend(pin)}
            disabled={pin.length < 6 || isSending}
          >
            Confirm Send
          </button>
          <button
            className="btn btn--ghost"
            onClick={() => { setStep('input'); setPin(''); setPinError(''); }}
            disabled={isSending}
            style={{ width: 'auto', padding: '12px 20px' }}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // ── Input step ────────────────────────────────────────────────────────────────
  return (
    <div className="screen send-screen">
      <div className="screen__header">
        <button className="back-btn" onClick={() => navigate('home')}>
          ← Back
        </button>
        <h1>Send XMR</h1>
      </div>

      <div className="send-screen__form">
        <div className="form-group">
          <label className="form-label">Destination address</label>
          <div className="send-screen__address-row">
            <textarea
              className="form-textarea"
              placeholder="Monero address (95–106 chars)"
              value={destAddress}
              onChange={(e) => { setDestAddress(e.target.value); setAddressError(''); }}
              rows={3}
            />
            <button
              className="send-screen__scan-btn"
              onClick={handleScan}
              title="Scan QR code"
              type="button"
            >
              📷
            </button>
          </div>
          {showWebNote && (
            <p className="send-screen__scan-note">
              QR scanning is only available on Android. Enter the address manually in browser.
            </p>
          )}
          {scanError && <p className="form-error">{scanError}</p>}
          {addressError && <p className="form-error">{addressError}</p>}
        </div>

        <div className="form-group">
          <label className="form-label">
            Amount (XMR)
            <span className="form-label__balance">Available: {spendableXmr} XMR</span>
          </label>
          <div className="form-amount-row">
            <input
              type="number"
              className="form-input"
              placeholder="0.000000"
              value={amountXmr}
              onChange={(e) => setAmountXmr(e.target.value)}
              min="0"
              step="0.000001"
            />
            <button className="btn btn--ghost btn--sm" onClick={handleMax}>
              MAX
            </button>
          </div>
        </div>

        {fetchError && <p className="form-error">{fetchError}</p>}

        <button
          className="btn btn--primary"
          onClick={handleGetFeeEstimate}
          disabled={!destAddress || !amountXmr || isFetching}
        >
          {isFetching ? 'Estimating fee…' : 'Get Fee Estimate'}
        </button>
      </div>
    </div>
  );
}
