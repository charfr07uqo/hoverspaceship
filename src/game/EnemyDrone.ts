import * as THREE from 'three';
import { PlayerShip } from './PlayerShip';
import { EnemyVariant, STANDARD_ENEMY_VARIANT } from '../constants/gameConfig';

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

  private bodyMesh: THREE.Mesh;
  private edgeMesh: THREE.LineSegments;
  private eyeMesh: THREE.Mesh;
  private thrusterLight: THREE.PointLight;

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

    // Variant accent color for the fuselage glow, edges, eye and thruster.
    const accent = variant.accentColorHex;

    // Build 3D Alien Drone Model
    // 1. Sharp Crimson Fuselage
    // 6-sided with a length-wise segment so the hull has a faceted spine
    // instead of the old flat 4-sided pyramid.
    const bodyGeo = new THREE.ConeGeometry(8 * this.scale, 26 * this.scale, 6, 2);
    bodyGeo.rotateZ(Math.PI / 2); // Pointing left towards player
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x18181b,
      emissive: accent,
      emissiveIntensity: 0.4,
      roughness: 0.25,
      metalness: 0.85,
      flatShading: true
    });
    this.bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
    this.group.add(this.bodyMesh);

    // 2. Glowing Neon Crimson Edge Wireframe
    const edgeGeo = new THREE.EdgesGeometry(bodyGeo);
    const edgeMat = new THREE.LineBasicMaterial({
      color: accent,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    this.edgeMesh = new THREE.LineSegments(edgeGeo, edgeMat);
    this.group.add(this.edgeMesh);

    // 2b. Swept attack fins + rear engine collar for silhouette detail
    const finShape = new THREE.Shape();
    finShape.moveTo(0, 0);
    finShape.lineTo(-14 * this.scale, 0);
    finShape.lineTo(-4 * this.scale, 11 * this.scale);
    finShape.closePath();
    const finGeo = new THREE.ExtrudeGeometry(finShape, { depth: 0.8 * this.scale, bevelEnabled: false });
    finGeo.rotateY(Math.PI / 2);
    const plateMat = new THREE.MeshStandardMaterial({
      color: 0x0f0f12,
      emissive: accent,
      emissiveIntensity: 0.18,
      roughness: 0.35,
      metalness: 0.9
    });
    for (const side of [1, -1]) {
      const fin = new THREE.Mesh(finGeo, plateMat);
      fin.position.set(6 * this.scale, 0, side * 3 * this.scale);
      fin.scale.z = side;
      this.group.add(fin);
    }

    const collarGeo = new THREE.TorusGeometry(6 * this.scale, 1.2 * this.scale, 8, 16);
    collarGeo.rotateY(Math.PI / 2);
    const collar = new THREE.Mesh(collarGeo, plateMat);
    collar.position.set(11 * this.scale, 0, 0);
    this.group.add(collar);

    // 3. Central Glowing Cyber Eye / Sensor Core
    const eyeGeo = new THREE.SphereGeometry(3 * this.scale, 8, 8);
    const eyeMat = new THREE.MeshBasicMaterial({
      color: accent,
      blending: THREE.AdditiveBlending
    });
    this.eyeMesh = new THREE.Mesh(eyeGeo, eyeMat);
    this.eyeMesh.position.set(-6 * this.scale, 0, 0);
    this.group.add(this.eyeMesh);

    // 4. Glowing Red Thruster Light
    this.thrusterLight = new THREE.PointLight(accent, 1.8, 80 * this.scale);
    this.thrusterLight.position.set(12 * this.scale, 0, 0);
    this.group.add(this.thrusterLight);

    this.group.position.set(this.x, this.y, this.z);
    this.scene.add(this.group);
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

    const angle = Math.atan2(this.vy, -this.forwardSpeed);
    this.group.rotation.z = angle;
    this.group.rotation.x = Math.sin(this.animTime) * 0.15;

    // Pulse cyber eye & thruster
    this.thrusterLight.intensity = 1.6 + Math.sin(this.animTime * 2.5) * 0.6;
  }

  public collidesWith(player: PlayerShip): boolean {
    const dx = this.x - player.x;
    const dy = this.y - player.y;
    const distSq = dx * dx + dy * dy;
    const combinedRadius = this.radius + player.radius;
    return distSq < combinedRadius * combinedRadius;
  }

  public destroy(): void {
    this.alive = false;
    this.scene.remove(this.group);
    this.bodyMesh.geometry.dispose();
    (this.bodyMesh.material as THREE.Material).dispose();
    this.edgeMesh.geometry.dispose();
    (this.edgeMesh.material as THREE.Material).dispose();
    this.eyeMesh.geometry.dispose();
    (this.eyeMesh.material as THREE.Material).dispose();

    // Fins/collar were added straight to the group; dispose them generically.
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh === this.bodyMesh || mesh === this.eyeMesh || (mesh as unknown) === this.edgeMesh) return;
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) {
        const mat = mesh.material as THREE.Material | THREE.Material[];
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat.dispose();
      }
    });
  }
}
