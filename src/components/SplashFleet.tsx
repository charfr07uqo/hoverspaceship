import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { PlayerShip } from '../game/PlayerShip';
import { SHIP_COLORS } from '../constants/gameConfig';
import { ShipColorKey, ShipModelId } from '../types/game';

/** Hulls paraded on the boot splash, one at a time. */
const FLEET: ShipModelId[] = ['dart', 'viper', 'titan', 'phantom', 'valkyrie'];

/** One accent per hull so the parade reads as a fleet rather than a colour swatch. */
const FLEET_COLORS: ShipColorKey[] = ['blue', 'green', 'red', 'pink', 'blue'];

const CAMERA_FOV = 45;
const CAMERA_Z = 300;

/** Fraction of the stage a single hull is allowed to occupy. */
const STAGE_FILL = 0.66;

/** Seconds each hull holds the stage. Five hulls fit the ~2.6s splash window. */
const SLOT_SECONDS = 0.5;

/**
 * Share of a slot spent handing the stage over. The outgoing hull flies out while
 * the incoming one flies in, and both finish together: the old hull is fully
 * off-stage on the same frame the new one lands centred.
 */
const HANDOFF_FRACTION = 0.34;

/** Extra world units past the frame edge so a hull is fully gone before release. */
const OFFSTAGE_MARGIN = 24;

/**
 * Local units the plume shader can push past the flame geometry's bounds
 * (`aT * uThrust * 6` at the preview throttle, plus the length scale). Bounding
 * boxes are measured on the undeformed geometry, so this is added by hand.
 */
const FLAME_STRETCH_PAD = 6;

/**
 * Seconds before its slot that a hull is built. Building costs a frame, so it is
 * paid while the previous hull is still mid-pass rather than on the cut.
 */
const PREBUILD_LEAD = 0.18;

/** Pixel-ratio cap. The splash stage is decorative, so it renders below native. */
const MAX_PIXEL_RATIO = 1.5;

interface FleetEntry {
  ship: PlayerShip;
  spanX: number;
  spanY: number;
  offsetX: number;
  offsetY: number;
  /**
   * Worst-case local distance from the group origin to the hull silhouette in
   * the horizontal plane, i.e. the swept radius of the turntable. The hull spins
   * around its origin, not around its bounding-box centre, so this is what
   * decides when it has actually left the frame.
   */
  radiusXZ: number;
  scale: number;
}

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

/**
 * Real in-game ship models rendered in their own tiny WebGL scene for the boot
 * splash. Reuses `PlayerShip` so the hulls, hull shader, cockpit glass and
 * thruster plumes are literally the ones flown in game, then drives them with
 * the lightweight `updatePreview` tick (no flight, shield, trail or audio).
 *
 * The hulls are paraded solo instead of laid out in a grid: rendering and
 * ticking five full ships at once (plus five sets of plume shaders) dropped
 * frames on mid-range phones. At most two exist at any moment here — the one on
 * stage and the one being built for the next slot.
 */
