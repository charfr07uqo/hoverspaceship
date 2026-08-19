import * as THREE from 'three';
import { Bounds, DifficultyConfig, DifficultyKey } from '../types/game';
import { PlayerShip } from './PlayerShip';

export type AsteroidShapeType = 'craggy' | 'oblong' | 'crystal' | 'smooth' | 'boulder';

/**
 * Global size multiplier for every rock in every formation. Applied to the
 * radius at generation time (not as a mesh scale) so that the stacking and
 * gap-edge placement math in buildFormation stays consistent with the visual
 * size and rocks keep sitting flush against the corridor edges.
 */
const ASTEROID_SIZE_SCALE = 0.8;

/** Scale a raw formation radius by the global asteroid size multiplier. */
function rockRadius(raw: number): number {
  return raw * ASTEROID_SIZE_SCALE;
}

/**
 * Arcade leniency applied to the player's *hull* radius when the Reflect shield
 * is down, so near-misses against the exposed ship read as misses. The shield
 * shell gets no such discount: it is a hard energy barrier and collides at its
 * full rendered radius.
 */
const HULL_HIT_LENIENCY = 0.65;

/**
 * Cheap deterministic 3D value noise. Used to displace asteroid hulls with
 * coherent lumps instead of per-vertex white noise, which is what made the old
 * rocks read as "spiky ball" rather than "rock".
 */
function hash3(x: number, y: number, z: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

function valueNoise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = x - xi;
  const yf = y - yi;
  const zf = z - zi;
  // Smoothstep fade for C1 continuity
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = zf * zf * (3 - 2 * zf);

  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

  const c000 = hash3(xi, yi, zi);
  const c100 = hash3(xi + 1, yi, zi);
  const c010 = hash3(xi, yi + 1, zi);
  const c110 = hash3(xi + 1, yi + 1, zi);
  const c001 = hash3(xi, yi, zi + 1);
  const c101 = hash3(xi + 1, yi, zi + 1);
  const c011 = hash3(xi, yi + 1, zi + 1);
  const c111 = hash3(xi + 1, yi + 1, zi + 1);

  const x00 = lerp(c000, c100, u);
  const x10 = lerp(c010, c110, u);
  const x01 = lerp(c001, c101, u);
  const x11 = lerp(c011, c111, u);

  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w) * 2 - 1;
}

/** 3-octave fBm in [-1, 1]. */
function fbm3(x: number, y: number, z: number): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < 3; o++) {
    sum += valueNoise3(x * freq, y * freq, z * freq) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.1;
  }
  return sum / norm;
}

/**
 * Injects a fresnel rim-light term into a MeshStandardMaterial without writing a
 * whole material from scratch. The rim picks up the sector theme colour so rocks
 * silhouette against the dark background; crevice shading is baked separately
 * into vertex colours (see generateGeometry).
 *
 * Deliberately adds no varyings and does not touch the vertex shader. The
 * standard material already publishes everything needed: `vViewPosition` is
 * declared unconditionally by the STANDARD fragment shader, and `normal` is in
 * scope for the rest of main() after `<normal_fragment_begin>` (which derives it
 * from screen-space derivatives when FLAT_SHADED, so crystals work too). The
 * previous version declared its own vRimNormal/vRimView pair and wrote them from
 * an injected `<project_vertex>` hook, which is exactly the kind of hand-rolled
 * variant that some mobile GL drivers refuse to link.
 */
function applyRockShader(mat: THREE.MeshStandardMaterial, rimColor: THREE.Color, cacheKey: string): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRimColor = { value: rimColor };
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform vec3 uRimColor;`
      )
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
         // Fresnel rim: bright at grazing angles, invisible face-on.
         float rimNdv = 1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);
         gl_FragColor.rgb += uRimColor * pow(rimNdv, 3.0) * 0.8;`
      );
  };
  // Keeps this variant from sharing a program with untouched standard materials.
  mat.customProgramCacheKey = () => cacheKey;
}

