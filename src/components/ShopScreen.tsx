import React from 'react';
import { ModuleType } from '../types/game';
import { MODULE_MAX_TIER, MODULE_META, MODULE_UPGRADE_COSTS } from '../constants/gameConfig';

interface ShopScreenProps {
  isVisible: boolean;
  totalGems: number;
  powerGenLevel: number;
  autoCannonLevel: number;
  zoomScannerLevel: number;
  onPurchase: (type: ModuleType) => void;
  onClose: () => void;
}

interface ModuleCardProps {
  type: ModuleType;
  level: number;
  totalGems: number;
  onPurchase: (type: ModuleType) => void;
}

const ModuleCard: React.FC<ModuleCardProps> = ({ type, level, totalGems, onPurchase }) => {
  const meta = MODULE_META[type];
  const isMaxed = level >= MODULE_MAX_TIER;
  const cost = isMaxed ? null : MODULE_UPGRADE_COSTS[level];
  const canAfford = cost !== null && totalGems >= cost;
  const currentValue = level > 0 ? meta.tierValues[level - 1] : null;
  const nextValue = isMaxed ? null : meta.tierValues[level];

  return (
    <div className="shop-card">
      <div className="shop-card-head">
        <span className="shop-card-icon">{meta.icon}</span>
        <div className="shop-card-titles">
          <h3 className="shop-card-name">{meta.name}</h3>
          <p className="shop-card-blurb">{meta.blurb}</p>
        </div>
      </div>

      <div className="shop-tier-row">
        {Array.from({ length: MODULE_MAX_TIER }, (_, i) => (
          <span key={i} className={`shop-tier-pip ${i < level ? 'filled' : ''}`} />
        ))}
        <span className="shop-tier-label">
          {level > 0 ? `TIER ${level}/${MODULE_MAX_TIER}` : 'NOT INSTALLED'}
        </span>
      </div>

      <div className="shop-card-stats">
        <span>
          Current: <b>{currentValue !== null ? `${currentValue}${meta.unit}` : '—'}</b>
        </span>
        {nextValue !== null && (
          <span className="shop-card-next">
            Next: <b>{nextValue}{meta.unit}</b>
          </span>
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
  onPurchase,
  onClose
}) => {
  if (!isVisible) return null;

  return (
    <div className="shop-modal">
      <div className="shop-card-container">
        <div className="shop-header">
          <div>
            <h2 className="shop-title">⚙️ MODULE SHOP</h2>
            <p className="shop-subtitle">Modules last for this run only • Warp resumes when you close</p>
          </div>
          <div className="shop-gem-bank">💎 {totalGems}</div>
        </div>

        <div className="shop-cards">
          <ModuleCard type="powerGen" level={powerGenLevel} totalGems={totalGems} onPurchase={onPurchase} />
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
