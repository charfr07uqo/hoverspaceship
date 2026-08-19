import React from 'react';
import { DifficultySelector } from './DifficultySelector';
import { DifficultyKey } from '../types/game';

interface GameOverScreenProps {
  isVisible: boolean;
  score: number;
  gems: number;
  totalGems: number;
  level: number;
  highScore: number;
  enemiesSurvived: number;
  runTimeSec: number;
  currentDifficulty: DifficultyKey;
  onSelectDifficulty: (diffKey: DifficultyKey) => void;
  onRestart: () => void;
  onHome: () => void;
}

export const GameOverScreen: React.FC<GameOverScreenProps> = ({
  isVisible,
  score,
  gems,
  totalGems,
  level,
  highScore,
  enemiesSurvived,
  runTimeSec,
  currentDifficulty,
  onSelectDifficulty,
  onRestart,
  onHome
}) => {
  const formatDuration = (totalSec: number): string => {
    const rounded = Math.floor(totalSec);
    const minutes = Math.floor(rounded / 60);
    const seconds = rounded % 60;
    return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
  };

  return (
    <div className={`overlay ${!isVisible ? 'hidden' : ''}`}>
      <h1 className="impact-title">ASTEROID IMPACT</h1>

      <div className="stat-card">
        <div className="stat-row">
          <span className="stat-label">Sector Level Reached</span>
          <span className="stat-value highlight-level">LEVEL {level}</span>
        </div>
        <div className="stat-row">
          <span className="stat-label">Time Survived</span>
          <span className="stat-value">{formatDuration(runTimeSec)}</span>
        </div>
        <div className="stat-row">
          <span className="stat-label">Enemies Survived</span>
          <span className="stat-value">{enemiesSurvived}</span>
        </div>
        <div className="stat-row">
          <span className="stat-label">Final Score</span>
          <span className="stat-value">{score}</span>
        </div>
        <div className="stat-row">
          <span className="stat-label">Gems Collected (Run)</span>
          <span className="stat-value">+{gems} 💎</span>
        </div>
        <div className="stat-row">
          <span className="stat-label">Total Vault Gems</span>
          <span className="stat-value">{totalGems} 💎</span>
        </div>
        <div className="stat-row">
          <span className="stat-label">Best Score</span>
          <span className="stat-value">{highScore}</span>
        </div>
      </div>

      <DifficultySelector
        currentDifficulty={currentDifficulty}
        onSelectDifficulty={onSelectDifficulty}
      />

      <div className="btn-group">
        <button className="btn btn-secondary" onClick={onHome} type="button">
          HOME
        </button>
        <button className="btn" onClick={onRestart} type="button">
          TRY AGAIN
        </button>
      </div>
    </div>
  );
};
