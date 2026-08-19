import * as THREE from 'three';
import { soundManager } from '../audio/soundManager';
import { Bounds, GameState, ShipModelId } from '../types/game';
import { SHIPS_CONFIG } from '../constants/gameConfig';

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

  public radius = 11;
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
  private flameMeshes: THREE.Mesh[] = [];
  private flameMat!: THREE.MeshBasicMaterial;
  private engineLight!: THREE.PointLight;
  private showcaseSpotLight!: THREE.PointLight;

  // Kingdom Hearts 2 Reflect Geodesic Shield
  public hasShield = true;
  public isShieldPoweringUp = false;
  public shieldPowerUpProgress = 1.0;
  private shieldGroup: THREE.Group;
  private shieldMesh!: THREE.Mesh;
  private shieldWireframe!: THREE.LineSegments;
  private shieldShaderMat!: THREE.ShaderMaterial;
  private shieldWireMat!: THREE.LineBasicMaterial;

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

  // Build the KH2 Reflect Crystal Geodesic Shield with per-facet variation shader
  private buildReflectShield(): void {
    const shieldRadius = 24;

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
    this.shieldShaderMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(this.shipColorHex) },
        uBaseOpacity: { value: 0.012 }
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

          float body = uBaseOpacity;
          float rim = fresnel * 0.16;
          float grid = latticeMask * 0.10;
          float flow = sweep * (0.05 + latticeMask * 0.12);
          float finalOpacity = clamp(body + rim + grid + flow, 0.0, 0.24);

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

    this.shieldMesh = new THREE.Mesh(fillGeo, this.shieldShaderMat);
    this.shieldGroup.add(this.shieldMesh);

    // Delicate Faceted Geodesic Outline Wireframe (no spikes!) - kept as a separate
    // low-poly icosahedron so the crystal "reflect" look is preserved on top of the
    // smooth energy dome.
    const wireBaseGeo = new THREE.IcosahedronGeometry(shieldRadius, 1);
    const edgeGeo = new THREE.EdgesGeometry(wireBaseGeo);
    this.shieldWireMat = new THREE.LineBasicMaterial({
      color: 0x9fe8ff,
      transparent: true,
      // Very faint - bloom does the rest of the work on these lines
      opacity: 0.045,
      linewidth: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    this.shieldWireframe = new THREE.LineSegments(edgeGeo, this.shieldWireMat);
    this.shieldGroup.add(this.shieldWireframe);
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
  }

  public triggerShieldPowerUp(): void {
    this.hasShield = true;
    this.isShieldPoweringUp = true;
    this.shieldPowerUpProgress = 0;
    if (!this.isHangar) {
      this.shieldGroup.visible = true;
    }
    this.shieldGroup.scale.set(0.01, 0.01, 0.01);
  }

  public breakShield(): void {
    this.hasShield = false;
    this.shieldGroup.visible = false;
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
    this.radius = 11 * config.sizeScale;

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

    this.flameMat = new THREE.MeshBasicMaterial({
      color: this.shipColorHex,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending
    });

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
      const flameGeo = new THREE.ConeGeometry(3.2, 16, 20);
      flameGeo.rotateZ(Math.PI / 2);

      const f1 = new THREE.Mesh(flameGeo, this.flameMat);
      f1.position.set(-18, 2, 3);
      this.flameMeshes.push(f1);
      this.shipModelGroup.add(f1);

      const f2 = new THREE.Mesh(flameGeo, this.flameMat);
      f2.position.set(-18, -2, -3);
      this.flameMeshes.push(f2);
      this.shipModelGroup.add(f2);
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
      const flameGeo = new THREE.ConeGeometry(4, 20, 20);
      flameGeo.rotateZ(Math.PI / 2);

      const fCenter = new THREE.Mesh(flameGeo, this.flameMat);
      fCenter.position.set(-22, 0, 0);
      this.flameMeshes.push(fCenter);
      this.shipModelGroup.add(fCenter);

      const fTop = new THREE.Mesh(flameGeo, this.flameMat);
      fTop.position.set(-20, 4, 6);
      this.flameMeshes.push(fTop);
      this.shipModelGroup.add(fTop);

      const fBot = new THREE.Mesh(flameGeo, this.flameMat);
      fBot.position.set(-20, -4, -6);
      this.flameMeshes.push(fBot);
      this.shipModelGroup.add(fBot);
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
      const flameGeo = new THREE.CylinderGeometry(2, 6, 16, 24, 1, true);
      flameGeo.rotateZ(Math.PI / 2);
      const f1 = new THREE.Mesh(flameGeo, this.flameMat);
      f1.position.set(-18, 0, 0);
      this.flameMeshes.push(f1);
      this.shipModelGroup.add(f1);
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
      const flameGeo = new THREE.ConeGeometry(5, 22, 24);
      flameGeo.rotateZ(Math.PI / 2);
      const f1 = new THREE.Mesh(flameGeo, this.flameMat);
      f1.position.set(-22, 0, 0);
      this.flameMeshes.push(f1);
      this.shipModelGroup.add(f1);
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

      const flameGeo = new THREE.ConeGeometry(4, 18, 20);
      flameGeo.rotateZ(Math.PI / 2);
      const f1 = new THREE.Mesh(flameGeo, this.flameMat);
      f1.position.set(-20, 0, 0);
      this.flameMeshes.push(f1);
      this.shipModelGroup.add(f1);
    }

    // Engine Point Light
    if (!this.engineLight) {
      this.engineLight = new THREE.PointLight(this.shipColorHex, 2.8, 100);
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
    if (this.flameMat) this.flameMat.color.setHex(colorHex);
    if (this.engineLight) this.engineLight.color.setHex(colorHex);
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
      const fit = this.showcaseAnchor ? this.showcaseAnchor.scale : 1;
      const showcaseScale = Math.min(1.15, this.sizeScale * 0.95) * fit;
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
    } else {
      // In-flight position & normal scale
      this.shipModelGroup.scale.set(this.sizeScale, this.sizeScale, this.sizeScale);

      const targetFlightX = -bounds.halfWidth * 0.72;
      this.x += (targetFlightX - this.x) * 0.12;
      this.z += (0 - this.z) * 0.12;

      let moveDir = 0;
      if (keys['ArrowUp'] || keys['KeyW']) moveDir += 1;
      if (keys['ArrowDown'] || keys['KeyS']) moveDir -= 1;

      if (this.isWarping) {
        // Hyperspace warp stabilization
        this.vy = (0 - this.y) * 0.12;
        this.y += this.vy;
      } else if (moveDir !== 0) {
        // Continuous smooth acceleration on holding keys; tap moves ~1/3rd with fluid holding
        const keyAccel = moveDir * (this.speed * 0.21) * (this.smoothness * 1.4);
        this.vy += keyAccel;
        const maxFlightVy = this.speed * 0.85;
        this.vy = Math.max(-maxFlightVy, Math.min(maxFlightVy, this.vy));
        this.y += this.vy;
        if (Math.abs(this.vy) > 0.8) {
          soundManager.playFlySound();
        }
      } else if (isPointerActive && pointerY !== null) {
        const dy = pointerY - this.y;
        this.vy = dy * this.smoothness;
        this.y += this.vy;
        if (Math.abs(this.vy) > 1.2) {
          soundManager.playFlySound();
        }
      } else {
        this.vy *= 0.86;
        this.y += this.vy;
      }

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

      // Power-up materialization animation
      if (this.isShieldPoweringUp) {
        this.shieldPowerUpProgress = Math.min(1.0, this.shieldPowerUpProgress + 0.04);
        const targetScale = this.sizeScale * 1.18 * this.shieldPowerUpProgress;
        this.shieldGroup.scale.set(targetScale, targetScale, targetScale);
        if (this.shieldPowerUpProgress >= 1.0) {
          this.isShieldPoweringUp = false;
        }
      } else {
        const targetScale = this.sizeScale * 1.18;
        this.shieldGroup.scale.set(targetScale, targetScale, targetScale);
      }

      // Slowly rotate geodesic crystal shield for prismatic shimmer
      this.shieldGroup.rotation.y += 0.012;
      this.shieldGroup.rotation.x += 0.006;

      // Update shader time for holographic surface shimmer
      if (this.shieldShaderMat && this.shieldShaderMat.uniforms.uTime) {
        this.shieldShaderMat.uniforms.uTime.value += 0.03;
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

    // Pulse Thruster Flames (Supercharged during warp)
    const baseFlameScale = (1 + Math.sin(this.flameTime) * 0.28 + Math.abs(this.vy) * 0.1) * this.sizeScale;
    const flameScale = this.isWarping ? baseFlameScale * 2.8 : baseFlameScale;

    for (const f of this.flameMeshes) {
      f.scale.set(flameScale, 0.9 + Math.cos(this.flameTime * 1.5) * 0.15, 0.9);
    }
    if (this.engineLight) {
      this.engineLight.intensity = this.isWarping ? 5.0 : 2.4 + Math.sin(this.flameTime * 2) * 0.8;
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
