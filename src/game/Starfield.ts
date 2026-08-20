import * as THREE from 'three';

/**
 * Builds a soft radial-gradient sprite once and shares it across every star
 * layer. Without a map, THREE.Points renders hard square quads, which is what
 * made the background read as pixel dust rather than stars.
 */
function createStarSprite(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.2, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.28)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Lets a stock PointsMaterial read a per-star size multiplier from an `aScale`
 * attribute. Patching the built-in shader keeps the sprite map, alpha map and
 * size attenuation behaviour intact, which a hand-written ShaderMaterial would
 * have meant reimplementing.
 */
function applyPerStarSize(mat: THREE.PointsMaterial): void {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n\t\tattribute float aScale;')
      .replace('gl_PointSize = size;', 'gl_PointSize = size * aScale;');
  };
  mat.customProgramCacheKey = () => 'starPerPointScale';
}

/**
 * Per-star size and colour spread.
 *
 * Sizes use a cubed random so the field stays mostly fine dust with only a
 * handful of standouts - a flat random reads as uniformly chunky. Colours stay
 * within a believable stellar range: mostly the layer's base tint, with a
 * minority of warm amber and a few cool blue-white stars, and brightness varied
 * per star so the layer has depth instead of one flat wash.
 */
function fillStarAppearance(
  count: number,
  base: THREE.Color,
  sizeRange: [number, number],
  brightnessRange: [number, number],
  hueMix = 1
): { colors: Float32Array; scales: Float32Array } {
  const colors = new Float32Array(count * 3);
  const scales = new Float32Array(count);

  const warm = new THREE.Color(0xffb27a);
  const cool = new THREE.Color(0xcfe6ff);
  const c = new THREE.Color();

  for (let i = 0; i < count; i++) {
    const r = Math.random();
    scales[i] = sizeRange[0] + Math.pow(r, 3) * (sizeRange[1] - sizeRange[0]);

    c.copy(base);
    const hue = Math.random();
    if (hue > 0.86) {
      c.lerp(warm, (0.35 + Math.random() * 0.3) * hueMix);
    } else if (hue > 0.68) {
      c.lerp(cool, (0.3 + Math.random() * 0.35) * hueMix);
    }

    // Bigger stars read as nearer, so let them run slightly brighter.
    const bias = (scales[i] - sizeRange[0]) / (sizeRange[1] - sizeRange[0]);
    const brightness =
      brightnessRange[0] +
      Math.random() * (brightnessRange[1] - brightnessRange[0]) +
      bias * 0.18;
    c.multiplyScalar(Math.min(1.25, brightness));

    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }

  return { colors, scales };
}

/**
 * The rift ring tunnel. Each ring is a closed polygon of line segments sitting
 * on its own Z plane; the whole stack marches toward the camera so perspective
 * turns it into a funnel the ship is falling through. Radius stays constant so
 * near rings blow past off-frame while far ones converge to a point.
 */
const RIFT_RING_COUNT = 16;
const RIFT_RING_SEGMENTS = 40;
const RIFT_RING_RADIUS = 300;
const RIFT_RING_Z_FAR = -700;
const RIFT_RING_Z_NEAR = 520;

/** Violet wash laid over the far star layer so the rift's void reads as other. */
const RIFT_FAR_TINT = 0xb98cff;

export class Starfield {
  private scene: THREE.Scene;
  private starSprite: THREE.Texture;
  private twinkleTime = 0;
  private farPoints: THREE.Points;
  private farMaterial: THREE.PointsMaterial;
  private nearPoints: THREE.Points;
  private nearMaterial: THREE.PointsMaterial;

  // Hyperspace Warp Streaks
  private warpLines: THREE.LineSegments;
  private warpMaterial: THREE.LineBasicMaterial;
  private warpCount = 90;
  private isWarping = false;

  // Alternate-reality (bonus rift) background state
  private riftRings: THREE.LineSegments;
  private riftRingMaterial: THREE.LineBasicMaterial;
  /** Per-ring Z and radius jitter, kept out of the vertex buffer's way. */
  private riftRingZ: number[] = [];
  private riftRingScale: number[] = [];
  private riftRoll = 0;
  private isRiftActive = false;
  private isRiftWarping = false;
  /** The difficulty theme colour to restore when the rift closes. */
  private normalThemeHex = 0x38bdf8;
  private riftThemeHex = 0xc084fc;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.starSprite = createStarSprite();

    // Far background stars
    const farCount = 250;
    const farGeo = new THREE.BufferGeometry();
    const farPositions = new Float32Array(farCount * 3);