/**
 * The two rock surface finishes. Everything that used to vary per rock (base
 * colour, cavity shading) is baked into vertex colours instead, so every
 * asteroid in the field draws with one of two shared materials.
 */
type RockFinish = 'crystal' | 'rock';

interface SharedRockMaterial {
  material: THREE.MeshStandardMaterial;
  /** Mutated in place so the live shader uniform tracks the sector theme. */
  rimColor: THREE.Color;
  wireMaterial: THREE.LineBasicMaterial;
}

/**
 * One material pair per finish, shared by every rock in the field.
 *
 * This used to be a fresh MeshStandardMaterial (plus a fresh LineBasicMaterial)
 * per asteroid — hundreds of them over a run, each carrying its own
 * onBeforeCompile hook and its own uniform block. Sharing collapses that to two,
 * which is both far less per-frame GL state and far less for a driver to get
 * wrong: rocks rendering as flat untextured blobs on some Android devices is the
 * signature of a material whose program never linked.
 */
const sharedRockMaterials = new Map<RockFinish, SharedRockMaterial>();

function getSharedRockMaterial(finish: RockFinish, themeColorHex: number): SharedRockMaterial {
  const existing = sharedRockMaterials.get(finish);
  if (existing) return existing;

  const isCrystal = finish === 'crystal';
  const rimColor = new THREE.Color(themeColorHex).multiplyScalar(0.5);

  const material = new THREE.MeshStandardMaterial({
    // White base: the rock's own hue arrives through vertex colours, which the
    // standard shader multiplies into the diffuse term.
    color: 0xffffff,
    roughness: isCrystal ? 0.35 : 0.92,
    metalness: isCrystal ? 0.65 : 0.12,
    flatShading: isCrystal,
    vertexColors: true,
    // Emissive cannot ride on vertex colours, so it is a neutral cool tone for
    // the whole field rather than a per-rock hue. At these intensities the
    // difference is not readable.
    emissive: new THREE.Color(0x2f3a4a),
    emissiveIntensity: isCrystal ? 0.22 : 0.06
  });
  applyRockShader(material, rimColor, `rockRim_${finish}`);

  // Neon accent lines share the same fate: one material for the whole field.
  const wireMaterial = new THREE.LineBasicMaterial({
    color: themeColorHex,
    transparent: true,
    opacity: isCrystal ? 0.6 : 0.3,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });

  const entry: SharedRockMaterial = { material, rimColor, wireMaterial };
  sharedRockMaterials.set(finish, entry);
  return entry;
}

/** Palette the per-rock base colour is drawn from and baked into vertex colours. */
const ROCK_COLORS = [0x334155, 0x3f2a4d, 0x1e3a5f, 0x4a3520, 0x2f4738];

export class ProceduralAsteroid3D {
  public offsetX: number;
  public offsetY: number;
  public baseRadius: number;
  public collisionRadius: number;
  public shapeType: AsteroidShapeType;

  private rotSpeedX: number;
  private rotSpeedY: number;
  private rotSpeedZ: number;

  public mesh: THREE.Mesh;
  private geometry: THREE.BufferGeometry;
  private wireMesh: THREE.LineSegments;
  /** Shared, field-wide materials. Never disposed by an individual rock. */
  private shared: SharedRockMaterial;

