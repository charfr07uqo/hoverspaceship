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
   * Hits the reflect shell can absorb before it breaks. Baseline is 1; the
   * Titan Dreadnought ships with 2. Kept as a first-class stat so a future
   * module can stack extra charges on top of the hull's rating.
   */
  shieldCharges: number;
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

export type ModuleType = 'powerGen' | 'autoCannon' | 'zoomScanner';

export interface ModuleStatus {
  powerGenLevel: number; // 0 = not owned, 1-5 tiers
  autoCannonLevel: number; // 0 = not owned, 1-5 tiers
  zoomScannerLevel: number; // 0 = not owned, 1-5 tiers
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