export const SplashFleet: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      // No WebGL available: the splash simply shows without the fleet.
      return;
    }

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 1, 2000);
    camera.position.set(0, 0, CAMERA_Z);
    camera.lookAt(0, 0, 0);

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.display = 'block';
    container.appendChild(renderer.domElement);

    // Same lighting rig as the game stage so the hulls read identically.
    scene.add(new THREE.AmbientLight(0x334155, 1.2));
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
    dirLight.position.set(100, 200, 300);
    scene.add(dirLight);
    const themeLight = new THREE.PointLight(0x38bdf8, 2.0, 900);
    themeLight.position.set(0, 60, 200);
    scene.add(themeLight);

    // Visible world extents at the hulls' depth, refreshed by layout().
    let visibleWidth = 1;
    let visibleHeight = 1;

    /** Fits one hull to the current stage, centred on its own bounding box. */
    const rescale = (entry: FleetEntry): void => {
      entry.scale = Math.min(
        (visibleWidth * STAGE_FILL) / entry.spanX,
        (visibleHeight * STAGE_FILL) / entry.spanY
      );
      entry.ship.group.scale.setScalar(entry.scale);
    };

    const entries: (FleetEntry | null)[] = FLEET.map(() => null);

    const build = (index: number): FleetEntry => {
      const ship = new PlayerShip(scene);
      ship.setShipModel(FLEET[index]);
      const colorKey = FLEET_COLORS[index % FLEET_COLORS.length];
      ship.setShipColor((SHIP_COLORS[colorKey] || SHIP_COLORS.blue).colorHex);
      ship.setVisible(false);

      // Measured while the group is still unscaled and unrotated. The turntable
      // swings depth into view, so the horizontal footprint is the larger of the
      // fuselage length and the wingspan.
      const box = ship.getModelBounds();
      const entry: FleetEntry = {
        ship,
        spanX: Math.max(box.max.x - box.min.x, box.max.z - box.min.z, 1),
        spanY: Math.max(box.max.y - box.min.y, 1),
        // The hull is not centred on its origin (nose forward, plume aft), so it
        // is recentred in the frame rather than pivoting around its pivot point.
        offsetX: (box.max.x + box.min.x) / 2,
        offsetY: (box.max.y + box.min.y) / 2,
        // Furthest bounding-box corner from the spin axis, padded for the plume
        // stretch the shader adds on top of the flame geometry.
        radiusXZ:
          Math.hypot(
            Math.max(Math.abs(box.min.x), Math.abs(box.max.x)),
            Math.max(Math.abs(box.min.z), Math.abs(box.max.z))
          ) + FLAME_STRETCH_PAD,
        scale: 1
      };
      rescale(entry);
      entries[index] = entry;
      return entry;
    };

    const release = (index: number): void => {
      const entry = entries[index];
      if (!entry) return;
      entry.ship.destroy();
      entries[index] = null;
    };

    /** Resizes the renderer and refits whatever hulls are currently alive. */
    const layout = (): void => {
      const w = container.clientWidth || 1;
      const h = container.clientHeight || 1;

      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();

      visibleHeight = 2 * CAMERA_Z * Math.tan((CAMERA_FOV * Math.PI) / 360);
      visibleWidth = visibleHeight * camera.aspect;

      for (const entry of entries) {
        if (entry) rescale(entry);
      }
    };

    layout();

    const resizeObserver = new ResizeObserver(() => layout());
    resizeObserver.observe(container);

    let frame = 0;
    let last = performance.now();
    let elapsed = 0;

    const cycleSeconds = FLEET.length * SLOT_SECONDS;
    const handoffSeconds = SLOT_SECONDS * HANDOFF_FRACTION;

    /**
     * Distance the hull must travel for its own silhouette to clear the frame,
     * so it is never seen popping in or out inside the visible stage.
     */
    const offstageX = (entry: FleetEntry): number =>
      visibleWidth / 2 +
      // Swept radius of the turntable plus the recentring shift place() applies,
      // so the trailing thruster is clear of the edge at any rotation angle.
      (entry.radiusXZ + Math.abs(entry.offsetX)) * entry.scale +
      OFFSTAGE_MARGIN;

    /** Places a hull horizontally/vertically, recentred on its bounding box. */
    const place = (entry: FleetEntry, slideX: number, lift: number, bob: number): void => {
      entry.ship.group.position.x = slideX - entry.offsetX * entry.scale;
      entry.ship.group.position.y = lift + bob - entry.offsetY * entry.scale;
    };

    const tick = (now: number): void => {
      frame = requestAnimationFrame(tick);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      elapsed += dt;

      // Loops so the stage never goes empty if the splash outlasts one pass.
      const cycleTime = elapsed % cycleSeconds;
      const current = Math.min(FLEET.length - 1, Math.floor(cycleTime / SLOT_SECONDS));
      const slotTime = cycleTime - current * SLOT_SECONDS;
      const upcoming = (current + 1) % FLEET.length;

      // The handoff occupies the tail of each slot. The next hull is built a touch
      // earlier still, so the build frame is not paid on the cut itself.
      const timeLeft = SLOT_SECONDS - slotTime;
      const inHandoff = timeLeft <= handoffSeconds;
      const needsPrebuild = timeLeft <= Math.max(PREBUILD_LEAD, handoffSeconds);

      for (let i = 0; i < FLEET.length; i++) {
        if (i === current || (needsPrebuild && i === upcoming)) continue;
        release(i);
      }

      const entry = entries[current] ?? build(current);
      const nextEntry = needsPrebuild ? entries[upcoming] ?? build(upcoming) : entries[upcoming];

      const bob = Math.sin(elapsed * 1.8) * 3;

      // Very first hull of the very first pass has no predecessor to hand off from,
      // so it flies in on its own over one handoff window.
      const isIntro = elapsed < handoffSeconds;

      if (inHandoff) {
        // p = 0 at the start of the handoff, 1 exactly on the cut. The outgoing hull
        // reaches fully off-stage at the same instant the incoming lands centred.
        const p = 1 - timeLeft / handoffSeconds;
        const outEased = p * p;
        place(entry, outEased * offstageX(entry), outEased * visibleHeight * 0.12, bob);
        entry.ship.setVisible(true);

        if (nextEntry) {
          const inP = easeOutCubic(p);
          place(
            nextEntry,
            -(1 - inP) * offstageX(nextEntry),
            -(1 - inP) * visibleHeight * 0.12,
            bob
          );
          nextEntry.ship.setVisible(true);
          nextEntry.ship.updatePreview(dt, 0.9);
        }
      } else {
        if (nextEntry) nextEntry.ship.setVisible(false);
        if (isIntro) {
          const inP = easeOutCubic(elapsed / handoffSeconds);
          place(entry, -(1 - inP) * offstageX(entry), -(1 - inP) * visibleHeight * 0.12, bob);
        } else {
          place(entry, 0, 0, bob);
        }
        entry.ship.setVisible(true);
      }

      entry.ship.updatePreview(dt, 0.9);

      renderer.render(scene, camera);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      for (let i = 0; i < FLEET.length; i++) release(i);
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  return <div className="splash-fleet" ref={containerRef} aria-hidden="true" />;
};
