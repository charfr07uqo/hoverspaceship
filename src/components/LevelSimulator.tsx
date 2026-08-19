import React, { useMemo, useState } from 'react';
import { DifficultyKey } from '../types/game';
import { DIFFICULTY_SETTINGS, simulateLevel } from '../constants/gameConfig';

interface LevelSimulatorProps {
  isVisible: boolean;
  currentDifficulty: DifficultyKey;
  onClose: () => void;
}

const LEVELS_PER_PAGE = 10;

export const LevelSimulator: React.FC<LevelSimulatorProps> = ({ isVisible, currentDifficulty, onClose }) => {
  const [previewDiff, setPreviewDiff] = useState<DifficultyKey>(currentDifficulty);
  const [page, setPage] = useState(0); // 0-indexed page of 10 sectors
  const [showInfo, setShowInfo] = useState(false);

  // Keep the preview in sync with the difficulty selected on the home screen
  React.useEffect(() => {
    setPreviewDiff(currentDifficulty);
  }, [currentDifficulty]);

  // Reset to the first page whenever the simulator is (re)opened
  React.useEffect(() => {
    if (isVisible) setPage(0);
  }, [isVisible]);

  const rows = useMemo(() => {
    const startLevel = page * LEVELS_PER_PAGE + 1;
    return Array.from({ length: LEVELS_PER_PAGE }, (_, i) => simulateLevel(startLevel + i, previewDiff));
  }, [previewDiff, page]);

  if (!isVisible) return null;

  const diffKeys = Object.keys(DIFFICULTY_SETTINGS) as DifficultyKey[];

  return (
    <div className="overlay sim-overlay" onClick={onClose}>
      <div className="sim-card" onClick={(e) => e.stopPropagation()}>
        <div className="sim-header">
          <h2 className="sim-title">🛰️ SECTOR SIMULATOR</h2>
          <div className="sim-header-actions">
            <button
              type="button"
              className={`sim-info-btn ${showInfo ? 'active' : ''}`}
              onClick={() => setShowInfo((s) => !s)}
              title="Legend"
            >
              ?
            </button>
            <button type="button" className="sim-close-btn" onClick={onClose} title="Close">
              ✕
            </button>
          </div>
        </div>

        {showInfo && (
          <ul className="sim-legend">
            <li><b>DURATION</b> sector length.</li>
            <li><b>ENEMIES</b> interceptors; icons = types.</li>
            <li><b>DENSITY</b> rock frequency.</li>
            <li><b>BOMBS</b> chance a gem is a bomb.</li>
            <li><b>MOVERS</b> drift speed (🪨); fewer rocks.</li>
            <li><b>SPEED</b> scroll speed.</li>
            <li>Sectors are infinite. Values at sector entry.</li>
          </ul>
        )}

        {/* Difficulty preview toggle */}
        <div className="sim-diff-toggle">
          {diffKeys.map((key) => {
            const cfg = DIFFICULTY_SETTINGS[key];
            const active = key === previewDiff;
            return (
              <button
                key={key}
                type="button"
                className={`sim-diff-btn ${active ? 'active' : ''}`}
                style={active ? { borderColor: cfg.themeColor, color: cfg.themeColor, boxShadow: `0 0 10px ${cfg.themeGlow}` } : undefined}
                onClick={() => setPreviewDiff(key)}
              >
                {cfg.label}
              </button>
            );
          })}
        </div>

        <div className="sim-table-scroll">
          <table className="sim-table">
            <thead>
              <tr>
                <th>SECTOR</th>
                <th>DURATION</th>
                <th>ENEMIES</th>
                <th>DENSITY</th>
                <th>BOMBS</th>
                <th>MOVERS</th>
                <th>SPEED</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.level}>
                  <td className="sim-sector-cell">{r.level}</td>
                  <td>{r.durationSec}s</td>
                  <td>
                    {r.enemyCount === 0 ? (
                      <span className="sim-muted">none</span>
                    ) : (
                      <span
                        className="sim-enemy-cell"
                        title={`Spawns at: ${r.enemyTimes.map((t) => `${t}s`).join(', ')}\nTypes: ${r.enemyVariants
                          .map((v) => v.label)
                          .join(', ')}`}
                      >
                        👾 {r.enemyCount}
                        {r.enemyVariants
                          .filter((v) => v.key !== 'standard')
                          .map((v) => (
                            <span key={v.key} className="sim-enemy-variant" title={`${v.label} unlocked`}>
                              {v.icon}
                            </span>
                          ))}
                      </span>
                    )}
                  </td>
                  <td>
                    <div className="sim-density-wrap">
                      <div className="sim-density-track">
                        <div className="sim-density-fill" style={{ width: `${r.rockDensityPct}%` }} />
                      </div>
                    </div>
                  </td>
                  <td>
                    {r.bombChancePct > 0 ? (
                      <span className="sim-bomb-chance" title="Chance a gem is a disguised bomb">
                        💣 {r.bombChancePct}%
                      </span>
                    ) : (
                      <span className="sim-muted">none</span>
                    )}
                  </td>
                  <td>
                    {r.movingAsteroidsActive ? (
                      <span
                        className="sim-mover-cell"
                        title={`Some rock formations drift up/down at ${r.movingAsteroidSpeed.toFixed(
                          2
                        )} units/frame. Movers carry fewer rocks.`}
                      >
                        🪨 {r.movingAsteroidSpeed.toFixed(2)}
                      </span>
                    ) : (
                      <span className="sim-muted">static</span>
                    )}
                  </td>
                  <td>{r.gameSpeed.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination: infinite sectors, 10 per page */}
        <div className="sim-pagination">
          <button
            type="button"
            className="sim-page-btn"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
          >
            ‹ PREV
          </button>
          <span className="sim-page-label">
            SECTORS {page * LEVELS_PER_PAGE + 1}–{(page + 1) * LEVELS_PER_PAGE}
          </span>
          <button
            type="button"
            className="sim-page-btn"
            onClick={() => setPage((p) => p + 1)}
          >
            NEXT ›
          </button>
        </div>

      </div>
    </div>
  );
};
