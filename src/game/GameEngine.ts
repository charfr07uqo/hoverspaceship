import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import {
  AUTO_CANNON_RELOAD_SEC,
  DIFFICULTY_ALGORITHM,
  DIFFICULTY_SETTINGS,
  getBombChancePct,
  getEnemySpawnSchedule,
  getLevelDuration,
  getMovingAsteroidSpeed,
  MOVING_ASTEROID_CONFIG,
  pickEnemyVariant,
  MODULE_MAX_TIER,
  MODULE_UPGRADE_COSTS,
  SCANNER_EXTRA_DISTANCE_PCT,
  SHIELD_REGEN_DELAYS_SEC,
  getShieldChargeBonus,
  getDifficultyShieldChargeBonus,
  getDifficultyStartAutoCannonLevel,
  SHIP_COLORS,
  SHIPS_CONFIG
} from '../constants/gameConfig';
import { soundManager } from '../audio/soundManager';
import { Bounds, DifficultyKey, GameEngineCallbacks, GameState, ModuleType, ShipColorKey, ShipModelId } from '../types/game';
import { Starfield } from './Starfield';
import { PlayerShip } from './PlayerShip';
import { ObstaclePair3D } from './AsteroidField';
import { detectGLPrecision } from './glCapabilities';
import { Gem3D } from './GemManager';
import { ParticleSystem } from './ParticleSystem';
import { EnemyDrone3D } from './EnemyDrone';
import { Projectile3D } from './Projectile';

/**
 * Stage height (world units) the showcase framing is tuned against. A measured
 * stage taller than this scales the hull up, shorter scales it down (clamped).
 *
 * This tracks the `.ship-showcase-viewport` heights in ui.css: both were grown
 * by PlayerShip's SHOWCASE_ZOOM factor (1.5x, from the original 95 / 220px), so
 * the fit factor a given screen produces is unchanged and the 50% size increase
 * comes purely from the zoom.
 */
const SHOWCASE_STAGE_REFERENCE = 142.5;

export class GameEngine {
  private container: HTMLElement;
  private callbacks: GameEngineCallbacks;

  public gameState: GameState = 'START';
  public currentDifficulty: DifficultyKey = 'normal';
  public currentShipColor: ShipColorKey = 'blue';
  public currentShipModel: ShipModelId = 'dart';

  public score = 0;
  public gemsCollected = 0;
  public totalGems = 0;
  public level = 1;
  public levelTimer = 0; // seconds into current level
  public runTime = 0; // total seconds survived this run (across all sectors)
  public enemiesSurvived = 0; // enemy interceptors the player outlasted (destroyed or evaded)

  public gameSpeed = 2.1;
  private spawnTimer = 0;
  private menuBgSpawnTimer = 0;
  private showcaseAnchorTimer = 999;

  // Hyperspace warp level transition. 5 seconds, which is also the window the
  // shop is available in, and the span the ship's lunge is fitted to.
  private static readonly WARP_DURATION = 5.0;
  private warpTimer = 0;

  // 3-Second Death explosion sequence
  private deathTimer = 0;
  private deathSecondaryTimer = 0;

  private obstacles: ObstaclePair3D[] = [];
  private gems: Gem3D[] = [];
  private enemies: EnemyDrone3D[] = [];
  private enemySpawnSchedule: number[] = [];
  private screenShake = 0;

  // In-run ship module addons (NOT persisted between games)
  public powerGenLevel = 0; // 0 = not owned, 1-5 tiers
  public autoCannonLevel = 0; // 0 = not owned, 1-5 tiers
  public zoomScannerLevel = 0; // 0 = not owned, 1-5 tiers (widens horizontal view)
  public shieldCellLevel = 0; // 0 = not owned, 1-5 tiers (extra reflect charges)
  private shieldRegenTimer = 0; // seconds elapsed since the shield broke
  private autoCannonTimer = 0; // seconds elapsed since last shot
  private projectiles: Projectile3D[] = [];

  /**
   * Module-granted True Sight tier. 0 = the ability comes from the hull only.
   * Wired up so a future shop module just has to call setTrueVisionModuleLevel()
   * and every live/spawning bomb picks the change up immediately.
   */
  private trueVisionModuleLevel = 0;

  private keys: Record<string, boolean> = {};
  private pointerY: number | null = null;
  private isPointerActive = false;

  public bounds: Bounds = { width: 480, height: 720, halfWidth: 240, halfHeight: 360 };

  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private composer!: EffectComposer;
  private bloomPass!: UnrealBloomPass;
  private gradePass!: ShaderPass;
  /** Only created on a WebGL1 fallback context, where render-target MSAA is unavailable. */
  private smaaPass: SMAAPass | null = null;
  private ambientLight!: THREE.AmbientLight;
  private dirLight!: THREE.DirectionalLight;
  private themeLight!: THREE.PointLight;

  private starfield!: Starfield;
  public player!: PlayerShip;
  private particleSystem!: ParticleSystem;

  private isDestroyed = false;
  private isPaused = false;
  private animationFrameId = 0;
  private lastTime = performance.now();

  // Fixed-timestep simulation constants. The simulation always advances in
  // 1/60s steps so gameplay speed is independent of the display refresh rate.
  private accumulator = 0;
  private static readonly FIXED_DT = 1 / 60;
  private static readonly MAX_STEPS_PER_FRAME = 5;

  private handleKeyDown!: (e: KeyboardEvent) => void;
  private handleKeyUp!: (e: KeyboardEvent) => void;
  private handlePointerDown!: (e: MouseEvent | TouchEvent) => void;
  private handlePointerMove!: (e: MouseEvent | TouchEvent) => void;
  private handlePointerUp!: () => void;
  private onResizeBound!: () => void;

  constructor(container: HTMLElement, callbacks: GameEngineCallbacks = {}) {
    this.container = container;
    this.callbacks = callbacks;

    this.initThree();
    this.initInputs();
    this.setDifficulty('normal');
    this.setShipColor('blue');
    this.setShipModel('dart');

    this.animate = this.animate.bind(this);
    this.animationFrameId = requestAnimationFrame(this.animate);
  }

  private initThree(): void {
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x010208, 0.0018);

    const width = this.container.clientWidth || 480;
    const height = this.container.clientHeight || 720;

    // Base camera distance. Pulled back ~15% from the original 480 so the
    // default view shows more of the map (greater view distance) in every
    // direction. The Scanner Array module widens the horizontal view further
    // on top of this baseline.
    this.camera = new THREE.PerspectiveCamera(50, width / height, 1, 2000);
    this.camera.position.set(0, 0, 552);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // Filmic tone mapping keeps hot emissive/additive surfaces from clipping to
    // flat white once bloom is stacked on top of them.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Must happen before any subsystem builds a material: contexts without
    // fragment `highp` need lighting-free shading at this world scale.
    detectGLPrecision(this.renderer);
    this.container.appendChild(this.renderer.domElement);

    this.initPostProcessing(width, height);

    this.calculateBounds();

    // Lighting
    this.ambientLight = new THREE.AmbientLight(0x334155, 1.2);
    this.scene.add(this.ambientLight);

    this.dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
    this.dirLight.position.set(100, 200, 300);
    this.scene.add(this.dirLight);

    this.themeLight = new THREE.PointLight(0x38bdf8, 2.0, 600);
    this.themeLight.position.set(0, 50, 150);
    this.scene.add(this.themeLight);

