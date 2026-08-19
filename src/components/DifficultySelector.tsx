import React from 'react';
import { soundManager } from '../audio/soundManager';
import { DifficultyKey } from '../types/game';

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

  return (
    <div className="difficulty-selector" data-active={currentDifficulty}>
      <div className="diff-indicator" />
      {DIFFICULTIES.map((d) => (
        <button
          key={d.key}
          className={`diff-btn ${currentDifficulty === d.key ? 'active' : ''}`}
          onClick={() => handleSelect(d.key)}
          type="button"
        >
          {d.label}
        </button>
      ))}
    </div>
  );
};