  constructor(
    offsetX: number,
    offsetY: number,
    baseRadius: number,
    themeColorHex: number,
    shapeType: AsteroidShapeType = 'craggy'
  ) {
    this.offsetX = offsetX;
    this.offsetY = offsetY;
    this.baseRadius = baseRadius;
    this.shapeType = shapeType;

    // Fair arcade collision radius (72% of bounding sphere)
    this.collisionRadius = baseRadius * 0.72;

    this.rotSpeedX = (Math.random() - 0.5) * 0.025;
    this.rotSpeedY = (Math.random() - 0.5) * 0.03;
    this.rotSpeedZ = (Math.random() - 0.5) * 0.025;

    // Per-rock base colour, baked into vertex colours so the shared material can
    // stay white and still give every rock its own hue.
    const chosenColor = new THREE.Color(ROCK_COLORS[Math.floor(Math.random() * ROCK_COLORS.length)]);

    // Generate varied procedural geometries
    this.geometry = this.generateGeometry(baseRadius, shapeType, chosenColor);

    this.shared = getSharedRockMaterial(shapeType === 'crystal' ? 'crystal' : 'rock', themeColorHex);
    // The shared entry may have been created under a previous sector's theme, so
    // a freshly spawned rock always reasserts the current one.
    this.setThemeColor(themeColorHex);

    this.mesh = new THREE.Mesh(this.geometry, this.shared.material);
    // Crucial: set local mesh position inside group
    this.mesh.position.set(this.offsetX, this.offsetY, 0);

    // Glowing Neon Edge Accent Wireframe
    // Neon accent lines. With the higher-poly hulls a full wireframe would read
    // as noise, so only sharp ridge edges are traced (crystals keep tighter
    // facets, so they use a lower threshold and stay more graphic).
    const wireGeo = new THREE.EdgesGeometry(this.geometry, shapeType === 'crystal' ? 22 : 42);
    this.wireMesh = new THREE.LineSegments(wireGeo, this.shared.wireMaterial);
    this.mesh.add(this.wireMesh);
  }

  private generateGeometry(
    baseRadius: number,
    shapeType: AsteroidShapeType,
    baseColor: THREE.Color
  ): THREE.BufferGeometry {
    let geo: THREE.BufferGeometry;

    // Per-rock noise seed so identical shape types still look different
    const seed = Math.random() * 100;
    // Feature scale: bigger rocks get proportionally similar-sized lumps
    const freq = 3.2 / baseRadius;

    /**
     * Radially displaces every vertex by coherent fBm noise plus a second,
     * higher-frequency octave for surface grit, then bakes a cavity mask into
     * vertex colours (recessed vertices get darker, peaks get a slight
     * mineral highlight).
     */
    const sculpt = (
      target: THREE.BufferGeometry,
      lumpAmount: number,
      gritAmount: number,
      transform?: (v: THREE.Vector3) => void
    ) => {
      const pos = target.attributes.position;
      const colors = new Float32Array(pos.count * 3);
      const v = new THREE.Vector3();

      for (let i = 0; i < pos.count; i++) {
        v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
        const len = v.length() || 1;

        const nx = v.x * freq + seed;
        const ny = v.y * freq + seed;
        const nz = v.z * freq + seed;

        const lump = fbm3(nx, ny, nz);
        const grit = valueNoise3(nx * 3.7, ny * 3.7, nz * 3.7);
        const displacement = lump * baseRadius * lumpAmount + grit * baseRadius * gritAmount;

        v.setLength(Math.max(baseRadius * 0.45, len + displacement));
        if (transform) transform(v);
        pos.setXYZ(i, v.x, v.y, v.z);

        // Cavity mask from the same noise: -1 = deep crevice, +1 = ridge.
        // Multiplied by the rock's base colour, which the shared white material
        // then passes straight through to the diffuse term.
        const cavity = THREE.MathUtils.clamp(lump * 0.5 + 0.5, 0, 1);
        const shade = 0.62 + cavity * 0.55;
        const warm = 0.62 + cavity * 0.62;
        colors[i * 3] = warm * baseColor.r;
        colors[i * 3 + 1] = shade * baseColor.g;
        colors[i * 3 + 2] = shade * 0.98 * baseColor.b;
      }

      pos.needsUpdate = true;
      target.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    };

    if (shapeType === 'crystal') {
      // Faceted mineral shard - keep hard planes, only shift the facet tips
      geo = new THREE.OctahedronGeometry(baseRadius, 2);
      sculpt(geo, 0.14, 0.03, (v) => {
        v.z *= 0.82;
        v.y *= 1.12;
      });
    } else if (shapeType === 'oblong') {
      geo = new THREE.IcosahedronGeometry(baseRadius, 3);
      const stretchX = 1.35 + Math.random() * 0.3;
      const squeezeY = 0.75 + Math.random() * 0.15;
      sculpt(geo, 0.2, 0.05, (v) => {
        v.x *= stretchX;
        v.y *= squeezeY;
      });
    } else if (shapeType === 'smooth') {
      // Weathered, near-spherical body: low lumps, fine surface pitting
      geo = new THREE.IcosahedronGeometry(baseRadius, 3);
      sculpt(geo, 0.1, 0.035);
    } else {
      // 'craggy' & 'boulder' - the heavy hero rocks get the most subdivision
      const detail = baseRadius > 32 ? 4 : 3;
      geo = new THREE.IcosahedronGeometry(baseRadius, detail);
      sculpt(geo, 0.26, 0.07);
    }

    geo.computeVertexNormals();
    return geo;
  }

