import * as THREE from 'three';
import { PlayerShip } from './PlayerShip';

// Frames per morph phase (~60fps => ~1 second per phase toggle).
const MORPH_PHASE_FRAMES = 60;

export class Gem3D {
  private scene: THREE.Scene;
  public x: number;
  public y: number;
  public radius = 11;
  private angle: number;

  public readonly isBomb: boolean;

  public group: THREE.Group;

  // Gem (disguise) representation
  private gemGroup: THREE.Group;
  private mesh: THREE.Mesh;
  private wire: THREE.LineSegments;

  // Bomb (revealed) representation — only built for bombs
  private bombGroup: THREE.Group | null = null;
  private bombMeshes: THREE.Mesh[] = [];

  private light: THREE.PointLight;

  private morphFrame = 0;
  private bombPhase = false; // true = showing the red bomb form

  constructor(scene: THREE.Scene, x: number, y: number, isBomb = false) {
    this.scene = scene;
    this.x = x;
    this.y = y;
    this.isBomb = isBomb;
    this.angle = Math.random() * Math.PI * 2;

    this.group = new THREE.Group();

    // -------- Gem (disguise) form --------
    this.gemGroup = new THREE.Group();

    const gemGeo = new THREE.OctahedronGeometry(9, 0);
    gemGeo.scale(0.85, 1.2, 0.85);

    const gemMat = new THREE.MeshStandardMaterial({
      color: 0xfbbf24,
      emissive: 0xf59e0b,
      emissiveIntensity: 0.9,
      roughness: 0.15,
      metalness: 0.85,
      flatShading: true
    });
    this.mesh = new THREE.Mesh(gemGeo, gemMat);
    this.gemGroup.add(this.mesh);

    // Glowing wireframe outline for a high-tech holographic look
    const wireGeo = new THREE.WireframeGeometry(gemGeo);
    const wireMat = new THREE.LineBasicMaterial({
      color: 0xfef08a,
      transparent: true,
      opacity: 0.75
    });
    this.wire = new THREE.LineSegments(wireGeo, wireMat);
    this.gemGroup.add(this.wire);

    // Bombs get tiny red "tell" dots on their gem disguise so a sharp-eyed
    // pilot can spot the fake even while it looks like a gem.
    if (this.isBomb) {
      const hintGeo = new THREE.SphereGeometry(1.5, 8, 8);
      const hintMat = new THREE.MeshBasicMaterial({
        color: 0xff2222,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending
      });
      const hintOffsets = [
        [0, 9, 0],
        [0, -9, 0],
        [6, 2, 4]
      ];
      for (const [hx, hy, hz] of hintOffsets) {
        const dot = new THREE.Mesh(hintGeo, hintMat);
        dot.position.set(hx, hy, hz);
        this.gemGroup.add(dot);
      }
    }

    this.group.add(this.gemGroup);

    // -------- Bomb (revealed) form --------
    if (this.isBomb) {
      this.bombGroup = new THREE.Group();

      const coreGeo = new THREE.SphereGeometry(8.5, 20, 20);
      const coreMat = new THREE.MeshStandardMaterial({
        color: 0x2b0505,
        emissive: 0xff1a1a,
        emissiveIntensity: 1.1,
        roughness: 0.35,
        metalness: 0.7
      });
      const core = new THREE.Mesh(coreGeo, coreMat);
      this.bombGroup.add(core);
      this.bombMeshes.push(core);

      // Menacing spikes around the bomb shell
      const spikeGeo = new THREE.ConeGeometry(2.2, 6, 8);
      const spikeMat = new THREE.MeshStandardMaterial({
        color: 0x7f1d1d,
        emissive: 0xef4444,
        emissiveIntensity: 0.6,
        metalness: 0.8,
        roughness: 0.3
      });
      const spikeDirs: [number, number, number][] = [
        [0, 11, 0],
        [0, -11, 0],
        [11, 0, 0],
        [-11, 0, 0],
        [0, 0, 11],
        [0, 0, -11]
      ];
      for (const [sx, sy, sz] of spikeDirs) {
        const spike = new THREE.Mesh(spikeGeo, spikeMat);
        spike.position.set(sx, sy, sz);
        spike.lookAt(new THREE.Vector3(sx * 2, sy * 2, sz * 2));
        spike.rotateX(Math.PI / 2);
        this.bombGroup.add(spike);
        this.bombMeshes.push(spike);
      }

      this.bombGroup.visible = false;
      this.group.add(this.bombGroup);
    }

    // Point light — warm amber for gems, hot red when a bomb reveals itself
    this.light = new THREE.PointLight(0xf59e0b, 1.5, 45);
    this.group.add(this.light);

    this.group.position.set(this.x, this.y, 0);
    this.scene.add(this.group);
  }

  public update(gameSpeed: number): void {
    this.x -= gameSpeed;
    this.angle += 0.05;

    this.group.position.x = this.x;
    this.group.position.y = this.y + Math.sin(this.angle) * 4;

    this.mesh.rotation.y += 0.04;
    this.mesh.rotation.x += 0.02;
    this.wire.rotation.copy(this.mesh.rotation);

    if (this.isBomb && this.bombGroup) {
      // Toggle between gem disguise and revealed bomb roughly every second.
      this.morphFrame++;
      if (this.morphFrame >= MORPH_PHASE_FRAMES) {
        this.morphFrame = 0;
        this.bombPhase = !this.bombPhase;
        this.gemGroup.visible = !this.bombPhase;
        this.bombGroup.visible = this.bombPhase;
        this.light.color.setHex(this.bombPhase ? 0xff1a1a : 0xf59e0b);
      }

      if (this.bombPhase) {
        // Ominous pulsing while the bomb is exposed
        const pulse = 1 + Math.sin(performance.now() * 0.012) * 0.12;
        this.bombGroup.scale.set(pulse, pulse, pulse);
        this.bombGroup.rotation.y += 0.03;
        this.light.intensity = 2.2 + Math.sin(performance.now() * 0.02) * 0.8;
      } else {
        this.light.intensity = 1.5;
      }
    }
  }

  public collidesWith(p: PlayerShip): boolean {
    const dx = p.x - this.x;
    const dy = p.y - this.group.position.y;
    const distSq = dx * dx + dy * dy;
    const hitDist = p.radius + this.radius;
    return distSq < hitDist * hitDist;
  }

  public destroy(): void {
    this.scene.remove(this.group);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.wire.geometry.dispose();
    (this.wire.material as THREE.Material).dispose();
    for (const m of this.bombMeshes) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  }
}
