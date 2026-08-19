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
    this.farMaterial = new THREE.PointsMaterial({
      color: 0x94a3b8,
      size: 5.5,
      map: this.starSprite,
      alphaMap: this.starSprite,
      sizeAttenuation: true,
      transparent: true,
      depthWrite: false,
      opacity: 0.6,
      blending: THREE.AdditiveBlending
    });
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
    this.nearMaterial = new THREE.PointsMaterial({
      color: 0x38bdf8,
      size: 9,
      map: this.starSprite,
      alphaMap: this.starSprite,
      sizeAttenuation: true,
      transparent: true,
      depthWrite: false,
      opacity: 0.8,
      blending: THREE.AdditiveBlending
    });
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
  }

  public setThemeColor(colorHex: number): void {
    if (this.nearMaterial) {
      this.nearMaterial.color.setHex(colorHex);
    }
    if (this.warpMaterial) {
      this.warpMaterial.color.setHex(colorHex);
    }
  }

  public setWarping(warping: boolean): void {
    this.isWarping = warping;
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
  }

  public destroy(): void {
    this.scene.remove(this.farPoints);
    this.scene.remove(this.nearPoints);
    this.scene.remove(this.warpLines);
    this.farPoints.geometry.dispose();
    this.farMaterial.dispose();
    this.nearPoints.geometry.dispose();
    this.nearMaterial.dispose();
    this.warpLines.geometry.dispose();
    this.warpMaterial.dispose();
    this.starSprite.dispose();
  }
}