  /**
   * The theme is a property of the sector, not of an individual rock, so this
   * retints the shared materials. Calling it per asteroid is redundant but
   * harmless, and keeps the existing call sites working.
   */
  public setThemeColor(colorHex: number): void {
    this.shared.wireMaterial.color.setHex(colorHex);
    // Mutating in place keeps the live shader uniform in sync
    this.shared.rimColor.setHex(colorHex).multiplyScalar(0.5);
  }

  public update(): void {
    this.mesh.rotation.x += this.rotSpeedX;
    this.mesh.rotation.y += this.rotSpeedY;
    this.mesh.rotation.z += this.rotSpeedZ;
  }

  /**
   * @param effectiveRadius Final collision radius of whatever is hitting this
   *   rock (the player's shield shell or its leniency-adjusted hull). Any
   *   fairness discount is applied by the caller, not here.
   */
  public collidesWith(clusterX: number, clusterY: number, px: number, py: number, effectiveRadius: number): boolean {
    const worldX = clusterX + this.offsetX;
    const worldY = clusterY + this.offsetY;
    const dx = px - worldX;
    const dy = py - worldY;
    const distSq = dx * dx + dy * dy;
    const hitDist = this.collisionRadius + effectiveRadius;
    return distSq < hitDist * hitDist;
  }

  public getWorldPosition(clusterX: number, clusterY: number): { x: number; y: number } {
    return {
      x: clusterX + this.offsetX,
      y: clusterY + this.offsetY
    };
  }

  /** Only the geometry is owned by this rock; the materials are field-wide. */
  public dispose(): void {
    this.geometry.dispose();
    this.wireMesh.geometry.dispose();
  }
}

export type FormationType = 'standard_gate' | 'staggered_cluster' | 'middle_island' | 'asteroid_swarm';

export class ObstaclePair3D {
  private scene: THREE.Scene;
  public group: THREE.Group;
  public x: number;
  public passed = false;
  public gapY: number;
  private initialGapY: number;
  public gap: number;
  public formationType: FormationType;

  public asteroids: ProceduralAsteroid3D[] = [];

  private oscillates: boolean;
  private oscAmp: number;
  private oscSpeed: number;
  private time: number;

  // Moving (drifting) asteroid formation state
  public isMoving: boolean;
  private moveSpeed: number;
  private moveDir: number;
  private moveOffset: number;
  private moveRange: number;
  private countScale: number;

  constructor(
    scene: THREE.Scene,
    startX: number,
    bounds: Bounds,
    config: DifficultyConfig,
    score: number,
    currentDifficulty: DifficultyKey,
    themeColorHex: number,
    verticalSpeed = 0,
    countScale = 1,
    travelRange = 90
  ) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.x = startX;

    // Moving formation setup: a mover drifts vertically at a constant speed,
    // bouncing back once it reaches travelRange from its spawn line. Movers
    // carry fewer rocks (countScale) so the screen stays fair.
    this.moveSpeed = verticalSpeed;
    this.isMoving = verticalSpeed > 0;
    this.moveDir = Math.random() < 0.5 ? 1 : -1;
    this.moveOffset = 0;
    this.moveRange = travelRange;
    this.countScale = this.isMoving ? countScale : 1;

