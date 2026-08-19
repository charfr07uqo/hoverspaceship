import { load as loadYaml } from 'js-yaml';
import {
  DifficultyConfig,
  DifficultyKey,
  LevelSimulation,
  ShipColorConfig,
  ShipColorKey,
  ShipModelId,
  ShipStats
} from '../types/game';
// Central, human-editable configuration. All ship/module/level/difficulty
// stats and tuning coefficients live in this YAML file.
import rawConfig from '../config/gameConfig.yaml?raw';

// ---------------------------------------------------------------------------
// Raw YAML shape (as authored in src/config/gameConfig.yaml)
// ---------------------------------------------------------------------------
interface RawModuleMeta {
  name: string;
  icon: string;
  blurb: string;
  unit: string;
}

interface RawShipStats {
  name: string;
  tagline: string;
  cost: number;
  sizeScale: number;
  speed: number;
  smoothness: number;
  sizeLabel: string;
  speedLabel: string;
  reactivityLabel: string;
  sizeStars: number;
  speedStars: number;
  reactivityStars: number;
}

interface RawDifficulty {
  label: string;
  baseSpeed: number;
  speedIncrement: number;
  baseGap: number;
  minGap: number;
  oscillateChance: number;
  spawnInterval: number;
  themeColor: string;
  themeGlow: string;
}

interface RawShipColor {
  label: string;
  color: string;
  glow: string;
}

interface RawEnemyVariant {
  label: string;
  icon: string;
  unlockLevel: number;
  spawnChance: number;
  sizeMultiplier: number;
  speedMultiplier: number;
  accentColor: string;
}

interface GameConfigFile {
  level: {
    baseDurationSec: number;
    maxDurationSec: number;
    durationStages: { upTo: number; step: number }[];
  };
  enemy: {
    startLevel: number;
    startCount: number;
    countCap: number;
    capLevel: number;
    variants: Record<string, RawEnemyVariant>;
  };
  bomb: {
    startLevel: number;
    baseChancePct: number;
    chanceIncrementPct: number;
    maxChancePct: number;
  };
  movingAsteroids: {
    unlockLevel: number;
    spawnChance: number;
    baseSpeed: number;
    startMultiplier: number;
    maxMultiplier: number;
    maxSpeedLevel: number;
    travelRange: number;
    countScale: number;
    difficultyMultipliers: Record<DifficultyKey, number>;
  };
  modules: {
    maxTier: number;
    shieldRegenDelaysSec: number[];
    autoCannonReloadSec: number[];
    scannerExtraDistancePct: number[];
    upgradeCosts: number[];
    meta: Record<'powerGen' | 'autoCannon' | 'zoomScanner', RawModuleMeta>;
  };
  difficultyAlgorithm: {
    scoreStepForSpeed: number;
    scoreSpeedMultiplier: number;
    levelSpeedBonus: number;
    levelGapReduction: number;
    levelSpawnIntervalReduction: number;
    scoreSpawnReductionFactor: number;
  };
  simulation: {
    framesPerSec: number;
    minSpawnInterval: number;
  };
  ships: Record<ShipModelId, RawShipStats>;
  difficulties: Record<DifficultyKey, RawDifficulty>;
  shipColors: Record<ShipColorKey, RawShipColor>;
}

const CONFIG = loadYaml(rawConfig) as GameConfigFile;

/** Convert a CSS hex color string (e.g. "#38bdf8") to its numeric form. */
const hexToNumber = (hex: string): number => parseInt(hex.replace('#', ''), 16);

// ---------------------------------------------------------------------------
// Level durations
// ---------------------------------------------------------------------------
export const LEVEL_BASE_DURATION_SEC = CONFIG.level.baseDurationSec;
export const LEVEL_MAX_DURATION_SEC = CONFIG.level.maxDurationSec;
export const LEVEL_DURATION_STAGES = CONFIG.level.durationStages;

/**
 * Duration in seconds for a given sector level.
 *
 * Starts at baseDurationSec and, for each subsequent level, adds the current
 * stage's `step` (clamped to that stage's `upTo`). Once a stage's ceiling is
 * reached the next stage's step applies, up to the global maxDurationSec.
 * Example: 15 -> +2 up to 25 -> +3 up to 30 -> +5 up to 60.
 */
