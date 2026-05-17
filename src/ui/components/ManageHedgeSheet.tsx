/**
 * ManageHedgeSheet — unified action sheet for all hedge management actions.
 *
 * Sections:
 *   1. Switch Currency — grid of currency chips
 *   2. Adjust Collateral — inlined CollateralAdjust
 *   3. Unhedge — entry point to unhedge flow
 */
import { useState } from 'react';
import { CollateralAdjust } from './CollateralAdjust';
import type { HedgeCurrency, HedgeStatus } from '../../backend/lighter';

const CURRENCY_OPTIONS: { value: HedgeCurrency; label: string }[] = [
  { value: 'USD', label: '$ USD' },
  { value: 'EUR', label: '€ EUR' },
  { value: 'GBP', label: '£ GBP' },
  { value: 'XAU', label: 'Au GOLD' },
  { value: 'XAG', label: 'Ag SILVER' },
];

interface ManageHedgeSheetProps {
  isOpen: boolean;
  onClose: () => void;
  currentCurrency: HedgeCurrency;
  hedgeStatus: HedgeStatus | null;
  onSwitch: (to: HedgeCurrency) => void;
  onUnhedge: () => void;
  onRefresh: () => void;
}

export function ManageHedgeSheet({
  isOpen,
  onClose,
  currentCurrency,
  hedgeStatus,
  onSwitch,
  onUnhedge,
  onRefresh,
}: ManageHedgeSheetProps) {
  const [showCollateral, setShowCollateral] = useState(false);

  if (!isOpen) return null;

  return (
    <div className="manage-sheet-overlay" onClick={onClose}>
      <div className="manage-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="manage-sheet__header">
          <h3 className="manage-sheet__title">Manage Hedge</h3>
          <button className="manage-sheet__close" onClick={onClose}>×</button>
        </div>

        {/* ── Switch Currency ── */}
        <div className="manage-sheet__section">
          <div className="manage-sheet__section-title">Switch currency</div>
          <div className="manage-sheet__currency-grid">
            {CURRENCY_OPTIONS.map((opt) => {
              const isActive = opt.value === currentCurrency;
              return (
                <button
                  key={opt.value}
                  className={`manage-sheet__currency-btn ${isActive ? 'manage-sheet__currency-btn--active' : ''}`}
                  disabled={isActive}
                  onClick={() => {
                    onSwitch(opt.value);
                    onClose();
                  }}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Adjust Collateral ── */}
        <div className="manage-sheet__section">
          <button
            className="manage-sheet__toggle"
            onClick={() => setShowCollateral((s) => !s)}
          >
            <span>Adjust collateral</span>
            <span>{showCollateral ? '▲' : '▼'}</span>
          </button>
          {showCollateral && hedgeStatus && (
            <div className="manage-sheet__collateral">
              <CollateralAdjust
                onComplete={() => {
                  onRefresh();
                  setShowCollateral(false);
                }}
                lighterUsdc={hedgeStatus.lighterUsdc ?? 0}
                marginUsed={hedgeStatus.position?.marginUsed ?? 0}
                markPrice={hedgeStatus.position?.markPrice ?? 0}
                positionSize={hedgeStatus.position?.size ?? 0}
              />
            </div>
          )}
        </div>

        {/* ── Unhedge ── */}
        <div className="manage-sheet__section manage-sheet__section--danger">
          <button
            className="manage-sheet__unhedge-btn"
            onClick={() => {
              onUnhedge();
              onClose();
            }}
          >
            <span>Unhedge — convert back to XMR</span>
          </button>
        </div>
      </div>
    </div>
  );
}
