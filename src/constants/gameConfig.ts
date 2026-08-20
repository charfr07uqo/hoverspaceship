import { load as loadYaml } from 'js-yaml';
import {
  DifficultyConfig,
  DifficultyKey,
  LevelSimulation,
  ModuleType,
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
  // Specials are opt-in per ship; anything omitted falls back to shipDefaults.
  shieldCharges?: number;
  shieldChargeMultiplier?: number;
  trueVision?: boolean;
  special?: string;
}

interface RawShipDefaults {
  shieldCharges: number;
  shieldChargeMultiplier: number;
  trueVision: boolean;
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
  // Opt-in: extra reflect charges handed out by the difficulty (EASY only today).
  shieldChargeBonus?: number;
  // Opt-in: Auto Cannon tier fitted for free at the start of a run (EASY/NORMAL).
  startAutoCannonLevel?: number;
  blurb: string;
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
  bonusLevel: {
    everyNLevels: number;
    gemSpawnMultiplier: number;
    warpDurationSec: number;
    speedRampPerSec: number;
    maxSpeedRamp: number;
    spawnIntervalRampPerSec: number;
    minSpawnInterval: number;
    enemyIntervalStartSec: number;
    enemyIntervalMinSec: number;
    enemyIntervalRampPerSec: number;
    themeColor: string;
    fogColor: string;
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
    shieldChargeBonuses: number[];
    upgradeCosts: number[];
    meta: Record<ModuleType, RawModuleMeta>;
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
  shipDefaults: RawShipDefaults;
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
// Bonus rift sectors
// ---------------------------------------------------------------------------
export const BONUS_LEVEL_CONFIG = {
  everyNLevels: CONFIG.bonusLevel.everyNLevels,
  gemSpawnMultiplier: CONFIG.bonusLevel.gemSpawnMultiplier,
  warpDurationSec: CONFIG.bonusLevel.warpDurationSec,
  speedRampPerSec: CONFIG.bonusLevel.speedRampPerSec,
  maxSpeedRamp: CONFIG.bonusLevel.maxSpeedRamp,
  spawnIntervalRampPerSec: CONFIG.bonusLevel.spawnIntervalRampPerSec,
  minSpawnInterval: CONFIG.bonusLevel.minSpawnInterval,
  enemyIntervalStartSec: CONFIG.bonusLevel.enemyIntervalStartSec,
  enemyIntervalMinSec: CONFIG.bonusLevel.enemyIntervalMinSec,
  enemyIntervalRampPerSec: CONFIG.bonusLevel.enemyIntervalRampPerSec,
  themeColor: CONFIG.bonusLevel.themeColor,
  themeColorHex: hexToNumber(CONFIG.bonusLevel.themeColor),
  fogColor: CONFIG.bonusLevel.fogColor,
  fogColorHex: hexToNumber(CONFIG.bonusLevel.fogColor)
};

/**
 * True when clearing `clearedLevel` should tear open a bonus rift instead of
 * warping straight on to the next normal sector.
 */
export const isRiftDueAfterLevel = (clearedLevel: number): boolean =>
  BONUS_LEVEL_CONFIG.everyNLevels > 0 && clearedLevel % BONUS_LEVEL_CONFIG.everyNLevels === 0;

/** Extra scroll speed the rift has accumulated after `elapsedSec` inside it. */
export const getRiftSpeedRamp = (elapsedSec: number): number =>
  Math.min(BONUS_LEVEL_CONFIG.maxSpeedRamp, elapsedSec * BONUS_LEVEL_CONFIG.speedRampPerSec);

/** Obstacle spawn-interval (frames) the rift has shaved off after `elapsedSec`. */
export const getRiftSpawnIntervalReduction = (elapsedSec: number): number =>
  elapsedSec * BONUS_LEVEL_CONFIG.spawnIntervalRampPerSec;

/** Seconds between rift enemy spawns after `elapsedSec` inside the rift. */
export const getRiftEnemyInterval = (elapsedSec: number): number =>
  Math.max(
    BONUS_LEVEL_CONFIG.enemyIntervalMinSec,
    BONUS_LEVEL_CONFIG.enemyIntervalStartSec - elapsedSec * BONUS_LEVEL_CONFIG.enemyIntervalRampPerSec
  );

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

// Reflect Capacitor: extra reflect-shell charges granted, per tier. Summed with
// the hull rating before the hull's multiplier, so ship specials scale with it.
export const SHIELD_CHARGE_BONUSES = CONFIG.modules.shieldChargeBonuses;

// Gem cost to purchase each successive tier (index 0 = cost to reach tier 1).
export const MODULE_UPGRADE_COSTS = CONFIG.modules.upgradeCosts;

export interface ModuleMeta {
  name: string;
  icon: string;
  blurb: string;
  tierValues: number[]; // human-readable value per tier (seconds)
  unit: string;
}

export const MODULE_META: Record<ModuleType, ModuleMeta> = {
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
  },
  shieldCell: {
    ...CONFIG.modules.meta.shieldCell,
    tierValues: SHIELD_CHARGE_BONUSES
  }
};

/** Extra reflect-shell charges granted by the Reflect Capacitor at `level` (0 = none). */
export const getShieldChargeBonus = (level: number): number =>
  level > 0 ? SHIELD_CHARGE_BONUSES[Math.min(level, MODULE_MAX_TIER) - 1] ?? 0 : 0;

// ---------------------------------------------------------------------------
// Ship models
// ---------------------------------------------------------------------------

/** Baseline special ratings inherited by any ship that does not override them. */
export const SHIP_DEFAULTS = CONFIG.shipDefaults;

/** Shield charges every hull starts from before per-ship or module bonuses. */
export const BASE_SHIELD_CHARGES = SHIP_DEFAULTS.shieldCharges;

export const SHIPS_CONFIG: Record<ShipModelId, ShipStats> = Object.fromEntries(
  (Object.keys(CONFIG.ships) as ShipModelId[]).map((id) => {
    const raw = CONFIG.ships[id];
    return [
      id,
      {
        id,
        ...raw,
        // Normalise the opt-in specials so consumers never deal with undefined.
        shieldCharges: raw.shieldCharges ?? SHIP_DEFAULTS.shieldCharges,
        shieldChargeMultiplier:
          raw.shieldChargeMultiplier ?? SHIP_DEFAULTS.shieldChargeMultiplier,
        trueVision: raw.trueVision ?? SHIP_DEFAULTS.trueVision
      }
    ];
  })
) as Record<ShipModelId, ShipStats>;

/** Canonical hull order, shared by every fleet carousel. Comes from the YAML. */
export const SHIP_IDS = Object.keys(SHIPS_CONFIG) as ShipModelId[];

/** Hull every pilot owns from the start; also the fallback for bad save data. */
export const DEFAULT_SHIP_ID: ShipModelId = 'dart';

/** Guards untrusted values (localStorage, URL params) before they reach state. */
export const isShipModelId = (value: unknown): value is ShipModelId =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(SHIPS_CONFIG, value);

/**
 * Shield charges a hull actually fields.
 *
 * The hull's flat rating and any module bonus are summed first, then the hull's
 * percentage multiplier is applied and rounded up. Ordering matters: the Titan
 * Dreadnought's +50% is meant to scale with upgrades, so a bonus charge takes it
 * from 2 (ceil 1 * 1.5) to 3 (ceil 2 * 1.5) rather than a flat 3.
 */
export function computeShieldCharges(shipId: ShipModelId, bonusCharges = 0): number {
  const config = SHIPS_CONFIG[shipId] || SHIPS_CONFIG.dart;
  const base = config.shieldCharges + Math.max(0, bonusCharges);
  return Math.max(1, Math.ceil(base * config.shieldChargeMultiplier));
}

// ---------------------------------------------------------------------------
// Difficulty settings (themeColorHex derived from themeColor)
// ---------------------------------------------------------------------------
export const DIFFICULTY_SETTINGS: Record<DifficultyKey, DifficultyConfig> = Object.fromEntries(
  (Object.keys(CONFIG.difficulties) as DifficultyKey[]).map((key) => {
    const d = CONFIG.difficulties[key];
    return [
      key,
      {
        ...d,
        themeColorHex: hexToNumber(d.themeColor),
        // Normalised so consumers never have to handle undefined.
        shieldChargeBonus: d.shieldChargeBonus ?? 0,
        startAutoCannonLevel: d.startAutoCannonLevel ?? 0
      }
    ];
  })
) as Record<DifficultyKey, DifficultyConfig>;

/** Extra reflect-shell charges a difficulty grants on top of the hull rating. */
export const getDifficultyShieldChargeBonus = (difficulty: DifficultyKey): number =>
  DIFFICULTY_SETTINGS[difficulty]?.shieldChargeBonus ?? 0;

/** Auto Cannon tier a difficulty fits for free at the start of a run (0 = none). */
export const getDifficultyStartAutoCannonLevel = (difficulty: DifficultyKey): number =>
  DIFFICULTY_SETTINGS[difficulty]?.startAutoCannonLevel ?? 0;

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