export const getLevelDuration = (level: number): number => {
  let duration = LEVEL_BASE_DURATION_SEC;
  for (let l = 2; l <= level; l++) {
    const stage = LEVEL_DURATION_STAGES.find((s) => duration < s.upTo);
    if (!stage) break;
    duration = Math.min(stage.upTo, duration + stage.step, LEVEL_MAX_DURATION_SEC);
  }
  return Math.min(duration, LEVEL_MAX_DURATION_SEC);
};

/**
 * Number of enemy interceptors that spawn in a given sector level.
 * Ramps linearly from `startCount` (at `startLevel`) up to `countCap`
 * (reached at `capLevel`), then stays at the cap for all later levels.
 */
export const getEnemyCountForLevel = (level: number): number => {
  const { startLevel, startCount, countCap, capLevel } = CONFIG.enemy;
  if (level < startLevel) return 0;
  if (level >= capLevel) return countCap;
  const t = (level - startLevel) / (capLevel - startLevel);
  return Math.min(countCap, Math.round(startCount + t * (countCap - startCount)));
};

// ---------------------------------------------------------------------------
// Enemy variants (heavy / scout unlockables)
// ---------------------------------------------------------------------------
export interface EnemyVariant {
  key: string; // 'standard' | 'heavy' | 'scout'
  label: string;
  icon: string;
  unlockLevel: number;
  spawnChance: number;
  sizeMultiplier: number;
  speedMultiplier: number;
  accentColor: string;
  accentColorHex: number;
}

/** The always-present baseline drone (no size/speed modifiers). */
export const STANDARD_ENEMY_VARIANT: EnemyVariant = {
  key: 'standard',
  label: 'Drone',
  icon: '👾',
  unlockLevel: 2,
  spawnChance: 1,
  sizeMultiplier: 1,
  speedMultiplier: 1,
  accentColor: '#ff3b30',
  accentColorHex: hexToNumber('#ff3b30')
};

/** Unlockable variants (heavy, scout, ...) derived from the YAML config. */
export const ENEMY_VARIANTS: EnemyVariant[] = Object.entries(CONFIG.enemy.variants).map(
  ([key, v]) => ({
    key,
    label: v.label,
    icon: v.icon,
    unlockLevel: v.unlockLevel,
    spawnChance: v.spawnChance,
    sizeMultiplier: v.sizeMultiplier,
    speedMultiplier: v.speedMultiplier,
    accentColor: v.accentColor,
    accentColorHex: hexToNumber(v.accentColor)
  })
);

/** Variants unlocked at (or before) a given level, including the standard drone. */
export const getUnlockedEnemyVariants = (level: number): EnemyVariant[] => [
  STANDARD_ENEMY_VARIANT,
  ...ENEMY_VARIANTS.filter((v) => level >= v.unlockLevel)
];

/**
 * Picks a variant for a spawning enemy at the given level. Each unlocked
 * special variant claims its spawnChance slice of the probability space;
 * whatever remains falls back to the standard drone.
 */
export const pickEnemyVariant = (level: number, rand: number = Math.random()): EnemyVariant => {
  let cumulative = 0;
  for (const v of ENEMY_VARIANTS) {
    if (level < v.unlockLevel) continue;
    cumulative += v.spawnChance;
    if (rand < cumulative) return v;
  }
  return STANDARD_ENEMY_VARIANT;
};

/**
 * Percent chance (0-100) that a spawned gem is actually a disguised bomb.
 * Zero before the bomb start level; ramps up per level to a hard cap.
 */
export const getBombChancePct = (level: number): number => {
  if (level < CONFIG.bomb.startLevel) return 0;
  const raw = CONFIG.bomb.baseChancePct + (level - CONFIG.bomb.startLevel) * CONFIG.bomb.chanceIncrementPct;
  return Math.min(CONFIG.bomb.maxChancePct, raw);
};

// ---------------------------------------------------------------------------
// Moving asteroids
// ---------------------------------------------------------------------------
export const MOVING_ASTEROID_CONFIG = {
  unlockLevel: CONFIG.movingAsteroids.unlockLevel,
  spawnChance: CONFIG.movingAsteroids.spawnChance,
  baseSpeed: CONFIG.movingAsteroids.baseSpeed,
  startMultiplier: CONFIG.movingAsteroids.startMultiplier,
  maxMultiplier: CONFIG.movingAsteroids.maxMultiplier,
  maxSpeedLevel: CONFIG.movingAsteroids.maxSpeedLevel,
  travelRange: CONFIG.movingAsteroids.travelRange,
  countScale: CONFIG.movingAsteroids.countScale,
  difficultyMultipliers: CONFIG.movingAsteroids.difficultyMultipliers
};

