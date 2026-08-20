import * as THREE from 'three';
import { soundManager } from '../audio/soundManager';
import { Bounds, GameState, ShipModelId } from '../types/game';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { SHIPS_CONFIG, computeShieldCharges } from '../constants/gameConfig';
import { makeFin, makePlanform, makeRevolvedHull } from './hullGeometry';

/**
 * Global dimmer for every layer of the Reflect shield (energy bubble, crystal
 * plates, shard outlines, and sparkle flares). Lowering this makes the whole
 * shell more see-through in one place instead of retuning each shader.
 */
const SHIELD_OPACITY_SCALE = 0.6;

/**
 * Tuned opacity of the shell's shard outlines at full charge, before
 * SHIELD_OPACITY_SCALE and the remaining-charge factor are applied.
 */
const SHIELD_WIRE_BASE_OPACITY = 0.18;

/**
 * Radius factors of the concentric Reflect shells, outermost first. One shell is
 * lit per remaining charge, so a 3-charge shell reads as three nested crystal
 * cages. The outermost stays at 1.0 so the collision radius is identical no
 * matter how many charges the hull carries.
 */
const SHIELD_LAYER_RADIUS_FACTORS = [1.0, 0.9, 0.8];

/** Charges beyond this are expressed as band thickness instead of a new shell. */
const SHIELD_MAX_LAYERS = SHIELD_LAYER_RADIUS_FACTORS.length;

/**
 * Per-shell brightness. Inner shells are dimmer so they read as backing layers
 * seen through the outer cage rather than three equally-weighted spheres.
 */
const SHIELD_LAYER_DIM = [1.0, 0.7, 0.5];

/**
 * Screen-space thickness (in CSS pixels) of the leading-face reinforcement band
 * per charge past `SHIELD_MAX_LAYERS`, and the cap it saturates at. So 4 charges
 * draws a 1px band, 5 draws 2px, and 6 or more draws 3px.
 */
const SHIELD_FRONT_BAND_PX_PER_CHARGE = 1;
const SHIELD_FRONT_BAND_MAX_PX = 3;

/** Band opacity at full charge, before SHIELD_OPACITY_SCALE is applied. */
const SHIELD_FRONT_BAND_OPACITY = 0.5;

/** Base hull collision radius at sizeScale 1.0, before the ship model scales it. */
const HULL_BASE_RADIUS = 11;

/** One concentric crystal shell of the Reflect shield. */
interface ShieldLayer {
  /** Holds the shell's plate mesh and shard outlines at this layer's radius. */
  group: THREE.Group;
  plateMat: THREE.ShaderMaterial;
  wireMat: THREE.ShaderMaterial;
  /** Brightness multiplier from SHIELD_LAYER_DIM. */
  dim: number;
}

/** Hull-local attachment points for the shop module hardware. */
interface ModuleMounts {
  /** Dorsal turret ring centre. */
  turret: THREE.Vector3;
  /** Reactor pod on the +z side; the -z pod mirrors it. */
  reactor: THREE.Vector3;
  /** Base of the radar mast. */
  scanner: THREE.Vector3;
}

/**
 * Where each hull carries its modules. Picked per ship so the turret sits on a
 * spine or deck rather than floating, the reactor pods hang off a wing or
 * sponson, and the radar mast has clear sky above it. These are hull-local, so
 * they scale with the ship like the rest of the model.
 */
const MODULE_MOUNTS: Record<ShipModelId, ModuleMounts> = {
  dart: {
    turret: new THREE.Vector3(-1.5, 6.2, 0),
    reactor: new THREE.Vector3(-6.0, -4.4, 10.6),
    scanner: new THREE.Vector3(-9.5, 5.0, 0)
  },
  viper: {
    turret: new THREE.Vector3(-2.0, 5.2, 0),
    reactor: new THREE.Vector3(-4.0, -4.4, 8.6),
    scanner: new THREE.Vector3(-12.0, 2.6, 0)
  },
  titan: {
    turret: new THREE.Vector3(6.0, 5.2, 0),
    reactor: new THREE.Vector3(-4.0, -4.4, 11.2),
    scanner: new THREE.Vector3(-6.0, 8.8, 0)
  },
  phantom: {
    turret: new THREE.Vector3(-6.0, 5.4, 0),
    reactor: new THREE.Vector3(-7.5, 0, 9.2),
    scanner: new THREE.Vector3(6.0, 5.2, 0)
  },
  valkyrie: {
    turret: new THREE.Vector3(-3.0, 6.2, 0),
    reactor: new THREE.Vector3(-9.0, -4.6, 9.2),
    scanner: new THREE.Vector3(-9.5, 6.0, 0)
  }
};

/**
 * Model-space radius the Reflect shell geometry is built at. Both the rendered
 * dome and the shield's collision radius derive from this single number, so the
 * hitbox can never drift away from what the player actually sees.
 */
const SHIELD_GEOMETRY_RADIUS = 24;

/**
 * Extra magnification applied to the hangar showcase only, so hulls read large
 * on the inspection stage. Safe above 1.0 because the hangar hides the shield
 * shell, which is what constrained the original framing on the title screen.
 */
const HANGAR_SHOWCASE_ZOOM = 1.5;

/**
 * Baseline magnification for every showcase stage (title screen and hangar
 * alike). The stage rectangles in ui.css were grown by the same factor, so the
 * hull still sits inside its frame the way it always did — it just reads 50%
 * larger on screen. GameEngine's stage-height reference was scaled to match, so
 * the measured `fit` factor is unaffected by the taller rectangles.
 */
const SHOWCASE_ZOOM = 1.5;

/** Resting scale of the shield group in flight, relative to the ship's sizeScale. */
const SHIELD_REST_SCALE = 1.18;

/**
 * Wall-clock length of the shell's "powering up" sequence, used when the shield
 * is cast fresh (run/level start) or regenerated by the power generator. Driven
 * off `performance.now()` rather than a per-frame increment so the spin-up reads
 * as the same two seconds regardless of the display's refresh rate.
 */
const SHIELD_POWER_UP_DURATION_SEC = 2.0;

/**
 * Length of the much snappier re-pop played when a multi-charge shell absorbs a
 * hit and holds. That is impact feedback, not a spin-up, so it stays quick.
 */
const SHIELD_IMPACT_REPOP_DURATION_SEC = 0.3;

/** Fraction of the power-up spent building before the final settle-in snap. */
const SHIELD_POWER_UP_BUILD_FRACTION = 0.75;

/**
 * Adds procedural hull detail to a MeshStandardMaterial: recessed panel lines,
 * a faint brushed-metal streak, and a fresnel rim in the ship's accent colour.
 * This runs on every ship model, so all five hulls gain surface detail without
 * touching their geometry.
 */
function applyHullShader(mat: THREE.MeshStandardMaterial, rimColor: THREE.Color): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRimColor = { value: rimColor };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vHullLocal;
         varying vec3 vHullNormal;
         varying vec3 vHullView;`
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
         vHullLocal = position;
         vHullNormal = normalize(normalMatrix * normal);
         vHullView = -mvPosition.xyz;`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform vec3 uRimColor;
         varying vec3 vHullLocal;
         varying vec3 vHullNormal;
         varying vec3 vHullView;`
      )
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
         // Panel seams running along and across the fuselage
         float seamX = abs(fract(vHullLocal.x * 0.18) - 0.5) * 2.0;
         float seamZ = abs(fract(vHullLocal.z * 0.26) - 0.5) * 2.0;
         float seam = min(smoothstep(0.0, 0.14, seamX), smoothstep(0.0, 0.14, seamZ));
         gl_FragColor.rgb *= mix(0.55, 1.0, seam);

         // Brushed-metal micro streaks for surface interest
         float streak = 0.94 + 0.06 * sin(vHullLocal.y * 6.0 + vHullLocal.x * 1.5);
         gl_FragColor.rgb *= streak;

         // Accent fresnel rim so the silhouette reads against dark space
         float hullNdv = 1.0 - clamp(dot(normalize(vHullNormal), normalize(vHullView)), 0.0, 1.0);
         gl_FragColor.rgb += uRimColor * pow(hullNdv, 2.6) * 0.9;`
      );
  };
  mat.customProgramCacheKey = () => 'hullPanels';
}

/**
 * Builds one thruster flame shell.
 *
 * The cone is open-ended (no base cap) and rotated so its tip points down -X,
 * i.e. out the back of the ship. Two extra attributes ride along:
 *  - `aT`   0 at the nozzle, 1 at the tail tip. Drives the temperature ramp.
 *  - `aSeed` constant per thruster, so several nozzles on the same hull flicker
 *            on their own clocks while still sharing one material.
 */
function makeFlameGeometry(radius: number, length: number, seed: number): THREE.BufferGeometry {
  const geo = new THREE.ConeGeometry(radius, length, 28, 14, true);
  geo.rotateZ(Math.PI / 2);

  const pos = geo.getAttribute('position');
  const tAttr = new Float32Array(pos.count);
  const seedAttr = new Float32Array(pos.count);
  const half = length / 2;
  for (let i = 0; i < pos.count; i++) {
    tAttr[i] = Math.min(1, Math.max(0, (half - pos.getX(i)) / length));
    seedAttr[i] = seed;
  }
  geo.setAttribute('aT', new THREE.BufferAttribute(tAttr, 1));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seedAttr, 1));
  return geo;
}

/** Shared GLSL: cheap 3D value noise + fbm, used for the flame turbulence. */
const FLAME_NOISE_GLSL = `
  float fhash(vec3 p) {
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
  }

  float fnoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(fhash(i + vec3(0,0,0)), fhash(i + vec3(1,0,0)), f.x),
          mix(fhash(i + vec3(0,1,0)), fhash(i + vec3(1,1,0)), f.x), f.y),
      mix(mix(fhash(i + vec3(0,0,1)), fhash(i + vec3(1,0,1)), f.x),
          mix(fhash(i + vec3(0,1,1)), fhash(i + vec3(1,1,1)), f.x), f.y),
      f.z);
  }

  float ffbm(vec3 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
      v += a * fnoise(p);
      p *= 2.02;
      a *= 0.5;
    }
    return v;
  }
`;

const FLAME_VERTEX_GLSL = `
  attribute float aT;
  attribute float aSeed;

  uniform float uTime;
  uniform float uThrust;
  uniform float uWobble;

  varying float vT;
  varying float vSeed;
  varying vec3 vLocal;
  varying vec3 vNormal;
  varying vec3 vView;

  ${FLAME_NOISE_GLSL}

  void main() {
    vT = aT;
    vSeed = aSeed;

    vec3 p = position;

    // Combustion pulse: the plume necks in near the nozzle and swells further
    // back, which is what makes a jet read as burning gas rather than a solid cone.
    float pulse = fnoise(vec3(aT * 3.0, uTime * 3.4 + aSeed * 17.0, aSeed * 5.0)) - 0.5;
    float swell = 1.0 + pulse * 0.55 * smoothstep(0.05, 0.8, aT) * uWobble;

    // Lateral licking, growing toward the tail where the gas is unconstrained.
    float sway = smoothstep(0.15, 1.0, aT) * uWobble;
    float swayY = (fnoise(vec3(aT * 2.4, uTime * 2.6 + aSeed * 9.0, 0.0)) - 0.5) * 2.0;
    float swayZ = (fnoise(vec3(aT * 2.4, 0.0, uTime * 2.9 + aSeed * 3.0)) - 0.5) * 2.0;

    p.yz *= swell;
    p.y += swayY * sway * 2.6;
    p.z += swayZ * sway * 2.6;

    // Harder throttle stretches the plume backward instead of just brightening it.
    p.x -= aT * uThrust * 6.0;

    vLocal = p;
    vNormal = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vView = -mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

/**
 * Fire fragment shader.
 *
 * Temperature runs along the plume: a white-hot throat at the nozzle, then
 * yellow, orange, and finally a ragged red-to-soot tail. Turbulence is scrolled
 * backward along -X so the flame visibly streams out of the engine, and it is
 * folded into the temperature lookup as well as the alpha so the hot and the
 * torn parts of the flame line up the way they do in a real exhaust.
 *
 * `uAccent` only tints the very throat, which keeps the ship-colour identity
 * without turning the whole plume back into a coloured cone.
 */
const FLAME_FRAGMENT_GLSL = `
  uniform float uTime;
  uniform vec3 uAccent;
  uniform float uThrust;
  uniform float uWarp;
  uniform float uCore;

  varying float vT;
  varying float vSeed;
  varying vec3 vLocal;
  varying vec3 vNormal;
  varying vec3 vView;

  ${FLAME_NOISE_GLSL}

  void main() {
    // Turbulence streaming out the back. Stretched along X so the cells read as
    // gas filaments rather than blobs.
    vec3 np = vec3(vLocal.x * 0.10, vLocal.y * 0.26, vLocal.z * 0.26);
    np.x += uTime * 2.4 + vSeed * 11.0;
    float turb = ffbm(np);
    float turbFine = fnoise(np * 3.1 + vec3(uTime * 4.5, 0.0, 0.0));

    // Effective distance along the plume, torn up by the turbulence so the flame
    // has a broken, licking edge instead of a clean gradient.
    float t = clamp(vT + (turb - 0.5) * 0.55 + (turbFine - 0.5) * 0.18, 0.0, 1.4);

    // --- Temperature ramp: white -> yellow -> orange -> red -> soot ---
    vec3 white  = vec3(1.00, 0.98, 0.90);
    vec3 yellow = vec3(1.00, 0.83, 0.32);
    vec3 orange = vec3(1.00, 0.45, 0.08);
    vec3 red    = vec3(0.85, 0.13, 0.02);
    vec3 soot   = vec3(0.22, 0.03, 0.01);

    vec3 color = mix(white, yellow, smoothstep(0.00, 0.22, t));
    color = mix(color, orange, smoothstep(0.18, 0.48, t));
    color = mix(color, red,    smoothstep(0.45, 0.78, t));
    color = mix(color, soot,   smoothstep(0.75, 1.05, t));

    // Blue-hot stoichiometric throat, tinted with the ship's accent colour so the
    // hull palette still reads at the nozzle.
    float throat = 1.0 - smoothstep(0.0, 0.16, vT);
    color = mix(color, mix(vec3(0.75, 0.90, 1.0), uAccent, 0.55), throat * 0.75);

    // Grazing angles look thicker: the classic trick for faking volume on a shell.
    float ndv = abs(dot(normalize(vNormal), normalize(vView)));
    float thickness = pow(1.0 - ndv, 0.55) + 0.25;

    // Fade out along the plume, cut short by the turbulence for a torn tail.
    float tail = 1.0 - smoothstep(0.35, 1.0, t);
    float nozzle = smoothstep(0.0, 0.05, vT);

    float alpha = tail * thickness * nozzle;
    alpha *= 0.55 + turb * 0.75;
    alpha *= mix(0.55, 1.15, uThrust);
    alpha *= uCore;
    alpha *= 1.0 + uWarp * 0.8;

    // Hotter cores get a brightness boost so bloom blows the throat out to white.
    //
    // Under warp the throat boost is deliberately pulled back and the gain moved
    // further down the plume instead: an overexposed throat sits right under the
    // fuselage, and its bloom halo washes forward over the nose and hides the
    // ship. This keeps the long torch bright while sparing the hull.
    float throatBoost = throat * (1.6 - uWarp * 1.05);
    float plumeBoost = uWarp * 0.9 * smoothstep(0.10, 0.45, vT);
    color *= 1.0 + throatBoost + plumeBoost;

    if (alpha < 0.01) discard;
    gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
  }
