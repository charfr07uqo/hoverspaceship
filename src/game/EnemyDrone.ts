import * as THREE from 'three';
import { PlayerShip } from './PlayerShip';
import { EnemyVariant, STANDARD_ENEMY_VARIANT } from '../constants/gameConfig';
import { makeFin, makePlanform, makeRevolvedHull } from './hullGeometry';

/**
 * Hostile interceptor.
 *
 * Orientation matters here and used to be wrong. Drones fly right-to-left, so
 * `update()` aligns the group with its velocity vector, which sits at roughly
 * 180 degrees. That means the model must be built nose-first along local +X
 * exactly like the player hulls: the group rotation is what turns it around to
 * face the player. Building it nose-to--X (as it was) put the engine end and
 * the flat cone base toward the player.
 */
export class EnemyDrone3D {
  public group: THREE.Group;
  private scene: THREE.Scene;

  public x: number;
  public y: number;
  public z = 0;
  public vx = 0;
  public vy = 0;
  public radius = 10;
  public scale = 0.75;
  public passed = false;
  public alive = true;

  private forwardSpeed: number;
  private trackingAgility: number;
  private animTime = 0;
  private speedMultiplier: number;

  public variantKey: string;
  /** Variant accent, reused by the engine so wrecks explode in the drone's colour. */
  public accentColorHex: number;

  /** Pulsing sensor eye. */
  private eyeMesh: THREE.Mesh;
  private eyeMat: THREE.MeshBasicMaterial;
  private thrusterLight: THREE.PointLight;
  /** Exhaust cones, scaled and faded per frame to flicker. */
  private plumes: THREE.Mesh[] = [];
  private plumeMat: THREE.MeshBasicMaterial;
  /** Wing/mandible parts that flex slightly while tracking. */
  private flexParts: THREE.Object3D[] = [];
  /** Every material this drone owns, disposed once on destroy. */
  private ownedMaterials: THREE.Material[] = [];