    // Subsystems
    this.starfield = new Starfield(this.scene);
    this.player = new PlayerShip(this.scene);
    // The shield's leading-face band is sized in CSS pixels, so it needs the
    // canvas dimensions up front and again on every resize.
    this.player.setViewportResolution(width, height);
    this.player.reset(this.bounds);
    this.particleSystem = new ParticleSystem(this.scene);

    this.onResizeBound = this.onResize.bind(this);
    window.addEventListener('resize', this.onResizeBound);
  }

  /**
   * Builds the post-processing chain: scene render -> selective bloom on the
   * bright emissive/additive parts -> a cheap "space grade" pass (chromatic
   * fringe, vignette, animated grain) -> tone map + sRGB output.
   */
  private initPostProcessing(width: number, height: number): void {
    // The renderer's own `antialias: true` does nothing here: every pass draws
    // into an offscreen render target, not the antialiased default framebuffer.
    // So the composer gets an explicitly multisampled target, which is what
    // actually smooths the hull silhouettes and the neon edge lines.
    //
    // HalfFloat also keeps the additive flames and bloom from banding before the
    // grade/tone-map pass reads them back.
    const drawing = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const renderTarget = new THREE.WebGLRenderTarget(drawing.x, drawing.y, {
      type: THREE.HalfFloatType,
      samples: 4
    });

    this.composer = new EffectComposer(this.renderer, renderTarget);
    this.composer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.composer.setSize(width, height);

    this.composer.addPass(new RenderPass(this.scene, this.camera));

    // Threshold is high enough that only neon edges, flames, cockpits, gems and
    // particles bloom - hull and rock surfaces stay crisp.
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(width, height), 0.62, 0.62, 0.72);
    this.composer.addPass(this.bloomPass);

    this.gradePass = new ShaderPass({
      uniforms: {
        tDiffuse: { value: null },
        uTime: { value: 0 },
        uAberration: { value: 0.0016 },
        uVignette: { value: 0.9 },
        uGrain: { value: 0.035 }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform float uTime;
        uniform float uAberration;
        uniform float uVignette;
        uniform float uGrain;
        varying vec2 vUv;

        void main() {
          vec2 centered = vUv - 0.5;
          float r2 = dot(centered, centered);

          // Lens chromatic fringe: channels sampled at slightly different radii,
          // scaled by distance from centre so the middle of the screen stays sharp.
          vec2 offset = centered * uAberration * (0.35 + r2 * 4.0);
          float cr = texture2D(tDiffuse, vUv + offset).r;
          vec4  cg = texture2D(tDiffuse, vUv);
          float cb = texture2D(tDiffuse, vUv - offset).b;
          vec3 color = vec3(cr, cg.g, cb);

          // Soft cockpit-glass vignette
          float vig = smoothstep(0.95, 0.15, r2 * uVignette * 2.0);
          color *= mix(1.0, vig, 0.75);

          // Animated film grain keeps the dark voids from banding
          float grain = fract(sin(dot(vUv * vec2(1024.0, 768.0) + uTime, vec2(12.9898, 78.233))) * 43758.5453);
          color += (grain - 0.5) * uGrain;

          gl_FragColor = vec4(max(color, 0.0), cg.a);
        }
      `
    });
    this.composer.addPass(this.gradePass);

    // MSAA on the render target needs WebGL2. On a WebGL1 fallback context the
    // `samples` option is ignored, so post-process SMAA stands in for it.
    if (!this.renderer.capabilities.isWebGL2) {
      const pr = this.renderer.getPixelRatio();
      this.smaaPass = new SMAAPass(width * pr, height * pr);
      this.composer.addPass(this.smaaPass);
    }

    this.composer.addPass(new OutputPass());
  }

  /**
   * Extra horizontal view fraction granted by the Scanner Array module.
   * 0 when not owned, up to 0.25 (25%) at max tier. This widens the horizontal
   * field of view only — vertical framing is deliberately left unchanged.
   */
  private getZoomExtraFraction(): number {
    if (this.zoomScannerLevel <= 0) return 0;
    const pct = SCANNER_EXTRA_DISTANCE_PCT[this.zoomScannerLevel - 1] ?? 0;
    return pct / 100;
  }

  private calculateBounds(): void {
    const width = this.container.clientWidth || 480;
    const height = this.container.clientHeight || 720;
    const trueAspect = width / height;

    // Widen the horizontal field of view by the scanner's extra-distance
    // fraction. Because we only inflate the aspect ratio (not the camera
    // distance or vertical FOV), the visible HEIGHT stays constant while the
    // visible WIDTH grows — revealing more of the map ahead without changing
    // the vertical framing.
    const extra = this.getZoomExtraFraction();
    const effectiveAspect = trueAspect * (1 + extra);

    this.camera.aspect = effectiveAspect;
    this.camera.updateProjectionMatrix();

    const vFOV = THREE.MathUtils.degToRad(this.camera.fov);
    const visibleHeight = 2 * Math.tan(vFOV / 2) * this.camera.position.z;
    const visibleWidth = visibleHeight * effectiveAspect;

    this.bounds = {
      width: visibleWidth,
      height: visibleHeight,
      halfWidth: visibleWidth / 2,
      halfHeight: visibleHeight / 2
    };
  }

  /**
   * Measures the visible `.ship-showcase-viewport` stage element and converts its
   * centre into world space on the showcase Z plane, so the menu/hangar ship is
   * framed by the actual rectangle the user sees. Both the start screen and the
   * hangar render a stage div at different heights; previously the ship sat at a
   * fixed world Y that only matched the start screen.
   */
  private updateShowcaseAnchor(): void {
    if (typeof document === 'undefined') return;

    const canvasRect = this.renderer.domElement.getBoundingClientRect();
    if (canvasRect.width === 0 || canvasRect.height === 0) return;

    // Every overlay stays mounted and `.overlay.hidden` only fades to opacity 0,
    // so hidden screens still report a full-size rect. Skip any stage that lives
    // inside a hidden overlay, otherwise the title stage wins over the hangar's.
    let rect: DOMRect | null = null;
    const stages = Array.from(document.querySelectorAll('.ship-showcase-viewport'));
    for (const el of stages) {
      const overlay = el.closest('.overlay');
      if (overlay && overlay.classList.contains('hidden')) continue;
      // Belt-and-braces: also reject anything faded out or detached
      if (el instanceof HTMLElement) {
        if (el.offsetParent === null) continue;
        if (parseFloat(getComputedStyle(el).opacity || '1') < 0.05) continue;
      }
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        rect = r;
        break;
      }
    }

    if (!rect) {
      this.player.showcaseAnchor = null;
      return;
    }

    // Normalized centre of the stage inside the canvas
    const cx = (rect.left + rect.width / 2 - canvasRect.left) / canvasRect.width;
    const cy = (rect.top + rect.height / 2 - canvasRect.top) / canvasRect.height;

    // Visible extents on the showcase plane (the ship sits at z = 120)
    const showcaseZ = 120;
    const dist = this.camera.position.z - showcaseZ;
    const vFOV = THREE.MathUtils.degToRad(this.camera.fov);
    const visibleHeight = 2 * Math.tan(vFOV / 2) * dist;
    const visibleWidth = visibleHeight * this.camera.aspect;

    const stageWorldHeight = (rect.height / canvasRect.height) * visibleHeight;

    this.player.showcaseAnchor = {
      x: (cx - 0.5) * visibleWidth,
      y: (0.5 - cy) * visibleHeight,
      scale: THREE.MathUtils.clamp(stageWorldHeight / SHOWCASE_STAGE_REFERENCE, 0.7, 1.15)
    };
  }

  public onResize(): void {
    if (this.isDestroyed) return;
    const width = this.container.clientWidth || 480;
    const height = this.container.clientHeight || 720;

    this.renderer.setSize(width, height);
    if (this.smaaPass) {
      const pr = this.renderer.getPixelRatio();
      this.smaaPass.setSize(width * pr, height * pr);
    }
    if (this.composer) {
      this.composer.setSize(width, height);
      this.bloomPass.setSize(width, height);
    }
    this.player.setViewportResolution(width, height);
    this.calculateBounds();
    this.updateShowcaseAnchor();
    if (this.gameState === 'START') {
      this.player.reset(this.bounds);
    }
  }

  private initInputs(): void {
    this.handleKeyDown = (e: KeyboardEvent) => {
      soundManager.init();
      this.keys[e.code] = true;
    };

    this.handleKeyUp = (e: KeyboardEvent) => {
      this.keys[e.code] = false;
    };

    this.handlePointerDown = (e: MouseEvent | TouchEvent) => {
      soundManager.init();
      this.updatePointerPos(e);
      this.isPointerActive = true;
    };

    this.handlePointerMove = (e: MouseEvent | TouchEvent) => {
      if (this.isPointerActive) {
        this.updatePointerPos(e);
      }
    };

    this.handlePointerUp = () => {
      this.isPointerActive = false;
    };

    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    this.container.addEventListener('mousedown', this.handlePointerDown as EventListener);
    this.container.addEventListener('mousemove', this.handlePointerMove as EventListener);
    this.container.addEventListener('touchstart', this.handlePointerDown as EventListener, { passive: true });
    this.container.addEventListener('touchmove', this.handlePointerMove as EventListener, { passive: true });
    window.addEventListener('mouseup', this.handlePointerUp);
    window.addEventListener('touchend', this.handlePointerUp);
  }

  private updatePointerPos(e: MouseEvent | TouchEvent): void {
    const rect = this.container.getBoundingClientRect();
    const clientY = 'touches' in e && e.touches.length > 0 ? e.touches[0].clientY : (e as MouseEvent).clientY;
    const relativeY = clientY - rect.top;
    const normY = relativeY / rect.height;
    this.pointerY = this.bounds.halfHeight - normY * this.bounds.height;
  }

  public setDifficulty(diffKey: DifficultyKey): void {
    this.currentDifficulty = diffKey;
    const config = DIFFICULTY_SETTINGS[diffKey] || DIFFICULTY_SETTINGS.normal;
    this.themeLight.color.setHex(config.themeColorHex);
    this.starfield.setThemeColor(config.themeColorHex);
    this.obstacles.forEach((o) => o.setThemeColor(config.themeColorHex));
    // EASY hands out a free reflect charge, so the shell has to be re-rated
    // whenever the difficulty changes (including on the title screen).
    this.applyShieldChargeBonuses();
  }

  /**
   * Re-rates the reflect shell from every source of bonus charges: the current
   * difficulty's handout plus any Reflect Capacitor tier. They are summed and
   * handed over as one number so the hull's shieldChargeMultiplier (the Titan's
   * +50%) still applies on top of the total.
   */
  private applyShieldChargeBonuses(): void {
    if (!this.player) return;
    this.player.setBonusShieldCharges(
      getDifficultyShieldChargeBonus(this.currentDifficulty) +
        getShieldChargeBonus(this.shieldCellLevel)
    );
  }

  public setShipColor(colorKey: ShipColorKey): void {
    this.currentShipColor = colorKey;
    const shipConfig = SHIP_COLORS[colorKey] || SHIP_COLORS.blue;
    if (this.player) {
      this.player.setShipColor(shipConfig.colorHex);
    }
  }

  public setShipModel(modelId: ShipModelId): void {
    this.currentShipModel = modelId;
    if (this.player) {
      this.player.setShipModel(modelId);
      // Module mount points are per-hull, so the attachments have to be rebuilt
      // against the new airframe rather than left on the old hull's anchors.
      this.applyModuleVisuals();
    }
    // Hull specials changed: re-evaluate True Sight on anything already in flight.
    this.syncTrueVision();
    this.emitModuleStatus();
  }

  /**
   * True Sight is on when either the equipped hull grants it or a module tier is
   * installed. Single source of truth for the ability, so adding the module later
   * is just a matter of raising trueVisionModuleLevel.
   */
  public get trueVisionActive(): boolean {
    const ship = SHIPS_CONFIG[this.currentShipModel] || SHIPS_CONFIG.dart;
    return ship.trueVision || this.trueVisionModuleLevel > 0;
  }

  /** Installs/removes a module-granted True Sight tier (reserved for the shop). */
  public setTrueVisionModuleLevel(level: number): void {
    this.trueVisionModuleLevel = Math.max(0, level);
    this.syncTrueVision();
    this.emitModuleStatus();
  }

  /** Pushes the resolved True Sight state onto every bomb currently on screen. */
  private syncTrueVision(): void {
    const active = this.trueVisionActive;
    this.gems.forEach((gem) => gem.setTrueVision(active));
  }

  /**
   * Float-text label for a shield impact: the caller's "break" copy when the
   * shell was destroyed, or a "held" message naming the charges still left.
   */
  private shieldImpactLabel(breakLabel: string, shieldDown: boolean): string {
    if (shieldDown) return breakLabel;
    const left = this.player.shieldCharges;
    return `🛡️ SHIELD HELD! ${left} CHARGE${left === 1 ? '' : 'S'} LEFT`;
  }

  /** @internal Tracks hangar mode so module visuals know which tiers to show. */
  private isHangarMode = false;
  private previewPowerGen = 0;
  private previewAutoCannon = 0;
  private previewZoomScanner = 0;

  public setHangarMode(isHangar: boolean): void {
    this.isHangarMode = isHangar;
    if (this.player) {
      this.player.setHangarMode(isHangar);
      // Swap between the preview kit and what the player actually owns.
      this.applyModuleVisuals();
      // The hangar stage sits at a different height than the title stage, so
      // re-measure on the next frame (after React has committed the layout).
      this.showcaseAnchorTimer = 999;
    }
  }

  public setTotalGems(total: number): void {
    this.totalGems = total;
  }

  /** Update the game state and notify listeners (drives React screen/shop visibility). */
  private setGameState(next: GameState): void {
    if (this.gameState === next) return;
    const wasMenu = this.gameState === 'START';
    this.gameState = next;
    // Entering or leaving the menu flips which module tiers the hull displays
    // (hangar preview vs. what the player owns), so re-apply on that edge only.
    if (wasMenu !== (next === 'START')) this.applyModuleVisuals();
    if (this.callbacks.onGameStateChange) this.callbacks.onGameStateChange(next);
  }

  /** Gem cost to purchase the next tier of a module, or null if already maxed. */
  public getModuleUpgradeCost(type: ModuleType): number | null {
    const level = this.getModuleLevel(type);
    if (level >= MODULE_MAX_TIER) return null;
    return MODULE_UPGRADE_COSTS[level];
  }

  /** Current installed tier (0-5) for a given module type. */
  private getModuleLevel(type: ModuleType): number {
    switch (type) {
      case 'powerGen':
        return this.powerGenLevel;
      case 'autoCannon':
        return this.autoCannonLevel;
      case 'zoomScanner':
        return this.zoomScannerLevel;
      case 'shieldCell':
        return this.shieldCellLevel;
    }
  }

  /**
   * Attempt to buy the next tier of a module using banked gems.
   * Returns true on success. Modules are not persisted between games.
   */
  public purchaseModule(type: ModuleType): boolean {
    const cost = this.getModuleUpgradeCost(type);
    if (cost === null || this.totalGems < cost) return false;

    this.totalGems -= cost;
    if (type === 'powerGen') {
      this.powerGenLevel++;
    } else if (type === 'autoCannon') {
      this.autoCannonLevel++;
      // Ready to fire immediately after purchasing/upgrading the cannon.
      this.autoCannonTimer = AUTO_CANNON_RELOAD_SEC[this.autoCannonLevel - 1];
    } else if (type === 'zoomScanner') {
      this.zoomScannerLevel++;
      // Recompute the viewport so the wider field of view takes effect and the
      // spawn/cull edges follow the newly revealed distance.
      this.calculateBounds();
    } else if (type === 'shieldCell') {
      this.shieldCellLevel++;
      // The hull's own multiplier is applied on top of this bonus, so the Titan
      // Dreadnought's Reinforced Reflect scales with every tier bought here.
      this.applyShieldChargeBonuses();
    }

    // Reflect the new module tiers on the ship's visuals
    this.applyModuleVisuals();
    this.emitModuleStatus();

    soundManager.playGemSound();
    if (this.callbacks.onGemsUpdate) this.callbacks.onGemsUpdate(this.gemsCollected, this.totalGems);
    return true;
  }

  /**
   * Hangar-only module preview tiers. Lets the player see the hardware bolted
   * onto the hull without owning it; purely cosmetic and never used in flight.
   */
  public setModulePreview(powerGen: number, autoCannon: number, zoomScanner: number): void {
    this.previewPowerGen = Math.max(0, powerGen);
    this.previewAutoCannon = Math.max(0, autoCannon);
    this.previewZoomScanner = Math.max(0, zoomScanner);
    this.applyModuleVisuals();
  }

  /**
   * Pushes the tiers the ship should *display*. In the hangar that is the
   * preview selection, everywhere else it is what the player actually owns.
   */
  private applyModuleVisuals(): void {
    if (!this.player) return;
    // The gameState guard matters because startGame() runs before React can
    // commit the hangar-mode prop change, and a preview kit must never survive
    // into an actual run.
    if (this.isHangarMode && this.gameState === 'START') {
      this.player.setModuleLevels(this.previewPowerGen, this.previewAutoCannon, this.previewZoomScanner);
      // Park the turret level and fully charged so the preview reads clearly.
      this.player.aimCannon(0);
      this.player.setCannonCharge(1);
    } else {
      this.player.setModuleLevels(this.powerGenLevel, this.autoCannonLevel, this.zoomScannerLevel);
    }
  }

  // Live count of remaining threats this sector: enemies not yet spawned plus
  // those still alive on screen. Decreases as enemies are destroyed or fly off.
  private lastThreatCount = -1;
  private emitThreatCount(): void {
    const remaining = this.enemySpawnSchedule.length + this.enemies.length;
    if (remaining === this.lastThreatCount) return;
    this.lastThreatCount = remaining;
    if (this.callbacks.onThreatCount) this.callbacks.onThreatCount(remaining);
  }

  private emitModuleStatus(): void {
    if (!this.callbacks.onModuleStatus || !this.player) return;

    // Full bar when the shell is at capacity; otherwise show the countdown to
    // the next regenerated charge so the timer reads as live progress.
    const shieldAtCapacity = this.player.shieldCharges >= this.player.maxShieldCharges;
    let shieldRegenProgress = shieldAtCapacity ? 1 : 0;
    if (this.powerGenLevel > 0 && !shieldAtCapacity) {
      const delay = SHIELD_REGEN_DELAYS_SEC[this.powerGenLevel - 1];
      shieldRegenProgress = Math.min(1, this.shieldRegenTimer / delay);
    }

    let cannonProgress = 0;
    if (this.autoCannonLevel > 0) {
      const reload = AUTO_CANNON_RELOAD_SEC[this.autoCannonLevel - 1];
      cannonProgress = Math.min(1, this.autoCannonTimer / reload);
    }

    this.callbacks.onModuleStatus({
      powerGenLevel: this.powerGenLevel,
      autoCannonLevel: this.autoCannonLevel,
      zoomScannerLevel: this.zoomScannerLevel,
      shieldCellLevel: this.shieldCellLevel,
      shieldActive: this.player.hasShield,
      shieldRegenProgress,
      cannonProgress,
      shieldCharges: this.player.shieldCharges,
      maxShieldCharges: this.player.maxShieldCharges,
      trueVisionActive: this.trueVisionActive
    });
  }

  private findNearestEnemy(): EnemyDrone3D | null {
    let nearest: EnemyDrone3D | null = null;
    let bestDistSq = Infinity;
    for (const drone of this.enemies) {
      // Only target enemies still on-screen ahead of / around the player.
      if (drone.x < -this.bounds.halfWidth) continue;
      const dx = drone.x - this.player.x;
      const dy = drone.y - this.player.y;
      const distSq = dx * dx + dy * dy;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        nearest = drone;
      }
    }
    return nearest;
  }

  private fireProjectile(target: EnemyDrone3D): void {
    const dx = target.x - this.player.x;
    const dy = target.y - this.player.y;
    const len = Math.hypot(dx, dy) || 1;
    const shipConfig = SHIP_COLORS[this.currentShipColor] || SHIP_COLORS.blue;
    const proj = new Projectile3D(
      this.scene,
      this.player.x + 18,
      this.player.y + 8,
      dx / len,
      dy / len,
      shipConfig.colorHex,
      target
    );
    this.projectiles.push(proj);
    this.player.triggerCannonFire();
    soundManager.playCannonSound();
  }

  private clearProjectiles(): void {
    this.projectiles.forEach((p) => p.destroy());
    this.projectiles = [];
  }

  public startGame(): void {
    soundManager.init();
    this.score = 0;
    this.gemsCollected = 0;
    this.level = 1;
    this.levelTimer = 0;
    this.runTime = 0;
    this.enemiesSurvived = 0;
    this.warpTimer = 0;
    this.deathTimer = 0;

    // Modules are per-run only: reset every new game. EASY/NORMAL fit a free
    // tier-1 Auto Cannon from the start; everything else starts unfitted.
    this.powerGenLevel = 0;
    this.autoCannonLevel = getDifficultyStartAutoCannonLevel(this.currentDifficulty);
    this.zoomScannerLevel = 0;
    this.shieldCellLevel = 0;
    this.shieldRegenTimer = 0;
    this.autoCannonTimer =
      this.autoCannonLevel > 0 ? AUTO_CANNON_RELOAD_SEC[this.autoCannonLevel - 1] : 0;
    this.trueVisionModuleLevel = 0;
    this.applyModuleVisuals();
    // Drop module-granted shield charges, keeping only the difficulty handout.
    this.applyShieldChargeBonuses();
    // Reset the viewport back to the default (un-widened) framing.
    this.calculateBounds();

    const config = DIFFICULTY_SETTINGS[this.currentDifficulty];
    this.gameSpeed = config.baseSpeed;
    this.spawnTimer = 0;

    this.starfield.setWarping(false);
    this.player.setWarping(false);

    this.clearObstaclesAndGems();
    this.particleSystem.clear();
    this.player.reset(this.bounds);
    this.lastThreatCount = -1;
    this.setupEnemyScheduleForLevel();

    if (this.callbacks.onScoreUpdate) this.callbacks.onScoreUpdate(this.score);
    if (this.callbacks.onGemsUpdate) this.callbacks.onGemsUpdate(this.gemsCollected, this.totalGems);
    if (this.callbacks.onLevelProgress) this.callbacks.onLevelProgress(0, getLevelDuration(this.level));
    if (this.callbacks.onLevelUp) this.callbacks.onLevelUp(this.level);
    this.emitModuleStatus();

    this.setGameState('PLAYING');
  }

  private setupEnemyScheduleForLevel(): void {
    this.enemies.forEach((e) => e.destroy());
    this.enemies = [];
    // Enemy count and timing scale with the level and its (now variable) duration.
    this.enemySpawnSchedule = getEnemySpawnSchedule(this.level);
    this.emitThreatCount();
  }

  public goToTitleScreen(): void {
    this.setGameState('START');
    this.clearObstaclesAndGems();
    this.particleSystem.clear();
    this.score = 0;
    this.gemsCollected = 0;
    this.level = 1;
    this.levelTimer = 0;
    this.runTime = 0;
    this.enemiesSurvived = 0;
    this.warpTimer = 0;
    this.deathTimer = 0;
    this.starfield.setWarping(false);
    this.player.setWarping(false);
    this.player.reset(this.bounds);
  }

  public triggerScreenShake(intensity = 12): void {
    this.screenShake = intensity;
  }

  public triggerDeath(): void {
    soundManager.playHitSound();
    soundManager.stopThruster();
    this.triggerScreenShake(26);
    this.setGameState('DYING');
    this.deathTimer = 3.0; // 3-second explosion sequence
    this.deathSecondaryTimer = 0.3;

    this.clearProjectiles();

    // Disappear player ship geometry
    this.player.setVisible(false);

    const shipConfig = SHIP_COLORS[this.currentShipColor] || SHIP_COLORS.blue;
    // Primary massive blast
    this.particleSystem.createExplosion(this.player.x, this.player.y, 0, shipConfig.colorHex, 50);
    this.particleSystem.createExplosion(this.player.x, this.player.y, 0, 0xf59e0b, 35);
    // Hull debris fragments
    this.particleSystem.createDebris(this.player.x, this.player.y, 0, shipConfig.colorHex, 26);
    // Expanding shockwave
    this.particleSystem.createShockwave(this.player.x, this.player.y, 0, shipConfig.colorHex);
  }

  // 3-Second Spacewarp Level Transition
  public triggerWarp(): void {
    soundManager.playGemSound();
    this.triggerScreenShake(14);
    this.setGameState('WARPING');
    this.warpTimer = GameEngine.WARP_DURATION; // shop is available during this window
    this.clearProjectiles();

    this.starfield.setWarping(true);
    this.player.setWarping(true);

    // Award level clear bonus gems
    const bonusGems = 5 + this.level * 2;
    this.gemsCollected += bonusGems;
    this.totalGems += bonusGems;
    this.score += 15;

    if (this.callbacks.onScoreUpdate) this.callbacks.onScoreUpdate(this.score);
    if (this.callbacks.onGemsUpdate) this.callbacks.onGemsUpdate(this.gemsCollected, this.totalGems);
    if (this.callbacks.onFloatText) {
      this.callbacks.onFloatText(`SECTOR COMPLETE! +${bonusGems} GEMS!`, this.player.x, this.player.y + 25, '#38bdf8');
    }

    const shipConfig = SHIP_COLORS[this.currentShipColor] || SHIP_COLORS.blue;
    this.particleSystem.createShockwave(this.player.x, this.player.y, 0, shipConfig.colorHex);
    this.particleSystem.createExplosion(this.player.x, this.player.y, 0, 0x38bdf8, 25);
  }

  private clearObstaclesAndGems(): void {
    this.obstacles.forEach((o) => o.destroy());
    this.obstacles = [];
    this.gems.forEach((g) => g.destroy());
    this.gems = [];
    this.enemies.forEach((e) => e.destroy());
    this.enemies = [];
    this.enemySpawnSchedule = [];
    this.clearProjectiles();
  }

  private spawnGemSafely(obs: ObstaclePair3D, startX: number): void {
    const clusterType = Math.random();
    const gemPositions: { x: number; y: number }[] = [];

    if (obs.formationType === 'middle_island') {
      // For middle island, spawn duo or single gem in upper or lower passage
      const isUpper = Math.random() > 0.5;
      const targetY = obs.gapY + (isUpper ? 1 : -1) * obs.gap * 0.44;
      if (clusterType < 0.5) {
        gemPositions.push({ x: startX, y: targetY });
      } else {
        gemPositions.push({ x: startX - 18, y: targetY });
        gemPositions.push({ x: startX + 18, y: targetY });
      }
    } else {
      if (clusterType < 0.4) {
        // Variation 1: Single Gem (1)
        gemPositions.push({ x: startX, y: obs.gapY });
      } else if (clusterType < 0.75) {
        // Variation 2: Double Gem Duo Trail (2)
        const yOffset = (Math.random() - 0.5) * 15;
        gemPositions.push({ x: startX - 20, y: obs.gapY + yOffset });
        gemPositions.push({ x: startX + 20, y: obs.gapY - yOffset });
      } else {
        // Variation 3: Triple Gem Cluster Arc (3)
        const arcY = (Math.random() > 0.5 ? 1 : -1) * 16;
        gemPositions.push({ x: startX - 28, y: obs.gapY - arcY * 0.5 });
        gemPositions.push({ x: startX, y: obs.gapY + arcY });
        gemPositions.push({ x: startX + 28, y: obs.gapY - arcY * 0.5 });
      }
    }

    // Validate and spawn every safe gem in the cluster
    for (const pos of gemPositions) {
      let isSafe = true;

      for (const obstacle of this.obstacles) {
        const clusterY = obstacle.group.position.y;
        for (const ast of obstacle.asteroids) {
          const astWorldX = obstacle.x + ast.offsetX;
          const astWorldY = clusterY + ast.offsetY;
          const dx = pos.x - astWorldX;
          const dy = pos.y - astWorldY;
          const dist = Math.sqrt(dx * dx + dy * dy) - ast.baseRadius;
          if (dist < 26) {
            isSafe = false;
            break;
          }
        }
        if (!isSafe) break;
      }

      if (isSafe) {
        const isBomb = Math.random() * 100 < getBombChancePct(this.level);
        const gem = new Gem3D(this.scene, pos.x, pos.y, isBomb, this.trueVisionActive);
        this.gems.push(gem);
      }
    }
  }

  private animate(): void {
    if (this.isDestroyed) return;

    const now = performance.now();
    // Real elapsed time since last frame, clamped to avoid huge catch-up spikes
    // (e.g. after a tab is backgrounded). Prevents a spiral-of-death on stalls.
    const frameTime = Math.min((now - this.lastTime) / 1000, 0.25);
    this.lastTime = now;

    // Fixed-timestep simulation. The game's movement is frame-based (fixed step
    // per update), so we must decouple it from the display refresh rate.
    // Without this, high-refresh mobile screens (90/120Hz) — which ramp up while
    // a finger is held/dragged — run the simulation faster than on a 60Hz display.
    this.accumulator += frameTime;
    let steps = 0;
    while (this.accumulator >= GameEngine.FIXED_DT && steps < GameEngine.MAX_STEPS_PER_FRAME) {
      this.update(GameEngine.FIXED_DT);
      this.accumulator -= GameEngine.FIXED_DT;
      steps++;
    }
    // Drop any leftover backlog beyond the cap so we never fast-forward.
    if (steps >= GameEngine.MAX_STEPS_PER_FRAME) {
      this.accumulator = 0;
    }

    this.render();

    this.animationFrameId = requestAnimationFrame(this.animate);
  }

  public setPaused(paused: boolean): void {
    this.isPaused = paused;
    // Reset timing so unpausing doesn't produce a large dt jump
    this.lastTime = performance.now();
    this.accumulator = 0;
  }

  private update(dt: number): void {
    // When paused during active gameplay, freeze all simulation but keep rendering
    if (this.isPaused && (this.gameState === 'PLAYING' || this.gameState === 'WARPING')) {
      return;
    }

    // Re-measure the showcase stage a few times a second while a menu is up.
    // getBoundingClientRect forces layout, so this is throttled rather than
    // running every frame, and skipped entirely during gameplay.
    if (this.gameState === 'START') {
      this.showcaseAnchorTimer++;
      if (this.showcaseAnchorTimer >= 12) {
        this.showcaseAnchorTimer = 0;
        this.updateShowcaseAnchor();
      }
    }

    const activeSpeed = this.gameState === 'START' ? 1.8 : this.gameSpeed;
    this.starfield.update(activeSpeed);
    this.particleSystem.update();

    if (this.gameState === 'START') {
      // Background animated title scene
      this.player.update(this.gameState, this.keys, this.pointerY, this.isPointerActive, this.bounds, activeSpeed);

      this.menuBgSpawnTimer++;
      if (this.menuBgSpawnTimer > 180) {
        const config = DIFFICULTY_SETTINGS[this.currentDifficulty];
        const startX = this.bounds.halfWidth + 80;
        const obs = new ObstaclePair3D(
          this.scene,
          startX,
          this.bounds,
          config,
          0,
          this.currentDifficulty,
          config.themeColorHex
        );
        this.obstacles.push(obs);

        if (Math.random() < 0.5) {
          this.spawnGemSafely(obs, startX);
        }
        this.menuBgSpawnTimer = 0;
      }

      // Drift background obstacles
      for (let i = this.obstacles.length - 1; i >= 0; i--) {
        const obs = this.obstacles[i];
        obs.update(activeSpeed);
        if (obs.x < -this.bounds.halfWidth - 100) {
          obs.destroy();
          this.obstacles.splice(i, 1);
        }
      }

      // Drift background gems
      for (let i = this.gems.length - 1; i >= 0; i--) {
        const gem = this.gems[i];
        gem.update(activeSpeed);
        if (gem.x < -this.bounds.halfWidth - 50) {
          gem.destroy();
          this.gems.splice(i, 1);
        }
      }
    } else if (this.gameState === 'PLAYING') {
      this.player.update(this.gameState, this.keys, this.pointerY, this.isPointerActive, this.bounds, this.gameSpeed);

      // Level Progress Timer (Level 1 = 30s, +5s each subsequent sector)
      const levelDuration = getLevelDuration(this.level);
      this.levelTimer += dt;
      this.runTime += dt;
      if (this.callbacks.onLevelProgress) {
        this.callbacks.onLevelProgress(this.levelTimer, levelDuration);
      }
      if (this.levelTimer >= levelDuration) {
        this.triggerWarp();
        return;
      }

      const config = DIFFICULTY_SETTINGS[this.currentDifficulty];
      // Algorithm-based difficulty scaling: gentler speed increments and spawn interval tightening
      const scoreSteps = Math.floor(this.score / DIFFICULTY_ALGORITHM.SCORE_STEP_FOR_SPEED);
      const scoreSpeedBonus = scoreSteps * DIFFICULTY_ALGORITHM.SCORE_SPEED_MULTIPLIER;
      const levelSpeedBonus = (this.level - 1) * DIFFICULTY_ALGORITHM.LEVEL_SPEED_BONUS;
      this.gameSpeed = config.baseSpeed + scoreSpeedBonus + levelSpeedBonus;

      this.spawnTimer++;
      const levelIntervalReduction = (this.level - 1) * DIFFICULTY_ALGORITHM.LEVEL_SPAWN_INTERVAL_REDUCTION;
      const scoreIntervalReduction = this.score * DIFFICULTY_ALGORITHM.SCORE_SPAWN_REDUCTION_FACTOR;
      const interval = Math.max(55, config.spawnInterval - scoreIntervalReduction - levelIntervalReduction);
      if (this.spawnTimer > interval) {
        const startX = this.bounds.halfWidth + 60;
        // After the unlock level, some formations drift vertically. Movers
        // scroll slowly early on and ramp to full speed by maxSpeedLevel.
        const moverSpeed = getMovingAsteroidSpeed(this.level, this.currentDifficulty);
        const isMover = moverSpeed > 0 && Math.random() < MOVING_ASTEROID_CONFIG.spawnChance;
        const obs = new ObstaclePair3D(
          this.scene,
          startX,
          this.bounds,
          config,
          this.score + (this.level - 1) * 3,
          this.currentDifficulty,
          config.themeColorHex,
          isMover ? moverSpeed : 0,
          MOVING_ASTEROID_CONFIG.countScale,
          MOVING_ASTEROID_CONFIG.travelRange
        );
        this.obstacles.push(obs);

        if (Math.random() < 0.6) {
          this.spawnGemSafely(obs, startX);
        }

        this.spawnTimer = 0;
      }

      // Update and check obstacles
      for (let i = this.obstacles.length - 1; i >= 0; i--) {
        const obs = this.obstacles[i];
        obs.update(this.gameSpeed);

        if (!obs.passed && obs.x < this.player.x) {
          obs.passed = true;
          this.score++;
          if (this.callbacks.onScoreUpdate) this.callbacks.onScoreUpdate(this.score);
          if (this.callbacks.onFloatText) {
            this.callbacks.onFloatText('+1', this.player.x + 25, this.player.y + 15, config.themeColor);
          }
        }

        if (obs.collidesWith(this.player)) {
          if (this.player.hasShield) {
            // KH2 Reflect: the shell obliterates the asteroid and spends a charge.
            // Hulls rated for more than one charge survive and stay deployed.
            const shieldDown = this.player.absorbShieldHit();
            soundManager.playHitSound();
            this.triggerScreenShake(shieldDown ? 20 : 12);

            const shipConfig = SHIP_COLORS[this.currentShipColor] || SHIP_COLORS.blue;
            this.particleSystem.createReflectShatter(
              this.player.x,
              this.player.y,
              0,
              shipConfig.colorHex,
              shieldDown ? 40 : 22
            );
            this.particleSystem.createDebris(obs.x, this.player.y, 0, 0x94a3b8, 22);

            if (this.callbacks.onFloatText) {
              this.callbacks.onFloatText(
                this.shieldImpactLabel('⚡ REFLECT SHIELD BREAK!', shieldDown),
                this.player.x + 30,
                this.player.y + 20,
                '#38bdf8'
              );
            }

            obs.destroy();
            this.obstacles.splice(i, 1);
            continue;
          } else {
            this.triggerDeath();
            return;
          }
        }

        if (obs.x < -this.bounds.halfWidth - 80) {
          obs.destroy();
          this.obstacles.splice(i, 1);
        }
      }

      // Update and check gems
      for (let i = this.gems.length - 1; i >= 0; i--) {
        const gem = this.gems[i];
        gem.update(this.gameSpeed);

        if (gem.collidesWith(this.player)) {
          if (gem.isBomb) {
            // Disguised bomb — detonates on contact.
            const gemY = gem.group.position.y;
            gem.destroy();
            this.gems.splice(i, 1);
            soundManager.playHitSound();
            this.triggerScreenShake(22);
            this.particleSystem.createExplosion(gem.x, gemY, 0, 0xef4444, 34);
            this.particleSystem.createDebris(gem.x, gemY, 0, 0xff0033, 20);

            if (this.player.hasShield) {
              const shieldDown = this.player.absorbShieldHit();
              const shipConfig = SHIP_COLORS[this.currentShipColor] || SHIP_COLORS.blue;
              this.particleSystem.createReflectShatter(
                this.player.x,
                this.player.y,
                0,
                shipConfig.colorHex,
                shieldDown ? 40 : 22
              );
              if (this.callbacks.onFloatText) {
                this.callbacks.onFloatText(
                  this.shieldImpactLabel('💣 BOMB! SHIELD DESTROYED!', shieldDown),
                  this.player.x + 30,
                  this.player.y + 20,
                  '#ef4444'
                );
              }
              continue;
            } else {
              this.triggerDeath();
              return;
            }
          }

          soundManager.playGemSound();
          this.gemsCollected++;
          this.totalGems++;
          this.score += 2;
          if (this.callbacks.onGemsUpdate) this.callbacks.onGemsUpdate(this.gemsCollected, this.totalGems);
          if (this.callbacks.onScoreUpdate) this.callbacks.onScoreUpdate(this.score);
          if (this.callbacks.onFloatText) {
            this.callbacks.onFloatText('+1 GEM', gem.x, gem.y + 15, '#fbbf24');
          }
          this.particleSystem.createExplosion(gem.x, gem.y, 0, 0xfbbf24, 18);
          gem.destroy();
          this.gems.splice(i, 1);
          continue;
        }

        if (gem.x < -this.bounds.halfWidth - 30) {
          gem.destroy();
          this.gems.splice(i, 1);
        }
      }

      // Check and spawn scheduled level enemies (Level 2+)
      if (this.enemySpawnSchedule.length > 0 && this.levelTimer >= this.enemySpawnSchedule[0]) {
        this.enemySpawnSchedule.shift();
        const startY = (Math.random() - 0.5) * this.bounds.halfHeight * 1.2;
        const variant = pickEnemyVariant(this.level);
        const enemy = new EnemyDrone3D(this.scene, this.bounds.halfWidth + 60, startY, this.level, this.gameSpeed, variant);
        this.enemies.push(enemy);
        soundManager.playEnemySpawnSound(variant.key);
        if (this.callbacks.onFloatText) {
          const label =
            variant.key === 'heavy'
              ? '⚠️ HEAVY INTERCEPTOR!'
              : variant.key === 'scout'
                ? '⚠️ SCOUT INTERCEPTOR!'
                : '⚠️ ENEMY INTERCEPTOR!';
          this.callbacks.onFloatText(label, enemy.x - 30, enemy.y, variant.accentColor);
        }
      }

      // Update and check enemy drones
      for (let i = this.enemies.length - 1; i >= 0; i--) {
        const drone = this.enemies[i];
        drone.update(this.player.y, this.gameSpeed);

        if (drone.collidesWith(this.player)) {
          if (this.player.hasShield) {
            // Shield hit against enemy: spends a charge, vaporizes enemy drone!
            const shieldDown = this.player.absorbShieldHit();
            soundManager.playHitSound();
            this.triggerScreenShake(shieldDown ? 20 : 12);

            const shipConfig = SHIP_COLORS[this.currentShipColor] || SHIP_COLORS.blue;
            this.particleSystem.createReflectShatter(
              this.player.x,
              this.player.y,
              0,
              shipConfig.colorHex,
              shieldDown ? 40 : 22
            );
            // Wreckage takes the drone's own accent, so heavies burn orange and
            // scouts burn violet instead of every kill reading the same red.
            this.particleSystem.createExplosion(drone.x, drone.y, 0, drone.accentColorHex, 30);
            this.particleSystem.createDebris(drone.x, drone.y, 0, drone.accentColorHex, 18);

            this.score += 3;
            this.enemiesSurvived++;
            if (this.callbacks.onScoreUpdate) this.callbacks.onScoreUpdate(this.score);
            if (this.callbacks.onFloatText) {
              this.callbacks.onFloatText(
                shieldDown
                  ? '💥 ENEMY DESTROYED! +3'
                  : `💥 ENEMY DESTROYED! +3 (🛡️ ${this.player.shieldCharges} LEFT)`,
                this.player.x + 30,
                this.player.y + 20,
                '#f87171'
              );
            }

            drone.destroy();
            this.enemies.splice(i, 1);
            continue;
          } else {
            this.triggerDeath();
            return;
          }
        }

        if (drone.x < -this.bounds.halfWidth - 80) {
          // Enemy flew past the player without landing a hit: survived.
          this.enemiesSurvived++;
          drone.destroy();
          this.enemies.splice(i, 1);
        }
      }

      // --- Power Generator Module: regenerate the reflect shield after a delay ---
      // Regenerates one charge per cycle whenever the shell is below capacity,
      // so it both revives a fully broken shield AND tops worn-down multi-charge
      // shields back up one pip at a time.
      if (this.powerGenLevel > 0 && this.player.shieldCharges < this.player.maxShieldCharges) {
        this.shieldRegenTimer += dt;
        const delay = SHIELD_REGEN_DELAYS_SEC[this.powerGenLevel - 1];
        if (this.shieldRegenTimer >= delay) {
          const wasBroken = !this.player.hasShield;
          if (this.player.regenerateShieldCharge()) {
            this.shieldRegenTimer = 0;
            soundManager.playGemSound();
            const shipConfig = SHIP_COLORS[this.currentShipColor] || SHIP_COLORS.blue;
            this.particleSystem.createShockwave(this.player.x, this.player.y, 0, shipConfig.colorHex);
            if (this.callbacks.onFloatText) {
              const label = wasBroken ? '🛡️ SHIELD RESTORED!' : '🛡️ CHARGE +1';
              this.callbacks.onFloatText(label, this.player.x + 30, this.player.y + 20, '#38bdf8');
            }
          }
        }
      } else {
        // Reset so the countdown starts fresh the moment a charge is next spent.
        this.shieldRegenTimer = 0;
      }

      // --- Auto Cannon Module: charge up and fire at the nearest enemy ---
      if (this.autoCannonLevel > 0) {
        const reload = AUTO_CANNON_RELOAD_SEC[this.autoCannonLevel - 1];
        this.autoCannonTimer += dt;

        // Track the nearest threat every frame so the turret visibly leads it,
        // and feed the reload progress to the heat glow on the charge band.
        const tracked = this.findNearestEnemy();
        this.player.aimCannon(
          tracked ? Math.atan2(tracked.y - this.player.y, Math.max(1, tracked.x - this.player.x)) : 0
        );
        this.player.setCannonCharge(Math.min(1, this.autoCannonTimer / reload));

        if (this.autoCannonTimer >= reload) {
          if (tracked) {
            this.fireProjectile(tracked);
            this.autoCannonTimer = 0;
          } else {
            // Stay fully charged until a target appears.
            this.autoCannonTimer = reload;
          }
        }
      }

      // --- Update auto cannon projectiles and resolve enemy hits ---
      for (let i = this.projectiles.length - 1; i >= 0; i--) {
        const proj = this.projectiles[i];
        proj.update(dt);

        let hit = false;
        for (let j = this.enemies.length - 1; j >= 0; j--) {
          const drone = this.enemies[j];
          const dx = proj.x - drone.x;
          const dy = proj.y - drone.y;
          const combined = proj.radius + drone.radius;
          if (dx * dx + dy * dy < combined * combined) {
            // Vaporize the enemy interceptor
            this.particleSystem.createExplosion(drone.x, drone.y, 0, drone.accentColorHex, 30);
            this.particleSystem.createDebris(drone.x, drone.y, 0, drone.accentColorHex, 16);
            drone.destroy();
            this.enemies.splice(j, 1);
            soundManager.playHitSound();
            this.score += 3;
            this.enemiesSurvived++;
            if (this.callbacks.onScoreUpdate) this.callbacks.onScoreUpdate(this.score);
            if (this.callbacks.onFloatText) {
              this.callbacks.onFloatText('🔫 ENEMY DOWN! +3', drone.x, drone.y + 15, '#f87171');
            }
            hit = true;
            break;
          }
        }

        if (hit || proj.life <= 0 || proj.x > this.bounds.halfWidth + 100 || Math.abs(proj.y) > this.bounds.halfHeight + 100) {
          proj.destroy();
          this.projectiles.splice(i, 1);
        }
      }

      this.emitModuleStatus();
      this.emitThreatCount();
    } else if (this.gameState === 'WARPING') {
      // Hyperspace Warp Animation
      this.warpTimer -= dt;
      // Normalised warp progress drives the ship's lunge to the right edge and
      // its deceleration back to station.
      this.player.warpProgress = THREE.MathUtils.clamp(
        1 - this.warpTimer / GameEngine.WARP_DURATION,
        0,
        1
      );
      this.player.update(this.gameState, this.keys, this.pointerY, this.isPointerActive, this.bounds, this.gameSpeed);

      // Fast clear of remaining obstacles and enemies off screen
      for (let i = this.obstacles.length - 1; i >= 0; i--) {
        const obs = this.obstacles[i];
        obs.update(this.gameSpeed * 3.5);
        if (obs.x < -this.bounds.halfWidth - 100) {
          obs.destroy();
          this.obstacles.splice(i, 1);
        }
      }

      for (let i = this.gems.length - 1; i >= 0; i--) {
        const gem = this.gems[i];
        gem.update(this.gameSpeed * 3.5);
        if (gem.x < -this.bounds.halfWidth - 50) {
          gem.destroy();
          this.gems.splice(i, 1);
        }
      }

      for (let i = this.enemies.length - 1; i >= 0; i--) {
        const drone = this.enemies[i];
        drone.x -= this.gameSpeed * 3.5;
        drone.group.position.x = drone.x;
        if (drone.x < -this.bounds.halfWidth - 80) {
          drone.destroy();
          this.enemies.splice(i, 1);
        }
      }
      this.emitThreatCount();

      // Warp exit transition
      if (this.warpTimer <= 0) {
        this.level++;
        this.levelTimer = 0;
        this.setGameState('PLAYING');
        this.starfield.setWarping(false);
        this.player.setWarping(false);
        this.player.triggerShieldPowerUp();
        this.setupEnemyScheduleForLevel();
        this.triggerScreenShake(12);

        const shipConfig = SHIP_COLORS[this.currentShipColor] || SHIP_COLORS.blue;
        this.particleSystem.createExplosion(this.player.x, this.player.y, 0, shipConfig.colorHex, 35);

        if (this.callbacks.onLevelUp) {
          this.callbacks.onLevelUp(this.level);
        }
        if (this.callbacks.onFloatText) {
          this.callbacks.onFloatText(`ARRIVED AT SECTOR ${this.level}!`, this.player.x, this.player.y + 25, '#38bdf8');
        }
      }
    } else if (this.gameState === 'DYING') {
      // 3-Second Cinematic Death Explosion Sequence
      this.deathTimer -= dt;
      this.deathSecondaryTimer -= dt;

      // Gracefully decelerate level scrolling to a complete dead halt
      this.gameSpeed = Math.max(0, this.gameSpeed * 0.93 - 0.05);

      // Drift remaining obstacles, gems & enemies with decelerating speed
      for (const obs of this.obstacles) {
        obs.update(this.gameSpeed);
      }
      for (const gem of this.gems) {
        gem.update(this.gameSpeed);
      }
      for (const drone of this.enemies) {
        drone.x -= this.gameSpeed;
        drone.group.position.x = drone.x;
      }

      // Cascading secondary explosion bursts during the 3 seconds
      const shipConfig = SHIP_COLORS[this.currentShipColor] || SHIP_COLORS.blue;
      if (this.deathSecondaryTimer <= 0 && this.deathTimer > 0.4) {
        this.deathSecondaryTimer = 0.38;
        const rx = this.player.x + (Math.random() - 0.5) * 30;
        const ry = this.player.y + (Math.random() - 0.5) * 30;

        soundManager.playHitSound();
        this.triggerScreenShake(8);
        this.particleSystem.createExplosion(rx, ry, 0, Math.random() > 0.4 ? shipConfig.colorHex : 0xf59e0b, 22);
        this.particleSystem.createShockwave(rx, ry, 0, shipConfig.colorHex);
      }

      // Transition to Game Over screen once 3-second explosion sequence completes
      if (this.deathTimer <= 0) {
        this.setGameState('GAMEOVER');
        if (this.callbacks.onGameOver) {
          this.callbacks.onGameOver({
            score: this.score,
            gemsCollected: this.gemsCollected,
            level: this.level,
            enemiesSurvived: this.enemiesSurvived,
            runTimeSec: this.runTime
          });
        }
      }
    }
  }

  private render(): void {
    if (this.screenShake > 0) {
      this.camera.position.x = (Math.random() - 0.5) * this.screenShake;
      this.camera.position.y = (Math.random() - 0.5) * this.screenShake;
      this.screenShake *= 0.88;
      if (this.screenShake < 0.2) {
        this.screenShake = 0;
        this.camera.position.x = 0;
        this.camera.position.y = 0;
      }
    }

    // Warp punches up the bloom for a hyperspace overexposure feel
    const targetBloom = this.gameState === 'WARPING' ? 1.15 : 0.62;
    this.bloomPass.strength += (targetBloom - this.bloomPass.strength) * 0.08;

    this.gradePass.uniforms.uTime.value = performance.now() * 0.001;
    // Screen shake also smears the lens fringe for a stronger impact read
    this.gradePass.uniforms.uAberration.value = 0.0016 + Math.min(this.screenShake, 26) * 0.00022;

    this.composer.render();
  }

  public destroy(): void {
    this.isDestroyed = true;
    cancelAnimationFrame(this.animationFrameId);

    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    this.container.removeEventListener('mousedown', this.handlePointerDown as EventListener);
    this.container.removeEventListener('mousemove', this.handlePointerMove as EventListener);
    this.container.removeEventListener('touchstart', this.handlePointerDown as EventListener);
    this.container.removeEventListener('touchmove', this.handlePointerMove as EventListener);
    window.removeEventListener('mouseup', this.handlePointerUp);
    window.removeEventListener('touchend', this.handlePointerUp);
    window.removeEventListener('resize', this.onResizeBound);

    this.clearObstaclesAndGems();
    this.starfield.destroy();
    this.player.destroy();
    this.particleSystem.destroy();

    if (this.renderer.domElement && this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
    this.composer.dispose();
    this.renderer.dispose();
  }
}
