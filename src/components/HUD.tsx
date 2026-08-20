import React, { useEffect, useState } from 'react';
import { LevelSimulator } from './LevelSimulator';
import { DifficultyKey, GameState, ModuleStatus, ShipModelId } from '../types/game';
import {
  DIFFICULTY_SETTINGS,
  MODULE_META,
  SHIPS_CONFIG,
  getDifficultyShieldChargeBonus,
  getEnemySpawnSchedule,
  getLevelDuration
} from '../constants/gameConfig';

interface HUDProps {
  score: number;
  highScore: number;
  gems: number;
  totalGems: number;
  level: number;
  levelProgress: number; // 0 to 1
  threatsRemaining: number;
  currentDifficulty: DifficultyKey;
  currentShipModel: ShipModelId;
  moduleStatus: ModuleStatus;
  gameState: GameState;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onHome: () => void;
  onRestart: () => void;
  onPauseChange: (paused: boolean) => void;
}

export const HUD: React.FC<HUDProps> = ({
  score,
  highScore,
  gems,
  totalGems,
  level,
  levelProgress,
  threatsRemaining,
  currentDifficulty,
  currentShipModel,
  moduleStatus,
  gameState,
  isFullscreen,
  onToggleFullscreen,
  onHome,
  onRestart,
  onPauseChange
}) => {
  const [pulseScore, setPulseScore] = useState(false);
  const [pulseHighScore, setPulseHighScore] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [showSimulator, setShowSimulator] = useState(false);

  const diffConfig = DIFFICULTY_SETTINGS[currentDifficulty] || DIFFICULTY_SETTINGS.normal;
  const shipConfig = SHIPS_CONFIG[currentShipModel] || SHIPS_CONFIG.dart;
  // Free reflect charges the difficulty is contributing (EASY only today), so the
  // shield readout can attribute them rather than looking like a module bonus.
  const diffShieldBonus = getDifficultyShieldChargeBonus(currentDifficulty);

  useEffect(() => {
    if (score > 0) {
      setPulseScore(true);
      const timer = setTimeout(() => setPulseScore(false), 160);
      return () => clearTimeout(timer);
    }
  }, [score]);

  useEffect(() => {
    if (highScore > 0) {
      setPulseHighScore(true);
      const timer = setTimeout(() => setPulseHighScore(false), 200);
      return () => clearTimeout(timer);
    }
  }, [highScore]);

  // Close menu if game state leaves active gameplay
  useEffect(() => {
    if (gameState !== 'PLAYING' && gameState !== 'WARPING') {
      setIsMenuOpen(false);
    }
  }, [gameState]);

  // Pause the simulation whenever the in-game menu is open during active gameplay
  useEffect(() => {
    const inGame = gameState === 'PLAYING' || gameState === 'WARPING';
    onPauseChange(inGame && isMenuOpen);
  }, [isMenuOpen, gameState, onPauseChange]);

  // DO NOT RENDER IN-GAME HUD DURING MAIN MENU OR GAMEOVER SCREEN
  if (gameState === 'START' || gameState === 'GAMEOVER') {
    return null;
  }

  return (
    <div className="ui-layer">
      {/* Top HUD Stats */}
      <div className="hud">
        <div className="hud-group">
          {/* Active Difficulty Badge */}
          <div
            className="score-box diff-badge"
            style={{
              borderColor: diffConfig.themeColor,
              boxShadow: `0 0 12px ${diffConfig.themeGlow}`
            }}
            title={`Difficulty: ${diffConfig.label}`}
          >
            <span style={{ color: diffConfig.themeColor }}>{diffConfig.label}</span>
          </div>

          <div className={`score-box ${pulseScore ? 'pulse' : ''}`}>
            SCORE: <span>{score}</span>
          </div>

          <div className="score-box gem-badge" title={`Vault Total: ${totalGems} | This Run: +${gems}`}>
            💎 <span>{totalGems}</span>
          </div>
        </div>

        <div className="hud-group">
          <div className={`score-box ${pulseHighScore ? 'pulse' : ''}`}>
            BEST: <span>{highScore}</span>
          </div>

          {/* In-Game Menu Dropdown Button */}
          <button
            type="button"
            className="score-box menu-hud-btn"
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            title="Open In-Game Menu"
          >
            ⚙️
          </button>
        </div>
      </div>

      {/* In-Game Menu Modal Overlay */}
      {isMenuOpen && (
        <div className="ingame-menu-modal">
          <div className="ingame-menu-card">
            <h3 className="ingame-menu-title">GAME PAUSED</h3>
            <p className="ingame-menu-sub">Sector {level} • {diffConfig.label}</p>

            <div className="ingame-menu-actions">
              <button
                type="button"
                className="btn ingame-menu-btn"
                onClick={() => setIsMenuOpen(false)}
              >
                ▶ RESUME FLIGHT
              </button>

              <button
                type="button"
                className="btn btn-secondary ingame-menu-btn"
                onClick={() => {
                  onToggleFullscreen();
                }}
              >
                {isFullscreen ? '🗗 EXIT FULLSCREEN' : '⛶ FULLSCREEN'}
              </button>

              <button
                type="button"
                className="btn btn-secondary ingame-menu-btn"
                onClick={() => setShowSimulator(true)}
              >
                📊 LEVEL SIMULATOR
              </button>

              <button
                type="button"
                className="btn btn-secondary ingame-menu-btn"
                onClick={() => {
                  setIsMenuOpen(false);
                  onRestart();
                }}
              >
                🔄 RESTART FLIGHT
              </button>

              <button
                type="button"
                className="btn btn-secondary ingame-menu-btn exit-home-btn"
                onClick={() => {
                  setIsMenuOpen(false);
                  onHome();
                }}
              >
                🏠 RETURN TO TITLE
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Level Progression Simulator Modal (accessible from pause menu) */}
      <LevelSimulator
        isVisible={showSimulator}
        currentDifficulty={currentDifficulty}
        onClose={() => setShowSimulator(false)}
      />

      {/* Spacewarp Level Transition Hologram Banner */}
      {gameState === 'WARPING' && (
        <div className="warp-banner-overlay">
          <div className="warp-banner-content">
            <div className="warp-status-pill">⚡ HYPERSPACE DRIVE ENGAGED</div>
            <h2 className="warp-title">SECTOR {level} CLEARED!</h2>
            <p className="warp-subtitle">WARPING TO SECTOR {level + 1}...</p>
            <div className="warp-energy-bar">
              <div className="warp-energy-fill" />
            </div>
          </div>
        </div>
      )}

      {/* Ship Status: hull specials + module charge bars */}
      {(moduleStatus.powerGenLevel > 0 ||
        moduleStatus.autoCannonLevel > 0 ||
        moduleStatus.maxShieldCharges > 1 ||
        moduleStatus.trueVisionActive) && (
        <div className="module-hud">
          {/* Reinforced reflect shell: one pip per charge, lit while available */}
          {moduleStatus.maxShieldCharges > 1 && (
            <div
              className="module-hud-row"
              title={
                `Reflect shield — ${moduleStatus.shieldCharges} of ${moduleStatus.maxShieldCharges} charges left` +
                (diffShieldBonus > 0
                  ? ` (includes +${diffShieldBonus} from ${diffConfig.label})`
                  : '')
              }
            >
              <span className="module-hud-icon">🛡️</span>
              {moduleStatus.shieldCellLevel > 0 && (
                <span className="module-hud-lvl">L{moduleStatus.shieldCellLevel}</span>
              )}
              {/* Attributes the handout so the extra pip is not mistaken for a
                  module the player forgot buying. */}
              {diffShieldBonus > 0 && (
                <span className="module-hud-lvl diff-bonus-tag">+{diffShieldBonus} {diffConfig.label}</span>
              )}
              <span className="module-hud-pips">
                {Array.from({ length: moduleStatus.maxShieldCharges }, (_, idx) => (
                  <span
                    key={idx}
                    className={`shield-charge-pip ${idx < moduleStatus.shieldCharges ? 'lit' : ''}`}
                  />
                ))}
              </span>
            </div>
          )}

          {/* True Sight: disguised bombs stay in their revealed form */}
          {moduleStatus.trueVisionActive && (
            <div className="module-hud-row" title="True Sight — disguised bombs stay revealed">
              <span className="module-hud-icon">👁️</span>
              <span className="module-hud-lvl">TRUE SIGHT</span>
            </div>
          )}

          {moduleStatus.powerGenLevel > 0 && (
            <div className="module-hud-row" title="Power Generator - shield regeneration">
              <span className="module-hud-icon">{MODULE_META.powerGen.icon}</span>
              <span className="module-hud-lvl">L{moduleStatus.powerGenLevel}</span>
              <div className="module-hud-track">
                <div
                  className={`module-hud-fill shield ${
                    moduleStatus.shieldCharges >= moduleStatus.maxShieldCharges ? 'ready' : ''
                  }`}
                  style={{ width: `${Math.round(moduleStatus.shieldRegenProgress * 100)}%` }}
                />
              </div>
            </div>
          )}
          {moduleStatus.autoCannonLevel > 0 && (
            <div className="module-hud-row" title="Auto Cannon - reload">
              <span className="module-hud-icon">{MODULE_META.autoCannon.icon}</span>
              <span className="module-hud-lvl">L{moduleStatus.autoCannonLevel}</span>
              <div className="module-hud-track">
                <div
                  className={`module-hud-fill cannon ${moduleStatus.cannonProgress >= 1 ? 'ready' : ''}`}
                  style={{ width: `${Math.round(moduleStatus.cannonProgress * 100)}%` }}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Bottom Combined Sector Progression & Telemetry Stats Footer */}
      <div className="bottom-hud-container">
        {/* Sector Progress Bar (variable countdown: 30s + 5s/level) with Red Enemy Threat Markers */}
        {gameState !== 'WARPING' && (
          <div className="level-progress-container">
            <div className="level-progress-track">
              <div
                className="level-progress-fill"
                style={{ width: `${Math.min(100, Math.max(0, levelProgress * 100))}%` }}
              />
              {/* Red Enemy Spawn Warning Markers */}
              {(() => {
                const duration = getLevelDuration(level);
                const enemyTimes = getEnemySpawnSchedule(level);
                return enemyTimes.map((time, idx) => {
                  const percent = (time / duration) * 100;
                  const isPassed = levelProgress * duration >= time;
                  return (
                    <div
                      key={idx}
                      className={`enemy-progress-marker ${isPassed ? 'passed' : 'active'}`}
                      style={{ left: `${percent}%` }}
                      title={`Enemy Interceptor Alert at ${time}s`}
                    />
                  );
                });
              })()}
            </div>
            <div className="level-progress-subline">
              <span className="level-progress-label">
                SECTOR {level} ({Math.floor(levelProgress * getLevelDuration(level))}s / {getLevelDuration(level)}s)
              </span>
              {level >= 2 && (
                threatsRemaining > 0 ? (
                  <span className="enemy-alert-tag">
                    👾 {threatsRemaining} {threatsRemaining === 1 ? 'THREAT' : 'THREATS'}
                  </span>
                ) : (
                  <span className="enemy-alert-tag cleared">✓ SECTOR CLEAR</span>
                )
              )}
            </div>
          </div>
        )}

        {/* Telemetry Stats Bar */}
        <div className="telemetry-footer">
          <span>🚀 <b>{shipConfig.name.toUpperCase()}</b> ({shipConfig.sizeLabel})</span>
          <span>•</span>
          <span>REACTIVITY: <b>{shipConfig.reactivityLabel}</b></span>
          <span>•</span>
          <span>SPEED: <b>{shipConfig.speedLabel}</b></span>
        </div>
      </div>
    </div>
  );
};
