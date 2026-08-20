import React, { useState } from 'react';
import { DifficultySelector } from './DifficultySelector';
import { LevelSimulator } from './LevelSimulator';
import { DifficultyKey, ShipColorKey, ShipModelId } from '../types/game';
import { SHIPS_CONFIG, SHIP_COLORS, SHIP_IDS } from '../constants/gameConfig';
import { soundManager } from '../audio/soundManager';

const renderStars = (stars: number) => {
  const filled = Math.max(1, Math.min(5, stars));
  return (
    <span className="star-rating inline-stars">
      {'★'.repeat(filled)}
      <span className="star-empty">{'☆'.repeat(5 - filled)}</span>
    </span>
  );
};

interface StartScreenProps {
  isVisible: boolean;
  /** Plays the 1s warp-in as the boot splash clears. */
  isIntroAnimating?: boolean;
  onStart: () => void;
  onOpenHangar: () => void;
  currentDifficulty: DifficultyKey;
  onSelectDifficulty: (diffKey: DifficultyKey) => void;
  currentShipModel: ShipModelId;
  onSelectShipModel: (modelId: ShipModelId) => void;
  unlockedShips: ShipModelId[];
  currentShipColor: ShipColorKey;
  totalGems: number;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
}

export const StartScreen: React.FC<StartScreenProps> = ({
  isVisible,
  isIntroAnimating = false,
  onStart,
  onOpenHangar,
  currentDifficulty,
  onSelectDifficulty,
  currentShipModel,
  onSelectShipModel,
  unlockedShips,
  currentShipColor,
  totalGems,
  isFullscreen,
  onToggleFullscreen
}) => {
  const activeShip = SHIPS_CONFIG[currentShipModel];
  const activeColor = SHIP_COLORS[currentShipColor];

  const [showSimulator, setShowSimulator] = useState(false);

  const handleSelectShip = (modelId: ShipModelId) => {
    soundManager.init();
    if (modelId !== currentShipModel) {
      soundManager.playDiffSwitchSound('normal');
      onSelectShipModel(modelId);
    }
  };

  // Only cycle through hulls the player has actually unlocked; locked hulls
  // are browsed and purchased from the Hangar instead.
  const availableShips = SHIP_IDS.filter((id) => unlockedShips.includes(id));

  const handlePrevShip = () => {
    if (availableShips.length < 2) return;
    const idx = availableShips.indexOf(currentShipModel);
    // idx of -1 means the active hull is not owned; snap back into the list.
    if (idx < 0) return handleSelectShip(availableShips[0]);
    const prevIdx = (idx - 1 + availableShips.length) % availableShips.length;
    handleSelectShip(availableShips[prevIdx]);
  };

  const handleNextShip = () => {
    if (availableShips.length < 2) return;
    const idx = availableShips.indexOf(currentShipModel);
    if (idx < 0) return handleSelectShip(availableShips[0]);
    const nextIdx = (idx + 1) % availableShips.length;
    handleSelectShip(availableShips[nextIdx]);
  };

  return (
    <div
      className={`overlay start-overlay ${!isVisible ? 'hidden' : ''} ${
        isIntroAnimating ? 'menu-warp-in' : ''
      }`}
    >
      {/* Top Header Bar */}
      <div className="title-top-bar">
        <div className="gems-wallet-chip" title="Total Vault Gems">
          💎 <span>{totalGems}</span> GEMS
        </div>

        <button
          type="button"
          className="fullscreen-title-btn"
          onClick={onToggleFullscreen}
          title={isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
        >
          {isFullscreen ? '🗗 EXIT FULLSCREEN' : '⛶ FULLSCREEN'}
        </button>
      </div>

      <div className="title-header">
        <h1>HOVER SPACESHIP</h1>
        <p className="subtitle-text">
          Arcade Sector Flight Simulator
        </p>
      </div>

      {/* 3D Ship Showcase Viewport Area - 100% Unobstructed Stage */}
      <div className="ship-showcase-viewport" />

      {/* Ship Info Badge & Hangar Button - Located Cleanly Below Stage */}
      <div className="showcase-info-container">
        <div className="showcase-ship-badge">
          <div className="badge-row ship-switcher-row">
            <button
              type="button"
              className="nav-arrow-btn"
              onClick={handlePrevShip}
              disabled={availableShips.length < 2}
              title="Previous Ship"
            >
              ◀
            </button>

            <div className="badge-row-center">
              <span
                className="equipped-color-dot"
                style={{ backgroundColor: activeColor.color, boxShadow: `0 0 10px ${activeColor.glow}` }}
              />
              <span className="badge-ship-name">{activeShip.name}</span>
              <span className="badge-color-name">({activeColor.label})</span>
            </div>

            <button
              type="button"
              className="nav-arrow-btn"
              onClick={handleNextShip}
              disabled={availableShips.length < 2}
              title="Next Ship"
            >
              ▶
            </button>
          </div>

          <div className="badge-stars-row">
            <span>SIZE {renderStars(activeShip.sizeStars)}</span>
            <span>•</span>
            <span>SPEED {renderStars(activeShip.speedStars)}</span>
            <span>•</span>
            <span>REACTIVITY {renderStars(activeShip.reactivityStars)}</span>
          </div>
        </div>

        <div className="showcase-btn-row">
          <button type="button" className="btn-open-hangar" onClick={onOpenHangar} title="Customize Ship in Hangar">
            🛠️ OPEN HANGAR & FLEET
          </button>
          <button
            type="button"
            className="btn-open-hangar btn-open-sim"
            onClick={() => setShowSimulator(true)}
            title="Preview sector progression"
          >
            🛰️ LEVEL SIMULATOR
          </button>
        </div>
      </div>

      {/* Difficulty Selector */}
      <DifficultySelector
        currentDifficulty={currentDifficulty}
        onSelectDifficulty={onSelectDifficulty}
      />

      {/* Launch Action Button - Primary call to action, anchored last */}
      <button className="btn launch-btn" onClick={onStart} type="button">
        🚀 LAUNCH SPACESHIP
      </button>

      {/* Level Progression Simulator Modal */}
      <LevelSimulator
        isVisible={showSimulator}
        currentDifficulty={currentDifficulty}
        onClose={() => setShowSimulator(false)}
      />
    </div>
  );
};