    // Pick formation type dynamically
    const randFormation = Math.random();
    if (randFormation < 0.45) {
      this.formationType = 'standard_gate';
    } else if (randFormation < 0.7) {
      this.formationType = 'staggered_cluster';
    } else if (randFormation < 0.88 && score > 2) {
      this.formationType = 'middle_island';
    } else {
      this.formationType = 'asteroid_swarm';
    }

    this.gap = Math.max(config.minGap, config.baseGap - score * 1.5);
    const minPadding = 45;
    const range = bounds.height - this.gap - minPadding * 2;
    this.gapY = Math.random() * range + minPadding + this.gap / 2 - bounds.halfHeight;
    this.initialGapY = this.gapY;

    this.buildFormation(themeColorHex);

    // Oscillation feature for higher difficulties. A mover never also
    // oscillates — its drift is the sole vertical motion.
    this.oscillates =
      !this.isMoving &&
      Math.random() < config.oscillateChance &&
      score > (currentDifficulty === 'exhard' ? 0 : 3);
    this.oscAmp = Math.random() * 32 + 12;
    this.oscSpeed = Math.random() * 0.028 + 0.014;
    this.time = Math.random() * 100;

    this.group.position.set(this.x, 0, 0);
    this.scene.add(this.group);
  }

  /** Scale a rock count by the formation's countScale (movers carry fewer). */
  private scaleCount(n: number): number {
    return Math.max(1, Math.round(n * this.countScale));
  }

  private getRandomShape(): AsteroidShapeType {
    const shapes: AsteroidShapeType[] = ['craggy', 'oblong', 'crystal', 'smooth', 'boulder'];
    return shapes[Math.floor(Math.random() * shapes.length)];
  }

  private buildFormation(themeColorHex: number): void {
    const topEdgeY = this.gapY + this.gap / 2;
    const botEdgeY = this.gapY - this.gap / 2;

    if (this.formationType === 'middle_island') {
      // Middle floating island with upper and lower gap corridors
      const islandR = rockRadius(Math.random() * 10 + 22);
      const island = new ProceduralAsteroid3D(0, this.gapY, islandR, themeColorHex, 'crystal');
      this.asteroids.push(island);
      this.group.add(island.mesh);

      // Top ceiling rock
      const topR = rockRadius(Math.random() * 14 + 30);
      const top = new ProceduralAsteroid3D(
        (Math.random() - 0.5) * 20,
        topEdgeY + topR + 25,
        topR,
        themeColorHex,
        this.getRandomShape()
      );
      this.asteroids.push(top);
      this.group.add(top.mesh);

      // Bottom floor rock
      const botR = rockRadius(Math.random() * 14 + 30);
      const bot = new ProceduralAsteroid3D(
        (Math.random() - 0.5) * 20,
        botEdgeY - botR - 25,
        botR,
        themeColorHex,
        this.getRandomShape()
      );
      this.asteroids.push(bot);
      this.group.add(bot.mesh);
    } else if (this.formationType === 'staggered_cluster') {
      // Top cluster shifted left/right, bottom shifted opposite
      const topShiftX = (Math.random() - 0.5) * 40;
      const botShiftX = -topShiftX;

      // Top Cluster
      const numTop = this.scaleCount(Math.floor(Math.random() * 3) + 2);
      let currentTopY = topEdgeY;
      for (let i = 0; i < numTop; i++) {
        const r = rockRadius(Math.random() * 14 + 24);
        const ox = topShiftX + (Math.random() - 0.5) * 25;
        const oy = currentTopY + r;
        const ast = new ProceduralAsteroid3D(ox, oy, r, themeColorHex, this.getRandomShape());
        this.asteroids.push(ast);
        this.group.add(ast.mesh);
        currentTopY += r * 1.5;
      }

      // Bottom Cluster
      const numBot = this.scaleCount(Math.floor(Math.random() * 3) + 2);
      let currentBotY = botEdgeY;
      for (let i = 0; i < numBot; i++) {
        const r = rockRadius(Math.random() * 14 + 24);
        const ox = botShiftX + (Math.random() - 0.5) * 25;
        const oy = currentBotY - r;
        const ast = new ProceduralAsteroid3D(ox, oy, r, themeColorHex, this.getRandomShape());
        this.asteroids.push(ast);
        this.group.add(ast.mesh);
        currentBotY -= r * 1.5;
      }
    } else if (this.formationType === 'asteroid_swarm') {
      // Scattered asteroid belt cluster with weaving path
      const count = this.scaleCount(Math.floor(Math.random() * 2) + 3);
      for (let i = 0; i < count; i++) {
        const r = rockRadius(Math.random() * 12 + 20);
        const ox = (Math.random() - 0.5) * 70;
        // Keep rocks outside gap center
        const isTop = i % 2 === 0;
        const oy = isTop
          ? topEdgeY + r + Math.random() * 30
          : botEdgeY - r - Math.random() * 30;
        const ast = new ProceduralAsteroid3D(ox, oy, r, themeColorHex, this.getRandomShape());
        this.asteroids.push(ast);
        this.group.add(ast.mesh);
      }
    } else {
      // Standard Gate Formation
      // Top Cluster
      const numTop = this.scaleCount(Math.floor(Math.random() * 3) + 2);
      let currentTopY = topEdgeY;
      for (let i = 0; i < numTop; i++) {
        const r = rockRadius(Math.random() * 14 + 25);
        const ox = (Math.random() - 0.5) * 25;
        const oy = currentTopY + r;
        const ast = new ProceduralAsteroid3D(ox, oy, r, themeColorHex, this.getRandomShape());
        this.asteroids.push(ast);
        this.group.add(ast.mesh);
        currentTopY += r * 1.5;
      }

      // Bottom Cluster
      const numBot = this.scaleCount(Math.floor(Math.random() * 3) + 2);
      let currentBotY = botEdgeY;
      for (let i = 0; i < numBot; i++) {
        const r = rockRadius(Math.random() * 14 + 25);
        const ox = (Math.random() - 0.5) * 25;
        const oy = currentBotY - r;
        const ast = new ProceduralAsteroid3D(ox, oy, r, themeColorHex, this.getRandomShape());
        this.asteroids.push(ast);
        this.group.add(ast.mesh);
        currentBotY -= r * 1.5;
      }
    }
  }

  public setThemeColor(colorHex: number): void {
    this.asteroids.forEach((a) => a.setThemeColor(colorHex));
  }

  public update(gameSpeed: number): void {
    this.x -= gameSpeed;

    if (this.isMoving) {
      // Constant-speed vertical drift that bounces at the travel limits.
      this.moveOffset += this.moveSpeed * this.moveDir;
      if (this.moveOffset > this.moveRange) {
        this.moveOffset = this.moveRange;
        this.moveDir = -1;
      } else if (this.moveOffset < -this.moveRange) {
        this.moveOffset = -this.moveRange;
        this.moveDir = 1;
      }
      this.gapY = this.initialGapY + this.moveOffset;
      this.group.position.y = this.moveOffset;
    } else if (this.oscillates) {
      this.time += this.oscSpeed;
      const offset = Math.sin(this.time) * this.oscAmp;
      this.gapY = this.initialGapY + offset;
      this.group.position.y = offset;
    }

    this.group.position.x = this.x;

    this.asteroids.forEach((a) => a.update());
  }

  public collidesWith(p: PlayerShip): boolean {
    const clusterY = this.group.position.y;
    // With the Reflect shield up, the shell is the surface the rock strikes, so
    // it collides at its full rendered radius. Bare hull keeps the arcade
    // leniency that makes tight gaps feel fair.
    const shieldRadius = p.shieldCollisionRadius;
    const effectiveRadius =
      shieldRadius === null
        ? p.radius * HULL_HIT_LENIENCY
        : Math.max(p.radius * HULL_HIT_LENIENCY, shieldRadius);

    for (const a of this.asteroids) {
      if (a.collidesWith(this.x, clusterY, p.x, p.y, effectiveRadius)) return true;
    }
    return false;
  }

  public destroy(): void {
    this.scene.remove(this.group);
    this.asteroids.forEach((a) => a.dispose());
  }
}
