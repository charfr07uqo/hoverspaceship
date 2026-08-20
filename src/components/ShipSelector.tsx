import React from 'react';
import { SHIPS_CONFIG, SHIP_IDS, computeShieldCharges } from '../constants/gameConfig';
import { ShipModelId } from '../types/game';
import { soundManager } from '../audio/soundManager';

interface ShipSelectorProps {
  /** Hull currently on show. Browsing locked hulls is how the player shops. */
  browsedShipModel: ShipModelId;
  /** Hull the player flies. Changing it requires an explicit EQUIP. */
  equippedShipModel: ShipModelId;
  unlockedShips: ShipModelId[];
  totalGems: number;
  onBrowseShip: (modelId: ShipModelId) => void;
  onEquipShip: (modelId: ShipModelId) => void;
  onUnlockShip: (modelId: ShipModelId) => void;
}

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
  browsedShipModel,
  equippedShipModel,
  unlockedShips,
  totalGems,
  onBrowseShip,
  onEquipShip,
  onUnlockShip
}) => {
  const currentConfig = SHIPS_CONFIG[browsedShipModel];
  const isUnlocked = unlockedShips.includes(browsedShipModel);
  const isEquipped = browsedShipModel === equippedShipModel;
  const canAfford = totalGems >= currentConfig.cost;
  // Hangar preview: the hull's own rating, before any in-run module bonus.
  const hullShieldCharges = computeShieldCharges(browsedShipModel);

  /** Browsing only. Never equips, so locked hulls stay safe to look at. */
  const handleBrowse = (modelId: ShipModelId) => {
    soundManager.init();
    if (modelId !== browsedShipModel) {
      soundManager.playDiffSwitchSound('normal');
      onBrowseShip(modelId);
    }
  };

  const handlePrev = () => {
    const idx = SHIP_IDS.indexOf(browsedShipModel);
    const prevIdx = (idx - 1 + SHIP_IDS.length) % SHIP_IDS.length;
    handleBrowse(SHIP_IDS[prevIdx]);
  };

  const handleNext = () => {
    const idx = SHIP_IDS.indexOf(browsedShipModel);
    const nextIdx = (idx + 1) % SHIP_IDS.length;
    handleBrowse(SHIP_IDS[nextIdx]);
  };

  const handleEquip = () => {
    soundManager.init();
    if (isUnlocked && !isEquipped) {
      soundManager.playDiffSwitchSound('normal');
      onEquipShip(browsedShipModel);
    }
  };

  const handleUnlock = () => {
    soundManager.init();
    if (!isUnlocked && canAfford) {
      soundManager.playGemSound();
      onUnlockShip(browsedShipModel);
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
            HULL {SHIP_IDS.indexOf(browsedShipModel) + 1} / {SHIP_IDS.length}
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
            {hullShieldCharges} HIT{hullShieldCharges === 1 ? '' : 'S'}
          </span>
          {renderShieldPips(hullShieldCharges)}
        </div>
      </div>

      {/* Hull special (shield charges, True Sight, ...) */}
      {currentConfig.special && (
        <div className="ship-special-row">
          <span className="ship-special-tag">SPECIAL</span>
          <span className="ship-special-text">{currentConfig.special}</span>
        </div>
      )}

      {/* Unlock / Equip status. Three states: locked, owned, equipped. */}
      <div className="ship-action-container">
        {!isUnlocked ? (
          <button
            type="button"
            className={`btn-unlock ${canAfford ? 'can-afford' : 'cannot-afford'}`}
            onClick={handleUnlock}
            disabled={!canAfford}
          >
            {canAfford ? (
              <>UNLOCK {currentConfig.name.toUpperCase()} (💎 {currentConfig.cost})</>
            ) : (
              <>NEED 💎 {currentConfig.cost} (VAULT: {totalGems})</>
            )}
          </button>
        ) : isEquipped ? (
          <div className="unlocked-badge">
            ✓ EQUIPPED & READY
          </div>
        ) : (
          <button type="button" className="btn-unlock can-afford" onClick={handleEquip}>
            EQUIP {currentConfig.name.toUpperCase()}
          </button>
        )}
      </div>
    </div>
  );
};
