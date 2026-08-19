import React, { useState } from 'react';
import { DifficultySelector } from './DifficultySelector';
import { LevelSimulator } from './LevelSimulator';
import { DifficultyKey, ShipColorKey, ShipModelId } from '../types/game';
import { SHIPS_CONFIG, SHIP_COLORS, DIFFICULTY_SETTINGS } from '../constants/gameConfig';

interface StartScreenProps {
  isVisible: boolean;
  onStart: () => void;
  onOpenHangar: () => void;
  currentDifficulty: DifficultyKey;
  onSelectDifficulty: (diffKey: DifficultyKey) => void;
  currentShipModel: ShipModelId;
  currentShipColor: ShipColorKey;
  totalGems: number;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
}

const renderStars = (stars: number) => {
  const filled = Math.max(1, Math.min(5, stars));
  return (
    <span className="star-rating inline-stars">
      {'★'.repeat(filled)}
      <span className="star-empty">{'☆'.repeat(5 - filled)}</span>
    </span>
  );
};

export const StartScreen: React.FC<StartScreenProps> = ({
  isVisible,
  onStart,
  onOpenHangar,
  currentDifficulty,
  onSelectDifficulty,
  currentShipModel,
  currentShipColor,
  totalGems,
  isFullscreen,
  onToggleFullscreen
}) => {
  const activeShip = SHIPS_CONFIG[currentShipModel];
  const activeColor = SHIP_COLORS[currentShipColor];
  const activeDiff = DIFFICULTY_SETTINGS[currentDifficulty];

  const [showSimulator, setShowSimulator] = useState(false);

  return (
    <div className={`overlay start-overlay ${!isVisible ? 'hidden' : ''}`}>
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
          <div className="badge-row">
            <span
              className="equipped-color-dot"
              style={{ backgroundColor: activeColor.color, boxShadow: `0 0 10px ${activeColor.glow}` }}
            />
            <span className="badge-ship-name">{activeShip.name}</span>
            <span className="badge-color-name">({activeColor.label})</span>
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

      {/* Controls & Telemetry Footer */}
      <div className="menu-telemetry-footer">
        <div className="telemetry-item">
          <span className="telemetry-label">BASE SPEED</span>
          <span className="telemetry-val">{activeDiff.baseSpeed.toFixed(1)} Mach</span>
        </div>
        <div className="telemetry-item">
          <span className="telemetry-label">REACTIVITY</span>
          <span className="telemetry-val">{activeShip.smoothness}</span>
        </div>
        <div className="telemetry-item">
          <span className="telemetry-label">SHIP SIZE</span>
          <span className="telemetry-val">{activeShip.sizeScale}x</span>
        </div>
        <div className="telemetry-item">
          <span className="telemetry-label">BASE GAP</span>
          <span className="telemetry-val">{activeDiff.baseGap}px</span>
        </div>
      </div>

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
