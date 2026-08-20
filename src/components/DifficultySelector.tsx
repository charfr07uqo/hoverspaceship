import React from 'react';
import { soundManager } from '../audio/soundManager';
import { DifficultyKey } from '../types/game';
import { DIFFICULTY_SETTINGS, getDifficultyShieldChargeBonus } from '../constants/gameConfig';

const DIFFICULTIES: { key: DifficultyKey; label: string }[] = [
  { key: 'easy', label: 'EASY' },
  { key: 'normal', label: 'NORMAL' },
  { key: 'hard', label: 'HARD' },
  { key: 'exhard', label: 'EX-HARD' }
];

interface DifficultySelectorProps {
  currentDifficulty: DifficultyKey;
  onSelectDifficulty: (diffKey: DifficultyKey) => void;
}

export const DifficultySelector: React.FC<DifficultySelectorProps> = ({
  currentDifficulty,
  onSelectDifficulty
}) => {
  const handleSelect = (diffKey: DifficultyKey) => {
    soundManager.init();
    if (diffKey !== currentDifficulty) {
      soundManager.playDiffSwitchSound(diffKey);
      onSelectDifficulty(diffKey);
    }
  };

  const activeConfig = DIFFICULTY_SETTINGS[currentDifficulty] || DIFFICULTY_SETTINGS.normal;
  // Difficulties can hand out free reflect-shell charges (EASY does). Surfaced
  // here so the perk is visible at the moment the choice is being made.
  const shieldBonus = getDifficultyShieldChargeBonus(currentDifficulty);

  return (
    <>
      <div className="difficulty-selector" data-active={currentDifficulty}>
        <div className="diff-indicator" />
        {DIFFICULTIES.map((d) => {
          const bonus = getDifficultyShieldChargeBonus(d.key);
          return (
            <button
              key={d.key}
              className={`diff-btn ${currentDifficulty === d.key ? 'active' : ''}`}
              onClick={() => handleSelect(d.key)}
              type="button"
              title={
                bonus > 0
                  ? `${d.label} — grants +${bonus} reflect shield charge${bonus === 1 ? '' : 's'}`
                  : d.label
              }
            >
              {d.label}
              {bonus > 0 && (
                <span className="diff-perk-dot" aria-hidden="true">
                  🛡️
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* What the selected difficulty actually changes, plus any perk it grants.
          Keyed on the difficulty so the text re-triggers its fade on each switch. */}
      <div className="diff-info-panel" key={currentDifficulty}>
        <p className="diff-blurb">{activeConfig.blurb}</p>
        {shieldBonus > 0 && (
          <span className="diff-perk-note">
            🛡️ +{shieldBonus} SHIELD CHARGE{shieldBonus === 1 ? '' : 'S'} ON EVERY HULL
          </span>
        )}
      </div>
    </>
  );
};