`;

interface TrailParticle {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  life: number;
  decay: number;
  vx: number;
}

export class PlayerShip {
  private scene: THREE.Scene;
  public group: THREE.Group;
  private shipModelGroup: THREE.Group;

  /**
   * Hull collision radius. Only used directly when the Reflect shield is down;
   * while the shield is up, incoming threats are tested against
   * `threatCollisionRadius` instead. See `shieldCollisionRadius`.
   */
  public radius = HULL_BASE_RADIUS;
  public x = 0;
  public y = 0;
  public z = 145;
  public vy = 0;

  // Stats derived from active ship model
  public shipModelId: ShipModelId = 'dart';
  public sizeScale = 1.0;
  public speed = 7.0;
  public smoothness = 0.13;

  private idleTime = 0;
  private flameTime = 0;
  private showcaseRotY = 0;

  private shipColorHex = 0x38bdf8;
  /** Live-mutated accent colour driving the hull fresnel rim shader. */
  private hullRimColor!: THREE.Color;

  // Shared greeble geometry, built once and reused across model swaps
  private greebleGeo: THREE.BoxGeometry | null = null;
  private finGeo: THREE.ExtrudeGeometry | null = null;
  private navLightGeo: THREE.SphereGeometry | null = null;
  private navLightMat: THREE.MeshBasicMaterial | null = null;
  /** Set by hulls that build their own greebles, to skip the generic pass. */
  private customGreebles = false;

  // Dynamic mesh references
  private bodyMesh!: THREE.Mesh;
  private bodyMat!: THREE.MeshStandardMaterial;
  private edgeMat!: THREE.LineBasicMaterial;
  private wingMesh!: THREE.Mesh;
  private wingMat!: THREE.MeshStandardMaterial;
  /** Darker, less reflective plating: armour, strakes, greebles. */
  private trimMat: THREE.MeshStandardMaterial | null = null;
  /** Additive accent glow for nozzle throats, coils and solar cells. */
  private glowMat: THREE.MeshBasicMaterial | null = null;
  private cockpitMesh!: THREE.Mesh;
  /** Additive canopy outline. Damped during warp so the nose does not blow out. */
  private canopyFrameMat: THREE.LineBasicMaterial | null = null;
  private flameMeshes: THREE.Mesh[] = [];
  /** Outer, cooler, more turbulent plume envelope. */
  private flameMat!: THREE.ShaderMaterial;
  /** Inner white-hot core, drawn tighter and brighter inside the envelope. */
  private flameCoreMat!: THREE.ShaderMaterial;
  private engineLight!: THREE.PointLight;
  private showcaseSpotLight!: THREE.PointLight;

  // Kingdom Hearts 2 Reflect Geodesic Shield
  public hasShield = true;
  public isShieldPoweringUp = false;
  public shieldPowerUpProgress = 1.0;
  /** `performance.now()` stamp the current power-up/re-pop started at. */
  private shieldPowerUpStartMs = 0;
  /** Duration of the in-flight spin-up, so the long cast and the quick impact
   * re-pop can share one animation path. */
  private shieldPowerUpDurationSec = SHIELD_POWER_UP_DURATION_SEC;
  /**
   * Impacts the reflect shell can still absorb. The shell only breaks when this
   * hits 0, so a hull rated for 2 charges survives its first hit.
   */
  public shieldCharges = 1;
  /** Total charges granted by the current hull (plus any future module bonus). */
  public maxShieldCharges = 1;
  /** Extra charges layered on top of the hull rating by modules. */
  public bonusShieldCharges = 0;
  private shieldGroup: THREE.Group;
  /** Concentric crystal shells, outermost first. One is lit per charge. */
  private shieldLayers: ShieldLayer[] = [];
  /**
   * Thick outline on the leading face only, used to express charges the three
   * concentric shells have run out of room for.
   */
  private shieldFrontBand: LineSegments2 | null = null;
  private shieldFrontBandMat: LineMaterial | null = null;
  /** Shared uniform feeding the band's front-face mask, refreshed per frame. */
  private shieldFrontBandForward: { value: THREE.Vector3 } | null = null;
  /**
   * Band opacity at the current charge count, before the materialisation fade.
   * The plate shader fades itself in via `uForm`; the band has no such term, so
   * its opacity is scaled on the CPU instead.
   */
  private shieldFrontBandBaseOpacity = SHIELD_FRONT_BAND_OPACITY * SHIELD_OPACITY_SCALE;
  /**
   * Canvas size in CSS pixels. LineMaterial needs this to convert its pixel
   * linewidth into clip space, so the band is exactly as thick as advertised.
   */
  private viewportResolution = new THREE.Vector2(
    typeof window === 'undefined' ? 1920 : window.innerWidth,
    typeof window === 'undefined' ? 1080 : window.innerHeight
  );
  private shieldBubbleMat!: THREE.ShaderMaterial;
  private shieldSparkles: THREE.Sprite[] = [];
  private shieldTwinkleTime = 0;
  private shieldSparkleSpin = 0;

  private trailParticles: TrailParticle[] = [];
  private trailGeo!: THREE.SphereGeometry;

  // Module visuals
  private moduleGroup: THREE.Group;
  private cannonGroup: THREE.Group | null = null;
  /** Elevating cradle: barrels, drum and radiators all ride on this. */
  private cannonYoke: THREE.Group | null = null;
  private cannonBarrels: THREE.Mesh[] = [];
  private cannonLight: THREE.PointLight | null = null;
  /** Charge band + top radiator plate, heated by the reload progress. */
  private cannonHeatMat: THREE.MeshStandardMaterial | null = null;
  private powerGenGroup: THREE.Group | null = null;
  private powerGenLight: THREE.PointLight | null = null;
  private powerGenRings: THREE.Mesh[] = [];
  private powerGenCoreMat: THREE.MeshBasicMaterial | null = null;
  private scannerGroup: THREE.Group | null = null;
  /** Rotating radar head (bowl + feed horn + sweep blade). */
  private scannerDish: THREE.Group | null = null;
  private scannerSweep: THREE.Mesh | null = null;
  private moduleTime = 0;
  private cannonRecoil = 0; // 0..1, decays after firing
  /** Target turret elevation in radians, eased toward each frame. */
  private cannonAim = 0;
  /** Reload progress 0..1, drives the turret's heat glow. */
  private cannonCharge = 0;
  public autoCannonLevel = 0;
  public powerGenLevel = 0;
  public zoomScannerLevel = 0;

  public isHangar = false;
  /**
   * World-space centre and fit factor of the on-screen showcase stage rectangle,
   * measured by GameEngine from the DOM. Null means "use the legacy framing".
   */
  public showcaseAnchor: { x: number; y: number; scale: number } | null = null;
  public isWarping = false;
  /**
   * 0 -> 1 across the warp window, fed by GameEngine from its warp timer. Drives
   * the hyperspace lunge: the ship accelerates out to the right edge, holds
   * there at peak speed, then decelerates back to its resting station on the
   * left before normal play resumes.
   */
  public warpProgress = 0;
  /** Current lunge amount, 0 at station and 1 at the right edge. */
  private warpSurge = 0;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.shipModelGroup = new THREE.Group();
    this.group.add(this.shipModelGroup);

    // Module attachments group (auto cannon + power generator visuals).
    // Kept separate from shipModelGroup so it survives ship-model rebuilds.
    this.moduleGroup = new THREE.Group();
    this.group.add(this.moduleGroup);

    // Shield Group
    this.shieldGroup = new THREE.Group();
    this.buildReflectShield();
    this.group.add(this.shieldGroup);

    // Dedicated showcase highlight light
    this.showcaseSpotLight = new THREE.PointLight(0xffffff, 2.5, 300);
    this.showcaseSpotLight.position.set(0, 40, 100);
    this.group.add(this.showcaseSpotLight);

    this.buildTrailSystem();
    this.setShipModel('dart');

    this.scene.add(this.group);
  }

  /**
   * Builds the KH2 "Reflect" crystal plate shell.
   *
   * The reference effect is not a smooth bubble: it is a Goldberg polyhedron of
   * chunky hexagonal/pentagonal crystal plates, each one slightly shrunk away
   * from its neighbours and pushed out by a different amount so the silhouette
   * reads as overlapping shards of ice rather than a sphere.
   *
   * We derive those plates from the dual of a subdivided icosahedron: every
   * vertex of the icosphere becomes one plate whose corners are the centroids of
   * the faces touching that vertex (6 corners almost everywhere, 5 at the twelve
   * original icosahedron vertices).
   */
  private buildCrystalPlates(radius: number): {
    plateGeo: THREE.BufferGeometry;
    rimGeo: THREE.BufferGeometry;
  } {
    const src = new THREE.IcosahedronGeometry(radius, 2);
    const srcPos = src.getAttribute('position');

    // --- Weld the non-indexed triangle soup so we can walk the topology ---
    const unique: THREE.Vector3[] = [];
    const lookup = new Map<string, number>();
    const faces: number[][] = [];
    for (let i = 0; i < srcPos.count; i += 3) {
      const tri: number[] = [];
      for (let k = 0; k < 3; k++) {
        const v = new THREE.Vector3().fromBufferAttribute(srcPos, i + k);
        const key = `${v.x.toFixed(3)}|${v.y.toFixed(3)}|${v.z.toFixed(3)}`;
        let idx = lookup.get(key);
        if (idx === undefined) {
          idx = unique.length;
          unique.push(v);
          lookup.set(key, idx);
        }
        tri.push(idx);
      }
      faces.push(tri);
    }
    src.dispose();

    const faceCentroids = faces.map((f) =>
      new THREE.Vector3()
        .add(unique[f[0]])
        .add(unique[f[1]])
        .add(unique[f[2]])
        .multiplyScalar(1 / 3)
        .normalize()
        .multiplyScalar(radius)
    );

    const vertexFaces: number[][] = unique.map(() => []);
    faces.forEach((f, fi) => f.forEach((vi) => vertexFaces[vi].push(fi)));

    const platePos: number[] = [];
    const plateNormal: number[] = [];
    const plateEdge: number[] = []; // 0 at plate centre, 1 at plate rim
    const plateRand: number[] = []; // per-plate random, drives shimmer + depth
    const rimPos: number[] = [];

    // Deterministic hash so the plate layout is identical every run.
    const hash = (n: number) => {
      const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
      return s - Math.floor(s);
    };

    const tangent = new THREE.Vector3();
    const bitangent = new THREE.Vector3();

    unique.forEach((vertex, vi) => {
      const ring = vertexFaces[vi];
      if (ring.length < 3) return;

      const normal = vertex.clone().normalize();

      // Stable tangent frame for angular sorting of the plate corners.
      tangent
        .set(0, 1, 0)
        .cross(normal)
        .normalize();
      if (tangent.lengthSq() < 1e-6) tangent.set(1, 0, 0);
      bitangent.copy(normal).cross(tangent).normalize();

      const corners = ring
        .map((fi) => faceCentroids[fi])
        .slice()
        .sort((a, b) => {
          const aa = Math.atan2(a.dot(bitangent), a.dot(tangent));
          const bb = Math.atan2(b.dot(bitangent), b.dot(tangent));
          return aa - bb;
        });

      const centre = new THREE.Vector3();
      corners.forEach((c) => centre.add(c));
      centre.multiplyScalar(1 / corners.length);

      // Each plate floats at its own height and shrinks a touch so the dark
      // gaps between shards stay visible - that separation is what makes the
      // effect read as crystal instead of glass.
      const r = hash(vi);
      const lift = 1 + 0.012 + r * 0.055;
      const shrink = 0.82 + hash(vi + 97) * 0.1;

      const shaped = corners.map((c) =>
        c.clone().sub(centre).multiplyScalar(shrink).add(centre).multiplyScalar(lift)
      );
      const shapedCentre = centre.clone().multiplyScalar(lift);

      // Fan-triangulate from the plate centre; aEdge interpolates outward so the
      // fragment shader can put a hot rim on every shard.
      for (let i = 0; i < shaped.length; i++) {
        const a = shaped[i];
        const b = shaped[(i + 1) % shaped.length];

        platePos.push(shapedCentre.x, shapedCentre.y, shapedCentre.z);
        platePos.push(a.x, a.y, a.z);
        platePos.push(b.x, b.y, b.z);

        plateEdge.push(0, 1, 1);
        for (let k = 0; k < 3; k++) {
          plateNormal.push(normal.x, normal.y, normal.z);
          plateRand.push(r);
        }

        rimPos.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
    });

    const plateGeo = new THREE.BufferGeometry();
    plateGeo.setAttribute('position', new THREE.Float32BufferAttribute(platePos, 3));
    plateGeo.setAttribute('normal', new THREE.Float32BufferAttribute(plateNormal, 3));
    plateGeo.setAttribute('aEdge', new THREE.Float32BufferAttribute(plateEdge, 1));
    plateGeo.setAttribute('aRand', new THREE.Float32BufferAttribute(plateRand, 1));

    const rimGeo = new THREE.BufferGeometry();
    rimGeo.setAttribute('position', new THREE.Float32BufferAttribute(rimPos, 3));

    return { plateGeo, rimGeo };
  }

  /** Four-point star flare used for the sparkles that pop around the shell. */
  private createSparkleTexture(): THREE.Texture {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const c = size / 2;

    const core = ctx.createRadialGradient(c, c, 0, c, c, size * 0.16);
    core.addColorStop(0, 'rgba(255,255,255,1)');
    core.addColorStop(0.4, 'rgba(215,240,255,0.55)');
    core.addColorStop(1, 'rgba(160,220,255,0)');
    ctx.fillStyle = core;
    ctx.fillRect(0, 0, size, size);

    // Long thin cross streaks, the signature of the KH2 sparkle
    ctx.translate(c, c);
    for (let i = 0; i < 4; i++) {
      const grad = ctx.createLinearGradient(0, 0, c, 0);
      grad.addColorStop(0, 'rgba(255,255,255,0.95)');
      grad.addColorStop(0.25, 'rgba(220,245,255,0.35)');
      grad.addColorStop(1, 'rgba(190,235,255,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(0, -size * 0.035);
      ctx.lineTo(c, 0);
      ctx.lineTo(0, size * 0.035);
      ctx.closePath();
      ctx.fill();
      ctx.rotate(Math.PI / 2);
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  // Build the KH2 Reflect Crystal Geodesic Shield with per-facet variation shader
  private buildReflectShield(): void {
    const shieldRadius = SHIELD_GEOMETRY_RADIUS;

    // Translucent energy dome fill: a smooth, welded (indexed) sphere with shared
    // vertices and smooth normals. Using a flat-shaded, non-indexed mesh here caused
    // every triangle edge to be under-covered by MSAA under additive blending, which
    // showed up as faint horizontal dark seams across the dome. A smooth sphere has no
    // hard facet edges, so the fill renders as a clean, continuous force field.
    const fillGeo = new THREE.SphereGeometry(shieldRadius, 48, 32);

    // Deflector shell shader: a near-invisible bubble that only becomes visible
    // where it is edge-on (fresnel rim) or where its hex energy lattice catches
    // the light. Everything is deliberately dim because bloom amplifies additive
    // surfaces heavily - a bright body here renders as an opaque white ball.
    this.shieldBubbleMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(this.shipColorHex) },
        uBaseOpacity: { value: 0.012 },
        uOpacityScale: { value: SHIELD_OPACITY_SCALE }
      },
      vertexShader: `
        varying vec3 vNormal;
        varying vec3 vViewPosition;
        varying vec3 vLocalPosition;

        void main() {
          vNormal = normalize(normalMatrix * normal);
          // Local (model-space) position keeps the energy pattern fixed to the dome
          // itself so it never bands with the ship's on-screen vertical position.
          vLocalPosition = position;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          vViewPosition = -mvPosition.xyz;
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform vec3 uColor;
        uniform float uBaseOpacity;
        uniform float uOpacityScale;

        varying vec3 vNormal;
        varying vec3 vViewPosition;
        varying vec3 vLocalPosition;

        // Seamless triplanar cell lattice. Bright only along the cell borders, so
        // the shell reads as an energy grid rather than a filled membrane. Built
        // from the three axis planes to avoid the pole/wrap seams that a spherical
        // UV hex grid produces on a rotating dome.
        float latticeLines(vec3 p, float scale) {
          vec3 c = fract(p * scale) - 0.5;
          vec3 d = abs(c);
          float line = min(min(d.x, d.y), d.z);
          // Thin, soft-edged border
          return 1.0 - smoothstep(0.0, 0.055, line);
        }

        void main() {
          vec3 normal = normalize(vNormal);
          vec3 viewDir = normalize(vViewPosition);

          // Hard fresnel: fully transparent facing the camera, energetic at the
          // silhouette. This is what sells "force field" instead of "glass ball".
          float ndv = max(0.0, dot(normal, viewDir));
          float fresnel = pow(1.0 - ndv, 5.0);

          // Energy lattice, only lit where the surface is already turning away so
          // the front of the bubble stays clear of the ship.
          float lattice = latticeLines(vLocalPosition + vec3(0.0, uTime * 0.35, 0.0), 0.09);
          float latticeMask = lattice * pow(1.0 - ndv, 1.6);

          // Slow vertical recharge sweep travelling up the shell
          float sweep = smoothstep(0.9, 1.0, sin(vLocalPosition.y * 0.10 - uTime * 1.2));

          // The crystal plates now carry the pattern, so the inner bubble is kept
          // to a faint containment glow that fills the gaps between the shards.
          float body = uBaseOpacity;
          float rim = fresnel * 0.13;
          float grid = latticeMask * 0.035;
          float flow = sweep * (0.03 + latticeMask * 0.05);
          float finalOpacity = clamp(body + rim + grid + flow, 0.0, 0.18) * uOpacityScale;

          // Stay in the ship's accent hue; only the very tip of the rim goes hot,
          // which keeps bloom from washing the whole dome to white.
          vec3 hot = mix(uColor, vec3(0.85, 0.96, 1.0), 0.65);
          vec3 color = uColor * (0.55 + grid * 2.0);
          color = mix(color, hot, clamp(fresnel * 0.8 + sweep * 0.35, 0.0, 1.0));

          gl_FragColor = vec4(color, finalOpacity);
        }
      `,
      transparent: true,
      // Single-sided: with DoubleSide the far hemisphere was additively stacked on
      // the near one, doubling the brightness and filling the bubble in.
      side: THREE.FrontSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });

    const bubbleMesh = new THREE.Mesh(fillGeo, this.shieldBubbleMat);
    this.shieldGroup.add(bubbleMesh);

    // --- Crystal plate shell: the actual KH2 Reflect look ---
    const { plateGeo, rimGeo } = this.buildCrystalPlates(shieldRadius);

    // Concentric shells, one lit per remaining charge. They share the plate and
    // rim geometry and are simply scaled down to nest inside each other, so the
    // extra layers cost nothing but a couple of draw calls.
    for (let i = 0; i < SHIELD_MAX_LAYERS; i++) {
      const layerGroup = new THREE.Group();
      layerGroup.scale.setScalar(SHIELD_LAYER_RADIUS_FACTORS[i]);

      const plateMat = this.createShieldPlateMaterial();
      const wireMat = this.createShieldWireMaterial();
      // Offset each shell's clock so the layers shimmer out of phase rather than
      // breathing in lockstep, which would read as one thick sphere.
      plateMat.uniforms.uTime.value = i * 7.3;
      wireMat.uniforms.uTime.value = i * 7.3;

      // Plates are unsorted transparent geometry; render after the hull so the
      // ship shows through, with the shard outlines on top of the plates.
      const plates = new THREE.Mesh(plateGeo, plateMat);
      plates.renderOrder = 3;
      layerGroup.add(plates);

      const wire = new THREE.LineSegments(rimGeo, wireMat);
      wire.renderOrder = 4;
      layerGroup.add(wire);

      this.shieldGroup.add(layerGroup);
      this.shieldLayers.push({
        group: layerGroup,
        plateMat,
        wireMat,
        dim: SHIELD_LAYER_DIM[i]
      });
    }

    this.buildShieldFrontBand(rimGeo);
    this.buildShieldSparkles(shieldRadius);
  }

  /**
   * Thick outline riding the outer shell's leading face.
   *
   * Once the shell carries more charges than there are concentric layers, the
   * surplus is expressed as line thickness instead of yet another sphere. Plain
   * `THREE.LineSegments` cannot do that - WebGL ignores `linewidth` - so this
   * uses `LineSegments2`, whose quad-expanded segments take a real pixel width.
   *
   * The band reuses the full rim geometry and masks itself down to the leading
   * cap in the fragment shader with the same `uForward` term the plates use.
   * Masking in the shader rather than trimming the geometry is what keeps the
   * band pinned to the ship's +X face while the shell itself keeps spinning.
   */
  private buildShieldFrontBand(rimGeo: THREE.BufferGeometry): void {
    const rimPos = rimGeo.getAttribute('position');
    const positions = new Float32Array(rimPos.count * 3);
    positions.set(rimPos.array as ArrayLike<number>);

    const bandGeo = new LineSegmentsGeometry();
    bandGeo.setPositions(positions);

    const mat = new LineMaterial({
      color: 0xffffff,
      linewidth: SHIELD_FRONT_BAND_PX_PER_CHARGE,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    mat.opacity = SHIELD_FRONT_BAND_OPACITY * SHIELD_OPACITY_SCALE;
    mat.resolution.copy(this.viewportResolution);

    // One uniform object shared between the material and the patched program, so
    // it does not matter which of the two the renderer ends up reading.
    const uForward = { value: new THREE.Vector3(1, 0, 0) };
    mat.uniforms.uForward = uForward;
    this.shieldFrontBandForward = uForward;

    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uForward = uForward;

      shader.vertexShader = shader.vertexShader
        .replace(
          'attribute vec3 instanceStart;',
          `attribute vec3 instanceStart;
           varying vec3 vShieldDir;`
        )
        .replace(
          'float aspect = resolution.x / resolution.y;',
          `vShieldDir = normalize( ( position.y < 0.5 ) ? instanceStart : instanceEnd );
           float aspect = resolution.x / resolution.y;`
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          'uniform float linewidth;',
          `uniform float linewidth;
           uniform vec3 uForward;
           varying vec3 vShieldDir;`
        )
        .replace(
          'gl_FragColor = vec4( diffuseColor.rgb, alpha );',
          `// Leading cap only: identical thresholds to the plate shader's
           // frontCap, so the thick band lines up with the brightest shards.
           float shieldFacing = dot( normalize( vShieldDir ), normalize( uForward ) );
           float shieldFront = smoothstep( 0.30, 0.62, shieldFacing );
           if ( shieldFront <= 0.002 ) discard;
           gl_FragColor = vec4( diffuseColor.rgb, alpha * shieldFront );`
        );
    };
    // Keeps the patched program out of the cache slot of a stock LineMaterial.
    mat.customProgramCacheKey = () => 'shieldFrontBand';

    const band = new LineSegments2(bandGeo, mat);
    band.frustumCulled = false;
    band.renderOrder = 4;
    band.visible = false;
    this.shieldGroup.add(band);

    this.shieldFrontBand = band;
    this.shieldFrontBandMat = mat;
  }

  /**
   * Crystal plate shader for a single shell: frosted shards with a hot bevel, a
   * per-plate shimmer clock, and a longitudinal fade that keeps the fully
   * powered region to a narrow cap on the ship's leading face.
   */
  private createShieldPlateMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(this.shipColorHex) },
        uForm: { value: 1 },
        // Ship-forward axis expressed in shield-local space. The shield group spins
        // for shimmer, so this is refreshed every frame to keep the bright face
        // pinned to the direction of travel instead of rotating with the shell.
        uForward: { value: new THREE.Vector3(1, 0, 0) },
        uOpacityScale: { value: SHIELD_OPACITY_SCALE }
      },
      vertexShader: `
        attribute float aEdge;
        attribute float aRand;

        varying float vEdge;
        varying float vRand;
        varying vec3 vNormal;
        varying vec3 vViewPosition;
        varying vec3 vDir;

        void main() {
          vEdge = aEdge;
          vRand = aRand;
          // Model-space outward direction: lets the fragment shader know which
          // shards face the ship's forward (+X) travel direction.
          vDir = normalize(position);
          vNormal = normalize(normalMatrix * normal);
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          vViewPosition = -mvPosition.xyz;
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform vec3 uColor;
        uniform float uForm;
        uniform vec3 uForward;
        uniform float uOpacityScale;

        varying float vEdge;
        varying float vRand;
        varying vec3 vNormal;
        varying vec3 vViewPosition;
        varying vec3 vDir;

        void main() {
          vec3 normal = normalize(vNormal);
          vec3 viewDir = normalize(vViewPosition);
          float ndv = abs(dot(normal, viewDir));

          // Plates tilted away from the camera catch the light along their faces,
          // exactly like the ice shards ringing the dome in the reference.
          float sheen = pow(1.0 - ndv, 2.2);

          // Hot bevel on every shard border.
          float bevel = smoothstep(0.42, 1.0, vEdge);
          float border = smoothstep(0.86, 1.0, vEdge);

          // Each plate shimmers on its own clock so the shell crackles with light
          // instead of pulsing as one object.
          float twinkle = 0.72 + 0.28 * sin(uTime * 2.1 + vRand * 43.0);

          // Staggered materialisation: shards flash in one after another.
          float form = clamp(uForm * 1.7 - vRand * 0.7, 0.0, 1.0);
          float flashIn = smoothstep(0.0, 0.45, form);
          float igniting = (1.0 - smoothstep(0.35, 1.0, form)) * flashIn;

          // Per-plate tint: some shards lean slightly icy blue, others slightly
          // golden, but both stay close to white so the shell still reads as
          // frosted crystal rather than a coloured gel.
          float tintPick = fract(vRand * 7.31 + 0.23);
          vec3 blueTint = vec3(0.80, 0.90, 1.0);
          vec3 goldTint = vec3(1.0, 0.93, 0.74);
          vec3 plateTint = mix(blueTint, goldTint, smoothstep(0.35, 0.65, tintPick));

          // Frosted white body with a faint warm centre, cooling to the ship's
          // accent hue at the shard edges.
          vec3 warm = vec3(1.0, 0.95, 0.86);
          vec3 cool = mix(uColor, vec3(0.88, 0.97, 1.0), 0.80);
          vec3 color = mix(warm * 0.85, cool, bevel * 0.75);
          color += vec3(1.0) * border * 0.85 * twinkle;
          color += cool * sheen * 0.6;
          color += vec3(1.0, 0.98, 0.92) * igniting * 1.4;
          color *= plateTint;

          // Each plate breathes on its own clock, dipping to nearly invisible so
          // the shell constantly reveals the ship through shifting gaps.
          float phase = vRand * 61.7 + tintPick * 13.0;
          float breath = 0.5 + 0.5 * sin(uTime * 1.35 + phase);
          float faceFade = mix(0.10, 1.0, pow(breath, 1.6));

          // Longitudinal grading along the ship's travel axis. The fully powered
          // region is a narrow cap on the leading face: a spherical cap covers
          // 1/5 of the surface at cos(theta) = 0.6, so the plateau starts there
          // and everything behind it falls off continuously to a nearly
          // transparent trailing side.
          float facing = dot(vDir, uForward);
          float frontCap = smoothstep(0.30, 0.62, facing);
          float lengthwise = smoothstep(-0.90, 0.30, facing);

          faceFade = mix(faceFade, max(faceFade, 0.60), frontCap);
          faceFade *= mix(0.07, 1.0, lengthwise);

          float alpha =
            0.030 +                     // barely-there plate body, keeps the ship readable
            bevel * 0.085 +
            border * 0.22 * twinkle +
            sheen * 0.15;

          alpha *= faceFade;
          // A touch of extra presence right on the leading cap.
          alpha *= 1.0 + frontCap * 0.12;

          // Back-facing shards read as the far side of the shell: still present,
          // but dimmed so they do not double up over the ship.
          if (!gl_FrontFacing) alpha *= 0.42;

          alpha *= flashIn;
          alpha *= uOpacityScale;

          gl_FragColor = vec4(color, clamp(alpha, 0.0, 0.8));
        }
      `,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.NormalBlending
    });
  }

  /**
   * Crisp outline on every hex/pent shard - this is what makes the faceting
   * legible at small on-screen sizes. Outlines follow the same front/middle/back
   * falloff as the plates, otherwise they paint a uniform white cage over the
   * whole sphere and the back never reads as transparent.
   */
  private createShieldWireMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uOpacity: { value: SHIELD_WIRE_BASE_OPACITY * SHIELD_OPACITY_SCALE },
        uForward: { value: new THREE.Vector3(1, 0, 0) }
      },
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform float uOpacity;
        uniform vec3 uForward;
        varying vec3 vDir;

        void main() {
          float facing = dot(vDir, uForward);
          // Matches the plate shader: narrow fully powered cap, continuous falloff.
          float frontCap = smoothstep(0.30, 0.62, facing);
          float lengthwise = smoothstep(-0.90, 0.30, facing);

          // Slow travelling shimmer so the mid-band outlines breathe too.
          float breath = 0.55 + 0.45 * sin(uTime * 1.1 + vDir.y * 3.1 + vDir.z * 2.3);
          float fade = mix(breath, 1.0, frontCap) * mix(0.06, 1.0, lengthwise);

          // Icy blue away from the leading face, warm gold toward it.
          vec3 tint = mix(vec3(0.80, 0.90, 1.0), vec3(1.0, 0.95, 0.80), frontCap);

          gl_FragColor = vec4(tint, uOpacity * fade);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
  }

  /** Sparkle flares orbiting the shell, spread on a golden-angle spiral. */
  private buildShieldSparkles(shieldRadius: number): void {
    const sparkleTex = this.createSparkleTexture();
    for (let i = 0; i < 7; i++) {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: sparkleTex,
          color: 0xffffff,
          transparent: true,
          opacity: 0.6 * SHIELD_OPACITY_SCALE,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          depthTest: false
        })
      );
      // Spread them over the shell with a golden-angle spiral for even coverage.
      const t = (i + 0.5) / 7;
      const phi = Math.acos(1 - 2 * t);
      const theta = Math.PI * (1 + Math.sqrt(5)) * i;
      sprite.position.set(
        Math.sin(phi) * Math.cos(theta),
        Math.cos(phi),
        Math.sin(phi) * Math.sin(theta)
      ).multiplyScalar(shieldRadius * 1.02);
      sprite.scale.setScalar(shieldRadius * 0.5);
      sprite.renderOrder = 5;
      sprite.userData.basePos = sprite.position.clone();
      this.shieldSparkles.push(sprite);
      this.shieldGroup.add(sprite);
    }
  }

  public setHangarMode(hangar: boolean): void {
    this.isHangar = hangar;
    // In Hangar mode, hide the active shield so player inspects pure spaceship hull
    if (this.shieldGroup) {
      this.shieldGroup.visible = !hangar && this.hasShield;
    }
  }

  public setWarping(warping: boolean): void {
    this.isWarping = warping;
    if (!warping) {
      this.warpProgress = 0;
      this.warpSurge = 0;
    }
  }

  /**
   * Shape of the hyperspace lunge over the warp window.
   *
   * Three phases, all C0-continuous and starting and ending at 0 so the ship
   * leaves and rejoins its normal station without a jump:
   *  - 0.00 -> 0.42  hard acceleration out to the right edge (easeOutCubic, so
   *                  most of the distance is covered early and it reads as fast)
   *  - 0.42 -> 0.60  held at the edge at peak speed
   *  - 0.60 -> 1.00  smooth deceleration back to station (easeInOutSine)
   */
  private warpSurgeCurve(p: number): number {
    if (p <= 0) return 0;
    if (p < 0.42) {
      const t = p / 0.42;
      return 1 - Math.pow(1 - t, 3);
    }
    if (p < 0.6) return 1;
    const t = Math.min(1, (p - 0.6) / 0.4);
    return 0.5 + 0.5 * Math.cos(Math.PI * t);
  }

  /**
   * World-space radius of the Reflect shell when it is actually deployed and
   * able to intercept something, or `null` when the hull is exposed.
   *
   * The radius is read off the live `shieldGroup` scale rather than recomputed,
   * so it tracks the shell's animated size (including the easeOutBack overshoot)
   * exactly. The two-second powering-up sequence is the one exception: it is
   * purely cosmetic, so the shell defends at its resting radius throughout
   * instead of leaving the player nearly unprotected for two seconds after a
   * regen. Returns `null` in the hangar, where the shell is hidden.
   */
  public get shieldCollisionRadius(): number | null {
    if (!this.hasShield || this.isHangar) return null;
    const scale = this.isShieldPoweringUp
      ? Math.max(this.shieldGroup.scale.x, this.sizeScale * SHIELD_REST_SCALE)
      : this.shieldGroup.scale.x;
    return SHIELD_GEOMETRY_RADIUS * scale;
  }

  /**
   * Radius that incoming threats (asteroids, enemy drones) should be tested
   * against. This is the shield shell while it is up, because the shell is what
   * physically takes the impact, and the bare hull once it has broken.
   *
   * Clamped to at least the hull radius so a mid-materialisation shell can never
   * shrink the player's effective hitbox below the ship itself.
   */
  public get threatCollisionRadius(): number {
    const shieldRadius = this.shieldCollisionRadius;
    return shieldRadius === null ? this.radius : Math.max(this.radius, shieldRadius);
  }

  /**
   * Casts the shell at full strength and plays the two-second powering-up
   * sequence. Called on run/level start and whenever the power generator
   * regenerates the shield.
   */
  public triggerShieldPowerUp(): void {
    this.hasShield = true;
    this.shieldCharges = this.maxShieldCharges;
    this.startShieldPowerUp(SHIELD_POWER_UP_DURATION_SEC);
    if (!this.isHangar) {
      this.shieldGroup.visible = true;
    }
    // A freshly cast shell is always at full strength.
    this.applyShieldChargeVisuals();
  }

  /** Arms the materialisation animation over `durationSec` of wall-clock time. */
  private startShieldPowerUp(durationSec: number): void {
    this.isShieldPoweringUp = true;
    this.shieldPowerUpProgress = 0;
    this.shieldPowerUpDurationSec = Math.max(0.01, durationSec);
    this.shieldPowerUpStartMs = performance.now();
    this.shieldGroup.scale.set(0.01, 0.01, 0.01);
  }

  /**
   * Recomputes the shell's charge capacity from the current hull rating plus any
   * module bonus. Pass `refill` to also top the live charges back up (ship swap,
   * new run); otherwise the remaining charges are only clamped to the new cap.
   */
  public refreshShieldCharges(refill: boolean): void {
    this.maxShieldCharges = computeShieldCharges(this.shipModelId, this.bonusShieldCharges);
    this.shieldCharges = refill
      ? this.maxShieldCharges
      : Math.min(this.shieldCharges, this.maxShieldCharges);
    this.applyShieldChargeVisuals();
  }

  /**
   * Grants extra shield charges on top of the hull's own rating (reserved for a
   * future upgradable module). Existing charges grow with the new capacity so a
   * mid-run purchase is felt immediately.
   */
  public setBonusShieldCharges(bonus: number): void {
    const delta = Math.max(0, bonus) - this.bonusShieldCharges;
    this.bonusShieldCharges = Math.max(0, bonus);
    this.refreshShieldCharges(false);
    if (delta > 0 && this.hasShield) {
      this.shieldCharges = Math.min(this.maxShieldCharges, this.shieldCharges + delta);
      this.applyShieldChargeVisuals();
    }
  }

  /**
   * Spends one shield charge against an impact.
   *
   * Returns true when that impact destroyed the shell (no charges left), false
   * when the shell held and is still protecting the ship. Callers use the return
   * value to decide between "shield break" and "shield held" feedback.
   */
  public absorbShieldHit(): boolean {
    if (!this.hasShield) return true;

    this.shieldCharges = Math.max(0, this.shieldCharges - 1);
    if (this.shieldCharges > 0) {
      // Shell held: replay the materialisation pop so the hit reads visually,
      // and re-tint the remaining layers to show it is running on reserves.
      this.startShieldPowerUp(SHIELD_IMPACT_REPOP_DURATION_SEC);
      this.applyShieldChargeVisuals();
      return false;
    }

    this.breakShield();
    return true;
  }

  public breakShield(): void {
    this.hasShield = false;
    this.shieldCharges = 0;
    this.shieldGroup.visible = false;
  }

  /**
   * Redraws the shell for the current charge count.
   *
   * Two things communicate strength. Charges pick how many concentric shells are
   * lit - one each up to `SHIELD_MAX_LAYERS` - and every charge past that
   * thickens the leading-face band by one pixel, capped at
   * `SHIELD_FRONT_BAND_MAX_PX`. On top of that the whole shell thins out as a
   * multi-charge shield is worn down, so spending a charge always reads even
   * when the layer count has not changed.
   *
   * Everything is recomputed from the tuned base opacities each call, so repeated
   * hits never compound the dimming.
   */
  private applyShieldChargeVisuals(): void {
    const strength =
      this.maxShieldCharges <= 1 ? 1 : Math.max(1, this.shieldCharges) / this.maxShieldCharges;
    const factor = 0.5 + 0.5 * strength;

    if (this.shieldBubbleMat?.uniforms.uOpacityScale) {
      this.shieldBubbleMat.uniforms.uOpacityScale.value = SHIELD_OPACITY_SCALE * factor;
    }

    // One shell per remaining charge. A broken shell hides the whole group, so
    // the floor of 1 here only guards the moment before that happens.
    const litLayers = Math.min(SHIELD_MAX_LAYERS, Math.max(1, this.shieldCharges));
    for (let i = 0; i < this.shieldLayers.length; i++) {
      const layer = this.shieldLayers[i];
      layer.group.visible = i < litLayers;
      if (!layer.group.visible) continue;
      layer.plateMat.uniforms.uOpacityScale.value = SHIELD_OPACITY_SCALE * factor * layer.dim;
      layer.wireMat.uniforms.uOpacity.value =
        SHIELD_WIRE_BASE_OPACITY * SHIELD_OPACITY_SCALE * factor * layer.dim;
    }

    // Surplus charges thicken the leading-face band instead of adding shells.
    if (this.shieldFrontBand && this.shieldFrontBandMat) {
      const surplus = Math.max(0, this.shieldCharges - SHIELD_MAX_LAYERS);
      const widthPx = Math.min(
        SHIELD_FRONT_BAND_MAX_PX,
        surplus * SHIELD_FRONT_BAND_PX_PER_CHARGE
      );
      this.shieldFrontBand.visible = widthPx > 0;
      this.shieldFrontBandMat.linewidth = widthPx;
      this.shieldFrontBandBaseOpacity = SHIELD_FRONT_BAND_OPACITY * SHIELD_OPACITY_SCALE * factor;
    }
  }

  /**
   * Canvas size in CSS pixels, forwarded by the engine on creation and on every
   * resize. The leading-face band's thickness is specified in pixels, which
   * LineMaterial can only convert to clip space if it knows the viewport.
   */
  public setViewportResolution(width: number, height: number): void {
    this.viewportResolution.set(Math.max(1, width), Math.max(1, height));
    this.shieldFrontBandMat?.resolution.copy(this.viewportResolution);
  }

  /**
   * Rebuild the shop module attachments for the given tiers. Everything hangs
   * off `moduleGroup`, whose scale tracks the hull, so the mount points below
   * are in hull-local units and each ship carries the kit at its own size.
   */
  public setModuleLevels(powerGenLevel: number, autoCannonLevel: number, zoomScannerLevel = 0): void {
    this.powerGenLevel = powerGenLevel;
    this.autoCannonLevel = autoCannonLevel;
    this.zoomScannerLevel = zoomScannerLevel;

    // Clear existing module meshes
    while (this.moduleGroup.children.length > 0) {
      const child = this.moduleGroup.children[0];
      this.moduleGroup.remove(child);
      child.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        if (mesh.material) {
          const mat = mesh.material as THREE.Material | THREE.Material[];
          if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
          else mat.dispose();
        }
      });
    }
    this.cannonGroup = null;
    this.cannonYoke = null;
    this.cannonBarrels = [];
    this.cannonLight = null;
    this.cannonHeatMat = null;
    this.powerGenGroup = null;
    this.powerGenLight = null;
    this.powerGenRings = [];
    this.powerGenCoreMat = null;
    this.scannerGroup = null;
    this.scannerDish = null;
    this.scannerSweep = null;

    if (autoCannonLevel > 0) this.buildAutoCannon(autoCannonLevel);
    if (powerGenLevel > 0) this.buildPowerGen(powerGenLevel);
    if (zoomScannerLevel > 0) this.buildScanner(zoomScannerLevel);
  }

  /** Hull-local mount points for the module hardware on the active ship. */
  private get moduleMounts(): ModuleMounts {
    return MODULE_MOUNTS[this.shipModelId] || MODULE_MOUNTS.dart;
  }

  /**
   * Auto Cannon: a real dorsal turret. Bolted ring base, a yoke that elevates
   * to track its target, one to three barrels with vented muzzle brakes, an
   * ammo drum and a stack of radiator plates that counts off the tier.
   */
  private buildAutoCannon(tier: number): void {
    this.cannonGroup = new THREE.Group();
    const mount = this.moduleMounts.turret;
    this.cannonGroup.position.copy(mount);

    const metalMat = new THREE.MeshStandardMaterial({
      color: 0x1a2438,
      metalness: 0.92,
      roughness: 0.28
    });
    const darkMat = new THREE.MeshStandardMaterial({
      color: 0x0a1120,
      metalness: 0.65,
      roughness: 0.6
    });
    // Charge/heat glow. Emissive is driven per frame from the reload progress.
    const heatMat = new THREE.MeshStandardMaterial({
      color: 0x2a1206,
      metalness: 0.4,
      roughness: 0.5,
      emissive: 0xff7a1e,
      emissiveIntensity: 0.2
    });
    this.cannonHeatMat = heatMat;
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0x7dd3fc,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });

    // --- Bolted ring base ---
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(3.3, 3.9, 1.5, 20), darkMat);
    this.cannonGroup.add(ring);

    const boltGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.5, 6);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const bolt = new THREE.Mesh(boltGeo, metalMat);
      bolt.position.set(Math.cos(a) * 3.1, 0.9, Math.sin(a) * 3.1);
      this.cannonGroup.add(bolt);
    }

    // --- Elevating yoke: everything above the ring pitches with the aim ---
    const yoke = new THREE.Group();
    yoke.position.y = 1.5;
    this.cannonYoke = yoke;
    this.cannonGroup.add(yoke);

    const cradle = new THREE.Mesh(new THREE.BoxGeometry(4.2, 2.4, 3.0), metalMat);
    cradle.position.set(-0.2, 1.1, 0);
    yoke.add(cradle);

    // Cheek plates the barrels ride between
    const cheekGeo = new THREE.BoxGeometry(3.4, 2.8, 0.5);
    for (const side of [1, -1]) {
      const cheek = new THREE.Mesh(cheekGeo, darkMat);
      cheek.position.set(0.4, 1.4, side * 1.7);
      yoke.add(cheek);
    }

    // Ammo drum with a glowing charge band
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 2.6, 14), darkMat);
    drum.geometry.rotateX(Math.PI / 2);
    drum.position.set(-2.2, 1.3, 0);
    yoke.add(drum);

    const band = new THREE.Mesh(new THREE.TorusGeometry(1.55, 0.22, 8, 18), heatMat);
    band.position.set(-2.2, 1.3, 0);
    yoke.add(band);

    // Radiator plates: one per installed tier, so the tier is readable in-world
    const plateGeo = new THREE.BoxGeometry(2.6, 0.22, 2.2);
    for (let i = 0; i < tier; i++) {
      const plate = new THREE.Mesh(plateGeo, i === tier - 1 ? heatMat : metalMat);
      plate.position.set(-1.4, 2.5 + i * 0.42, 0);
      plate.rotation.z = -0.12;
      yoke.add(plate);
    }

    // --- Barrels: 1 up to tier 2, 2 up to tier 4, 3 at max ---
    const barrelCount = tier >= 5 ? 3 : tier >= 3 ? 2 : 1;
    const barrelLen = 11 + tier * 1.1;
    const barrelGeo = new THREE.CylinderGeometry(0.62, 0.78, barrelLen, 12);
    barrelGeo.rotateZ(-Math.PI / 2);
    const brakeGeo = new THREE.CylinderGeometry(1.05, 0.9, 2.0, 12);
    brakeGeo.rotateZ(-Math.PI / 2);
    const ventGeo = new THREE.BoxGeometry(1.4, 0.18, 2.3);
    const muzzleGeo = new THREE.SphereGeometry(0.85, 12, 10);

    // Barrels sit side by side, or stacked in a triangle at max tier
    const layout: Array<[number, number]> =
      barrelCount === 1 ? [[1.4, 0]] : barrelCount === 2 ? [[1.4, 0.95], [1.4, -0.95]] : [[1.4, 1.05], [1.4, -1.05], [2.3, 0]];

    for (const [by, bz] of layout) {
      const barrel = new THREE.Mesh(barrelGeo, metalMat);
      barrel.position.set(barrelLen / 2 + 1.2, by, bz);
      // Rest position, so the recoil animation has something to spring back to.
      barrel.userData.restX = barrel.position.x;
      yoke.add(barrel);
      this.cannonBarrels.push(barrel);

      const brake = new THREE.Mesh(brakeGeo, darkMat);
      brake.position.set(barrelLen + 1.6, by, bz);
      yoke.add(brake);

      for (const vs of [1, -1]) {
        const vent = new THREE.Mesh(ventGeo, darkMat);
        vent.position.set(barrelLen + 1.6, by + vs * 0.85, bz);
        yoke.add(vent);
      }

      const muzzle = new THREE.Mesh(muzzleGeo, glowMat);
      muzzle.position.set(barrelLen + 3.0, by, bz);
      yoke.add(muzzle);
    }

    this.cannonLight = new THREE.PointLight(0x38bdf8, 0.8, 40);
    this.cannonLight.position.set(barrelLen + 3.0, 1.4, 0);
    yoke.add(this.cannonLight);

    this.moduleGroup.add(this.cannonGroup);
  }

  /**
   * Power Generator: paired reactor pods on pylons, each with a lit core rod
   * seen through a cage, counter-rotating gyro rings and one cooling fin per
   * tier. The rings spin faster and the core burns brighter while the shield is
   * actually regenerating.
   */
  private buildPowerGen(tier: number): void {
    this.powerGenGroup = new THREE.Group();
    const mount = this.moduleMounts.reactor;

    const shellMat = new THREE.MeshStandardMaterial({
      color: 0x07231a,
      metalness: 0.85,
      roughness: 0.35
    });
    const finMat = new THREE.MeshStandardMaterial({
      color: 0x0b3a2a,
      metalness: 0.7,
      roughness: 0.5,
      emissive: 0x14532d,
      emissiveIntensity: 0.6
    });
    const coreMat = new THREE.MeshBasicMaterial({
      color: 0x4ade80,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    this.powerGenCoreMat = coreMat;
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x22c55e,
      transparent: true,
      opacity: 0.7,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });

    const shellGeo = new THREE.CapsuleGeometry(1.7, 4.4, 6, 14);
    shellGeo.rotateZ(Math.PI / 2);
    const coreGeo = new THREE.CapsuleGeometry(0.85, 5.2, 4, 10);
    coreGeo.rotateZ(Math.PI / 2);
    const cageGeo = new THREE.BoxGeometry(6.2, 0.28, 0.28);
    const pylonGeo = new THREE.BoxGeometry(1.1, 3.2, 0.8);
    const finGeo = new THREE.BoxGeometry(0.5, 2.6, 3.4);
    const gyroGeo = new THREE.TorusGeometry(2.5, 0.22, 8, 26);

    for (const side of [1, -1]) {
      const pod = new THREE.Group();
      pod.position.set(mount.x, mount.y, side * mount.z);
      this.powerGenGroup.add(pod);

      // Pylon back up to the hull
      const pylon = new THREE.Mesh(pylonGeo, shellMat);
      pylon.position.set(0.4, 2.0, side * -0.6);
      pod.add(pylon);

      // Lit core rod inside an open cage, so the glow reads through the shell
      const core = new THREE.Mesh(coreGeo, coreMat);
      pod.add(core);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        const bar = new THREE.Mesh(cageGeo, shellMat);
        bar.position.set(0, Math.sin(a) * 1.25, Math.cos(a) * 1.25);
        pod.add(bar);
      }

      // End shells cap the pod fore and aft
      for (const ex of [-2.6, 2.6]) {
        const shell = new THREE.Mesh(shellGeo, shellMat);
        shell.scale.set(0.42, 1, 1);
        shell.position.set(ex, 0, 0);
        pod.add(shell);
      }

      // Cooling fins: one per tier, marching down the pod
      for (let i = 0; i < tier; i++) {
        const fin = new THREE.Mesh(finGeo, finMat);
        fin.position.set(1.9 - i * 1.0, -0.6, 0);
        fin.rotation.x = 0.2;
        pod.add(fin);
      }

      // Counter-rotating gyro rings, tilted off-axis so the spin is visible
      for (const dir of [1, -1]) {
        const gyro = new THREE.Mesh(gyroGeo, ringMat);
        gyro.rotation.y = Math.PI / 2;
        gyro.rotation.x = dir * 0.42;
        gyro.userData.spinDir = dir * side;
        pod.add(gyro);
        this.powerGenRings.push(gyro);
      }
    }

    this.powerGenLight = new THREE.PointLight(0x22c55e, 0.6 + tier * 0.25, 55);
    this.powerGenLight.position.set(mount.x, mount.y, 0);
    this.powerGenGroup.add(this.powerGenLight);

    this.moduleGroup.add(this.powerGenGroup);
  }

  /**
   * Scanner Array: a masted radar dish that sweeps continuously, with a lit
   * sweep blade inside the bowl and one whip antenna per tier. Previously this
   * module had no hardware on the hull at all.
   */
  private buildScanner(tier: number): void {
    this.scannerGroup = new THREE.Group();
    const mount = this.moduleMounts.scanner;
    this.scannerGroup.position.copy(mount);

    const strutMat = new THREE.MeshStandardMaterial({
      color: 0x141a2e,
      metalness: 0.85,
      roughness: 0.4
    });
    // Violet, so the scanner never reads as the green reactor or blue cannon.
    const dishMat = new THREE.MeshStandardMaterial({
      color: 0x1e1b4b,
      metalness: 0.6,
      roughness: 0.35,
      emissive: 0x7c3aed,
      emissiveIntensity: 0.35,
      side: THREE.DoubleSide
    });
    const sweepMat = new THREE.MeshBasicMaterial({
      color: 0xc4b5fd,
      transparent: true,
      opacity: 0.75,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });

    // Mast and turntable
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.8, 3.0, 12), strutMat);
    mast.position.y = 1.5;
    this.scannerGroup.add(mast);

    const turntable = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.7, 0.7, 16), strutMat);
    turntable.position.y = 3.2;
    this.scannerGroup.add(turntable);

    // The whole head rotates: bowl, feed horn and sweep blade together
    const head = new THREE.Group();
    head.position.y = 3.6;
    this.scannerDish = head;
    this.scannerGroup.add(head);

    const bowlGeo = new THREE.SphereGeometry(2.9, 22, 12, 0, Math.PI * 2, 0, Math.PI / 2.5);
    bowlGeo.rotateX(-Math.PI / 2.6); // tilt the aperture up and forward
    const bowl = new THREE.Mesh(bowlGeo, dishMat);
    head.add(bowl);

    // Feed horn on a tripod at the focus
    const horn = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.5, 10), strutMat);
    horn.position.set(1.1, 1.5, 0);
    horn.rotation.z = Math.PI + 0.9;
    head.add(horn);

    // Lit sweep blade inside the bowl
    const sweep = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.12, 0.5), sweepMat);
    sweep.position.set(0.5, 0.9, 0);
    sweep.rotation.z = 0.5;
    this.scannerSweep = sweep;
    head.add(sweep);

    // Whip antennas around the base, one per tier
    const whipGeo = new THREE.CylinderGeometry(0.12, 0.16, 3.4, 6);
    for (let i = 0; i < tier; i++) {
      const a = (i / Math.max(1, tier)) * Math.PI * 2;
      const whip = new THREE.Mesh(whipGeo, strutMat);
      whip.position.set(Math.cos(a) * 1.5, 2.2, Math.sin(a) * 1.5);
      whip.rotation.x = Math.sin(a) * 0.3;
      whip.rotation.z = -Math.cos(a) * 0.3;
      this.scannerGroup.add(whip);
    }

    this.moduleGroup.add(this.scannerGroup);
  }

  /** Elevation the turret should track, in radians, clamped to a sane arc. */
  public aimCannon(elevationRad: number): void {
    this.cannonAim = THREE.MathUtils.clamp(elevationRad, -0.75, 0.75);
  }

  /** Reload progress 0..1, used to heat up the turret's charge band. */
  public setCannonCharge(progress: number): void {
    this.cannonCharge = THREE.MathUtils.clamp(progress, 0, 1);
  }

  /** Visual kick when the auto cannon fires a bolt. */
  public triggerCannonFire(): void {
    this.cannonRecoil = 1;
    if (this.cannonLight) this.cannonLight.intensity = 3.5;
  }

  public setShipModel(modelId: ShipModelId): void {
    this.shipModelId = modelId;
    const config = SHIPS_CONFIG[modelId] || SHIPS_CONFIG.dart;

    this.sizeScale = config.sizeScale;
    this.speed = config.speed;
    this.smoothness = config.smoothness;
    this.radius = HULL_BASE_RADIUS * config.sizeScale;

    // Shield charges are a hull stat plus any module bonus. Swapping hulls only
    // happens in the hangar/menu, so re-arming the shell to full is safe here.
    this.refreshShieldCharges(true);

    // Scale shield proportionally to ship size
    const shieldScale = this.sizeScale * 1.15;
    this.shieldGroup.scale.set(shieldScale, shieldScale, shieldScale);

    // Clear previous model meshes. The engine point light is kept: it is created
    // once and only re-added when missing, so sweeping it out here would leave
    // every hull after the first swap without its exhaust glow.
    for (const child of [...this.shipModelGroup.children]) {
      if (child === this.engineLight) continue;
      this.shipModelGroup.remove(child);
    }
    this.flameMeshes = [];

    this.buildShipMesh(modelId);
    this.upgradeCockpitGlass();
    this.addHullGreebles();
    this.shipModelGroup.scale.set(this.sizeScale, this.sizeScale, this.sizeScale);
    this.setShipColor(this.shipColorHex);
  }

  /**
   * Turns the flat emissive canopy of every model into layered glass: a
   * physically-shaded transparent shell with a fresnel sheen so it catches the
   * directional light and reads as a real cockpit rather than a lit blob.
   */
  private upgradeCockpitGlass(): void {
    if (!this.cockpitMesh) return;
    const old = this.cockpitMesh.material as THREE.MeshStandardMaterial;
    const glass = new THREE.MeshPhysicalMaterial({
      color: 0xcfeeff,
      emissive: new THREE.Color(this.shipColorHex),
      emissiveIntensity: 0.55,
      metalness: 0.1,
      roughness: 0.06,
      clearcoat: 1.0,
      clearcoatRoughness: 0.05,
      transparent: true,
      opacity: 0.62,
      depthWrite: false
    });
    this.cockpitMesh.material = glass;
    // Remembered so the warp glow damping can restore the correct rest value.
    this.cockpitMesh.userData.baseEmissive = 0.55;
    old.dispose();

    // Thin canopy frame traced from the canopy silhouette
    const frameGeo = new THREE.EdgesGeometry(this.cockpitMesh.geometry, 18);
    const frame = new THREE.LineSegments(
      frameGeo,
      new THREE.LineBasicMaterial({
        color: 0x9fe8ff,
        transparent: true,
        opacity: 0.45,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
    );
    this.cockpitMesh.add(frame);
    this.canopyFrameMat = frame.material as THREE.LineBasicMaterial;
  }

  /**
   * Adds model-agnostic surface detail derived from the hull's own bounding box:
   * side intakes, a dorsal spine fin and additive navigation lights. Keeps every
   * ship silhouette intact while making the models read as built hardware.
   */
  private addHullGreebles(): void {
    if (!this.bodyMesh) return;
    // Hulls that model their own intakes/fins/lights opt out of the generic pass,
    // otherwise the box-derived greebles punch through the bespoke silhouette.
    if (this.customGreebles) return;
    this.bodyMesh.geometry.computeBoundingBox();
    const bb = this.bodyMesh.geometry.boundingBox;
    if (!bb) return;

    const len = Math.max(bb.max.x - bb.min.x, 8);
    const halfH = Math.max((bb.max.y - bb.min.y) / 2, 2);
    const halfD = Math.max((bb.max.z - bb.min.z) / 2, 2);

    if (!this.greebleGeo) this.greebleGeo = new THREE.BoxGeometry(1, 1, 1);
    // The fin is proportional to the current hull, so rebuild it per model swap
    if (this.finGeo) {
      this.finGeo.dispose();
      this.finGeo = null;
    }
    {
      const finShape = new THREE.Shape();
      finShape.moveTo(0, 0);
      finShape.lineTo(-len * 0.28, 0);
      finShape.lineTo(-len * 0.18, halfH * 0.85);
      finShape.closePath();
      this.finGeo = new THREE.ExtrudeGeometry(finShape, { depth: 0.8, bevelEnabled: false });
      this.finGeo.rotateY(Math.PI / 2);
    }
    if (!this.navLightGeo) this.navLightGeo = new THREE.SphereGeometry(0.9, 10, 10);

    // Paired side intakes just behind the mid-point
    for (const side of [1, -1]) {
      const intake = new THREE.Mesh(this.greebleGeo, this.wingMat);
      intake.scale.set(len * 0.22, halfH * 0.5, halfD * 0.35);
      intake.position.set(-len * 0.12, -halfH * 0.25, side * halfD * 0.95);
      this.shipModelGroup.add(intake);
    }

    // Dorsal spine fin
    const fin = new THREE.Mesh(this.finGeo, this.wingMat);
    fin.position.set(-len * 0.05, halfH * 0.75, 0);
    this.shipModelGroup.add(fin);

    // Navigation lights: wingtip pair + tail beacon
    this.addNavLights([
      new THREE.Vector3(len * 0.18, 0, halfD * 1.05),
      new THREE.Vector3(len * 0.18, 0, -halfD * 1.05),
      new THREE.Vector3(-len * 0.45, halfH * 0.6, 0)
    ]);
  }

  /**
   * Drops additive beacon blips at the given hull-local points. One shared
   * material is reused for every model so the per-frame opacity pulse in
   * `updateFlames` keeps driving them after a hull swap.
   */
  private addNavLights(points: THREE.Vector3[], scale = 1): void {
    if (!this.navLightGeo) this.navLightGeo = new THREE.SphereGeometry(0.9, 10, 10);
    if (!this.navLightMat) {
      this.navLightMat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      });
    }
    for (const p of points) {
      const light = new THREE.Mesh(this.navLightGeo, this.navLightMat);
      light.position.copy(p);
      light.scale.setScalar(scale);
      this.shipModelGroup.add(light);
    }
  }

  /** Additive accent outline traced from a geometry's sharp edges. */
  private addAccentEdges(geo: THREE.BufferGeometry, pos: THREE.Vector3, threshold = 30): THREE.LineSegments {
    const lines = new THREE.LineSegments(new THREE.EdgesGeometry(geo, threshold), this.edgeMat);
    lines.position.copy(pos);
    this.shipModelGroup.add(lines);
    return lines;
  }

  /**
   * Bright accent ring used for nozzle throats and warp coils. Shares the
   * accent-tinted `glowMat`, so it follows the paint job.
   */
  private addGlowRing(radius: number, tube: number, pos: THREE.Vector3, segments = 24): THREE.Mesh {
    const geo = new THREE.TorusGeometry(radius, tube, 8, segments);
    geo.rotateY(Math.PI / 2);
    const ring = new THREE.Mesh(geo, this.glowMat!);
    ring.position.copy(pos);
    ring.renderOrder = 1;
    this.shipModelGroup.add(ring);
    return ring;
  }

  /**
   * One layer of the exhaust plume. `intensity` scales the layer's opacity
   * (the inner core is pushed brighter) and `wobble` how much the geometry
   * deforms (the core stays steadier than the outer envelope).
   */
  private createFlameMaterial(intensity: number, wobble: number): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uAccent: { value: new THREE.Color(this.shipColorHex) },
        uThrust: { value: 0.35 },
        uWarp: { value: 0 },
        uCore: { value: intensity },
        uWobble: { value: wobble }
      },
      vertexShader: FLAME_VERTEX_GLSL,
      fragmentShader: FLAME_FRAGMENT_GLSL,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
  }

  /**
   * Adds a thruster at `(x, y, z)` as two nested plumes: a wide turbulent
   * envelope and a short white-hot core. Both are registered in `flameMeshes`
   * so the existing per-frame pulse scaling drives them together.
   */
  private addThruster(x: number, y: number, z: number, radius: number, length: number): void {
    const seed = this.flameMeshes.length * 1.37 + 0.21;

    const layers: Array<[THREE.BufferGeometry, THREE.ShaderMaterial, number]> = [
      [makeFlameGeometry(radius, length, seed), this.flameMat, length * 0.42],
      [makeFlameGeometry(radius * 0.55, length * 0.62, seed + 4.7), this.flameCoreMat, length * 0.26]
    ];

    for (const [geo, mat, offset] of layers) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x - offset, y, z);
      mesh.renderOrder = 2;
      // Nozzle anchor, so the plume can be stretched backward without detaching.
      mesh.userData.nozzleX = x;
      mesh.userData.offset = offset;
      this.flameMeshes.push(mesh);
      this.shipModelGroup.add(mesh);
    }
  }

  private buildShipMesh(modelId: ShipModelId): void {
    this.customGreebles = false;
    this.trimMat?.dispose();
    this.trimMat = null;
    this.glowMat?.dispose();
    this.glowMat = null;
    this.hullRimColor = new THREE.Color(this.shipColorHex).multiplyScalar(0.45);

    this.bodyMat = new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      roughness: 0.28,
      metalness: 0.92,
      emissive: this.shipColorHex,
      emissiveIntensity: 0.35
    });
    applyHullShader(this.bodyMat, this.hullRimColor);

    this.edgeMat = new THREE.LineBasicMaterial({
      color: this.shipColorHex,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });

    this.wingMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      metalness: 0.88,
      roughness: 0.32
    });
    applyHullShader(this.wingMat, this.hullRimColor);

    // Darker matte plating, so detail parts read as bolted-on hardware rather
    // than more of the same hull.
    const trimMat = new THREE.MeshStandardMaterial({
      color: 0x0b1220,
      metalness: 0.7,
      roughness: 0.55
    });
    applyHullShader(trimMat, this.hullRimColor);
    this.trimMat = trimMat;

    // Accent-tinted additive glow for nozzle throats, warp coils, solar cells.
    const glowMat = new THREE.MeshBasicMaterial({
      color: this.shipColorHex,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    this.glowMat = glowMat;

    this.flameMat = this.createFlameMaterial(1.0, 1.0);
    this.flameCoreMat = this.createFlameMaterial(1.35, 0.45);

    if (modelId === 'viper') {
      // ---------------------------------------------------------------------
      // 'viper' — Nebula Viper. Twin-boom micro interceptor.
      //
      // A slim centre pod slung between two long engine booms, tied together by
      // a forward-swept wing and an inward-canted V-tail. Everything is lean and
      // spindly to sell the highest reactivity rating in the fleet. Drawn large
      // in local units because the hull renders at 0.70x.
      // ---------------------------------------------------------------------
      this.customGreebles = true;

      // --- Centre pod ---
      const bodyGeo = makeRevolvedHull(
        [
          [0.0, -13.0], [2.6, -12.6], [3.8, -10.0], [4.6, -4.0], [4.8, 1.0],
          [4.3, 6.0], [3.2, 10.5], [1.6, 14.0], [0.0, 16.0]
        ],
        0.82,
        1.0,
        22
      );
      this.bodyMesh = new THREE.Mesh(bodyGeo, this.bodyMat);
      this.shipModelGroup.add(this.bodyMesh);

      // --- Forward-swept wing bridging pod to booms ---
      const wingGeo = makePlanform(
        [[7.0, 1.5], [10.5, 5.0], [12.5, 9.6], [10.0, 11.2], [-2.0, 9.0], [-6.0, 1.5]],
        1.1,
        0.4
      );
      this.wingMesh = new THREE.Mesh(wingGeo, this.wingMat);
      this.wingMesh.position.set(0, -0.6, 0);
      this.shipModelGroup.add(this.wingMesh);
      this.addAccentEdges(wingGeo, this.wingMesh.position);

      // --- Twin booms: engine aft, sensor spike forward ---
      const boomGeo = new THREE.CylinderGeometry(1.9, 2.3, 26, 14);
      boomGeo.rotateZ(-Math.PI / 2);
      const spikeGeo = new THREE.ConeGeometry(1.9, 10, 14);
      spikeGeo.rotateZ(-Math.PI / 2);
      const boomRingGeo = new THREE.TorusGeometry(2.1, 0.4, 8, 18);
      boomRingGeo.rotateY(Math.PI / 2);
      // V-tail: fins on the boom tails, canted in toward the centreline
      const tailFinGeo = makeFin([[-4.2, 0], [3.0, 0], [0.6, 8.4], [-2.2, 8.4]], 0.7);

      for (const side of [1, -1]) {
        const boom = new THREE.Mesh(boomGeo, this.wingMat);
        boom.position.set(-1.0, 0, side * 8.6);
        this.shipModelGroup.add(boom);

        const spike = new THREE.Mesh(spikeGeo, trimMat);
        spike.position.set(17.0, 0, side * 8.6);
        this.shipModelGroup.add(spike);

        const collar = new THREE.Mesh(boomRingGeo, trimMat);
        collar.position.set(9.5, 0, side * 8.6);
        this.shipModelGroup.add(collar);

        this.addGlowRing(2.0, 0.28, new THREE.Vector3(-13.6, 0, side * 8.6), 18);

        const tail = new THREE.Mesh(tailFinGeo, trimMat);
        tail.position.set(-10.5, 1.4, side * 8.6);
        tail.rotation.x = -side * 0.46;
        this.shipModelGroup.add(tail);
      }

      // --- Bubble canopy, set well forward on the slim pod ---
      const cockpitGeo = new THREE.SphereGeometry(2.7, 28, 20);
      cockpitGeo.scale(1.75, 0.85, 1.0);
      const cockpitMat = new THREE.MeshStandardMaterial({
        color: 0xe0f2fe,
        emissive: this.shipColorHex,
        emissiveIntensity: 0.9,
        transparent: true,
        opacity: 0.92
      });
      this.cockpitMesh = new THREE.Mesh(cockpitGeo, cockpitMat);
      this.cockpitMesh.position.set(6.0, 3.0, 0);
      this.shipModelGroup.add(this.cockpitMesh);

      // Short dorsal blade behind the canopy
      const combGeo = makeFin([[0.0, 0.0], [-9.0, 0.0], [-7.5, 4.2], [-2.0, 3.4]], 0.7);
      const comb = new THREE.Mesh(combGeo, trimMat);
      comb.position.set(-1.0, 2.6, 0);
      this.shipModelGroup.add(comb);

      // Ventral strake keeps the belly from reading empty
      const strakeGeo = makeFin([[6.0, 0.0], [-8.0, 0.0], [-6.5, -3.0], [3.0, -2.2]], 0.8);
      const strake = new THREE.Mesh(strakeGeo, trimMat);
      strake.position.set(0, -2.8, 0);
      this.shipModelGroup.add(strake);

      this.addNavLights([
        new THREE.Vector3(11.4, -0.6, 10.9),
        new THREE.Vector3(11.4, -0.6, -10.9)
      ]);
      this.addNavLights([new THREE.Vector3(22.4, 0, 8.6), new THREE.Vector3(22.4, 0, -8.6)], 0.55);

      // Boom-mounted micro thrusters
      this.addThruster(-14.5, 0, 8.6, 2.3, 15);
      this.addThruster(-14.5, 0, -8.6, 2.3, 15);
    } else if (modelId === 'titan') {
      // ---------------------------------------------------------------------
      // 'titan' — Titan Dreadnought. Layered armour, not a box.
      //
      // A prismatic citadel hull with a knife prow, spaced armour belt, bolted
      // deck plates, gun sponsons either side and a stepped bridge tower set
      // aft. Reads slow and heavy, which is what its stat line promises.
      // Drawn tight in local units because the hull renders at 1.25x.
      // ---------------------------------------------------------------------
      this.customGreebles = true;

      // --- Citadel hull: plan view extruded into a full-depth prism ---
      const hullPlan: Array<[number, number]> = [
        [17.0, 2.2], [11.0, 7.0], [4.0, 9.5], [-11.0, 9.5], [-15.0, 6.0], [-15.0, 1.5]
      ];
      const bodyGeo = makePlanform(hullPlan, 9.0, 0.7);
      this.bodyMesh = new THREE.Mesh(bodyGeo, this.bodyMat);
      this.shipModelGroup.add(this.bodyMesh);
      this.addAccentEdges(bodyGeo, new THREE.Vector3(0, 0, 0));

      // --- Spaced armour belt standing proud of the waist ---
      const beltGeo = makePlanform(
        [[17.8, 2.6], [11.2, 8.3], [4.0, 10.9], [-11.2, 10.9], [-15.8, 6.6], [-15.8, 1.8]],
        3.0,
        0.5
      );
      this.wingMesh = new THREE.Mesh(beltGeo, trimMat);
      this.wingMesh.position.set(0, -0.8, 0);
      this.shipModelGroup.add(this.wingMesh);

      // --- Bolted deck and belly plates ---
      const deckPlateGeo = makePlanform(
        [[13.0, 1.6], [8.0, 5.4], [3.0, 7.2], [-10.0, 7.2], [-13.0, 4.4], [-13.0, 1.2]],
        1.8,
        0.4
      );
      for (const [py, mat] of [
        [5.0, trimMat],
        [-5.0, trimMat]
      ] as Array<[number, THREE.MeshStandardMaterial]>) {
        const plate = new THREE.Mesh(deckPlateGeo, mat);
        plate.position.set(0, py, 0);
        this.shipModelGroup.add(plate);
      }

      // --- Knife prow: a vertical cutwater plus two shoulder cutters ---
      const prowGeo = makeFin([[6.0, -5.2], [20.0, -1.3], [20.0, 1.3], [6.0, 5.2]], 5.2, 0.4);
      const prow = new THREE.Mesh(prowGeo, trimMat);
      this.shipModelGroup.add(prow);

      const cutterGeo = makeFin([[4.0, -3.6], [13.5, -0.9], [13.5, 0.9], [4.0, 3.6]], 2.4);
      for (const side of [1, -1]) {
        const cutter = new THREE.Mesh(cutterGeo, trimMat);
        cutter.position.set(0, 0, side * 6.4);
        this.shipModelGroup.add(cutter);
      }

      // --- Gun sponsons with forward-laid barrels ---
      const sponsonGeo = new THREE.BoxGeometry(15, 4.6, 4.2);
      const barrelGeo = new THREE.CylinderGeometry(1.1, 1.3, 10, 12);
      barrelGeo.rotateZ(-Math.PI / 2);
      for (const side of [1, -1]) {
        const sponson = new THREE.Mesh(sponsonGeo, trimMat);
        sponson.position.set(1.5, -1.2, side * 10.6);
        this.shipModelGroup.add(sponson);

        const barrel = new THREE.Mesh(barrelGeo, this.wingMat);
        barrel.position.set(13.0, -1.2, side * 10.6);
        this.shipModelGroup.add(barrel);
        this.addGlowRing(1.2, 0.3, new THREE.Vector3(18.2, -1.2, side * 10.6), 14);
      }

      // --- Side ribs, so the flanks are not one flat wall ---
      const ribGeo = new THREE.BoxGeometry(1.6, 8.4, 2.2);
      for (const side of [1, -1]) {
        for (const rx of [8.0, 1.0, -6.0, -12.0]) {
          const rib = new THREE.Mesh(ribGeo, trimMat);
          rib.position.set(rx, 0, side * 9.9);
          this.shipModelGroup.add(rib);
        }
      }

      // --- Stepped bridge tower, set aft to leave the forward deck clear ---
      const bridge = new THREE.Mesh(new THREE.BoxGeometry(10, 4.6, 9), this.wingMat);
      bridge.position.set(-8.5, 6.6, 0);
      this.shipModelGroup.add(bridge);

      const conning = new THREE.Mesh(new THREE.BoxGeometry(6.4, 3.0, 6.0), trimMat);
      conning.position.set(-10.0, 10.2, 0);
      this.shipModelGroup.add(conning);

      const mastGeo = makeFin([[-1.2, 0.0], [1.2, 0.0], [0.5, 6.0], [-0.5, 6.0]], 1.0);
      const mast = new THREE.Mesh(mastGeo, trimMat);
      mast.position.set(-12.0, 11.5, 0);
      this.shipModelGroup.add(mast);

      // --- Armoured bridge slit ---
      const cockpitGeo = new THREE.BoxGeometry(5.0, 2.0, 7.2);
      const cockpitMat = new THREE.MeshStandardMaterial({
        color: 0xe0f2fe,
        emissive: this.shipColorHex,
        emissiveIntensity: 0.8,
        transparent: true,
        opacity: 0.9
      });
      this.cockpitMesh = new THREE.Mesh(cockpitGeo, cockpitMat);
      this.cockpitMesh.position.set(-5.4, 8.0, 0);
      this.shipModelGroup.add(this.cockpitMesh);

      // --- Engine block: one heavy centre nozzle plus two outboard ---
      const blockGeo = new THREE.BoxGeometry(5.0, 8.4, 15.5);
      const block = new THREE.Mesh(blockGeo, this.wingMat);
      block.position.set(-17.0, 0, 0);
      this.shipModelGroup.add(block);

      for (const [nx, ny, nz, nr] of [
        [-19.5, 0, 0, 4.2],
        [-19.0, 2.6, 6.4, 3.0],
        [-19.0, 2.6, -6.4, 3.0]
      ]) {
        const housingGeo = new THREE.CylinderGeometry(nr + 0.5, nr + 0.9, 4.0, 16);
        housingGeo.rotateZ(-Math.PI / 2);
        const housing = new THREE.Mesh(housingGeo, trimMat);
        housing.position.set(nx, ny, nz);
        this.shipModelGroup.add(housing);
        this.addGlowRing(nr * 0.8, 0.35, new THREE.Vector3(nx - 2.2, ny, nz), 20);
      }

      this.addNavLights([
        new THREE.Vector3(-6.0, 12.0, 0),
        new THREE.Vector3(2.0, -1.2, 12.9),
        new THREE.Vector3(2.0, -1.2, -12.9)
      ]);

      this.addThruster(-21.0, 0, 0, 4.2, 22);
      this.addThruster(-20.5, 2.6, 6.4, 3.0, 17);
      this.addThruster(-20.5, 2.6, -6.4, 3.0, 17);
    } else if (modelId === 'phantom') {
      // ---------------------------------------------------------------------
      // 'phantom' — Pulse Oracle. A sensor, not a fighter.
      //
      // An ovoid core carrying a huge lens eye up front, wrapped in two
      // spar-mounted warp coil rings with glowing windings. The eye doubles as
      // the canopy, which suits the hull's True Sight special.
      // ---------------------------------------------------------------------
      this.customGreebles = true;

      // --- Ovoid core ---
      const bodyGeo = makeRevolvedHull(
        [
          [0.0, -11.5], [3.4, -11.0], [5.2, -8.5], [6.2, -3.5], [6.5, 1.0],
          [6.1, 5.0], [5.0, 9.0], [3.2, 12.0], [0.0, 13.6]
        ],
        0.94,
        0.94,
        28
      );
      this.bodyMesh = new THREE.Mesh(bodyGeo, this.bodyMat);
      this.shipModelGroup.add(this.bodyMesh);

      // --- Twin warp coil rings on radial spars ---
      const sparGeo = new THREE.BoxGeometry(2.4, 1.1, 6.4);
      const ringSpecs: Array<[number, number, number]> = [
        // [x, ring radius, tube]
        [-0.5, 11.0, 1.15],
        [-7.5, 9.2, 0.95]
      ];
      for (const [rx, ringR, tube] of ringSpecs) {
        const ringGeo = new THREE.TorusGeometry(ringR, tube, 12, 40);
        ringGeo.rotateY(Math.PI / 2);
        const ring = new THREE.Mesh(ringGeo, trimMat);
        ring.position.set(rx, 0, 0);
        this.shipModelGroup.add(ring);

        // Glowing winding sunk just inside the coil
        this.addGlowRing(ringR - tube * 0.55, 0.3, new THREE.Vector3(rx, 0, 0), 40);

        // Four spars out to the ring at the diagonals
        const hubR = 5.6;
        for (const phi of [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4]) {
          const spar = new THREE.Mesh(sparGeo, this.wingMat);
          const mid = (hubR + ringR) / 2;
          spar.position.set(rx, mid * Math.sin(phi), mid * Math.cos(phi));
          spar.rotation.x = -phi;
          spar.scale.z = (ringR - hubR) / 6.4;
          this.shipModelGroup.add(spar);
        }
      }

      // --- Sensor vanes fanning off the forward hull ---
      // Rolled 60 degrees off vertical so no vane fights the dorsal cannon mount.
      const vaneGeo = makeFin([[6.0, 0.0], [-4.0, 0.0], [-6.0, 7.0], [3.0, 5.6]], 0.7);
      for (const phi of [Math.PI / 3, Math.PI, (5 * Math.PI) / 3]) {
        const vane = new THREE.Mesh(vaneGeo, trimMat);
        vane.position.set(6.0, 0, 0);
        vane.rotation.x = -phi;
        this.shipModelGroup.add(vane);
        this.wingMesh = vane;
      }

      // --- The eye: oversized lens on the nose, treated as the canopy ---
      const cockpitGeo = new THREE.SphereGeometry(4.4, 36, 26);
      cockpitGeo.scale(0.85, 1.0, 1.0);
      const cockpitMat = new THREE.MeshStandardMaterial({
        color: 0xe0f2fe,
        emissive: this.shipColorHex,
        emissiveIntensity: 0.95,
        transparent: true,
        opacity: 0.95
      });
      this.cockpitMesh = new THREE.Mesh(cockpitGeo, cockpitMat);
      this.cockpitMesh.position.set(11.5, 0, 0);
      this.shipModelGroup.add(this.cockpitMesh);

      // Iris housing and glowing rim around the lens
      const irisGeo = new THREE.TorusGeometry(4.0, 0.9, 12, 28);
      irisGeo.rotateY(Math.PI / 2);
      const iris = new THREE.Mesh(irisGeo, trimMat);
      iris.position.set(10.4, 0, 0);
      this.shipModelGroup.add(iris);
      this.addGlowRing(3.2, 0.32, new THREE.Vector3(13.2, 0, 0), 28);
      this.addAccentEdges(vaneGeo, new THREE.Vector3(6.0, 0, 0));

      // --- Warp nozzle: one wide throat plus two verniers ---
      const throatGeo = new THREE.CylinderGeometry(4.6, 5.4, 4.4, 22);
      throatGeo.rotateZ(-Math.PI / 2);
      const throat = new THREE.Mesh(throatGeo, this.wingMat);
      throat.position.set(-12.6, 0, 0);
      this.shipModelGroup.add(throat);
      this.addGlowRing(4.2, 0.4, new THREE.Vector3(-14.4, 0, 0), 26);

      this.addNavLights([
        new THREE.Vector3(-0.5, 11.9, 0),
        new THREE.Vector3(-0.5, -11.9, 0),
        new THREE.Vector3(-9.0, 0, 9.9)
      ]);

      this.addThruster(-14.0, 0, 0, 5.0, 19);
      this.addThruster(-11.0, 0, 6.6, 1.8, 10);
      this.addThruster(-11.0, 0, -6.6, 1.8, 10);
    } else if (modelId === 'valkyrie') {
      // ---------------------------------------------------------------------
      // 'valkyrie' — Solar Valkyrie. The flagship silhouette.
      //
      // A long slender hull with a gull-swept solar array: outer wing panels
      // carry lit cell blocks, the tips fold up into raked pinions, and four
      // engines sit in a stepped rear block. Reads fast and expensive.
      // ---------------------------------------------------------------------
      this.customGreebles = true;

      // --- Slender fuselage with a drawn-out nose ---
      const bodyGeo = makeRevolvedHull(
        [
          [0.0, -15.0], [3.6, -14.6], [5.4, -12.5], [6.6, -8.0], [7.3, -2.0], [7.4, 2.5],
          [6.9, 6.5], [5.8, 10.5], [4.2, 14.0], [2.5, 17.0], [1.0, 19.0], [0.0, 20.0]
        ],
        0.7,
        1.05
      );
      this.bodyMesh = new THREE.Mesh(bodyGeo, this.bodyMat);
      this.shipModelGroup.add(this.bodyMesh);

      // --- Gull-swept solar array ---
      const wingGeo = makePlanform(
        [[8.0, 2.0], [2.0, 8.5], [-12.0, 18.5], [-17.5, 19.5], [-10.5, 9.5], [-9.0, 2.0]],
        1.5,
        0.5
      );
      this.wingMesh = new THREE.Mesh(wingGeo, this.wingMat);
      this.wingMesh.position.set(0, -0.8, 0);
      this.shipModelGroup.add(this.wingMesh);
      this.addAccentEdges(wingGeo, this.wingMesh.position);

      // Inner glove blending wing root into the hull
      const gloveGeo = makePlanform([[13.0, 1.8], [6.0, 7.0], [-8.0, 8.4], [-9.5, 1.8]], 2.2, 0.5);
      const glove = new THREE.Mesh(gloveGeo, trimMat);
      glove.position.set(0, -0.4, 0);
      this.shipModelGroup.add(glove);

      // --- Lit solar cell blocks on the outer panels ---
      const cellGeo = new THREE.BoxGeometry(5.6, 0.35, 3.2);
      for (const side of [1, -1]) {
        for (const [cx, cz] of [
          [-5.5, 11.2],
          [-8.5, 13.9],
          [-11.5, 16.6]
        ]) {
          const cell = new THREE.Mesh(cellGeo, glowMat);
          cell.position.set(cx, 0.2, side * cz);
          cell.rotation.y = side * -0.62; // lie along the sweep of the panel
          this.shipModelGroup.add(cell);
        }
      }

      // --- Raked pinion tips ---
      const pinionGeo = makeFin([[-5.0, 0.0], [5.0, 0.0], [1.0, 9.5], [-3.0, 8.0]], 0.9, 0.3);
      for (const side of [1, -1]) {
        const pinion = new THREE.Mesh(pinionGeo, trimMat);
        pinion.position.set(-14.5, -0.8, side * 18.9);
        pinion.rotation.x = side * 0.5;
        this.shipModelGroup.add(pinion);
      }

      // --- Dorsal spine and long canopy ---
      const spineGeo = makeFin(
        [[15.0, 0.0], [3.0, 3.4], [-9.0, 3.0], [-13.5, 0.6], [-13.5, -2.6], [15.0, -2.6]],
        5.4,
        0.35
      );
      const spine = new THREE.Mesh(spineGeo, this.wingMat);
      spine.position.set(0, 3.2, 0);
      this.shipModelGroup.add(spine);

      const cockpitGeo = new THREE.SphereGeometry(3.6, 32, 24);
      cockpitGeo.scale(2.3, 0.7, 0.95);
      const cockpitMat = new THREE.MeshStandardMaterial({
        color: 0xe0f2fe,
        emissive: this.shipColorHex,
        emissiveIntensity: 0.9,
        transparent: true,
        opacity: 0.92
      });
      this.cockpitMesh = new THREE.Mesh(cockpitGeo, cockpitMat);
      this.cockpitMesh.position.set(10.5, 4.4, 0);
      this.shipModelGroup.add(this.cockpitMesh);

      // --- Swept twin tail fins ---
      const tailGeo = makeFin([[-6.0, 0.0], [4.0, 0.0], [-1.0, 9.0], [-6.5, 8.0]], 0.9, 0.3);
      for (const side of [1, -1]) {
        const tail = new THREE.Mesh(tailGeo, trimMat);
        tail.position.set(-11.0, 1.6, side * 4.4);
        tail.rotation.x = -side * 0.3;
        this.shipModelGroup.add(tail);
      }

      // --- Nose pitot mast and chin sensor ---
      const mastGeo = new THREE.CylinderGeometry(0.35, 0.55, 6.0, 8);
      mastGeo.rotateZ(-Math.PI / 2);
      const mast = new THREE.Mesh(mastGeo, trimMat);
      mast.position.set(22.0, 0, 0);
      this.shipModelGroup.add(mast);

      const chinGeo = new THREE.SphereGeometry(2.2, 20, 14);
      chinGeo.scale(2.1, 0.7, 0.85);
      const chin = new THREE.Mesh(chinGeo, trimMat);
      chin.position.set(11.0, -3.4, 0);
      this.shipModelGroup.add(chin);

      // --- Stepped engine block: two mains plus two outboards ---
      const blockGeo = new THREE.BoxGeometry(7.0, 5.6, 13.0);
      const block = new THREE.Mesh(blockGeo, this.wingMat);
      block.position.set(-14.5, -0.6, 0);
      this.shipModelGroup.add(block);

      for (const [ex, ey, ez, er] of [
        [-17.5, -0.6, 3.6, 3.0],
        [-17.5, -0.6, -3.6, 3.0],
        [-15.5, -1.0, 9.2, 2.1],
        [-15.5, -1.0, -9.2, 2.1]
      ]) {
        const nacelleGeo = new THREE.CylinderGeometry(er, er + 0.6, 5.0, 16);
        nacelleGeo.rotateZ(-Math.PI / 2);
        const nacelle = new THREE.Mesh(nacelleGeo, trimMat);
        nacelle.position.set(ex, ey, ez);
        this.shipModelGroup.add(nacelle);
        this.addGlowRing(er * 0.8, 0.32, new THREE.Vector3(ex - 2.6, ey, ez), 20);
      }

      this.addNavLights([
        new THREE.Vector3(-15.5, 0.6, 19.4),
        new THREE.Vector3(-15.5, 0.6, -19.4),
        new THREE.Vector3(-12.0, 5.0, 0)
      ]);
      this.addNavLights([new THREE.Vector3(25.3, 0, 0)], 0.55);

      this.addThruster(-19.0, -0.6, 3.6, 3.0, 22);
      this.addThruster(-19.0, -0.6, -3.6, 3.0, 22);
      this.addThruster(-17.0, -1.0, 9.2, 2.1, 14);
      this.addThruster(-17.0, -1.0, -9.2, 2.1, 14);
    } else {
      // ---------------------------------------------------------------------
      // 'dart' — Spectre Dart. Stealth recon interdictor.
      //
      // Built as a real airframe rather than a primitive: a revolved
      // needle-nosed lifting body wrapped in knife-edge chine strakes, cranked
      // wings with canted winglets, forward canards, a recessed dorsal canopy
      // and twin underslung nacelles. Every part is hand-placed, so the
      // bounding-box greeble pass is skipped for this hull.
      // ---------------------------------------------------------------------
      this.customGreebles = true;

      // --- Fuselage: revolved side profile, tail (-13) to nose tip (+19.2) ---
      const bodyGeo = makeRevolvedHull(
        [
          [0.0, -13.0], [3.2, -12.7], [5.0, -11.6], [5.9, -8.5], [6.6, -3.5], [7.0, 1.0],
          [6.7, 5.0], [5.7, 9.0], [4.1, 12.8], [2.4, 15.6], [1.0, 17.8], [0.0, 19.2]
        ],
        0.66, // flattened
        1.2 // and slightly widened into a lifting body
      );
      this.bodyMesh = new THREE.Mesh(bodyGeo, this.bodyMat);
      this.shipModelGroup.add(this.bodyMesh);

      // --- Knife-edge chine strakes running the length of the forebody ---
      const chineGeo = makePlanform(
        [[19.8, 0.0], [6.0, 7.6], [-3.0, 8.9], [-9.5, 6.2], [-9.5, 0.0]],
        1.0,
        0.35
      );
      const chine = new THREE.Mesh(chineGeo, trimMat);
      chine.position.set(0, 0.4, 0);
      this.shipModelGroup.add(chine);

      // The chine planform is the crispest outline on the hull, so the accent
      // wireframe is traced from it instead of the smooth revolved body.
      this.addAccentEdges(chineGeo, chine.position);

      // --- Cranked delta wings with a notched trailing edge ---
      const wingGeo = makePlanform(
        [[4.0, 1.6], [-6.0, 8.4], [-17.5, 14.2], [-20.5, 13.6], [-13.5, 7.0], [-11.0, 1.6]],
        1.4,
        0.5
      );
      this.wingMesh = new THREE.Mesh(wingGeo, this.wingMat);
      this.wingMesh.position.set(0, -1.1, 0);
      this.shipModelGroup.add(this.wingMesh);
      this.addAccentEdges(wingGeo, this.wingMesh.position);

      // --- Canted winglets at the wingtips ---
      const wingletGeo = makeFin([[-4.4, 0], [4.0, 0], [1.2, 7.0], [-1.6, 7.0]], 0.7);
      for (const side of [1, -1]) {
        const winglet = new THREE.Mesh(wingletGeo, trimMat);
        winglet.position.set(-17.6, -1.0, side * 13.7);
        winglet.rotation.x = side * 0.34; // rake the tips outward
        this.shipModelGroup.add(winglet);
      }

      // --- Forward canards ---
      const canardGeo = makePlanform([[13.0, 0.0], [7.6, 6.6], [5.4, 6.4], [8.6, 0.0]], 0.8, 0);
      const canards = new THREE.Mesh(canardGeo, this.wingMat);
      canards.position.set(0, 1.0, 0);
      this.shipModelGroup.add(canards);

      // --- Dorsal spine the canopy is recessed into ---
      const spineGeo = makeFin(
        [[12.0, 0.0], [2.0, 3.1], [-8.0, 2.7], [-11.5, 0.4], [-11.5, -2.4], [12.0, -2.4]],
        5.0,
        0.3
      );
      const spine = new THREE.Mesh(spineGeo, this.wingMat);
      spine.position.set(0, 3.0, 0);
      this.shipModelGroup.add(spine);

      // --- Recessed tandem canopy ---
      const cockpitGeo = new THREE.SphereGeometry(3.2, 32, 24);
      cockpitGeo.scale(2.05, 0.72, 0.92);
      const cockpitMat = new THREE.MeshStandardMaterial({
        color: 0xe0f2fe,
        emissive: this.shipColorHex,
        emissiveIntensity: 0.85,
        transparent: true,
        opacity: 0.9
      });
      this.cockpitMesh = new THREE.Mesh(cockpitGeo, cockpitMat);
      this.cockpitMesh.position.set(6.2, 4.5, 0);
      this.shipModelGroup.add(this.cockpitMesh);

      // --- Shoulder intakes feeding the nacelles ---
      const intakeGeo = new THREE.BoxGeometry(6.4, 2.6, 3.6);
      for (const side of [1, -1]) {
        const intake = new THREE.Mesh(intakeGeo, trimMat);
        intake.position.set(1.5, 2.6, side * 6.6);
        intake.rotation.z = -0.06;
        this.shipModelGroup.add(intake);
      }

      // --- Twin underslung nacelles with convergent nozzle rings ---
      const nacelleGeo = new THREE.CylinderGeometry(2.5, 3.2, 15, 18);
      nacelleGeo.rotateZ(-Math.PI / 2); // narrow end forward
      const nozzleRingGeo = new THREE.TorusGeometry(2.6, 0.6, 10, 22);
      nozzleRingGeo.rotateY(Math.PI / 2);
      for (const side of [1, -1]) {
        const nacelle = new THREE.Mesh(nacelleGeo, this.wingMat);
        nacelle.position.set(-6.0, -2.0, side * 7.2);
        this.shipModelGroup.add(nacelle);

        const ring = new THREE.Mesh(nozzleRingGeo, trimMat);
        ring.position.set(-13.6, -2.0, side * 7.2);
        this.shipModelGroup.add(ring);
      }

      // --- Fuselage panel bands (r, x) tracked off the revolved profile ---
      for (const [bandR, bandX] of [
        [5.9, 8.5],
        [7.1, 1.0],
        [6.5, -6.5]
      ]) {
        const bandGeo = new THREE.TorusGeometry(bandR, 0.24, 8, 30);
        bandGeo.rotateY(Math.PI / 2);
        bandGeo.scale(1, 0.66, 1.2);
        const band = new THREE.Mesh(bandGeo, trimMat);
        band.position.set(bandX, 0, 0);
        this.shipModelGroup.add(band);
      }

      // --- Ventral sensor pod ---
      const podGeo = new THREE.SphereGeometry(2.2, 20, 14);
      podGeo.scale(2.0, 0.75, 0.85);
      const pod = new THREE.Mesh(podGeo, trimMat);
      pod.position.set(9.0, -3.0, 0);
      this.shipModelGroup.add(pod);

      // Wingtip beacons, tail beacon and a small nose scanner blip
      this.addNavLights([
        new THREE.Vector3(-18.6, 1.1, 14.0),
        new THREE.Vector3(-18.6, 1.1, -14.0),
        new THREE.Vector3(-11.2, 3.0, 0)
      ]);
      this.addNavLights([new THREE.Vector3(18.4, -0.5, 0)], 0.6);

      this.addThruster(-15.0, -2.0, 7.2, 3.0, 18);
      this.addThruster(-15.0, -2.0, -7.2, 3.0, 18);
    }

    // Engine Point Light. Warm flame-orange rather than the accent colour, so the
    // light spilling onto the hull agrees with what the plume looks like.
    if (!this.engineLight) {
      this.engineLight = new THREE.PointLight(0xff6a1e, 2.8, 100);
      this.shipModelGroup.add(this.engineLight);
    }
    this.engineLight.position.set(-18, 0, 0);
  }

  private buildTrailSystem(): void {
    this.trailParticles = [];
    this.trailGeo = new THREE.SphereGeometry(1.2, 6, 6);
  }

  public setShipColor(colorHex: number): void {
    this.shipColorHex = colorHex;
    if (this.edgeMat) this.edgeMat.color.setHex(colorHex);
    // Only the flame's throat picks up the accent colour; the body of the plume
    // stays fire-coloured, and the engine light stays warm.
    if (this.flameMat) this.flameMat.uniforms.uAccent.value.setHex(colorHex);
    if (this.flameCoreMat) this.flameCoreMat.uniforms.uAccent.value.setHex(colorHex);
    if (this.showcaseSpotLight) this.showcaseSpotLight.color.setHex(colorHex);
    // Nozzle throats, warp coils and solar cells all share one accent glow.
    if (this.glowMat) this.glowMat.color.setHex(colorHex);
    if (this.bodyMat) {
      this.bodyMat.emissive.setHex(colorHex);
      this.bodyMat.emissiveIntensity = 0.35;
    }
    if (this.cockpitMesh && this.cockpitMesh.material) {
      (this.cockpitMesh.material as THREE.MeshStandardMaterial).emissive.setHex(colorHex);
    }
    for (const layer of this.shieldLayers) {
      layer.plateMat.uniforms.uColor.value.setHex(colorHex);
    }
    if (this.shieldBubbleMat && this.shieldBubbleMat.uniforms.uColor) {
      this.shieldBubbleMat.uniforms.uColor.value.setHex(colorHex);
    }
    if (this.hullRimColor) {
      // Mutated in place so the live hull shader uniform follows the paint job
      this.hullRimColor.setHex(colorHex).multiplyScalar(0.45);
    }
  }

  public setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  public reset(bounds: Bounds): void {
    this.setVisible(true);
    this.triggerShieldPowerUp();
    this.x = 0;
    this.y = bounds.halfHeight * 0.43;
    this.z = 120;
    this.vy = 0;
    this.showcaseRotY = 0;
    this.group.position.set(this.x, this.y, this.z);
    this.group.rotation.set(0.15, 0, 0);
    this.clearTrail();
  }

  public clearTrail(): void {
    for (const tp of this.trailParticles) {
      this.scene.remove(tp.mesh);
      tp.mat.dispose();
    }
    this.trailParticles = [];
  }

  /**
   * Local-space bounds of the hull as currently built (model scale included,
   * shield and modules excluded). Preview stages use this to fit each hull
   * tightly into its slot instead of guessing a worst-case footprint.
   */
  public getModelBounds(): THREE.Box3 {
    return new THREE.Box3().setFromObject(this.shipModelGroup);
  }

  /**
   * Minimal showcase tick for standalone previews (e.g. the boot splash), where
   * the ship lives in its own tiny scene with no flight, shield, trail or audio.
   * Drives only the turntable rotation, the thruster plume shader and the
   * navigation beacons, so the hull looks exactly like it does in the hangar.
   */
  public updatePreview(dt: number, spinSpeed = 0.9): void {
    this.idleTime += dt * 2.1;
    this.showcaseRotY += dt * spinSpeed;

    this.group.rotation.y = this.showcaseRotY;
    this.group.rotation.x = Math.sin(this.idleTime * 1.5) * 0.12 + 0.12;
    this.group.rotation.z = Math.cos(this.idleTime) * 0.05;

    // Previews inspect the bare hull, same as the hangar stage.
    this.shieldGroup.visible = false;

    this.flameTime += dt * 15;

    const lengthScale = 1.05;
    for (const f of this.flameMeshes) {
      f.scale.set(lengthScale, 1, 1);
      const nozzleX = f.userData.nozzleX as number;
      const offset = f.userData.offset as number;
      f.position.x = nozzleX - offset * lengthScale;
    }
    for (const mat of [this.flameMat, this.flameCoreMat]) {
      if (!mat) continue;
      mat.uniforms.uTime.value = this.flameTime * 0.16;
      mat.uniforms.uThrust.value = 0.55;
      mat.uniforms.uWarp.value = 0;
    }
    if (this.engineLight) {
      this.engineLight.intensity = 2.4 + Math.sin(this.flameTime * 2) * 0.8;
    }
    if (this.navLightMat) {
      this.navLightMat.opacity = 0.35 + Math.abs(Math.sin(this.flameTime * 0.8)) * 0.65;
    }
  }

  public update(
    gameState: GameState,
    keys: Record<string, boolean>,
    pointerY: number | null,
    isPointerActive: boolean,
    bounds: Bounds,
    gameSpeed: number
  ): void {
    if (gameState === 'START') {
      // 3D Showcase Turntable
      this.idleTime += 0.035;
      this.showcaseRotY += 0.024;

      // Prefer the measured on-screen stage rectangle (start screen and hangar
      // place their viewport at different heights). Falls back to the old fixed
      // framing if the stage element is not in the DOM.
      const anchor = this.showcaseAnchor;
      const targetStartX = anchor ? anchor.x : 0;
      const targetStartY = (anchor ? anchor.y : bounds.halfHeight * 0.37) + Math.sin(this.idleTime) * 3;
      const targetStartZ = 120;

      this.x += (targetStartX - this.x) * 0.14;
      this.y += (targetStartY - this.y) * 0.14;
      this.z += (targetStartZ - this.z) * 0.14;

      this.group.position.set(this.x, this.y, this.z);

      // Normalized Showcase Scale: Ensures entire ship and shield fit completely
      // inside the stage rectangle, shrinking slightly for shorter stages.
      //
      // The hangar gets an extra zoom pass so hulls fill the inspection stage.
      // It can afford the tighter framing because the shield shell (the widest
      // thing on the title stage) is hidden there.
      const fit = this.showcaseAnchor ? this.showcaseAnchor.scale : 1;
      const zoom = SHOWCASE_ZOOM * (this.isHangar ? HANGAR_SHOWCASE_ZOOM : 1);
      const showcaseScale = Math.min(1.15, this.sizeScale * 0.95) * fit * zoom;
      this.shipModelGroup.scale.set(showcaseScale, showcaseScale, showcaseScale);

      // In Hangar mode, hide the active shield so player inspects pure spaceship hull
      this.shieldGroup.visible = !this.isHangar && this.hasShield;
      if (this.shieldGroup.visible) {
        const targetShieldScale = showcaseScale * 1.12;
        this.shieldGroup.scale.set(targetShieldScale, targetShieldScale, targetShieldScale);
      }

      // Smooth 3D turntable rotation showing all angles of the spaceship
      this.group.rotation.y = this.showcaseRotY;
      this.group.rotation.x = Math.sin(this.idleTime * 1.5) * 0.12 + 0.12;
      this.group.rotation.z = Math.cos(this.idleTime) * 0.05;

      this.flameTime += 0.25;
      // Hangar/showcase turntable: no flight, so no movement whoosh.
      soundManager.stopThruster();
    } else {
      // In-flight position & normal scale
      this.shipModelGroup.scale.set(this.sizeScale, this.sizeScale, this.sizeScale);

      const targetFlightX = -bounds.halfWidth * 0.72;
      if (!this.isWarping) {
        this.x += (targetFlightX - this.x) * 0.12;
      }
      this.z += (0 - this.z) * 0.12;

      let moveDir = 0;
      if (keys['ArrowUp'] || keys['KeyW']) moveDir += 1;
      if (keys['ArrowDown'] || keys['KeyS']) moveDir -= 1;

      // Movement whoosh level, driven by how hard the ship is manoeuvring.
      // Set once at the end of this block so every branch reports a value and
      // the loop never retriggers a one-shot sound.
      let thrusterTarget = 0;

      if (this.isWarping) {
        // Hyperspace warp stabilization: centre vertically...
        this.vy = (0 - this.y) * 0.12;
        this.y += this.vy;

        // ...and lunge down the screen. X is driven straight off the surge curve
        // rather than lerped toward a target, so the acceleration profile is
        // exactly the curve's and cannot be smeared out by an easing factor.
        this.warpSurge = this.warpSurgeCurve(this.warpProgress);
        const warpEdgeX = bounds.halfWidth * 0.74;
        this.x = targetFlightX + (warpEdgeX - targetFlightX) * this.warpSurge;
      } else if (moveDir !== 0) {
        // Continuous smooth acceleration on holding keys; tap moves ~1/3rd with fluid holding
        const keyAccel = moveDir * (this.speed * 0.21) * (this.smoothness * 1.4);
        this.vy += keyAccel;
        const maxFlightVy = this.speed * 0.85;
        this.vy = Math.max(-maxFlightVy, Math.min(maxFlightVy, this.vy));
        this.y += this.vy;
        thrusterTarget = Math.min(1, Math.abs(this.vy) / maxFlightVy);
      } else if (isPointerActive && pointerY !== null) {
        const dy = pointerY - this.y;
        this.vy = dy * this.smoothness;
        this.y += this.vy;
        thrusterTarget = Math.min(1, Math.abs(this.vy) / (this.speed * 0.85));
      } else {
        this.vy *= 0.86;
        this.y += this.vy;
        // Coasting: let the whoosh trail off with the residual drift.
        thrusterTarget = Math.min(0.35, Math.abs(this.vy) / (this.speed * 0.85));
      }

      // Below this the ship is effectively still, so go fully silent.
      soundManager.setThrusterIntensity(thrusterTarget < 0.08 ? 0 : thrusterTarget);

      // Constrain within bounds
      const maxY = bounds.halfHeight - this.radius - 8;
      const minY = -bounds.halfHeight + this.radius + 8;

      if (this.y > maxY) {
        this.y = maxY;
        this.vy = 0;
      } else if (this.y < minY) {
        this.y = minY;
        this.vy = 0;
      }

      this.flameTime += this.isWarping ? 0.8 : 0.35;

      // Apply Position and Dynamic Bank/Pitch Rotation
      this.group.position.set(this.x, this.y, this.z);

      const pitch = this.isWarping ? -0.05 : Math.max(-0.45, Math.min(0.45, this.vy * 0.05));
      const roll = this.isWarping ? 0 : Math.max(-0.35, Math.min(0.35, this.vy * 0.04));
      this.group.rotation.z = pitch;
      this.group.rotation.x = roll;
      this.group.rotation.y += (0 - this.group.rotation.y) * 0.15;
    }

    // Update KH2 Reflect Geodesic Shield Animation & Power-Up
    if (this.hasShield && !this.isHangar) {
      this.shieldGroup.visible = true;

      // Power-up materialization: the shell snaps outward past its resting size
      // and settles back, matching Reflect's hard "pop" on cast.
      const restScale = this.sizeScale * SHIELD_REST_SCALE;
      if (this.isShieldPoweringUp) {
        const elapsedSec = (performance.now() - this.shieldPowerUpStartMs) / 1000;
        const p = Math.min(1, Math.max(0, elapsedSec / this.shieldPowerUpDurationSec));
        this.shieldPowerUpProgress = p;

        const build = SHIELD_POWER_UP_BUILD_FRACTION;
        let factor: number;
        if (p < build) {
          // Charge-up: the shell swells out of nothing on a smoothstep ramp with
          // a decaying energy pulse riding on top, so it reads as gathering
          // power rather than a slow, flat inflate.
          const t = p / build;
          const grow = t * t * (3 - 2 * t);
          const pulse = 1 + 0.06 * Math.sin(t * Math.PI * 6) * (1 - t);
          factor = (0.18 + 0.57 * grow) * pulse;
        } else {
          // Settle-in snap: easeOutBack from the built size up to rest, giving
          // the shell its final Reflect-style "lock" with a small overshoot.
          const t = (p - build) / (1 - build);
          const c1 = 1.70158;
          const c3 = c1 + 1;
          const eased = 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
          factor = 0.75 + 0.25 * eased;
        }
        const targetScale = restScale * factor;
        this.shieldGroup.scale.set(targetScale, targetScale, targetScale);
        if (p >= 1) {
          this.isShieldPoweringUp = false;
          this.shieldGroup.scale.set(restScale, restScale, restScale);
        }
      } else {
        this.shieldGroup.scale.set(restScale, restScale, restScale);
      }

      // Slowly rotate geodesic crystal shield for prismatic shimmer. While the
      // shell is powering up it spins hot and decelerates into its resting drift.
      const spinBoost = this.isShieldPoweringUp
        ? 1 + 3 * (1 - this.shieldPowerUpProgress)
        : 1;
      this.shieldGroup.rotation.y += 0.012 * spinBoost;
      this.shieldGroup.rotation.x += 0.006 * spinBoost;

      // The shell spins for shimmer, so re-express the ship's forward axis in
      // shield-local space each frame. That keeps the opaque deflector face aimed
      // at oncoming obstacles while the plates rotate through it.
      const localForward = new THREE.Vector3(1, 0, 0).applyQuaternion(
        this.shieldGroup.quaternion.clone().invert()
      );

      // Update shader time for holographic surface shimmer. Every concentric
      // shell and the leading-face band share the same forward axis so their
      // bright caps stay stacked on the direction of travel.
      for (const layer of this.shieldLayers) {
        layer.plateMat.uniforms.uTime.value += 0.03;
        layer.plateMat.uniforms.uForm.value = this.shieldPowerUpProgress;
        layer.plateMat.uniforms.uForward.value.copy(localForward);
        layer.wireMat.uniforms.uTime.value += 0.03;
        layer.wireMat.uniforms.uForward.value.copy(localForward);
      }
      if (this.shieldFrontBandForward) {
        this.shieldFrontBandForward.value.copy(localForward);
      }
      if (this.shieldFrontBandMat) {
        // Match the plates' flash-in so the band does not sit fully lit on the
        // pinhead-sized shell at the start of a materialisation.
        const formIn = Math.min(1, this.shieldPowerUpProgress / 0.45);
        this.shieldFrontBandMat.opacity = this.shieldFrontBandBaseOpacity * formIn;
      }
      if (this.shieldBubbleMat && this.shieldBubbleMat.uniforms.uTime) {
        this.shieldBubbleMat.uniforms.uTime.value += 0.03;
      }

      // Sparkle flares: each blinks on its own beat and counter-rotates with the
      // shell so they drift across the crystal instead of riding one facet.
      if (this.shieldSparkles.length) {
        this.shieldTwinkleTime += 0.06;
        for (let i = 0; i < this.shieldSparkles.length; i++) {
          const sprite = this.shieldSparkles[i];
          const beat = Math.sin(this.shieldTwinkleTime * (1.5 + i * 0.23) + i * 1.7);
          const pop = Math.max(0, beat);
          const mat = sprite.material as THREE.SpriteMaterial;
          mat.opacity = (0.12 + Math.pow(pop, 3) * 0.75) * SHIELD_OPACITY_SCALE;
          const s = 24 * (0.22 + Math.pow(pop, 2) * 0.42);
          sprite.scale.setScalar(s);
        }
        // Counter-spin so sparkles are not locked to the rotating facets.
        this.shieldSparkleSpin -= 0.02;
        this.shieldSparkles.forEach((sprite, i) => {
          const base = sprite.userData.basePos as THREE.Vector3 | undefined;
          if (!base) {
            sprite.userData.basePos = sprite.position.clone();
            return;
          }
          const a = this.shieldSparkleSpin + i * 0.9;
          sprite.position.set(
            base.x * Math.cos(a) - base.z * Math.sin(a),
            base.y,
            base.x * Math.sin(a) + base.z * Math.cos(a)
          );
        });
      }
    } else {
      this.shieldGroup.visible = false;
    }

    // Keep module attachments aligned with the current ship scale, then animate them
    this.moduleGroup.scale.copy(this.shipModelGroup.scale);
    this.moduleTime += 0.1;

    if (this.cannonGroup) {
      this.cannonRecoil = Math.max(0, this.cannonRecoil - 0.08);

      // Yoke eases toward the tracked elevation instead of snapping to it.
      if (this.cannonYoke) {
        this.cannonYoke.rotation.z += (this.cannonAim - this.cannonYoke.rotation.z) * 0.12;
      }

      // Recoil kicks each barrel back along its own axis, then springs forward.
      for (let i = 0; i < this.cannonBarrels.length; i++) {
        const barrel = this.cannonBarrels[i];
        const rest = (barrel.userData.restX as number) ?? barrel.position.x;
        // Stagger the barrels slightly so a multi-barrel turret reads as ripple fire.
        const stagger = Math.max(0, this.cannonRecoil - i * 0.15);
        barrel.position.x = rest - stagger * 2.6;
      }

      // Charge band glows from a dull ember to white-hot as the reload completes.
      if (this.cannonHeatMat) {
        const shimmer = 0.9 + Math.sin(this.moduleTime * 6) * 0.1;
        this.cannonHeatMat.emissiveIntensity = (0.15 + Math.pow(this.cannonCharge, 1.6) * 2.2) * shimmer;
      }

      if (this.cannonLight) {
        const base = 0.5 + this.cannonCharge * 1.4 + Math.sin(this.moduleTime * 2) * 0.15;
        this.cannonLight.intensity += (base - this.cannonLight.intensity) * 0.2;
      }
    }

    if (this.powerGenGroup && this.powerGenLight) {
      // Pulse faster/brighter while the shield is down (actively regenerating)
      const regenBoost = this.hasShield ? 1 : 1.8;
      const pulse = 0.6 + Math.sin(this.moduleTime * (this.hasShield ? 2 : 4)) * 0.35;
      this.powerGenLight.intensity = (0.6 + this.powerGenLevel * 0.25) * regenBoost * (0.7 + pulse * 0.5);

      // Gyro rings counter-rotate, winding up while the shield is rebuilding.
      const spin = 0.045 * regenBoost * (1 + this.powerGenLevel * 0.12);
      for (const gyro of this.powerGenRings) {
        gyro.rotation.z += spin * ((gyro.userData.spinDir as number) || 1);
      }
      if (this.powerGenCoreMat) {
        this.powerGenCoreMat.opacity = 0.55 + pulse * 0.45 * regenBoost * 0.6;
      }
    }

    if (this.scannerGroup) {
      // Radar head sweeps continuously; the blade inside runs faster still.
      if (this.scannerDish) {
        this.scannerDish.rotation.y += 0.02 + this.zoomScannerLevel * 0.004;
      }
      if (this.scannerSweep) {
        this.scannerSweep.rotation.x += 0.16;
      }
    }

    // Thruster flames. The flicker itself now lives in the flame shader, so the
    // mesh transform only carries throttle: plume length grows with how hard the
    // ship is manoeuvring, and warp stretches it into a long torch.
    const throttle = Math.min(1, Math.abs(this.vy) / Math.max(1, this.speed * 0.85));
    // During warp the plume tracks the lunge itself, so the torch is longest while
    // the ship is running at the right edge and pulls back in as it decelerates.
    const lengthScale = this.isWarping ? 1.4 + this.warpSurge * 2.2 : 0.85 + throttle * 0.75;
    const girthScale = this.isWarping ? 1.0 + this.warpSurge * 0.3 : 0.92 + throttle * 0.2;

    for (const f of this.flameMeshes) {
      f.scale.set(lengthScale, girthScale, girthScale);
      // Stretching a centred cone would pull its mouth off the hull, so the mesh
      // is re-anchored to its nozzle every frame.
      const nozzleX = f.userData.nozzleX as number;
      const offset = f.userData.offset as number;
      f.position.x = nozzleX - offset * lengthScale;
    }
    for (const mat of [this.flameMat, this.flameCoreMat]) {
      if (!mat) continue;
      mat.uniforms.uTime.value = this.flameTime * 0.16;
      mat.uniforms.uThrust.value = this.isWarping ? 1 : 0.3 + throttle * 0.7;
      mat.uniforms.uWarp.value = this.isWarping ? 1 : 0;
    }
    if (this.engineLight) {
      // A point light this strong reaches the nose as well as the tail, so during
      // warp it is pulled back behind the hull and its falloff shortened. That
      // keeps the engine glow a rear-local effect instead of lighting the whole
      // fuselage from within and washing out the front of the ship.
      this.engineLight.intensity = this.isWarping ? 3.4 : 2.4 + Math.sin(this.flameTime * 2) * 0.8;
      this.engineLight.distance = this.isWarping ? 46 : 100;
      this.engineLight.position.x = this.isWarping ? -28 : -18;
    }

    // Warp raises global bloom, which also blows out the ship's own forward
    // emissives (the cockpit glass sits at the nose). Damping them for the
    // duration keeps the hull silhouette readable through the transition.
    if (this.cockpitMesh) {
      const cockpitMat = this.cockpitMesh.material as THREE.MeshStandardMaterial;
      const base = (this.cockpitMesh.userData.baseEmissive as number | undefined) ?? 0.85;
      cockpitMat.emissiveIntensity = this.isWarping ? base * 0.35 : base;
    }
    if (this.canopyFrameMat) {
      this.canopyFrameMat.opacity = this.isWarping ? 0.2 : 0.45;
    }
    if (this.bodyMat) {
      this.bodyMat.emissiveIntensity = this.isWarping ? 0.16 : 0.35;
    }
    if (this.edgeMat) {
      // The neon edge lines trace the whole hull, nose included, and are the
      // largest additive contributor at the front under warp bloom.
      this.edgeMat.opacity = this.isWarping ? 0.45 : 0.9;
    }

    // Blinking navigation beacons
    if (this.navLightMat) {
      this.navLightMat.opacity = 0.35 + Math.abs(Math.sin(this.flameTime * 0.8)) * 0.65;
    }

    // Emit exhaust trail particles in flight and warp wake
    const trailRate = this.isWarping ? 1.0 : 0.75;
    if ((gameState === 'PLAYING' || gameState === 'WARPING') && Math.random() <= trailRate) {
      const trailMat = new THREE.MeshBasicMaterial({
        color: this.isWarping ? 0x38bdf8 : Math.random() > 0.3 ? this.shipColorHex : 0xffffff,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending
      });
      const trailMesh = new THREE.Mesh(this.trailGeo, trailMat);
      trailMesh.position.set(
        this.x - (this.isWarping ? 32 : 22) * this.sizeScale,
        this.y + (Math.random() - 0.5) * 4 * this.sizeScale,
        (Math.random() - 0.5) * 4
      );
      this.scene.add(trailMesh);
      this.trailParticles.push({
        mesh: trailMesh,
        mat: trailMat,
        life: 1.0,
        decay: this.isWarping ? 0.08 : 0.05,
        vx: -(gameSpeed * (this.isWarping ? 2.5 : 0.5) + Math.random() * 1.5)
      });
    }

    // Update trail
    for (let i = this.trailParticles.length - 1; i >= 0; i--) {
      const tp = this.trailParticles[i];
      tp.mesh.position.x += tp.vx;
      tp.life -= tp.decay;

      if (tp.life <= 0) {
        this.scene.remove(tp.mesh);
        tp.mat.dispose();
        this.trailParticles.splice(i, 1);
      } else {
        tp.mat.opacity = tp.life;
        const s = tp.life * 1.5 * this.sizeScale;
        tp.mesh.scale.set(s, s, s);
      }
    }
  }

  public destroy(): void {
    this.scene.remove(this.group);
    this.clearTrail();
    this.trailGeo.dispose();
    this.greebleGeo?.dispose();
    this.trimMat?.dispose();
    this.glowMat?.dispose();
    this.finGeo?.dispose();
    this.navLightGeo?.dispose();
    this.navLightMat?.dispose();
  }
}
