export type GameState = 'START' | 'PLAYING' | 'WARPING' | 'DYING' | 'GAMEOVER';

export type DifficultyKey = 'easy' | 'normal' | 'hard' | 'exhard';

export type ShipColorKey = 'blue' | 'green' | 'red' | 'pink';

export type ShipModelId = 'dart' | 'viper' | 'titan' | 'phantom' | 'valkyrie';

export interface ShipStats {
  id: ShipModelId;
  name: string;
  tagline: string;
  cost: number;
  sizeScale: number;
  speed: number;
  smoothness: number; // Finger/mouse/keyboard reactivity (higher = faster, lower = slight inertia delay)
  sizeLabel: string;
  speedLabel: string;
  reactivityLabel: string;
  sizeStars: number; // 1-5 stars (smaller size = more stars)
  speedStars: number; // 1-5 stars (faster speed = more stars)
  reactivityStars: number; // 1-5 stars (faster reactivity = more stars)
  /**
   * Base hits the reflect shell can absorb before it breaks. Baseline is 1.
   * Kept as a first-class stat so a future module can stack extra charges on
   * top of the hull's rating.
   */
  shieldCharges: number;
  /**
   * Multiplier applied to `shieldCharges + module bonus`, rounded up. 1.0 for
   * every hull except the Titan Dreadnought, whose 1.5 reads as "+50% shields"
   * and keeps scaling as modules add charges (1 -> 2, 2 -> 3, 3 -> 5).
   */
  shieldChargeMultiplier: number;
  /**
   * True Sight: disguised bombs never cycle back into their gem form. Owned by
   * the Pulse Oracle today, and designed to also be grantable by a module.
   */
  trueVision: boolean;
  /** Optional one-line description of the hull's special, shown in the hangar. */
  special?: string;
}

export interface ShipColorConfig {
  label: string;
  color: string;
  colorHex: number;
  glow: string;
}

export interface DifficultyConfig {
  label: string;
  baseSpeed: number;
  speedIncrement: number;
  baseGap: number;
  minGap: number;
  oscillateChance: number;
  spawnInterval: number;
  themeColor: string;
  themeColorHex: number;
  themeGlow: string;
  /**
   * One-line summary of what this difficulty changes, phrased relative to NORMAL
   * (the baseline). Shown under the difficulty picker and in the simulator.
   */
  blurb: string;
  /**
   * Extra reflect-shell charges granted purely for playing on this difficulty.
   * Added to the hull rating alongside any module bonus, before the hull's
   * shieldChargeMultiplier. 0 for every difficulty except EASY.
   */
  shieldChargeBonus: number;
  /**
   * Auto Cannon tier fitted for free at the start of every run on this
   * difficulty. 0 for difficulties that grant no default cannon.
   */
  startAutoCannonLevel: number;
}

export interface LevelSimulation {
  level: number;
  durationSec: number;
  enemyCount: number;
  enemyTimes: number[];
  enemyVariants: { key: string; label: string; icon: string }[]; // variant types active this level
  gameSpeed: number; // scroll speed at level start
  spawnInterval: number; // frames between obstacle spawns at level start (lower = denser)
  obstaclesPerLevel: number; // estimated obstacles across the whole sector
  rockDensityPct: number; // relative rock density 0-100
  bombChancePct: number; // chance a spawned gem is a bomb 0-100
  movingAsteroidsActive: boolean; // whether drifting asteroid formations can appear
  movingAsteroidSpeed: number; // vertical drift speed at this level (0 if not unlocked)
}

export interface Bounds {
  width: number;
  height: number;
  halfWidth: number;
  halfHeight: number;
}

export interface FloatingTextItem {
  id: number;
  text: string;
  left: string;
  top: string;
  color: string;
}

export type ModuleType = 'powerGen' | 'autoCannon' | 'zoomScanner' | 'shieldCell';

/**
 * Modules that bolt visible hardware onto the hull, and so can be shown off in
 * the hangar. The Reflect Capacitor is excluded: it expresses itself through the
 * reflect shell, which the hangar showcase never raises.
 */
export type PreviewModuleType = 'powerGen' | 'autoCannon' | 'zoomScanner';

/**
 * Hangar-only "try before you buy" flags. Each enabled module is shown on the
 * showcase hull at max tier; nothing here affects an actual run.
 */
export type ModulePreview = Record<PreviewModuleType, boolean>;

export interface ModuleStatus {
  powerGenLevel: number; // 0 = not owned, 1-5 tiers
  autoCannonLevel: number; // 0 = not owned, 1-5 tiers
  zoomScannerLevel: number; // 0 = not owned, 1-5 tiers
  shieldCellLevel: number; // 0 = not owned, 1-5 tiers (extra reflect charges)
  shieldActive: boolean;
  shieldRegenProgress: number; // 0-1 toward regenerating the shield
  cannonProgress: number; // 0-1 toward the next auto cannon shot
  shieldCharges: number; // impacts the shell can still absorb (0 = shield down)
  maxShieldCharges: number; // total charges the current hull/loadout grants
  trueVisionActive: boolean; // bombs are locked into their revealed form
}

export interface GameOverSummary {
  score: number;
  gemsCollected: number;
  level: number;
  enemiesSurvived: number;
  runTimeSec: number;
}

export interface GameEngineCallbacks {
  onScoreUpdate?: (score: number) => void;
  onGemsUpdate?: (runGems: number, totalGems: number) => void;
  onGameOver?: (summary: GameOverSummary) => void;
  onLevelUp?: (level: number) => void;
  onLevelProgress?: (levelTimerSec: number, totalDurationSec: number) => void;
  onFloatText?: (text: string, x: number, y: number, color?: string) => void;
  onModuleStatus?: (status: ModuleStatus) => void;
  onThreatCount?: (remaining: number) => void;
  onGameStateChange?: (state: GameState) => void;
}
