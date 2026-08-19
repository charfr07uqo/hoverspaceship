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

const renderStars = (stars: number) => {
  const filled = Math.max(1, Math.min(5, stars));
  return (
    <span className="star-rating">
      {'★'.repeat(filled)}
      <span className="star-empty">{'☆'.repeat(5 - filled)}</span>
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
      {/* Ship Quick Tabs */}
      <div className="ship-tabs-row">
        {SHIP_IDS.map((id) => {
          const cfg = SHIPS_CONFIG[id];
          const unlocked = unlockedShips.includes(id);
          const active = currentShipModel === id;
          return (
            <button
              key={id}
              type="button"
              className={`ship-tab-chip ${active ? 'active' : ''} ${unlocked ? 'unlocked' : 'locked'}`}
              onClick={() => handleSelectShip(id)}
              title={cfg.name}
            >
              <span className="ship-tab-icon">{unlocked ? '🚀' : '🔒'}</span>
              <span className="ship-tab-label">{cfg.name.split(' ')[1] || cfg.name}</span>
            </button>
          );
        })}
      </div>

      <div className="ship-selector-header">
        <button type="button" className="nav-arrow-btn" onClick={handlePrev} title="Previous Ship">
          ◀
        </button>

        <div className="ship-name-badge">
          <span className="ship-name">{currentConfig.name}</span>
          <span className="ship-tagline">{currentConfig.tagline}</span>
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
      </div>

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
