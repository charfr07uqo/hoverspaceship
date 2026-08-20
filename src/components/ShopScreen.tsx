import React from 'react';
import { ModuleType } from '../types/game';
import { MODULE_MAX_TIER, MODULE_META, MODULE_UPGRADE_COSTS } from '../constants/gameConfig';

interface ShopScreenProps {
  isVisible: boolean;
  totalGems: number;
  powerGenLevel: number;
  autoCannonLevel: number;
  zoomScannerLevel: number;
  shieldCellLevel: number;
  onPurchase: (type: ModuleType) => void;
  onClose: () => void;
}

interface ModuleCardProps {
  type: ModuleType;
  level: number;
  totalGems: number;
  onPurchase: (type: ModuleType) => void;
}

/**
 * One module tile. Laid out for density: the blurb lives in the tooltip, the
 * tier readout collapses into the header, and the current -> next values share
 * a single line so four tiles fit the warp window without scrolling.
 */
const ModuleCard: React.FC<ModuleCardProps> = ({ type, level, totalGems, onPurchase }) => {
  const meta = MODULE_META[type];
  const isMaxed = level >= MODULE_MAX_TIER;
  const cost = isMaxed ? null : MODULE_UPGRADE_COSTS[level];
  const canAfford = cost !== null && totalGems >= cost;
  const currentValue = level > 0 ? meta.tierValues[level - 1] : null;
  const nextValue = isMaxed ? null : meta.tierValues[level];

  return (
    <div className="shop-card" title={meta.blurb}>
      <div className="shop-card-head">
        <span className="shop-card-icon">{meta.icon}</span>
        <h3 className="shop-card-name">{meta.name}</h3>
        <span className="shop-card-tier">{level}/{MODULE_MAX_TIER}</span>
      </div>

      <div className="shop-tier-row">
        {Array.from({ length: MODULE_MAX_TIER }, (_, i) => (
          <span key={i} className={`shop-tier-pip ${i < level ? 'filled' : ''}`} />
        ))}
      </div>

      <div className="shop-card-stats">
        <span className="shop-stat-now">
          {currentValue !== null ? `${currentValue}${meta.unit}` : '—'}
        </span>
        {nextValue !== null && (
          <>
            <span className="shop-stat-arrow">→</span>
            <span className="shop-stat-next">{nextValue}{meta.unit}</span>
          </>
        )}
      </div>

      <button
        type="button"
        className="btn shop-buy-btn"
        disabled={isMaxed || !canAfford}
        onClick={() => onPurchase(type)}
      >
        {isMaxed ? 'MAX TIER' : (
          <>
            {level > 0 ? 'UPGRADE' : 'INSTALL'} · 💎 {cost}
          </>
        )}
      </button>
    </div>
  );
};

export const ShopScreen: React.FC<ShopScreenProps> = ({
  isVisible,
  totalGems,
  powerGenLevel,
  autoCannonLevel,
  zoomScannerLevel,
  shieldCellLevel,
  onPurchase,
  onClose
}) => {
  if (!isVisible) return null;

  return (
    <div className="shop-modal">
      <div className="shop-card-container">
        <div className="shop-header">
          <h2 className="shop-title">⚙️ MODULE SHOP</h2>
          <div className="shop-gem-bank">💎 {totalGems}</div>
        </div>
        <p className="shop-subtitle">This run only • Warp resumes when you close</p>

        <div className="shop-cards">
          <ModuleCard type="powerGen" level={powerGenLevel} totalGems={totalGems} onPurchase={onPurchase} />
          <ModuleCard type="shieldCell" level={shieldCellLevel} totalGems={totalGems} onPurchase={onPurchase} />
          <ModuleCard type="autoCannon" level={autoCannonLevel} totalGems={totalGems} onPurchase={onPurchase} />
          <ModuleCard type="zoomScanner" level={zoomScannerLevel} totalGems={totalGems} onPurchase={onPurchase} />
        </div>

        <button type="button" className="btn shop-close-btn" onClick={onClose}>
          ▶ RESUME WARP
        </button>
      </div>
    </div>
  );
};
