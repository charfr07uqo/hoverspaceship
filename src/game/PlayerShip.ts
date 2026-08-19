import * as THREE from 'three';
import { soundManager } from '../audio/soundManager';
import { Bounds, GameState, ShipModelId } from '../types/game';
import { SHIPS_CONFIG } from '../constants/gameConfig';

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

/** Base hull collision radius at sizeScale 1.0, before the ship model scales it. */
const HULL_BASE_RADIUS = 11;

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

/** Resting scale of the shield group in flight, relative to the ship's sizeScale. */
const SHIELD_REST_SCALE = 1.18;

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

  // Dynamic mesh references
  private bodyMesh!: THREE.Mesh;
  private bodyMat!: THREE.MeshStandardMaterial;
  private edgeMesh!: THREE.LineSegments;
  private edgeMat!: THREE.LineBasicMaterial;
  private wingMesh!: THREE.Mesh;
  private wingMat!: THREE.MeshStandardMaterial;
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
  private shieldMesh!: THREE.Mesh;
  private shieldWireframe!: THREE.LineSegments;
  private shieldShaderMat!: THREE.ShaderMaterial;
  private shieldWireMat!: THREE.ShaderMaterial;
  private shieldBubbleMat!: THREE.ShaderMaterial;
  private shieldSparkles: THREE.Sprite[] = [];
  private shieldTwinkleTime = 0;
  private shieldSparkleSpin = 0;

  private trailParticles: TrailParticle[] = [];
  private trailGeo!: THREE.SphereGeometry;

  // Module visuals
  private moduleGroup: THREE.Group;
  private cannonGroup: THREE.Group | null = null;
  private cannonBarrel: THREE.Mesh | null = null;
  private cannonLight: THREE.PointLight | null = null;
  private powerGenGroup: THREE.Group | null = null;
  private powerGenLight: THREE.PointLight | null = null;
  private moduleTime = 0;
  private cannonRecoil = 0; // 0..1, decays after firing
  public autoCannonLevel = 0;
  public powerGenLevel = 0;

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

    this.shieldShaderMat = new THREE.ShaderMaterial({
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

    this.shieldMesh = new THREE.Mesh(plateGeo, this.shieldShaderMat);
    // Plates are unsorted transparent geometry; render after the hull so the ship
    // shows through them.
    this.shieldMesh.renderOrder = 3;
    this.shieldGroup.add(this.shieldMesh);

    // Crisp outline on every hex/pent shard - this is what makes the faceting
    // legible at small on-screen sizes.
    // Outlines follow the same front/middle/back falloff as the plates, otherwise
    // they paint a uniform white cage over the whole sphere and the back never
    // reads as transparent.
    this.shieldWireMat = new THREE.ShaderMaterial({
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
    this.shieldWireframe = new THREE.LineSegments(rimGeo, this.shieldWireMat);
    this.shieldWireframe.renderOrder = 4;
    this.shieldGroup.add(this.shieldWireframe);

    // --- Sparkle flares orbiting the shell ---
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
   * so it tracks the power-up pop-in (and its easeOutBack overshoot) exactly:
   * a shell that has only materialised to 30% does not deflect at full size.
   * Returns `null` in the hangar, where the shell is hidden for inspection.
   */
  public get shieldCollisionRadius(): number | null {
    if (!this.hasShield || this.isHangar) return null;
    return SHIELD_GEOMETRY_RADIUS * this.shieldGroup.scale.x;
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

  public triggerShieldPowerUp(): void {
    this.hasShield = true;
    this.shieldCharges = this.maxShieldCharges;
    this.isShieldPoweringUp = true;
    this.shieldPowerUpProgress = 0;
    if (!this.isHangar) {
      this.shieldGroup.visible = true;
    }
    this.shieldGroup.scale.set(0.01, 0.01, 0.01);
    // A freshly cast shell is always at full strength.
    this.applyShieldChargeTint();
  }

  /**
   * Recomputes the shell's charge capacity from the current hull rating plus any
   * module bonus. Pass `refill` to also top the live charges back up (ship swap,
   * new run); otherwise the remaining charges are only clamped to the new cap.
   */
  public refreshShieldCharges(refill: boolean): void {
    const config = SHIPS_CONFIG[this.shipModelId] || SHIPS_CONFIG.dart;
    this.maxShieldCharges = Math.max(1, config.shieldCharges + this.bonusShieldCharges);
    this.shieldCharges = refill
      ? this.maxShieldCharges
      : Math.min(this.shieldCharges, this.maxShieldCharges);
    this.applyShieldChargeTint();
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
      this.applyShieldChargeTint();
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
      this.isShieldPoweringUp = true;
      this.shieldPowerUpProgress = 0;
      this.shieldGroup.scale.set(0.01, 0.01, 0.01);
      this.applyShieldChargeTint();
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
   * Thins the shell as charges are spent so a multi-charge shield visibly
   * weakens instead of silently soaking hits. Recomputed from the tuned base
   * opacities every call, so it never compounds across hits.
   */
  private applyShieldChargeTint(): void {
    const strength =
      this.maxShieldCharges <= 1 ? 1 : Math.max(1, this.shieldCharges) / this.maxShieldCharges;
    const factor = 0.5 + 0.5 * strength;

    if (this.shieldShaderMat?.uniforms.uOpacityScale) {
      this.shieldShaderMat.uniforms.uOpacityScale.value = SHIELD_OPACITY_SCALE * factor;
    }
    if (this.shieldBubbleMat?.uniforms.uOpacityScale) {
      this.shieldBubbleMat.uniforms.uOpacityScale.value = SHIELD_OPACITY_SCALE * factor;
    }
    if (this.shieldWireMat?.uniforms.uOpacity) {
      this.shieldWireMat.uniforms.uOpacity.value = SHIELD_WIRE_BASE_OPACITY * SHIELD_OPACITY_SCALE * factor;
    }
  }

  /** Rebuild the auto cannon and power generator attachments for the given tiers. */
  public setModuleLevels(powerGenLevel: number, autoCannonLevel: number): void {
    this.powerGenLevel = powerGenLevel;
    this.autoCannonLevel = autoCannonLevel;

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
    this.cannonBarrel = null;
    this.cannonLight = null;
    this.powerGenGroup = null;
    this.powerGenLight = null;

    if (autoCannonLevel > 0) this.buildAutoCannon(autoCannonLevel);
    if (powerGenLevel > 0) this.buildPowerGen(powerGenLevel);
  }

  private buildAutoCannon(tier: number): void {
    this.cannonGroup = new THREE.Group();

    const metalMat = new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      metalness: 0.9,
      roughness: 0.25,
      emissive: 0x38bdf8,
      emissiveIntensity: 0.25
    });

    // Turret base mounted on the ship's spine
    const baseGeo = new THREE.CylinderGeometry(3.2, 3.8, 3.5, 16);
    const base = new THREE.Mesh(baseGeo, metalMat);
    base.position.set(0, 7, 0);
    this.cannonGroup.add(base);

    // Forward-pointing barrel (longer with higher tiers)
    const barrelLen = 12 + tier * 1.4;
    const barrelGeo = new THREE.CylinderGeometry(1.5, 1.8, barrelLen, 14);
    barrelGeo.rotateZ(-Math.PI / 2); // point along +x (forward)
    this.cannonBarrel = new THREE.Mesh(barrelGeo, metalMat);
    this.cannonBarrel.position.set(barrelLen / 2 + 2, 8.5, 0);
    this.cannonGroup.add(this.cannonBarrel);

    // Glowing muzzle tip
    const muzzleGeo = new THREE.SphereGeometry(1.9, 12, 12);
    const muzzleMat = new THREE.MeshBasicMaterial({
      color: 0x7dd3fc,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending
    });
    const muzzle = new THREE.Mesh(muzzleGeo, muzzleMat);
    muzzle.position.set(barrelLen + 3, 8.5, 0);
    this.cannonGroup.add(muzzle);

    this.cannonLight = new THREE.PointLight(0x38bdf8, 0.8, 40);
    this.cannonLight.position.set(barrelLen + 3, 8.5, 0);
    this.cannonGroup.add(this.cannonLight);

    this.moduleGroup.add(this.cannonGroup);
  }

  private buildPowerGen(tier: number): void {
    this.powerGenGroup = new THREE.Group();

    const podMat = new THREE.MeshStandardMaterial({
      color: 0x052e16,
      metalness: 0.8,
      roughness: 0.3,
      emissive: 0x22c55e,
      emissiveIntensity: 0.9
    });
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x4ade80,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending
    });

    // Two energy pods flanking the rear hull, glowing brighter with tier
    const podGeo = new THREE.CapsuleGeometry(1.8, 5, 6, 12);
    podGeo.rotateZ(Math.PI / 2);
    const ringGeo = new THREE.TorusGeometry(3.2, 0.6, 10, 20);
    ringGeo.rotateY(Math.PI / 2);

    for (const side of [1, -1]) {
      const pod = new THREE.Mesh(podGeo, podMat);
      pod.position.set(-10, 0, side * 7);
      this.powerGenGroup.add(pod);

      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.set(-10, 0, side * 7);
      this.powerGenGroup.add(ring);
    }

    this.powerGenLight = new THREE.PointLight(0x22c55e, 0.6 + tier * 0.25, 55);
    this.powerGenLight.position.set(-10, 0, 0);
    this.powerGenGroup.add(this.powerGenLight);

    this.moduleGroup.add(this.powerGenGroup);
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

    // Clear previous model meshes
    while (this.shipModelGroup.children.length > 0) {
      const child = this.shipModelGroup.children[0];
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
    if (this.navLightMat) this.navLightMat.dispose();
    const navMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    this.navLightMat = navMat;
    for (const p of [
      new THREE.Vector3(len * 0.18, 0, halfD * 1.05),
      new THREE.Vector3(len * 0.18, 0, -halfD * 1.05),
      new THREE.Vector3(-len * 0.45, halfH * 0.6, 0)
    ]) {
      const light = new THREE.Mesh(this.navLightGeo, navMat);
      light.position.copy(p);
      this.shipModelGroup.add(light);
    }
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

    this.flameMat = this.createFlameMaterial(1.0, 1.0);
    this.flameCoreMat = this.createFlameMaterial(1.35, 0.45);

    if (modelId === 'viper') {
      // Dual-fork agile interceptor - smooth tapered hull
      const bodyGeo = new THREE.CylinderGeometry(3.5, 5.5, 26, 16, 3);
      bodyGeo.rotateZ(-Math.PI / 2);
      bodyGeo.scale(1, 0.75, 1);
      this.bodyMesh = new THREE.Mesh(bodyGeo, this.bodyMat);
      this.shipModelGroup.add(this.bodyMesh);

      const edgeGeo = new THREE.EdgesGeometry(bodyGeo, 25);
      this.edgeMesh = new THREE.LineSegments(edgeGeo, this.edgeMat);
      this.shipModelGroup.add(this.edgeMesh);

      // Dual forward prongs
      const prongGeo = new THREE.ConeGeometry(3, 14, 20);
      prongGeo.rotateZ(-Math.PI / 2);

      const prong1 = new THREE.Mesh(prongGeo, this.wingMat);
      prong1.position.set(14, 3, 4);
      this.shipModelGroup.add(prong1);

      const prong2 = new THREE.Mesh(prongGeo, this.wingMat);
      prong2.position.set(14, -3, -4);
      this.shipModelGroup.add(prong2);

      // Cockpit
      const cockpitGeo = new THREE.SphereGeometry(3.2, 32, 24);
      cockpitGeo.scale(2, 0.8, 1);
      const cockpitMat = new THREE.MeshStandardMaterial({
        color: 0xe0f2fe,
        emissive: this.shipColorHex,
        emissiveIntensity: 0.9,
        transparent: true,
        opacity: 0.92
      });
      this.cockpitMesh = new THREE.Mesh(cockpitGeo, cockpitMat);
      this.cockpitMesh.position.set(3, 2.5, 0);
      this.shipModelGroup.add(this.cockpitMesh);

      // Dual micro thrusters
      this.addThruster(-10, 2, 3, 3.2, 16);
      this.addThruster(-10, -2, -3, 3.2, 16);
    } else if (modelId === 'titan') {
      // Broad heavy cruiser with armor plating
      const bodyGeo = new THREE.BoxGeometry(32, 10, 16);
      this.bodyMesh = new THREE.Mesh(bodyGeo, this.bodyMat);
      this.shipModelGroup.add(this.bodyMesh);

      const edgeGeo = new THREE.EdgesGeometry(bodyGeo);
      this.edgeMesh = new THREE.LineSegments(edgeGeo, this.edgeMat);
      this.shipModelGroup.add(this.edgeMesh);

      // Heavy Side Armored Wings
      const wingShape = new THREE.Shape();
      wingShape.moveTo(-14, 0);
      wingShape.lineTo(-18, 18);
      wingShape.lineTo(4, 0);
      wingShape.lineTo(-18, -18);
      wingShape.closePath();
      const wingGeo = new THREE.ExtrudeGeometry(wingShape, { depth: 3, bevelEnabled: true, bevelSize: 0.5, bevelThickness: 0.5 });
      wingGeo.rotateX(Math.PI / 2);
      this.wingMesh = new THREE.Mesh(wingGeo, this.wingMat);
      this.wingMesh.position.set(0, 0, 0);
      this.shipModelGroup.add(this.wingMesh);

      // Heavy Cockpit
      const cockpitGeo = new THREE.BoxGeometry(10, 4, 6);
      const cockpitMat = new THREE.MeshStandardMaterial({
        color: 0xe0f2fe,
        emissive: this.shipColorHex,
        emissiveIntensity: 0.8,
        transparent: true,
        opacity: 0.9
      });
      this.cockpitMesh = new THREE.Mesh(cockpitGeo, cockpitMat);
      this.cockpitMesh.position.set(4, 5, 0);
      this.shipModelGroup.add(this.cockpitMesh);

      // Triple heavy thrusters
      this.addThruster(-16, 0, 0, 4.2, 22);
      this.addThruster(-15, 4, 6, 3.4, 18);
      this.addThruster(-15, -4, -6, 3.4, 18);
    } else if (modelId === 'phantom') {
      // Disc & Ring warp fuselage
      const bodyGeo = new THREE.TorusGeometry(8, 2.5, 24, 48);
      bodyGeo.rotateY(Math.PI / 2);
      this.bodyMesh = new THREE.Mesh(bodyGeo, this.bodyMat);
      this.shipModelGroup.add(this.bodyMesh);

      const edgeGeo = new THREE.EdgesGeometry(bodyGeo, 20);
      this.edgeMesh = new THREE.LineSegments(edgeGeo, this.edgeMat);
      this.shipModelGroup.add(this.edgeMesh);

      // Central core cone
      const coreGeo = new THREE.ConeGeometry(5, 26, 24);
      coreGeo.rotateZ(-Math.PI / 2);
      this.wingMesh = new THREE.Mesh(coreGeo, this.wingMat);
      this.wingMesh.position.set(0, 0, 0);
      this.shipModelGroup.add(this.wingMesh);

      // Warp Cockpit
      const cockpitGeo = new THREE.SphereGeometry(3.5, 32, 24);
      const cockpitMat = new THREE.MeshStandardMaterial({
        color: 0xe0f2fe,
        emissive: this.shipColorHex,
        emissiveIntensity: 0.95,
        transparent: true,
        opacity: 0.95
      });
      this.cockpitMesh = new THREE.Mesh(cockpitGeo, cockpitMat);
      this.cockpitMesh.position.set(4, 1.5, 0);
      this.shipModelGroup.add(this.cockpitMesh);

      // Ring Thruster
      this.addThruster(-10, 0, 0, 5.5, 18);
    } else if (modelId === 'valkyrie') {
      // Swept-back solar flagship
      const bodyGeo = new THREE.ConeGeometry(9, 34, 28, 3);
      bodyGeo.rotateZ(-Math.PI / 2);
      this.bodyMesh = new THREE.Mesh(bodyGeo, this.bodyMat);
      this.shipModelGroup.add(this.bodyMesh);

      const edgeGeo = new THREE.EdgesGeometry(bodyGeo, 25);
      this.edgeMesh = new THREE.LineSegments(edgeGeo, this.edgeMat);
      this.shipModelGroup.add(this.edgeMesh);

      // Solar swept wings
      const wingShape = new THREE.Shape();
      wingShape.moveTo(-8, 0);
      wingShape.lineTo(-24, 20);
      wingShape.lineTo(8, 6);
      wingShape.lineTo(-4, 0);
      wingShape.lineTo(8, -6);
      wingShape.lineTo(-24, -20);
      wingShape.closePath();
      const wingGeo = new THREE.ExtrudeGeometry(wingShape, { depth: 1.8, bevelEnabled: true, bevelSize: 0.6, bevelThickness: 0.6 });
      wingGeo.rotateX(Math.PI / 2);
      this.wingMesh = new THREE.Mesh(wingGeo, this.wingMat);
      this.wingMesh.position.set(0, 0, 0);
      this.shipModelGroup.add(this.wingMesh);

      // Cockpit
      const cockpitGeo = new THREE.SphereGeometry(4, 32, 24);
      cockpitGeo.scale(2.2, 1, 1.2);
      const cockpitMat = new THREE.MeshStandardMaterial({
        color: 0xe0f2fe,
        emissive: this.shipColorHex,
        emissiveIntensity: 0.9,
        transparent: true,
        opacity: 0.92
      });
      this.cockpitMesh = new THREE.Mesh(cockpitGeo, cockpitMat);
      this.cockpitMesh.position.set(6, 2.5, 0);
      this.shipModelGroup.add(this.cockpitMesh);

      // Solar thruster
      this.addThruster(-13, 0, 0, 5, 24);
    } else {
      // 'dart' Default
      const bodyGeo = new THREE.ConeGeometry(8, 30, 28, 3);
      bodyGeo.rotateZ(-Math.PI / 2);
      bodyGeo.scale(1, 0.65, 1.4);
      this.bodyMesh = new THREE.Mesh(bodyGeo, this.bodyMat);
      this.shipModelGroup.add(this.bodyMesh);

      const edgeGeo = new THREE.EdgesGeometry(bodyGeo, 25);
      this.edgeMesh = new THREE.LineSegments(edgeGeo, this.edgeMat);
      this.shipModelGroup.add(this.edgeMesh);

      const wingShape = new THREE.Shape();
      wingShape.moveTo(-10, 0);
      wingShape.lineTo(-18, 14);
      wingShape.lineTo(-4, 0);
      wingShape.lineTo(-18, -14);
      wingShape.closePath();
      const wingGeo = new THREE.ExtrudeGeometry(wingShape, { depth: 1.5, bevelEnabled: true, bevelSize: 0.6, bevelThickness: 0.6 });
      wingGeo.rotateX(Math.PI / 2);
      this.wingMesh = new THREE.Mesh(wingGeo, this.wingMat);
      this.wingMesh.position.set(2, 0, 0);
      this.shipModelGroup.add(this.wingMesh);

      const cockpitGeo = new THREE.SphereGeometry(3.6, 32, 24);
      cockpitGeo.scale(2.2, 1, 1.2);
      const cockpitMat = new THREE.MeshStandardMaterial({
        color: 0xe0f2fe,
        emissive: this.shipColorHex,
        emissiveIntensity: 0.85,
        transparent: true,
        opacity: 0.9
      });
      this.cockpitMesh = new THREE.Mesh(cockpitGeo, cockpitMat);
      this.cockpitMesh.position.set(4, 2.5, 0);
      this.shipModelGroup.add(this.cockpitMesh);

      this.addThruster(-12, 0, 0, 4, 20);
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
    if (this.bodyMat) {
      this.bodyMat.emissive.setHex(colorHex);
      this.bodyMat.emissiveIntensity = 0.35;
    }
    if (this.cockpitMesh && this.cockpitMesh.material) {
      (this.cockpitMesh.material as THREE.MeshStandardMaterial).emissive.setHex(colorHex);
    }
    if (this.shieldShaderMat && this.shieldShaderMat.uniforms.uColor) {
      this.shieldShaderMat.uniforms.uColor.value.setHex(colorHex);
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
      const zoom = this.isHangar ? HANGAR_SHOWCASE_ZOOM : 1;
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
        this.shieldPowerUpProgress = Math.min(1.0, this.shieldPowerUpProgress + 0.055);
        const p = this.shieldPowerUpProgress;
        // easeOutBack for the overshoot
        const eased = 1 + 2.2 * Math.pow(p - 1, 3) + 1.4 * Math.pow(p - 1, 2);
        const targetScale = restScale * (0.35 + 0.65 * eased);
        this.shieldGroup.scale.set(targetScale, targetScale, targetScale);
        if (this.shieldPowerUpProgress >= 1.0) {
          this.isShieldPoweringUp = false;
        }
      } else {
        this.shieldGroup.scale.set(restScale, restScale, restScale);
      }

      // Slowly rotate geodesic crystal shield for prismatic shimmer
      this.shieldGroup.rotation.y += 0.012;
      this.shieldGroup.rotation.x += 0.006;

      // The shell spins for shimmer, so re-express the ship's forward axis in
      // shield-local space each frame. That keeps the opaque deflector face aimed
      // at oncoming obstacles while the plates rotate through it.
      const localForward = new THREE.Vector3(1, 0, 0).applyQuaternion(
        this.shieldGroup.quaternion.clone().invert()
      );

      // Update shader time for holographic surface shimmer
      if (this.shieldShaderMat && this.shieldShaderMat.uniforms.uTime) {
        this.shieldShaderMat.uniforms.uTime.value += 0.03;
        this.shieldShaderMat.uniforms.uForm.value = this.shieldPowerUpProgress;
        this.shieldShaderMat.uniforms.uForward.value.copy(localForward);
      }
      if (this.shieldWireMat && this.shieldWireMat.uniforms.uTime) {
        this.shieldWireMat.uniforms.uTime.value += 0.03;
        this.shieldWireMat.uniforms.uForward.value.copy(localForward);
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
      if (this.cannonBarrel) {
        // Recoil kicks the barrel backward then eases forward again
        this.cannonBarrel.position.x = (12 + this.autoCannonLevel * 1.4) / 2 + 2 - this.cannonRecoil * 3;
      }
      if (this.cannonLight) {
        const base = 0.8 + Math.sin(this.moduleTime * 2) * 0.15;
        this.cannonLight.intensity += (base - this.cannonLight.intensity) * 0.2;
      }
    }

    if (this.powerGenGroup && this.powerGenLight) {
      // Pulse faster/brighter while the shield is down (actively regenerating)
      const regenBoost = this.hasShield ? 1 : 1.8;
      const pulse = 0.6 + Math.sin(this.moduleTime * (this.hasShield ? 2 : 4)) * 0.35;
      this.powerGenLight.intensity = (0.6 + this.powerGenLevel * 0.25) * regenBoost * (0.7 + pulse * 0.5);
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
    this.finGeo?.dispose();
    this.navLightGeo?.dispose();
    this.navLightMat?.dispose();
  }
}