    for (let i = 0; i < farCount; i++) {
      farPositions[i * 3] = (Math.random() - 0.5) * 800;
      farPositions[i * 3 + 1] = (Math.random() - 0.5) * 600;
      farPositions[i * 3 + 2] = -100 - Math.random() * 200;
    }
    farGeo.setAttribute('position', new THREE.BufferAttribute(farPositions, 3));

    // The base slate tint now lives in the vertex colours instead of the material,
    // so individual stars are free to drift warm or cool off it.
    const far = fillStarAppearance(farCount, new THREE.Color(0x94a3b8), [0.65, 1.75], [0.75, 1.05]);
    farGeo.setAttribute('color', new THREE.BufferAttribute(far.colors, 3));
    farGeo.setAttribute('aScale', new THREE.BufferAttribute(far.scales, 1));

    this.farMaterial = new THREE.PointsMaterial({
      color: 0xffffff,
      vertexColors: true,
      size: 5.5,
      map: this.starSprite,
      alphaMap: this.starSprite,
      sizeAttenuation: true,
      transparent: true,
      depthWrite: false,
      opacity: 0.6,
      blending: THREE.AdditiveBlending
    });
    applyPerStarSize(this.farMaterial);
    this.farPoints = new THREE.Points(farGeo, this.farMaterial);
    this.scene.add(this.farPoints);

    // Near glowing stars
    const nearCount = 90;
    const nearGeo = new THREE.BufferGeometry();
    const nearPositions = new Float32Array(nearCount * 3);

    for (let i = 0; i < nearCount; i++) {
      nearPositions[i * 3] = (Math.random() - 0.5) * 600;
      nearPositions[i * 3 + 1] = (Math.random() - 0.5) * 500;
      nearPositions[i * 3 + 2] = (Math.random() - 0.5) * 60;
    }
    nearGeo.setAttribute('position', new THREE.BufferAttribute(nearPositions, 3));

    // Near stars keep the theme colour on the material (setThemeColor still drives
    // it) and use vertex colours purely as a per-star multiplier, so the hue
    // variation here is held back to a light tint rather than fighting the theme.
    const near = fillStarAppearance(nearCount, new THREE.Color(0xffffff), [0.55, 1.6], [0.6, 1.0], 0.45);
    nearGeo.setAttribute('color', new THREE.BufferAttribute(near.colors, 3));
    nearGeo.setAttribute('aScale', new THREE.BufferAttribute(near.scales, 1));

    this.nearMaterial = new THREE.PointsMaterial({
      color: 0x38bdf8,
      vertexColors: true,
      size: 9,
      map: this.starSprite,
      alphaMap: this.starSprite,
      sizeAttenuation: true,
      transparent: true,
      depthWrite: false,
      opacity: 0.8,
      blending: THREE.AdditiveBlending
    });
    applyPerStarSize(this.nearMaterial);
    this.nearPoints = new THREE.Points(nearGeo, this.nearMaterial);
    this.scene.add(this.nearPoints);

    // Warp Streaks Line Geometry (Each streak is a 2-vertex segment)
    const warpGeo = new THREE.BufferGeometry();
    const warpPositions = new Float32Array(this.warpCount * 6);

