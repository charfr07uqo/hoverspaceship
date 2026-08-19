import React from 'react';
import { SHIP_COLORS } from '../constants/gameConfig';
import { ShipColorKey } from '../types/game';
import { soundManager } from '../audio/soundManager';

interface ShipColorPickerProps {
  currentShipColor: ShipColorKey;
  onSelectShipColor: (colorKey: ShipColorKey) => void;
}

const COLOR_KEYS: ShipColorKey[] = ['blue', 'green', 'red', 'pink'];

export const ShipColorPicker: React.FC<ShipColorPickerProps> = ({
  currentShipColor,
  onSelectShipColor
}) => {
  const handleSelect = (colorKey: ShipColorKey) => {
    soundManager.init();
    if (colorKey !== currentShipColor) {
      soundManager.playDiffSwitchSound('normal');
      onSelectShipColor(colorKey);
    }
  };

  return (
    <div className="ship-color-picker-container">
      <span className="picker-label">SHIP COLOR</span>
      <div className="color-swatches">
        {COLOR_KEYS.map((key) => {
          const config = SHIP_COLORS[key];
          const isSelected = currentShipColor === key;
          return (
            <button
              key={key}
              type="button"
              className={`color-swatch-btn ${isSelected ? 'selected' : ''}`}
              style={{
                '--swatch-color': config.color,
                '--swatch-glow': config.glow
              } as React.CSSProperties}
              onClick={() => handleSelect(key)}
              title={config.label}
            >
              <span className="swatch-dot" />
              <span className="swatch-name">{config.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
