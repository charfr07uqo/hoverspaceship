import React, { useEffect, useRef, useState } from 'react';
import { GameEngine } from '../game/GameEngine';
import { MODULE_MAX_TIER } from '../constants/gameConfig';
import { DifficultyKey, FloatingTextItem, GameOverSummary, GameState, ModulePreview, ModuleStatus, RiftStatus, ShipColorKey, ShipModelId } from '../types/game';

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
  /** Hangar-only module fitting preview; ignored outside hangar mode. */
  modulePreview?: ModulePreview;
  isHangarMode?: boolean;
  /** Hides the fog of war while a spacewarp or reality-breach animation plays. */
  isWarping?: boolean;
  /** Tints the canvas frame while the flight is inside a bonus rift. */
  isRiftSpace?: boolean;
  onScoreUpdate: (score: number) => void;
  onGemsUpdate: (runGems: number, totalGems: number) => void;
  onGameOver: (summary: GameOverSummary) => void;
  onLevelUp: (newLevel: number) => void;
  onLevelProgress: (progressSec: number, totalSec: number) => void;
  onModuleStatus: (status: ModuleStatus) => void;
  onThreatCount: (remaining: number) => void;
  onGameStateChange: (state: GameState) => void;
  onRiftStatus: (status: RiftStatus) => void;
}

export const GameCanvas: React.FC<GameCanvasProps> = ({
  engineRef,
  currentDifficulty,
  currentShipColor,
  currentShipModel,
  totalGems,
  zoomScannerLevel = 0,
  modulePreview,
  isHangarMode = false,
  isWarping = false,
  isRiftSpace = false,
  onScoreUpdate,
  onGemsUpdate,
  onGameOver,
  onLevelUp,
  onLevelProgress,
  onModuleStatus,
  onThreatCount,
  onGameStateChange,
  onRiftStatus
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
    onGameStateChange,
    onRiftStatus
  });
  callbacksRef.current = {
    onScoreUpdate,
    onGemsUpdate,
    onGameOver,
    onLevelUp,
    onLevelProgress,
    onModuleStatus,
    onThreatCount,
    onGameStateChange,
    onRiftStatus
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
      onGameStateChange: (...args) => callbacksRef.current.onGameStateChange(...args),
      onRiftStatus: (...args) => callbacksRef.current.onRiftStatus(...args)
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

  // Module fitting preview. Each enabled module is shown at max tier so the
  // hangar displays the fully built hardware rather than a tier-1 stub.
  const previewPowerGen = modulePreview?.powerGen ? MODULE_MAX_TIER : 0;
  const previewAutoCannon = modulePreview?.autoCannon ? MODULE_MAX_TIER : 0;
  const previewZoomScanner = modulePreview?.zoomScanner ? MODULE_MAX_TIER : 0;
  useEffect(() => {
    if (engineRef.current) {
      engineRef.current.setModulePreview(previewPowerGen, previewAutoCannon, previewZoomScanner);
    }
  }, [previewPowerGen, previewAutoCannon, previewZoomScanner]);

  const clampedTier = Math.max(0, Math.min(MODULE_MAX_TIER, zoomScannerLevel));
  const fogFraction = BASE_FOG_FRACTION * (1 - clampedTier / MODULE_MAX_TIER);

  return (
    <div className={`canvas-container ${isRiftSpace ? 'is-rift-space' : ''}`} ref={containerRef}>
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