  constructor(
    scene: THREE.Scene,
    startX: number,
    startY: number,
    level: number,
    baseGameSpeed: number,
    variant: EnemyVariant = STANDARD_ENEMY_VARIANT
  ) {
    this.scene = scene;
    this.x = startX;
    this.y = startY;
    this.group = new THREE.Group();
    this.variantKey = variant.key;
    this.speedMultiplier = variant.speedMultiplier;

    // Scale gets slightly larger with level + small variance, then the variant
    // size multiplier is applied on top (heavy = bigger, scout = half size).
    const levelSizeBonus = (level - 2) * 0.14;
    const variance = (Math.random() - 0.5) * 0.18;
    const baseScale = Math.max(0.65, Math.min(1.45, 0.75 + levelSizeBonus + variance));
    this.scale = baseScale * variant.sizeMultiplier;
    this.radius = 10 * this.scale;

    // Speeds: Level 2 starts very slow, scales up gently on level 3+.
    // The variant speed multiplier makes heavy drones slower and scouts faster.
    const levelSpeedBonus = Math.max(0, (level - 2)) * 0.35;
    this.forwardSpeed =
      (baseGameSpeed * (1.1 + levelSpeedBonus * 0.15) + (Math.random() * 0.4)) * variant.speedMultiplier;
    this.trackingAgility = 0.018 + Math.max(0, (level - 2)) * 0.008;

    const accent = variant.accentColorHex;
    this.accentColorHex = accent;

    // --- Shared materials for this drone -----------------------------------
    // Dark faceted hull with an accent bleed, matte armour plating, additive
    // accent glow. One set per drone because the accent is per variant.
    const hullMat = this.own(
      new THREE.MeshStandardMaterial({
        color: 0x141418,
        emissive: accent,
        emissiveIntensity: 0.28,
        roughness: 0.3,
        metalness: 0.88,
        flatShading: true
      })
    );
    const plateMat = this.own(
      new THREE.MeshStandardMaterial({
        color: 0x0b0b0f,
        emissive: accent,
        emissiveIntensity: 0.12,
        roughness: 0.5,
        metalness: 0.8
      })
    );
    const edgeMat = this.own(
      new THREE.LineBasicMaterial({
        color: accent,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
    );
    const glowMat = this.own(
      new THREE.MeshBasicMaterial({
        color: accent,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
    );
    this.plumeMat = this.own(
      new THREE.MeshBasicMaterial({
        color: accent,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide
      })
    );
    this.eyeMat = this.own(
      new THREE.MeshBasicMaterial({
        color: accent,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
    );

    const s = this.scale;
    /** Adds a mesh at a hull-local position, scaled into world units. */
    const add = (
      geo: THREE.BufferGeometry,
      mat: THREE.Material,
      pos: [number, number, number] = [0, 0, 0],
      rot: [number, number, number] = [0, 0, 0]
    ): THREE.Mesh => {
      geo.scale(s, s, s);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(pos[0] * s, pos[1] * s, pos[2] * s);
      mesh.rotation.set(rot[0], rot[1], rot[2]);
      this.group.add(mesh);
      return mesh;
    };
    /** Accent wireframe traced from a geometry that is already world-scaled. */
    const addEdges = (geo: THREE.BufferGeometry, from: THREE.Mesh, threshold = 26): void => {
      const lines = new THREE.LineSegments(new THREE.EdgesGeometry(geo, threshold), edgeMat);
      lines.position.copy(from.position);
      lines.rotation.copy(from.rotation);
      this.group.add(lines);
    };

    if (variant.key === 'heavy') {
      // -------------------------------------------------------------------
      // Heavy: a slab-sided battering ram. Blunt armoured prow, wide shoulder
      // plates, twin engines. Reads as something you do not want to trade
      // paint with.
      // -------------------------------------------------------------------
      const hullGeo = makePlanform(
        [[15, 1.6], [10, 6.0], [2, 8.0], [-10, 8.0], [-13, 5.0], [-13, 1.4]],
        11,
        0.8
      );
      const hull = add(hullGeo, hullMat);
      addEdges(hullGeo, hull);

      // Armoured prow wedge and a pair of cutters flanking it
      add(makeFin([[6, -5.0], [17, -1.4], [17, 1.4], [6, 5.0]], 6.0, 0.4), plateMat);
      for (const side of [1, -1]) {
        add(makeFin([[4, -3.2], [12.5, -0.8], [12.5, 0.8], [4, 3.2]], 2.2), plateMat, [0, 0, side * 5.6]);
      }

      // Shoulder plates standing off the flanks, angled back like tusks
      for (const side of [1, -1]) {
        const plate = add(
          makePlanform([[8, 0.6], [1, 4.2], [-11, 4.2], [-13, 1.0]], 2.4, 0.3),
          plateMat,
          [0, 0, side * 8.6],
          [side * 0.3, 0, 0]
        );
        this.flexParts.push(plate);
      }

      // Dorsal and ventral ridge armour
      for (const py of [5.4, -5.4]) {
        add(makePlanform([[11, 1.0], [5, 4.0], [-9, 4.0], [-11, 1.0]], 1.4, 0.25), plateMat, [0, py, 0]);
      }

      // Sensor cluster recessed in a cowl
      add(new THREE.TorusGeometry(3.0, 0.9, 8, 16).rotateY(Math.PI / 2), plateMat, [11.5, 1.2, 0]);
      this.eyeMesh = add(new THREE.SphereGeometry(2.3, 12, 10), this.eyeMat, [12.2, 1.2, 0]);

      // Twin engines with glowing throats
      for (const side of [1, -1]) {
        const housing = new THREE.CylinderGeometry(3.4, 3.9, 5.0, 14);
        housing.rotateZ(-Math.PI / 2);
        add(housing, plateMat, [-14.0, 0, side * 4.2]);
        add(new THREE.TorusGeometry(2.6, 0.5, 8, 16).rotateY(Math.PI / 2), glowMat, [-16.4, 0, side * 4.2]);
        this.addPlume(-17.5, 0, side * 4.2, 2.9, 13);
      }
    } else if (variant.key === 'scout') {
      // -------------------------------------------------------------------
      // Scout: a wasp. Thin needle body, long forward mandible antennae, high
      // swept wings and one oversized eye. Small and twitchy.
      // -------------------------------------------------------------------
      const hullGeo = makeRevolvedHull(
        [[0, -12], [2.2, -11.4], [3.4, -8], [4.0, -2], [3.9, 3], [3.0, 8], [1.6, 12], [0, 15]],
        0.9,
        0.85,
        14
      );
      add(hullGeo, hullMat);

      // Long mandible antennae reaching ahead of the nose
      for (const side of [1, -1]) {
        const mandible = new THREE.CylinderGeometry(0.28, 0.7, 16, 6);
        mandible.rotateZ(-Math.PI / 2);
        const arm = add(mandible, plateMat, [21, 0, side * 1.9], [0, side * -0.12, 0]);
        this.flexParts.push(arm);
        add(new THREE.SphereGeometry(0.7, 8, 6), glowMat, [29, 0, side * 2.8]);
      }

      // High swept wings, sharply raked back
      const wingGeo = makePlanform([[3, 1.2], [-4, 6.5], [-13, 11.5], [-15, 10.8], [-8, 5.0], [-7, 1.2]], 0.8, 0.25);
      const wing = add(wingGeo, plateMat, [0, 2.2, 0]);
      addEdges(wingGeo, wing);
      this.flexParts.push(wing);

      // Single canted tail blade
      add(makeFin([[-5, 0], [3, 0], [-1, 8], [-5, 6.5]], 0.6), plateMat, [-9, 2.0, 0]);

      // Oversized single eye
      this.eyeMesh = add(new THREE.SphereGeometry(2.6, 12, 10), this.eyeMat, [11, 0.8, 0]);
      add(new THREE.TorusGeometry(2.4, 0.6, 8, 14).rotateY(Math.PI / 2), plateMat, [10.0, 0.8, 0]);

      // One hot little thruster, mounted high
      add(new THREE.TorusGeometry(2.0, 0.4, 8, 14).rotateY(Math.PI / 2), glowMat, [-12.6, 0.6, 0]);
      this.addPlume(-13.6, 0.6, 0, 2.1, 14);
    } else {
      // -------------------------------------------------------------------
      // Standard: a lean interceptor. Needle nose, cranked delta wings raked
      // back toward the tail, twin canted tail fins, one engine.
      // -------------------------------------------------------------------
      const hullGeo = makeRevolvedHull(
        [
          [0, -13], [3.0, -12.5], [4.8, -10.5], [5.8, -6], [6.2, -1], [6.0, 3],
          [5.0, 7.5], [3.6, 11], [2.0, 14], [0, 16.5]
        ],
        0.78,
        1.0,
        16
      );
      add(hullGeo, hullMat);

      // Cheek strakes running back from the nose, knife-edged
      const strakeGeo = makePlanform([[16.5, 0.4], [4, 6.2], [-4, 7.0], [-9, 4.6], [-9, 0.4]], 0.9, 0.3);
      const strake = add(strakeGeo, plateMat, [0, 0.4, 0]);
      addEdges(strakeGeo, strake);

      // Cranked delta wings, swept back so the drone reads as diving forward
      const wingGeo = makePlanform(
        [[2, 1.4], [-5, 7.0], [-14, 12.0], [-16.5, 11.4], [-10, 6.0], [-8.5, 1.4]],
        1.1,
        0.35
      );
      const wing = add(wingGeo, plateMat, [0, -0.8, 0]);
      addEdges(wingGeo, wing);
      this.flexParts.push(wing);

      // Twin tail fins, canted outward
      const finGeo = makeFin([[-4.5, 0], [3.0, 0], [-0.5, 7.5], [-4.0, 6.2]], 0.7);
      for (const side of [1, -1]) {
        add(finGeo.clone(), plateMat, [-9.5, 0.4, side * 3.4], [side * 0.42, 0, 0]);
      }

      // Belly sensor pod plus the eye in a housing ring
      add(new THREE.SphereGeometry(1.9, 12, 8).scale(1.8, 0.7, 0.8), plateMat, [6.0, -3.4, 0]);
      add(new THREE.TorusGeometry(2.7, 0.7, 8, 16).rotateY(Math.PI / 2), plateMat, [10.5, 0.6, 0]);
      this.eyeMesh = add(new THREE.SphereGeometry(2.4, 12, 10), this.eyeMat, [11.4, 0.6, 0]);

      // Engine collar at the tail, where an engine belongs
      const collar = new THREE.CylinderGeometry(4.4, 5.0, 3.4, 14);
      collar.rotateZ(-Math.PI / 2);
      add(collar, plateMat, [-13.2, 0, 0]);
      add(new THREE.TorusGeometry(3.4, 0.5, 8, 18).rotateY(Math.PI / 2), glowMat, [-15.0, 0, 0]);
      this.addPlume(-16.0, 0, 0, 3.6, 16);
    }

    // Thruster light sits behind the drone, so the glow trails it
    this.thrusterLight = new THREE.PointLight(accent, 1.8, 80 * this.scale);
    this.thrusterLight.position.set(-15 * this.scale, 0, 0);
    this.group.add(this.thrusterLight);

    this.group.position.set(this.x, this.y, this.z);
    this.scene.add(this.group);
  }

  /** Registers a material for disposal and returns it. */
  private own<T extends THREE.Material>(mat: T): T {
    this.ownedMaterials.push(mat);
    return mat;
  }

  /**
   * Exhaust plume: an open cone opening backwards from the nozzle, plus a
   * brighter inner core. Cheap additive geometry rather than the player's
   * shader plume, since up to ten drones can be on screen at once.
   */
  private addPlume(x: number, y: number, z: number, radius: number, length: number): void {
    const s = this.scale;
    for (const [rMul, lMul, mat] of [
      [1.0, 1.0, this.plumeMat],
      [0.5, 0.6, this.eyeMat]
    ] as Array<[number, number, THREE.Material]>) {
      const geo = new THREE.ConeGeometry(radius * rMul * s, length * lMul * s, 10, 1, true);
      // Cone apex points +Y by default; turn it to trail backwards down -X.
      geo.rotateZ(Math.PI / 2);
      const plume = new THREE.Mesh(geo, mat);
      plume.position.set((x - (length * lMul) / 2) * s, y * s, z * s);
      plume.renderOrder = 2;
      plume.userData.baseScale = 1;
      this.plumes.push(plume);
      this.group.add(plume);
    }
  }

  public update(playerY: number, currentSpeed: number): void {
    this.animTime += 0.08;

    // Move forward (right to left towards player). The floor is scaled by the
    // variant speed multiplier so heavy drones stay slower and scouts stay faster.
    const activeForwardSpeed = Math.max(this.forwardSpeed, currentSpeed * 1.08 * this.speedMultiplier);
    this.x -= activeForwardSpeed;

    // Gentle homing tracking towards player's Y position
    const dy = playerY - this.y;
    this.vy += (dy * this.trackingAgility - this.vy) * 0.08;
    this.y += this.vy;

    // Apply Position & Bank rotation towards movement vector
    this.group.position.set(this.x, this.y, this.z);

    // Aligns local +X with the velocity vector, which points left, so this
    // lands near 180 degrees and the nose ends up facing the player.
    const angle = Math.atan2(this.vy, -this.forwardSpeed);
    this.group.rotation.z = angle;
    this.group.rotation.x = Math.sin(this.animTime) * 0.15;

    // Wings and mandibles flex a little as the drone corrects its intercept
    const flex = Math.sin(this.animTime * 1.6) * 0.05 + this.vy * 0.012;
    for (let i = 0; i < this.flexParts.length; i++) {
      const part = this.flexParts[i];
      part.rotation.z = flex * (i % 2 === 0 ? 1 : -1);
    }

    // Pulse cyber eye & thruster
    const beat = 0.75 + Math.abs(Math.sin(this.animTime * 2.5)) * 0.25;
    this.eyeMat.opacity = beat;
    this.eyeMesh.scale.setScalar(0.9 + beat * 0.15);
    this.thrusterLight.intensity = 1.6 + Math.sin(this.animTime * 2.5) * 0.6;

    // Plume flicker: length jitters, opacity breathes with the same beat
    const flicker = 0.85 + Math.sin(this.animTime * 7.3) * 0.12 + Math.sin(this.animTime * 3.1) * 0.06;
    this.plumeMat.opacity = 0.35 + flicker * 0.3;
    for (const plume of this.plumes) {
      plume.scale.set(flicker, 1, 1);
    }
  }

  public collidesWith(player: PlayerShip): boolean {
    const dx = this.x - player.x;
    const dy = this.y - player.y;
    const distSq = dx * dx + dy * dy;
    // While the Reflect shield is up the shell is what the drone rams into, so
    // test against the shield radius rather than the hull.
    const combinedRadius = this.radius + player.threatCollisionRadius;
    return distSq < combinedRadius * combinedRadius;
  }

  public destroy(): void {
    this.alive = false;
    this.scene.remove(this.group);

    // Geometry is unique per mesh; materials are shared across the drone, so
    // they are tracked separately and disposed exactly once.
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    });
    for (const mat of this.ownedMaterials) mat.dispose();
    this.ownedMaterials = [];
    this.plumes = [];
    this.flexParts = [];
  }
}
