import React from 'react';
import { SHIPS_CONFIG } from '../constants/gameConfig';
import { ShipModelId } from '../types/game';
import { soundManager } from '../audio/soundManager';

interface ShipSelectorProps {
  currentShipModel: ShipModelId;
  unlockedShips: ShipModelId[];
  totalGems: number;
  onSelectShip: (modelId: ShipModelId) => void;
  onUnlockShip: (modelId: ShipModelId, cost: number) => void;
}

const SHIP_IDS: ShipModelId[] = ['dart', 'viper', 'titan', 'phantom', 'valkyrie'];

/** Highest shield charge rating the pip readout can display. */
const MAX_SHIELD_PIPS = 5;

const renderStars = (stars: number) => {
  const filled = Math.max(1, Math.min(5, stars));
  return (
    <span className="star-rating">
      {'★'.repeat(filled)}
      <span className="star-empty">{'☆'.repeat(5 - filled)}</span>
    </span>
  );
};

/** Shield charges as filled/empty diamonds, leaving headroom for future upgrades. */
const renderShieldPips = (charges: number) => {
  const filled = Math.max(1, Math.min(MAX_SHIELD_PIPS, charges));
  return (
    <span className="star-rating shield-pips">
      {'◆'.repeat(filled)}
      <span className="star-empty">{'◇'.repeat(MAX_SHIELD_PIPS - filled)}</span>
    </span>
  );
};

export const ShipSelector: React.FC<ShipSelectorProps> = ({
  currentShipModel,
  unlockedShips,
  totalGems,
  onSelectShip,
  onUnlockShip
}) => {
  const currentConfig = SHIPS_CONFIG[currentShipModel];
  const isUnlocked = unlockedShips.includes(currentShipModel);

  const handleSelectShip = (modelId: ShipModelId) => {
    soundManager.init();
    if (modelId !== currentShipModel) {
      soundManager.playDiffSwitchSound('normal');
      onSelectShip(modelId);
    }
  };

  const handlePrev = () => {
    const idx = SHIP_IDS.indexOf(currentShipModel);
    const prevIdx = (idx - 1 + SHIP_IDS.length) % SHIP_IDS.length;
    handleSelectShip(SHIP_IDS[prevIdx]);
  };

  const handleNext = () => {
    const idx = SHIP_IDS.indexOf(currentShipModel);
    const nextIdx = (idx + 1) % SHIP_IDS.length;
    handleSelectShip(SHIP_IDS[nextIdx]);
  };

  const handleUnlock = () => {
    soundManager.init();
    if (!isUnlocked && totalGems >= currentConfig.cost) {
      soundManager.playGemSound();
      onUnlockShip(currentShipModel, currentConfig.cost);
    }
  };

  return (
    <div className="ship-selector-card">
      {/* Ships are browsed purely with the left/right arrows below. */}
      <div className="ship-selector-header">
        <button type="button" className="nav-arrow-btn" onClick={handlePrev} title="Previous Ship">
          ◀
        </button>

        <div className="ship-name-badge">
          <span className="ship-name">{currentConfig.name}</span>
          <span className="ship-tagline">{currentConfig.tagline}</span>
          {/* Read-only position marker now that the per-ship tabs are gone */}
          <span className="ship-index-counter">
            HULL {SHIP_IDS.indexOf(currentShipModel) + 1} / {SHIP_IDS.length}
          </span>
        </div>

        <button type="button" className="nav-arrow-btn" onClick={handleNext} title="Next Ship">
          ▶
        </button>
      </div>

      {/* 5-Star Stats Display */}
      <div className="ship-stats-grid">
        <div className="stat-pill">
          <span className="stat-pill-label">SHIP SIZE</span>
          <span className="stat-pill-value">{currentConfig.sizeLabel}</span>
          {renderStars(currentConfig.sizeStars)}
        </div>
        <div className="stat-pill">
          <span className="stat-pill-label">SPEED</span>
          <span className="stat-pill-value">{currentConfig.speedLabel}</span>
          {renderStars(currentConfig.speedStars)}
        </div>
        <div className="stat-pill">
          <span className="stat-pill-label">REACTIVITY</span>
          <span className="stat-pill-value">{currentConfig.reactivityLabel}</span>
          {renderStars(currentConfig.reactivityStars)}
        </div>
        <div className="stat-pill" title="Impacts the reflect shield can absorb before it breaks">
          <span className="stat-pill-label">SHIELD</span>
          <span className="stat-pill-value">
            {currentConfig.shieldCharges} HIT{currentConfig.shieldCharges === 1 ? '' : 'S'}
          </span>
          {renderShieldPips(currentConfig.shieldCharges)}
        </div>
      </div>

      {/* Hull special (shield charges, True Sight, ...) */}
      {currentConfig.special && (
        <div className="ship-special-row">
          <span className="ship-special-tag">SPECIAL</span>
          <span className="ship-special-text">{currentConfig.special}</span>
        </div>
      )}

      {/* Unlock / Select Status */}
      <div className="ship-action-container">
        {isUnlocked ? (
          <div className="unlocked-badge">
            ✓ SELECTED & READY
          </div>
        ) : (
          <button
            type="button"
            className={`btn-unlock ${totalGems >= currentConfig.cost ? 'can-afford' : 'cannot-afford'}`}
            onClick={handleUnlock}
            disabled={totalGems < currentConfig.cost}
          >
            {totalGems >= currentConfig.cost ? (
              <>UNLOCK {currentConfig.name.toUpperCase()} (💎 {currentConfig.cost})</>
            ) : (
              <>NEED 💎 {currentConfig.cost} (VAULT: {totalGems})</>
            )}
          </button>
        )}
      </div>
    </div>
  );
};
