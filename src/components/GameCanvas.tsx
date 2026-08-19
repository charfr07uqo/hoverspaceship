import React, { useEffect, useRef, useState } from 'react';
import { GameEngine } from '../game/GameEngine';
import { MODULE_MAX_TIER } from '../constants/gameConfig';
import { DifficultyKey, FloatingTextItem, GameOverSummary, GameState, ModuleStatus, ShipColorKey, ShipModelId } from '../types/game';

// Width (as a fraction of the screen) that the right-side fog of war covers when
// the Scanner Array module is not installed. Each tier peels this back until the
// fog is fully cleared at max tier.
const BASE_FOG_FRACTION = 0.33;

interface GameCanvasProps {
  engineRef: React.MutableRefObject<GameEngine | null>;
  currentDifficulty: DifficultyKey;
  currentShipColor: ShipColorKey;
  currentShipModel: ShipModelId;
  totalGems: number;
  zoomScannerLevel?: number;
  isHangarMode?: boolean;
  /** Hides the fog of war while the spacewarp animation plays. */
  isWarping?: boolean;
  onScoreUpdate: (score: number) => void;
  onGemsUpdate: (runGems: number, totalGems: number) => void;
  onGameOver: (summary: GameOverSummary) => void;
  onLevelUp: (newLevel: number) => void;
  onLevelProgress: (progressSec: number, totalSec: number) => void;
  onModuleStatus: (status: ModuleStatus) => void;
  onThreatCount: (remaining: number) => void;
  onGameStateChange: (state: GameState) => void;
}

export const GameCanvas: React.FC<GameCanvasProps> = ({
  engineRef,
  currentDifficulty,
  currentShipColor,
  currentShipModel,
  totalGems,
  zoomScannerLevel = 0,
  isHangarMode = false,
  isWarping = false,
  onScoreUpdate,
  onGemsUpdate,
  onGameOver,
  onLevelUp,
  onLevelProgress,
  onModuleStatus,
  onThreatCount,
  onGameStateChange
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [floatingTexts, setFloatingTexts] = useState<FloatingTextItem[]>([]);

  // Keep the latest callbacks in a ref so the engine (created once, below)
  // always invokes the current handlers instead of the stale first-render
  // closures. Without this, handlers like onGameOver would read initial state
  // (e.g. totalGems === 0), which made the gem bank appear to reset.
  const callbacksRef = useRef({
    onScoreUpdate,
    onGemsUpdate,
    onGameOver,
    onLevelUp,
    onLevelProgress,
    onModuleStatus,
    onThreatCount,
    onGameStateChange
  });
  callbacksRef.current = {
    onScoreUpdate,
    onGemsUpdate,
    onGameOver,
    onLevelUp,
    onLevelProgress,
    onModuleStatus,
    onThreatCount,
    onGameStateChange
  };

  useEffect(() => {
    if (!containerRef.current) return;

    const handleFloatText = (text: string, worldX: number, worldY: number, color: string = '#38bdf8') => {
      if (!containerRef.current) return;
      const engine = engineRef.current;
      if (!engine) return;

      const normX = (worldX + engine.bounds.halfWidth) / engine.bounds.width;
      const normY = (engine.bounds.halfHeight - worldY) / engine.bounds.height;

      const id = Date.now() + Math.random();
      const newFt: FloatingTextItem = {
        id,
        text,
        left: `${normX * 100}%`,
        top: `${normY * 100}%`,
        color
      };

      setFloatingTexts((prev) => [...prev, newFt]);
      setTimeout(() => {
        setFloatingTexts((prev) => prev.filter((ft) => ft.id !== id));
      }, 950);
    };

    const engine = new GameEngine(containerRef.current, {
      onScoreUpdate: (...args) => callbacksRef.current.onScoreUpdate(...args),
      onGemsUpdate: (...args) => callbacksRef.current.onGemsUpdate(...args),
      onGameOver: (...args) => callbacksRef.current.onGameOver(...args),
      onFloatText: handleFloatText,
      onLevelUp: (...args) => callbacksRef.current.onLevelUp(...args),
      onLevelProgress: (...args) => callbacksRef.current.onLevelProgress(...args),
      onModuleStatus: (...args) => callbacksRef.current.onModuleStatus(...args),
      onThreatCount: (...args) => callbacksRef.current.onThreatCount(...args),
      onGameStateChange: (...args) => callbacksRef.current.onGameStateChange(...args)
    });

    engineRef.current = engine;
    engine.setDifficulty(currentDifficulty);
    engine.setShipColor(currentShipColor);
    engine.setShipModel(currentShipModel);
    engine.setTotalGems(totalGems);
    engine.setHangarMode(isHangarMode);

    return () => {
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (engineRef.current) {
      engineRef.current.setDifficulty(currentDifficulty);
    }
  }, [currentDifficulty]);

  useEffect(() => {
    if (engineRef.current) {
      engineRef.current.setShipColor(currentShipColor);
    }
  }, [currentShipColor]);

  useEffect(() => {
    if (engineRef.current) {
      engineRef.current.setShipModel(currentShipModel);
    }
  }, [currentShipModel]);

  useEffect(() => {
    if (engineRef.current) {
      engineRef.current.setTotalGems(totalGems);
    }
  }, [totalGems]);

  useEffect(() => {
    if (engineRef.current) {
      engineRef.current.setHangarMode(isHangarMode);
    }
  }, [isHangarMode]);

  const clampedTier = Math.max(0, Math.min(MODULE_MAX_TIER, zoomScannerLevel));
  const fogFraction = BASE_FOG_FRACTION * (1 - clampedTier / MODULE_MAX_TIER);

  return (
    <div className="canvas-container" ref={containerRef}>
      {fogFraction > 0.001 && (
        <div
          className={`fog-of-war ${isWarping ? 'is-hidden' : ''}`}
          style={{ width: `${fogFraction * 100}%` }}
          aria-hidden="true"
        />
      )}
      {floatingTexts.map((ft) => (
        <div
          key={ft.id}
          className="floating-text"
          style={{
            left: ft.left,
            top: ft.top,
            color: ft.color
          }}
        >
          {ft.text}
        </div>
      ))}
    </div>
  );
};