/** True once moving asteroids are unlocked for the given level (after unlockLevel). */
export const areMovingAsteroidsUnlocked = (level: number): boolean =>
  level > MOVING_ASTEROID_CONFIG.unlockLevel;

/**
 * Vertical drift speed (world units / frame) for movers at a given level and
 * difficulty. Zero until unlocked; then the level ramp climbs linearly from
 * startMultiplier (the level after unlock) to maxMultiplier (at maxSpeedLevel),
 * and the difficulty multiplier is layered on top. Speed = baseSpeed * ramp * diff.
 */
export const getMovingAsteroidSpeed = (level: number, difficulty: DifficultyKey = 'easy'): number => {
  const { unlockLevel, baseSpeed, startMultiplier, maxMultiplier, maxSpeedLevel, difficultyMultipliers } =
    MOVING_ASTEROID_CONFIG;
  if (level <= unlockLevel) return 0;
  const span = Math.max(1, maxSpeedLevel - unlockLevel);
  const t = Math.min(1, (level - unlockLevel) / span);
  const rampMultiplier = startMultiplier + t * (maxMultiplier - startMultiplier);
  const diffMultiplier = difficultyMultipliers[difficulty] ?? 1;
  return baseSpeed * rampMultiplier * diffMultiplier;
};

/** Enemy spawn times (seconds) evenly distributed across the level's duration. */
export const getEnemySpawnSchedule = (level: number): number[] => {
  const count = getEnemyCountForLevel(level);
  if (count === 0) return [];
  const duration = getLevelDuration(level);
  const step = duration / (count + 1);
  return Array.from({ length: count }, (_, idx) => Math.round(step * (idx + 1)));
};

// ---------------------------------------------------------------------------
// Algorithm Constants for Difficulty & Progression Scaling
// ---------------------------------------------------------------------------
export const DIFFICULTY_ALGORITHM = {
  // Score interval required for speed increase
  SCORE_STEP_FOR_SPEED: CONFIG.difficultyAlgorithm.scoreStepForSpeed,
  // Speed bonus multiplier per score step
  SCORE_SPEED_MULTIPLIER: CONFIG.difficultyAlgorithm.scoreSpeedMultiplier,
  // Speed bonus per sector level
  LEVEL_SPEED_BONUS: CONFIG.difficultyAlgorithm.levelSpeedBonus,
  // Gap reduction per sector level
  LEVEL_GAP_REDUCTION: CONFIG.difficultyAlgorithm.levelGapReduction,
  // Spawn interval tightening per sector level
  LEVEL_SPAWN_INTERVAL_REDUCTION: CONFIG.difficultyAlgorithm.levelSpawnIntervalReduction,
  // Score spawn interval tightening factor
  SCORE_SPAWN_REDUCTION_FACTOR: CONFIG.difficultyAlgorithm.scoreSpawnReductionFactor
};

// ---------------------------------------------------------------------------
// Ship Module Addons (in-run only, NOT persisted between games)
// Purchased from the Shop during the spacewarp transition using gems.
// ---------------------------------------------------------------------------
export const MODULE_MAX_TIER = CONFIG.modules.maxTier;

// Power Generator: delay (seconds) before a broken shield regenerates, per tier.
export const SHIELD_REGEN_DELAYS_SEC = CONFIG.modules.shieldRegenDelaysSec;

// Auto Cannon: reload time (seconds) between shots, per tier.
export const AUTO_CANNON_RELOAD_SEC = CONFIG.modules.autoCannonReloadSec;

// Scanner Array: extra viewing distance (percent of base width) per tier.
export const SCANNER_EXTRA_DISTANCE_PCT = CONFIG.modules.scannerExtraDistancePct;

// Gem cost to purchase each successive tier (index 0 = cost to reach tier 1).
export const MODULE_UPGRADE_COSTS = CONFIG.modules.upgradeCosts;

export interface ModuleMeta {
  name: string;
  icon: string;
  blurb: string;
  tierValues: number[]; // human-readable value per tier (seconds)
  unit: string;
}

