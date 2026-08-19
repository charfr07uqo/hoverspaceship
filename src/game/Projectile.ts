import * as THREE from 'three';

/**
 * Auto Cannon energy bolt fired from the player ship toward an enemy interceptor.
 * Travels in a fixed aimed direction and self-expires after a short lifetime.
 */
/** Minimal shape of a homing target (an enemy drone). */
interface ProjectileTarget {
  x: number;
  y: number;
  alive: boolean;
}

// Fairly slow so the bolt is clearly visible, but quick enough to run down
// enemies that are closing on the player.
const PROJECTILE_SPEED = 6;
// How sharply the bolt curves toward its target each frame (0..1).
const HOMING_TURN = 0.12;

export class Projectile3D {
  public group: THREE.Group;
  private scene: THREE.Scene;

  public x: number;
  public y: number;
  public z = 0;
  public vx: number;
  public vy: number;
  public radius = 7;
  public life = 3.2; // seconds before it fizzles out

  private target: ProjectileTarget | null;

  private mesh: THREE.Mesh;
  private glowMesh: THREE.Mesh;
  private light: THREE.PointLight;

  constructor(
    scene: THREE.Scene,
    x: number,
    y: number,
    dirX: number,
    dirY: number,
    colorHex = 0x38bdf8,
    target: ProjectileTarget | null = null
  ) {
    this.scene = scene;
    this.x = x;
    this.y = y;
    this.target = target;

    this.vx = dirX * PROJECTILE_SPEED;
    this.vy = dirY * PROJECTILE_SPEED;

    this.group = new THREE.Group();

    const coreGeo = new THREE.SphereGeometry(3.2, 12, 12);
    const coreMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      blending: THREE.AdditiveBlending
    });
    this.mesh = new THREE.Mesh(coreGeo, coreMat);
    this.group.add(this.mesh);

    const glowGeo = new THREE.SphereGeometry(6, 12, 12);
    const glowMat = new THREE.MeshBasicMaterial({
      color: colorHex,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    this.glowMesh = new THREE.Mesh(glowGeo, glowMat);
    this.group.add(this.glowMesh);

    this.light = new THREE.PointLight(colorHex, 2.0, 90);
    this.group.add(this.light);

    this.group.position.set(this.x, this.y, this.z);
    this.scene.add(this.group);
  }

  public update(dt: number): void {
    // Gently home toward the target while it's still alive so the slow bolt
    // still connects with enemies that weave around.
    if (this.target && this.target.alive) {
      const dx = this.target.x - this.x;
      const dy = this.target.y - this.y;
      const len = Math.hypot(dx, dy) || 1;
      const desiredVx = (dx / len) * PROJECTILE_SPEED;
      const desiredVy = (dy / len) * PROJECTILE_SPEED;
      this.vx += (desiredVx - this.vx) * HOMING_TURN;
      this.vy += (desiredVy - this.vy) * HOMING_TURN;
      // Keep a constant travel speed
      const spd = Math.hypot(this.vx, this.vy) || 1;
      this.vx = (this.vx / spd) * PROJECTILE_SPEED;
      this.vy = (this.vy / spd) * PROJECTILE_SPEED;
    }

    this.x += this.vx;
    this.y += this.vy;
    this.group.position.set(this.x, this.y, this.z);
    this.life -= dt;
    const pulse = 1 + Math.sin(performance.now() * 0.02) * 0.15;
    this.glowMesh.scale.set(pulse, pulse, pulse);
  }

  public destroy(): void {
    this.scene.remove(this.group);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.glowMesh.geometry.dispose();
    (this.glowMesh.material as THREE.Material).dispose();
  }
}
