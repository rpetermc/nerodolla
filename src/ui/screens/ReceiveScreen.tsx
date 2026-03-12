import { useEffect, useState } from 'react';
import QRCode from 'react-qr-code';
import { useWalletStore } from '../../store/wallet';
import { createSubaddress } from '../../backend/lws';

export function ReceiveScreen() {
  const {
    xmrKeys,
    receiveAddress,
    receiveAddressIndex,
    setReceiveAddress,
    navigate,
  } = useWalletStore();

  const [copied, setCopied]         = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [genError, setGenError]     = useState<string | null>(null);

  // Auto-generate a fresh subaddress the first time this screen opens
  useEffect(() => {
    if (xmrKeys && !receiveAddress) {
      generateNew();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xmrKeys]);

  async function generateNew() {
    if (!xmrKeys) return;
    setIsGenerating(true);
    setGenError(null);
    try {
      const { address, index } = await createSubaddress(
        xmrKeys.primaryAddress,
        xmrKeys.viewKeyPrivate,
      );
      setReceiveAddress(address, index);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to generate subaddress';
      setGenError(msg);
      // Fall back: show primary address so the screen isn't empty
      if (!receiveAddress) {
        setReceiveAddress(xmrKeys.primaryAddress, 0);
      }
    } finally {
      setIsGenerating(false);
    }
  }

  if (!xmrKeys) return null;

  const displayAddress = receiveAddress ?? xmrKeys.primaryAddress;
  const isPrimary      = receiveAddressIndex === 0;

  async function handleCopy() {
    await navigator.clipboard.writeText(displayAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="screen receive-screen">
      <div className="screen__header">
        <button className="back-btn" onClick={() => navigate('home')}>
          ← Back
        </button>
        <h1>Receive XMR</h1>
      </div>

      {isGenerating ? (
        <div className="receive-screen__generating">
          <div className="swap-flow__spinner" />
          <p>Generating subaddress…</p>
        </div>
      ) : (
        <>
          <div className="receive-screen__qr">
            <QRCode
              value={`monero:${displayAddress}`}
              size={240}
              bgColor="#ffffff"
              fgColor="#1a1a2e"
            />
          </div>

          <div className="receive-screen__address">
            <p className="receive-screen__address-label">
              {isPrimary ? 'Primary address' : 'Subaddress'}
            </p>
            <code className="receive-screen__address-text">{displayAddress}</code>

            <div className="receive-screen__actions">
              <button className="btn btn--secondary" onClick={handleCopy}>
                {copied ? '✓ Copied' : 'Copy'}
              </button>
              <button
                className="btn btn--ghost"
                onClick={generateNew}
                disabled={isGenerating}
              >
                New Address
              </button>
            </div>
          </div>

          {genError && (
            <p className="receive-screen__error">{genError}</p>
          )}

          <div className="receive-screen__note">
            {isPrimary ? (
              <p>
                Showing primary address — wallet-rpc unavailable.
                For best privacy, use a new subaddress per deposit.
              </p>
            ) : (
              <p>
                Fresh subaddress — unlinkable from your primary address.
                Funds received here show in your total balance automatically.
                Previous subaddresses remain active indefinitely.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
