/**
 * PinPad — reusable numeric PIN entry component.
 * Shows N dots for entered digits + a 3×4 keypad.
 * Calls onComplete when pinLength digits have been entered.
 */

interface PinPadProps {
  pinLength?: number;
  onComplete: (pin: string) => void;
  disabled?: boolean;
  error?: string | null;
  /** If provided, shown above the dots */
  label?: string;
}

export function PinPad({ pinLength = 6, onComplete, disabled, error, label }: PinPadProps) {
  // Controlled internally; parent gets notified only on completion.
  const [digits, setDigits] = useState('');

  function press(d: string) {
    if (disabled) return;
    const next = digits + d;
    setDigits(next);
    if (next.length === pinLength) {
      // Brief visual pause so the last dot fills before callback fires.
      setTimeout(() => {
        setDigits('');
        onComplete(next);
      }, 80);
    }
  }

  function backspace() {
    if (disabled) return;
    setDigits((prev) => prev.slice(0, -1));
  }

  const keys = [
    ['1', '2', '3'],
    ['4', '5', '6'],
    ['7', '8', '9'],
    ['', '0', 'del'],
  ];

  return (
    <div className="pin-pad">
      {label && <p className="pin-pad__label">{label}</p>}

      <div className="pin-pad__dots">
        {Array.from({ length: pinLength }).map((_, i) => (
          <span
            key={i}
            className={`pin-pad__dot${i < digits.length ? ' pin-pad__dot--filled' : ''}`}
          />
        ))}
      </div>

      {error && <p className="pin-pad__error">{error}</p>}

      <div className="pin-pad__grid">
        {keys.map((row, r) =>
          row.map((key, c) => {
            if (!key) return <span key={`${r}-${c}`} />;
            if (key === 'del') {
              return (
                <button
                  key="del"
                  className="pin-pad__key pin-pad__key--del"
                  onClick={backspace}
                  disabled={disabled || digits.length === 0}
                  aria-label="Delete"
                >
                  ⌫
                </button>
              );
            }
            return (
              <button
                key={key}
                className="pin-pad__key"
                onClick={() => press(key)}
                disabled={disabled || digits.length >= pinLength}
              >
                {key}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

// useState import
import { useState } from 'react';
