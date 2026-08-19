import React from 'react';
import { ShipSelector } from './ShipSelector';
import { ShipColorPicker } from './ShipColorPicker';
import { ShipColorKey, ShipModelId } from '../types/game';
import { SHIPS_CONFIG, SHIP_COLORS } from '../constants/gameConfig';

interface HangarScreenProps {
  isVisible: boolean;
  currentShipModel: ShipModelId;
  unlockedShips: ShipModelId[];
  totalGems: number;
  currentShipColor: ShipColorKey;
  onSelectShipModel: (modelId: ShipModelId) => void;
  onUnlockShip: (modelId: ShipModelId, cost: number) => void;
  onSelectShipColor: (colorKey: ShipColorKey) => void;
  onBackToMenu: () => void;
}

export const HangarScreen: React.FC<HangarScreenProps> = ({
  isVisible,
  currentShipModel,
  unlockedShips,
  totalGems,
  currentShipColor,
  onSelectShipModel,
  onUnlockShip,
  onSelectShipColor,
  onBackToMenu
}) => {
  const activeShip = SHIPS_CONFIG[currentShipModel];
  const activeColor = SHIP_COLORS[currentShipColor];

  return (
    <div className={`overlay start-overlay ${!isVisible ? 'hidden' : ''}`}>
      {/* Top Header */}
      <div className="title-top-bar">
        <div className="hangar-title-group">
          <h1>SPACE HANGAR</h1>
          <span className="hangar-subtitle">Fleet Showcase & Customization</span>
        </div>
        <div className="gems-wallet-chip" title="Vault Gems">
          💎 <span>{totalGems}</span> GEMS
        </div>
      </div>

      {/* 3D Ship Hologram Viewport Zone - 100% Unobstructed Stage */}
      <div className="ship-showcase-viewport hangar-viewport" />

      {/* Active Ship Selected Name Tag */}
      <div className="showcase-ship-badge hangar-badge">
        <div className="badge-row">
          <span
            className="equipped-color-dot"
            style={{ backgroundColor: activeColor.color, boxShadow: `0 0 10px ${activeColor.glow}` }}
          />
          <span className="badge-ship-name">{activeShip.name}</span>
          <span className="badge-color-name">({activeColor.label})</span>
        </div>
      </div>

      {/* Ship Selection with Quick Tabs & Stats & Unlocking */}
      <ShipSelector
        currentShipModel={currentShipModel}
        unlockedShips={unlockedShips}
        totalGems={totalGems}
        onSelectShip={onSelectShipModel}
        onUnlockShip={onUnlockShip}
      />

      {/* Color Customization */}
      <ShipColorPicker
        currentShipColor={currentShipColor}
        onSelectShipColor={onSelectShipColor}
      />

      <button className="btn btn-secondary hangar-back-btn" onClick={onBackToMenu} type="button">
        ◀ RETURN TO TITLE
      </button>

      {/* Hangar Telemetry Specs */}
      <div className="menu-telemetry-footer">
        <div className="telemetry-item">
          <span className="telemetry-label">FUSELAGE</span>
          <span className="telemetry-val">{activeShip.name.split(' ')[1] || activeShip.name}</span>
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
          <span className="telemetry-label">TOP SPEED</span>
          <span className="telemetry-val">{activeShip.speed} M</span>
        </div>
      </div>
    </div>
  );
};