export const MODULE_META: Record<'powerGen' | 'autoCannon' | 'zoomScanner', ModuleMeta> = {
  powerGen: {
    ...CONFIG.modules.meta.powerGen,
    tierValues: SHIELD_REGEN_DELAYS_SEC
  },
  autoCannon: {
    ...CONFIG.modules.meta.autoCannon,
    tierValues: AUTO_CANNON_RELOAD_SEC
  },
  zoomScanner: {
    ...CONFIG.modules.meta.zoomScanner,
    tierValues: SCANNER_EXTRA_DISTANCE_PCT
  }
};

// ---------------------------------------------------------------------------
// Ship models
// ---------------------------------------------------------------------------
export const SHIPS_CONFIG: Record<ShipModelId, ShipStats> = Object.fromEntries(
  (Object.keys(CONFIG.ships) as ShipModelId[]).map((id) => [
    id,
    { id, ...CONFIG.ships[id] }
  ])
) as Record<ShipModelId, ShipStats>;

// ---------------------------------------------------------------------------
// Difficulty settings (themeColorHex derived from themeColor)
// ---------------------------------------------------------------------------
export const DIFFICULTY_SETTINGS: Record<DifficultyKey, DifficultyConfig> = Object.fromEntries(
  (Object.keys(CONFIG.difficulties) as DifficultyKey[]).map((key) => {
    const d = CONFIG.difficulties[key];
    return [key, { ...d, themeColorHex: hexToNumber(d.themeColor) }];
  })
) as Record<DifficultyKey, DifficultyConfig>;

// ---------------------------------------------------------------------------
// Ship color options (colorHex derived from color)
// ---------------------------------------------------------------------------
export const SHIP_COLORS: Record<ShipColorKey, ShipColorConfig> = Object.fromEntries(
  (Object.keys(CONFIG.shipColors) as ShipColorKey[]).map((key) => {
    const c = CONFIG.shipColors[key];
    return [key, { ...c, colorHex: hexToNumber(c.color) }];
  })
) as Record<ShipColorKey, ShipColorConfig>;

// ---------------------------------------------------------------------------
// Level preview simulation
// ---------------------------------------------------------------------------
// Approximate simulation frame rate used to estimate obstacle counts.
const SIM_FRAMES_PER_SEC = CONFIG.simulation.framesPerSec;
// Tightest possible obstacle spawn interval (matches the clamp in GameEngine).
const MIN_SPAWN_INTERVAL = CONFIG.simulation.minSpawnInterval;

/**
 * Predicts how a sector level will play out for a given difficulty.
 * Mirrors the level-start scaling used by GameEngine (score assumed 0 at entry).
 */
export const simulateLevel = (level: number, difficulty: DifficultyKey): LevelSimulation => {
  const config = DIFFICULTY_SETTINGS[difficulty] || DIFFICULTY_SETTINGS.normal;
  const durationSec = getLevelDuration(level);
  const enemyTimes = getEnemySpawnSchedule(level);
  const enemyVariants = getUnlockedEnemyVariants(level).map((v) => ({
    key: v.key,
    label: v.label,
    icon: v.icon
  }));

  const levelSpeedBonus = (level - 1) * DIFFICULTY_ALGORITHM.LEVEL_SPEED_BONUS;
  const gameSpeed = config.baseSpeed + levelSpeedBonus;

  const levelIntervalReduction = (level - 1) * DIFFICULTY_ALGORITHM.LEVEL_SPAWN_INTERVAL_REDUCTION;
  const spawnInterval = Math.max(MIN_SPAWN_INTERVAL, config.spawnInterval - levelIntervalReduction);

  const obstaclesPerLevel = Math.round((durationSec * SIM_FRAMES_PER_SEC) / spawnInterval);
  const rockDensityPct = Math.round(Math.min(100, (MIN_SPAWN_INTERVAL / spawnInterval) * 100));

  return {
    level,
    durationSec,
    enemyCount: enemyTimes.length,
    enemyTimes,
    enemyVariants,
    gameSpeed,
    spawnInterval,
    obstaclesPerLevel,
    rockDensityPct,
    bombChancePct: getBombChancePct(level),
    movingAsteroidsActive: areMovingAsteroidsUnlocked(level),
    movingAsteroidSpeed: getMovingAsteroidSpeed(level, difficulty)
  };
};