    for (let i = 0; i < this.warpCount; i++) {
      const x = (Math.random() - 0.5) * 700;
      const y = (Math.random() - 0.5) * 550;
      const z = (Math.random() - 0.5) * 80;
      const len = 30 + Math.random() * 60;

      // Start vertex
      warpPositions[i * 6] = x;
      warpPositions[i * 6 + 1] = y;
      warpPositions[i * 6 + 2] = z;

      // End vertex (extended along X axis)
      warpPositions[i * 6 + 3] = x + len;
      warpPositions[i * 6 + 4] = y;
      warpPositions[i * 6 + 5] = z;
    }
    warpGeo.setAttribute('position', new THREE.BufferAttribute(warpPositions, 3));
    this.warpMaterial = new THREE.LineBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      linewidth: 2
    });
    this.warpLines = new THREE.LineSegments(warpGeo, this.warpMaterial);
    // Keep the streaks completely out of the render until we're actually
    // warping. This prevents faint depth-buffer artifacts from showing the
    // otherwise-invisible horizontal lines (e.g. through the shield dome).
    this.warpLines.visible = false;
    this.scene.add(this.warpLines);

    // Rift ring tunnel. Built once and parked invisible; only bonus rifts and
    // the breach warp ever switch it on.
    const ringGeo = new THREE.BufferGeometry();
    const ringPositions = new Float32Array(RIFT_RING_COUNT * RIFT_RING_SEGMENTS * 6);
    for (let r = 0; r < RIFT_RING_COUNT; r++) {
      // Spread the stack evenly from the far plane to just past the camera.
      this.riftRingZ[r] =
        RIFT_RING_Z_FAR + ((RIFT_RING_Z_NEAR - RIFT_RING_Z_FAR) * r) / RIFT_RING_COUNT;
      this.riftRingScale[r] = 0.82 + Math.random() * 0.36;
    }
    ringGeo.setAttribute('position', new THREE.BufferAttribute(ringPositions, 3));
    this.riftRingMaterial = new THREE.LineBasicMaterial({
      color: this.riftThemeHex,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      // The rift runs a denser fog than normal space, which would swallow the far
      // half of the tunnel and cost it its sense of depth. Perspective alone does
      // the falloff here.
      fog: false
    });
    this.riftRings = new THREE.LineSegments(ringGeo, this.riftRingMaterial);
    this.riftRings.visible = false;
    this.scene.add(this.riftRings);
    this.writeRiftRings();
  }

  /**
   * Rewrites every ring's vertices from the current Z / roll state. Rings are
   * regular polygons, so the whole stack is one buffer write per frame.
   */
  private writeRiftRings(): void {
    const pos = this.riftRings.geometry.attributes.position.array as Float32Array;
    const step = (Math.PI * 2) / RIFT_RING_SEGMENTS;

    for (let r = 0; r < RIFT_RING_COUNT; r++) {
      const z = this.riftRingZ[r];
      // Alternate the roll direction per ring so the tunnel visibly counter-rotates.
      const spin = this.riftRoll * (r % 2 === 0 ? 1 : -1) + r * 0.21;
      const radius = RIFT_RING_RADIUS * this.riftRingScale[r];
      const base = r * RIFT_RING_SEGMENTS * 6;

      for (let s = 0; s < RIFT_RING_SEGMENTS; s++) {
        const a0 = spin + s * step;
        const a1 = spin + (s + 1) * step;
        // Squash one axis slightly so rings read as a torn membrane, not a pipe.
        const i = base + s * 6;
        pos[i] = Math.cos(a0) * radius;
        pos[i + 1] = Math.sin(a0) * radius * 0.86;
        pos[i + 2] = z;
        pos[i + 3] = Math.cos(a1) * radius;
        pos[i + 4] = Math.sin(a1) * radius * 0.86;
        pos[i + 5] = z;
      }
    }
    this.riftRings.geometry.attributes.position.needsUpdate = true;
  }

  public setThemeColor(colorHex: number): void {
    this.normalThemeHex = colorHex;
    this.applyPalette();
  }

  /**
   * Repaints the star layers and streaks for whichever reality we are in. The
   * difficulty theme still owns normal space; a rift overrides it wholesale so
   * the player can tell at a glance that this is somewhere else.
   */
  private applyPalette(): void {
    const accent = this.isRiftActive || this.isRiftWarping ? this.riftThemeHex : this.normalThemeHex;
    this.nearMaterial.color.setHex(accent);
    this.warpMaterial.color.setHex(accent);
    this.riftRingMaterial.color.setHex(this.riftThemeHex);
    // Far stars carry the base wash: neutral white in normal space, violet in a rift.
    this.farMaterial.color.setHex(this.isRiftActive || this.isRiftWarping ? RIFT_FAR_TINT : 0xffffff);
  }

  /** Overrides the rift accent colour (kept in config alongside the fog tint). */
  public setRiftThemeColor(colorHex: number): void {
    this.riftThemeHex = colorHex;
    this.applyPalette();
  }

  public setWarping(warping: boolean): void {
    this.isWarping = warping;
  }

  /** True for as long as the flight is inside a bonus rift, warps included. */
  public setRiftActive(active: boolean): void {
    if (this.isRiftActive === active) return;
    this.isRiftActive = active;
    if (active) {
      this.riftRings.visible = true;
    }
    this.applyPalette();
  }

  /**
   * The reality-breach warp itself: the ring tunnel slams past at speed and the
   * streaks come along for the ride. Distinct from setWarping, which is the
   * ordinary between-sectors hyperspace jump.
   */
  public setRiftWarping(warping: boolean): void {
    this.isRiftWarping = warping;
    // The breach borrows the star-streak machinery, so it owns that flag for the
    // duration and has to hand it back — otherwise the streaks would still be
    // screaming past once the rift run begins.
    this.isWarping = warping;
    if (warping) {
      this.riftRings.visible = true;
    }
    this.applyPalette();
  }

  public update(speed: number): void {
    const warpSpeed = this.isWarping ? speed * 6.5 + 16 : speed;

    // Subtle atmospheric twinkle on the two star layers (out of phase so they
    // never pulse together)
    this.twinkleTime += 0.02;
    this.farMaterial.opacity = 0.6 + Math.sin(this.twinkleTime) * 0.08;
    this.nearMaterial.opacity = 0.8 + Math.sin(this.twinkleTime * 1.37 + 1.9) * 0.1;

    const farPos = this.farPoints.geometry.attributes.position.array as Float32Array;
    for (let i = 0; i < farPos.length; i += 3) {
      farPos[i] -= warpSpeed * 0.3;
      if (farPos[i] < -400) {
        farPos[i] = 400;
      }
    }
    this.farPoints.geometry.attributes.position.needsUpdate = true;

    const nearPos = this.nearPoints.geometry.attributes.position.array as Float32Array;
    for (let i = 0; i < nearPos.length; i += 3) {
      nearPos[i] -= warpSpeed * 0.9;
      if (nearPos[i] < -300) {
        nearPos[i] = 300;
      }
    }
    this.nearPoints.geometry.attributes.position.needsUpdate = true;

    // Update Hyperspace Warp Lines
    if (this.isWarping) {
      this.warpLines.visible = true;
      this.warpMaterial.opacity = Math.min(1.0, this.warpMaterial.opacity + 0.08);
      const warpPos = this.warpLines.geometry.attributes.position.array as Float32Array;

      for (let i = 0; i < this.warpCount; i++) {
        const idx = i * 6;
        warpPos[idx] -= warpSpeed * 2.2;
        warpPos[idx + 3] -= warpSpeed * 2.2;

        if (warpPos[idx + 3] < -400) {
          const newX = 400 + Math.random() * 100;
          const newY = (Math.random() - 0.5) * 550;
          const newZ = (Math.random() - 0.5) * 80;
          const len = 50 + Math.random() * 80;

          warpPos[idx] = newX;
          warpPos[idx + 1] = newY;
          warpPos[idx + 2] = newZ;

          warpPos[idx + 3] = newX + len;
          warpPos[idx + 4] = newY;
          warpPos[idx + 5] = newZ;
        }
      }
      this.warpLines.geometry.attributes.position.needsUpdate = true;
    } else {
      this.warpMaterial.opacity = Math.max(0, this.warpMaterial.opacity - 0.06);
      // Once fully faded, stop rendering the streaks entirely.
      if (this.warpMaterial.opacity <= 0) {
        this.warpLines.visible = false;
      }
    }

    this.updateRiftRings(speed);
  }

  /**
   * Advances the rift tunnel. It tears past at speed during the breach warp and
   * then settles into a slow, ever-present drift for as long as the rift lasts,
   * which is what keeps the bonus sector reading as a different place.
   */
  private updateRiftRings(speed: number): void {
    const targetOpacity = this.isRiftWarping ? 0.9 : this.isRiftActive ? 0.26 : 0;

    if (targetOpacity > this.riftRingMaterial.opacity) {
      this.riftRingMaterial.opacity = Math.min(targetOpacity, this.riftRingMaterial.opacity + 0.06);
    } else {
      this.riftRingMaterial.opacity = Math.max(targetOpacity, this.riftRingMaterial.opacity - 0.035);
    }

    if (this.riftRingMaterial.opacity <= 0) {
      this.riftRings.visible = false;
      return;
    }
    this.riftRings.visible = true;

    const advance = this.isRiftWarping ? speed * 9 + 42 : speed * 2.4;
    this.riftRoll += this.isRiftWarping ? 0.022 : 0.0035;

    const span = RIFT_RING_Z_NEAR - RIFT_RING_Z_FAR;
    for (let r = 0; r < RIFT_RING_COUNT; r++) {
      this.riftRingZ[r] += advance;
      if (this.riftRingZ[r] > RIFT_RING_Z_NEAR) {
        // Wrap by the full span so the stack keeps its even spacing at any speed.
        this.riftRingZ[r] -= span;
        this.riftRingScale[r] = 0.82 + Math.random() * 0.36;
      }
    }
    this.writeRiftRings();
  }

  public destroy(): void {
    this.scene.remove(this.farPoints);
    this.scene.remove(this.nearPoints);
    this.scene.remove(this.warpLines);
    this.scene.remove(this.riftRings);
    this.riftRings.geometry.dispose();
    this.riftRingMaterial.dispose();
    this.farPoints.geometry.dispose();
    this.farMaterial.dispose();
    this.nearPoints.geometry.dispose();
    this.nearMaterial.dispose();
    this.warpLines.geometry.dispose();
    this.warpMaterial.dispose();
    this.starSprite.dispose();
  }
}
