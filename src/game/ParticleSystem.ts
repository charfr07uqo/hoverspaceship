import * as THREE from 'three';

interface ParticleData {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  vx: number;
  vy: number;
  vz: number;
  rotSpeedX?: number;
  rotSpeedY?: number;
  rotSpeedZ?: number;
  life: number;
  decay: number;
  isShockwave?: boolean;
  isCrystal?: boolean;
}

export class ParticleSystem {
  private scene: THREE.Scene;
  private particles: ParticleData[] = [];
  private sphereGeo: THREE.SphereGeometry;
  private boxGeo: THREE.BoxGeometry;
  private ringGeo: THREE.RingGeometry;
  private crystalGeo: THREE.OctahedronGeometry;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.sphereGeo = new THREE.SphereGeometry(1, 10, 10);
    this.boxGeo = new THREE.BoxGeometry(2, 2, 2);
    // Wider ring with vertex-colour falloff so shockwaves have soft edges
    this.ringGeo = new THREE.RingGeometry(1, 3.4, 48);
    ParticleSystem.applyRingFalloff(this.ringGeo);
    this.crystalGeo = new THREE.OctahedronGeometry(1.8, 0);
  }

  /**
   * Bakes a radial alpha ramp into the ring's vertex colours: brightest at the
   * mid-band, fading to zero at both the inner and outer rim. Combined with
   * additive blending this gives a soft energy shockwave instead of a hard band.
   */
  private static applyRingFalloff(geo: THREE.RingGeometry): void {
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    let min = Infinity;
    let max = -Infinity;
    const radii: number[] = [];

    for (let i = 0; i < pos.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getY(i));
      radii.push(r);
      if (r < min) min = r;
      if (r > max) max = r;
    }

    for (let i = 0; i < pos.count; i++) {
      const t = (radii[i] - min) / Math.max(1e-6, max - min);
      // Peak near the outer third of the band, feathered both ways
      const a = Math.sin(Math.pow(t, 0.7) * Math.PI);
      colors[i * 3] = a;
      colors[i * 3 + 1] = a;
      colors[i * 3 + 2] = a;
    }

    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }

  public createExplosion(x: number, y: number, z: number, colorHex: number, count = 35): void {
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: colorHex,
        transparent: true,
        opacity: 1,
        blending: THREE.AdditiveBlending
      });
      const mesh = new THREE.Mesh(this.sphereGeo, mat);
      const scale = Math.random() * 2.8 + 1.2;
      mesh.scale.set(scale, scale, scale);
      mesh.position.set(x, y, z);

      const angle = Math.random() * Math.PI * 2;
      const speed = Math.random() * 5.5 + 2.0;
      const vx = Math.cos(angle) * speed;
      const vy = Math.sin(angle) * speed;
      const vz = (Math.random() - 0.5) * 4;

      this.scene.add(mesh);
      this.particles.push({
        mesh,
        mat,
        vx,
        vy,
        vz,
        life: 1.0,
        decay: Math.random() * 0.025 + 0.015
      });
    }
  }

  public createDebris(x: number, y: number, z: number, colorHex: number, count = 18): void {
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: Math.random() > 0.4 ? colorHex : 0xffffff,
        transparent: true,
        opacity: 1
      });
      const mesh = new THREE.Mesh(this.boxGeo, mat);
      const scaleX = Math.random() * 2.5 + 1.0;
      const scaleY = Math.random() * 2.5 + 1.0;
      const scaleZ = Math.random() * 2.5 + 1.0;
      mesh.scale.set(scaleX, scaleY, scaleZ);
      mesh.position.set(x, y, z);

      const angle = Math.random() * Math.PI * 2;
      const speed = Math.random() * 6.0 + 1.5;
      const vx = Math.cos(angle) * speed;
      const vy = Math.sin(angle) * speed;
      const vz = (Math.random() - 0.5) * 5;

      this.scene.add(mesh);
      this.particles.push({
        mesh,
        mat,
        vx,
        vy,
        vz,
        rotSpeedX: (Math.random() - 0.5) * 0.2,
        rotSpeedY: (Math.random() - 0.5) * 0.2,
        rotSpeedZ: (Math.random() - 0.5) * 0.2,
        life: 1.0,
        decay: Math.random() * 0.018 + 0.012
      });
    }
  }

  // KH2 Reflect Glass/Crystal Shatter Burst
  public createReflectShatter(x: number, y: number, z: number, colorHex = 0xe0f2fe, count = 36): void {
    // 1. Expanding diamond shockwave ring
    this.createShockwave(x, y, z, 0xffffff);
    this.createShockwave(x, y, z, colorHex);

    // 2. High-speed tumbling crystal facets
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: Math.random() > 0.3 ? 0xffffff : colorHex,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending
      });
      const mesh = new THREE.Mesh(this.crystalGeo, mat);
      const scale = Math.random() * 2.2 + 1.0;
      mesh.scale.set(scale, scale * 1.5, scale);
      mesh.position.set(x, y, z);

      const angle = Math.random() * Math.PI * 2;
      const speed = Math.random() * 7.5 + 3.0;
      const vx = Math.cos(angle) * speed;
      const vy = Math.sin(angle) * speed;
      const vz = (Math.random() - 0.5) * 6;

      this.scene.add(mesh);
      this.particles.push({
        mesh,
        mat,
        vx,
        vy,
        vz,
        rotSpeedX: (Math.random() - 0.5) * 0.35,
        rotSpeedY: (Math.random() - 0.5) * 0.35,
        rotSpeedZ: (Math.random() - 0.5) * 0.35,
        life: 1.0,
        decay: Math.random() * 0.022 + 0.016,
        isCrystal: true
      });
    }
  }

  public createShockwave(x: number, y: number, z: number, colorHex: number): void {
    const mat = new THREE.MeshBasicMaterial({
      color: colorHex,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false,
      vertexColors: true,
      blending: THREE.AdditiveBlending
    });
    const mesh = new THREE.Mesh(this.ringGeo, mat);
    mesh.position.set(x, y, z);
    mesh.scale.set(1, 1, 1);

    this.scene.add(mesh);
    this.particles.push({
      mesh,
      mat,
      vx: 0,
      vy: 0,
      vz: 0,
      life: 1.0,
      decay: 0.024,
      isShockwave: true
    });
  }

  public update(): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];

      if (p.isShockwave) {
        const expand = (1.0 - p.life) * 55 + 2;
        p.mesh.scale.set(expand, expand, expand);
      } else {
        p.mesh.position.x += p.vx;
        p.mesh.position.y += p.vy;
        p.mesh.position.z += p.vz;

        p.vx *= 0.98;
        p.vy *= 0.98;

        if (p.rotSpeedX) p.mesh.rotation.x += p.rotSpeedX;
        if (p.rotSpeedY) p.mesh.rotation.y += p.rotSpeedY;
        if (p.rotSpeedZ) p.mesh.rotation.z += p.rotSpeedZ;
      }

      p.life -= p.decay;

      if (p.life <= 0) {
        this.scene.remove(p.mesh);
        p.mat.dispose();
        this.particles.splice(i, 1);
      } else {
        p.mat.opacity = Math.max(0, p.life);
        if (!p.isShockwave) {
          const s = p.mesh.scale.x * 0.985;
          p.mesh.scale.set(s, s, s);
        }
      }
    }
  }

  public clear(): void {
    for (const p of this.particles) {
      this.scene.remove(p.mesh);
      p.mat.dispose();
    }
    this.particles = [];
  }

  public destroy(): void {
    this.clear();
    this.sphereGeo.dispose();
    this.boxGeo.dispose();
    this.ringGeo.dispose();
    this.crystalGeo.dispose();
  }
}
